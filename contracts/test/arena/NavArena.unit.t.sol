// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArenaBase, MockChainlinkFeed} from "./ArenaBase.t.sol";
import {NavArena} from "../../src/arena/NavArena.sol";

/// @dev Unit coverage: every lifecycle transition, every revert path, exact fee
///      and payout arithmetic against hand-computed values.
contract NavArenaUnitTest is ArenaBase {
    /*//////////////////////////////////////////////////////////////////////
                                  CREATE BOUT
    //////////////////////////////////////////////////////////////////////*/

    function test_create_storesConfig() public {
        uint256 id = _createDefault();
        NavArena.Bout memory b = arena.getBout(id);
        assertEq(b.assetA, address(nvda));
        assertEq(b.assetB, address(tsla));
        assertEq(b.entryClose, entryClose);
        assertEq(b.settleTime, settleTime);
        assertEq(uint8(b.state), uint8(NavArena.State.Open));
        assertEq(arena.nextBoutId(), 1);
    }

    function test_create_revert_sameAsset() public {
        vm.expectRevert(NavArena.BadAssets.selector);
        arena.createBout(address(nvda), address(nvda), entryClose, settleTime);
    }

    function test_create_revert_zeroAsset() public {
        vm.expectRevert(NavArena.BadAssets.selector);
        arena.createBout(address(0), address(tsla), entryClose, settleTime);
        vm.expectRevert(NavArena.BadAssets.selector);
        arena.createBout(address(nvda), address(0), entryClose, settleTime);
    }

    function test_create_revert_entryTooSoon() public {
        vm.expectRevert(NavArena.BadWindow.selector);
        arena.createBout(address(nvda), address(tsla), uint64(block.timestamp + 1 hours - 1), settleTime);
    }

    function test_create_revert_entryTooFar() public {
        vm.expectRevert(NavArena.BadWindow.selector);
        arena.createBout(address(nvda), address(tsla), uint64(block.timestamp + 7 days + 1), settleTime);
    }

    function test_create_revert_windowTooShort() public {
        vm.expectRevert(NavArena.BadWindow.selector);
        arena.createBout(address(nvda), address(tsla), entryClose, entryClose + 1 hours - 1);
    }

    function test_create_revert_windowTooLong() public {
        vm.expectRevert(NavArena.BadWindow.selector);
        arena.createBout(address(nvda), address(tsla), entryClose, entryClose + 30 days + 1);
    }

    function test_create_boundaryWindows_ok() public {
        // Exact minimums and maximums are inclusive.
        uint64 ec = uint64(block.timestamp + 1 hours);
        arena.createBout(address(nvda), address(tsla), ec, ec + 1 hours);
        uint64 ec2 = uint64(block.timestamp + 7 days);
        arena.createBout(address(nvda), address(tsla), ec2, ec2 + 30 days);
    }

    function test_create_revert_unknownMarket() public {
        MockRevertProbe probe = new MockRevertProbe();
        oracle.setQuoteReverts(address(nvda), true);
        vm.expectRevert(); // oracle's own MarketUnknown bubbles
        arena.createBout(address(nvda), address(tsla), entryClose, settleTime);
        probe; // silence unused warning
    }

    function test_create_revert_zeroQuote() public {
        oracle.setQuote(address(tsla), 0);
        vm.expectRevert(NavArena.OracleDead.selector);
        arena.createBout(address(nvda), address(tsla), entryClose, settleTime);
    }

    /*//////////////////////////////////////////////////////////////////////
                                     STAKE
    //////////////////////////////////////////////////////////////////////*/

    function test_stake_accumulatesBothSides() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, alice, true, 50e6);
        _stake(id, bob, false, 30e6);
        NavArena.Bout memory b = arena.getBout(id);
        assertEq(b.potA, 150e6);
        assertEq(b.potB, 30e6);
        assertEq(arena.stakeA(id, alice), 150e6);
        assertEq(arena.stakeB(id, bob), 30e6);
        assertEq(usdg.balanceOf(address(arena)), 180e6);
    }

    function test_stake_revert_afterEntryClose() public {
        uint256 id = _createDefault();
        vm.warp(entryClose);
        vm.expectRevert(NavArena.TooLate.selector);
        vm.prank(alice);
        arena.stake(id, true, 100e6);
    }

    function test_stake_revert_belowMin() public {
        uint256 id = _createDefault();
        vm.expectRevert(NavArena.StakeTooSmall.selector);
        vm.prank(alice);
        arena.stake(id, true, 1e6 - 1);
    }

    function test_stake_revert_nonexistentBout() public {
        vm.expectRevert(NavArena.BadState.selector);
        vm.prank(alice);
        arena.stake(42, true, 100e6);
    }

    function test_stake_revert_afterLock() public {
        uint256 id = _lockedBout(100e6, 100e6);
        vm.expectRevert(NavArena.BadState.selector);
        vm.prank(carol);
        arena.stake(id, true, 100e6);
    }

    /*//////////////////////////////////////////////////////////////////////
                                      LOCK
    //////////////////////////////////////////////////////////////////////*/

    function test_lock_revert_beforeEntryClose() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        vm.expectRevert(NavArena.TooEarly.selector);
        arena.lock(id);
    }

    function test_lock_voidsOneSided() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        vm.warp(entryClose);
        arena.lock(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
    }

    function test_lock_voidsEmpty() public {
        uint256 id = _createDefault();
        vm.warp(entryClose);
        arena.lock(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
    }

    function test_lock_snapsStartPrices() public {
        uint256 id = _lockedBout(100e6, 100e6);
        NavArena.Bout memory b = arena.getBout(id);
        assertEq(b.startA, 200e18);
        assertEq(b.startB, 400e18);
        assertEq(uint8(b.state), uint8(NavArena.State.Locked));
    }

    function test_lock_usesExistingSnapshot() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        // Options venue already snapped this expiry — arena must reuse it.
        oracle.forceSettlement(address(nvda), entryClose, 199e18);
        oracle.setPyth(address(nvda), entryClose, 199e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(entryClose);
        arena.lock(id);
        assertEq(arena.getBout(id).startA, 199e18);
    }

    function test_lock_revert_anchorPending() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        vm.warp(entryClose);
        vm.expectRevert(); // AnchorPending bubbles from the oracle
        arena.lock(id);
    }

    function test_lock_revert_twice() public {
        uint256 id = _lockedBout(100e6, 100e6);
        vm.expectRevert(NavArena.BadState.selector);
        arena.lock(id);
    }

    /*//////////////////////////////////////////////////////////////////////
                                     SETTLE
    //////////////////////////////////////////////////////////////////////*/

    function test_settle_revert_beforeSettleTime() public {
        uint256 id = _lockedBout(100e6, 100e6);
        vm.expectRevert(NavArena.TooEarly.selector);
        arena.settle(id);
    }

    function test_settle_aWins_exactFeeMath() public {
        uint256 id = _lockedBout(300e6, 700e6);
        uint256 accumBefore = usdg.balanceOf(ACCUM);
        uint256 settlerBefore = usdg.balanceOf(settler);

        _settleAWins(id);

        NavArena.Bout memory b = arena.getBout(id);
        assertEq(b.winner, 1);
        assertEq(uint8(b.state), uint8(NavArena.State.Settled));
        // fee = 2% of losing pot (700) = 14 USDG; bounty = 10% of fee = 1.4.
        assertEq(usdg.balanceOf(settler) - settlerBefore, 1.4e6);
        assertEq(usdg.balanceOf(ACCUM) - accumBefore, 12.6e6);
    }

    function test_settle_bWins() public {
        uint256 id = _lockedBout(300e6, 700e6);
        // A -10%, B +10%.
        _setFreshAnchor(address(nvda), settleTime, 180e18);
        _setFreshAnchor(address(tsla), settleTime, 440e18);
        vm.warp(settleTime);
        arena.settle(id);
        assertEq(arena.getBout(id).winner, 2);
    }

    function test_settle_dollarNeutral_relativeOnly() public {
        // Both crash, but A crashes less: A must still win.
        uint256 id = _lockedBout(500e6, 500e6);
        _setFreshAnchor(address(nvda), settleTime, 150e18); // -25%
        _setFreshAnchor(address(tsla), settleTime, 240e18); // -40%
        vm.warp(settleTime);
        arena.settle(id);
        assertEq(arena.getBout(id).winner, 1);
    }

    function test_settle_exactDraw_voids() public {
        uint256 id = _lockedBout(100e6, 100e6);
        // Both exactly +5%.
        _setFreshAnchor(address(nvda), settleTime, 210e18);
        _setFreshAnchor(address(tsla), settleTime, 420e18);
        vm.warp(settleTime);
        arena.settle(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
        // No fee moved.
        assertEq(usdg.balanceOf(ACCUM), 0);
    }

    function test_settle_revert_notLocked() public {
        uint256 id = _createDefault();
        vm.warp(settleTime);
        vm.expectRevert(NavArena.BadState.selector);
        arena.settle(id);
    }

    function test_settle_revert_twice() public {
        uint256 id = _lockedBout(100e6, 100e6);
        _settleAWins(id);
        vm.expectRevert(NavArena.BadState.selector);
        arena.settle(id);
    }

    /*//////////////////////////////////////////////////////////////////////
                                      VOID
    //////////////////////////////////////////////////////////////////////*/

    function test_void_lockOverdue() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        // No anchor ever arrives.
        vm.warp(uint256(entryClose) + RES_WINDOW + 1);
        arena.voidBout(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
    }

    function test_void_settleOverdue() public {
        uint256 id = _lockedBout(100e6, 100e6);
        vm.warp(uint256(settleTime) + RES_WINDOW + 1);
        arena.voidBout(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
    }

    function test_void_revert_tooEarly() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        vm.warp(uint256(entryClose) + RES_WINDOW); // not strictly greater
        vm.expectRevert(NavArena.TooEarly.selector);
        arena.voidBout(id);
    }

    /// @dev The lock and void windows are disjoint: at exactly entryClose+24h
    ///      lock still works and void doesn't; one second later they flip.
    function test_void_lock_windows_disjoint() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        _setFreshAnchor(address(nvda), entryClose, 200e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);

        vm.warp(uint256(entryClose) + RES_WINDOW);
        vm.expectRevert(NavArena.TooEarly.selector);
        arena.voidBout(id);
        arena.lock(id); // boundary: still inside the lock window
        assertEq(uint8(_state(id)), uint8(NavArena.State.Locked));

        uint256 id2 = arena.createBout(address(nvda), address(tsla), settleTime, settleTime + 1 days);
        vm.warp(uint256(settleTime) + RES_WINDOW + 1);
        vm.expectRevert(NavArena.TooLate.selector);
        arena.lock(id2);
        arena.voidBout(id2);
        assertEq(uint8(_state(id2)), uint8(NavArena.State.Voided));
    }

    function test_void_revert_settledBout() public {
        uint256 id = _lockedBout(100e6, 100e6);
        _settleAWins(id);
        vm.warp(uint256(settleTime) + 30 days);
        vm.expectRevert(NavArena.TooEarly.selector);
        arena.voidBout(id);
    }

    function test_void_revert_nonexistent() public {
        vm.expectRevert(NavArena.BadState.selector);
        arena.voidBout(99);
    }

    /*//////////////////////////////////////////////////////////////////////
                                     CLAIM
    //////////////////////////////////////////////////////////////////////*/

    function test_claim_winnerExactPayout() public {
        // A pot 300 (alice 100, carol 200), B pot 700 (bob). A wins.
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, carol, true, 200e6);
        _stake(id, bob, false, 700e6);
        _setFreshAnchor(address(nvda), entryClose, 200e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(entryClose);
        arena.lock(id);
        _settleAWins(id);

        // net losing = 700 - 14 = 686. alice: 100 + 686*100/300 = 328.666666
        uint256 aliceBefore = usdg.balanceOf(alice);
        vm.prank(alice);
        arena.claim(id);
        assertEq(usdg.balanceOf(alice) - aliceBefore, 100e6 + uint256(686e6) * 100e6 / 300e6);

        uint256 carolBefore = usdg.balanceOf(carol);
        vm.prank(carol);
        arena.claim(id);
        assertEq(usdg.balanceOf(carol) - carolBefore, 200e6 + uint256(686e6) * 200e6 / 300e6);

        // Contract retains only division dust after all claims + fee.
        assertLe(usdg.balanceOf(address(arena)), 2);
    }

    /// @dev Losers close out with an explicit zero payout (Claimed(0)), so
    ///      frontends and indexers see the position resolved; a second claim
    ///      then reverts.
    function test_claim_loser_zeroPayoutCloseout() public {
        uint256 id = _lockedBout(100e6, 100e6);
        _settleAWins(id);
        uint256 before = usdg.balanceOf(bob);
        vm.expectEmit(true, true, false, true);
        emit NavArena.Claimed(id, bob, 0);
        vm.prank(bob);
        arena.claim(id);
        assertEq(usdg.balanceOf(bob), before, "loser gets nothing");
        assertEq(arena.stakeB(id, bob), 0, "losing stake zeroed");
        vm.expectRevert(NavArena.NothingToClaim.selector);
        vm.prank(bob);
        arena.claim(id);
    }

    function test_claim_voided_refundsBothSides() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, alice, false, 40e6); // alice on both sides
        _stake(id, bob, false, 60e6);
        vm.warp(uint256(entryClose) + RES_WINDOW + 1);
        arena.voidBout(id);

        uint256 aliceBefore = usdg.balanceOf(alice);
        vm.prank(alice);
        arena.claim(id);
        assertEq(usdg.balanceOf(alice) - aliceBefore, 140e6);

        uint256 bobBefore = usdg.balanceOf(bob);
        vm.prank(bob);
        arena.claim(id);
        assertEq(usdg.balanceOf(bob) - bobBefore, 60e6);
        assertEq(usdg.balanceOf(address(arena)), 0);
    }

    function test_claim_revert_double() public {
        uint256 id = _lockedBout(100e6, 100e6);
        _settleAWins(id);
        vm.prank(alice);
        arena.claim(id);
        vm.expectRevert(NavArena.NothingToClaim.selector);
        vm.prank(alice);
        arena.claim(id);
    }

    function test_claim_revert_whileOpen() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        vm.expectRevert(NavArena.BadState.selector);
        vm.prank(alice);
        arena.claim(id);
    }

    function test_claim_revert_whileLocked() public {
        uint256 id = _lockedBout(100e6, 100e6);
        vm.expectRevert(NavArena.BadState.selector);
        vm.prank(alice);
        arena.claim(id);
    }

    function test_claim_nonStaker_reverts() public {
        uint256 id = _lockedBout(100e6, 100e6);
        _settleAWins(id);
        vm.expectRevert(NavArena.NothingToClaim.selector);
        vm.prank(carol);
        arena.claim(id);
    }

    /*//////////////////////////////////////////////////////////////////////
                                     VIEWS
    //////////////////////////////////////////////////////////////////////*/

    function test_preview_tracksQuotes() public {
        uint256 id = _lockedBout(100e6, 100e6);
        oracle.setQuote(address(nvda), 220e18); // +10%
        oracle.setQuote(address(tsla), 380e18); // -5%
        (uint256 pA, uint256 pB) = arena.preview(id);
        assertEq(pA, 1.1e18);
        assertEq(pB, 0.95e18);
    }

    function test_preview_revert_notLocked() public {
        uint256 id = _createDefault();
        vm.expectRevert(NavArena.BadState.selector);
        arena.preview(id);
    }

    /*//////////////////////////////////////////////////////////////////////
                        ANTI-SNIPING & HARD DEADLINES (v2)
    //////////////////////////////////////////////////////////////////////*/

    function test_stake_revert_insideBuffer() public {
        uint256 id = _createDefault();
        vm.warp(uint256(entryClose) - BUFFER); // ts + BUFFER == entryClose
        vm.expectRevert(NavArena.TooLate.selector);
        vm.prank(alice);
        arena.stake(id, true, 100e6);
    }

    function test_stake_ok_justBeforeBuffer() public {
        uint256 id = _createDefault();
        vm.warp(uint256(entryClose) - BUFFER - 1);
        vm.prank(alice);
        arena.stake(id, true, 100e6);
        assertEq(arena.stakeA(id, alice), 100e6);
    }

    function test_stake_revert_overflow() public {
        uint256 id = _createDefault();
        usdg.mint(alice, type(uint256).max / 2);
        vm.expectRevert(NavArena.StakeOverflow.selector);
        vm.prank(alice);
        arena.stake(id, true, uint256(type(uint128).max) + 1);
    }

    function test_lock_revert_afterDeadline() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        _setFreshAnchor(address(nvda), entryClose, 200e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(uint256(entryClose) + RES_WINDOW + 1);
        vm.expectRevert(NavArena.TooLate.selector);
        arena.lock(id);
    }

    function test_settle_revert_afterDeadline() public {
        uint256 id = _lockedBout(100e6, 100e6);
        _setFreshAnchor(address(nvda), settleTime, 220e18);
        _setFreshAnchor(address(tsla), settleTime, 360e18);
        vm.warp(uint256(settleTime) + RES_WINDOW + 1);
        vm.expectRevert(NavArena.TooLate.selector);
        arena.settle(id);
    }

    function test_settle_ok_atDeadlineBoundary() public {
        uint256 id = _lockedBout(100e6, 100e6);
        _setFreshAnchor(address(nvda), settleTime, 220e18);
        _setFreshAnchor(address(tsla), settleTime, 360e18);
        vm.warp(uint256(settleTime) + RES_WINDOW); // inclusive boundary
        arena.settle(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Settled));
    }

    /// @dev Snapshot exists but neither a Pyth benchmark nor any Chainlink feed
    ///      vouches for its freshness -> the bout voids instead of locking.
    function test_lock_voids_staleAnchor() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        oracle.setAnchor(address(nvda), entryClose, 200e18); // no pyth, no feed
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(entryClose);
        vm.expectEmit(true, false, false, true);
        emit NavArena.Voided(id, "stale-anchor");
        arena.lock(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
    }

    /// @dev A Pyth benchmark that does NOT match the stored snapshot (i.e. the
    ///      snapshot came from something else) cannot vouch for freshness.
    function test_lock_voids_pythMismatch() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        oracle.forceSettlement(address(nvda), entryClose, 205e18); // snapshot != pyth
        oracle.setPyth(address(nvda), entryClose, 200e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(entryClose);
        arena.lock(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
    }

    /// @dev Freshness via the Chainlink path: bracket round within 30 minutes.
    function test_lock_freshViaChainlink() public {
        MockChainlinkFeed feedA = new MockChainlinkFeed();
        MockChainlinkFeed feedB = new MockChainlinkFeed();
        oracle.setMarket(address(nvda), address(0x9001), address(feedA), bytes32(uint256(1)), false, 200, 500);
        oracle.setMarket(address(tsla), address(0x9002), address(feedB), bytes32(uint256(2)), false, 200, 500);

        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        // Rounds 10 min before entryClose, later rounds after it.
        feedA.pushRound(200e8, uint256(entryClose) - 10 minutes);
        feedA.pushRound(201e8, uint256(entryClose) + 5 minutes);
        feedB.pushRound(400e8, uint256(entryClose) - 3 minutes);
        feedB.pushRound(401e8, uint256(entryClose) + 2 minutes);
        oracle.setAnchor(address(nvda), entryClose, 200e18); // no pyth
        oracle.setAnchor(address(tsla), entryClose, 400e18);
        vm.warp(uint256(entryClose) + 10 minutes);
        arena.lock(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Locked));
    }

    /// @dev Chainlink bracket round older than 30 minutes -> stale, void.
    function test_lock_voids_staleChainlink() public {
        MockChainlinkFeed feedA = new MockChainlinkFeed();
        oracle.setMarket(address(nvda), address(0x9001), address(feedA), bytes32(uint256(1)), false, 200, 500);

        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        // Friday close: last round 31 minutes before entryClose.
        feedA.pushRound(200e8, uint256(entryClose) - 31 minutes);
        feedA.pushRound(201e8, uint256(entryClose) + 4 hours);
        oracle.setAnchor(address(nvda), entryClose, 200e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(uint256(entryClose) + 5 hours);
        vm.expectEmit(true, false, false, true);
        emit NavArena.Voided(id, "stale-anchor");
        arena.lock(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
    }

    /// @dev Oracle owner repoints a market between create and lock -> void.
    function test_lock_voids_configChanged() public {
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        oracle.setMarket(address(nvda), address(0xBAD), address(0), bytes32(0), false, 0, 0);
        _setFreshAnchor(address(nvda), entryClose, 200e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(entryClose);
        vm.expectEmit(true, false, false, true);
        emit NavArena.Voided(id, "config-changed");
        arena.lock(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
    }

    /// @dev Config change between lock and settle -> void with full refunds.
    function test_settle_voids_configChanged() public {
        uint256 id = _lockedBout(100e6, 100e6);
        oracle.setMarket(address(tsla), address(0xBAD), address(0), bytes32(0), false, 0, 0);
        _setFreshAnchor(address(nvda), settleTime, 220e18);
        _setFreshAnchor(address(tsla), settleTime, 360e18);
        vm.warp(settleTime);
        vm.expectEmit(true, false, false, true);
        emit NavArena.Voided(id, "config-changed");
        arena.settle(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
        // Both sides refund in full.
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        arena.claim(id);
        assertEq(usdg.balanceOf(alice) - before, 100e6);
    }
    /*//////////////////////////////////////////////////////////////////////
              V3: PRICE CONSISTENCY + SETTLE-TIME CONTEMPORANEITY
    //////////////////////////////////////////////////////////////////////*/

    /// @dev A snapshot poisoned via a transient feed-repoint sandwich cannot
    ///      match the pinned feed's genuine print -> void, not settle (F-1).
    function test_lock_voids_poisonedSnapMismatchesChainlink() public {
        MockChainlinkFeed feedA = new MockChainlinkFeed();
        MockChainlinkFeed feedB = new MockChainlinkFeed();
        oracle.setMarket(address(nvda), address(0x9001), address(feedA), bytes32(uint256(1)), false, 200, 500);
        oracle.setMarket(address(tsla), address(0x9002), address(feedB), bytes32(uint256(2)), false, 200, 500);
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        // Genuine feed printed $200 / $400 around entryClose...
        feedA.pushRound(200e8, uint256(entryClose) - 5 minutes);
        feedA.pushRound(201e8, uint256(entryClose) + 5 minutes);
        feedB.pushRound(400e8, uint256(entryClose) - 5 minutes);
        feedB.pushRound(401e8, uint256(entryClose) + 5 minutes);
        // ...but the stored snapshot was poisoned through a transient repoint
        // (config restored before lock, so the hash pin alone would pass).
        oracle.setAnchor(address(nvda), entryClose, 999e18); // no matching pyth
        oracle.setAnchor(address(tsla), entryClose, 400e18);
        vm.warp(uint256(entryClose) + 10 minutes);
        vm.expectEmit(true, false, false, true);
        emit NavArena.Voided(id, "stale-anchor");
        arena.lock(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
    }

    /// @dev End anchors with no contemporaneous source void at settle (F-2).
    function test_settle_voids_staleEndAnchor() public {
        uint256 id = _lockedBout(100e6, 100e6);
        oracle.setAnchor(address(nvda), settleTime, 220e18); // no pyth, no feed
        oracle.setAnchor(address(tsla), settleTime, 360e18);
        vm.warp(settleTime);
        vm.expectEmit(true, false, false, true);
        emit NavArena.Voided(id, "stale-anchor");
        vm.prank(settler);
        arena.settle(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
    }

    /// @dev The sandwich defence also holds on the settle leg (F-1 at settle).
    function test_settle_voids_poisonedEndSnap() public {
        MockChainlinkFeed feedA = new MockChainlinkFeed();
        MockChainlinkFeed feedB = new MockChainlinkFeed();
        oracle.setMarket(address(nvda), address(0x9001), address(feedA), bytes32(uint256(1)), false, 200, 500);
        oracle.setMarket(address(tsla), address(0x9002), address(feedB), bytes32(uint256(2)), false, 200, 500);
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        _setFreshAnchor(address(nvda), entryClose, 200e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(entryClose);
        arena.lock(id);
        // Genuine end rounds print $220 / $360; NVDA's stored end snap was
        // poisoned through a transient repoint sandwich.
        feedA.pushRound(220e8, uint256(settleTime) - 2 minutes);
        feedA.pushRound(221e8, uint256(settleTime) + 2 minutes);
        feedB.pushRound(360e8, uint256(settleTime) - 2 minutes);
        feedB.pushRound(361e8, uint256(settleTime) + 2 minutes);
        oracle.setAnchor(address(nvda), settleTime, 999e18); // != genuine print
        oracle.setAnchor(address(tsla), settleTime, 360e18);
        vm.warp(uint256(settleTime) + 5 minutes);
        vm.expectEmit(true, false, false, true);
        emit NavArena.Voided(id, "stale-anchor");
        vm.prank(settler);
        arena.settle(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
    }

    /// @dev Settle succeeds via the Chainlink path when the stored end snaps
    ///      equal the pinned feed's own bracket prints.
    function test_settle_freshViaChainlink() public {
        MockChainlinkFeed feedA = new MockChainlinkFeed();
        MockChainlinkFeed feedB = new MockChainlinkFeed();
        oracle.setMarket(address(nvda), address(0x9001), address(feedA), bytes32(uint256(1)), false, 200, 500);
        oracle.setMarket(address(tsla), address(0x9002), address(feedB), bytes32(uint256(2)), false, 200, 500);
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 700e6);
        _setFreshAnchor(address(nvda), entryClose, 200e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(entryClose);
        arena.lock(id);
        feedA.pushRound(220e8, uint256(settleTime) - 2 minutes); // +10%
        feedA.pushRound(221e8, uint256(settleTime) + 2 minutes);
        feedB.pushRound(360e8, uint256(settleTime) - 2 minutes); // -10%
        feedB.pushRound(361e8, uint256(settleTime) + 2 minutes);
        oracle.setAnchor(address(nvda), settleTime, 220e18); // == genuine print
        oracle.setAnchor(address(tsla), settleTime, 360e18);
        vm.warp(uint256(settleTime) + 5 minutes);
        vm.prank(settler);
        arena.settle(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Settled));
        assertEq(arena.getBout(id).winner, 1);
    }
}

/// @dev Trivial deploy probe used by test_create_revert_unknownMarket.
contract MockRevertProbe {}
