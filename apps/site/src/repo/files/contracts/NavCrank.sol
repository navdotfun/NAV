// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {TickMathMini} from "./pit/TickMathMini.sol";

/* ─────────────────────── minimal external interfaces ─────────────────────── */

interface ILpTimelockMinimal {
    function collectFees(address to) external returns (uint256 amount0, uint256 amount1);
    function transferController(address newController) external;
    function acceptController() external;
    function controller() external view returns (address);
}

interface IFeeSplitterMinimal {
    function distribute() external;
}

interface IAccumulatorV2Minimal {
    function accumulate(address asset) external returns (uint256 out);
    function routes(address asset)
        external
        view
        returns (address pool, bool enabled, bool assetIsToken0, uint8 assetDecimals, uint16 maxSlippageBps);
    function lastRunAt(address asset) external view returns (uint256);
    function minInterval() external view returns (uint256);
}

interface INavVaultMinimal {
    function assetInfo(address asset) external view returns (bool listed, bool active, uint64 addedAt);
}

interface INavTokenBurnable {
    function burn(uint256 value) external;
    function balanceOf(address) external view returns (uint256);
}

interface IUniswapV3PoolCrankMinimal {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @title NavCrank — one permissionless crank for the whole NAV fee pipeline
/// @notice Plugs into the LIVE protocol without redeploying anything. Once this
///         contract is made controller of the LpTimelock (two-step, reversible),
///         a single `crank()` call from ANYONE atomically:
///
///           1. collects LP fees from the timelock (WETH + NAV) to itself;
///           2. BURNS 100% of the NAV side — the fee-flow burn policy is now
///              code, not convention;
///           3. swaps the WETH side to USDG directly on the canonical
///              WETH/USDG pool, floor-guarded by the pool's own 30-min TWAP,
///              proceeds straight to the FeeSplitter;
///           4. triggers the splitter's 80/15/5 distribution;
///           5. buys stocks into the vault via AccumulatorV2, with the asset
///              chosen ON-CHAIN by deterministic round-robin rotation over the
///              routed list — the caller cannot choose the asset (selection is
///              a pure function of contract state; a caller's only residual
///              influence is WHEN the deterministic sequence advances);
///           6. forwards the accumulator's keeper reward (USDG) to the caller.
///
///         The caller controls TIMING ONLY. Amounts, prices, venues, burn,
///         split and asset selection are all decided by contract state.
///
///         ESCAPE HATCH: the owner can hand the timelock controllership to any
///         address via `handOverTimelock` — so this contract can always be
///         retired or upgraded without touching the locked LP position.
contract NavCrank is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    uint32 public constant TWAP_WINDOW = 1800; // 30 min, same as AccumulatorV2
    /// @dev Uniswap v3 full-range price limits (TickMath MIN/MAX sqrt ratios).
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    /// @dev Hard bounds on owner-tunable parameters.
    uint16 public constant MAX_WETH_SLIPPAGE_BPS = 300; // ≤3%
    uint256 public constant MAX_CRANK_COOLDOWN = 1 days;
    uint8 public constant MAX_BUYS_PER_CRANK = 3;
    uint8 internal constant MAX_BUY_ATTEMPTS = 4; // A-05: tighter grief bound
    /// @dev L-02: hard cap on rotation size keeps crank gas bounded.
    uint256 public constant MAX_ROTATION = 64;
    /// @dev L-03: owner cannot park the fee stream by raising thresholds sky-high.
    uint256 public constant MAX_MIN_WETH_SWAP = 1 ether;
    uint256 public constant MAX_MIN_ACCUMULATE = 1000e6;
    /// @dev A-01: per-crank swap size cap bounds sandwich surface regardless of backlog.
    uint256 public constant MAX_WETH_PER_CRANK_CAP = 20 ether;
    /// @dev A-06: NAV dust below this still burns but does not count as "work",
    ///      so a 1-wei donation cannot arm the crank cooldown.
    uint256 public constant MIN_NAV_WORK = 1e18;
    /// @dev A-02/A-05: never start an accumulate leg on gas fumes.
    uint256 internal constant MIN_GAS_FOR_BUY = 600_000;

    /* ─────────────────────────── wiring (immutable) ─────────────────────── */

