// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {NAVVault} from "./NAVVault.sol";
import {TickMathMini} from "./pit/TickMathMini.sol";

interface IUniswapV3PoolSwapMinimal {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IUniswapV3FactoryMinimal {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @dev PitOracle read used as the INDEPENDENT price reference for the
///      slippage floor (H-01 fix 3). PitOracle already bands its 30-min TWAP
///      against a Chainlink feed, so it is not a function of the route pool.
interface IPriceOracleMinimal {
    function quotePrice(address underlying) external view returns (uint256 price);
}

interface IERC20DecimalsMinimal {
    function decimals() external view returns (uint8);
}

/// @title AccumulatorV2 — turns fee revenue into the whole market, keeper-proof
/// @notice Same mission as Accumulator (swap `feeToken` fee revenue into
///         vault-registry assets, proceeds straight to the vault), but the
///         caller controls NOTHING except (asset, timing):
///         - no router, no whitelist, no caller calldata, no caller minOut;
///         - swaps run DIRECTLY on the owner-validated canonical Uniswap v3
///           pool for each asset, with the vault as swap recipient;
///         - `amountIn` is computed on-chain (balance capped by
///           `maxSwapPerCall`), never claimed by the caller;
///         - the slippage floor is derived on-chain from the pool's own
///           30-min TWAP (same tick→price math as PitOracle.spotTwap);
///         - the keeper reward is paid on the feeToken ACTUALLY spent in the
///           swap callback, after the swap succeeded — closing V1's P3-02
///           drain (reward paid up-front on a caller-claimed `amountIn`).
/// @dev    Price convention mirrors PitOracle: "price1e18" = feeToken amount
///         for 10**assetDecimals of asset, ×1e18/10**feeTokenDecimals.
contract AccumulatorV2 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint32 public constant TWAP_WINDOW = 30 minutes;
    uint16 public constant BPS = 10_000;
    /// @notice hard cap on per-route slippage tolerance (5%)
    uint16 public constant MAX_SLIPPAGE_BPS = 500;
    /// @notice hard cap on the keeper reward (0.50%)
    uint16 public constant MAX_KEEPER_REWARD_BPS = 50;
    /// @dev Uniswap v3 TickMath sqrt price bounds (full-range swap limits)
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    struct Route {
        address pool; // canonical Uniswap v3 pool for feeToken/asset
        bool enabled;
        bool assetIsToken0;
        uint8 assetDecimals;
        uint16 maxSlippageBps;
    }

    IERC20 public immutable feeToken;
    NAVVault public immutable vault;
    uint8 public immutable feeTokenDecimals;

    mapping(address => Route) public routes; // key: asset
    mapping(address => uint256) public lastRunAt; // key: asset

    // ------------------------------------------------------------------
    // H-01 hardening: route-provenance + independent price reference
    // ------------------------------------------------------------------

    /// @notice canonical Uniswap v3 factory; every route pool must be one of
    ///         its pools. Write-once (see `configureValidation`) — once set it
    ///         can never be changed or cleared, so route provenance is a
    ///         machine-checked property rather than a comment.
    address public factory;
    /// @notice independent price reference (PitOracle) used to break the
    ///         self-referential TWAP floor. Write-once with `factory`.
    address public priceOracle;
    /// @notice minimum `pool.liquidity()` a route pool must have, checked in
    ///         `setRoute` AND re-checked in `accumulate` so a pool drained
    ///         after configuration fails closed.
    uint128 public minPoolLiquidity;
    /// @notice minimum `slot0().observationCardinality` for a route pool — a
    ///         freshly-created hostile pool has 1.
    uint16 public minObservationCardinality;
    /// @notice max deviation between the route pool's own TWAP and the
    ///         independent oracle price before `accumulate` fails closed.
    uint16 public maxOracleDeviationBps;
    /// @notice true once `configureValidation` has run; irreversible.
    bool public validationConfigured;

    /// @notice minimum seconds between accumulate() calls per asset
    uint256 public minInterval = 300;
    /// @notice max feeToken spent per accumulate() call
    uint256 public maxSwapPerCall = 10_000e6;
    /// @notice keeper reward in bps of feeToken actually spent
    uint16 public keeperRewardBps = 10; // 0.10%

