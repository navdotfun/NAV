// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {TickMathMini} from "./TickMathMini.sol";

interface IUniswapV3PoolMinimal {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IChainlinkAggregatorMinimal {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

interface IPythMinimal {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    struct PriceFeed {
        bytes32 id;
        Price price;
        Price emaPrice;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256);
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PriceFeed[] memory priceFeeds);
}

interface IERC20DecimalsMinimal {
    function decimals() external view returns (uint8);
}

interface IUiMultiplierMinimal {
    function uiMultiplier() external view returns (uint256);
}

/// @title PitOracleV2 — externally-anchored, zero-keeper price reads for The Pit
/// @notice Replaces PitOracle v1's poked-heartbeat design with external anchors so no
///         manual action, schedule, keeper, or user heartbeat is ever required:
///
///         - `quotePrice`  : 30-min Uniswap v3 geometric TWAP, sanity-banded against the
///                           freshest external anchor (Chainlink push feed primary, Pyth
///                           backup). The band widens with anchor age instead of switching
///                           off at a freshness cliff, so weekend closes stay protected.
///         - `snapshotSettlement` : settlement price for (underlying, expiry) resolved
///                           AT the expiry timestamp, not at call time:
///                             1. Chainlink round bracketing the expiry (on-chain binary
///                                search over round history) — push feeds updated by
///                                Chainlink's DON, no action needed from anyone;
///                             2. else a Pyth price with publishTime inside
///                                [expiry, expiry + PYTH_SETTLE_WINDOW], pushed by anyone
///                                via the permissionless `pushPythSettlement`;
///                             3. else, only after TWAP_FALLBACK_DELAY, the pool TWAP
///                                clamped against the last known anchor (never bricks).
///                           This removes the "free look" of v1 (which snapshotted the
///                           live TWAP whenever first called) and the unclamped path for
///                           never-poked markets.
///         - `lastValidTwap` : kept for interface compatibility with PitYieldVault's
///                           deposit guard; now returns the freshest external anchor
///                           (price, updatedAt) instead of a poked TWAP.
///
///         There is no `poke` and no stored heartbeat. Nothing in this contract depends
///         on any party acting on a schedule.
/// @dev All prices are quote-wei per 1 whole underlying TOKEN, scaled to 1e18 fixed point
///      (same convention as v1). Chainlink "Robinhood X / USD" feeds already quote the
///      token. Pyth equity feeds quote the real-world share; markets flag
///      `pythUsesShares` so the share price is scaled by the stock token's
///      `uiMultiplier()` (token = uiMultiplier/1e18 shares).
contract PitOracleV2 is Ownable2Step {
    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    uint32 public constant TWAP_WINDOW = 30 minutes;
    uint16 public constant BPS = 10_000;
    /// Anchor age per widening period of the quote band (and TWAP-fallback clamp).
    uint256 public constant DECAY_PERIOD = 24 hours;
    /// Cap on band widening so a dead anchor cannot widen without limit.
    uint256 public constant MAX_DECAY_PERIODS = 7;
    /// A Chainlink round older than this at expiry is not a valid settlement anchor.
    uint256 public constant CL_SETTLE_MAX_AGE = 24 hours;
    /// Pyth settlement updates must have publishTime in [expiry, expiry + this window].
    uint64 public constant PYTH_SETTLE_WINDOW = 30 minutes;
    /// Pyth prices with confidence wider than this fraction of price are rejected.
    uint256 public constant MAX_CONF_BPS = 500;
    /// Only after this delay past expiry may settlement fall back to the pool TWAP.
    uint256 public constant TWAP_FALLBACK_DELAY = 24 hours;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    struct MarketConfig {
        address pool; // Uniswap v3 pool for underlying/quote (TWAP source)
        address underlying;
        address quote;
        bool underlyingIsToken0;
        uint8 underlyingDecimals;
        uint8 quoteDecimals;
        address chainlinkFeed; // token-denominated push feed; 0 = none
        uint8 chainlinkDecimals; // cached at setMarket
        bytes32 pythId; // Pyth price id; 0 = none
        bool pythUsesShares; // scale Pyth share price by uiMultiplier()
        uint16 maxFeedDeviationBps; // quote band vs anchor (per decay period)
        uint16 maxSettleMoveBps; // TWAP-fallback clamp vs anchor (per decay period)
    }

    IPythMinimal public immutable pyth;

    mapping(address => MarketConfig) public markets; // key: underlying
    // settlement price per (underlying, expiry); 0 = unset
    mapping(address => mapping(uint64 => uint256)) public settlementPrice;
    // Pyth price-at-expiry pushed permissionlessly; consumed by snapshotSettlement
    mapping(address => mapping(uint64 => uint256)) public pythSettlement;

    // ------------------------------------------------------------------
    // Events / errors
    // ------------------------------------------------------------------

    enum SettleSource {
        Chainlink,
        Pyth,
        TwapFallback
    }

    event MarketSet(address indexed underlying, address pool, address chainlinkFeed, bytes32 pythId);
    event SettlementSnapped(
        address indexed underlying, uint64 indexed expiry, uint256 price, SettleSource source, address caller
    );
    event PythSettlementPushed(address indexed underlying, uint64 indexed expiry, uint256 price, address caller);

    error MarketUnknown();
    error BadConfig();
    error NotExpired();
    error AlreadySnapped();
    error FeedDeviation();
    error NoPrice();
    error AnchorPending();
    error PythPushRejected();
    error RefundFailed();

    constructor(address owner_, address pyth_) Ownable(owner_) {
        if (pyth_ == address(0)) revert BadConfig();
        pyth = IPythMinimal(pyth_);
    }

    // ------------------------------------------------------------------
    // Admin (bounded; this contract never holds funds beyond transient msg.value)
    // ------------------------------------------------------------------

    function setMarket(
        address underlying,
        address pool,
        address quote,
        address chainlinkFeed,
        bytes32 pythId,
        bool pythUsesShares,
        uint16 maxFeedDeviationBps,
        uint16 maxSettleMoveBps
    ) external onlyOwner {
        if (pool == address(0) || underlying == address(0) || quote == address(0)) revert BadConfig();
        // at least one external anchor is mandatory in v2 — that is the point
        if (chainlinkFeed == address(0) && pythId == bytes32(0)) revert BadConfig();
        // hard bounds: deviation 1%–20%, settle move 1%–50% (per decay period)
        if (maxFeedDeviationBps < 100 || maxFeedDeviationBps > 2_000) revert BadConfig();
        if (maxSettleMoveBps < 100 || maxSettleMoveBps > 5_000) revert BadConfig();
        address t0 = IUniswapV3PoolMinimal(pool).token0();
        address t1 = IUniswapV3PoolMinimal(pool).token1();
        bool u0 = t0 == underlying && t1 == quote;
        bool u1 = t1 == underlying && t0 == quote;
        if (!u0 && !u1) revert BadConfig();
        uint8 clDecimals = 0;
        if (chainlinkFeed != address(0)) {
            clDecimals = IChainlinkAggregatorMinimal(chainlinkFeed).decimals();
            if (clDecimals > 30) revert BadConfig();
        }
        markets[underlying] = MarketConfig({
            pool: pool,
            underlying: underlying,
            quote: quote,
            underlyingIsToken0: u0,
            underlyingDecimals: IERC20DecimalsMinimal(underlying).decimals(),
            quoteDecimals: IERC20DecimalsMinimal(quote).decimals(),
            chainlinkFeed: chainlinkFeed,
            chainlinkDecimals: clDecimals,
            pythId: pythId,
            pythUsesShares: pythUsesShares,
            maxFeedDeviationBps: maxFeedDeviationBps,
            maxSettleMoveBps: maxSettleMoveBps
        });
        emit MarketSet(underlying, pool, chainlinkFeed, pythId);
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    /// @notice 30-min geometric-mean TWAP, 1e18 fixed point quote-per-underlying-token.
    function spotTwap(address underlying) public view returns (uint256) {
        MarketConfig memory m = markets[underlying];
        if (m.pool == address(0)) revert MarketUnknown();
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        (int56[] memory ticks,) = IUniswapV3PoolMinimal(m.pool).observe(ago);
        int56 delta = ticks[1] - ticks[0];
        int24 avgTick = int24(delta / int56(uint56(TWAP_WINDOW)));
        // round toward negative infinity (Uniswap convention)
        if (delta < 0 && (delta % int56(uint56(TWAP_WINDOW)) != 0)) avgTick--;
        return _tickToPrice1e18(avgTick, m);
    }

    /// @notice Price used for premium quoting on buys: TWAP banded against the freshest
    ///         external anchor. The band widens with anchor age (never a cliff), so the
    ///         check stays active through weekends and reverts on genuine dislocations.
    function quotePrice(address underlying) external view returns (uint256 price) {
        MarketConfig memory m = markets[underlying];
        if (m.pool == address(0)) revert MarketUnknown();
        price = spotTwap(underlying);
        (uint256 anchor, uint256 updatedAt) = _freshestAnchor(m);
        if (anchor != 0) {
            uint256 allowedBps = _allowedBps(m.maxFeedDeviationBps, updatedAt);
            uint256 diff = price > anchor ? price - anchor : anchor - price;
            if (diff > Math.mulDiv(anchor, allowedBps, BPS)) revert FeedDeviation();
        }
        // no anchor data at all (both sources dead since deploy): TWAP stands alone,
        // matching v1 semantics for feedless markets. setMarket requires an anchor,
        // so this is unreachable in practice unless both external systems fail.
    }

    /// @notice Freshest external anchor (price, updatedAt). Name kept for drop-in
    ///         compatibility with PitYieldVault's deposit guard, which consumed v1's
    ///         poked heartbeat through this exact signature. No poking exists in v2:
    ///         the "heartbeat" is Chainlink's DON / Pyth's publishers.
    function lastValidTwap(address underlying) external view returns (uint256 price, uint256 updatedAt) {
        MarketConfig memory m = markets[underlying];
        if (m.pool == address(0)) revert MarketUnknown();
        return _freshestAnchor(m);
    }

    /// @notice Convenience view: current anchor with its source for UIs and monitoring.
    function anchorPrice(address underlying)
        external
        view
        returns (uint256 price, uint256 updatedAt, bool fromChainlink)
    {
        MarketConfig memory m = markets[underlying];
        if (m.pool == address(0)) revert MarketUnknown();
        (uint256 clPrice, uint256 clAt) = _chainlinkLatest(m);
        (uint256 pyPrice, uint256 pyAt) = _pythLatest(m);
        if (clAt >= pyAt) return (clPrice, clAt, true);
        return (pyPrice, pyAt, false);
    }

    // ------------------------------------------------------------------
    // Writes (permissionless)
    // ------------------------------------------------------------------

    /// @notice Snapshot the settlement price for (underlying, expiry). Permissionless,
    ///         only after expiry, at most once, immutable afterwards. The price is
    ///         resolved AT the expiry timestamp from external anchors — the caller has
    ///         no influence over it and gains nothing by choosing when to call.
    function snapshotSettlement(address underlying, uint64 expiry) external returns (uint256 price) {
        MarketConfig memory m = markets[underlying];
        if (m.pool == address(0)) revert MarketUnknown();
        if (block.timestamp < expiry) revert NotExpired();
        if (settlementPrice[underlying][expiry] != 0) revert AlreadySnapped();

        SettleSource source;

        // 1) Chainlink round bracketing the expiry (primary; push feed, no keeper).
        price = _chainlinkPriceAt(m, expiry);
        if (price != 0) {
            source = SettleSource.Chainlink;
        } else {
            // 2) Pyth price-at-expiry pushed permissionlessly via pushPythSettlement.
            price = pythSettlement[underlying][expiry];
            if (price != 0) {
                source = SettleSource.Pyth;
            } else if (block.timestamp > expiry + TWAP_FALLBACK_DELAY) {
                // 3) Doomsday fallback: both anchor paths unavailable for a full day
                //    after expiry. Settle on the pool TWAP clamped against the last
                //    known anchor so the series can never strand collateral forever.
                price = _twapFallback(m, underlying);
                source = SettleSource.TwapFallback;
            } else {
                // Wait for an anchor: Chainlink's next round or anyone pushing the
                // Pyth update for the expiry window. Nothing scheduled, nothing manual
                // required from the protocol — any settler can carry the Pyth bytes.
                revert AnchorPending();
            }
        }

        settlementPrice[underlying][expiry] = price;
        emit SettlementSnapped(underlying, expiry, price, source, msg.sender);
    }

    /// @notice Record the Pyth price for (underlying, expiry) from a signed Hermes
    ///         update whose publishTime falls inside [expiry, expiry + window]. Anyone
    ///         may call — typically the settler, in the same transaction bundle. Only
    ///         used when the Chainlink round path cannot serve the expiry.
    function pushPythSettlement(address underlying, uint64 expiry, bytes[] calldata updateData)
        external
        payable
        returns (uint256 price)
    {
        MarketConfig memory m = markets[underlying];
        if (m.pool == address(0)) revert MarketUnknown();
        if (m.pythId == bytes32(0)) revert PythPushRejected();
        if (block.timestamp < expiry) revert NotExpired();
        if (settlementPrice[underlying][expiry] != 0) revert AlreadySnapped();
        if (pythSettlement[underlying][expiry] != 0) revert AlreadySnapped();

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = m.pythId;
        uint256 fee = pyth.getUpdateFee(updateData);
        IPythMinimal.PriceFeed[] memory feeds =
            pyth.parsePriceFeedUpdatesUnique{value: fee}(updateData, ids, expiry, expiry + PYTH_SETTLE_WINDOW);
        price = _scalePyth(m, feeds[0].price);
        if (price == 0) revert PythPushRejected();

        pythSettlement[underlying][expiry] = price;
        emit PythSettlementPushed(underlying, expiry, price, msg.sender);

        // refund any excess fee provided
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    // ------------------------------------------------------------------
    // Internals — anchors
    // ------------------------------------------------------------------

    /// @dev Freshest of Chainlink latest and Pyth latest (either may be zero).
    function _freshestAnchor(MarketConfig memory m) internal view returns (uint256 price, uint256 updatedAt) {
        (uint256 clPrice, uint256 clAt) = _chainlinkLatest(m);
        (uint256 pyPrice, uint256 pyAt) = _pythLatest(m);
        if (clAt >= pyAt) {
            (price, updatedAt) = clPrice != 0 ? (clPrice, clAt) : (pyPrice, pyAt);
        } else {
            (price, updatedAt) = pyPrice != 0 ? (pyPrice, pyAt) : (clPrice, clAt);
        }
    }

    function _chainlinkLatest(MarketConfig memory m) internal view returns (uint256 price, uint256 updatedAt) {
        if (m.chainlinkFeed == address(0)) return (0, 0);
        try IChainlinkAggregatorMinimal(m.chainlinkFeed).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 at, uint80
        ) {
            if (answer <= 0 || at == 0 || at > block.timestamp) return (0, 0);
            return (Math.mulDiv(uint256(answer), 1e18, 10 ** m.chainlinkDecimals), at);
        } catch {
            return (0, 0);
        }
    }

    function _pythLatest(MarketConfig memory m) internal view returns (uint256 price, uint256 updatedAt) {
        if (m.pythId == bytes32(0)) return (0, 0);
        try pyth.getPriceUnsafe(m.pythId) returns (IPythMinimal.Price memory p) {
            uint256 scaled = _scalePyth(m, p);
            if (scaled == 0 || p.publishTime == 0 || p.publishTime > block.timestamp) return (0, 0);
            return (scaled, p.publishTime);
        } catch {
            return (0, 0);
        }
    }

    /// @dev Pyth Price → token-denominated 1e18 price. Rejects non-positive prices,
    ///      absurd exponents, and confidence intervals wider than MAX_CONF_BPS.
    function _scalePyth(MarketConfig memory m, IPythMinimal.Price memory p) internal view returns (uint256) {
        if (p.price <= 0) return 0;
        if (p.expo > 12 || p.expo < -18) return 0;
        uint256 raw = uint256(uint64(p.price));
        // confidence sanity: conf/price ≤ MAX_CONF_BPS
        if (uint256(p.conf) * BPS > raw * MAX_CONF_BPS) return 0;
        uint256 price1e18 = p.expo >= 0
            ? raw * 1e18 * (10 ** uint32(p.expo))
            : Math.mulDiv(raw, 1e18, 10 ** uint32(-p.expo));
        if (m.pythUsesShares) {
            // Pyth quotes the real-world share; token = uiMultiplier/1e18 shares.
            uint256 mult = _uiMultiplier(m.underlying);
            price1e18 = Math.mulDiv(price1e18, mult, 1e18);
        }
        return price1e18;
    }

    function _uiMultiplier(address token) internal view returns (uint256) {
        try IUiMultiplierMinimal(token).uiMultiplier() returns (uint256 mult) {
            if (mult == 0 || mult > type(uint128).max) return 1e18;
            return mult;
        } catch {
            return 1e18;
        }
    }

    // ------------------------------------------------------------------
    // Internals — settlement resolution
    // ------------------------------------------------------------------

    /// @dev Latest Chainlink round with updatedAt <= expiry, found by binary search
    ///      over the current phase's round history. Returns 0 when the feed is unset,
    ///      the phase doesn't reach back to the expiry, or the bracketing round is
    ///      older than CL_SETTLE_MAX_AGE at the expiry (feed was down before expiry).
    function _chainlinkPriceAt(MarketConfig memory m, uint64 expiry) internal view returns (uint256) {
        if (m.chainlinkFeed == address(0)) return 0;
        IChainlinkAggregatorMinimal feed = IChainlinkAggregatorMinimal(m.chainlinkFeed);

        uint80 latestId;
        int256 latestAnswer;
        uint256 latestAt;
        try feed.latestRoundData() returns (uint80 rid, int256 a, uint256, uint256 at, uint80) {
            (latestId, latestAnswer, latestAt) = (rid, a, at);
        } catch {
            return 0;
        }
        if (latestAnswer <= 0 || latestAt == 0) return 0;

        // Fast path: latest round is already at-or-before expiry (e.g. Friday-close
        // expiry snapped over the weekend, before the next market open).
        if (latestAt <= expiry) {
            if (expiry - latestAt > CL_SETTLE_MAX_AGE) return 0;
            return Math.mulDiv(uint256(latestAnswer), 1e18, 10 ** m.chainlinkDecimals);
        }

        // Binary search the current phase for the smallest round with updatedAt > expiry;
        // the answer round is the one before it. Proxy round ids compose the phase in
        // the top 16 bits, so we search the low 64 bits within the latest phase.
        uint80 phase = latestId & ~uint80(type(uint64).max);
        uint64 lo = 1; // smallest aggregator round in phase
        uint64 hi = uint64(latestId); // invariant: updatedAt(hi) > expiry
        while (lo < hi) {
            uint64 mid = lo + (hi - lo) / 2;
            (int256 a, uint256 at) = _roundAt(feed, phase | uint80(mid));
            if (at == 0 || a <= 0) {
                // missing/invalid early round data: everything at or below mid is
                // unusable, move up
                lo = mid + 1;
            } else if (at > expiry) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        // lo == smallest round with updatedAt > expiry (or with unusable data below it)
        if (lo <= 1) return 0; // nothing in this phase at-or-before expiry
        (int256 ans, uint256 ansAt) = _roundAt(feed, phase | uint80(lo - 1));
        if (ans <= 0 || ansAt == 0 || ansAt > expiry) return 0;
        if (expiry - ansAt > CL_SETTLE_MAX_AGE) return 0;
        return Math.mulDiv(uint256(ans), 1e18, 10 ** m.chainlinkDecimals);
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

    /// @dev Doomsday TWAP fallback, clamped against the last known anchor (any age,
    ///      band widened by anchor age). Raw TWAP only if no anchor data exists at all;
    ///      reverts NoPrice only if the pool itself cannot serve a TWAP either.
    function _twapFallback(MarketConfig memory m, address underlying) internal view returns (uint256 price) {
        (uint256 anchor, uint256 updatedAt) = _freshestAnchor(m);
        try PitOracleV2(this).spotTwap(underlying) returns (uint256 twap) {
            price = twap;
            if (anchor != 0) {
                uint256 allowedBps = _allowedBps(m.maxSettleMoveBps, updatedAt);
                uint256 maxUp = Math.mulDiv(anchor, BPS + allowedBps, BPS);
                uint256 maxDown = Math.mulDiv(anchor, BPS, BPS + allowedBps);
                if (price > maxUp) price = maxUp;
                if (price < maxDown) price = maxDown;
            }
        } catch {
            // frozen/bricked pool: the anchor alone is the best remaining truth
            if (anchor == 0) revert NoPrice();
            price = anchor;
        }
        if (price == 0) revert NoPrice();
    }

    /// @dev Allowed deviation in bps: base × elapsed periods since the anchor updated
    ///      (+1 so a fresh anchor still bounds), capped at MAX_DECAY_PERIODS.
    function _allowedBps(uint16 baseBps, uint256 updatedAt) internal view returns (uint256) {
        uint256 elapsed = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        uint256 periods = elapsed / DECAY_PERIOD + 1;
        if (periods > MAX_DECAY_PERIODS) periods = MAX_DECAY_PERIODS;
        return uint256(baseBps) * periods;
    }

    /// @dev price1e18 = quote per 1 whole underlying, 1e18 fixed point.
    function _tickToPrice1e18(int24 tick, MarketConfig memory m) internal pure returns (uint256) {
        uint160 sqrtP = TickMathMini.getSqrtRatioAtTick(tick);
        uint256 p1e18 = Math.mulDiv(Math.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96), 1e18, 1 << 96);
        uint256 price;
        if (m.underlyingIsToken0) {
            price = Math.mulDiv(p1e18, 10 ** m.underlyingDecimals, 10 ** m.quoteDecimals);
        } else {
            if (p1e18 == 0) revert NoPrice();
            price = Math.mulDiv(1e36, 10 ** m.underlyingDecimals, p1e18 * 10 ** m.quoteDecimals);
        }
        if (price == 0) revert NoPrice();
        return price;
    }
}
