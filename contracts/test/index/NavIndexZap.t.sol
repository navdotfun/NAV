// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase, MockERC20} from "./IndexBase.t.sol";
import {NavIndexToken} from "../../src/index/NavIndexToken.sol";
import {NavIndexZap, INavSwapRouter, INavIndexFactory} from "../../src/index/NavIndexZap.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/*//////////////////////////////////////////////////////////////////////////
                                 MOCK ROUTER
//////////////////////////////////////////////////////////////////////////*/

/// @dev Mirrors NavSwapRouter semantics for USDG-waypoint swaps: pulls tokenIn,
///      skims 20 bps in USDG, pays out at a settable price, enforces minOut and
///      deadline. Prices are quoted as USDG (6 dec) per 1e18 of token.
contract MockRouter {
    uint256 public constant FEE_BPS = 20;
    uint256 internal constant BPS = 10_000;

    MockERC20 public usdg;
    mapping(address => uint256) public price; // USDG-6dec per 1e18 token
    mapping(address => MockERC20) public tokens;

    error DeadlineExpired();
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);

    constructor(MockERC20 usdg_) {
        usdg = usdg_;
    }

    function setPrice(address token, uint256 usdgPer1e18) external {
        price[token] = usdgPer1e18;
        tokens[token] = MockERC20(token);
    }

    function swapExactIn(INavSwapRouter.SwapParams calldata p) external returns (uint256 amountOut) {
        if (block.timestamp > p.deadline) revert DeadlineExpired();
        require(p.minAmountOut > 0, "minOut=0");

        if (p.tokenIn == address(usdg)) {
            // USDG -> token: skim fee from input, buy at price.
            usdg.transferFrom(msg.sender, address(this), p.amountIn);
            uint256 netIn = p.amountIn - (p.amountIn * FEE_BPS / BPS);
            amountOut = netIn * 1e18 / price[p.tokenOut];
            MockERC20(p.tokenOut).mint(p.recipient, amountOut);
        } else {
            // token -> USDG: sell at price, skim fee from USDG output.
            MockERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
            uint256 grossOut = p.amountIn * price[p.tokenIn] / 1e18;
            amountOut = grossOut - (grossOut * FEE_BPS / BPS);
            usdg.mint(p.recipient, amountOut);
        }
        if (amountOut < p.minAmountOut) revert InsufficientOutput(amountOut, p.minAmountOut);
    }
}

/*//////////////////////////////////////////////////////////////////////////
                                  ZAP TESTS
//////////////////////////////////////////////////////////////////////////*/