    /// @dev swap-callback guard: pool allowed to call back during the current swap
    address private _activePool;
    /// @dev feeToken actually paid to the pool inside the current swap's callback
    uint256 private _callbackPaid;
    /// @dev hard ceiling on the current swap's total callback payment
    uint256 private _callbackBudget;

    event RouteSet(address indexed asset, address pool, uint16 maxSlippageBps, bool enabled);
    event ValidationConfigured(
        address factory,
        address priceOracle,
        uint128 minPoolLiquidity,
        uint16 minObservationCardinality,
        uint16 maxOracleDeviationBps
    );
    event MinIntervalSet(uint256 interval);
    event MaxSwapPerCallSet(uint256 amount);
    event KeeperRewardSet(uint16 bps);
    event Accumulated(address indexed asset, uint256 spent, uint256 amountOut, address indexed keeper, uint256 reward);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error BadRoute();
    error SlippageTooHigh();
    error RewardTooHigh();
    error ZeroAmount();
    error RouteNotEnabled();
    error AssetNotInRegistry();
    error IntervalNotElapsed();
    error NothingToAccumulate();
    error TwapZero();
    error CallbackNotPool();
    error CallbackNoPayment();
    error CallbackOverBudget();
    error NoOutput();
    error InsufficientOutput(uint256 out, uint256 minOut);
    /// @notice pool is not a pool of the canonical factory for {feeToken, asset, fee} (H-01)
    error PoolNotCanonical();
    /// @notice pool liquidity below `minPoolLiquidity` (H-01)
    error PoolTooThin(uint128 liquidity, uint128 required);
    /// @notice pool cannot serve a full TWAP window (H-01)
    error PoolObservationsTooShort(uint16 cardinality, uint16 required);
    /// @notice pool TWAP deviates from the independent oracle beyond the band (H-01)
    error OracleDeviation(uint256 poolPrice, uint256 oraclePrice, uint16 maxBps);
    error AlreadyConfigured();
    error BadValidationConfig();

