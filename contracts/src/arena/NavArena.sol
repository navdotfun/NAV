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
///      Settlement prices are permissionless, anchor-verified snapshots keyed by
///      (underlying, expiry): Chainlink round bracketing the expiry first, a Pyth
///      price pushed for the expiry window second, and a clamped pool TWAP as the
///      day-late doomsday fallback. Quote-wei (USDG, 6 dec) per 1e18 underlying.
///
///      NOTE ON TRUST: PitOracleV2 itself has an owner who can re-call
///      `setMarket` and repoint a market's feeds. NavArena defends in two
///      layers: (1) it pins a hash of each asset's market config at bout
///      creation and re-checks it at lock AND settle — a persistent config
///      change converts the bout into a full refund; (2) every consumed price
///      (start and end) must additionally match what the pinned source
///      actually printed — Chainlink bracket-round equality FIRST (a fresh
///      genuine bracket is authoritative and cannot be overridden), Pyth
///      benchmark equality only when no fresh bracket exists — so a snapshot
///      poisoned through a *transient* repoint of either the feed or the
///      pythId fails the consistency check and voids instead of settling.
///      Residual trust: when NO fresh Chainlink bracket exists for the expiry
///      (feed dead or its bracketing round older than 30 min — e.g. genuinely
///      off-hours), an oracle owner who repoints `pythId` can still force a
///      void-or-poisoned outcome for in-flight bouts; timelocking or
///      renouncing PitOracleV2 ownership removes this entirely.
interface IPitOracleSettle {
    function quotePrice(address underlying) external view returns (uint256 price);
    function settlementPrice(address underlying, uint64 expiry) external view returns (uint256);
    function pythSettlement(address underlying, uint64 expiry) external view returns (uint256);
    function snapshotSettlement(address underlying, uint64 expiry) external returns (uint256 price);
    function markets(address underlying)
        external
        view
        returns (
            address pool,
            address underlying_,
            address quote,
            bool underlyingIsToken0,
            uint8 underlyingDecimals,
            uint8 quoteDecimals,
            address chainlinkFeed,
            uint8 chainlinkDecimals,
            bytes32 pythId,
            bool pythUsesShares,
            uint16 maxFeedDeviationBps,
            uint16 maxSettleMoveBps
        );
}

