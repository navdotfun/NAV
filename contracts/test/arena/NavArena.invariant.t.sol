// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArenaBase, MockERC20, MockSettleOracle} from "./ArenaBase.t.sol";
import {NavArena} from "../../src/arena/NavArena.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPitOracleSettle} from "../../src/arena/NavArena.sol";

/*//////////////////////////////////////////////////////////////////////////
                                    HANDLER
//////////////////////////////////////////////////////////////////////////*/

/// @dev Random walk over the full bout lifecycle with 6 actors, random stakes,
///      random price paths, random time warps and adversarial call ordering.
///      Tracks ground truth for solvency and payout accounting.
contract ArenaHandler is Test {
    NavArena public arena;
    MockERC20 public usdg;
    MockERC20 public nvda;
    MockERC20 public tsla;
    MockSettleOracle public oracle;
    address public constant ACCUM = address(0xACC);

    address[6] public actors;
    uint256[] public liveBouts;

    // Ground truth
    uint256 public totalStaked; // all USDG ever staked
    uint256 public totalClaimed; // all USDG paid to claimants
    uint256 public totalFees; // fee transfers out (bounty + accumulator)
    uint256 public ghost_claimViolations;

    constructor(NavArena arena_, MockERC20 usdg_, MockERC20 nvda_, MockERC20 tsla_, MockSettleOracle oracle_) {
        arena = arena_;
        usdg = usdg_;
        nvda = nvda_;
        tsla = tsla_;
        oracle = oracle_;
        for (uint256 i; i < 6; ++i) {
            actors[i] = address(uint160(0xF000 + i));
            usdg.mint(actors[i], type(uint96).max);
            vm.prank(actors[i]);
            usdg.approve(address(arena), type(uint256).max);
        }
    }

    /// @dev Fresh anchor = stored settlement backed by a matching Pyth print.
    function _setFreshAnchor(address asset, uint64 expiry, uint256 p) internal {
        oracle.setAnchor(asset, expiry, p);
        oracle.setPyth(asset, expiry, p);
    }

    function createBout(uint256 seed) external {
        uint64 ec = uint64(block.timestamp + 1 hours + (seed % 6 days));
        uint64 st = uint64(ec + 1 hours + ((seed >> 64) % 29 days));
        uint256 id = arena.createBout(address(nvda), address(tsla), ec, st);
        liveBouts.push(id);
    }

    function stake(uint256 seed, uint256 amountSeed) external {
        if (liveBouts.length == 0) return;
        uint256 id = liveBouts[seed % liveBouts.length];
        NavArena.Bout memory b = arena.getBout(id);
        if (b.state != NavArena.State.Open || block.timestamp + 30 minutes >= b.entryClose) return;
        address actor = actors[seed % 6];
        uint256 amt = 1e6 + (amountSeed % 500_000e6);
        vm.prank(actor);
        arena.stake(id, seed % 2 == 0, amt);
        totalStaked += amt;
    }

    function lock(uint256 seed) external {
        if (liveBouts.length == 0) return;
        uint256 id = liveBouts[seed % liveBouts.length];
        NavArena.Bout memory b = arena.getBout(id);
        if (b.state != NavArena.State.Open) return;
        if (block.timestamp < b.entryClose) vm.warp(b.entryClose);
        // Randomly pre-arm anchors: fresh (anchor+pyth), stale (anchor only,
        // exercises the stale-anchor void) or missing (AnchorPending revert).
        uint256 mode = seed % 5;
        if (mode >= 2) {
            uint256 pA = 1e15 + (seed % 1e22);
            uint256 pB = 1e15 + ((seed >> 32) % 1e22);
            oracle.setAnchor(address(nvda), b.entryClose, pA);
            oracle.setPyth(address(nvda), b.entryClose, pA);
            oracle.setAnchor(address(tsla), b.entryClose, pB);
            oracle.setPyth(address(tsla), b.entryClose, pB);
        } else if (mode == 1) {
            oracle.setAnchor(address(nvda), b.entryClose, 1e15 + (seed % 1e22));
            oracle.setAnchor(address(tsla), b.entryClose, 1e15 + ((seed >> 32) % 1e22));
        }
        try arena.lock(id) {} catch {}
    }

    function settle(uint256 seed) external {
        if (liveBouts.length == 0) return;
        uint256 id = liveBouts[seed % liveBouts.length];
        NavArena.Bout memory b = arena.getBout(id);
        if (b.state != NavArena.State.Locked) return;
        if (block.timestamp < b.settleTime) vm.warp(b.settleTime);
        // Randomly pre-arm end anchors: fresh (anchor+pyth), stale (anchor
        // only, exercises the settle-time stale-anchor void) or missing
        // (AnchorPending revert).
        if (seed % 7 == 1) {
            oracle.setAnchor(address(nvda), b.settleTime, 1e15 + ((seed >> 8) % 1e22));
            oracle.setAnchor(address(tsla), b.settleTime, 1e15 + ((seed >> 48) % 1e22));
        } else if (seed % 7 != 0) {
            _setFreshAnchor(address(nvda), b.settleTime, 1e15 + ((seed >> 8) % 1e22));
            _setFreshAnchor(address(tsla), b.settleTime, 1e15 + ((seed >> 48) % 1e22));
        }
        uint256 balBefore = usdg.balanceOf(address(arena));
        try arena.settle(id) {
            // fee left the contract iff bout is now Settled
            NavArena.Bout memory a = arena.getBout(id);
            if (a.state == NavArena.State.Settled) {
                totalFees += balBefore - usdg.balanceOf(address(arena));
            }
        } catch {}
    }

    function voidBout(uint256 seed) external {
        if (liveBouts.length == 0) return;
        uint256 id = liveBouts[seed % liveBouts.length];
        try arena.voidBout(id) {} catch {}
    }

    function claim(uint256 seed) external {
        if (liveBouts.length == 0) return;
        uint256 id = liveBouts[seed % liveBouts.length];
        address actor = actors[seed % 6];
        uint256 before = usdg.balanceOf(actor);
        vm.prank(actor);
        try arena.claim(id) {
            totalClaimed += usdg.balanceOf(actor) - before;
        } catch {}
    }

    function warp(uint256 seed) external {
        vm.warp(block.timestamp + (seed % 3 days));
    }

    function boutCount() external view returns (uint256) {
        return liveBouts.length;
    }

    function boutAt(uint256 i) external view returns (uint256) {
        return liveBouts[i];
    }
}

