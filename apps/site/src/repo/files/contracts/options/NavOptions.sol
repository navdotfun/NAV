// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";

/*//////////////////////////////////////////////////////////////////////////
                          EXTERNAL INTERFACES (live contracts)
//////////////////////////////////////////////////////////////////////////*/

/// @dev PitOracleV2 — live at 0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd.
interface IPitOracleV2Minimal {
    /// 30-min TWAP banded against freshest Chainlink/Pyth anchor; reverts on deviation.
    function quotePrice(address underlying) external view returns (uint256);
    /// Permissionless settlement snapshot at `expiry` (price resolved AT expiry).
    function snapshotSettlement(address underlying, uint64 expiry) external returns (uint256);
    /// Idempotent read of an existing settlement snapshot (0 if not yet snapped).
    function settlementPrice(address underlying, uint64 expiry) external view returns (uint256);
}

/// @dev Canonical Uniswap V3 pool — read-only consumption.
interface IUniV3PoolMinimal {
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function feeGrowthGlobal0X128() external view returns (uint256);
    function feeGrowthGlobal1X128() external view returns (uint256);
}

interface IERC20DecimalsMinimal {
    function decimals() external view returns (uint8);
}

/// @title NavOptions — covered, prepaid, oracle-settled options on tokenized equities.
/// @notice European CALL/PUT options bought with USDG. Every option's maximum payout is
///         physically escrowed at open (stock for calls, strike-value USDG for puts), so
///         insolvency is impossible by construction: no margin, no liquidations, no keepers.
///         Premiums are priced from the underlying Uniswap pool's own fee accumulators
///         ("streamia"): what the escrowed capital would have earned as in-range liquidity
///         over the term, times a fixed spread multiplier. Settlement is permissionless and
///         bounty-incentivised via PitOracleV2's expiry-anchored snapshot.
/// @dev    Immutable: no owner, no setters, no upgrade path. Markets fixed at deploy.
///         Spec: docs/OPTIONS-SPEC.md (v1.0). Invariants I1-I10 are enforced by the test
///         campaign; rounding always favours vault solvency (buyer pays ceil, vault credits floor).
contract NavOptions is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /*//////////////////////////////////////////////////////////////////////
                                   ERRORS
    //////////////////////////////////////////////////////////////////////*/

    error BadParams();
    error UnknownMarket();
    error BadTerm();
    error BadBucket();
    error DepthLow();          // pool in-range liquidity below the per-market gate
    error DepthCapExceeded();  // open interest would exceed 20% of band depth
    error NotionalTooSmall();
    error InsufficientFreeCapital();
    error ZeroShares();
    error ZeroAmount();
    error NotExpired();
    error AlreadySettled();
    error UnknownPosition();
    error Overflow();
    error SameBlock();
    error EmptyVault();
    error CostTooHigh();

    /*//////////////////////////////////////////////////////////////////////
                                  CONSTANTS
    //////////////////////////////////////////////////////////////////////*/

    uint256 private constant Q96 = 1 << 96;
    uint256 private constant Q128 = 1 << 128;
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    /// stock (18 dec) * price (1e18 quote/token) -> USDG (6 dec) divisor.
    uint256 private constant STOCK_TO_USDG = 1e30;

    // --- fees (spec §8) ---
    uint256 public constant ORIGINATION_BPS = 20;        // of notional, to Accumulator
    uint256 public constant PROTOCOL_PREMIUM_BPS = 400;  // 4% of premium, to Accumulator
    uint256 public constant SETTLE_BOUNTY_BPS = 5;       // of released escrow, to settler
    uint256 public constant BOUNTY_CAP_USDG = 25e6;      // 25 USDG equivalent cap

    // --- pricing (spec §6) ---
    uint256 public constant FLOOR_RATE_X18 = 8e14;       // 8 bps/day
    uint256 public constant CAP_RATE_X18 = 3e16;         // 300 bps/day
    uint256 public constant MULT_NUM = 125;              // 1.25x spread multiplier
    uint256 public constant MULT_DEN = 100;
    uint256 public constant MIN_ABS_PREM_BPS = 2;        // absolute premium floor (of notional)
    uint256 public constant MIN_NOTIONAL_USDG = 10e6;    // 10 USDG

    // --- gates (spec §5) ---
    uint256 public constant DEPTH_CAP_BPS = 2_000;       // OI <= 20% of band depth
    /// sqrt(1.02) scaled 1e9 — defines the +/-2% valuation band.
    uint256 private constant BAND_NUM = 1_009_950_494;
    uint256 private constant BAND_DEN = 1_000_000_000;

    // --- fee-growth snapshot ring (spec §6) ---
    uint256 public constant SNAP_MIN_GAP = 20 minutes;
    uint256 public constant SNAP_MIN_AGE = 4 hours;
    uint256 public constant SNAP_MAX_AGE = 48 hours;
    uint8 public constant SNAP_RING = 24;

    // --- share accounting (spec §4) ---
    uint256 private constant VIRT_SHARES = 1e3;
    uint256 private constant VIRT_ASSETS = 1;

    uint64 private constant HOUR = 3600;

    /*//////////////////////////////////////////////////////////////////////
                                  IMMUTABLES
    //////////////////////////////////////////////////////////////////////*/

    IERC20 public immutable USDG;
    IPitOracleV2Minimal public immutable ORACLE;
    address public immutable ACCUMULATOR;

    /*//////////////////////////////////////////////////////////////////////
                                    STORAGE
    //////////////////////////////////////////////////////////////////////*/

    struct Market {
        address token;        // 18-dec tokenized stock
        address pool;         // canonical stock/USDG Uniswap V3 pool
        bool usdgIsToken0;    // token ordering in the pool
        uint128 minLiquidity; // in-range liquidity gate (spec §12 calibration)
    }

    /// @dev Written once in the constructor; no setters exist.
    Market[] private _markets;

    /// side index: 0 = CALL vault (holds stock), 1 = PUT vault (holds USDG)
    struct SideVault {
        uint128 totalShares;
        uint128 assets;      // total native asset incl. escrowed
        uint128 escrowed;    // committed to open positions; escrowed <= assets
        uint128 premiumUsdg; // CALL side: undistributed USDG premium reserve (PUT folds into assets)
    }

    mapping(uint256 => SideVault[2]) private _vaults;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public sharesOf;

    /// @dev CALL-side premium distribution uses reward-per-share accounting so premiums
    ///      accrue only to shares that existed when the premium was earned. A later
    ///      depositor starts with debt == shares * acc and therefore claims nothing
    ///      earned before their deposit (dilution-theft impossible).
    mapping(uint256 => uint256) public accPremiumPerShareX128; // marketId => premium/share, X128
    mapping(uint256 => mapping(address => uint256)) private _premDebtX128; // marketId => writer => debt

    /// @dev anti-sandwich: a writer cannot deposit and withdraw in the same block.
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) private _lastDepositBlock;

    struct Snap {
        uint64 ts;
        uint256 fg0;
        uint256 fg1;
    }

    mapping(uint256 => Snap[SNAP_RING]) private _snaps;
    mapping(uint256 => uint8) private _snapHead;

    struct Position {
        address owner;
        uint32 marketId;
        bool isCall;
        bool settled;
        uint64 expiry;      // hour-aligned
        uint128 size;       // stock wei (18 dec)
        uint128 strike;     // 1e18 USDG-quote per token
        uint128 escrow;     // stock wei (CALL) or USDG 6-dec (PUT)
        uint128 notional;   // USDG 6-dec at open (for OI accounting)
    }

    mapping(uint256 => Position) private _positions;
    uint256 public nextPositionId = 1;

    /// open-interest notional per market (USDG 6-dec)
    mapping(uint256 => uint128) public oiNotional;

    /*//////////////////////////////////////////////////////////////////////
                                    EVENTS
    //////////////////////////////////////////////////////////////////////*/

    event Deposited(uint256 indexed marketId, uint8 indexed side, address indexed writer, uint256 amount, uint256 shares);
    event Withdrawn(uint256 indexed marketId, uint8 indexed side, address indexed writer, uint256 amount, uint256 premiumUsdg, uint256 shares);
    event PremiumHarvested(uint256 indexed marketId, address indexed writer, uint256 amount);
    event Opened(
        uint256 indexed id,
        address indexed buyer,
        uint256 indexed marketId,
        bool isCall,
        uint8 bucket,
        uint128 size,
        uint128 strike,
        uint64 expiry,
        uint256 premium,
        uint256 origination,
        uint256 notional
    );
    event Settled(
        uint256 indexed id,
        address indexed settler,
        uint256 settlePrice,
        uint256 payout,
        uint256 bounty,
        uint256 releasedToVault
    );
    event Snapped(uint256 indexed marketId, uint64 ts, uint256 fg0, uint256 fg1);

    /*//////////////////////////////////////////////////////////////////////
                                  CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////*/

    constructor(
        address usdg,
        address oracle,
        address accumulator,
        address[] memory tokens,
        address[] memory pools,
        uint128[] memory minLiqs
    ) {
        if (
            usdg == address(0) || oracle == address(0) || accumulator == address(0)
                || tokens.length == 0 || tokens.length != pools.length || tokens.length != minLiqs.length
                || tokens.length > 16
        ) revert BadParams();
        if (IERC20DecimalsMinimal(usdg).decimals() != 6) revert BadParams();

        USDG = IERC20(usdg);
        ORACLE = IPitOracleV2Minimal(oracle);
        ACCUMULATOR = accumulator;

        for (uint256 i = 0; i < tokens.length; i++) {
            address t = tokens[i];
            address p = pools[i];
            if (t == address(0) || p == address(0) || minLiqs[i] == 0) revert BadParams();
            if (IERC20DecimalsMinimal(t).decimals() != 18) revert BadParams();
            _markets.push(
                Market({token: t, pool: p, usdgIsToken0: usdg < t, minLiquidity: minLiqs[i]})
            );
            // Seed the snapshot ring so fee-based pricing arms SNAP_MIN_AGE after deploy.
            IUniV3PoolMinimal pool = IUniV3PoolMinimal(p);
            _snaps[i][0] = Snap({
                ts: uint64(block.timestamp),
                fg0: pool.feeGrowthGlobal0X128(),
                fg1: pool.feeGrowthGlobal1X128()
            });
            emit Snapped(i, uint64(block.timestamp), _snaps[i][0].fg0, _snaps[i][0].fg1);
        }
    }

    /*//////////////////////////////////////////////////////////////////////
                              WRITER (VAULT) SIDE
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Deposit writer capital. side 0 = CALL vault (stock), side 1 = PUT vault (USDG).
    function deposit(uint256 marketId, uint8 side, uint256 amount)
        external
        nonReentrant
        returns (uint256 shares)
    {
        Market memory m = _market(marketId);
        if (side > 1) revert BadParams();
        if (amount == 0) revert ZeroAmount();
        _maybeSnap(marketId);

        SideVault storage v = _vaults[marketId][side];
        shares = Math.mulDiv(amount, uint256(v.totalShares) + VIRT_SHARES, uint256(v.assets) + VIRT_ASSETS);
        if (shares == 0) revert ZeroShares();

        uint256 harvest;
        if (side == 0) harvest = _harvestPremium(marketId, msg.sender);

        _lastDepositBlock[marketId][side][msg.sender] = block.number;
        v.totalShares = _u128(uint256(v.totalShares) + shares);
        v.assets = _u128(uint256(v.assets) + amount);
        uint256 newHeld = sharesOf[marketId][side][msg.sender] + shares;
        sharesOf[marketId][side][msg.sender] = newHeld;
        if (side == 0) _premDebtX128[marketId][msg.sender] = newHeld * accPremiumPerShareX128[marketId];

        IERC20 asset = side == 0 ? IERC20(m.token) : USDG;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        if (harvest > 0) USDG.safeTransfer(msg.sender, harvest);

        emit Deposited(marketId, side, msg.sender, amount, shares);
    }

    /// @notice Redeem shares for free (unescrowed) capital plus (CALL side) accrued USDG premium.
    function withdraw(uint256 marketId, uint8 side, uint256 shares)
        external
        nonReentrant
        returns (uint256 amountOut, uint256 premiumOut)
    {
        Market memory m = _market(marketId);
        if (side > 1) revert BadParams();
        if (shares == 0) revert ZeroAmount();
        uint256 held = sharesOf[marketId][side][msg.sender];
        if (shares > held) revert BadParams();
        _maybeSnap(marketId);

        if (block.number <= _lastDepositBlock[marketId][side][msg.sender]) revert SameBlock();

        SideVault storage v = _vaults[marketId][side];
        amountOut = Math.mulDiv(shares, uint256(v.assets) + VIRT_ASSETS, uint256(v.totalShares) + VIRT_SHARES);
        if (amountOut > uint256(v.assets) - uint256(v.escrowed)) revert InsufficientFreeCapital();
        if (side == 0) premiumOut = _harvestPremium(marketId, msg.sender);

        uint256 newHeld = held - shares;
        sharesOf[marketId][side][msg.sender] = newHeld;
        if (side == 0) _premDebtX128[marketId][msg.sender] = newHeld * accPremiumPerShareX128[marketId];
        v.totalShares = _u128(uint256(v.totalShares) - shares);
        v.assets = _u128(uint256(v.assets) - amountOut);

        IERC20 asset = side == 0 ? IERC20(m.token) : USDG;
        if (amountOut > 0) asset.safeTransfer(msg.sender, amountOut);
        if (premiumOut > 0) USDG.safeTransfer(msg.sender, premiumOut);

        emit Withdrawn(marketId, side, msg.sender, amountOut, premiumOut, shares);
    }

    /// @notice Claim accrued CALL-side premium without touching principal shares.
    function harvestPremium(uint256 marketId) external nonReentrant returns (uint256 amount) {
        _market(marketId);
        amount = _harvestPremium(marketId, msg.sender);
        uint256 held = sharesOf[marketId][0][msg.sender];
        _premDebtX128[marketId][msg.sender] = held * accPremiumPerShareX128[marketId];
        if (amount > 0) USDG.safeTransfer(msg.sender, amount);
    }

    /// @notice CALL-side premium currently claimable by `writer`.
    function pendingPremium(uint256 marketId, address writer) external view returns (uint256) {
        if (marketId >= _markets.length) revert UnknownMarket();
        uint256 accrued = sharesOf[marketId][0][writer] * accPremiumPerShareX128[marketId];
        uint256 debt = _premDebtX128[marketId][writer];
        return accrued > debt ? (accrued - debt) >> 128 : 0;
    }

    /// @dev Compute pending premium and debit the reserve. Caller must reset the debt
    ///      checkpoint after any share change and transfer `amount` out.
    function _harvestPremium(uint256 marketId, address writer) private returns (uint256 amount) {
        uint256 accrued = sharesOf[marketId][0][writer] * accPremiumPerShareX128[marketId];
        uint256 debt = _premDebtX128[marketId][writer];
        if (accrued <= debt) return 0;
        amount = (accrued - debt) >> 128;
        if (amount == 0) return 0;
        SideVault storage v = _vaults[marketId][0];
        // reserve is always >= sum of pendings (credits are rounded down into acc)
        v.premiumUsdg = _u128(uint256(v.premiumUsdg) - amount);
        emit PremiumHarvested(marketId, writer, amount);
    }

    /*//////////////////////////////////////////////////////////////////////
                                 BUYER SIDE
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Open a covered option. bucket: 0 ATM, 1 OTM 5%, 2 OTM 10%.
    ///         term: 1 hours, 1 days, 3 days or 7 days.
    /// @param maxCostUsdg Slippage guard: reverts if premium + origination exceeds it
    ///        (quotes drift with the oracle price and measured rate). 0 disables the check.
    function open(uint256 marketId, bool isCall, uint8 bucket, uint128 size, uint256 term, uint256 maxCostUsdg)
        external
        nonReentrant
        returns (uint256 id)
    {
        Market memory m = _market(marketId);
        _maybeSnap(marketId);

        Quote memory qt = _quote(marketId, m, isCall, bucket, size, term);
        if (maxCostUsdg != 0 && qt.premium + qt.origination > maxCostUsdg) revert CostTooHigh();

        SideVault storage v = _vaults[marketId][isCall ? 0 : 1];
        if (uint256(qt.escrow) > uint256(v.assets) - uint256(v.escrowed)) {
            revert InsufficientFreeCapital();
        }

        // ---- effects ----
        if (v.totalShares == 0) revert EmptyVault();
        v.escrowed = _u128(uint256(v.escrowed) + qt.escrow);
        uint256 protocolCut = (qt.premium * PROTOCOL_PREMIUM_BPS) / BPS; // floor: writer favoured
        if (isCall) {
            // reward-per-share credit: only pre-existing shares earn this premium
            v.premiumUsdg = _u128(uint256(v.premiumUsdg) + (qt.premium - protocolCut));
            accPremiumPerShareX128[marketId] += ((qt.premium - protocolCut) << 128) / v.totalShares;
        } else {
            v.assets = _u128(uint256(v.assets) + (qt.premium - protocolCut));
        }
        oiNotional[marketId] = _u128(uint256(oiNotional[marketId]) + qt.notional);

        id = nextPositionId++;
        _positions[id] = Position({
            owner: msg.sender,
            marketId: uint32(marketId),
            isCall: isCall,
            settled: false,
            expiry: qt.expiry,
            size: size,
            strike: qt.strike,
            escrow: qt.escrow,
            notional: qt.notional
        });

        // ---- interactions ----
        USDG.safeTransferFrom(msg.sender, address(this), qt.premium + qt.origination);
        USDG.safeTransfer(ACCUMULATOR, qt.origination + protocolCut);

        emit Opened(
            id, msg.sender, marketId, isCall, bucket, size, qt.strike, qt.expiry, qt.premium, qt.origination, qt.notional
        );
    }

    /// @notice Settle an expired position. Permissionless; caller earns a bounty from the
    ///         released escrow. Settlement price is anchored to the expiry timestamp by
    ///         PitOracleV2 regardless of when this is called.
    function settle(uint256 id) external nonReentrant returns (uint256 payout, uint256 bounty) {
        Position storage p = _positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
        if (p.settled) revert AlreadySettled();
        if (block.timestamp < p.expiry) revert NotExpired();

        Market memory m = _market(p.marketId);
        uint256 settleP = ORACLE.settlementPrice(m.token, p.expiry);
        if (settleP == 0) settleP = ORACLE.snapshotSettlement(m.token, p.expiry);

        p.settled = true;

        SideVault storage v = _vaults[p.marketId][p.isCall ? 0 : 1];
        uint256 released; // escrow flowing back to the vault before bounty
        address payoutAsset;

        if (p.isCall) {
            payoutAsset = m.token;
            if (settleP > p.strike) {
                // cash-settled in stock units: size * (P - K) / P  (floor)
                payout = Math.mulDiv(p.size, settleP - p.strike, settleP);
                if (payout > p.size) payout = p.size; // unreachable; belt-and-braces
            }
            released = uint256(p.size) - payout;
            bounty = (released * SETTLE_BOUNTY_BPS) / BPS;
            uint256 capStock = Math.mulDiv(BOUNTY_CAP_USDG, STOCK_TO_USDG, settleP);
            if (bounty > capStock) bounty = capStock;
        } else {
            payoutAsset = address(USDG);
            if (p.strike > settleP) {
                payout = Math.mulDiv(p.size, uint256(p.strike) - settleP, STOCK_TO_USDG);
                if (payout > p.escrow) payout = p.escrow; // unreachable by I1; guarded anyway
            }
            released = uint256(p.escrow) - payout;
            bounty = (released * SETTLE_BOUNTY_BPS) / BPS;
            if (bounty > BOUNTY_CAP_USDG) bounty = BOUNTY_CAP_USDG;
        }

        // ---- effects ----
        v.escrowed = _u128(uint256(v.escrowed) - p.escrow);
        v.assets = _u128(uint256(v.assets) - payout - bounty);
        oiNotional[p.marketId] = _u128(uint256(oiNotional[p.marketId]) - p.notional);

        // ---- interactions ----
        if (payout > 0) IERC20(payoutAsset).safeTransfer(p.owner, payout);
        if (bounty > 0) IERC20(payoutAsset).safeTransfer(msg.sender, bounty);

        emit Settled(id, msg.sender, settleP, payout, bounty, released - bounty);
    }

    /*//////////////////////////////////////////////////////////////////////
                                    VIEWS
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Exact quote the UI must display — bit-parity with open().
    function previewOpen(uint256 marketId, bool isCall, uint8 bucket, uint128 size, uint256 term)
        external
        view
        returns (uint256 premium, uint256 origination, uint128 strike, uint64 expiry, uint128 notional, uint128 escrow)
    {
        Market memory m = _market(marketId);
        Quote memory qt = _quote(marketId, m, isCall, bucket, size, term);
        return (qt.premium, qt.origination, qt.strike, qt.expiry, qt.notional, qt.escrow);
    }

    function marketsLength() external view returns (uint256) {
        return _markets.length;
    }

    function market(uint256 marketId)
        external
        view
        returns (address token, address pool, bool usdgIsToken0, uint128 minLiquidity)
    {
        Market memory m = _market(marketId);
        return (m.token, m.pool, m.usdgIsToken0, m.minLiquidity);
    }

    function vaultInfo(uint256 marketId, uint8 side)
        external
        view
        returns (uint128 totalShares, uint128 assets, uint128 escrowed, uint128 premiumUsdg, uint256 freeAssets)
    {
        if (marketId >= _markets.length || side > 1) revert UnknownMarket();
        SideVault memory v = _vaults[marketId][side];
        return (v.totalShares, v.assets, v.escrowed, v.premiumUsdg, uint256(v.assets) - uint256(v.escrowed));
    }

    function position(uint256 id) external view returns (Position memory) {
        Position memory p = _positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
        return p;
    }

    /// @notice Measured pool-fee daily rate (1e18 = 100%/day), pre floor/cap. 0 when the
    ///         snapshot ring has no reference in the [4h, 48h] window.
    function dailyRateX18(uint256 marketId) external view returns (uint256) {
        Market memory m = _market(marketId);
        uint256 s = ORACLE.quotePrice(m.token);
        IUniV3PoolMinimal pool = IUniV3PoolMinimal(m.pool);
        uint128 liq = pool.liquidity();
        (uint160 sqrtP,,,,,,) = pool.slot0();
        return _dailyRate(marketId, m, s, liq, sqrtP);
    }

    /// @notice USDG value of in-range liquidity across the +/-2% band (6-dec).
    function bandDepthUsdg(uint256 marketId) public view returns (uint256) {
        Market memory m = _market(marketId);
        uint256 s = ORACLE.quotePrice(m.token);
        IUniV3PoolMinimal pool = IUniV3PoolMinimal(m.pool);
        (uint160 sqrtP,,,,,,) = pool.slot0();
        return _bandValueUsdg(m, pool.liquidity(), sqrtP, s);
    }

    /*//////////////////////////////////////////////////////////////////////
                                  INTERNALS
    //////////////////////////////////////////////////////////////////////*/

    function _market(uint256 marketId) private view returns (Market memory m) {
        if (marketId >= _markets.length) revert UnknownMarket();
        m = _markets[marketId];
    }

    function _u128(uint256 x) private pure returns (uint128) {
        if (x > type(uint128).max) revert Overflow();
        return uint128(x);
    }

    /// @dev Push a fee-growth snapshot if the newest is >= SNAP_MIN_GAP old. Called from
    ///      every mutating entrypoint — organic traffic maintains the ring, no keeper.
    function _maybeSnap(uint256 marketId) private {
        uint8 head = _snapHead[marketId];
        Snap storage newest = _snaps[marketId][head];
        if (block.timestamp < uint256(newest.ts) + SNAP_MIN_GAP) return;
        IUniV3PoolMinimal pool = IUniV3PoolMinimal(_markets[marketId].pool);
        uint8 next = uint8((uint256(head) + 1) % SNAP_RING);
        _snaps[marketId][next] =
            Snap({ts: uint64(block.timestamp), fg0: pool.feeGrowthGlobal0X128(), fg1: pool.feeGrowthGlobal1X128()});
        _snapHead[marketId] = next;
        emit Snapped(marketId, uint64(block.timestamp), _snaps[marketId][next].fg0, _snaps[marketId][next].fg1);
    }

    /// @dev Oldest snapshot aged within [SNAP_MIN_AGE, SNAP_MAX_AGE]; ok=false when none.
    function _refSnap(uint256 marketId) private view returns (Snap memory best, bool ok) {
        uint256 bestAge;
        for (uint256 i = 0; i < SNAP_RING; i++) {
            Snap memory sn = _snaps[marketId][i];
            if (sn.ts == 0) continue;
            uint256 age = block.timestamp - uint256(sn.ts);
            if (age < SNAP_MIN_AGE || age > SNAP_MAX_AGE) continue;
            if (age > bestAge) {
                bestAge = age;
                best = sn;
                ok = true;
            }
        }
    }

    /// @dev Measured daily fee rate of the pool (1e18 fixed), converting both fee legs to
    ///      USDG at the CURRENT oracle price so reference and live legs are consistent.
    function _dailyRate(uint256 marketId, Market memory m, uint256 s, uint128 liq, uint160 sqrtP)
        private
        view
        returns (uint256)
    {
        (uint256 feeUsdg, uint256 dt) = _feeUsdgSinceRef(marketId, m, s, liq);
        if (feeUsdg == 0 || dt == 0) return 0;
        uint256 vUsdg = _bandValueUsdg(m, liq, sqrtP, s);
        if (vUsdg == 0) return 0;
        return Math.mulDiv(feeUsdg, WAD * 86_400, vUsdg * dt);
    }

    /// @dev USDG-denominated pool fees earned by liquidity `liq` since the reference
    ///      snapshot, plus the elapsed time. (0,0) when no usable reference exists.
    function _feeUsdgSinceRef(uint256 marketId, Market memory m, uint256 s, uint128 liq)
        private
        view
        returns (uint256 feeUsdg, uint256 dt)
    {
        (Snap memory ref, bool ok) = _refSnap(marketId);
        if (!ok || liq == 0) return (0, 0);
        IUniV3PoolMinimal pool = IUniV3PoolMinimal(m.pool);
        uint256 d0;
        uint256 d1;
        unchecked {
            // fee-growth accumulators wrap by design; unchecked subtraction is wrap-safe.
            d0 = pool.feeGrowthGlobal0X128() - ref.fg0;
            d1 = pool.feeGrowthGlobal1X128() - ref.fg1;
        }
        dt = block.timestamp - uint256(ref.ts);
        if (!m.usdgIsToken0) (d0, d1) = (d1, d0);
        // d0 now = USDG-leg growth, d1 = stock-leg growth (converted at current S).
        feeUsdg = Math.mulDiv(d0 + Math.mulDiv(d1, s, STOCK_TO_USDG), liq, Q128);
    }

    /// @dev USDG value (6-dec) of liquidity `liq` across the +/-2% band around sqrtP.
    function _bandValueUsdg(Market memory m, uint128 liq, uint160 sqrtP, uint256 s)
        private
        pure
        returns (uint256)
    {
        if (liq == 0 || sqrtP == 0) return 0;
        uint256 sqrtU = (uint256(sqrtP) * BAND_NUM) / BAND_DEN;
        uint256 sqrtL = (uint256(sqrtP) * BAND_DEN) / BAND_NUM;
        // token0 amount over [sqrtP, sqrtU]  (SqrtPriceMath.getAmount0Delta)
        uint256 amt0 = Math.mulDiv(uint256(liq) << 96, sqrtU - uint256(sqrtP), sqrtU) / uint256(sqrtP);
        // token1 amount over [sqrtL, sqrtP]  (SqrtPriceMath.getAmount1Delta)
        uint256 amt1 = Math.mulDiv(liq, uint256(sqrtP) - sqrtL, Q96);
        (uint256 usdgAmt, uint256 stockAmt) = m.usdgIsToken0 ? (amt0, amt1) : (amt1, amt0);
        return usdgAmt + Math.mulDiv(stockAmt, s, STOCK_TO_USDG);
    }

    struct Quote {
        uint256 premium;
        uint256 origination;
        uint128 strike;
        uint64 expiry;
        uint128 notional;
        uint128 escrow;
    }

    struct QuoteVars {
        uint256 s;
        uint128 liq;
        uint160 sqrtP;
        uint256 depth;
        uint256 rate;
        uint256 base;
        uint256 factor;
        uint256 intrinsic;
    }

    /// @dev Full open-time quote + gates. Reverts on any gate failure. view-safe.
    function _quote(uint256 marketId, Market memory m, bool isCall, uint8 bucket, uint128 size, uint256 term)
        private
        view
        returns (Quote memory out)
    {
        if (size == 0) revert ZeroAmount();
        if (term != 1 hours && term != 1 days && term != 3 days && term != 7 days) revert BadTerm();
        if (bucket > 2) revert BadBucket();

        QuoteVars memory q;
        // Oracle quote: TWAP banded against Chainlink/Pyth — reverts on deviation (manipulation gate).
        q.s = ORACLE.quotePrice(m.token);

        IUniV3PoolMinimal pool = IUniV3PoolMinimal(m.pool);
        q.liq = pool.liquidity();
        if (q.liq < m.minLiquidity) revert DepthLow();
        (q.sqrtP,,,,,,) = pool.slot0();

        out.notional = _u128(Math.mulDiv(size, q.s, STOCK_TO_USDG, Math.Rounding.Ceil));
        if (out.notional < MIN_NOTIONAL_USDG) revert NotionalTooSmall();

        q.depth = _bandValueUsdg(m, q.liq, q.sqrtP, q.s);
        if (uint256(oiNotional[marketId]) + out.notional > (q.depth * DEPTH_CAP_BPS) / BPS) {
            revert DepthCapExceeded();
        }

        // strike bucket: ATM 100, CALL 105/110, PUT 95/90
        uint256 mult = bucket == 0 ? 100 : (bucket == 1 ? (isCall ? 105 : 95) : (isCall ? 110 : 90));
        out.strike = _u128((q.s * mult) / 100);

        out.expiry = uint64(((block.timestamp + term + HOUR - 1) / HOUR) * HOUR);

        // ---- premium (spec §6) ----
        q.rate = _dailyRate(marketId, m, q.s, q.liq, q.sqrtP);
        if (q.rate < FLOOR_RATE_X18) q.rate = FLOOR_RATE_X18;
        if (q.rate > CAP_RATE_X18) q.rate = CAP_RATE_X18;
        q.base = Math.mulDiv(out.notional, q.rate * term, 86_400 * WAD, Math.Rounding.Ceil);
        q.factor = bucket == 0 ? 100 : (bucket == 1 ? 55 : 30);
        out.premium = Math.mulDiv(q.base, MULT_NUM * q.factor, MULT_DEN * 100, Math.Rounding.Ceil);
        uint256 absMin = Math.mulDiv(out.notional, MIN_ABS_PREM_BPS, BPS, Math.Rounding.Ceil);
        if (out.premium < absMin) out.premium = absMin;

        if (isCall) {
            if (q.s > out.strike) {
                q.intrinsic = Math.mulDiv(size, q.s - out.strike, STOCK_TO_USDG, Math.Rounding.Ceil);
            }
            out.escrow = size; // covered 1:1 in stock
        } else {
            if (out.strike > q.s) {
                q.intrinsic = Math.mulDiv(size, out.strike - q.s, STOCK_TO_USDG, Math.Rounding.Ceil);
            }
            out.escrow = _u128(Math.mulDiv(size, out.strike, STOCK_TO_USDG, Math.Rounding.Ceil)); // cash-secured
        }
        out.premium += q.intrinsic;
        out.origination = Math.mulDiv(out.notional, ORIGINATION_BPS, BPS, Math.Rounding.Ceil);
    }
}
