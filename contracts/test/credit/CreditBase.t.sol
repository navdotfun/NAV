// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CreditPair} from "../../src/credit/CreditPair.sol";
import {CreditFactory} from "../../src/credit/CreditFactory.sol";

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

/// @dev Mirrors PitOracleV2.anchorPrice semantics: (price 1e18, updatedAt, fromChainlink).
contract MockAnchorOracle {
    struct Anchor {
        uint256 price;
        uint256 updatedAt;
        bool fromChainlink;
    }

    mapping(address => Anchor) public anchors;
    mapping(address => bool) public revertsFor;

    error MarketUnknown();

    function setAnchor(address t, uint256 price, uint256 updatedAt) external {
        anchors[t] = Anchor(price, updatedAt, true);
    }

    function setReverts(address t, bool r) external {
        revertsFor[t] = r;
    }

    function anchorPrice(address t)
        external
        view
        returns (uint256 price, uint256 updatedAt, bool fromChainlink)
    {
        if (revertsFor[t]) revert MarketUnknown();
        Anchor memory a = anchors[t];
        return (a.price, a.updatedAt, a.fromChainlink);
    }
}

/*//////////////////////////////////////////////////////////////////////////
                                   FIXTURE
//////////////////////////////////////////////////////////////////////////*/

/// @dev Base fixture: NVDA-like pair (LTV 60% / LT 70% / bonus 8%), $200 anchor,
///      caps sized like the production stamping (borrow 50k / supply 100k USDG).
abstract contract CreditBase is Test {
    uint256 internal constant RAY = 1e27;
    uint256 internal constant BPS = 10_000;

    MockERC20 internal usdg;    // 6 decimals
    MockERC20 internal stock;   // 18 decimals
    MockAnchorOracle internal oracle;
    CreditFactory internal factory;
    CreditPair internal pair;

    address internal constant ACCUM = address(0xACC);
    address internal lender = address(0x1111);
    address internal borrower = address(0x2222);
    address internal liquidator = address(0x3333);

    uint256 internal constant PRICE = 200e18;       // $200/share
    uint256 internal constant BORROW_CAP = 50_000e6;
    uint256 internal constant SUPPLY_CAP = 100_000e6;
    uint256 internal constant MAX_AGE = 26 hours;

    function setUp() public virtual {
        vm.warp(1_760_000_000); // realistic timestamp

        usdg = new MockERC20("USDG", "USDG", 6);
        stock = new MockERC20("NVIDIA", "NVDA", 18);
        oracle = new MockAnchorOracle();
        oracle.setAnchor(address(stock), PRICE, block.timestamp);

        factory = new CreditFactory(address(usdg), address(oracle), ACCUM);
        pair = CreditPair(
            factory.deployPair({
                collateral: address(stock),
                ltvBps: 6000,
                liqThresholdBps: 7000,
                liqBonusBps: 800,
                borrowCap: BORROW_CAP,
                supplyCap: SUPPLY_CAP,
                maxPriceAge: MAX_AGE,
                optimalUtilizationRay: 0.8e27,
                baseRateRay: 0,
                slope1Ray: 0.08e27,  // 8% APR at the kink
                slope2Ray: 0.72e27   // 80% APR at 100% utilization
            })
        );

        // Fund actors.
        usdg.mint(lender, 1_000_000e6);
        usdg.mint(borrower, 1_000_000e6);
        usdg.mint(liquidator, 1_000_000e6);
        stock.mint(borrower, 1_000_000e18);

        vm.prank(lender);
        usdg.approve(address(pair), type(uint256).max);
        vm.startPrank(borrower);
        usdg.approve(address(pair), type(uint256).max);
        stock.approve(address(pair), type(uint256).max);
        vm.stopPrank();
        vm.prank(liquidator);
        usdg.approve(address(pair), type(uint256).max);
    }

    /*//////////////////////////// helpers ////////////////////////////*/

    function _deposit(address who, uint256 amt) internal returns (uint256) {
        vm.prank(who);
        return pair.deposit(amt);
    }

    function _addCollateral(address who, uint256 amt) internal {
        vm.prank(who);
        pair.addCollateral(amt);
    }

    function _borrow(address who, uint256 amt) internal returns (uint256) {
        vm.prank(who);
        return pair.borrow(amt);
    }

    function _freshenOracle() internal {
        oracle.setAnchor(address(stock), PRICE, block.timestamp);
    }

    function _setPrice(uint256 p) internal {
        oracle.setAnchor(address(stock), p, block.timestamp);
    }

    /// @dev Solvency: pool USDG balance always covers lender claims minus lent-out debt.
    function _assertSolvent() internal view {
        uint256 s = pair.totalSupplyAssets();
        uint256 b = pair.totalBorrowAssets();
        assertGe(s, b, "S >= B");
        assertGe(usdg.balanceOf(address(pair)), s - b, "cash covers S-B");
    }
}
