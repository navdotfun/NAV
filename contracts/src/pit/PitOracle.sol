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
    function decimals() external view returns (uint8);
}

interface IERC20DecimalsMinimal {
    function decimals() external view returns (uint8);
}

/// @title PitOracle — manipulation-resistant price reads for The Pit
/// @notice Per market (underlying/quote Uniswap v3 pool):
///         - `quotePrice`: 30-min geometric TWAP, optionally sanity-banded against a
///           Chainlink feed when the feed is fresh (off-hours the feed goes stale and
///           the band check disables itself — TWAP remains authoritative).
///         - `poke`: permissionless heartbeat storing `lastValidTwap`, clamped to a
///           bounded move per update (truncated-oracle behaviour) so a settlement
///           snapshot can be sanity-clamped and frozen markets retain a fallback price.
///         - `snapshotSettlement`: stores the settlement price once per (market, expiry),
///           only after expiry; immutable once set (single-read settlement, Aevo lesson).
/// @dev Prices are quote-wei per 1 whole underlying token, scaled to 1e18 fixed point
///      ("price1e18" = quote amount for 10**underlyingDecimals of underlying, ×1e18/10**quoteDecimals).
contract PitOracle is Ownable2Step {
    uint32 public constant TWAP_WINDOW = 30 minutes;
    uint256 public constant POKE_MIN_INTERVAL = 5 minutes;
    uint256 public constant POKE_FRESHNESS = 24 hours;
    /// Max widening of the settlement clamp for a stale heartbeat (periods of POKE_FRESHNESS).
    uint256 public constant MAX_DECAY_PERIODS = 7;
    uint256 public constant FEED_FRESHNESS = 1 hours;
    uint16 public constant BPS = 10_000;

    struct MarketConfig {
        address pool; // Uniswap v3 pool for underlying/quote
        address underlying;
        address quote;
        bool underlyingIsToken0;
        uint8 underlyingDecimals;
        uint8 quoteDecimals;
        address chainlinkFeed; // optional; 0 = disabled
        uint16 maxFeedDeviationBps; // band vs fresh Chainlink feed
        uint16 maxPokeMoveBps; // clamp per poke update
        uint16 maxSettleMoveBps; // clamp of settlement snapshot vs recent lastValidTwap
    }

    struct PokeState {
        uint128 lastValidTwap; // 1e18 fixed point
        uint64 lastPokeAt;
    }

    mapping(address => MarketConfig) public markets; // key: underlying
    mapping(address => PokeState) public pokes; // key: underlying
    // settlement price per (underlying, expiry); 0 = unset
    mapping(address => mapping(uint64 => uint256)) public settlementPrice;

    event MarketSet(address indexed underlying, address pool, address feed);
    event Poked(address indexed underlying, uint256 twap, uint256 stored);
    event SettlementSnapped(address indexed underlying, uint64 indexed expiry, uint256 price, address keeper);

    error MarketUnknown();
    error BadConfig();
    error NotExpired();
    error AlreadySnapped();
    error FeedDeviation();
    error PokeTooSoon();
    error NoPrice();

    constructor(address owner_) Ownable(owner_) {}

    // ------------------------------------------------------------------
    // Admin (bounded; cannot touch funds — this contract never holds any)
    // ------------------------------------------------------------------

    function setMarket(
        address underlying,
        address pool,
        address quote,
        address chainlinkFeed,
        uint16 maxFeedDeviationBps,
        uint16 maxPokeMoveBps,
        uint16 maxSettleMoveBps
    ) external onlyOwner {
        if (pool == address(0) || underlying == address(0) || quote == address(0)) revert BadConfig();
        // hard bounds: deviation 1%–20%, poke move 1%–50%, settle move 1%–50%
        if (maxFeedDeviationBps < 100 || maxFeedDeviationBps > 2_000) revert BadConfig();
        if (maxPokeMoveBps < 100 || maxPokeMoveBps > 5_000) revert BadConfig();
        if (maxSettleMoveBps < 100 || maxSettleMoveBps > 5_000) revert BadConfig();
        address t0 = IUniswapV3PoolMinimal(pool).token0();
        address t1 = IUniswapV3PoolMinimal(pool).token1();
        bool u0 = t0 == underlying && t1 == quote;
        bool u1 = t1 == underlying && t0 == quote;
        if (!u0 && !u1) revert BadConfig();
        markets[underlying] = MarketConfig({
            pool: pool,
            underlying: underlying,
            quote: quote,
            underlyingIsToken0: u0,
            underlyingDecimals: IERC20DecimalsMinimal(underlying).decimals(),
            quoteDecimals: IERC20DecimalsMinimal(quote).decimals(),
            chainlinkFeed: chainlinkFeed,
            maxFeedDeviationBps: maxFeedDeviationBps,
            maxPokeMoveBps: maxPokeMoveBps,
            maxSettleMoveBps: maxSettleMoveBps
        });
        emit MarketSet(underlying, pool, chainlinkFeed);
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    /// @notice 30-min geometric-mean TWAP, 1e18 fixed point quote-per-underlying.
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

    /// @notice Price used for premium quoting on buys. TWAP + optional fresh-feed band.
    function quotePrice(address underlying) external view returns (uint256 price) {
        MarketConfig memory m = markets[underlying];
        if (m.pool == address(0)) revert MarketUnknown();
        price = spotTwap(underlying);
        _checkFeedBand(m, price);
    }

    /// @notice Best-effort price for frozen markets: last poked TWAP if fresh.
    function lastValidTwap(address underlying) external view returns (uint256 price, uint256 updatedAt) {
        PokeState memory p = pokes[underlying];
        return (p.lastValidTwap, p.lastPokeAt);
    }

    // ------------------------------------------------------------------
    // Writes (permissionless)
    // ------------------------------------------------------------------

    /// @notice Heartbeat: store the current TWAP as lastValidTwap, clamped to a
    ///         bounded move from the previous stored value. Anyone may call.
    function poke(address underlying) external returns (uint256 stored) {
        MarketConfig memory m = markets[underlying];
        if (m.pool == address(0)) revert MarketUnknown();
        PokeState storage p = pokes[underlying];
        if (block.timestamp < p.lastPokeAt + POKE_MIN_INTERVAL) revert PokeTooSoon();
        uint256 twap = spotTwap(underlying);
        stored = twap;
        if (p.lastValidTwap != 0) {
            uint256 prev = p.lastValidTwap;
            uint256 maxUp = prev + Math.mulDiv(prev, m.maxPokeMoveBps, BPS);
            uint256 maxDown = prev - Math.mulDiv(prev, m.maxPokeMoveBps, BPS);
            if (stored > maxUp) stored = maxUp;
            if (stored < maxDown) stored = maxDown;
        }
        p.lastValidTwap = uint128(stored);
        p.lastPokeAt = uint64(block.timestamp);
        emit Poked(underlying, twap, stored);
    }

    /// @notice Snapshot the settlement price for (underlying, expiry). Permissionless,
    ///         only after expiry, at most once, immutable afterwards.
    ///         Uses the live TWAP; if the pool's observe() reverts (frozen market),
    ///         falls back to a fresh lastValidTwap. Clamped vs a fresh lastValidTwap.
    function snapshotSettlement(address underlying, uint64 expiry) external returns (uint256 price) {
        MarketConfig memory m = markets[underlying];
        if (m.pool == address(0)) revert MarketUnknown();
        if (block.timestamp < expiry) revert NotExpired();
        if (settlementPrice[underlying][expiry] != 0) revert AlreadySnapped();

        PokeState memory p = pokes[underlying];
        bool hasRef = p.lastValidTwap != 0;

        try PitOracle(this).spotTwap(underlying) returns (uint256 twap) {
            price = twap;
            // Clamp against the last heartbeat, widening with its age instead of
            // switching off at a freshness cliff (a cliff made the clamp inert in
            // exactly the quiet markets where manipulation is cheapest).
            if (hasRef) price = _clampWithDecay(price, p, m.maxSettleMoveBps);
            _checkFeedBand(m, price);
        } catch {
            // Frozen / bricked pool: fall back to the last heartbeat at ANY age.
            // Requiring freshness here would make the series permanently
            // unsettleable and strand both sides' collateral forever.
            if (!hasRef) revert NoPrice();
            price = p.lastValidTwap;
        }

        settlementPrice[underlying][expiry] = price;
        emit SettlementSnapped(underlying, expiry, price, msg.sender);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Bound `price` around the last heartbeat. The allowed move is
    ///      `maxMoveBps` per POKE_FRESHNESS period elapsed since the heartbeat
    ///      (linear, +1 period so a fresh reference still clamps), capped at
    ///      MAX_DECAY_PERIODS so an abandoned market cannot widen without limit.
    ///      Applied geometrically so up and down moves are symmetric in ratio.
    function _clampWithDecay(uint256 price, PokeState memory p, uint16 maxMoveBps)
        internal
        view
        returns (uint256)
    {
        uint256 elapsed = block.timestamp > p.lastPokeAt ? block.timestamp - p.lastPokeAt : 0;
        uint256 periods = elapsed / POKE_FRESHNESS + 1;
        if (periods > MAX_DECAY_PERIODS) periods = MAX_DECAY_PERIODS;
        uint256 allowedBps = uint256(maxMoveBps) * periods;
        uint256 prev = p.lastValidTwap;
        uint256 maxUp = Math.mulDiv(prev, BPS + allowedBps, BPS);
        uint256 maxDown = Math.mulDiv(prev, BPS, BPS + allowedBps);
        if (price > maxUp) return maxUp;
        if (price < maxDown) return maxDown;
        return price;
    }

    function _checkFeedBand(MarketConfig memory m, uint256 price) internal view {
        if (m.chainlinkFeed == address(0)) return;
        try IChainlinkAggregatorMinimal(m.chainlinkFeed).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer <= 0) return; // broken feed: ignore
            if (block.timestamp - updatedAt > FEED_FRESHNESS) return; // stale (market closed): ignore
            uint8 fd = IChainlinkAggregatorMinimal(m.chainlinkFeed).decimals();
            uint256 feedPrice = Math.mulDiv(uint256(answer), 1e18, 10 ** fd);
            uint256 diff = price > feedPrice ? price - feedPrice : feedPrice - price;
            if (diff > Math.mulDiv(feedPrice, m.maxFeedDeviationBps, BPS)) revert FeedDeviation();
        } catch {
            return; // feed reverts: TWAP authoritative
        }
    }

    /// @dev price1e18 = quote per 1 whole underlying, 1e18 fixed point.
    function _tickToPrice1e18(int24 tick, MarketConfig memory m) internal pure returns (uint256) {
        uint160 sqrtP = TickMathMini.getSqrtRatioAtTick(tick);
        // raw price token1-per-token0 = sqrtP^2 / 2^192
        // step in 1e18 fixed point, guarding overflow via two mulDivs
        uint256 p1e18 = Math.mulDiv(Math.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96), 1e18, 1 << 96);
        uint256 price;
        if (m.underlyingIsToken0) {
            // p1e18 = quoteWei per underlyingWei × 1e18
            price = Math.mulDiv(p1e18, 10 ** m.underlyingDecimals, 10 ** m.quoteDecimals);
        } else {
            if (p1e18 == 0) revert NoPrice();
            // invert: underlying is token1
            price = Math.mulDiv(1e36, 10 ** m.underlyingDecimals, p1e18 * 10 ** m.quoteDecimals);
        }
        if (price == 0) revert NoPrice();
        return price;
    }
}