/// @dev Minimal Chainlink aggregator surface used for the start-anchor
///      contemporaneity check (read-only; mirrors PitOracleV2's own search).
interface IChainlinkAggregatorMinimal {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/*//////////////////////////////////////////////////////////////////////////
                                  NAV ARENA
//////////////////////////////////////////////////////////////////////////*/

/// @title  NavArena — parimutuel stock-vs-stock outperformance markets ("bouts")
/// @notice The first on-chain outperformance market for tokenized equities. A bout
///         is a rivalry: does asset A outperform asset B between `entryClose` and
///         `settleTime`? Stakers back a side in USDG while entry is open; after the
///         window closes, winners split the losing pot pro-rata to their stake.
///
///         Dollar-neutral by construction — both legs are measured as
///         `end/start` performance ratios from the same oracle, so broad market
///         moves cancel and only the *relative* move decides the bout.
///
///         Fully decentralised:
///           - this contract is ownerless: no admin, no pause, no parameters to
///             tune; every constant is fixed at compile time (the oracle it reads
///             has an owner — see the config-pinning note on IPitOracleSettle);
///           - permissionless lifecycle: anyone creates bouts, anyone locks them,
///             anyone settles them (settler earns a bounty), anyone voids a bout
///             that missed its resolution window;
///           - prices only ever come from PitOracleV2 settlement storage — and
///             only through its anchor-verified paths. The oracle's day-late TWAP
///             doomsday fallback is *provably unreachable* here: it exists only
///             for timestamps strictly beyond expiry + 24h, while every Arena
///             resolution hard-stops at exactly +24h and voids afterwards.
///
///         Anti-sniping protections (parimutuel markets die without them):
///           - staking closes STAKE_BUFFER before `entryClose`, so late entries
///             cannot react to a start price that is already forming;
///           - at lock, both start anchors must be *contemporaneous* with
///             `entryClose` (a Pyth benchmark print inside the expiry window, or
///             a Chainlink round within MAX_START_ANCHOR_AGE). A bout whose
///             start price would be hours stale — weekends, halts, after-hours
///             earnings — voids and refunds instead of locking on dead quotes.
///
///         Economics stakers must understand (by design, standard parimutuel):
///           - stakes are final — there is no unstake; entering early means
///             accepting that later entries will move the implied odds;
///           - a bout voids (full refund, no fee) whenever a fair settlement
///             cannot be guaranteed: one-sided pots, draws, stale start anchors,
///             oracle config changes, or a missed resolution window.
///
///         Fee: 2% of the *losing* pot only, on settlement. 10% of the fee pays
///         the settling caller; 90% flows to AccumulatorV2 (NAV buy pressure) —
///         the same rail Credit origination fees ride. Voided bouts refund in
///         full and pay no fee.
contract NavArena is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////////////
                                   CONSTANTS
    //////////////////////////////////////////////////////////////////////*/

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    /// @notice Fee on the losing pot at settlement, bps.
    uint256 public constant FEE_BPS = 200;
    /// @notice Share of the fee paid to the settling caller, bps of the fee.
    uint256 public constant BOUNTY_SHARE_BPS = 1000;
    /// @notice Minimum stake per call (1 USDG).
    uint256 public constant MIN_STAKE = 1e6;
    /// @notice Entry window bounds relative to bout creation.
    uint64 public constant MIN_ENTRY = 1 hours;
    uint64 public constant MAX_ENTRY = 7 days;
    /// @notice Measurement window bounds (entryClose -> settleTime).
    uint64 public constant MIN_WINDOW = 1 hours;
    uint64 public constant MAX_WINDOW = 30 days;
    /// @notice Staking closes this long before `entryClose`. Entries cannot be
    ///         timed against a start price that is already effectively known.
    uint64 public constant STAKE_BUFFER = 30 minutes;
    /// @notice Hard deadline for lock after `entryClose` and for settle after
    ///         `settleTime`. Chosen equal to the oracle's TWAP_FALLBACK_DELAY:
    ///         the doomsday TWAP only exists strictly *after* expiry + 24h, so a
    ///         resolution that happens at or before +24h can only ever have used
    ///         an anchor-verified price. Past the deadline the bout voids.
    uint64 public constant RESOLUTION_WINDOW = 24 hours;
    /// @notice Maximum allowed age of a Chainlink start anchor relative to
    ///         `entryClose`. Anything older means the market was not trading
    ///         around entry close (weekend/halt/after-hours) and the bout voids.
    uint64 public constant MAX_START_ANCHOR_AGE = 30 minutes;

    /*//////////////////////////////////////////////////////////////////////
                                    STORAGE
    //////////////////////////////////////////////////////////////////////*/

    enum State {
        Open, // staking; before entryClose
        Locked, // start prices snapped; measurement running
        Settled, // end prices snapped; winners claim
        Voided // refunds for everyone; no fee
    }

    /// @dev Packed to 8 slots: (assetA|entryClose|state|winner),
    ///      (assetB|settleTime), (potA|potB), configHash, 4 price words.
    struct Bout {
        address assetA;
        uint64 entryClose; // staking deadline; start-price expiry key
        State state;
        uint8 winner; // 1 = A, 2 = B; 0 until settled
        address assetB;
        uint64 settleTime; // end-price expiry key
        uint128 potA;
        uint128 potB;
        bytes32 configHash; // oracle market-config pin for both assets
        uint256 startA; // 1e18-scaled USDG price per whole token
        uint256 startB;
        uint256 endA;
        uint256 endB;
    }

    /// @notice Stake token (USDG, 6 decimals).
    IERC20 public immutable usdg;
    /// @notice Price source — live PitOracleV2.
    IPitOracleSettle public immutable oracle;
    /// @notice Protocol fee sink — live AccumulatorV2 (buys NAV).
    address public immutable accumulator;

    uint256 public nextBoutId;
    mapping(uint256 => Bout) public bouts;
    /// @dev boutId => staker => stake per side. Zeroed on claim.
    mapping(uint256 => mapping(address => uint128)) public stakeA;
    mapping(uint256 => mapping(address => uint128)) public stakeB;

    /*//////////////////////////////////////////////////////////////////////
                                EVENTS / ERRORS
    //////////////////////////////////////////////////////////////////////*/

