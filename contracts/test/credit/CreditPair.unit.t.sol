// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CreditBase, MockERC20, MockAnchorOracle} from "./CreditBase.t.sol";
import {CreditPair} from "../../src/credit/CreditPair.sol";
import {CreditFactory} from "../../src/credit/CreditFactory.sol";

contract CreditPairUnitTest is CreditBase {
    /*//////////////////////////////////////////////////////////////////////
                                CONSTRUCTOR / FACTORY
    //////////////////////////////////////////////////////////////////////*/

    function test_factory_immutables() public view {
        assertEq(factory.DEPLOYER(), address(this));
        assertEq(factory.USDG(), address(usdg));
        assertEq(factory.ORACLE(), address(oracle));
        assertEq(factory.ACCUMULATOR(), ACCUM);
        assertEq(factory.allPairsLength(), 1);
        assertEq(factory.allPairs(0), address(pair));
        assertEq(factory.pairFor(address(stock)), address(pair));
    }

    function test_factory_onlyDeployer() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(CreditFactory.NotDeployer.selector);
        factory.deployPair(address(stock), 5000, 6000, 800, 1e6, 2e6, 26 hours, 0.8e27, 0, 0.08e27, 0.72e27);
    }

    function test_factory_noDuplicatePair() public {
        vm.expectRevert(CreditFactory.PairExists.selector);
        factory.deployPair(address(stock), 5000, 6000, 800, 1e6, 2e6, 26 hours, 0.8e27, 0, 0.08e27, 0.72e27);
    }

    function test_constructor_rejectsBadParams() public {
        MockERC20 t2 = new MockERC20("T", "T", 18);
        oracle.setAnchor(address(t2), 100e18, block.timestamp);

        // LTV >= threshold
        vm.expectRevert(bytes("LTV>=THRESHOLD"));
        factory.deployPair(address(t2), 7000, 7000, 800, 1e6, 2e6, 26 hours, 0.8e27, 0, 0.08e27, 0.72e27);

        // threshold * (1+bonus) > 100%
        vm.expectRevert(bytes("THRESHOLD*BONUS"));
        factory.deployPair(address(t2), 9000, 9500, 800, 1e6, 2e6, 26 hours, 0.8e27, 0, 0.08e27, 0.72e27);

        // borrowCap > supplyCap
        vm.expectRevert(bytes("CAPS"));
        factory.deployPair(address(t2), 6000, 7000, 800, 3e6, 2e6, 26 hours, 0.8e27, 0, 0.08e27, 0.72e27);
    }

    function test_constructor_probesOracle() public {
        MockERC20 unknown = new MockERC20("X", "X", 18);
        oracle.setReverts(address(unknown), true);
        vm.expectRevert(MockAnchorOracle.MarketUnknown.selector);
        factory.deployPair(address(unknown), 6000, 7000, 800, 1e6, 2e6, 26 hours, 0.8e27, 0, 0.08e27, 0.72e27);
    }

    function test_pair_immutables() public view {
        assertEq(address(pair.COLLATERAL()), address(stock));
        assertEq(address(pair.USDG()), address(usdg));
        assertEq(address(pair.ORACLE()), address(oracle));
        assertEq(pair.ACCUMULATOR(), ACCUM);
        assertEq(pair.LTV_BPS(), 6000);
        assertEq(pair.LIQ_THRESHOLD_BPS(), 7000);
        assertEq(pair.LIQ_BONUS_BPS(), 800);
        assertEq(pair.MAX_PRICE_AGE(), 26 hours);
    }

    /*//////////////////////////////////////////////////////////////////////
                                  DEPOSIT / WITHDRAW
    //////////////////////////////////////////////////////////////////////*/

    function test_deposit_basic() public {
        uint256 shares = _deposit(lender, 10_000e6);
        assertGt(shares, 0);
        assertEq(pair.totalSupplyAssets(), 10_000e6);
        assertEq(usdg.balanceOf(address(pair)), 10_000e6);
        _assertSolvent();
    }

    function test_deposit_zeroReverts() public {
        vm.prank(lender);
        vm.expectRevert(CreditPair.ZeroAmount.selector);
        pair.deposit(0);
    }

    function test_deposit_capEnforced() public {
        vm.prank(lender);
        vm.expectRevert(CreditPair.SupplyCapExceeded.selector);
        pair.deposit(SUPPLY_CAP + 1);
    }

    function test_withdraw_full_roundTrip() public {
        _deposit(lender, 10_000e6);
        vm.prank(lender);
        uint256 assets = pair.withdraw(type(uint256).max);
        // Virtual offsets cost at most 1 rounding unit.
        assertGe(assets, 10_000e6 - 1);
        assertLe(assets, 10_000e6);
        _assertSolvent();
    }

    function test_withdraw_moreThanOwnedReverts() public {
        _deposit(lender, 100e6);
        (uint128 shares,,) = pair.accounts(lender);
        vm.prank(lender);
        vm.expectRevert(CreditPair.InsufficientShares.selector);
        pair.withdraw(uint256(shares) + 1);
    }

    function test_withdraw_limitedByLiquidity() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 100e18); // $20k collateral
        _borrow(borrower, 9_000e6);
        vm.prank(lender);
        vm.expectRevert(CreditPair.InsufficientLiquidity.selector);
        pair.withdraw(type(uint256).max);
        _assertSolvent();
    }

    function test_deposit_withdraw_alwaysOpenWhenStale() public {
        _deposit(lender, 1_000e6);
        vm.warp(block.timestamp + 30 days); // anchor now very stale
        _deposit(lender, 1_000e6);
        vm.prank(lender);
        pair.withdraw(type(uint256).max);
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////////////
                                     BORROW
    //////////////////////////////////////////////////////////////////////*/

    function test_borrow_basic_feeToAccumulator() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18); // $2,000 collateral -> max $1,200 debt
        uint256 balBefore = usdg.balanceOf(borrower);

        uint256 fee = _borrow(borrower, 1_000e6);
        assertEq(fee, 3e6); // 30 bps of 1,000
        assertEq(usdg.balanceOf(borrower) - balBefore, 1_000e6);
        assertEq(usdg.balanceOf(ACCUM), 3e6);
        assertEq(pair.debtOf(borrower), 1_003e6);
        _assertSolvent();
    }

    function test_borrow_respectsLtv() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18); // $2,000 -> LTV cap $1,200 incl. fee
        vm.prank(borrower);
        vm.expectRevert(CreditPair.LtvExceeded.selector);
        pair.borrow(1_198e6); // 1198 + 3.6 fee > 1200
    }

    function test_borrow_maxLtvBoundary() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        // debt = assets + fee <= 1200e6  =>  assets <= 1200e6 / 1.003
        uint256 assets = (1_200e6 * BPS) / (BPS + 30);
        _borrow(borrower, assets);
        assertLe(pair.debtOf(borrower), 1_200e6);
        _assertSolvent();
    }

    function test_borrow_minDebt() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        vm.prank(borrower);
        vm.expectRevert(CreditPair.DebtTooSmall.selector);
        pair.borrow(5e6); // 5.015 < MIN_DEBT 10
    }

    function test_borrow_capEnforced() public {
        _deposit(lender, SUPPLY_CAP);
        _addCollateral(borrower, 1_000_000e18);
        vm.prank(borrower);
        vm.expectRevert(CreditPair.BorrowCapExceeded.selector);
        pair.borrow(BORROW_CAP); // + fee busts the cap
    }

    function test_borrow_liquidityEnforced() public {
        _deposit(lender, 1_000e6);
        _addCollateral(borrower, 100e18);
        vm.prank(borrower);
        vm.expectRevert(CreditPair.InsufficientLiquidity.selector);
        pair.borrow(1_000e6); // fee makes debt > cash
    }

    function test_borrow_staleOracleBlocks() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.prank(borrower);
        vm.expectRevert(CreditPair.StalePrice.selector);
        pair.borrow(500e6);
    }

    function test_borrow_zeroPriceBlocks() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        oracle.setAnchor(address(stock), 0, block.timestamp);
        vm.prank(borrower);
        vm.expectRevert(CreditPair.InvalidPrice.selector);
        pair.borrow(500e6);
    }

    /*//////////////////////////////////////////////////////////////////////
                                      REPAY
    //////////////////////////////////////////////////////////////////////*/

    function test_repay_partial() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_000e6);

        vm.prank(borrower);
        uint256 repaid = pair.repay(500e6, borrower);
        assertEq(repaid, 500e6);
        assertApproxEqAbs(pair.debtOf(borrower), 503e6, 1);
        _assertSolvent();
    }

    function test_repay_full_clearsPosition() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_000e6);

        vm.prank(borrower);
        pair.repay(type(uint256).max, borrower);
        assertEq(pair.debtOf(borrower), 0);
        (, uint128 bs,) = pair.accounts(borrower);
        assertEq(bs, 0);
        // Collateral is now fully withdrawable.
        vm.prank(borrower);
        pair.removeCollateral(10e18);
        _assertSolvent();
    }

    function test_repay_cannotLeaveDust() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_000e6);
        vm.prank(borrower);
        vm.expectRevert(CreditPair.DebtTooSmall.selector);
        pair.repay(998e6, borrower); // would leave ~5 USDG < MIN_DEBT
    }

    function test_repay_worksWhenOracleStale() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_000e6);
        vm.warp(block.timestamp + 30 days);
        vm.prank(borrower);
        pair.repay(type(uint256).max, borrower); // never gated
        assertEq(pair.debtOf(borrower), 0);
        _assertSolvent();
    }

    function test_repay_onBehalf() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_000e6);
        vm.prank(liquidator); // anyone can repay for borrower
        pair.repay(type(uint256).max, borrower);
        assertEq(pair.debtOf(borrower), 0);
    }

    function test_repay_accruesInterest() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 100e18);
        _borrow(borrower, 5_000e6);

        uint256 debtBefore = pair.debtOf(borrower);
        vm.warp(block.timestamp + 365 days);
        _freshenOracle();
        uint256 debtAfter = pair.debtOf(borrower);
        assertGt(debtAfter, debtBefore); // interest accrued
        // ~50.15% utilization -> rate ~= 8% * (0.5015/0.8) ~= 5.01% APR
        uint256 expected = debtBefore + (debtBefore * 5015 / 100_000) * 8 / 10 ;
        assertApproxEqRel(debtAfter, expected, 0.03e18);

        vm.prank(borrower);
        pair.repay(type(uint256).max, borrower);
        assertEq(pair.debtOf(borrower), 0);
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////////////
                                   COLLATERAL
    //////////////////////////////////////////////////////////////////////*/

    function test_addCollateral_alwaysOpen() public {
        vm.warp(block.timestamp + 30 days); // stale anchor
        _addCollateral(borrower, 5e18);
        (,, uint128 c) = pair.accounts(borrower);
        assertEq(c, 5e18);
    }

    function test_removeCollateral_freeWhenNoDebt() public {
        _addCollateral(borrower, 5e18);
        vm.warp(block.timestamp + 30 days); // stale is fine with zero debt
        vm.prank(borrower);
        pair.removeCollateral(5e18);
        (,, uint128 c) = pair.accounts(borrower);
        assertEq(c, 0);
    }

    function test_removeCollateral_ltvGated() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_000e6);
        vm.prank(borrower);
        vm.expectRevert(CreditPair.LtvExceeded.selector);
        pair.removeCollateral(2e18); // 8 * 200 * 0.6 = 960 < 1003 debt
    }

    function test_removeCollateral_staleOracleBlocksWithDebt() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 100e18);
        _borrow(borrower, 1_000e6);
        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.prank(borrower);
        vm.expectRevert(CreditPair.StalePrice.selector);
        pair.removeCollateral(1e18);
    }

    function test_removeCollateral_partialWithinLtv() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 100e18);
        _borrow(borrower, 1_000e6);
        vm.prank(borrower);
        pair.removeCollateral(90e18); // 10 * 200 * 0.6 = 1200 >= 1003
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////////////
                                    ACCRUAL / IRM
    //////////////////////////////////////////////////////////////////////*/

    function test_irm_shape() public view {
        // 0% util -> base (0)
        assertEq(pair.borrowRateRay(0), 0);
        // kink -> slope1 (8%)
        assertEq(pair.borrowRateRay(0.8e27), 0.08e27);
        // 100% -> slope1 + slope2 (80%)
        assertEq(pair.borrowRateRay(RAY), 0.8e27);
        // halfway to kink -> 4%
        assertEq(pair.borrowRateRay(0.4e27), 0.04e27);
        // halfway past kink -> 8% + 36% = 44%
        assertEq(pair.borrowRateRay(0.9e27), 0.44e27);
    }

    function test_accrual_splitsReserve() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 100e18);
        _borrow(borrower, 5_000e6);

        (uint128 selfSharesBefore,,) = pair.accounts(address(pair));
        assertEq(selfSharesBefore, 0);

        vm.warp(block.timestamp + 365 days);
        pair.accrue();

        (uint128 selfShares,,) = pair.accounts(address(pair));
        assertGt(selfShares, 0, "reserve minted");

        // Reserve S >= B invariant intact after fee mint.
        _assertSolvent();
    }

    function test_accrual_idempotentSameBlock() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 100e18);
        _borrow(borrower, 5_000e6);
        vm.warp(block.timestamp + 1 days);
        pair.accrue();
        uint256 b1 = pair.totalBorrowAssets();
        pair.accrue(); // same timestamp: no-op
        assertEq(pair.totalBorrowAssets(), b1);
    }

    function test_accrual_zeroWhenNoDebt() public {
        _deposit(lender, 10_000e6);
        vm.warp(block.timestamp + 365 days);
        pair.accrue();
        assertEq(pair.totalSupplyAssets(), 10_000e6); // lenders earn nothing without borrowers
    }

    function test_supplyRate_netOfReserve() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 100e18);
        _borrow(borrower, 5_000e6);
        (,,, uint256 util, uint256 br, uint256 sr,,,) = pair.marketState();
        // supplyRate = borrowRate * util * (1 - 20%)
        assertApproxEqRel(sr, br * util / RAY * 8000 / BPS, 0.001e18);
    }

    /*//////////////////////////////////////////////////////////////////////
                                     SKIM
    //////////////////////////////////////////////////////////////////////*/

    function test_skim_nothingReverts() public {
        vm.expectRevert(CreditPair.NothingToSkim.selector);
        pair.skimReserves();
    }

    function test_skim_sweepsToAccumulatorWithBounty() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 100e18);
        _borrow(borrower, 5_000e6);
        vm.warp(block.timestamp + 365 days);

        // Repay so there is cash to skim.
        vm.prank(borrower);
        pair.repay(type(uint256).max, borrower);

        uint256 accumBefore = usdg.balanceOf(ACCUM);
        vm.prank(liquidator);
        (uint256 swept, uint256 bounty) = pair.skimReserves();

        assertGt(swept, 0);
        assertEq(usdg.balanceOf(ACCUM) - accumBefore, swept);
        assertEq(usdg.balanceOf(liquidator), 1_000_000e6 + bounty);
        (uint128 selfShares,,) = pair.accounts(address(pair));
        assertEq(selfShares, 0, "reserve fully swept");
        _assertSolvent();
    }

    function test_skim_limitedByCash() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 200e18);
        _borrow(borrower, 9_000e6);
        vm.warp(block.timestamp + 365 days);
        _freshenOracle();

        // Utilization ~90%: cash is thin but nonzero, skim must not revert or
        // sweep more than cash.
        pair.accrue();
        uint256 cashBefore = pair.availableLiquidity();
        (uint256 swept, uint256 bounty) = pair.skimReserves();
        assertLe(swept + bounty, cashBefore);
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////////////
                                   LIQUIDATION
    //////////////////////////////////////////////////////////////////////*/

    function _setupUnderwater() internal returns (uint256 debt) {
        _deposit(lender, 50_000e6);
        _addCollateral(borrower, 10e18);        // $2,000
        _borrow(borrower, 1_100e6);             // debt 1,103.3 (LTV 55%)
        _setPrice(150e18);                      // $1,500 collateral; LT 70% -> 1,050 < debt
        return pair.debtOf(borrower);
    }

    function test_liquidate_healthyReverts() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_000e6);
        vm.prank(liquidator);
        vm.expectRevert(CreditPair.NotLiquidatable.selector);
        pair.liquidate(borrower, 100e6);
    }

    function test_liquidate_partial_closeFactor50() public {
        uint256 debt = _setupUnderwater();
        // HF = 1500*0.7/1103.3 = 0.9517 -> in [0.95,1) -> close factor 50%
        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = pair.liquidate(borrower, type(uint256).max / 2);
        assertApproxEqAbs(repaid, debt / 2, 2);
        // seize = repaid * 1.08 / 150
        assertApproxEqRel(seized, (repaid * 1e12) * 10800 / 10000 * 1e18 / 150e18, 0.001e18);
        assertGt(pair.debtOf(borrower), 0);
        _assertSolvent();
    }

    function test_liquidate_fullBelow095() public {
        _deposit(lender, 50_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_100e6);
        _setPrice(140e18); // HF = 1400*0.7/1103.3 = 0.888 < 0.95 -> 100% closable
        uint256 debt = pair.debtOf(borrower);

        vm.prank(liquidator);
        (uint256 repaid,) = pair.liquidate(borrower, type(uint256).max / 2);
        assertEq(repaid, debt);
        assertEq(pair.debtOf(borrower), 0);
        _assertSolvent();
    }

    /// @notice A liquidation ask that would leave a dust remainder
    ///         (0 < debt - repaid < MIN_DEBT) reverts with DebtTooSmall by design
    ///         (Morpho dust guard). The liquidator's correct move is a full close
    ///         (any ask >= debt), which is always permitted in the same state —
    ///         liquidation is never blocked, only the dust-leaving ask shape.
    ///         Surfaced by the 100k-run fuzz campaign (seed 0xae1faa9d…).
    function test_liquidate_dustWindowReverts() public {
        _deposit(lender, 50_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_100e6);
        _setPrice(140e18);                          // HF < 0.95 -> 100% closable
        uint256 debt = pair.debtOf(borrower);

        vm.prank(liquidator);
        vm.expectRevert(CreditPair.DebtTooSmall.selector);
        pair.liquidate(borrower, debt - 5e6);       // would leave 5 USDG < MIN_DEBT

        // Same state, full ask: closes cleanly.
        vm.prank(liquidator);
        (uint256 repaid,) = pair.liquidate(borrower, debt);
        assertEq(repaid, debt);
        assertEq(pair.debtOf(borrower), 0);
        _assertSolvent();
    }

    function test_liquidate_badDebtSocialized() public {
        _deposit(lender, 50_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_100e6);
        _setPrice(80e18); // collateral $800 << debt 1,103 -> guaranteed bad debt

        uint256 supplyBefore = pair.totalSupplyAssets();
        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = pair.liquidate(borrower, type(uint256).max / 2);

        assertEq(seized, 10e18, "all collateral seized");
        // repaid = 800/1.08 = ~740.74
        assertApproxEqAbs(repaid, 740_740_740, 2);
        assertEq(pair.debtOf(borrower), 0, "position closed, no zombie debt");
        assertLt(pair.totalSupplyAssets(), supplyBefore, "loss socialized");
        _assertSolvent();
    }

    function test_liquidate_staleOracleBlocks() public {
        _setupUnderwater();
        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.prank(liquidator);
        vm.expectRevert(CreditPair.StalePrice.selector);
        pair.liquidate(borrower, 100e6);
    }

    function test_liquidate_liquidatorProfit() public {
        _setupUnderwater();
        uint256 usdgBefore = usdg.balanceOf(liquidator);
        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = pair.liquidate(borrower, type(uint256).max / 2);
        // Collateral received at $150 is worth more than USDG paid (8% bonus).
        uint256 seizedValue = seized * 150e18 / 1e18 / 1e12; // to USDG units
        assertGt(seizedValue, repaid, "bonus positive");
        assertApproxEqRel(seizedValue, repaid * 108 / 100, 0.001e18);
        assertEq(usdgBefore - usdg.balanceOf(liquidator), repaid);
    }

    function test_liquidate_dustFullClose() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 1e17); // $20 collateral
        _borrow(borrower, 10e6);        // debt 10.03 (LTV 50.15% < 60%)
        _setPrice(120e18);              // $12 collateral; LT: 8.4 < 10.03 underwater
        // debt <= FULL_CLOSE_DEBT -> fully closable regardless of HF band
        vm.prank(liquidator);
        pair.liquidate(borrower, type(uint256).max / 2);
        assertEq(pair.debtOf(borrower), 0);
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////////////
                                 VIEWS / MISC
    //////////////////////////////////////////////////////////////////////*/

    function test_healthFactor_views() public {
        assertEq(pair.healthFactor(borrower), type(uint256).max);
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_000e6);
        // HF = 2000*0.7/1003 = 1.395
        assertApproxEqRel(pair.healthFactor(borrower), 1.3958e18, 0.001e18);
    }

    function test_priceStatus() public {
        (uint256 p, uint256 at, bool fresh) = pair.priceStatus();
        assertEq(p, PRICE);
        assertEq(at, block.timestamp);
        assertTrue(fresh);
        vm.warp(block.timestamp + MAX_AGE + 1);
        (,, fresh) = pair.priceStatus();
        assertFalse(fresh);
    }

    function test_donation_doesNotBreakAccounting() public {
        _deposit(lender, 10_000e6);
        usdg.mint(address(pair), 100_000e6); // hostile donation
        _addCollateral(borrower, 100e18);
        _borrow(borrower, 5_000e6);
        // Utilization uses accounting cash, not balance: rate unaffected.
        (,,, uint256 util,,,,,) = pair.marketState();
        assertApproxEqRel(util, 0.5015e27, 0.001e27);
        // Lender exits get exactly their accounting entitlement.
        vm.prank(borrower);
        pair.repay(type(uint256).max, borrower);
        vm.prank(lender);
        uint256 got = pair.withdraw(type(uint256).max);
        assertLe(got, 10_001e6);
        _assertSolvent();
    }

    function test_supplyShares_inflationAttackResisted() public {
        // Classic first-depositor inflation attack: tiny deposit + donation.
        vm.prank(lender);
        pair.deposit(1); // 1 unit
        usdg.mint(address(pair), 1_000_000e6); // donation does NOT touch ledger

        // Victim deposits; virtual offsets keep share pricing honest.
        vm.prank(borrower);
        uint256 victimShares = pair.deposit(1_000e6);
        assertGt(victimShares, 0, "victim not zero-shared");

        vm.prank(borrower);
        uint256 out = pair.withdraw(type(uint256).max);
        assertGe(out, 999e6, "victim loses at most rounding dust");
    }

    /*//////////////////// audit A regression coverage ////////////////////*/

    /// L-03: a position whose collateral value rounds below 1 USDG unit must
    /// still be fully closable — zero-repay close seizes the dust and
    /// socializes the whole debt instead of stranding it forever.
    function test_liquidate_dustCollateral_zeroRepayFullClose() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 100e18);
        _borrow(borrower, 5_000e6);

        // Catastrophic crash: collateral worth < 1e-6 USD total.
        _setPrice(1); // 1 wei per 1e18 units
        uint256 debt = pair.debtOf(borrower);
        assertGt(debt, 0);

        uint256 liqUsdgBefore = usdg.balanceOf(liquidator);
        vm.expectEmit(true, false, false, false, address(pair));
        emit CreditPair.BadDebtSocialized(borrower, 0, 0);
        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = pair.liquidate(borrower, type(uint256).max);

        assertEq(repaid, 0, "zero-repay close");
        assertEq(seized, 100e18, "all dust collateral to caller");
        assertEq(usdg.balanceOf(liquidator), liqUsdgBefore, "no USDG pulled");
        assertEq(pair.debtOf(borrower), 0, "debt gone");
        (uint128 sShares, uint128 bShares, uint128 coll) = pair.accounts(borrower);
        assertEq(bShares, 0);
        assertEq(coll, 0);
        sShares; // silence
        assertEq(pair.totalBorrowShares(), 0, "ledger clean");
        // The whole debt was socialized to lenders.
        assertApproxEqAbs(pair.totalSupplyAssets(), 10_000e6 - debt, 2);
        _assertSolvent();
    }

    /// I-05: cash-capped skim must not decrease the lender share price.
    function test_skim_cashCapped_sharePriceMonotonic() public {
        _deposit(lender, 10_000e6);
        _addCollateral(borrower, 200e18);
        _borrow(borrower, 8_000e6);

        // A year of accrual builds a real reserve position.
        vm.warp(block.timestamp + 365 days);
        _freshenOracle();
        pair.accrue();
        (uint128 reserveShares,,) = pair.accounts(address(pair));
        assertGt(reserveShares, 0, "reserve exists");

        // Drain cash below the reserve entitlement so the skim is cash-capped.
        uint256 reserveAssets = pair.supplyBalanceOf(address(pair));
        uint256 cash = pair.availableLiquidity();
        // Convert the target asset pull into shares (shares are 1000x-scaled).
        uint256 pullShares = (cash - reserveAssets / 3) * uint256(pair.totalSupplyShares())
            / uint256(pair.totalSupplyAssets());
        vm.prank(lender);
        pair.withdraw(pullShares);
        assertGt(reserveAssets, pair.availableLiquidity(), "skim must be cash-capped");

        // Lender share price before (assets per 1e6 shares, scaled).
        uint256 pxBefore = pair.supplyBalanceOf(lender);
        pair.skimReserves();
        uint256 pxAfter = pair.supplyBalanceOf(lender);
        assertGe(pxAfter, pxBefore, "share price monotonic across skim");
        _assertSolvent();
    }

    /// I-04: factory refuses mis-decimal collateral and USDG-as-collateral.
    function test_factory_rejectsBadCollateral() public {
        MockERC20 sixDec = new MockERC20("USD Tether", "USDT", 6);
        oracle.setAnchor(address(sixDec), 1e18, block.timestamp);
        vm.expectRevert(CreditFactory.BadCollateral.selector);
        factory.deployPair({
            collateral: address(sixDec),
            ltvBps: 6000, liqThresholdBps: 7000, liqBonusBps: 800,
            borrowCap: BORROW_CAP, supplyCap: SUPPLY_CAP, maxPriceAge: MAX_AGE,
            optimalUtilizationRay: 0.8e27, baseRateRay: 0,
            slope1Ray: 0.08e27, slope2Ray: 0.72e27
        });

        vm.expectRevert(CreditFactory.BadCollateral.selector);
        factory.deployPair({
            collateral: address(usdg),
            ltvBps: 6000, liqThresholdBps: 7000, liqBonusBps: 800,
            borrowCap: BORROW_CAP, supplyCap: SUPPLY_CAP, maxPriceAge: MAX_AGE,
            optimalUtilizationRay: 0.8e27, baseRateRay: 0,
            slope1Ray: 0.08e27, slope2Ray: 0.72e27
        });
    }

    /// L-01: constructor floor — a price-age below the feed's worst-case
    /// quiet stretch is a liveness hazard and must not be deployable.
    function test_constructor_priceAgeFloor() public {
        MockERC20 t = new MockERC20("Test", "TST", 18);
        oracle.setAnchor(address(t), 100e18, block.timestamp);
        vm.expectRevert(bytes("PRICE_AGE"));
        factory.deployPair({
            collateral: address(t),
            ltvBps: 6000, liqThresholdBps: 7000, liqBonusBps: 800,
            borrowCap: BORROW_CAP, supplyCap: SUPPLY_CAP, maxPriceAge: 23 hours,
            optimalUtilizationRay: 0.8e27, baseRateRay: 0,
            slope1Ray: 0.08e27, slope2Ray: 0.72e27
        });
    }
}