    ILpTimelockMinimal public immutable timelock;
    INavTokenBurnable public immutable navToken;
    IERC20 public immutable weth;
    IERC20 public immutable usdg;
    IUniswapV3PoolCrankMinimal public immutable wethUsdgPool;
    IFeeSplitterMinimal public immutable splitter;
    IAccumulatorV2Minimal public immutable accumulator;
    INavVaultMinimal public immutable vault;
    /// @dev True when WETH is token0 of `wethUsdgPool` (checked in constructor).
    bool public immutable wethIsToken0;

    /* ─────────────────────────── rotation state ─────────────────────────── */

    /// @notice Round-robin list of accumulator-routed assets. Owner-curated to
    ///         mirror the accumulator's route set; every candidate is
    ///         re-validated on-chain at selection time, so a stale entry can
    ///         only be SKIPPED, never wrongly bought.
    address[] public rotation;
    /// @notice Index into `rotation` of the NEXT asset to consider.
    uint256 public cursor;

    /* ─────────────────────────── parameters ─────────────────────────────── */

    /// @notice WETH below this is left for the next crank instead of swapped.
    uint256 public minWethSwap = 0.0005 ether;
    /// @notice A-01: at most this much WETH is swapped per crank; any excess
    ///         backlog drains over subsequent cranks, keeping every swap deep
    ///         inside the sandwich-unprofitable region.
    uint256 public maxWethPerCrank = 2 ether;
    /// @notice Accumulator USDG below this is left to pool up for later cranks.
    uint256 public minAccumulate = 10e6; // 10 USDG
    /// @notice Max spot slippage vs the 30-min TWAP for the WETH→USDG leg.
    uint16 public wethSlippageBps = 100; // 1%
    /// @notice Minimum time between cranks (spam guard; timing only).
    uint256 public crankCooldown = 30 minutes;
    uint256 public lastCrankAt;

    /* ─────────────────────────── swap callback state ─────────────────────── */

    address private _activePool;
    uint256 private _callbackBudget;

    /* ────────────────────────────── events ──────────────────────────────── */

    event Cranked(
        address indexed caller,
        uint256 wethCollected,
        uint256 navBurned,
        uint256 usdgToSplitter,
        uint8 assetsBought,
        uint256 rewardPaid
    );
    event AssetBought(address indexed asset, uint256 amountOut);
    event RotationSet(address[] assets);
    event ParamsSet(
        uint256 minWethSwap, uint256 maxWethPerCrank, uint256 minAccumulate, uint16 wethSlippageBps, uint256 crankCooldown
    );
    event TimelockHandedOver(address indexed newController);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    /* ────────────────────────────── errors ──────────────────────────────── */

    error ZeroAddress();
    error TooSoon(uint256 readyAt);
    error NothingToCrank();
    error BadRotationAsset(address asset);
    error EmptyRotation();
    error ParamOutOfBounds();
    error TwapZero();
    error NoOutput();
    error BadCallback();
    error WethNotInPool();
    error RenounceDisabled();

    constructor(
        address owner_,
        ILpTimelockMinimal timelock_,
        INavTokenBurnable navToken_,
        IERC20 weth_,
        IERC20 usdg_,
        IUniswapV3PoolCrankMinimal wethUsdgPool_,
        IFeeSplitterMinimal splitter_,
        IAccumulatorV2Minimal accumulator_,
        INavVaultMinimal vault_,
        address[] memory rotation_
    ) Ownable(owner_) {
        if (
            address(timelock_) == address(0) || address(navToken_) == address(0) || address(weth_) == address(0)
                || address(usdg_) == address(0) || address(wethUsdgPool_) == address(0) || address(splitter_) == address(0)
                || address(accumulator_) == address(0) || address(vault_) == address(0)
        ) revert ZeroAddress();
        timelock = timelock_;
        navToken = navToken_;
        weth = weth_;
        usdg = usdg_;
        wethUsdgPool = wethUsdgPool_;
        splitter = splitter_;
        accumulator = accumulator_;
        vault = vault_;

        // Bind the swap direction to the actual pool layout instead of trusting
        // a constructor flag.
        address t0 = wethUsdgPool_.token0();
        address t1 = wethUsdgPool_.token1();
        if (t0 == address(weth_)) {
            if (t1 != address(usdg_)) revert WethNotInPool();
            wethIsToken0 = true;
        } else if (t1 == address(weth_)) {
            if (t0 != address(usdg_)) revert WethNotInPool();
            wethIsToken0 = false;
        } else {
            revert WethNotInPool();
        }

        _setRotation(rotation_);
    }

