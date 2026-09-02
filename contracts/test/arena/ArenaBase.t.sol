// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NavArena} from "../../src/arena/NavArena.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPitOracleSettle} from "../../src/arena/NavArena.sol";

/*//////////////////////////////////////////////////////////////////////////
                                     MOCKS
//////////////////////////////////////////////////////////////////////////*/

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "bal");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address f, address to, uint256 amt) external returns (bool) {
        require(balanceOf[f] >= amt, "bal");
        uint256 a = allowance[f][msg.sender];
        require(a >= amt, "allow");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - amt;
        balanceOf[f] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// @dev Chainlink aggregator mock with real rounds in a single phase, mirroring
///      the surface NavArena._clBracketAt binary-searches.
contract MockChainlinkFeed {
    uint80 public constant PHASE = uint80(1) << 64;
    uint64 public lastAgg;
    mapping(uint64 => int256) public answers;
    mapping(uint64 => uint256) public updatedAts;
    bool public latestReverts;

    function pushRound(int256 answer, uint256 updatedAt) external {
        lastAgg++;
        answers[lastAgg] = answer;
        updatedAts[lastAgg] = updatedAt;
    }

    function setLatestReverts(bool r) external {
        latestReverts = r;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (latestReverts || lastAgg == 0) revert("no data");
        return (PHASE | uint80(lastAgg), answers[lastAgg], 0, updatedAts[lastAgg], 0);
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        uint64 agg = uint64(roundId);
        uint256 at = updatedAts[agg];
        if (at == 0) revert("no round");
        return (roundId, answers[agg], 0, at, 0);
    }
}

/// @dev Mirrors PitOracleV2 settlement semantics: `settlementPrice` is a stored
///      snapshot per (underlying, expiry); `snapshotSettlement` writes it from a
///      settable per-asset "anchor curve" or reverts AnchorPending while the
///      anchor is unavailable; `quotePrice` reverts for unknown markets. Also
///      exposes the `markets` config tuple and `pythSettlement` store the arena
///      pins/checks.
contract MockSettleOracle {
    struct Cfg {
        address pool;
        address chainlinkFeed;
        bytes32 pythId;
        bool pythUsesShares;
        uint16 maxFeedDeviationBps;
        uint16 maxSettleMoveBps;
    }

    mapping(address => uint256) public quote; // live quote per asset (0 = unknown)
    mapping(address => bool) public quoteReverts;
    mapping(address => mapping(uint64 => uint256)) public settlementPrice;
    mapping(address => mapping(uint64 => uint256)) public pythSettlement;
    /// @dev What snapshotSettlement would store for (asset, expiry).
    mapping(address => mapping(uint64 => uint256)) public pendingAnchor;
    mapping(address => bool) public anchorDead; // snapshot always reverts
    mapping(address => Cfg) internal cfg;

    error MarketUnknown();
    error AnchorPending();
    error ZeroSettle();

    function setQuote(address t, uint256 p) external {
        quote[t] = p;
    }

    function setQuoteReverts(address t, bool r) external {
        quoteReverts[t] = r;
    }

    function setAnchor(address t, uint64 expiry, uint256 p) external {
        pendingAnchor[t][expiry] = p;
    }

    function setPyth(address t, uint64 expiry, uint256 p) external {
        pythSettlement[t][expiry] = p;
    }

    function setMarket(address t, address pool, address feed, bytes32 pythId, bool shares, uint16 dev, uint16 mov)
        external
    {
        cfg[t] = Cfg(pool, feed, pythId, shares, dev, mov);
    }

    function setAnchorDead(address t, bool dead) external {
        anchorDead[t] = dead;
    }

    /// @dev Test hook mirroring a pre-existing snapshot (e.g. options settled first).
    function forceSettlement(address t, uint64 expiry, uint256 p) external {
        settlementPrice[t][expiry] = p;
    }

    function quotePrice(address t) external view returns (uint256) {
        if (quoteReverts[t]) revert MarketUnknown();
        return quote[t];
    }

    function markets(address t)
        external
        view
        returns (
            address pool,
            address underlying_,
            address quote_,
            bool underlyingIsToken0,
            uint8 underlyingDecimals,
            uint8 quoteDecimals,
            address chainlinkFeed,
            uint8 chainlinkDecimals,
            bytes32 pythId,
            bool pythUsesShares,
            uint16 maxFeedDeviationBps,
            uint16 maxSettleMoveBps
        )
    {
        Cfg memory c = cfg[t];
        return
            (c.pool, t, address(0), true, 18, 6, c.chainlinkFeed, 8, c.pythId, c.pythUsesShares, c.maxFeedDeviationBps, c.maxSettleMoveBps);
    }

    function snapshotSettlement(address t, uint64 expiry) external returns (uint256 price) {
        if (anchorDead[t]) revert AnchorPending();
        uint256 existing = settlementPrice[t][expiry];
        if (existing != 0) return existing;
        price = pendingAnchor[t][expiry];
        if (price == 0) revert AnchorPending();
        settlementPrice[t][expiry] = price;
    }
}

/*//////////////////////////////////////////////////////////////////////////
                                   FIXTURE
//////////////////////////////////////////////////////////////////////////*/

/// @dev Base fixture: NVDA vs TSLA bout, $200 / $400 quotes, three stakers.
abstract contract ArenaBase is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint64 internal constant RES_WINDOW = 24 hours;
    uint64 internal constant BUFFER = 30 minutes;

    MockERC20 internal usdg; // 6 decimals
    MockERC20 internal nvda;
    MockERC20 internal tsla;
    MockSettleOracle internal oracle;
    NavArena internal arena;

    address internal constant ACCUM = address(0xACC);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCAA01);
    address internal settler = address(0x5E77);

    uint64 internal entryClose;
    uint64 internal settleTime;

    function setUp() public virtual {
        vm.warp(1_760_000_000);

        usdg = new MockERC20("USDG", "USDG", 6);
        nvda = new MockERC20("NVIDIA", "NVDA", 18);
        tsla = new MockERC20("Tesla", "TSLA", 18);
        oracle = new MockSettleOracle();
        oracle.setQuote(address(nvda), 200e18);
        oracle.setQuote(address(tsla), 400e18);

        arena = new NavArena(IERC20(address(usdg)), IPitOracleSettle(address(oracle)), ACCUM);

        entryClose = uint64(block.timestamp + 1 days);
        settleTime = uint64(block.timestamp + 8 days);

        address[4] memory actors = [alice, bob, carol, settler];
        for (uint256 i; i < actors.length; ++i) {
            usdg.mint(actors[i], 1_000_000e6);
            vm.prank(actors[i]);
            usdg.approve(address(arena), type(uint256).max);
        }
    }

    /*//////////////////////////////////////////////////////////////////////
                                    HELPERS
    //////////////////////////////////////////////////////////////////////*/

    function _createDefault() internal returns (uint256 id) {
        id = arena.createBout(address(nvda), address(tsla), entryClose, settleTime);
    }

    function _stake(uint256 id, address who, bool sideA, uint256 amt) internal {
        vm.prank(who);
        arena.stake(id, sideA, amt);
    }

    /// @dev Arm a *fresh* start anchor: the snapshot value plus a matching Pyth
    ///      benchmark so the contemporaneity check passes via the Pyth path.
    function _setFreshAnchor(address asset, uint64 expiry, uint256 p) internal {
        oracle.setAnchor(asset, expiry, p);
        oracle.setPyth(asset, expiry, p);
    }

    /// @dev Stake both sides, close entry, set fresh start anchors and lock.
    function _lockedBout(uint256 aStake, uint256 bStake) internal returns (uint256 id) {
        id = _createDefault();
        _stake(id, alice, true, aStake);
        _stake(id, bob, false, bStake);
        _setFreshAnchor(address(nvda), entryClose, 200e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(entryClose);
        arena.lock(id);
    }

    /// @dev Move to settleTime with end anchors set so A wins (+10% vs -10%).
    function _settleAWins(uint256 id) internal {
        _setFreshAnchor(address(nvda), settleTime, 220e18);
        _setFreshAnchor(address(tsla), settleTime, 360e18);
        vm.warp(settleTime);
        vm.prank(settler);
        arena.settle(id);
    }

    function _state(uint256 id) internal view returns (NavArena.State) {
        return arena.getBout(id).state;
    }
}