    event BoutCreated(
        uint256 indexed boutId,
        address indexed assetA,
        address indexed assetB,
        uint64 entryClose,
        uint64 settleTime,
        address creator
    );
    event Staked(uint256 indexed boutId, address indexed staker, bool sideA, uint256 amount);
    event Locked(uint256 indexed boutId, uint256 startA, uint256 startB);
    event Settled(
        uint256 indexed boutId, uint8 winner, uint256 endA, uint256 endB, uint256 fee, uint256 bounty, address settler
    );
    event Voided(uint256 indexed boutId, string reason);
    event Claimed(uint256 indexed boutId, address indexed staker, uint256 payout);

    error BadAssets();
    error BadWindow();
    error BadState();
    error TooEarly();
    error TooLate();
    error StakeTooSmall();
    error StakeOverflow();
    error NothingToClaim();
    error OracleDead();

    /*//////////////////////////////////////////////////////////////////////
                                  CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////*/

    constructor(IERC20 usdg_, IPitOracleSettle oracle_, address accumulator_) {
        if (address(usdg_) == address(0) || address(oracle_) == address(0) || accumulator_ == address(0)) {
            revert BadAssets();
        }
        usdg = usdg_;
        oracle = oracle_;
        accumulator = accumulator_;
    }

    /*//////////////////////////////////////////////////////////////////////
                                   LIFECYCLE
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Open a new bout. Permissionless. Both assets must be live,
    ///         quotable markets on PitOracleV2 *now* — a bout can never be
    ///         created on a stale or unknown underlying. The oracle config of
    ///         both assets is hashed and pinned; any later `setMarket` change
    ///         voids the bout at lock/settle instead of resolving against a
    ///         repointed source.
    function createBout(address assetA, address assetB, uint64 entryClose, uint64 settleTime)
        external
        returns (uint256 boutId)
    {
        if (assetA == assetB || assetA == address(0) || assetB == address(0)) revert BadAssets();
        if (entryClose < block.timestamp + MIN_ENTRY || entryClose > block.timestamp + MAX_ENTRY) revert BadWindow();
        if (settleTime < entryClose + MIN_WINDOW || settleTime > entryClose + MAX_WINDOW) revert BadWindow();

        // Live-market probe: quotePrice reverts for unknown markets and for
        // markets whose anchor has decayed beyond the widest allowed band.
        if (oracle.quotePrice(assetA) == 0 || oracle.quotePrice(assetB) == 0) revert OracleDead();

        boutId = nextBoutId++;
        Bout storage b = bouts[boutId];
        b.assetA = assetA;
        b.assetB = assetB;
        b.entryClose = entryClose;
        b.settleTime = settleTime;
        b.configHash = _configHash(assetA, assetB);

        emit BoutCreated(boutId, assetA, assetB, entryClose, settleTime, msg.sender);
    }

    /// @notice Back a side with USDG while entry is open. Staking closes
    ///         STAKE_BUFFER before `entryClose`. Stakes are final (no unstake).
    function stake(uint256 boutId, bool sideA, uint256 amount) external nonReentrant {
        Bout storage b = bouts[boutId];
        if (b.state != State.Open || b.assetA == address(0)) revert BadState();
        if (block.timestamp + STAKE_BUFFER >= b.entryClose) revert TooLate();
        if (amount < MIN_STAKE) revert StakeTooSmall();
        if (amount > type(uint128).max) revert StakeOverflow();

        usdg.safeTransferFrom(msg.sender, address(this), amount);

        if (sideA) {
            b.potA += uint128(amount);
            stakeA[boutId][msg.sender] += uint128(amount);
        } else {
            b.potB += uint128(amount);
            stakeB[boutId][msg.sender] += uint128(amount);
        }
        emit Staked(boutId, msg.sender, sideA, amount);
    }

    /// @notice Lock a bout after entry closes: snap start prices from the oracle.
    ///         Voids instead of locking when a fair start cannot be guaranteed:
    ///         one-sided pots, a changed oracle config, or a stale start anchor.
    ///         Must happen within RESOLUTION_WINDOW of `entryClose`; afterwards
    ///         the bout can only be voided.
    function lock(uint256 boutId) external nonReentrant {
        Bout storage b = bouts[boutId];
        if (b.state != State.Open || b.assetA == address(0)) revert BadState();
        if (block.timestamp < b.entryClose) revert TooEarly();
        if (block.timestamp > uint256(b.entryClose) + RESOLUTION_WINDOW) revert TooLate();

        if (b.potA == 0 || b.potB == 0) {
            b.state = State.Voided;
            emit Voided(boutId, "one-sided");
            return;
        }

        if (_configHash(b.assetA, b.assetB) != b.configHash) {
            b.state = State.Voided;
            emit Voided(boutId, "config-changed");
            return;
        }

        uint256 pA = _settlement(b.assetA, b.entryClose);
        uint256 pB = _settlement(b.assetB, b.entryClose);

        // Start-anchor contemporaneity: both legs must have been priced by a
        // source that was demonstrably live around entryClose. A stale anchor
        // (weekend, halt, after-hours) is permanent for this expiry key — the
        // bout can never lock fairly, so it voids now.
        if (!_anchorFresh(b.assetA, b.entryClose, pA) || !_anchorFresh(b.assetB, b.entryClose, pB)) {
            b.state = State.Voided;
            emit Voided(boutId, "stale-anchor");
            return;
        }

        b.startA = pA;
        b.startB = pB;
        b.state = State.Locked;
        emit Locked(boutId, pA, pB);
    }

    /// @notice Settle a bout after the window ends: snap end prices, decide the
    ///         winner, route the fee, pay the settler bounty. Must happen within
    ///         RESOLUTION_WINDOW of `settleTime` — at or before that deadline the
    ///         oracle can only have served an anchor-verified price (its TWAP
    ///         fallback exists strictly after +24h). Afterwards the bout voids.
    function settle(uint256 boutId) external nonReentrant {
        Bout storage b = bouts[boutId];
        if (b.state != State.Locked) revert BadState();
        if (block.timestamp < b.settleTime) revert TooEarly();
        if (block.timestamp > uint256(b.settleTime) + RESOLUTION_WINDOW) revert TooLate();

        if (_configHash(b.assetA, b.assetB) != b.configHash) {
            b.state = State.Voided;
            emit Voided(boutId, "config-changed");
            return;
        }

        b.endA = _settlement(b.assetA, b.settleTime);
        b.endB = _settlement(b.assetB, b.settleTime);

        // End-anchor contemporaneity + price consistency: both legs must have
        // been priced by a source demonstrably live around settleTime, and the
        // consumed value must equal what that pinned source actually printed.
        // Mirrors the lock-time gate — a stale or inconsistent end anchor is
        // permanent for this expiry key, so the bout voids instead of settling
        // on truncated or fabricated measurements.
        if (!_anchorFresh(b.assetA, b.settleTime, b.endA) || !_anchorFresh(b.assetB, b.settleTime, b.endB)) {
            b.state = State.Voided;
            emit Voided(boutId, "stale-anchor");
            return;
        }

        // Performance ratios, 1e18 fixed point. Start prices are non-zero by
        // oracle construction (a zero settlement price can never be stored).
        uint256 perfA = Math.mulDiv(b.endA, WAD, b.startA);
        uint256 perfB = Math.mulDiv(b.endB, WAD, b.startB);

        if (perfA == perfB) {
            b.state = State.Voided;
            emit Voided(boutId, "draw");
            return;
        }

        bool aWins = perfA > perfB;
        b.winner = aWins ? 1 : 2;
        uint256 losingPot = aWins ? b.potB : b.potA;

        uint256 fee = (losingPot * FEE_BPS) / BPS;
        uint256 bounty = (fee * BOUNTY_SHARE_BPS) / BPS;
        b.state = State.Settled;

        if (bounty != 0) usdg.safeTransfer(msg.sender, bounty);
        if (fee - bounty != 0) usdg.safeTransfer(accumulator, fee - bounty);

        emit Settled(boutId, b.winner, b.endA, b.endB, fee, bounty, msg.sender);
    }

    /// @notice Void a bout that missed its resolution window. The windows are
    ///         disjoint by construction — lock ends at entryClose + 24h and
    ///         settle at settleTime + 24h, and voiding only opens strictly
    ///         afterwards — so a void can never race a live lock or settle.
    function voidBout(uint256 boutId) external {
        Bout storage b = bouts[boutId];
        if (b.assetA == address(0)) revert BadState();

        bool lockOverdue = b.state == State.Open && block.timestamp > uint256(b.entryClose) + RESOLUTION_WINDOW;
        bool settleOverdue = b.state == State.Locked && block.timestamp > uint256(b.settleTime) + RESOLUTION_WINDOW;
        if (!lockOverdue && !settleOverdue) revert TooEarly();

        b.state = State.Voided;
        emit Voided(boutId, lockOverdue ? "lock-overdue" : "settle-overdue");
    }

    /// @notice Claim entitlements. Voided: full refund of both sides' stakes.
    ///         Settled: winners receive principal + pro-rata share of the losing
    ///         pot net of fee; losing-side stakes close with a zero payout so a
    ///         claim marks the position resolved either way. Pull-based; stakes
    ///         are zeroed before any transfer.
    function claim(uint256 boutId) external nonReentrant {
        Bout storage b = bouts[boutId];
        uint256 payout;

        if (b.state == State.Voided) {
            uint256 sA = stakeA[boutId][msg.sender];
            uint256 sB = stakeB[boutId][msg.sender];
            if (sA == 0 && sB == 0) revert NothingToClaim();
            if (sA != 0) stakeA[boutId][msg.sender] = 0;
            if (sB != 0) stakeB[boutId][msg.sender] = 0;
            payout = sA + sB;
        } else if (b.state == State.Settled) {
            bool aWon = b.winner == 1;
            uint256 winStake = aWon ? stakeA[boutId][msg.sender] : stakeB[boutId][msg.sender];
            uint256 loseStake = aWon ? stakeB[boutId][msg.sender] : stakeA[boutId][msg.sender];
            if (winStake == 0 && loseStake == 0) revert NothingToClaim();

            if (winStake != 0) {
                if (aWon) stakeA[boutId][msg.sender] = 0;
                else stakeB[boutId][msg.sender] = 0;

                uint256 winPot = aWon ? b.potA : b.potB;
                uint256 losingPot = aWon ? b.potB : b.potA;
                uint256 netLosing = losingPot - (losingPot * FEE_BPS) / BPS;
                payout = winStake + Math.mulDiv(winStake, netLosing, winPot);
            }
            if (loseStake != 0) {
                if (aWon) stakeB[boutId][msg.sender] = 0;
                else stakeA[boutId][msg.sender] = 0;
            }
        } else {
            revert BadState();
        }

        if (payout != 0) usdg.safeTransfer(msg.sender, payout);
        emit Claimed(boutId, msg.sender, payout);
    }

    /*//////////////////////////////////////////////////////////////////////
                                     VIEWS
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Full bout struct (frontend convenience; auto-getter splits tuples).
    function getBout(uint256 boutId) external view returns (Bout memory) {
        return bouts[boutId];
    }

