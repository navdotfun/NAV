// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArenaBase, MockChainlinkFeed} from "./ArenaBase.t.sol";
import {NavArena} from "../../src/arena/NavArena.sol";

/// @dev Audit fix-verification pass 2 — PoCs.
///
/// PoC-1 (N-1 REGRESSION — originally demonstrated the attack, now pins the
///        fix): `_anchorFresh` consults the Chainlink bracket FIRST. When a
///        fresh genuine bracket exists it is authoritative, so a poisoned
///        snapshot that entered through the oracle's Pyth path (owner
///        pythId-repoint sandwich) can no longer short-circuit on benchmark
///        equality during market hours: the bout VOIDS with a full refund
///        instead of settling on the fabricated price.
///
/// PoC-2: settle-side void solvency — a stale end anchor voids the bout and
///        refunds exactly potA + potB with zero fee/bounty outflow.
///
/// PoC-3: the CL price-consistency equality is exact to the wei — a snapshot
///        1 wei away from the pinned feed's genuine print voids.
contract AuditFixVerify2PoC is ArenaBase {
    MockChainlinkFeed internal feedA;
    MockChainlinkFeed internal feedB;

    function _wireFeeds() internal {
        feedA = new MockChainlinkFeed();
        feedB = new MockChainlinkFeed();
        oracle.setMarket(address(nvda), address(0x9001), address(feedA), bytes32(uint256(1)), false, 200, 500);
        oracle.setMarket(address(tsla), address(0x9002), address(feedB), bytes32(uint256(2)), false, 200, 500);
    }

    /// @dev PoC-1 regression. Genuine fresh CL rounds print $220 (NVDA) /
    ///      $360 (TSLA) around settleTime — market hours, bracket 2 min fresh.
    ///      The NVDA end snapshot is poisoned to $999 via the oracle's Pyth
    ///      path (owner pythId sandwich — poison lands in BOTH pythSettlement
    ///      and settlementPrice, restored config cannot un-write either).
    ///      Post-fix, the fresh genuine bracket (220e18 != 999e18) is checked
    ///      FIRST and contradicts the poison: the bout VOIDS and both sides
    ///      claim exact refunds — the sandwich steals nothing at any hour.
    function test_poc1_pythPathSandwich_voidsAgainstFreshBracket() public {
        _wireFeeds();
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6); // attacker side
        _stake(id, bob, false, 700e6); // victim side

        // Honest lock at genuine prices.
        _setFreshAnchor(address(nvda), entryClose, 200e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(entryClose);
        arena.lock(id);

        // Genuine feeds are live and fresh around settleTime (market hours).
        feedA.pushRound(220e8, uint256(settleTime) - 2 minutes);
        feedA.pushRound(221e8, uint256(settleTime) + 2 minutes);
        feedB.pushRound(360e8, uint256(settleTime) - 2 minutes);
        feedB.pushRound(361e8, uint256(settleTime) + 2 minutes);

        // Owner sandwich on the NVDA leg: the poisoned value lands in both
        // pythSettlement and settlementPrice (first-write-wins, immutable),
        // then config is restored so the hash pin passes.
        oracle.setPyth(address(nvda), settleTime, 999e18);
        oracle.setAnchor(address(nvda), settleTime, 999e18);
        // TSLA leg resolves honestly via its genuine CL print.
        oracle.setAnchor(address(tsla), settleTime, 360e18);

        vm.warp(uint256(settleTime) + 5 minutes);
        vm.prank(settler);
        arena.settle(id);

        // Post-fix: the fresh genuine bracket is authoritative — 220e18 !=
        // 999e18 fails the consistency check and the bout VOIDS. Nothing is
        // stolen; both sides recover their exact stakes, no fee, no bounty.
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided), "fresh bracket contradiction must void");
        uint256 aBefore = usdg.balanceOf(alice);
        uint256 bBefore = usdg.balanceOf(bob);
        vm.prank(alice);
        arena.claim(id);
        vm.prank(bob);
        arena.claim(id);
        assertEq(usdg.balanceOf(alice) - aBefore, 100e6, "attacker side refunded exactly");
        assertEq(usdg.balanceOf(bob) - bBefore, 700e6, "victim side refunded exactly");
        assertEq(usdg.balanceOf(address(arena)), 0, "arena fully drained by refunds");
    }

    /// @dev PoC-2. Void at settle (stale end anchor): refunds are exactly
    ///      potA + potB, no fee, no bounty, arena drains to zero.
    function test_poc2_settleVoid_exactRefund_noFee() public {
        uint256 id = _lockedBout(123e6, 456e6);
        // End snapshots exist but nothing vouches for them.
        oracle.setAnchor(address(nvda), settleTime, 220e18);
        oracle.setAnchor(address(tsla), settleTime, 360e18);
        vm.warp(settleTime);

        uint256 settlerBefore = usdg.balanceOf(settler);
        uint256 accumBefore = usdg.balanceOf(ACCUM);
        vm.prank(settler);
        arena.settle(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));
        assertEq(usdg.balanceOf(settler), settlerBefore, "no bounty on void");
        assertEq(usdg.balanceOf(ACCUM), accumBefore, "no fee on void");

        uint256 aBefore = usdg.balanceOf(alice);
        uint256 bBefore = usdg.balanceOf(bob);
        vm.prank(alice);
        arena.claim(id);
        vm.prank(bob);
        arena.claim(id);
        assertEq(usdg.balanceOf(alice) - aBefore, 123e6, "alice exact refund");
        assertEq(usdg.balanceOf(bob) - bBefore, 456e6, "bob exact refund");
        assertEq(usdg.balanceOf(address(arena)), 0, "arena fully drained");
    }

    /// @dev PoC-3. CL equality is exact: a snapshot 1 wei off the genuine
    ///      print voids; the exact value locks. (clDec = 8 <= 18, so
    ///      mulDiv(ans, 1e18, 1e8) is exact — no rounding slack exists.)
    function test_poc3_clEquality_exactToTheWei() public {
        _wireFeeds();
        int256 oddAns = 19_876_543_217; // $198.76543217, 8 dec
        uint256 genuine = uint256(oddAns) * 1e10; // mulDiv(ans, 1e18, 1e8)

        // (a) off by one wei -> void
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 100e6);
        feedA.pushRound(oddAns, uint256(entryClose) - 1 minutes);
        feedA.pushRound(oddAns + 1e4, uint256(entryClose) + 1 minutes);
        feedB.pushRound(400e8, uint256(entryClose) - 1 minutes);
        feedB.pushRound(401e8, uint256(entryClose) + 1 minutes);
        oracle.setAnchor(address(nvda), entryClose, genuine + 1);
        oracle.setAnchor(address(tsla), entryClose, 400e18);
        vm.warp(uint256(entryClose) + 5 minutes);
        arena.lock(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided), "1 wei mismatch voids");

        // (b) exact value -> locks
        uint64 ec2 = uint64(block.timestamp + 1 days);
        uint64 st2 = uint64(block.timestamp + 8 days);
        uint256 id2 = arena.createBout(address(nvda), address(tsla), ec2, st2);
        _stake(id2, alice, true, 100e6);
        _stake(id2, bob, false, 100e6);
        feedA.pushRound(oddAns, uint256(ec2) - 1 minutes);
        feedA.pushRound(oddAns + 1e4, uint256(ec2) + 1 minutes);
        feedB.pushRound(400e8, uint256(ec2) - 1 minutes);
        feedB.pushRound(401e8, uint256(ec2) + 1 minutes);
        oracle.setAnchor(address(nvda), ec2, genuine);
        oracle.setAnchor(address(tsla), ec2, 400e18);
        vm.warp(uint256(ec2) + 5 minutes);
        arena.lock(id2);
        assertEq(uint8(_state(id2)), uint8(NavArena.State.Locked), "exact print locks");
        assertEq(arena.getBout(id2).startA, genuine);
    }

    /*//////////////////////////////////////////////////////////////////////
                       PASS 3 — CL-FIRST REORDER VERIFICATION
    //////////////////////////////////////////////////////////////////////*/

    /// @dev PoC-4 (pass 3). N-1 at LOCK: pyth-poisoned start snap + fresh
    ///      genuine contradicting bracket -> voids (the authoritative CL
    ///      branch cannot be overridden by benchmark equality on either leg).
    function test_poc4_pythSandwichAtLock_voidsAgainstFreshBracket() public {
        _wireFeeds();
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 700e6);
        // Genuine fresh rounds around entryClose (market hours).
        feedA.pushRound(200e8, uint256(entryClose) - 2 minutes);
        feedA.pushRound(201e8, uint256(entryClose) + 2 minutes);
        feedB.pushRound(400e8, uint256(entryClose) - 2 minutes);
        feedB.pushRound(401e8, uint256(entryClose) + 2 minutes);
        // Owner pythId sandwich poisons the NVDA start leg through BOTH
        // pyth benchmark and settlement storage; config restored.
        oracle.setPyth(address(nvda), entryClose, 50e18);
        oracle.setAnchor(address(nvda), entryClose, 50e18);
        oracle.setAnchor(address(tsla), entryClose, 400e18);
        vm.warp(uint256(entryClose) + 5 minutes);
        vm.expectEmit(true, false, false, true);
        emit NavArena.Voided(id, "stale-anchor");
        arena.lock(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided), "poisoned start leg must void at lock");
    }

    /// @dev PoC-5 (pass 3). No false void for the legitimate off-hours Pyth
    ///      flow with a WIRED feed: the bracket at settleTime is >30 min stale
    ///      (feed halted), the snap came from the pushed Pyth benchmark and
    ///      equals it -> the fallback rail accepts and the bout SETTLES.
    function test_poc5_legitPythPath_staleWiredFeed_settles() public {
        _wireFeeds();
        uint256 id = _createDefault();
        _stake(id, alice, true, 100e6);
        _stake(id, bob, false, 700e6);
        _setFreshAnchor(address(nvda), entryClose, 200e18);
        _setFreshAnchor(address(tsla), entryClose, 400e18);
        vm.warp(entryClose);
        arena.lock(id);
        // Feeds halted: last rounds 31 minutes before settleTime; next rounds
        // only much later (so a bracket EXISTS but is stale -> CL branch is
        // correctly skipped, not authoritative).
        feedA.pushRound(219e8, uint256(settleTime) - 31 minutes);
        feedA.pushRound(222e8, uint256(settleTime) + 6 hours);
        feedB.pushRound(361e8, uint256(settleTime) - 31 minutes);
        feedB.pushRound(359e8, uint256(settleTime) + 6 hours);
        // Pushed Pyth benchmarks inside the window; snaps equal them (+10%/-10%).
        _setFreshAnchor(address(nvda), settleTime, 220e18);
        _setFreshAnchor(address(tsla), settleTime, 360e18);
        vm.warp(uint256(settleTime) + 10 minutes);
        vm.prank(settler);
        arena.settle(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Settled), "legit pyth-path settle must not false-void");
        assertEq(arena.getBout(id).winner, 1);
    }

    /// @dev PoC-6 (pass 3). The one divergence corner the reorder introduces:
    ///      a genuine Pyth-path snap coexisting with a fresh bracket that
    ///      prints a different value (only reachable if the oracle's CL search
    ///      transiently failed at snap time while the arena's later search
    ///      succeeds). The authoritative CL branch voids -> fail-closed refund,
    ///      never a theft or a brick. Documents accepted behavior (N-4 Info).
    function test_poc6_divergenceCorner_freshBracketContradictsGenuinePyth_failsClosed() public {
        _wireFeeds();
        uint256 id = _lockedBout(100e6, 100e6);
        // Fresh bracket printing 220; snap == genuine pyth benchmark 219.
        feedA.pushRound(220e8, uint256(settleTime) - 2 minutes);
        feedA.pushRound(221e8, uint256(settleTime) + 2 minutes);
        feedB.pushRound(360e8, uint256(settleTime) - 2 minutes);
        feedB.pushRound(361e8, uint256(settleTime) + 2 minutes);
        _setFreshAnchor(address(nvda), settleTime, 219e18); // pyth-sourced snap
        oracle.setAnchor(address(tsla), settleTime, 360e18); // CL-consistent
        vm.warp(uint256(settleTime) + 5 minutes);
        vm.prank(settler);
        arena.settle(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided), "contradiction fails closed into refund");
        uint256 aBefore = usdg.balanceOf(alice);
        vm.prank(alice);
        arena.claim(id);
        assertEq(usdg.balanceOf(alice) - aBefore, 100e6, "exact refund");
    }
}