    /* ─────────────────────────── the one crank ──────────────────────────── */

    /// @notice Run one full fee epoch. Permissionless; caller picks timing only.
    /// @return bought number of accumulator buys executed this crank
    function crank() external nonReentrant returns (uint8 bought) {
        uint256 readyAt = lastCrankAt + crankCooldown;
        if (block.timestamp < readyAt) revert TooSoon(readyAt);
        lastCrankAt = block.timestamp;

        bool didAnything;

        // 1 — collect LP fees (WETH + NAV) from the locked position.
        (uint256 c0, uint256 c1) = timelock.collectFees(address(this));
        if (c0 > 0 || c1 > 0) didAnything = true;

        // 2 — burn the ENTIRE NAV side. Balance-based so NAV from any source
        //     (donations included) is destroyed rather than stranded. Dust
        //     below MIN_NAV_WORK still burns but does not count as "work"
        //     (A-06: a 1-wei donation cannot arm the cooldown).
        uint256 navBal = navToken.balanceOf(address(this));
        if (navBal > 0) {
            navToken.burn(navBal);
            if (navBal >= MIN_NAV_WORK) didAnything = true;
        }

        // 3 — swap the WETH side to USDG, straight to the splitter, guarded by
        //     the canonical pool's own 30-min TWAP. Size-capped per crank
        //     (A-01) and decoupled from the rest of the pipeline (A-03): a
        //     reverting swap leg (e.g. TWAP floor tripped during a violent
        //     move) skips instead of blocking burns and buys — the WETH simply
        //     waits for a calmer crank.
        uint256 wethBal = weth.balanceOf(address(this));
        uint256 wethIn = wethBal > maxWethPerCrank ? maxWethPerCrank : wethBal;
        uint256 usdgOut;
        if (wethIn >= minWethSwap) {
            try this.swapWethLegExternal(wethIn) returns (uint256 out) {
                usdgOut = out;
                didAnything = true;
            } catch {
                wethIn = 0; // leg skipped; a caught failure is not "work"
            }
        } else {
            wethIn = 0;
        }

        // 4 — split 80/15/5. No-ops harmlessly on zero balance.
        splitter.distribute();

        // 5 — rotate through the routed assets and buy. Selection is pure
        //     contract state; failures skip forward instead of bricking.
        bought = _accumulateRotating();
        if (bought > 0) didAnything = true;

        // 6 — forward every USDG this contract holds (keeper rewards from the
        //     accumulator) to whoever cranked. The router holds nothing back.
        uint256 reward = usdg.balanceOf(address(this));
        if (reward > 0) usdg.safeTransfer(msg.sender, reward);

        if (!didAnything) revert NothingToCrank();
        emit Cranked(msg.sender, wethIn, navBal, usdgOut, bought, reward);
    }

    /// @notice Self-call wrapper that lets `crank()` try/catch the WETH leg
    ///         (internal functions cannot be caught). Callable ONLY by this
    ///         contract; state safety is inherited from the calling crank's
    ///         `nonReentrant` guard.
    function swapWethLegExternal(uint256 amountIn) external returns (uint256 out) {
        if (msg.sender != address(this)) revert BadCallback();
        return _swapWethToSplitter(amountIn);
    }

    /* ───────────────────────── rotation internals ───────────────────────── */