    /// @notice Live performance preview for a locked bout using current quotes.
    ///         Reverts while a market's quote is unavailable — view-only, never
    ///         used in settlement.
    function preview(uint256 boutId) external view returns (uint256 perfA, uint256 perfB) {
        Bout storage b = bouts[boutId];
        if (b.state != State.Locked) revert BadState();
        perfA = Math.mulDiv(oracle.quotePrice(b.assetA), WAD, b.startA);
        perfB = Math.mulDiv(oracle.quotePrice(b.assetB), WAD, b.startB);
    }

    /*//////////////////////////////////////////////////////////////////////
                                   INTERNALS
    //////////////////////////////////////////////////////////////////////*/

    /// @dev Read the oracle settlement price for (asset, expiry), snapping it
    ///      first if nobody has yet. Reverts with the oracle's own AnchorPending
    ///      while no valid anchor exists — callers simply retry within the
    ///      resolution window; past it the bout is voided instead.
    function _settlement(address asset, uint64 expiry) internal returns (uint256 price) {
        price = oracle.settlementPrice(asset, expiry);
        if (price == 0) price = oracle.snapshotSettlement(asset, expiry);
    }

    /// @dev Hash of the oracle market config fields that determine where prices
    ///      come from, for both assets. Pinned at creation, re-checked at every
    ///      resolution step.
    function _configHash(address assetA, address assetB) internal view returns (bytes32) {
        return keccak256(abi.encode(_assetConfig(assetA), _assetConfig(assetB)));
    }

