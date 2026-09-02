// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NavIndexToken} from "../../src/index/NavIndexToken.sol";
import {NavIndexFactory, IPitOracleQuote} from "../../src/index/NavIndexFactory.sol";

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

/// @dev quotePrice-only oracle mock; reverts for unknown, settable zero.
contract MockQuoteOracle {
    mapping(address => uint256) public quote;
    mapping(address => bool) public quoteReverts;

    error MarketUnknown();

    function setQuote(address t, uint256 p) external {
        quote[t] = p;
    }

    function setQuoteReverts(address t, bool r) external {
        quoteReverts[t] = r;
    }

    function quotePrice(address t) external view returns (uint256) {
        if (quoteReverts[t]) revert MarketUnknown();
        return quote[t];
    }
}

/*//////////////////////////////////////////////////////////////////////////
                                   FIXTURE
//////////////////////////////////////////////////////////////////////////*/

/// @dev Base fixture: 3-component index (NVDA/AAPL/QQQ, 18 decimals), default
///      fees 50 bps mint / 50 bps redeem / 100 bps yr streaming.
abstract contract IndexBase is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;

    MockERC20 internal nvda;
    MockERC20 internal aapl;
    MockERC20 internal qqq;
    MockQuoteOracle internal oracle;
    NavIndexFactory internal factory;
    NavIndexToken internal index;

    address internal creator = address(0xC0FFEE);
    address internal minter = address(0x1111);
    address internal redeemer = address(0x2222);

    address[] internal comps;
    uint256[] internal units;

    function setUp() public virtual {
        vm.warp(1_760_000_000);

        nvda = new MockERC20("NVIDIA", "NVDA", 18);
        aapl = new MockERC20("Apple", "AAPL", 18);
        qqq = new MockERC20("Invesco QQQ", "QQQ", 18);
        oracle = new MockQuoteOracle();
        oracle.setQuote(address(nvda), 200e18);
        oracle.setQuote(address(aapl), 250e18);
        oracle.setQuote(address(qqq), 600e18);

        factory = new NavIndexFactory(IPitOracleQuote(address(oracle)));

        comps.push(address(nvda));
        comps.push(address(aapl));
        comps.push(address(qqq));
        units.push(0.5e18); // 0.5 NVDA per share
        units.push(0.4e18); // 0.4 AAPL per share
        units.push(0.1e18); // 0.1 QQQ per share

        vm.prank(creator);
        index = NavIndexToken(_create("NAV Blue Chip", "NAVBLUE", 50, 50, 100));

        address[2] memory actors = [minter, redeemer];
        for (uint256 i; i < actors.length; ++i) {
            nvda.mint(actors[i], 1e30);
            aapl.mint(actors[i], 1e30);
            qqq.mint(actors[i], 1e30);
            vm.startPrank(actors[i]);
            nvda.approve(address(index), type(uint256).max);
            aapl.approve(address(index), type(uint256).max);
            qqq.approve(address(index), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _create(string memory n, string memory s, uint256 mf, uint256 rf, uint256 sf)
        internal
        returns (address)
    {
        return factory.createIndex(
            NavIndexFactory.CreateParams({
                name: n,
                symbol: s,
                components: comps,
                unitsPerShare: units,
                mintFeeBps: mf,
                redeemFeeBps: rf,
                streamFeeBps: sf
            })
        );
    }

    /// @dev ceil(shares * unit / 1e18)
    function _ceilPull(uint256 shares, uint256 unit) internal pure returns (uint256) {
        return (shares * unit + WAD - 1) / WAD;
    }
}
