// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase, MockERC20} from "./IndexBase.t.sol";
import {NavIndexToken} from "../../src/index/NavIndexToken.sol";
import {NavIndexFactory} from "../../src/index/NavIndexFactory.sol";

/// @dev Unit coverage: factory validation, issue/redeem exact arithmetic,
///      fee splits, streaming accrual, views, registry.
contract NavIndexUnitTest is IndexBase {
    /*//////////////////////////////////////////////////////////////////////
                                    FACTORY
    //////////////////////////////////////////////////////////////////////*/

    function test_factory_registry() public view {
        assertEq(factory.indexCount(), 1);
        assertTrue(factory.isIndex(address(index)));
        assertEq(factory.allIndices(0), address(index));
        assertEq(factory.indicesOf(creator).length, 1);
        assertEq(factory.indicesOf(creator)[0], address(index));
    }

    function test_factory_pagination() public {
        vm.startPrank(creator);
        for (uint256 i; i < 5; ++i) {
            _create("Another Index", "IDX", 0, 0, 0);
        }
        vm.stopPrank();
        assertEq(factory.indexCount(), 6);
        address[] memory page = factory.indices(2, 3);
        assertEq(page.length, 3);
        assertEq(page[0], factory.allIndices(2));
        assertEq(factory.indices(6, 10).length, 0);
        assertEq(factory.indices(4, 10).length, 2);
    }

    function test_factory_revert_deadComponent() public {
        oracle.setQuote(address(qqq), 0);
        vm.expectRevert(abi.encodeWithSelector(NavIndexFactory.DeadComponent.selector, address(qqq)));
        _create("X Index", "X", 0, 0, 0);
    }

    function test_factory_revert_unknownComponent() public {
        oracle.setQuoteReverts(address(aapl), true);
        vm.expectRevert(); // oracle MarketUnknown bubbles
        _create("X Index", "X", 0, 0, 0);
    }

    function test_factory_revert_badNames() public {
        vm.expectRevert(NavIndexFactory.BadName.selector);
        _create("", "X", 0, 0, 0);
        vm.expectRevert(NavIndexFactory.BadName.selector);
        _create("Valid Name", "", 0, 0, 0);
        vm.expectRevert(NavIndexFactory.BadName.selector);
        _create(
            "This name is way way way too long to be a sensible index name!!", "X", 0, 0, 0
        );
        vm.expectRevert(NavIndexFactory.BadName.selector);
        _create("Valid Name", "SYMBOLWAYTOOLONGX", 0, 0, 0);
    }

    function test_token_revert_duplicateComponent() public {
        comps.push(address(nvda)); // dup
        units.push(1e18);
        vm.expectRevert(NavIndexToken.BadConfig.selector);
        _create("Dup Index", "DUP", 0, 0, 0);
        comps.pop();
        units.pop();
    }

    function test_token_revert_tooFewComponents() public {
        address[] memory one = new address[](1);
        one[0] = address(nvda);
        uint256[] memory u = new uint256[](1);
        u[0] = 1e18;
        vm.expectRevert(NavIndexToken.BadConfig.selector);
        factory.createIndex(
            NavIndexFactory.CreateParams("Solo", "SOLO", one, u, 0, 0, 0)
        );
    }

    function test_token_revert_feeCaps() public {
        vm.expectRevert(NavIndexToken.BadConfig.selector);
        _create("Fee Index", "FEE", 101, 0, 0);
        vm.expectRevert(NavIndexToken.BadConfig.selector);
        _create("Fee Index", "FEE", 0, 101, 0);
        vm.expectRevert(NavIndexToken.BadConfig.selector);
        _create("Fee Index", "FEE", 0, 0, 201);
    }

    function test_token_revert_zeroUnit() public {
        units[1] = 0;
        vm.expectRevert(NavIndexToken.BadConfig.selector);
        _create("Zero Index", "ZERO", 0, 0, 0);
        units[1] = 0.4e18;
    }

    function test_token_immutableConfig() public view {
        assertEq(index.creator(), creator);
        assertEq(index.mintFeeBps(), 50);
        assertEq(index.redeemFeeBps(), 50);
        assertEq(index.streamFeeBps(), 100);
        address[] memory c = index.components();
        assertEq(c.length, 3);
        assertEq(c[0], address(nvda));
        uint256[] memory u = index.unitsPerShare();
        assertEq(u[0], 0.5e18);
        assertEq(u[2], 0.1e18);
        assertEq(index.name(), "NAV Blue Chip");
        assertEq(index.symbol(), "NAVBLUE");
        assertEq(index.decimals(), 18);
    }

    /*//////////////////////////////////////////////////////////////////////
                                     ISSUE
    //////////////////////////////////////////////////////////////////////*/

    function test_issue_exactPullsAndShares() public {
        uint256 gross = 100e18;
        vm.prank(minter);
        uint256 net = index.issue(gross, minter);

        // Pulls: 50 NVDA, 40 AAPL, 10 QQQ (exact, no rounding at these units).
        assertEq(nvda.balanceOf(address(index)), 50e18);
        assertEq(aapl.balanceOf(address(index)), 40e18);
        assertEq(qqq.balanceOf(address(index)), 10e18);

        // fee = 0.5% of 100 = 0.5 shares; creator 90% = 0.45; 0.05 unminted.
        assertEq(net, 99.5e18);
        assertEq(index.balanceOf(minter), 99.5e18);
        assertEq(index.balanceOf(creator), 0.45e18);
        assertEq(index.totalSupply(), 99.95e18); // 0.05 never minted
    }

    function test_issue_roundsPullsUp() public {
        // 1 wei of shares still pulls 1 wei of every component.
        vm.prank(minter);
        index.issue(1, minter);
        assertEq(nvda.balanceOf(address(index)), 1);
        assertEq(aapl.balanceOf(address(index)), 1);
        assertEq(qqq.balanceOf(address(index)), 1);
    }

    function test_issue_toOtherReceiver() public {
        vm.prank(minter);
        index.issue(10e18, redeemer);
        assertEq(index.balanceOf(redeemer), 9.95e18);
        assertEq(index.balanceOf(minter), 0);
    }

    function test_issue_revert_zero() public {
        vm.expectRevert(NavIndexToken.ZeroShares.selector);
        vm.prank(minter);
        index.issue(0, minter);
    }

    function test_issue_zeroFeeIndex() public {
        vm.prank(creator);
        NavIndexToken free = NavIndexToken(_create("Free Index", "FREE", 0, 0, 0));
        vm.startPrank(minter);
        nvda.approve(address(free), type(uint256).max);
        aapl.approve(address(free), type(uint256).max);
        qqq.approve(address(free), type(uint256).max);
        uint256 net = free.issue(100e18, minter);
        vm.stopPrank();
        assertEq(net, 100e18);
        assertEq(free.totalSupply(), 100e18);
        assertEq(free.balanceOf(creator), 0);
    }

    /*//////////////////////////////////////////////////////////////////////
                                     REDEEM
    //////////////////////////////////////////////////////////////////////*/

    function test_redeem_exactProRata() public {
        vm.prank(minter);
        index.issue(100e18, minter);

        uint256 supply = index.totalSupply(); // 99.95e18
        uint256 shares = 50e18;
        uint256 feeShares = shares * 50 / BPS; // 0.25e18
        uint256 net = shares - feeShares; // 49.75e18

        uint256 nvdaBefore = nvda.balanceOf(redeemer);
        vm.prank(minter);
        index.redeem(shares, redeemer);

        // out = bal * net / supplyBeforeBurn
        assertEq(nvda.balanceOf(redeemer) - nvdaBefore, 50e18 * net / supply);
        // creator got 90% of fee shares on top of mint-side fees
        assertEq(index.balanceOf(creator), 0.45e18 + feeShares * 9000 / BPS);
        // supply: -shares +creatorCut
        assertEq(index.totalSupply(), supply - shares + feeShares * 9000 / BPS);
    }

    function test_redeem_donationAccruesToHolders() public {
        vm.prank(minter);
        index.issue(100e18, minter);
        // Someone donates 10 NVDA to the vault.
        nvda.mint(address(index), 10e18);

        uint256 supply = index.totalSupply();
        uint256 net = 50e18 - (50e18 * 50 / BPS);
        uint256 before = nvda.balanceOf(minter);
        vm.prank(minter);
        index.redeem(50e18, minter);
        // Redeemer gets pro-rata of 60 NVDA, not 50.
        assertEq(nvda.balanceOf(minter) - before, 60e18 * net / supply);
    }

    function test_redeem_fullSupply_drainsVault() public {
        vm.prank(creator);
        NavIndexToken free = NavIndexToken(_create("Free Index", "FREE", 0, 0, 0));
        vm.startPrank(minter);
        nvda.approve(address(free), type(uint256).max);
        aapl.approve(address(free), type(uint256).max);
        qqq.approve(address(free), type(uint256).max);
        free.issue(77.777e18, minter);
        free.redeem(77.777e18, minter);
        vm.stopPrank();
        assertEq(free.totalSupply(), 0);
        assertEq(nvda.balanceOf(address(free)), 0);
        assertEq(aapl.balanceOf(address(free)), 0);
        assertEq(qqq.balanceOf(address(free)), 0);
    }

    function test_redeem_revert_zero() public {
        vm.expectRevert(NavIndexToken.ZeroShares.selector);
        vm.prank(minter);
        index.redeem(0, minter);
    }

    function test_redeem_revert_insufficientBalance() public {
        vm.prank(minter);
        index.issue(10e18, minter);
        vm.expectRevert();
        vm.prank(minter);
        index.redeem(100e18, minter);
    }

    function test_roundTrip_neverProfits() public {
        vm.prank(minter);
        uint256 net = index.issue(100e18, minter);

        uint256 nvdaBefore = nvda.balanceOf(minter);
        vm.prank(minter);
        index.redeem(net, minter);
        // Got back strictly less NVDA than the 50 deposited (fees + rounding).
        assertLt(nvda.balanceOf(minter) - nvdaBefore, 50e18);
    }

    /*//////////////////////////////////////////////////////////////////////
                                STREAMING FEE
    //////////////////////////////////////////////////////////////////////*/

    function test_streaming_exactAccrual() public {
        vm.prank(minter);
        index.issue(100e18, minter);
        uint256 supply = index.totalSupply();
        uint256 creatorBefore = index.balanceOf(creator);

        vm.warp(block.timestamp + 365 days);
        index.pokeFees();

        // 100 bps over exactly one year.
        uint256 expected = supply * 100 * 365 days / (BPS * YEAR);
        assertEq(index.balanceOf(creator) - creatorBefore, expected);
        assertEq(index.lastAccrual(), block.timestamp);
    }

    function test_streaming_zeroSupply_safe() public {
        vm.warp(block.timestamp + 30 days);
        index.pokeFees(); // must not revert, must not mint
        assertEq(index.totalSupply(), 0);
        assertEq(index.lastAccrual(), block.timestamp);
    }

    function test_streaming_zeroRate_noMint() public {
        vm.prank(creator);
        NavIndexToken free = NavIndexToken(_create("Free Index", "FREE", 0, 0, 0));
        vm.startPrank(minter);
        nvda.approve(address(free), type(uint256).max);
        aapl.approve(address(free), type(uint256).max);
        qqq.approve(address(free), type(uint256).max);
        free.issue(100e18, minter);
        vm.stopPrank();
        vm.warp(block.timestamp + 365 days);
        free.pokeFees();
        assertEq(free.balanceOf(creator), 0);
    }

    function test_streaming_accruesOnIssueAndRedeem() public {
        vm.prank(minter);
        index.issue(100e18, minter);
        uint64 t0 = index.lastAccrual();
        vm.warp(block.timestamp + 10 days);
        vm.prank(minter);
        index.issue(1e18, minter);
        assertGt(index.lastAccrual(), t0);
        uint64 t1 = index.lastAccrual();
        vm.warp(block.timestamp + 10 days);
        vm.prank(minter);
        index.redeem(1e18, minter);
        assertGt(index.lastAccrual(), t1);
    }

    /*//////////////////////////////////////////////////////////////////////
                                     VIEWS
    //////////////////////////////////////////////////////////////////////*/

    function test_issueAmounts_matchesPulls() public {
        uint256 gross = 33.33e18;
        uint256[] memory amounts = index.issueAmounts(gross);
        vm.prank(minter);
        index.issue(gross, minter);
        assertEq(nvda.balanceOf(address(index)), amounts[0]);
        assertEq(aapl.balanceOf(address(index)), amounts[1]);
        assertEq(qqq.balanceOf(address(index)), amounts[2]);
    }

    function test_redeemAmounts_matchesPayout() public {
        vm.prank(minter);
        index.issue(100e18, minter);
        uint256[] memory amounts = index.redeemAmounts(40e18);
        uint256 before = nvda.balanceOf(minter);
        vm.prank(minter);
        index.redeem(40e18, minter);
        assertEq(nvda.balanceOf(minter) - before, amounts[0]);
    }

    function test_redeemAmounts_zeroSupply() public view {
        uint256[] memory amounts = index.redeemAmounts(10e18);
        assertEq(amounts[0], 0);
        assertEq(amounts[1], 0);
        assertEq(amounts[2], 0);
    }

    /*//////////////////////////////////////////////////////////////////////
                    DONATION NEUTRALITY & SHORTFALL (v2)
    //////////////////////////////////////////////////////////////////////*/

    /// @dev nominalAmounts is the floor-rounded static basket.
    function test_nominalAmounts_view() public view {
        uint256[] memory amounts = index.nominalAmounts(100e18);
        assertEq(amounts[0], 50e18); // 0.5 * 100
        assertEq(amounts[1], 40e18); // 0.4 * 100
        assertEq(amounts[2], 10e18); // 0.1 * 100
    }

    /// @dev A donation to the vault cannot be reclaimed by an issuer: issue
    ///      pulls max(nominal, pro-rata), so later issuers pay the inflated
    ///      pro-rata price and existing holders' backing-per-share never falls.
    function test_issue_donationFrontRunNeutralized() public {
        vm.prank(minter);
        index.issue(100e18, minter);
        uint256 supplyBefore = index.totalSupply();
        uint256 backingBefore = nvda.balanceOf(address(index)) * 1e18 / supplyBefore;

        // Attacker donates 100 NVDA directly to the vault.
        nvda.mint(address(index), 100e18);
        uint256 backingAfterDonation = nvda.balanceOf(address(index)) * 1e18 / index.totalSupply();
        assertGt(backingAfterDonation, backingBefore);

        // Redeemer issues and redeems the same gross amount: the round trip
        // must not extract the donation.
        uint256[] memory pull = index.issueAmounts(100e18);
        // Pro-rata pull now exceeds the nominal 50 NVDA.
        assertGt(pull[0], 50e18);

        uint256 nvdaBefore = nvda.balanceOf(redeemer);
        vm.startPrank(redeemer);
        uint256 net = index.issue(100e18, redeemer);
        index.redeem(net, redeemer);
        vm.stopPrank();
        // Round trip strictly loses (fees + no donation capture).
        assertLt(nvda.balanceOf(redeemer), nvdaBefore);

        // Original holder's backing per share never decreased.
        uint256 backingFinal = nvda.balanceOf(address(index)) * 1e18 / index.totalSupply();
        assertGe(backingFinal, backingBefore);
    }

    /// @dev Fee-on-transfer component delivering less than requested must
    ///      revert the whole issuance atomically.
    function test_issue_feeOnTransfer_reverts() public {
        MockFoTERC20 fot = new MockFoTERC20();
        address[] memory c = new address[](2);
        c[0] = address(fot);
        c[1] = address(nvda);
        uint256[] memory u = new uint256[](2);
        u[0] = 1e18;
        u[1] = 0.1e18;
        oracle.setQuote(address(fot), 100e18);
        NavIndexToken fotIndex = NavIndexToken(
            factory.createIndex(
                NavIndexFactory.CreateParams({
                    name: "FoT Index",
                    symbol: "FOT",
                    components: c,
                    unitsPerShare: u,
                    mintFeeBps: 0,
                    redeemFeeBps: 0,
                    streamFeeBps: 0
                })
            )
        );
        fot.mint(minter, 1e24);
        vm.startPrank(minter);
        fot.approve(address(fotIndex), type(uint256).max);
        nvda.approve(address(fotIndex), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(NavIndexToken.ComponentShortfall.selector, address(fot)));
        fotIndex.issue(10e18, minter);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////////////
                            SKIP-REDEEM ESCAPE HATCH (v2)
    //////////////////////////////////////////////////////////////////////*/

    function test_redeemSkip_forfeitsLeg() public {
        vm.prank(minter);
        index.issue(100e18, minter);

        bool[] memory skip = new bool[](3);
        skip[1] = true; // forfeit AAPL leg
        uint256[] memory owed = index.redeemAmounts(50e18);

        uint256 nvdaBefore = nvda.balanceOf(minter);
        uint256 aaplBefore = aapl.balanceOf(minter);
        uint256 vaultAapl = aapl.balanceOf(address(index));

        vm.expectEmit(true, false, false, true);
        emit NavIndexToken.ComponentSkipped(address(aapl), owed[1]);
        vm.prank(minter);
        index.redeem(50e18, minter, skip);

        assertEq(nvda.balanceOf(minter) - nvdaBefore, owed[0], "non-skipped leg pays");
        assertEq(aapl.balanceOf(minter), aaplBefore, "skipped leg pays nothing");
        assertEq(aapl.balanceOf(address(index)), vaultAapl, "forfeited AAPL stays in vault");
    }

    /// @dev Forfeited legs accrete to remaining holders via pro-rata redeem.
    function test_redeemSkip_accretesToHolders() public {
        vm.prank(minter);
        index.issue(100e18, minter);
        vm.prank(redeemer);
        index.issue(100e18, redeemer);

        bool[] memory skip = new bool[](3);
        skip[0] = true; // minter forfeits all NVDA
        vm.startPrank(minter);
        index.redeem(index.balanceOf(minter), minter, skip);
        vm.stopPrank();

        // Redeemer's NVDA entitlement per share is now higher than nominal.
        uint256 half = index.balanceOf(redeemer);
        uint256[] memory owed = index.redeemAmounts(half);
        uint256[] memory nominal = index.nominalAmounts(half);
        assertGt(owed[0], nominal[0], "forfeit accretes");
    }

    function test_redeemSkip_revert_wrongLength() public {
        vm.prank(minter);
        index.issue(100e18, minter);
        bool[] memory skip = new bool[](2);
        vm.expectRevert(NavIndexToken.BadSkips.selector);
        vm.prank(minter);
        index.redeem(10e18, minter, skip);
    }

    function test_redeemSkip_revert_allSkipped() public {
        vm.prank(minter);
        index.issue(100e18, minter);
        bool[] memory skip = new bool[](3);
        skip[0] = true;
        skip[1] = true;
        skip[2] = true;
        vm.expectRevert(NavIndexToken.BadSkips.selector);
        vm.prank(minter);
        index.redeem(10e18, minter, skip);
    }

    function test_redeemSkip_noneSkipped_equalsPlainRedeem() public {
        vm.prank(minter);
        index.issue(100e18, minter);
        bool[] memory skip = new bool[](3);
        uint256[] memory owed = index.redeemAmounts(30e18);
        uint256 before = qqq.balanceOf(minter);
        vm.prank(minter);
        index.redeem(30e18, minter, skip);
        assertEq(qqq.balanceOf(minter) - before, owed[2]);
    }
}

/// @dev Fee-on-transfer mock: burns 1% of every transfer.
contract MockFoTERC20 {
    string public name = "FoT";
    string public symbol = "FOT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        return _move(msg.sender, to, amt);
    }

    function transferFrom(address f, address to, uint256 amt) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= amt, "allow");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - amt;
        return _move(f, to, amt);
    }

    function _move(address f, address to, uint256 amt) internal returns (bool) {
        require(balanceOf[f] >= amt, "bal");
        uint256 fee = amt / 100; // 1% burn
        balanceOf[f] -= amt;
        balanceOf[to] += amt - fee;
        totalSupply -= fee;
        return true;
    }
}
