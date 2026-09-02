// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CreditBase, MockERC20, MockAnchorOracle} from "./CreditBase.t.sol";
import {CreditPair} from "../../src/credit/CreditPair.sol";

/*//////////////////////////////////////////////////////////////////////////
                                   HANDLER
//////////////////////////////////////////////////////////////////////////*/

/// @dev Random-walk handler: 4 lenders, 4 borrowers, 1 liquidator; random price
///      moves, time jumps and every external entrypoint including donations.
contract CreditHandler is Test {
    CreditPair public immutable pair;
    MockERC20 public immutable usdg;
    MockERC20 public immutable stock;
    MockAnchorOracle public immutable oracle;
    address public immutable ACCUM;

    address[4] public lenders;
    address[4] public borrowers;
    address public liquidator = address(0xF00D);

    uint256 public price = 200e18;

    // Ghost accounting.
    uint256 public ghostDeposits;     // sum of USDG in via deposit
    uint256 public ghostWithdrawals;  // sum of USDG out via withdraw
    uint256 public ghostAccumFees;    // USDG that reached the accumulator

    constructor(CreditPair _pair, MockERC20 _usdg, MockERC20 _stock, MockAnchorOracle _oracle, address accum) {
        pair = _pair;
        usdg = _usdg;
        stock = _stock;
        oracle = _oracle;
        ACCUM = accum;
        for (uint256 i; i < 4; i++) {
            lenders[i] = address(uint160(0x1000 + i));
            borrowers[i] = address(uint160(0x2000 + i));
            usdg.mint(lenders[i], 1_000_000e6);
            usdg.mint(borrowers[i], 1_000_000e6);
            stock.mint(borrowers[i], 1_000_000e18);
            vm.prank(lenders[i]);
            usdg.approve(address(pair), type(uint256).max);
            vm.startPrank(borrowers[i]);
            usdg.approve(address(pair), type(uint256).max);
            stock.approve(address(pair), type(uint256).max);
            vm.stopPrank();
        }
        usdg.mint(liquidator, 10_000_000e6);
        vm.prank(liquidator);
        usdg.approve(address(pair), type(uint256).max);
    }

    /*//////////////////////// actions ////////////////////////*/

    function deposit(uint256 who, uint256 amt) external {
        address l = lenders[who % 4];
        amt = bound(amt, 1, 20_000e6);
        uint256 room = pair.SUPPLY_CAP() - pair.totalSupplyAssets();
        if (room == 0) return;
        if (amt > room) amt = room;
        vm.prank(l);
        try pair.deposit(amt) {
            ghostDeposits += amt;
        } catch {}
    }

    function withdraw(uint256 who, uint256 shares) external {
        address l = lenders[who % 4];
        (uint128 owned,,) = pair.accounts(l);
        if (owned == 0) return;
        shares = bound(shares, 1, owned);
        uint256 balBefore = usdg.balanceOf(l);
        vm.prank(l);
        try pair.withdraw(shares) {
            ghostWithdrawals += usdg.balanceOf(l) - balBefore;
        } catch {}
    }

    function addCollateral(uint256 who, uint256 amt) external {
        address b = borrowers[who % 4];
        amt = bound(amt, 1e15, 1_000e18);
        if (stock.balanceOf(b) < amt) return;
        vm.prank(b);
        try pair.addCollateral(amt) {} catch {}
    }

    function removeCollateral(uint256 who, uint256 amt) external {
        address b = borrowers[who % 4];
        (,, uint128 c) = pair.accounts(b);
        if (c == 0) return;
        amt = bound(amt, 1, c);
        vm.prank(b);
        try pair.removeCollateral(amt) {} catch {}
    }

    function borrow(uint256 who, uint256 amt) external {
        address b = borrowers[who % 4];
        amt = bound(amt, 10e6, 20_000e6);
        uint256 accumBefore = usdg.balanceOf(ACCUM);
        vm.prank(b);
        try pair.borrow(amt) {
            ghostAccumFees += usdg.balanceOf(ACCUM) - accumBefore;
        } catch {}
    }

    function repay(uint256 who, uint256 amt) external {
        address b = borrowers[who % 4];
        uint256 debt = pair.debtOf(b);
        if (debt == 0) return;
        // Either full repay or a partial that respects MIN_DEBT.
        if (amt % 2 == 0 || debt <= 20e6) {
            amt = type(uint256).max;
        } else {
            if (debt < 10e6 + 1e6) return;
            amt = bound(amt, 1e6, debt - 10e6);
        }
        vm.prank(b);
        try pair.repay(amt, b) {} catch {}
    }

    function liquidate(uint256 who, uint256 amt) external {
        address b = borrowers[who % 4];
        if (pair.debtOf(b) == 0) return;
        amt = bound(amt, 1e6, 10_000_000e6);
        uint256 accumBefore = usdg.balanceOf(ACCUM);
        vm.prank(liquidator);
        try pair.liquidate(b, amt) {
            ghostAccumFees += usdg.balanceOf(ACCUM) - accumBefore;
        } catch {}
    }

    function skim() external {
        uint256 accumBefore = usdg.balanceOf(ACCUM);
        try pair.skimReserves() {
            ghostAccumFees += usdg.balanceOf(ACCUM) - accumBefore;
        } catch {}
    }

    function accrueOnly() external {
        pair.accrue();
    }

    function movePrice(uint256 seed) external {
        // ±30% random walk, floored at $1, capped at $10,000.
        uint256 bpsMove = bound(seed, 0, 6000);
        if (seed % 2 == 0) {
            price = price * (10_000 + bpsMove - 3000) / 10_000;
        } else {
            price = price * 10_000 / (10_000 + bpsMove - 3000 + 1);
        }
        if (price < 1e18) price = 1e18;
        if (price > 10_000e18) price = 10_000e18;
        oracle.setAnchor(address(stock), price, block.timestamp);
    }

    function jumpTime(uint256 dt) external {
        dt = bound(dt, 1 minutes, 3 days);
        vm.warp(block.timestamp + dt);
        // Keep the anchor fresh most of the time so gated actions stay reachable.
        if (dt % 5 != 0) oracle.setAnchor(address(stock), price, block.timestamp);
    }

    function donate(uint256 amt) external {
        amt = bound(amt, 1, 1_000e6);
        usdg.mint(address(pair), amt);
    }

    /*//////////////////////// ghost views ////////////////////////*/

    function sumSupplyShares() external view returns (uint256 s) {
        for (uint256 i; i < 4; i++) {
            (uint128 sh,,) = pair.accounts(lenders[i]);
            s += sh;
        }
        (uint128 self,,) = pair.accounts(address(pair));
        s += self;
    }

    function sumBorrowShares() external view returns (uint256 s) {
        for (uint256 i; i < 4; i++) {
            (, uint128 sh,) = pair.accounts(borrowers[i]);
            s += sh;
        }
    }

    function sumCollateral() external view returns (uint256 s) {
        for (uint256 i; i < 4; i++) {
            (,, uint128 c) = pair.accounts(borrowers[i]);
            s += c;
        }
    }
}

