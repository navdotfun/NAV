// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {SafeCast} from "openzeppelin-contracts/contracts/utils/math/SafeCast.sol";
import {PitPricer} from "./PitPricer.sol";
import {PitTicket} from "./PitTicket.sol";

/// @notice Minimal oracle surface consumed by the pool. Satisfied by both
///         PitOracle (v1) and PitOracleV2 — the concrete oracle is bound by
///         address at construction, so the pool never imports an implementation.
interface IPitOracle {
    function quotePrice(address underlying) external view returns (uint256);
    function settlementPrice(address underlying, uint64 expiry) external view returns (uint256);
    function snapshotSettlement(address underlying, uint64 expiry) external returns (uint256);
    function spotTwap(address underlying) external view returns (uint256);
}

interface IPitFactoryMinimal {
    function paused() external view returns (bool);
    function feeSink() external view returns (address);
    function pitFeeBps() external view returns (uint16);
    function keeperFeeBps() external view returns (uint16);
}

interface IUiMultiplier {
    function uiMultiplier() external view returns (uint256);
}

/// @title PitPool v2 — fully-collateralized strike-bucket option books for one underlying
/// @notice Two books per strike (CALL: collateral = underlying; PUT: collateral = quote).
///         LPs deposit into buckets and earn premiums; buyers receive PitTicket NFTs.
///         European settlement at a once-per-expiry oracle snapshot; permissionless
///         settlement/exercise with keeper compensation. No margin, no liquidations:
///         every position is 100% collateralized at write time, so
///         max payout <= locked collateral for ANY settlement price, by construction.
///
/// @dev v2 accounting model (audit-v4 fixes C-01, C-02, H-01, H-02, H-03, S-04, S-14,
///      S-17, S-19, M-01..M-04, L-01, L-02, L-04):
///
///      * Shares are PAR: 1 share == 1 collateral wei at deposit, forever. Realised
///        P&L is distributed through a signed per-share accumulator (`accPnlPerShare`)
///        exactly like premiums, instead of by moving the share price. Share supply
///        therefore never ratchets, so the uint128 share cast can no longer brick a
///        bucket after repeated realised losses (H-03).
///      * A realised loss is charged to the share base AT RECONCILE TIME, before any
///        withdrawal can price off it, which removes the post-reconcile par-exit dodge
///        (C-02, S-17).
///      * Withdrawals are risk-priced: an exiting LP is haircut by its pro-rata share of
///        the bucket's *pending* (unreconciled) intrinsic exposure, marked at the current
///        oracle price (C-01 leg 1, H-01).
///      * Shares are time-locked for WITHDRAW_COOLDOWN after every deposit whenever the
///        bucket carries risk (`locked > 0`), which kills the atomic
///        deposit -> buy -> withdraw -> self-rebate loop and JIT premium capture
///        (C-01 leg 2, H-02).
///      * Payouts are never pushed to an address that can block them: a failing transfer
///        is credited to `credits[asset][holder]` and pulled with `claimCredit` (S-14).
///      * Active expiries are tracked per bucket, so the withdrawal freeze sees every
///        unreconciled series with OI, not two hard-coded expiries (S-19, M-02).
///      * `sweepSeries` releases the reserve of an abandoned series after
///        `expiry + SWEEP_DELAY` (M-01, S-08).
///
///      qty is 1e18 fixed point (1e18 = option on 1 whole underlying token).
///      Prices/strikes are quote-per-whole-underlying, 1e18 fixed point.
contract PitPool is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ---------------------------------------------------------------- types

    struct Bucket {
        uint128 free; // collateral wei available to write against / withdraw
        uint128 locked; // collateral wei locked under open + unreconciled + reserved series
        uint128 totalShares; // par shares: 1 share == 1 collateral wei deposited
        uint128 reservedPayout; // sum of owedPayout over reconciled-but-unsettled series (packed with totalShares)
        uint256 accPremPerShare; // quote wei premium per share, ACC_SCALE-scaled
        int256 accPnlPerShare; // realised collateral P&L per share, ACC_SCALE-scaled (<= 0 typically)
        uint256 premDust; // truncated premium carried to the next accrual (L-01)
        uint256 premBank; // quote wei held for premium payouts, never collateral (V6-01)
    }

    /// @dev ABI-frozen 2-field layout (test/pit/PitHandler.sol destructures 2 values).
    ///      Per-LP P&L debt and the deposit cooldown live in their own mappings.
    struct LpPosition {
        uint128 shares;
        int256 premDebt; // MasterChef-style accumulator debt (quote wei, ACC_SCALE-scaled product)
    }

    /// @dev ABI-frozen 5-field layout. `multiplier` holds the write-time uiMultiplier
    ///      until reconcile, then the reconcile-time SNAPSHOT used by every payout (S-04).
    struct Series {
        uint128 lockedColl; // collateral wei locked for this (bucket, expiry)
        uint128 oiQty; // open interest, qty units
        uint128 owedPayout; // reserved payout after reconcile (collateral wei)
        uint128 multiplier; // write multiplier pre-reconcile; settlement snapshot post-reconcile
        bool reconciled;
    }

    // ---------------------------------------------------------------- config

    uint256 public constant VIRTUAL_SHARES = 1e3; // retained for ABI compatibility (par shares need no offset)
    uint256 public constant ACC_SCALE = 1e24; // accumulator precision (6-dec quote safe)
    uint256 public constant WAD = 1e18;
    uint16 public constant BPS = 10_000;
    uint64 public constant WEEK = 7 days;
    /// Thu 1 Jan 1970 00:00 UTC + 4 days + 20h = Mon 5 Jan 1970 20:00 UTC — weekly anchor (expiries land on MONDAYS 20:00 UTC)
    uint64 public constant EXPIRY_ANCHOR = 4 days + 20 hours;
    uint64 public constant MAX_TENOR = 28 days;
    uint64 public constant FREEZE_WINDOW = 1 hours; // no buys/withdrawals pre-expiry
    uint64 public constant KEEPER_DELAY = 2 hours; // holder-exclusive claim window post-expiry
    uint64 public constant WITHDRAW_COOLDOWN = 24 hours; // share time-lock while the bucket carries risk
    uint64 public constant SETTLE_GRACE = 2 hours; // post-expiry reconcile window (bounded freeze)
    uint64 public constant SWEEP_DELAY = 90 days; // abandoned-series reserve release
    uint128 public constant MIN_QTY = 0.01e18; // dust-griefing floor
    uint256 public constant MAX_ACTIVE_EXPIRIES = 12; // bounded per-bucket freeze/mark loops

    IERC20 public immutable underlying;
    IERC20 public immutable quote;
    IPitOracle public immutable oracle;
    PitTicket public immutable ticket;
    IPitFactoryMinimal public immutable factory;
    uint256 public immutable strikeSpacing; // 1e18 fp, immutable per pool
    uint256 public immutable underlyingScale; // 10**underlyingDecimals
    uint256 public immutable quoteScale; // 10**quoteDecimals
    uint16 public immutable sigmaBps; // annualized vol for quoting (bounded by factory)
    uint128 public immutable maxOiPerSeries; // qty cap per (bucket, expiry)

    // buckets[isCall][strike]
    mapping(bool => mapping(uint256 => Bucket)) public buckets;
    mapping(bool => mapping(uint256 => mapping(address => LpPosition))) public lps;
    mapping(bool => mapping(uint256 => mapping(uint64 => Series))) public series;

    /// @notice Realised-P&L accumulator debt per LP (ACC_SCALE-scaled product, signed).
    mapping(bool => mapping(uint256 => mapping(address => int256))) public pnlDebt;
    /// @notice Timestamp from which an LP's shares in a bucket may be withdrawn (C-01/H-02).
    mapping(bool => mapping(uint256 => mapping(address => uint64))) public shareUnlockAt;
    /// @notice Expiries with live or unreconciled state in a bucket (S-19).
    mapping(bool => mapping(uint256 => uint64[])) public activeExpiries;
    mapping(bool => mapping(uint256 => mapping(uint64 => bool))) public seriesTracked;
    /// @notice Series whose abandoned reserve was swept back to LPs (M-01/S-08).
    mapping(bool => mapping(uint256 => mapping(uint64 => bool))) public seriesSwept;
    /// @notice Pull-payment credits when a push transfer fails (S-14): credits[asset][account].
    mapping(address => mapping(address => uint256)) public credits;

    // ---------------------------------------------------------------- events

    event Deposited(address indexed lp, bool isCall, uint256 strike, uint256 amount, uint256 shares);
    event Withdrawn(address indexed lp, bool isCall, uint256 strike, uint256 amount, uint256 shares);
    event PremiumsClaimed(address indexed lp, bool isCall, uint256 strike, uint256 amount);
    event Bought(
        address indexed buyer,
        uint256 indexed ticketId,
        bool isCall,
        uint256 strike,
        uint64 expiry,
        uint256 qty,
        uint256 premium,
        uint256 fee
    );
    event Reconciled(
        bool isCall, uint256 strike, uint64 indexed expiry, uint256 settlePrice, uint256 owed, uint256 released
    );
    event TicketSettled(
        uint256 indexed ticketId, address indexed holder, uint256 payout, uint256 keeperFee, address keeper
    );
    event SeriesResidualReleased(bool isCall, uint256 strike, uint64 indexed expiry, uint256 residual);
    event SeriesSwept(bool isCall, uint256 strike, uint64 indexed expiry, uint256 released, address caller);
    event PayoutCredited(address indexed asset, address indexed account, uint256 amount);
    event CreditClaimed(address indexed asset, address indexed account, uint256 amount);
    event LossRealised(bool isCall, uint256 strike, uint64 indexed expiry, uint256 loss);

    // ---------------------------------------------------------------- errors

    error Paused();
    error BadStrike();
    error BadExpiry();
    error BadQty();
    error SlippageExceeded();
    error InsufficientLiquidity();
    error OiCapExceeded();
    error FrozenWindow();
    error NotSettled();
    error NotReconciled();
    error AlreadyReconciled();
    error NothingToClaim();
    error NotTicketHolder();
    error KeeperTooEarly();
    error MultiplierChanged();
    error NonStandardToken();
    error ZeroAmount();
    error WrongPoolTicket();
    error SharesLocked(); // v2: deposit cooldown while the bucket carries risk (C-01/H-02)
    error TooManyActiveExpiries(); // v2: bounded freeze/mark loops (S-19)
    error SweepTooEarly(); // v2: abandoned-series sweep window (M-01/S-08)

    // ---------------------------------------------------------------- setup

    constructor(
        IERC20 underlying_,
        IERC20 quote_,
        IPitOracle oracle_,
        PitTicket ticket_,
        address factory_,
        uint256 strikeSpacing_,
        uint256 underlyingScale_,
        uint256 quoteScale_,
        uint16 sigmaBps_,
        uint128 maxOiPerSeries_
    ) {
        underlying = underlying_;
        quote = quote_;
        oracle = oracle_;
        ticket = ticket_;
        /* Passed explicitly (not msg.sender) because pools are deployed by
           PitPoolDeployer, which exists only to keep PitFactory under the
           EIP-170 code-size limit. */
        factory = IPitFactoryMinimal(factory_);
        strikeSpacing = strikeSpacing_;
        underlyingScale = underlyingScale_;
        quoteScale = quoteScale_;
        sigmaBps = sigmaBps_;
        maxOiPerSeries = maxOiPerSeries_;
    }

    // ---------------------------------------------------------------- LP side

    /// @notice Deposit collateral into a strike bucket. CALL buckets take underlying,
    ///         PUT buckets take quote. Shares are par (1 share == 1 collateral wei);
    ///         realised P&L is carried by the per-share accumulators, not the share price.
    function deposit(bool isCall, uint256 strike, uint256 amount) external nonReentrant returns (uint256 shares) {
        if (factory.paused()) revert Paused();
        _validStrike(strike);
        if (amount == 0) revert ZeroAmount();

        IERC20 asset = isCall ? underlying : quote;
        // balance-delta check: reject fee-on-transfer / rebasing collateral
        uint256 balBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        if (asset.balanceOf(address(this)) - balBefore != amount) revert NonStandardToken();

        Bucket storage b = buckets[isCall][strike];
        shares = amount; // H-03: par shares, no ratchet, no uint128 brick
        b.free += amount.toUint128();
        b.totalShares += shares.toUint128();

        LpPosition storage lp = lps[isCall][strike][msg.sender];
        lp.shares += shares.toUint128();
        lp.premDebt += int256(Math.mulDiv(shares, b.accPremPerShare, 1)); // ACC_SCALE-scaled product
        pnlDebt[isCall][strike][msg.sender] += b.accPnlPerShare * int256(shares);
        // C-01/H-02: fresh capital is time-locked; the lock only bites while the bucket
        // carries risk, so a risk-free bucket keeps instant-exit liveness.
        shareUnlockAt[isCall][strike][msg.sender] = uint64(block.timestamp) + WITHDRAW_COOLDOWN;

        emit Deposited(msg.sender, isCall, strike, amount, shares);
    }

    /// @notice Withdraw by burning shares. The exit price is
    ///         `shares + realised P&L - pro-rata pending (unreconciled) intrinsic`,
    ///         so an exiting LP can neither dodge a realised loss (C-02/S-17) nor dump
    ///         pending ITM exposure on the LPs that stay (C-01/H-01). Blocked inside the
    ///         pre-expiry freeze window while any tracked series in this bucket is
    ///         unreconciled with OI (S-19), and while the caller's shares are still in
    ///         the post-deposit cooldown of a risk-carrying bucket (C-01/H-02).
    function withdraw(bool isCall, uint256 strike, uint256 shares_) external nonReentrant returns (uint256 amount) {
        _validStrike(strike);
        if (shares_ == 0) revert ZeroAmount();
        _checkFreeze(isCall, strike);

        Bucket storage b = buckets[isCall][strike];
        LpPosition storage lp = lps[isCall][strike][msg.sender];
        uint256 lpShares = lp.shares;
        if (lpShares < shares_) revert InsufficientLiquidity();
        if (b.locked > 0 && block.timestamp < shareUnlockAt[isCall][strike][msg.sender]) revert SharesLocked();

        // ---- realised P&L attributable to the exiting shares (charged at reconcile)
        int256 debtSlice = _mulDivSigned(pnlDebt[isCall][strike][msg.sender], shares_, lpShares);
        int256 pnl = _divFloor(b.accPnlPerShare * int256(shares_) - debtSlice, int256(ACC_SCALE));
        int256 valued = int256(shares_) + pnl;

        // ---- mark-to-market haircut for pending (unreconciled) exposure
        uint256 haircut;
        uint256 pending = _pendingLoss(isCall, strike);
        if (pending > 0 && b.totalShares > 0) {
            haircut = Math.mulDiv(pending, shares_, b.totalShares, Math.Rounding.Ceil);
            valued -= int256(haircut);
        }
        amount = valued > 0 ? uint256(valued) : 0;
        if (amount > b.free) revert InsufficientLiquidity(); // can only draw on unlocked
        // the last LP out cannot abandon the bucket while it still carries risk:
        // locked collateral must always have a share base behind it.
        if (b.totalShares == shares_ && b.locked > 0) revert InsufficientLiquidity();

        // ---- effects
        lp.shares = uint128(lpShares - shares_);
        lp.premDebt -= int256(Math.mulDiv(shares_, b.accPremPerShare, 1));
        pnlDebt[isCall][strike][msg.sender] -= debtSlice;
        b.totalShares -= shares_.toUint128();
        b.free -= amount.toUint128();

        // value the exiting LP left behind (its share of pending risk) belongs to stayers
        int256 forgone = int256(shares_) + pnl - int256(amount);
        if (forgone > 0) _creditGain(b, uint256(forgone));

        (isCall ? underlying : quote).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, isCall, strike, amount, shares_);
    }

    /// @notice Claim accrued premiums (always in quote) for a bucket position.
    function claimPremiums(bool isCall, uint256 strike) external nonReentrant returns (uint256 owed) {
        _validStrike(strike); // L-02: off-grid strikes are not addressable
        LpPosition storage lp = lps[isCall][strike][msg.sender];
        Bucket storage b = buckets[isCall][strike];
        int256 accumulated = int256(Math.mulDiv(lp.shares, b.accPremPerShare, 1));
        int256 owedSigned = accumulated - lp.premDebt;
        if (owedSigned <= 0) revert NothingToClaim();
        owed = uint256(owedSigned) / ACC_SCALE;
        // V6-01: solvency clamp. `floor(sum of per-share accruals)` can exceed the
        // sum of the per-accrual floors that `_collectPremium` actually reserved,
        // so an unclamped claim could pay out up to ~1 wei per accrual from the
        // bucket's collateral. Paying only out of the banked premium makes the
        // "balance >= free + locked" invariant hold exactly.
        if (owed > b.premBank) owed = b.premBank;
        if (owed == 0) revert NothingToClaim();
        b.premBank -= owed;
        // Credit debt for exactly what was paid (not the full accumulator), so any
        // sub-wei or clamped remainder stays claimable instead of being forfeited.
        lp.premDebt += int256(owed) * int256(ACC_SCALE);
        quote.safeTransfer(msg.sender, owed);
        emit PremiumsClaimed(msg.sender, isCall, strike, owed);
    }

    /// @notice Pull a payout that could not be pushed (blocklisted holder, hostile
    ///         receiver, etc.). Value is never confiscated, only re-routed (S-14).
    function claimCredit(address asset) external nonReentrant returns (uint256 amount) {
        amount = credits[asset][msg.sender];
        if (amount == 0) revert NothingToClaim();
        credits[asset][msg.sender] = 0;
        IERC20(asset).safeTransfer(msg.sender, amount);
        emit CreditClaimed(asset, msg.sender, amount);
    }

    // ---------------------------------------------------------------- buyer side

    /// @notice Buy a fully-collateralized option. Premium is quoted from the oracle
    ///         TWAP + bounded time value, paid in quote. Collateral locks instantly.
    function buy(bool isCall, uint256 strike, uint64 expiry, uint128 qty, uint256 maxPremium)
        external
        nonReentrant
        returns (uint256 ticketId, uint256 premium)
    {
        if (factory.paused()) revert Paused();
        _validStrike(strike);
        _validExpiry(expiry);
        if (qty < MIN_QTY) revert BadQty();
        if (block.timestamp + FREEZE_WINDOW >= expiry) revert FrozenWindow();

        // ---- price
        {
            uint256 price = oracle.quotePrice(address(underlying));
            uint256 premPerUnit =
                PitPricer.premiumPerUnit(price, strike, expiry - block.timestamp, sigmaBps, isCall, block.timestamp);
            premium = _toQuoteWei(Math.mulDiv(qty, premPerUnit, WAD, Math.Rounding.Ceil), Math.Rounding.Ceil);
        }
        if (premium == 0 || premium > maxPremium) revert SlippageExceeded();

        uint128 m = _lockCollateral(isCall, strike, expiry, qty);
        uint256 fee = _collectPremium(isCall, strike, premium);

        // ---- ticket (plain _mint, no callback; state fully written above)
        ticketId = ticket.mint(
            msg.sender,
            PitTicket.TicketData({
                pool: address(this),
                underlying: address(underlying),
                isCall: isCall,
                expiry: expiry,
                strike1e18: uint128(strike),
                qty: qty,
                premiumPaid: premium.toUint128(),
                writeMultiplier: m
            })
        );
        emit Bought(msg.sender, ticketId, isCall, strike, expiry, qty, premium, fee);
    }

    /// @dev buy() helper: lock series collateral, enforce OI cap + uniform multiplier,
    ///      and register the expiry as active for this bucket (S-19).
    function _lockCollateral(bool isCall, uint256 strike, uint64 expiry, uint128 qty) internal returns (uint128 m) {
        uint256 lockAmt = _collateralFor(isCall, strike, qty, Math.Rounding.Ceil);
        Bucket storage b = buckets[isCall][strike];
        if (lockAmt > b.free) revert InsufficientLiquidity();
        Series storage s = series[isCall][strike][expiry];
        if (s.reconciled || seriesSwept[isCall][strike][expiry]) revert AlreadyReconciled();
        if (uint256(s.oiQty) + qty > maxOiPerSeries) revert OiCapExceeded();

        m = _uiMultiplier();
        if (s.oiQty == 0 && s.lockedColl == 0) {
            s.multiplier = m;
        } else if (s.multiplier != m) {
            revert MultiplierChanged(); // corporate action mid-series: series is closed to new writes
        }

        if (!seriesTracked[isCall][strike][expiry]) {
            uint64[] storage list = activeExpiries[isCall][strike];
            if (list.length >= MAX_ACTIVE_EXPIRIES) revert TooManyActiveExpiries();
            list.push(expiry);
            seriesTracked[isCall][strike][expiry] = true;
        }

        b.free -= lockAmt.toUint128();
        b.locked += lockAmt.toUint128();
        s.lockedColl += lockAmt.toUint128();
        s.oiQty += qty;
    }

    /// @dev buy() helper: pull premium (standard-transfer enforced), route protocol fee
    ///      to the FeeSplitter, accrue the LP share to the bucket. Truncation dust is
    ///      carried forward instead of burned, and a premium accrued with no LPs present
    ///      is held as dust for the next accrual (L-01).
    function _collectPremium(bool isCall, uint256 strike, uint256 premium) internal returns (uint256 fee) {
        uint256 balBefore = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), premium);
        if (quote.balanceOf(address(this)) - balBefore != premium) revert NonStandardToken();

        fee = Math.mulDiv(premium, factory.pitFeeBps(), BPS);
        if (fee > 0) quote.safeTransfer(factory.feeSink(), fee);
        Bucket storage b = buckets[isCall][strike];
        // V6-01: bank the LP share of this premium. `premBank` is the hard ceiling
        // on everything `claimPremiums` may ever pay out of this bucket, so premium
        // rounding can never reach into deposited collateral. Increment by the
        // net-of-fee premium only — carried `premDust` was banked on its own accrual.
        b.premBank += premium - fee;
        uint256 net = premium - fee + b.premDust;
        if (b.totalShares > 0) {
            uint256 perShare = Math.mulDiv(net, ACC_SCALE, b.totalShares);
            b.accPremPerShare += perShare;
            b.premDust = net - Math.mulDiv(perShare, b.totalShares, ACC_SCALE);
        } else {
            b.premDust = net;
        }
    }

    // ---------------------------------------------------------------- settlement

    /// @notice Ensure the settlement price exists for `expiry` (snapshots via oracle if needed).
    function settle(uint64 expiry) public returns (uint256 price) {
        price = oracle.settlementPrice(address(underlying), expiry);
        if (price == 0) price = oracle.snapshotSettlement(address(underlying), expiry);
    }

    /// @notice Reconcile one (bucket, expiry): reserve exact owed payouts (rounded up),
    ///         release the rest of the series lock back to the bucket, and charge the
    ///         realised loss to the share base immediately (C-02/S-17). O(1) except for
    ///         the bounded active-expiry list update; permissionless.
    function reconcile(bool isCall, uint256 strike, uint64 expiry) external nonReentrant {
        _reconcile(isCall, strike, expiry);
    }

    function _reconcile(bool isCall, uint256 strike, uint64 expiry) internal {
        Series storage s = series[isCall][strike][expiry];
        if (s.reconciled) revert AlreadyReconciled();
        uint256 rawPrice = oracle.settlementPrice(address(underlying), expiry);
        if (rawPrice == 0) revert NotSettled();

        // S-04: the multiplier is snapshotted here and reused by every payout, so the
        // reserve and the per-ticket payouts are always computed on the same basis.
        uint128 mSnap = _uiMultiplier();
        uint256 price = _scalePrice(rawPrice, s.multiplier, mSnap);

        uint256 owed = _owedAt(price, isCall, strike, s.oiQty);
        if (owed > s.lockedColl) owed = s.lockedColl; // hard cap: payouts can never exceed the series lock

        uint256 released = uint256(s.lockedColl) - owed;
        s.owedPayout = owed.toUint128();
        s.lockedColl = owed.toUint128(); // remaining lock == reserved payout
        s.multiplier = mSnap;
        s.reconciled = true;

        Bucket storage b = buckets[isCall][strike];
        b.locked -= released.toUint128();
        b.free += released.toUint128();
        b.reservedPayout += owed.toUint128();
        // C-02: the loss is realised against the share base NOW, before anyone can exit.
        if (owed > 0) {
            _chargeLoss(b, owed);
            emit LossRealised(isCall, strike, expiry, owed);
        }
        // a reconciled series contributes to neither the freeze nor the pending mark,
        // so it leaves the active list immediately (keeps the list from filling up).
        _untrackSeries(isCall, strike, expiry);

        emit Reconciled(isCall, strike, expiry, price, owed, released);
    }

    /// @notice Settle one ticket: pay intrinsic payout to the holder and burn the NFT.
    ///         Holder may claim immediately after reconcile; after KEEPER_DELAY anyone
    ///         may settle on the holder's behalf for a keeper fee cut from the payout
    ///         (no position depends on its owner's liveness). A payout that cannot be
    ///         pushed is credited for later pull, so no holder can brick the series (S-14).
    function settleTicket(uint256 ticketId) external nonReentrant returns (uint256 payout) {
        PitTicket.TicketData memory d = ticket.getTicket(ticketId);
        if (d.pool != address(this)) revert WrongPoolTicket();

        address holder = ticket.ownerOfTicket(ticketId);
        bool isKeeper = msg.sender != holder;
        if (isKeeper && block.timestamp < uint256(d.expiry) + KEEPER_DELAY) revert KeeperTooEarly();
        if (!isKeeper && block.timestamp < d.expiry) revert NotSettled();

        // M-01/S-08: a swept series has already returned its reserve to the LPs; the
        // ticket is only burned so the NFT does not linger.
        if (seriesSwept[d.isCall][d.strike1e18][d.expiry]) {
            ticket.burn(ticketId);
            emit TicketSettled(ticketId, holder, 0, 0, msg.sender);
            return 0;
        }

        Series storage s = series[d.isCall][d.strike1e18][d.expiry];
        if (!s.reconciled) {
            // auto-path: snapshot + reconcile if possible (both total, permissionless)
            settle(d.expiry);
            _reconcile(d.isCall, d.strike1e18, d.expiry);
        }

        payout = _ticketPayout(d, s.multiplier);
        if (payout > s.owedPayout) payout = s.owedPayout; // per-series payout cap (Aevo class)

        // effects
        s.owedPayout -= payout.toUint128();
        s.lockedColl -= payout.toUint128();
        s.oiQty -= d.qty;
        Bucket storage b = buckets[d.isCall][d.strike1e18];
        b.locked -= payout.toUint128();
        b.reservedPayout -= payout.toUint128();
        ticket.burn(ticketId);

        // residual release once the series is fully settled
        if (s.oiQty == 0 && s.lockedColl > 0) {
            uint128 residual = s.lockedColl;
            s.lockedColl = 0;
            s.owedPayout = 0;
            b.locked -= residual;
            b.free += residual;
            b.reservedPayout -= residual;
            _creditGain(b, residual); // reserved-but-unpaid value returns to the LPs
            emit SeriesResidualReleased(d.isCall, d.strike1e18, d.expiry, residual);
        }
        if (s.oiQty == 0) _untrackSeries(d.isCall, d.strike1e18, d.expiry);

        // interactions (never able to block the state transition above)
        uint256 keeperFee;
        if (payout > 0) {
            IERC20 asset = d.isCall ? underlying : quote;
            if (isKeeper) {
                keeperFee = Math.mulDiv(payout, factory.keeperFeeBps(), BPS);
                if (keeperFee > 0) _payOrCredit(asset, msg.sender, keeperFee);
            }
            _payOrCredit(asset, holder, payout - keeperFee);
        }
        emit TicketSettled(ticketId, holder, payout, keeperFee, msg.sender);
    }

    /// @notice Permissionless release of an abandoned series' reserve back to the LPs
    ///         once `expiry + SWEEP_DELAY` has passed (M-01/S-08). Holders keep a long
    ///         but finite claim window; after the sweep the reserve belongs to the LPs.
    function sweepSeries(bool isCall, uint256 strike, uint64 expiry) external nonReentrant returns (uint256 released) {
        _validStrike(strike);
        if (block.timestamp < uint256(expiry) + SWEEP_DELAY) revert SweepTooEarly();
        if (seriesSwept[isCall][strike][expiry]) revert AlreadyReconciled();

        Series storage s = series[isCall][strike][expiry];
        if (!s.reconciled) {
            settle(expiry);
            _reconcile(isCall, strike, expiry);
        }
        if (s.oiQty == 0 && s.lockedColl == 0) revert NothingToClaim();

        released = s.lockedColl;
        Bucket storage b = buckets[isCall][strike];
        s.lockedColl = 0;
        s.owedPayout = 0;
        s.oiQty = 0;
        seriesSwept[isCall][strike][expiry] = true;
        if (released > 0) {
            b.locked -= released.toUint128();
            b.free += released.toUint128();
            b.reservedPayout -= released.toUint128();
            _creditGain(b, released);
        }
        _untrackSeries(isCall, strike, expiry);
        emit SeriesSwept(isCall, strike, expiry, released, msg.sender);
    }

    /// @dev Intrinsic payout for one ticket at the (multiplier-adjusted) settlement price.
    ///      `mSnap` is the reconcile-time multiplier snapshot (S-04), so the reserve and
    ///      the payouts can never be computed on different bases.
    ///      Rounds down (per-ticket floor vs per-series ceil reserve → Σ paid ≤ owed).
    function _ticketPayout(PitTicket.TicketData memory d, uint128 mSnap) internal view returns (uint256 payout) {
        uint256 rawPrice = oracle.settlementPrice(address(underlying), d.expiry);
        uint256 price = _scalePrice(rawPrice, d.writeMultiplier, mSnap);
        if (d.isCall) {
            uint256 fracPerUnit = PitPricer.callPayoutUnderlyingPerUnit(price, d.strike1e18);
            payout = Math.mulDiv(Math.mulDiv(d.qty, fracPerUnit, WAD), underlyingScale, WAD); // round down
        } else {
            uint256 quotePerUnit = PitPricer.putPayoutQuotePerUnit(price, d.strike1e18);
            payout = _toQuoteWei(Math.mulDiv(d.qty, quotePerUnit, WAD), Math.Rounding.Floor);
        }
    }

    // ---------------------------------------------------------------- views

    /// @notice Quote a premium without trading (UI helper).
    function quotePremium(bool isCall, uint256 strike, uint64 expiry, uint128 qty)
        external
        view
        returns (uint256 premium, uint256 price)
    {
        price = oracle.quotePrice(address(underlying));
        uint256 t = expiry > block.timestamp ? expiry - block.timestamp : 0;
        uint256 premPerUnit = PitPricer.premiumPerUnit(price, strike, t, sigmaBps, isCall, block.timestamp);
        premium = _toQuoteWei(Math.mulDiv(qty, premPerUnit, WAD, Math.Rounding.Ceil), Math.Rounding.Ceil);
    }

    function bucketState(bool isCall, uint256 strike)
        external
        view
        returns (uint256 free, uint256 locked, uint256 totalShares)
    {
        Bucket storage b = buckets[isCall][strike];
        return (b.free, b.locked, b.totalShares);
    }

    /// @notice Risk view for UIs/keepers: reserved (post-reconcile) payouts, pending
    ///         (pre-reconcile) mark-to-market exposure, and the count of active expiries.
    function bucketRisk(bool isCall, uint256 strike)
        external
        view
        returns (uint256 reservedPayout, uint256 pendingLoss, uint256 activeCount)
    {
        Bucket storage b = buckets[isCall][strike];
        return (b.reservedPayout, _pendingLoss(isCall, strike), activeExpiries[isCall][strike].length);
    }

    /// @notice What `withdraw(isCall, strike, shares_)` would pay right now.
    function previewWithdraw(bool isCall, uint256 strike, address lpAddr, uint256 shares_)
        external
        view
        returns (uint256 amount)
    {
        Bucket storage b = buckets[isCall][strike];
        uint256 lpShares = lps[isCall][strike][lpAddr].shares;
        if (shares_ == 0 || lpShares < shares_) return 0;
        int256 debtSlice = _mulDivSigned(pnlDebt[isCall][strike][lpAddr], shares_, lpShares);
        int256 valued =
            int256(shares_) + _divFloor(b.accPnlPerShare * int256(shares_) - debtSlice, int256(ACC_SCALE));
        uint256 pending = _pendingLoss(isCall, strike);
        if (pending > 0 && b.totalShares > 0) {
            valued -= int256(Math.mulDiv(pending, shares_, b.totalShares, Math.Rounding.Ceil));
        }
        return valued > 0 ? uint256(valued) : 0;
    }

    function activeExpiryCount(bool isCall, uint256 strike) external view returns (uint256) {
        return activeExpiries[isCall][strike].length;
    }

    /// @notice Next valid expiry strictly after `ts` (Fridays 20:00 UTC).
    function nextExpiryAfter(uint256 ts) public pure returns (uint64) {
        uint256 sinceAnchor = ts - EXPIRY_ANCHOR;
        return uint64(EXPIRY_ANCHOR + ((sinceAnchor / WEEK) + 1) * WEEK);
    }

    // ---------------------------------------------------------------- internals

    function _validStrike(uint256 strike) internal view {
        if (strike == 0 || strike % strikeSpacing != 0 || strike > type(uint128).max) revert BadStrike();
    }

    function _validExpiry(uint64 expiry) internal view {
        if (expiry <= block.timestamp) revert BadExpiry();
        if ((uint256(expiry) - EXPIRY_ANCHOR) % WEEK != 0) revert BadExpiry();
        if (expiry > block.timestamp + MAX_TENOR) revert BadExpiry();
    }

    /// @dev S-19/M-02: withdrawals freeze while ANY tracked series in this bucket is
    ///      unreconciled with OI and inside (or past) its pre-expiry freeze window —
    ///      not just the two hard-coded expiries v1 probed. Later expiries with OI are
    ///      not frozen (that would break liveness for 4-week tenors); their exposure is
    ///      priced into the withdrawal instead (see `_pendingLoss`).
    /// @dev S-19: the freeze covers EVERY tracked expiry of the bucket, not just the two
    ///      probed by v1. The frozen interval is `[e - FREEZE_WINDOW, e + SETTLE_GRACE]`
    ///      so it stays bounded: a series that can never be reconciled cannot lock LPs
    ///      out forever (S-10), it is simply marked by `_pendingLoss` from then on.
    function _checkFreeze(bool isCall, uint256 strike) internal view {
        uint64[] storage list = activeExpiries[isCall][strike];
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            uint64 e = list[i];
            Series storage s = series[isCall][strike][e];
            if (s.reconciled || s.oiQty == 0) continue;
            if (block.timestamp + FREEZE_WINDOW >= e && block.timestamp <= uint256(e) + SETTLE_GRACE) {
                revert FrozenWindow();
            }
        }
    }

    /// @dev Pro-rata-able pending loss: intrinsic value, marked at the CURRENT oracle
    ///      price, of every unreconciled series with OI in this bucket (C-01/H-01/M-03).
    ///      If the oracle cannot serve a price the full remaining lock is assumed at
    ///      risk, so a dead oracle can never make exits cheap (it only makes them dear).
    function _pendingLoss(bool isCall, uint256 strike) internal view returns (uint256 loss) {
        uint64[] storage list = activeExpiries[isCall][strike];
        uint256 n = list.length;
        if (n == 0) return 0;

        uint256 price;
        try oracle.quotePrice(address(underlying)) returns (uint256 p) {
            price = p;
        } catch {
            price = 0;
        }
        uint128 mNow = _uiMultiplier();

        for (uint256 i; i < n; ++i) {
            Series storage s = series[isCall][strike][list[i]];
            if (s.reconciled || s.oiQty == 0 || s.lockedColl == 0) continue;
            uint256 owed;
            if (price == 0) {
                owed = s.lockedColl;
            } else {
                owed = _owedAt(_scalePrice(price, s.multiplier, mNow), isCall, strike, s.oiQty);
                if (owed > s.lockedColl) owed = s.lockedColl;
            }
            loss += owed;
        }
    }

    /// @dev Intrinsic collateral owed for `oiQty` at `price` (ceil — reserve rounds up).
    function _owedAt(uint256 price, bool isCall, uint256 strike, uint128 oiQty)
        internal
        view
        returns (uint256 owed)
    {
        if (oiQty == 0) return 0;
        if (isCall) {
            uint256 fracPerUnit = PitPricer.callPayoutUnderlyingPerUnit(price, strike);
            owed = Math.mulDiv(
                Math.mulDiv(oiQty, fracPerUnit, WAD, Math.Rounding.Ceil), underlyingScale, WAD, Math.Rounding.Ceil
            );
        } else {
            uint256 quotePerUnit = PitPricer.putPayoutQuotePerUnit(price, strike);
            owed = _toQuoteWei(Math.mulDiv(oiQty, quotePerUnit, WAD, Math.Rounding.Ceil), Math.Rounding.Ceil);
        }
    }

    /// @dev Charge a realised loss to the current share base (ceil: rounds against LPs,
    ///      so Σ claims ≤ assets and the bucket can never promise more than it holds).
    function _chargeLoss(Bucket storage b, uint256 loss) internal {
        if (loss == 0 || b.totalShares == 0) return;
        b.accPnlPerShare -= int256(Math.mulDiv(loss, ACC_SCALE, b.totalShares, Math.Rounding.Ceil));
    }

    /// @dev Credit released/forgone collateral back to the share base (floor).
    function _creditGain(Bucket storage b, uint256 gain) internal {
        if (gain == 0 || b.totalShares == 0) return;
        b.accPnlPerShare += int256(Math.mulDiv(gain, ACC_SCALE, b.totalShares));
    }

    function _untrackSeries(bool isCall, uint256 strike, uint64 expiry) internal {
        if (!seriesTracked[isCall][strike][expiry]) return;
        seriesTracked[isCall][strike][expiry] = false;
        uint64[] storage list = activeExpiries[isCall][strike];
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == expiry) {
                list[i] = list[n - 1];
                list.pop();
                return;
            }
        }
    }

    /// @dev S-14: push `amt` to `to`; on ANY failure credit it for later pull instead of
    ///      reverting, so no receiver can block settlement or strand the series reserve.
    function _payOrCredit(IERC20 asset, address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok, bytes memory ret) = address(asset).call(abi.encodeCall(IERC20.transfer, (to, amt)));
        bool success = ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
        if (!success) {
            credits[address(asset)][to] += amt;
            emit PayoutCredited(address(asset), to, amt);
        }
    }

    /// @dev Collateral to lock for qty at strike. CALL: qty whole underlying.
    ///      PUT: strike × qty in quote.
    function _collateralFor(bool isCall, uint256 strike, uint128 qty, Math.Rounding r)
        internal
        view
        returns (uint256)
    {
        if (isCall) {
            return Math.mulDiv(qty, underlyingScale, WAD, r);
        }
        return _toQuoteWei(Math.mulDiv(qty, strike, WAD, r), r);
    }

    /// @dev 1e18-fp quote amount → quote wei.
    function _toQuoteWei(uint256 amount1e18, Math.Rounding r) internal view returns (uint256) {
        return Math.mulDiv(amount1e18, quoteScale, WAD, r);
    }

    /// @dev Corporate-action normalization: adjust a raw price by
    ///      multiplier(reference) / multiplier(write). Solvency unaffected
    ///      (payouts capped by the series lock).
    function _scalePrice(uint256 rawPrice, uint128 writeMultiplier, uint128 refMultiplier)
        internal
        pure
        returns (uint256)
    {
        if (writeMultiplier == 0 || refMultiplier == 0 || refMultiplier == writeMultiplier) return rawPrice;
        return Math.mulDiv(rawPrice, refMultiplier, writeMultiplier);
    }

    function _uiMultiplier() internal view returns (uint128) {
        try IUiMultiplier(address(underlying)).uiMultiplier() returns (uint256 m) {
            if (m == 0 || m > type(uint128).max) return uint128(WAD);
            return uint128(m);
        } catch {
            return uint128(WAD);
        }
    }

    /// @dev floor division for signed values (Solidity truncates toward zero).
    function _divFloor(int256 a, int256 b) internal pure returns (int256) {
        int256 q = a / b;
        if ((a % b != 0) && ((a < 0) != (b < 0))) q -= 1;
        return q;
    }

    /// @dev a × num / den for a signed `a`, rounding toward negative infinity.
    function _mulDivSigned(int256 a, uint256 num, uint256 den) internal pure returns (int256) {
        if (a == 0 || num == 0) return 0;
        if (a >= 0) return int256(Math.mulDiv(uint256(a), num, den));
        return -int256(Math.mulDiv(uint256(-a), num, den, Math.Rounding.Ceil));
    }
}