    constructor(address owner_, IERC20 feeToken_, NAVVault vault_) Ownable(owner_) {
        if (address(feeToken_) == address(0) || address(vault_) == address(0)) revert ZeroAddress();
        feeToken = feeToken_;
        vault = vault_;
        feeTokenDecimals = IERC20DecimalsMinimal(address(feeToken_)).decimals();
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice Wire the route-validation trust anchors: the canonical Uniswap
    ///         v3 factory, an independent price oracle (PitOracle) and the
    ///         pool-health floors. WRITE-ONCE and irreversible: after this
    ///         call `setRoute` can only ever point at a canonical, deep,
    ///         observation-rich pool whose TWAP agrees with the oracle, so a
    ///         compromised owner key cannot repoint a route at a pool it
    ///         controls (H-01). The deploy script calls this before any
    ///         `setRoute`, so on the live deployment the guard is permanent.
    /// @dev    Kept out of the constructor so the deployed ABI/constructor
    ///         signature is unchanged for existing tooling; `validationConfigured`
    ///         makes it a one-shot, and it can never be turned off.
    function configureValidation(
        address factory_,
        address priceOracle_,
        uint128 minPoolLiquidity_,
        uint16 minObservationCardinality_,
        uint16 maxOracleDeviationBps_
    ) external onlyOwner {
        if (validationConfigured) revert AlreadyConfigured();
        if (factory_ == address(0)) revert ZeroAddress();
        // an oracle band of 0 bps would be unsatisfiable; the oracle itself is
        // optional (address(0) = pool-TWAP-only floor, factory provenance still
        // enforced), but if given the band must be a usable, tight number.
        if (priceOracle_ != address(0) && (maxOracleDeviationBps_ == 0 || maxOracleDeviationBps_ > BPS / 2)) {
            revert BadValidationConfig();
        }
        if (minObservationCardinality_ == 0) revert BadValidationConfig();
        factory = factory_;
        priceOracle = priceOracle_;
        minPoolLiquidity = minPoolLiquidity_;
        minObservationCardinality = minObservationCardinality_;
        maxOracleDeviationBps = maxOracleDeviationBps_;
        validationConfigured = true;
        emit ValidationConfigured(
            factory_, priceOracle_, minPoolLiquidity_, minObservationCardinality_, maxOracleDeviationBps_
        );
    }

    /// @notice Configure the canonical feeToken/asset v3 pool for `asset`.
    /// @dev    Validates on-chain that {pool.token0, pool.token1} is exactly
    ///         {feeToken, asset}, and — once `configureValidation` has run —
    ///         that the pool was actually created by the canonical Uniswap v3
    ///         factory for that token pair and fee tier, holds at least
    ///         `minPoolLiquidity`, can serve a full TWAP window, and prices
    ///         the asset within `maxOracleDeviationBps` of the independent
    ///         oracle. An attacker-created 1-wei pool fails every one of those
    ///         (H-01).
    function setRoute(address asset, address pool, uint16 maxSlippageBps, bool enabled) external onlyOwner {
        if (asset == address(0) || pool == address(0)) revert ZeroAddress();
        if (asset == address(feeToken)) revert BadRoute();
        if (maxSlippageBps == 0 || maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        address t0 = IUniswapV3PoolSwapMinimal(pool).token0();
        address t1 = IUniswapV3PoolSwapMinimal(pool).token1();
        bool a0 = t0 == asset && t1 == address(feeToken);
        bool a1 = t1 == asset && t0 == address(feeToken);
        if (!a0 && !a1) revert BadRoute();
        uint8 dec = IERC20DecimalsMinimal(asset).decimals();
        if (dec > 30) revert BadRoute(); // keeps 10**dec scaling safe

        Route memory r =
            Route({pool: pool, enabled: enabled, assetIsToken0: a0, assetDecimals: dec, maxSlippageBps: maxSlippageBps});

        if (validationConfigured) {
            _requireCanonicalPool(pool, t0, t1);
            _requirePoolHealth(pool);
            // the floor must agree with an independent reference at listing
            // time as well as at execution time
            _requireOracleAgreement(r, asset);
        }

        routes[asset] = r;
        emit RouteSet(asset, pool, maxSlippageBps, enabled);
    }

    /// @dev Provenance: the pool must be THE factory pool for (t0, t1, fee).
    ///      A contract that is not a v3 pool (no `fee()`/`getPool` mismatch)
    ///      fails closed.
    function _requireCanonicalPool(address pool, address t0, address t1) internal view {
        uint24 fee = IUniswapV3PoolSwapMinimal(pool).fee();
        if (IUniswapV3FactoryMinimal(factory).getPool(t0, t1, fee) != pool) revert PoolNotCanonical();
    }

    /// @dev Depth + observation-history floors. Re-checked in `accumulate` so a
    ///      pool that is drained after configuration also fails closed.
    function _requirePoolHealth(address pool) internal view {
        uint128 liq = IUniswapV3PoolSwapMinimal(pool).liquidity();
        if (liq < minPoolLiquidity) revert PoolTooThin(liq, minPoolLiquidity);
        (,,, uint16 cardinality,,,) = IUniswapV3PoolSwapMinimal(pool).slot0();
        if (cardinality < minObservationCardinality) {
            revert PoolObservationsTooShort(cardinality, minObservationCardinality);
        }
    }

    /// @dev The pool's own TWAP must sit inside a band around the independent
    ///      oracle price. This is what stops the floor being self-referential:
    ///      an attacker who is the sole LP can move the pool TWAP, but not the
    ///      Chainlink-banded oracle.
    function _requireOracleAgreement(Route memory r, address asset) internal view {
        address oracle = priceOracle;
        if (oracle == address(0)) return;
        uint256 poolPrice = _twapPrice1e18(r);
        uint256 ref = IPriceOracleMinimal(oracle).quotePrice(asset);
        if (ref == 0) revert TwapZero();
        uint256 diff = poolPrice > ref ? poolPrice - ref : ref - poolPrice;
        if (Math.mulDiv(diff, BPS, ref) > maxOracleDeviationBps) {
            revert OracleDeviation(poolPrice, ref, maxOracleDeviationBps);
        }
    }

    function setMinInterval(uint256 interval) external onlyOwner {
        if (interval == 0 || interval > 1 days) revert ZeroAmount();
        minInterval = interval;
        emit MinIntervalSet(interval);
    }

    function setMaxSwapPerCall(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        maxSwapPerCall = amount;
        emit MaxSwapPerCallSet(amount);
    }

    function setKeeperRewardBps(uint16 bps) external onlyOwner {
        if (bps > MAX_KEEPER_REWARD_BPS) revert RewardTooHigh();
        keeperRewardBps = bps;
        emit KeeperRewardSet(bps);
    }

    /// @notice Recover any token — including feeToken — to `to`. The owner is
    ///         trusted (deployer EOA → timelock/multisig); allowing feeToken
    ///         keeps recovery simple if the contract is ever superseded.
    function rescueToken(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, bal);
        emit TokenRescued(token, to, bal);
    }

    // ------------------------------------------------------------------
    // Keeper entrypoint (permissionless)
    // ------------------------------------------------------------------

    /// @notice Swap this contract's feeToken balance (capped by
    ///         `maxSwapPerCall`) into `asset` on the canonical pool, proceeds
    ///         straight to the vault. The caller picks only (asset, timing);
    ///         everything else — amount, price floor, venue — is on-chain.
    /// @return out asset amount delivered to the vault (from swap deltas)
    function accumulate(address asset) external nonReentrant returns (uint256 out) {
        Route memory r = routes[asset];
        if (r.pool == address(0) || !r.enabled) revert RouteNotEnabled();
        (bool listed, bool active,) = vault.assetInfo(asset);
        if (!listed || !active) revert AssetNotInRegistry();
        if (block.timestamp < lastRunAt[asset] + minInterval) revert IntervalNotElapsed();
        lastRunAt[asset] = block.timestamp;

        // H-01: re-validate pool health at EXECUTION time, so a route whose
        // pool is drained or whose observation history is truncated after
        // configuration fails closed instead of trading against a shell.
        if (validationConfigured) _requirePoolHealth(r.pool);

        uint256 bal = feeToken.balanceOf(address(this));
        uint256 amountIn = bal > maxSwapPerCall ? maxSwapPerCall : bal;
        // Reserve headroom so the keeper reward is always payable out of what
        // is left AFTER the swap: reward = spent*bps/BPS must fit in bal-spent,
        // i.e. spent <= bal*BPS/(BPS+bps). Without this, a full-balance swap
        // would silently pay a zero reward and kill the keeper incentive.
        uint256 spendable = Math.mulDiv(bal, BPS, BPS + keeperRewardBps);
        if (amountIn > spendable) amountIn = spendable;
        if (amountIn == 0) revert NothingToAccumulate();

        // On-chain slippage floor from the pool's 30-min TWAP, cross-checked
        // against the independent oracle (H-01) so it is not self-referential.
        uint256 minOut = _minOutFor(r, asset, amountIn);
        if (minOut == 0) revert NothingToAccumulate(); // dust: floor would be meaningless

        uint256 spent;
        (out, spent) = _swapToVault(r, asset, amountIn);
        if (out < minOut) revert InsufficientOutput(out, minOut);

        // Keeper reward on feeToken ACTUALLY spent, only after a successful
        // swap. The headroom reserved above makes this affordable; the balance
        // cap is a belt-and-braces guard so accumulation can never brick.
        uint256 reward = Math.mulDiv(spent, keeperRewardBps, BPS);
        uint256 balAfter = feeToken.balanceOf(address(this));
        if (reward > balAfter) reward = balAfter;
        if (reward > 0) feeToken.safeTransfer(msg.sender, reward);

        emit Accumulated(asset, spent, out, msg.sender, reward);
    }

    /// @notice Uniswap v3 swap callback: pays the pool the feeToken owed for
    ///         the swap initiated in `accumulate`. Only the route's canonical
    ///         pool, and only during a swap this contract started, may call.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address asset = abi.decode(data, (address));
        Route memory r = routes[asset];
        if (msg.sender != _activePool || msg.sender != r.pool) revert CallbackNotPool();
        // we only ever owe feeToken (exact-in feeToken → asset)
        int256 owedDelta = r.assetIsToken0 ? amount1Delta : amount0Delta;
        if (owedDelta <= 0) revert CallbackNoPayment();
        uint256 owed = uint256(owedDelta);
        uint256 paid = _callbackPaid + owed;
        // a pool can never extract more than the exact-in amount this contract
        // asked for, however many times it calls back
        if (paid > _callbackBudget) revert CallbackOverBudget();
        _callbackPaid = paid;
        feeToken.safeTransfer(msg.sender, owed);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev TWAP-implied output for `amountIn` of feeToken, discounted by the
    ///      route's slippage tolerance. price1e18 = feeToken per
    ///      10**assetDecimals of asset, 1e18 fixed point.
    ///
    ///      H-01: the floor is NOT derived from the traded pool alone. When an
    ///      independent oracle is configured, (a) the pool TWAP must sit inside
    ///      `maxOracleDeviationBps` of the oracle price or the call reverts,
    ///      and (b) the floor uses the CHEAPER of the two prices, i.e. the one
    ///      implying MORE asset per feeToken. An attacker who is sole LP can
    ///      inflate their pool's TWAP, but that now either trips the band or
    ///      leaves the floor pinned to the oracle — it can never be used to
    ///      lower the vault's protection.
    function _minOutFor(Route memory r, address asset, uint256 amountIn) internal view returns (uint256) {
        uint256 price = _twapPrice1e18(r);
        address oracle = priceOracle;
        if (oracle != address(0)) {
            uint256 ref = IPriceOracleMinimal(oracle).quotePrice(asset);
            if (ref == 0) revert TwapZero();
            uint256 diff = price > ref ? price - ref : ref - price;
            if (Math.mulDiv(diff, BPS, ref) > maxOracleDeviationBps) {
                revert OracleDeviation(price, ref, maxOracleDeviationBps);
            }
            if (ref < price) price = ref; // conservative: the stricter floor
        }
        uint256 expectedOut = Math.mulDiv(amountIn, 1e18 * 10 ** r.assetDecimals, price * 10 ** feeTokenDecimals);
        return Math.mulDiv(expectedOut, BPS - r.maxSlippageBps, BPS);
    }

    /// @dev Direct pool swap: exact-in feeToken, full-range price limit (the
    ///      TWAP-derived minOut is the real guard), recipient = vault.
    ///      Output is taken from the swap's own return deltas — NOT a vault
    ///      balance diff. `spent` is the feeToken actually paid in the callback.
    function _swapToVault(Route memory r, address asset, uint256 amountIn)
        internal
        returns (uint256 out, uint256 spent)
    {
        bool zeroForOne = !r.assetIsToken0; // we sell feeToken
        _activePool = r.pool;
        _callbackBudget = amountIn;
        (int256 amount0, int256 amount1) = IUniswapV3PoolSwapMinimal(r.pool).swap(
            address(vault),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(asset)
        );
        _activePool = address(0);
        _callbackBudget = 0;
        spent = _callbackPaid;
        _callbackPaid = 0;

        int256 outDelta = zeroForOne ? amount1 : amount0;
        if (outDelta >= 0) revert NoOutput();
        out = uint256(-outDelta);
    }

    /// @dev 30-min geometric-mean TWAP from the route's pool, mirrored from
    ///      PitOracle.spotTwap/_tickToPrice1e18: feeToken per whole asset,
    ///      1e18 fixed point.
    function _twapPrice1e18(Route memory r) internal view returns (uint256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        (int56[] memory ticks,) = IUniswapV3PoolSwapMinimal(r.pool).observe(ago);
        int56 delta = ticks[1] - ticks[0];
        int24 avgTick = int24(delta / int56(uint56(TWAP_WINDOW)));
        // round toward negative infinity (Uniswap convention)
        if (delta < 0 && (delta % int56(uint56(TWAP_WINDOW)) != 0)) avgTick--;

        uint160 sqrtP = TickMathMini.getSqrtRatioAtTick(avgTick);
        // raw price token1-per-token0 = sqrtP^2 / 2^192, in 1e18 fixed point,
        // guarding overflow via two mulDivs
        uint256 p1e18 = Math.mulDiv(Math.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96), 1e18, 1 << 96);
        uint256 price;
        if (r.assetIsToken0) {
            // p1e18 = feeTokenWei per assetWei × 1e18
            price = Math.mulDiv(p1e18, 10 ** r.assetDecimals, 10 ** feeTokenDecimals);
        } else {
            if (p1e18 == 0) revert TwapZero();
            // invert: asset is token1
            price = Math.mulDiv(1e36, 10 ** r.assetDecimals, p1e18 * 10 ** feeTokenDecimals);
        }
        if (price == 0) revert TwapZero();
        return price;
    }
}
