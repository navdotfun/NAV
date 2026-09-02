// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArenaBase} from "./ArenaBase.t.sol";
import {NavArena} from "../../src/arena/NavArena.sol";

/// @dev Randomised property tests. Each run builds a full bout with up to 16
///      stakers per side, random stakes and random price paths, then checks
///      conservation, payout exactness and monotonicity properties.
contract NavArenaFuzzTest is ArenaBase {
    uint256 internal constant MAX_ACTORS = 16;

    struct Prices {
        uint256 sA;
        uint256 sB;
        uint256 eA;
        uint256 eB;
    }

    /// @dev Derives a draw-free random price path, arms anchors, locks the bout
    ///      and arms settle anchors. Memory struct keeps the caller's stack flat.
    function _runPricePath(uint256 id, uint256 priceSeed) internal returns (bool aWins) {
        Prices memory p;
        p.sA = 1e15 + (priceSeed % 1e24);
        p.sB = 1e15 + ((priceSeed >> 32) % 1e24);
        p.eA = 1e15 + ((priceSeed >> 64) % 1e24);
        p.eB = 1e15 + ((priceSeed >> 96) % 1e24);
        vm.assume(p.eA * 1e18 / p.sA != p.eB * 1e18 / p.sB);

        _setFreshAnchor(address(nvda), entryClose, p.sA);
        _setFreshAnchor(address(tsla), entryClose, p.sB);
        vm.warp(entryClose);
        arena.lock(id);

        _setFreshAnchor(address(nvda), settleTime, p.eA);
        _setFreshAnchor(address(tsla), settleTime, p.eB);
        aWins = p.eA * 1e18 / p.sA > p.eB * 1e18 / p.sB;
    }

    uint256 internal nextActor;

    /// @dev Unique, freshly funded actor per call — collisions would let one
    ///      address stake on both sides and break exact-accounting assertions.
    function _actor(uint256) internal returns (address a) {
        a = address(uint160(0x10000 + nextActor++));
        usdg.mint(a, type(uint128).max);
        vm.prank(a);
        usdg.approve(address(arena), type(uint256).max);
    }

    /// @notice Conservation: after settlement and all claims, the contract holds
    ///         only sub-lot division dust; fee+bounty exactly 2% of losing pot;
    ///         every winner receives >= principal.
    struct Ctx {
        uint256 id;
        uint256 potA;
        uint256 potB;
        bool aWins;
        uint256 fee;
        uint256 paid;
    }

    function testFuzz_settlement_conservation(uint256 seed, uint256 priceSeed) public {
        Ctx memory c;
        c.id = _createDefault();

        address[] memory sideA = new address[](1 + (seed % MAX_ACTORS));
        uint256[] memory stA = new uint256[](sideA.length);
        for (uint256 i; i < sideA.length; ++i) {
            sideA[i] = _actor(uint256(keccak256(abi.encode(seed, "A", i))));
            stA[i] = 1e6 + (uint256(keccak256(abi.encode(seed, "sa", i))) % 1_000_000e6);
            vm.prank(sideA[i]);
            arena.stake(c.id, true, stA[i]);
            c.potA += stA[i];
        }
        address[] memory sideB = new address[](1 + ((seed >> 8) % MAX_ACTORS));
        uint256[] memory stB = new uint256[](sideB.length);
        for (uint256 i; i < sideB.length; ++i) {
            sideB[i] = _actor(uint256(keccak256(abi.encode(seed, "B", i))));
            stB[i] = 1e6 + (uint256(keccak256(abi.encode(seed, "sb", i))) % 1_000_000e6);
            vm.prank(sideB[i]);
            arena.stake(c.id, false, stB[i]);
            c.potB += stB[i];
        }

        {
            NavArena.Bout memory b0 = arena.getBout(c.id);
            assertEq(b0.potA, c.potA, "potA accumulation");
            assertEq(b0.potB, c.potB, "potB accumulation");
            assertEq(usdg.balanceOf(address(arena)), c.potA + c.potB, "escrow == pots");
        }

        // Random but sane start/end prices (avoid draws for this property).
        c.aWins = _runPricePath(c.id, priceSeed);
        vm.warp(settleTime);
        c.fee = ((c.aWins ? c.potB : c.potA) * 200) / BPS;
        {
            uint256 accumBefore = usdg.balanceOf(ACCUM);
            uint256 settlerBefore = usdg.balanceOf(settler);
            vm.prank(settler);
            arena.settle(c.id);
            assertEq(arena.getBout(c.id).winner, c.aWins ? 1 : 2, "winner side");
            uint256 bounty = (c.fee * 1000) / BPS;
            assertEq(usdg.balanceOf(settler) - settlerBefore, bounty, "bounty exact");
            assertEq(usdg.balanceOf(ACCUM) - accumBefore, c.fee - bounty, "accum exact");
        }

        // All winners claim; every payout >= principal; losers cannot claim.
        address[] memory winners = c.aWins ? sideA : sideB;
        uint256[] memory wStakes = c.aWins ? stA : stB;
        for (uint256 i; i < winners.length; ++i) {
            uint256 before = usdg.balanceOf(winners[i]);
            vm.prank(winners[i]);
            arena.claim(c.id);
            uint256 got = usdg.balanceOf(winners[i]) - before;
            assertGe(got, wStakes[i], "winner >= principal");
            c.paid += got;
        }
        // Conservation: escrow released = pots - fee - dust; dust < #winners.
        assertLe(c.paid, c.potA + c.potB - c.fee, "cannot overpay");
        assertLt(c.potA + c.potB - c.fee - c.paid, winners.length + 1, "dust bounded");
        assertLe(usdg.balanceOf(address(arena)), winners.length, "arena drained to dust");

        // A losing staker closes out with an explicit zero payout — no funds
        // move — and can never claim twice.
        address loser = c.aWins ? sideB[0] : sideA[0];
        uint256 loserBefore = usdg.balanceOf(loser);
        vm.prank(loser);
        arena.claim(c.id);
        assertEq(usdg.balanceOf(loser), loserBefore, "loser paid nothing");
        vm.expectRevert(NavArena.NothingToClaim.selector);
        vm.prank(loser);
        arena.claim(c.id);
    }

    /// @notice Voided bouts refund exactly what was staked, for every staker,
    ///         regardless of how the void was reached.
    function testFuzz_void_refunds_exact(uint256 seed, bool viaLockTimeout) public {
        uint256 nA = 1 + (seed % MAX_ACTORS);
        uint256 nB = (seed >> 16) % MAX_ACTORS; // possibly zero => one-sided void

        uint256 id = _createDefault();
        address[] memory actors = new address[](nA + nB);
        uint256[] memory stakes = new uint256[](nA + nB);
        for (uint256 i; i < nA + nB; ++i) {
            actors[i] = _actor(uint256(keccak256(abi.encode(seed, "v", i))));
            stakes[i] = 1e6 + (uint256(keccak256(abi.encode(seed, "vs", i))) % 100_000e6);
            vm.prank(actors[i]);
            arena.stake(id, i < nA, stakes[i]);
        }

        if (viaLockTimeout || nB == 0) {
            if (nB == 0) {
                // One side empty -> lock voids directly (inside the window).
                vm.warp(entryClose);
                arena.lock(id);
            } else {
                // Anchor never arrives -> overdue void after the window.
                vm.warp(uint256(entryClose) + 24 hours + 1);
                arena.voidBout(id);
            }
        } else {
            _setFreshAnchor(address(nvda), entryClose, 200e18);
            _setFreshAnchor(address(tsla), entryClose, 400e18);
            vm.warp(entryClose);
            arena.lock(id);
            vm.warp(uint256(settleTime) + 24 hours + 1);
            arena.voidBout(id);
        }
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided));

        for (uint256 i; i < actors.length; ++i) {
            uint256 before = usdg.balanceOf(actors[i]);
            vm.prank(actors[i]);
            arena.claim(id);
            assertEq(usdg.balanceOf(actors[i]) - before, stakes[i], "exact refund");
        }
        assertEq(usdg.balanceOf(address(arena)), 0, "fully drained after refunds");
    }

    /// @notice Window bounds hold for arbitrary timestamps.
    function testFuzz_create_windowBounds(uint64 ec, uint64 st) public {
        uint256 nowTs = block.timestamp;
        bool entryOk = ec >= nowTs + 1 hours && ec <= nowTs + 7 days;
        bool windowOk = entryOk && st >= uint256(ec) + 1 hours && st <= uint256(ec) + 30 days;
        if (windowOk) {
            arena.createBout(address(nvda), address(tsla), ec, st);
        } else {
            vm.expectRevert(NavArena.BadWindow.selector);
            arena.createBout(address(nvda), address(tsla), ec, st);
        }
    }

    /// @notice Stake accounting is exact for any sequence of stakes by one actor.
    function testFuzz_stake_accounting(uint96[8] memory amounts, bool[8] memory sides) public {
        uint256 id = _createDefault();
        usdg.mint(alice, 10_000_000e6); // cover 8 max-size stakes
        vm.prank(alice);
        usdg.approve(address(arena), type(uint256).max);
        uint256 potA;
        uint256 potB;
        for (uint256 i; i < 8; ++i) {
            uint256 amt = 1e6 + uint256(amounts[i]) % 1_000_000e6;
            _stake(id, alice, sides[i], amt);
            if (sides[i]) potA += amt;
            else potB += amt;
            NavArena.Bout memory b = arena.getBout(id);
            assertEq(b.potA, potA);
            assertEq(b.potB, potB);
            assertEq(arena.stakeA(id, alice), potA);
            assertEq(arena.stakeB(id, alice), potB);
        }
    }

    /// @notice Draw detection: proportionally identical moves always void.
    function testFuzz_settle_draw_voids(uint256 s, uint256 k) public {
        uint256 startP = 1e16 + (s % 1e22);
        uint256 mul = 1 + (k % 1000); // both sides move by identical ratio
        uint256 id = _lockedBoutWithPrices(startP, startP * 2);

        _setFreshAnchor(address(nvda), settleTime, startP * mul);
        _setFreshAnchor(address(tsla), settleTime, startP * 2 * mul);
        vm.warp(settleTime);
        arena.settle(id);
        assertEq(uint8(_state(id)), uint8(NavArena.State.Voided), "identical ratios must draw");
    }

    function _lockedBoutWithPrices(uint256 pA, uint256 pB) internal returns (uint256 id) {
        id = _createDefault();
        _stake(id, alice, true, 500e6);
        _stake(id, bob, false, 500e6);
        _setFreshAnchor(address(nvda), entryClose, pA);
        _setFreshAnchor(address(tsla), entryClose, pB);
        vm.warp(entryClose);
        arena.lock(id);
    }
}