    /// @dev Try up to MAX_BUY_ATTEMPTS candidates from the rotation, executing
    ///      at most MAX_BUYS_PER_CRANK successful buys, while the accumulator
    ///      still holds at least `minAccumulate`. Every candidate is validated
    ///      against LIVE accumulator + vault state at call time.
    function _accumulateRotating() internal returns (uint8 bought) {
        uint256 len = rotation.length;
        if (len == 0) return 0;
        uint256 interval = accumulator.minInterval();
        uint256 cur = cursor;

        for (uint8 attempts = 0; attempts < MAX_BUY_ATTEMPTS && bought < MAX_BUYS_PER_CRANK; attempts++) {
            if (usdg.balanceOf(address(accumulator)) < minAccumulate) break;
            // A-02/A-05: never start a buy on gas fumes — a deliberately
            // gas-starved call cannot OOG the inner accumulate into the catch
            // and thereby consume rotation candidates without buying.
            if (gasleft() < MIN_GAS_FOR_BUY) break;

            // peek-scan for the next eligible asset (≤ one full lap) WITHOUT
            // consuming skipped slots; only the slot actually tried is
            // consumed (A-05: cursor advances past attempted assets only).
            address asset = address(0);
            for (uint256 scanned = 0; scanned < len; scanned++) {
                address candidate = rotation[(cur + scanned) % len];
                if (_eligible(candidate, interval)) {
                    asset = candidate;
                    cur = cur + scanned + 1; // consume through the tried slot
                    break;
                }
            }
            if (asset == address(0)) break; // nothing eligible this crank

            try accumulator.accumulate(asset) returns (uint256 out) {
                bought++;
                emit AssetBought(asset, out);
            } catch {
                // pool health / oracle band / interval race — skip, try next
                continue;
            }
        }
        cursor = cur % len;
    }

    /// @dev Eligibility mirrors AccumulatorV2's own preconditions so that a
    ///      selected asset is very likely to actually trade.
    function _eligible(address asset, uint256 interval) internal view returns (bool) {
        (address pool, bool enabled,,,) = accumulator.routes(asset);
        if (pool == address(0) || !enabled) return false;
        (bool listed, bool active,) = vault.assetInfo(asset);
        if (!listed || !active) return false;
        return block.timestamp >= accumulator.lastRunAt(asset) + interval;
    }

    /* ─────────────────────────── WETH→USDG leg ──────────────────────────── */

    /// @dev Exact-in swap of the router's WETH into USDG, recipient = splitter,
    ///      minOut derived from the pool's OWN 30-min TWAP (the pool is the
    ///      deepest venue and predates this contract; manipulating a 30-min
    ///      geometric-mean TWAP upward to loosen the floor is capital-intensive
    ///      and bounded by `wethSlippageBps`).
    function _swapWethToSplitter(uint256 amountIn) internal returns (uint256 out) {
        uint256 usdgPerWeth1e18 = _twapUsdgPerWeth1e18();
        uint256 expectedOut = Math.mulDiv(amountIn, usdgPerWeth1e18, 1e18);
        uint256 minOut = Math.mulDiv(expectedOut, BPS - wethSlippageBps, BPS);
        if (minOut == 0) revert TwapZero(); // dust would make the floor meaningless

        bool zeroForOne = wethIsToken0; // selling WETH
        _activePool = address(wethUsdgPool);
        _callbackBudget = amountIn;
        (int256 a0, int256 a1) = wethUsdgPool.swap(
            address(splitter),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        );
        _activePool = address(0);
        _callbackBudget = 0;

        int256 outDelta = zeroForOne ? a1 : a0;
        if (outDelta >= 0) revert NoOutput();
        out = uint256(-outDelta);
        if (out < minOut) revert NoOutput();
    }