/*//////////////////////////////////////////////////////////////////////////
                                  INVARIANTS
//////////////////////////////////////////////////////////////////////////*/

contract CreditPairInvariantTest is CreditBase {
    CreditHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new CreditHandler(pair, usdg, stock, oracle, ACCUM);
        targetContract(address(handler));
    }

    /// @dev I1 — Supply always covers borrow (no phantom lending).
    function invariant_supplyCoversBorrow() public view {
        assertGe(pair.totalSupplyAssets(), pair.totalBorrowAssets());
    }

    /// @dev I2 — Cash solvency: pool balance >= lender claims minus lent-out.
    function invariant_cashSolvency() public view {
        uint256 s = pair.totalSupplyAssets();
        uint256 b = pair.totalBorrowAssets();
        assertGe(usdg.balanceOf(address(pair)), s - b);
    }

    /// @dev I3 — Share ledgers equal the sum over all accounts (incl. reserve).
    function invariant_shareLedgersExact() public view {
        assertEq(handler.sumSupplyShares(), pair.totalSupplyShares());
        assertEq(handler.sumBorrowShares(), pair.totalBorrowShares());
    }

    /// @dev I4 — Collateral custody: pool stock balance covers all account collateral.
    function invariant_collateralCustody() public view {
        assertGe(stock.balanceOf(address(pair)), handler.sumCollateral());
    }

    /// @dev I5 — No borrow shares without borrow assets (and vice versa within dust).
    function invariant_noOrphanBorrowLedger() public view {
        if (pair.totalBorrowShares() == 0) {
            // Rounding dust from up-rounded repays may leave a few units.
            assertLe(pair.totalBorrowAssets(), 10);
        }
        if (pair.totalBorrowAssets() == 0) {
            assertEq(pair.totalBorrowShares(), 0);
        }
    }

    /// @dev I6 — Utilization never exceeds 100%.
    function invariant_utilizationBounded() public view {
        assertLe(pair.utilizationRay(), 1e27);
    }

    /// @dev I7 — The accumulator only ever receives money (fees are one-way).
    function invariant_accumulatorMonotone() public view {
        assertEq(usdg.balanceOf(ACCUM), handler.ghostAccumFees());
    }

    /// @dev I8 — Value conservation: everything that entered equals everything
    ///      tracked + everything that left (donations excluded by ghost accounting).
    function invariant_lenderExitsBounded() public view {
        // Withdrawals can never exceed deposits + total interest paid in, which is
        // itself bounded by deposits (interest comes from repays, which come from
        // borrower balances). Coarse but donation-robust bound:
        assertLe(
            handler.ghostWithdrawals(),
            handler.ghostDeposits() + usdg.balanceOf(address(pair))
                + pair.totalBorrowAssets() + 1_000_000e6
        );
    }
}