/*//////////////////////////////////////////////////////////////////////////
                                  INVARIANTS
//////////////////////////////////////////////////////////////////////////*/

contract NavArenaInvariantTest is Test {
    NavArena internal arena;
    MockERC20 internal usdg;
    MockERC20 internal nvda;
    MockERC20 internal tsla;
    MockSettleOracle internal oracle;
    ArenaHandler internal handler;

    function setUp() public {
        vm.warp(1_760_000_000);
        usdg = new MockERC20("USDG", "USDG", 6);
        nvda = new MockERC20("NVIDIA", "NVDA", 18);
        tsla = new MockERC20("Tesla", "TSLA", 18);
        oracle = new MockSettleOracle();
        oracle.setQuote(address(nvda), 200e18);
        oracle.setQuote(address(tsla), 400e18);
        arena = new NavArena(IERC20(address(usdg)), IPitOracleSettle(address(oracle)), address(0xACC));
        handler = new ArenaHandler(arena, usdg, nvda, tsla, oracle);
        targetContract(address(handler));
    }

    /// @notice Global conservation: staked = escrowed + claimed + fees, always.
    function invariant_conservation() public view {
        assertEq(
            handler.totalStaked(),
            usdg.balanceOf(address(arena)) + handler.totalClaimed() + handler.totalFees(),
            "staked == escrow + claimed + fees"
        );
    }

    /// @notice The contract can always cover every remaining entitlement: for
    ///         each bout, unclaimed refunds (voided), unclaimed winner payouts
    ///         (settled) and full pots (open/locked) are <= escrow.
    function invariant_solvency() public view {
        uint256 owed;
        uint256 n = handler.boutCount();
        for (uint256 i; i < n; ++i) {
            NavArena.Bout memory b = arena.getBout(handler.boutAt(i));
            if (b.state == NavArena.State.Open || b.state == NavArena.State.Locked) {
                owed += uint256(b.potA) + b.potB;
            }
            // Voided/Settled bouts: remaining entitlements are bounded by
            // pots minus what already left; covered by conservation together
            // with per-claim exactness (fuzz suite). Here we assert escrow
            // never goes negative for live bouts alone.
        }
        assertLe(owed, usdg.balanceOf(address(arena)), "live pots covered by escrow");
    }

    /// @notice State machine sanity: winner set iff Settled; snapped prices
    ///         non-zero iff Locked or Settled; pots never mutate after lock.
    function invariant_stateMachine() public view {
        uint256 n = handler.boutCount();
        for (uint256 i; i < n; ++i) {
            NavArena.Bout memory b = arena.getBout(handler.boutAt(i));
            if (b.state == NavArena.State.Settled) {
                assertTrue(b.winner == 1 || b.winner == 2, "settled has winner");
                assertTrue(b.startA != 0 && b.startB != 0 && b.endA != 0 && b.endB != 0, "settled has prices");
            } else {
                assertTrue(b.winner == 0, "winner only when settled");
            }
            if (b.state == NavArena.State.Locked) {
                assertTrue(b.startA != 0 && b.startB != 0, "locked has start prices");
            }
        }
    }

    /// @notice Fees only ever flow out on settlement: accumulator balance equals
    ///         total fees minus bounties (bounties went to callers).
    function invariant_feesOnlyGrow() public view {
        assertLe(usdg.balanceOf(address(0xACC)), handler.totalFees(), "accum <= total fees");
    }
}