    /// @notice Uniswap v3 swap callback — pays the WETH owed for the swap this
    ///         contract initiated. Only the bound pool, only mid-swap.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != _activePool || _activePool == address(0)) revert BadCallback();
        uint256 owed = uint256(wethIsToken0 ? amount0Delta : amount1Delta);
        if (owed == 0 || owed > _callbackBudget) revert BadCallback();
        _callbackBudget -= owed; // A-04/L-01: budget is CUMULATIVE across invocations
        weth.safeTransfer(msg.sender, owed);
    }

    /// @dev 30-min geometric-mean TWAP of the WETH/USDG pool, returned as
    ///      USDG-wei per 1e18 WETH-wei, 1e18 fixed point on the raw wei ratio
    ///      (no decimal rescaling needed — we work in wei on both sides).
    function _twapUsdgPerWeth1e18() internal view returns (uint256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        (int56[] memory ticks,) = wethUsdgPool.observe(ago);
        int56 delta = ticks[1] - ticks[0];
        int24 avgTick = int24(delta / int56(uint56(TWAP_WINDOW)));
        if (delta < 0 && (delta % int56(uint56(TWAP_WINDOW)) != 0)) avgTick--;

        uint160 sqrtP = TickMathMini.getSqrtRatioAtTick(avgTick);
        // token1-wei per token0-wei, 1e18 fixed point
        uint256 p1e18 = Math.mulDiv(Math.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96), 1e18, 1 << 96);
        uint256 price = wethIsToken0 ? p1e18 : (p1e18 == 0 ? 0 : Math.mulDiv(1e18, 1e18, p1e18));
        if (price == 0) revert TwapZero();
        return price;
    }

    /* ─────────────────────────── owner controls ─────────────────────────── */

    /// @notice Replace the rotation list. Every entry must be routed in the
    ///         accumulator at set time (belt) and is re-validated at every
    ///         selection (braces).
    function setRotation(address[] calldata assets) external onlyOwner {
        _setRotation(assets);
    }

    function _setRotation(address[] memory assets) internal {
        if (assets.length == 0) revert EmptyRotation();
        if (assets.length > MAX_ROTATION) revert ParamOutOfBounds(); // L-02
        for (uint256 i = 0; i < assets.length; i++) {
            (address pool,,,,) = accumulator.routes(assets[i]);
            if (assets[i] == address(0) || pool == address(0)) revert BadRotationAsset(assets[i]);
        }
        rotation = assets;
        cursor = 0;
        emit RotationSet(assets);
    }

    /// @notice Tune thresholds within hard bounds. Timing/dust knobs only —
    ///         cannot touch custody, split, burn or asset selection logic.
    function setParams(
        uint256 minWethSwap_,
        uint256 maxWethPerCrank_,
        uint256 minAccumulate_,
        uint16 wethSlippageBps_,
        uint256 crankCooldown_
    ) external onlyOwner {
        if (wethSlippageBps_ == 0 || wethSlippageBps_ > MAX_WETH_SLIPPAGE_BPS) revert ParamOutOfBounds();
        if (crankCooldown_ > MAX_CRANK_COOLDOWN) revert ParamOutOfBounds();
        // L-03: thresholds are hard-bounded so the owner cannot park the fee
        // stream inside this contract (and later sweep it via rescueToken).
        if (minWethSwap_ > MAX_MIN_WETH_SWAP) revert ParamOutOfBounds();
        if (minAccumulate_ > MAX_MIN_ACCUMULATE) revert ParamOutOfBounds();
        // A-01: cap is bounded above, and never below minWethSwap (which would
        // silently disable the swap leg forever — same parking grief).
        if (maxWethPerCrank_ < minWethSwap_ || maxWethPerCrank_ > MAX_WETH_PER_CRANK_CAP) revert ParamOutOfBounds();
        minWethSwap = minWethSwap_;
        maxWethPerCrank = maxWethPerCrank_;
        minAccumulate = minAccumulate_;
        wethSlippageBps = wethSlippageBps_;
        crankCooldown = crankCooldown_;
        emit ParamsSet(minWethSwap_, maxWethPerCrank_, minAccumulate_, wethSlippageBps_, crankCooldown_);
    }

    /// @notice DISABLED (M-01). Renouncing ownership while this contract is
    ///         the timelock controller would strand the LP position forever
    ///         (no owner → no handOverTimelock → no release path). Ownership
    ///         exits only via the two-step transferOwnership.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice ESCAPE HATCH — begin handing the timelock controllership to any
    ///         address (wallet, multisig, or an upgraded router). Two-step on
    ///         the timelock side, so a typo cannot orphan the lock.
    function handOverTimelock(address newController) external onlyOwner {
        if (newController == address(0)) revert ZeroAddress();
        timelock.transferController(newController);
        emit TimelockHandedOver(newController);
    }

    /// @notice Complete this contract's side of the controller handover FROM
    ///         the current controller. Permissionless — accepting custody of
    ///         the fee stream is never against the protocol's interest.
    function acceptTimelock() external {
        timelock.acceptController();
    }

    /// @notice Safety net for tokens that end up here outside the crank flow.
    ///         NAV is deliberately NOT rescuable — any NAV that reaches this
    ///         contract is destined for the burn, no exceptions.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(navToken)) revert BadRotationAsset(token);
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Rotation list length, for UIs.
    function rotationLength() external view returns (uint256) {
        return rotation.length;
    }
}
