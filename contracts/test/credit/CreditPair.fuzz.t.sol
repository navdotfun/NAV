// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CreditBase} from "./CreditBase.t.sol";
import {CreditPair} from "../../src/credit/CreditPair.sol";

/// @dev Property fuzz campaign. Run deep with `FOUNDRY_PROFILE=deep forge test`.
contract CreditPairFuzzTest is CreditBase {
    /*//////////////////////////////////////////////////////////////////////
                              DEPOSIT / WITHDRAW
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Round-tripping a deposit never returns more than was put in.
    function testFuzz_depositWithdraw_neverProfits(uint256 amount) public {
        amount = bound(amount, 1, SUPPLY_CAP);
        vm.startPrank(lender);
        pair.deposit(amount);
        uint256 out = pair.withdraw(type(uint256).max);
        vm.stopPrank();
        assertLe(out, amount, "lender cannot mint value");
        assertGe(out + 2, amount, "rounding loss bounded");
        _assertSolvent();
    }

    /// @notice Two lenders splitting a pool get proportional exits.
    function testFuzz_twoLenders_proRata(uint256 a, uint256 b) public {
        a = bound(a, 1e6, SUPPLY_CAP / 2);
        b = bound(b, 1e6, SUPPLY_CAP / 2);
        address lender2 = address(0x4444);
        usdg.mint(lender2, b);
        vm.prank(lender2);
        usdg.approve(address(pair), type(uint256).max);

        _deposit(lender, a);
        vm.prank(lender2);
        pair.deposit(b);

        vm.prank(lender);
        uint256 outA = pair.withdraw(type(uint256).max);
        vm.prank(lender2);
        uint256 outB = pair.withdraw(type(uint256).max);

        assertLe(outA, a);
        assertLe(outB, b);
        assertGe(outA + 2, a);
        assertGe(outB + 2, b);
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////////////
                                    BORROW
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Whatever is borrowed, debt covers principal + exact fee and stays within LTV.
    function testFuzz_borrow_debtAccounting(uint256 collateral, uint256 borrowAmt) public {
        collateral = bound(collateral, 1e17, 1_000_000e18);
        _deposit(lender, SUPPLY_CAP);
        _addCollateral(borrower, collateral);

        // Max borrowable given LTV and fee.
        uint256 collValueUsdg = collateral * PRICE / 1e18 / 1e12;
        uint256 maxDebt = collValueUsdg * 6000 / BPS;
        uint256 maxAssets = maxDebt * BPS / (BPS + 30);
        if (maxAssets < 11e6) return; // below MIN_DEBT territory
        if (maxAssets > BORROW_CAP * BPS / (BPS + 30)) {
            maxAssets = BORROW_CAP * BPS / (BPS + 30);
        }
        uint256 cash = pair.availableLiquidity();
        if (maxAssets > cash * BPS / (BPS + 30)) maxAssets = cash * BPS / (BPS + 30);
        borrowAmt = bound(borrowAmt, 11e6, maxAssets);

        uint256 fee = _borrow(borrower, borrowAmt);
        assertEq(fee, (borrowAmt * 30 + BPS - 1) / BPS, "fee is exactly ceil(30bps)");
        assertEq(usdg.balanceOf(ACCUM), fee, "fee at accumulator");

        uint256 debt = pair.debtOf(borrower);
        assertGe(debt, borrowAmt + fee, "debt >= principal+fee");
        assertLe(debt, borrowAmt + fee + 2, "debt overshoot bounded by rounding");
        _assertSolvent();
    }

    /// @notice Borrow + immediate full repay never loses lender money.
    function testFuzz_borrowRepay_lendersWhole(uint256 borrowAmt, uint256 elapsed) public {
        _deposit(lender, 50_000e6);
        _addCollateral(borrower, 10_000e18);
        borrowAmt = bound(borrowAmt, 11e6, 40_000e6);
        elapsed = bound(elapsed, 0, 730 days);

        _borrow(borrower, borrowAmt);
        vm.warp(block.timestamp + elapsed);

        vm.prank(borrower);
        pair.repay(type(uint256).max, borrower);
        assertEq(pair.debtOf(borrower), 0);

        // Lender can now exit with at least the original deposit (interest may add more,
        // reserve shares belong to the pair, not the lender).
        vm.prank(lender);
        uint256 out = pair.withdraw(type(uint256).max);
        assertGe(out + 2, 50_000e6, "lender never loses principal");
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////////////
                                   ACCRUAL
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Accrual keeps S >= B and cash-solvency for any time jump.
    function testFuzz_accrual_solvency(uint256 borrowAmt, uint16 jumps, uint256 seed) public {
        _deposit(lender, SUPPLY_CAP);
        _addCollateral(borrower, 10_000e18);
        borrowAmt = bound(borrowAmt, 11e6, 40_000e6);
        _borrow(borrower, borrowAmt);

        jumps = uint16(bound(jumps, 1, 20));
        for (uint256 i; i < jumps; i++) {
            uint256 dt = uint256(keccak256(abi.encode(seed, i))) % 30 days;
            vm.warp(block.timestamp + dt);
            pair.accrue();
            _assertSolvent();
        }
        // Debt grew monotonically and remains repayable.
        usdg.mint(borrower, pair.debtOf(borrower));
        vm.prank(borrower);
        pair.repay(type(uint256).max, borrower);
        assertEq(pair.debtOf(borrower), 0);
        _assertSolvent();
    }

    /// @notice IRM is monotone in utilization and continuous at the kink.
    function testFuzz_irm_monotone(uint256 u1, uint256 u2) public view {
        u1 = bound(u1, 0, RAY);
        u2 = bound(u2, 0, RAY);
        if (u1 > u2) (u1, u2) = (u2, u1);
        assertLe(pair.borrowRateRay(u1), pair.borrowRateRay(u2), "monotone");
        // Continuity at kink: one-sided limits equal.
        assertEq(pair.borrowRateRay(0.8e27), 0.08e27);
        assertLe(pair.borrowRateRay(0.8e27 + 1) - pair.borrowRateRay(0.8e27), 1e13);
    }

    /*//////////////////////////////////////////////////////////////////////
                                  LIQUIDATION
    //////////////////////////////////////////////////////////////////////*/

    /// @notice For any crash depth, liquidation closes or shrinks the position,
    ///         the liquidator never pays more than debt, and the ledger stays solvent.
    function testFuzz_liquidation_anyCrash(uint256 crashPrice, uint256 repayAsk) public {
        _deposit(lender, 50_000e6);
        _addCollateral(borrower, 10e18);              // $2,000 at $200
        _borrow(borrower, 1_100e6);                   // ~55% LTV
        uint256 debt0 = pair.debtOf(borrower);

        crashPrice = bound(crashPrice, 1e15, 157e18); // $0.001 .. just under liq trigger
        _setPrice(crashPrice);
        repayAsk = bound(repayAsk, 1, type(uint128).max);

        uint256 hfNum = 10e18 * crashPrice / 1e18 * 7000 / BPS;
        if (hfNum >= debt0 * 1e12) return;            // still healthy — nothing to test

        // Mirror the contract's repay clamp. An ask whose clamped repay would
        // leave a dust remainder (0 < debt - repaid < MIN_DEBT) reverts with
        // DebtTooSmall by design (Morpho dust guard; the liquidator full-closes
        // instead) — pinned by test_liquidate_dustWindowReverts. Steer the fuzz
        // ask out of that window so this property tests the success paths.
        {
            uint256 hfWad = hfNum * 1e18 / (debt0 * 1e12);
            uint256 maxRepay = (hfWad < 0.95e18 || debt0 <= 20e6) ? debt0 : debt0 * 5000 / BPS;
            uint256 wouldRepay = repayAsk > maxRepay ? maxRepay : repayAsk;
            if (wouldRepay < debt0 && debt0 - wouldRepay < 10e6 + 2) {
                repayAsk = type(uint256).max; // full close — always permitted here
            }
        }

        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = pair.liquidate(borrower, repayAsk);

        assertLe(repaid, debt0, "never overpays");
        assertLe(seized, 10e18, "never over-seizes");
        assertLt(pair.debtOf(borrower), debt0, "debt reduced");
        // Seized value never exceeds repay * (1 + bonus) + 2 rounding units.
        // Full-close computes repaid FROM seized via three chained floors
        // (seized*px/1e18, then *BPS/(BPS+bonus), then /1e12 wad->USDG), each
        // losing <1 of its unit — worst-case slack is 2 USDG units (2e-6 USDG),
        // found by the 100k-run campaign at slack exactly 2. Direction is the
        // documented Aave debtAmountNeeded floor: the liquidator never overpays.
        uint256 seizedValueUsdg = seized * crashPrice / 1e18 / 1e12;
        assertLe(seizedValueUsdg, repaid * (BPS + 800) / BPS + 2, "bonus bounded");
        _assertSolvent();
    }

    /// @notice After a full-close with bad debt, the borrower account is zeroed and
    ///         lenders bear exactly the shortfall.
    function testFuzz_badDebt_exactSocialization(uint256 crashPrice) public {
        _deposit(lender, 50_000e6);
        _addCollateral(borrower, 10e18);
        _borrow(borrower, 1_100e6);
        uint256 debt0 = pair.debtOf(borrower);
        uint256 s0 = pair.totalSupplyAssets();

        // Crash so hard the collateral cannot cover the debt: value*(1/(1+bonus)) < debt.
        crashPrice = bound(crashPrice, 1e15, 110e18);
        _setPrice(crashPrice);

        vm.prank(liquidator);
        (uint256 repaid,) = pair.liquidate(borrower, type(uint256).max / 2);

        if (pair.debtOf(borrower) == 0) {
            (, uint128 bs, uint128 c) = pair.accounts(borrower);
            assertEq(bs, 0);
            assertEq(c, 0);
            uint256 badDebt = debt0 - repaid;
            assertEq(s0 - pair.totalSupplyAssets(), badDebt, "loss == shortfall exactly");
        }
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////////////
                                     SKIM
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Skim never sweeps more than cash, never breaks solvency, always
    ///         pays the accumulator at least 99.95% of the sweep.
    function testFuzz_skim_safe(uint256 borrowAmt, uint256 elapsed) public {
        _deposit(lender, SUPPLY_CAP);
        _addCollateral(borrower, 10_000e18);
        borrowAmt = bound(borrowAmt, 1_000e6, 40_000e6);
        elapsed = bound(elapsed, 1 days, 730 days);
        _borrow(borrower, borrowAmt);
        vm.warp(block.timestamp + elapsed);
        pair.accrue();

        (uint128 reserveShares,,) = pair.accounts(address(pair));
        if (reserveShares == 0) return;

        uint256 accumBefore = usdg.balanceOf(ACCUM);
        uint256 cash = pair.availableLiquidity();
        (uint256 swept, uint256 bounty) = pair.skimReserves();

        assertLe(swept + bounty, cash, "bounded by cash");
        assertEq(usdg.balanceOf(ACCUM) - accumBefore, swept);
        assertGe(swept * BPS, (swept + bounty) * (BPS - 5) - BPS, "bounty is 5bps");
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////////////
                                SHARE PRICING
    //////////////////////////////////////////////////////////////////////*/

    /// @notice First-depositor inflation attack is capped at dust loss for any
    ///         attack size and victim size.
    function testFuzz_inflationAttack_bounded(uint256 donation, uint256 victimAmt) public {
        donation = bound(donation, 1, 1_000_000_000e6);
        victimAmt = bound(victimAmt, 1e6, SUPPLY_CAP - 1);

        vm.prank(lender);
        pair.deposit(1);
        usdg.mint(address(pair), donation); // donation is ignored by the ledger

        vm.prank(borrower);
        uint256 shares = pair.deposit(victimAmt);
        assertGt(shares, 0, "victim always receives shares");

        vm.prank(borrower);
        uint256 out = pair.withdraw(type(uint256).max);
        assertGe(out + 2, victimAmt, "victim loss bounded to rounding dust");
    }
}