contract NavIndexZapTest is IndexBase {
    MockERC20 internal usdg;
    MockRouter internal router;
    NavIndexZap internal zap;
    address internal zapper = address(0x2A9);

    function setUp() public override {
        super.setUp();
        usdg = new MockERC20("USDG", "USDG", 6);
        router = new MockRouter(usdg);
        router.setPrice(address(nvda), 200e6);
        router.setPrice(address(aapl), 250e6);
        router.setPrice(address(qqq), 600e6);
        zap = new NavIndexZap(
            IERC20(address(usdg)), INavSwapRouter(address(router)), INavIndexFactory(address(factory))
        );
        usdg.mint(zapper, 1_000_000e6);
        vm.startPrank(zapper);
        usdg.approve(address(zap), type(uint256).max);
        index.approve(address(zap), type(uint256).max);
        vm.stopPrank();
    }

    function _legs(uint256 budget0, uint256 budget1, uint256 budget2)
        internal
        pure
        returns (NavIndexZap.RouteLeg[] memory legs)
    {
        legs = new NavIndexZap.RouteLeg[](3);
        legs[0] = NavIndexZap.RouteLeg(INavSwapRouter.Leg(1, 10000), budget0, 1);
        legs[1] = NavIndexZap.RouteLeg(INavSwapRouter.Leg(1, 10000), budget1, 1);
        legs[2] = NavIndexZap.RouteLeg(INavSwapRouter.Leg(1, 10000), budget2, 1);
    }

    /*//////////////////////////////////////////////////////////////////////
                                    ZAP IN
    //////////////////////////////////////////////////////////////////////*/

    function test_zapIssue_happyPath() public {
        // 10 shares need 5 NVDA ($1000), 4 AAPL ($1000), 1 QQQ ($600).
        // Budgets padded ~1% over fee+need.
        NavIndexZap.RouteLeg[] memory legs = _legs(1_010e6, 1_010e6, 606e6);
        uint256 usdgBefore = usdg.balanceOf(zapper);

        vm.prank(zapper);
        uint256 net = zap.zapIssue(address(index), 10e18, legs, block.timestamp + 600);

        // 0.5% mint fee -> 9.95 shares to zapper.
        assertEq(net, 9.95e18);
        assertEq(index.balanceOf(zapper), 9.95e18);
        // Zap holds nothing.
        assertEq(usdg.balanceOf(address(zap)), 0, "no USDG rests in zap");
        assertEq(nvda.balanceOf(address(zap)), 0, "no NVDA rests in zap");
        assertEq(aapl.balanceOf(address(zap)), 0, "no AAPL rests in zap");
        assertEq(qqq.balanceOf(address(zap)), 0, "no QQQ rests in zap");
        // Zapper spent at most the budgets; component dust was refunded.
        assertLe(usdgBefore - usdg.balanceOf(zapper), 2_626e6);
        assertGt(nvda.balanceOf(zapper), 0, "excess NVDA refunded");
    }

    function test_zapIssue_revert_notAnIndex() public {
        NavIndexZap.RouteLeg[] memory legs = _legs(100e6, 100e6, 100e6);
        vm.expectRevert(NavIndexZap.NotAnIndex.selector);
        vm.prank(zapper);
        zap.zapIssue(address(usdg), 1e18, legs, block.timestamp + 600);
    }

    function test_zapIssue_revert_lengthMismatch() public {
        NavIndexZap.RouteLeg[] memory legs = new NavIndexZap.RouteLeg[](2);
        legs[0] = NavIndexZap.RouteLeg(INavSwapRouter.Leg(1, 10000), 100e6, 1);
        legs[1] = NavIndexZap.RouteLeg(INavSwapRouter.Leg(1, 10000), 100e6, 1);
        vm.expectRevert(NavIndexZap.LengthMismatch.selector);
        vm.prank(zapper);
        zap.zapIssue(address(index), 1e18, legs, block.timestamp + 600);
    }

    function test_zapIssue_revert_zeroShares() public {
        NavIndexZap.RouteLeg[] memory legs = _legs(100e6, 100e6, 100e6);
        vm.expectRevert(NavIndexZap.ZeroAmount.selector);
        vm.prank(zapper);
        zap.zapIssue(address(index), 0, legs, block.timestamp + 600);
    }

    function test_zapIssue_revert_zeroBudget() public {
        NavIndexZap.RouteLeg[] memory legs = _legs(0, 0, 0);
        vm.expectRevert(NavIndexZap.ZeroAmount.selector);
        vm.prank(zapper);
        zap.zapIssue(address(index), 1e18, legs, block.timestamp + 600);
    }

    function test_zapIssue_revert_deadline() public {
        // The zap's own deadline guard fires before any router call.
        NavIndexZap.RouteLeg[] memory legs = _legs(1_010e6, 1_010e6, 606e6);
        vm.expectRevert(NavIndexZap.Expired.selector);
        vm.prank(zapper);
        zap.zapIssue(address(index), 10e18, legs, block.timestamp - 1);
    }

    function test_zapIssue_revert_insufficientBudget() public {
        // Budgets far below the component requirement: issue's transferFrom fails.
        NavIndexZap.RouteLeg[] memory legs = _legs(10e6, 10e6, 10e6);
        vm.expectRevert();
        vm.prank(zapper);
        zap.zapIssue(address(index), 10e18, legs, block.timestamp + 600);
    }

    /*//////////////////////////////////////////////////////////////////////
                                    ZAP OUT
    //////////////////////////////////////////////////////////////////////*/

    function _mintSharesViaZap(uint256 gross) internal returns (uint256 net) {
        NavIndexZap.RouteLeg[] memory legs =
            _legs(gross * 101e6 / 1e18, gross * 101e6 / 1e18, gross * 61e6 / 1e18);
        vm.prank(zapper);
        net = zap.zapIssue(address(index), gross, legs, block.timestamp + 600);
    }

    function test_zapRedeem_happyPath() public {
        uint256 net = _mintSharesViaZap(10e18);
        uint256 usdgBefore = usdg.balanceOf(zapper);

        NavIndexZap.RouteLeg[] memory legs = _legs(0, 0, 0);
        vm.prank(zapper);
        uint256 out = zap.zapRedeem(address(index), net, legs, 2_000e6, block.timestamp + 600);

        assertGt(out, 2_000e6);
        assertEq(usdg.balanceOf(zapper) - usdgBefore, out);
        assertEq(index.balanceOf(zapper), 0);
        // Zap fully swept.
        assertEq(usdg.balanceOf(address(zap)), 0);
        assertEq(nvda.balanceOf(address(zap)), 0);
        assertEq(aapl.balanceOf(address(zap)), 0);
        assertEq(qqq.balanceOf(address(zap)), 0);
    }

    function test_zapRedeem_revert_slippage() public {
        uint256 net = _mintSharesViaZap(10e18);
        NavIndexZap.RouteLeg[] memory legs = _legs(0, 0, 0);
        vm.expectRevert(); // SlippageExceeded
        vm.prank(zapper);
        zap.zapRedeem(address(index), net, legs, 10_000_000e6, block.timestamp + 600);
    }

    function test_zapRedeem_revert_notAnIndex() public {
        NavIndexZap.RouteLeg[] memory legs = _legs(0, 0, 0);
        vm.expectRevert(NavIndexZap.NotAnIndex.selector);
        vm.prank(zapper);
        zap.zapRedeem(address(usdg), 1e18, legs, 0, block.timestamp + 600);
    }

    /*//////////////////////////////////////////////////////////////////////
                                     FUZZ
    //////////////////////////////////////////////////////////////////////*/

    /// @notice The zap never retains any balance, for arbitrary share sizes and
    ///         over-budgeting, in both directions.
    function testFuzz_zap_neverRetainsBalances(uint256 gross, uint256 pad) public {
        gross = bound(gross, 1e15, 1_000e18);
        pad = bound(pad, 0, 50); // % over-budget

        uint256 needN = (gross * 101e6 / 1e18) * (100 + pad) / 100 + 1;
        uint256 needA = (gross * 101e6 / 1e18) * (100 + pad) / 100 + 1;
        uint256 needQ = (gross * 61e6 / 1e18) * (100 + pad) / 100 + 1;
        usdg.mint(zapper, needN + needA + needQ);

        NavIndexZap.RouteLeg[] memory legs = _legs(needN, needA, needQ);
        vm.prank(zapper);
        uint256 net = zap.zapIssue(address(index), gross, legs, block.timestamp + 600);
        assertEq(index.balanceOf(zapper), net);

        NavIndexZap.RouteLeg[] memory outLegs = _legs(0, 0, 0);
        vm.prank(zapper);
        zap.zapRedeem(address(index), net, outLegs, 1, block.timestamp + 600);

        assertEq(usdg.balanceOf(address(zap)), 0, "usdg swept");
        assertEq(nvda.balanceOf(address(zap)), 0, "nvda swept");
        assertEq(aapl.balanceOf(address(zap)), 0, "aapl swept");
        assertEq(qqq.balanceOf(address(zap)), 0, "qqq swept");
        assertEq(index.balanceOf(address(zap)), 0, "shares swept");
    }

    /*//////////////////////////////////////////////////////////////////////
                        DEADLINE, MEV FLOOR & ALLOWANCES (v2)
    //////////////////////////////////////////////////////////////////////*/

    function test_zapRedeem_revert_deadline() public {
        NavIndexZap.RouteLeg[] memory legs = _legs(0, 0, 0);
        vm.expectRevert(NavIndexZap.Expired.selector);
        vm.prank(zapper);
        zap.zapRedeem(address(index), 1e18, legs, 1, block.timestamp - 1);
    }

    /// @dev A zero minUsdgOut would let MEV sandwich every leg to dust; the
    ///      zap forces callers to state a real floor.
    function test_zapRedeem_revert_zeroMinOut() public {
        NavIndexZap.RouteLeg[] memory legs = _legs(0, 0, 0);
        vm.expectRevert(NavIndexZap.ZeroAmount.selector);
        vm.prank(zapper);
        zap.zapRedeem(address(index), 1e18, legs, 0, block.timestamp + 600);
    }

    /// @dev No component or USDG allowance survives a zap in either direction.
    function test_zap_allowancesZeroedAfter() public {
        NavIndexZap.RouteLeg[] memory legs = _legs(1_010e6, 1_010e6, 606e6);
        vm.prank(zapper);
        uint256 net = zap.zapIssue(address(index), 10e18, legs, block.timestamp + 600);

        assertEq(nvda.allowance(address(zap), address(index)), 0, "nvda->index zeroed");
        assertEq(aapl.allowance(address(zap), address(index)), 0, "aapl->index zeroed");
        assertEq(qqq.allowance(address(zap), address(index)), 0, "qqq->index zeroed");
        assertEq(usdg.allowance(address(zap), address(router)), 0, "usdg->router zeroed");

        NavIndexZap.RouteLeg[] memory outLegs = _legs(0, 0, 0);
        vm.prank(zapper);
        zap.zapRedeem(address(index), net, outLegs, 1, block.timestamp + 600);

        assertEq(nvda.allowance(address(zap), address(router)), 0, "nvda->router zeroed");
        assertEq(aapl.allowance(address(zap), address(router)), 0, "aapl->router zeroed");
        assertEq(qqq.allowance(address(zap), address(router)), 0, "qqq->router zeroed");
    }
}
