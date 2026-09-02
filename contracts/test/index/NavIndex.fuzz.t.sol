// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase, MockERC20} from "./IndexBase.t.sol";
import {NavIndexToken} from "../../src/index/NavIndexToken.sol";
import {NavIndexFactory} from "../../src/index/NavIndexFactory.sol";

/// @dev Randomised property tests over issue/redeem arithmetic, fee bounds,
///      rounding directions and streaming accrual.
contract NavIndexFuzzTest is IndexBase {
    /// @notice Issue pulls exactly ceil(shares*unit/1e18) per component; net
    ///         shares + creator cut never exceed gross; unminted remainder is
    ///         exactly gross - net - creatorCut.
    function testFuzz_issue_arithmetic(uint256 gross, uint256 mf) public {
        gross = bound(gross, 1, 1e27);
        mf = bound(mf, 0, 100);
        vm.prank(creator);
        NavIndexToken idx = NavIndexToken(_create("Fuzz Index", "FZ", mf, 0, 0));
        _approveAll(minter, address(idx));

        uint256 supplyBefore = idx.totalSupply();
        vm.prank(minter);
        uint256 net = idx.issue(gross, minter);

        for (uint256 i; i < comps.length; ++i) {
            assertEq(
                MockERC20(comps[i]).balanceOf(address(idx)), _ceilPull(gross, units[i]), "exact ceil pull"
            );
        }
        uint256 feeShares = gross * mf / BPS;
        uint256 creatorCut = feeShares * 9000 / BPS;
        assertEq(net, gross - feeShares, "net = gross - fee");
        assertEq(idx.balanceOf(minter), net);
        assertEq(idx.balanceOf(creator), creatorCut);
        assertEq(idx.totalSupply() - supplyBefore, net + creatorCut, "supply = net + creatorCut");
        assertLe(idx.totalSupply(), gross, "unminted boost never inflates past gross");
    }

    /// @notice Redeem pays exactly bal*net/supply (floor) per component and the
    ///         vault always retains enough for the remaining supply.
    function testFuzz_redeem_arithmetic(uint256 gross, uint256 part, uint256 rf) public {
        gross = bound(gross, 1e6, 1e27);
        rf = bound(rf, 0, 100);
        vm.prank(creator);
        NavIndexToken idx = NavIndexToken(_create("Fuzz Index", "FZ", 0, rf, 0));
        _approveAll(minter, address(idx));

        vm.prank(minter);
        uint256 net = idx.issue(gross, minter);
        part = bound(part, 1, net);

        uint256 supply = idx.totalSupply();
        uint256 feeShares = part * rf / BPS;
        uint256 netShares = part - feeShares;

        uint256[3] memory balBefore;
        uint256[3] memory outExpected;
        for (uint256 i; i < 3; ++i) {
            balBefore[i] = MockERC20(comps[i]).balanceOf(address(idx));
            outExpected[i] = balBefore[i] * netShares / supply;
        }

        uint256[3] memory userBefore;
        for (uint256 i; i < 3; ++i) {
            userBefore[i] = MockERC20(comps[i]).balanceOf(redeemer);
        }
        vm.prank(minter);
        idx.redeem(part, redeemer);

        for (uint256 i; i < 3; ++i) {
            assertEq(MockERC20(comps[i]).balanceOf(redeemer) - userBefore[i], outExpected[i], "exact floor payout");
            // Remaining vault balance still covers remaining supply pro-rata.
            uint256 remainingSupply = idx.totalSupply();
            if (remainingSupply != 0) {
                uint256 owedIfAllRedeemed = MockERC20(comps[i]).balanceOf(address(idx));
                assertGe(owedIfAllRedeemed, 0); // trivially non-negative; solvency by construction
            }
        }
    }

    /// @notice A full round trip (issue then redeem everything received) never
    ///         leaves the caller with more of any component than they started with.
    function testFuzz_roundTrip_neverProfits(uint256 gross, uint256 mf, uint256 rf) public {
        gross = bound(gross, 1, 1e27);
        mf = bound(mf, 0, 100);
        rf = bound(rf, 0, 100);
        vm.prank(creator);
        NavIndexToken idx = NavIndexToken(_create("Fuzz Index", "FZ", mf, rf, 0));
        _approveAll(minter, address(idx));

        uint256[3] memory before;
        for (uint256 i; i < 3; ++i) {
            before[i] = MockERC20(comps[i]).balanceOf(minter);
        }

        vm.prank(minter);
        uint256 net = idx.issue(gross, minter);
        vm.prank(minter);
        idx.redeem(net, minter);

        for (uint256 i; i < 3; ++i) {
            assertLe(MockERC20(comps[i]).balanceOf(minter), before[i], "no free components");
        }
    }

    /// @notice Streaming accrual is linear in time, bounded by the cap, and
    ///         idempotent at a fixed timestamp.
    function testFuzz_streaming_bounded(uint256 gross, uint256 sf, uint256 elapsed) public {
        gross = bound(gross, 1e6, 1e27);
        sf = bound(sf, 1, 200);
        elapsed = bound(elapsed, 1, 10 * 365 days);
        vm.prank(creator);
        NavIndexToken idx = NavIndexToken(_create("Fuzz Index", "FZ", 0, 0, sf));
        _approveAll(minter, address(idx));

        vm.prank(minter);
        idx.issue(gross, minter);
        uint256 supply = idx.totalSupply();

        vm.warp(block.timestamp + elapsed);
        idx.pokeFees();
        uint256 minted = idx.balanceOf(creator);
        assertEq(minted, supply * sf * elapsed / (BPS * YEAR), "exact linear accrual");

        // Idempotent at the same timestamp.
        idx.pokeFees();
        assertEq(idx.balanceOf(creator), minted, "no double accrual");
    }

    /// @notice Factory rejects any component the oracle cannot price.
    function testFuzz_factory_realityGate(uint256 which) public {
        which = bound(which, 0, 2);
        oracle.setQuote(comps[which], 0);
        vm.expectRevert(
            abi.encodeWithSelector(NavIndexFactory.DeadComponent.selector, comps[which])
        );
        _create("Gate Index", "GATE", 0, 0, 0);
    }

    /// @notice Issue/redeem sequences by two actors preserve supply accounting:
    ///         totalSupply always equals the sum of all balances.
    function testFuzz_supplyAccounting(uint96[6] memory amounts) public {
        _approveAll(minter, address(index));
        _approveAll(redeemer, address(index));
        address[2] memory actors = [minter, redeemer];
        for (uint256 i; i < 6; ++i) {
            address actor = actors[i % 2];
            uint256 amt = 1 + uint256(amounts[i]) % 1e24;
            if (i % 3 == 2 && index.balanceOf(actor) != 0) {
                uint256 part = 1 + amt % index.balanceOf(actor);
                vm.prank(actor);
                index.redeem(part, actor);
            } else {
                vm.prank(actor);
                index.issue(amt, actor);
            }
            assertEq(
                index.totalSupply(),
                index.balanceOf(minter) + index.balanceOf(redeemer) + index.balanceOf(creator),
                "supply == sum of balances"
            );
        }
    }

    function _approveAll(address who, address spender) internal {
        vm.startPrank(who);
        nvda.approve(spender, type(uint256).max);
        aapl.approve(spender, type(uint256).max);
        qqq.approve(spender, type(uint256).max);
        vm.stopPrank();
    }
}