    function _assetConfig(address asset) internal view returns (bytes32) {
        (
            address pool,
            ,
            ,
            ,
            ,
            ,
            address chainlinkFeed,
            ,
            bytes32 pythId,
            bool pythUsesShares,
            uint16 maxFeedDeviationBps,
            uint16 maxSettleMoveBps
        ) = oracle.markets(asset);
        return keccak256(abi.encode(pool, chainlinkFeed, pythId, pythUsesShares, maxFeedDeviationBps, maxSettleMoveBps));
    }

    /// @dev An anchor is contemporaneous when one of two rails confirms it,
    ///      checked in strict priority order (audit N-1):
    ///        (a) CHAINLINK FIRST — when the pinned feed has a round bracketing
    ///            the expiry that was updated within MAX_START_ANCHOR_AGE of it,
    ///            that round is AUTHORITATIVE: the consumed price must equal its
    ///            answer (scaled to 1e18) exactly, and nothing can override a
    ///            mismatch. A snapshot poisoned through a temporarily repointed
    ///            feed or a repointed pythId cannot match what the pinned,
    ///            genuine feed actually printed, so the bout voids (refund)
    ///            instead of settling on a fabricated price.
    ///        (b) PYTH FALLBACK — only when no fresh Chainlink bracket exists
    ///            (dead feed, stale round, or decode failure) is an exact match
    ///            with the pushed Pyth benchmark accepted; the oracle only
    ///            stores Pyth prints published inside [expiry, expiry + 30 min]
    ///            (parsePriceFeedUpdatesUnique — first print at/after expiry),
    ///            fresh and canonical by construction.
    ///      Ordering matters: checking Pyth equality first would let a poisoned
    ///      benchmark short-circuit a fresh genuine bracket that contradicts it.
    ///      The bracket set at/below expiry is immutable once expiry passes
    ///      (round timestamps are monotonic), so (a) can never appear after a
    ///      genuine Pyth-path snapshot and retroactively void it. Both rails are
    ///      deterministic and fail closed into voidBout.
    function _anchorFresh(address asset, uint64 expiry, uint256 snapped) internal view returns (bool) {
        (,,,,,, address feed, uint8 clDec,,,,) = oracle.markets(asset);
        if (feed != address(0)) {
            (int256 ans, uint256 bracketAt) = _clBracketAt(IChainlinkAggregatorMinimal(feed), expiry);
            if (bracketAt != 0 && uint256(expiry) - bracketAt <= MAX_START_ANCHOR_AGE) {
                return snapped == Math.mulDiv(uint256(ans), WAD, 10 ** clDec);
            }
        }
        uint256 py = oracle.pythSettlement(asset, expiry);
        return py != 0 && py == snapped;
    }

    /// @dev Answer and `updatedAt` of the latest Chainlink round at-or-before
    ///      `expiry`, searched exactly like PitOracleV2._chainlinkPriceAt (same
    ///      phase handling, same invariants), or (0, 0) when no usable round
    ///      exists.
    function _clBracketAt(IChainlinkAggregatorMinimal feed, uint64 expiry)
        internal
        view
        returns (int256, uint256)
    {
        uint80 latestId;
        int256 latestAnswer;
        uint256 latestAt;
        try feed.latestRoundData() returns (uint80 rid, int256 a, uint256, uint256 at, uint80) {
            (latestId, latestAnswer, latestAt) = (rid, a, at);
        } catch {
            return (int256(0), 0);
        }
        if (latestAnswer <= 0 || latestAt == 0) return (int256(0), 0);

        // Fast path: latest round is already at-or-before the expiry.
        if (latestAt <= expiry) return (latestAnswer, latestAt);

        // Binary search the current phase for the smallest round with
        // updatedAt > expiry; the bracketing round is the one before it.
        uint80 phase = latestId & ~uint80(type(uint64).max);
        uint64 lo = 1;
        uint64 hi = uint64(latestId); // invariant: updatedAt(hi) > expiry
        while (lo < hi) {
            uint64 mid = lo + (hi - lo) / 2;
            (int256 a, uint256 at) = _roundAt(feed, phase | uint80(mid));
            if (at == 0 || a <= 0) {
                lo = mid + 1; // missing/invalid early data: move up
            } else if (at > expiry) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        if (lo <= 1) return (int256(0), 0); // nothing in this phase at-or-before expiry
        (int256 ans, uint256 ansAt) = _roundAt(feed, phase | uint80(lo - 1));
        if (ans <= 0 || ansAt == 0 || ansAt > expiry) return (int256(0), 0);
        return (ans, ansAt);
    }

    function _roundAt(IChainlinkAggregatorMinimal feed, uint80 roundId)
        internal
        view
        returns (int256 answer, uint256 updatedAt)
    {
        try feed.getRoundData(roundId) returns (uint80, int256 a, uint256, uint256 at, uint80) {
            return (a, at);
        } catch {
            return (0, 0);
        }
    }
}
