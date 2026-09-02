// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NavIndexToken} from "../../src/index/NavIndexToken.sol";

/*//////////////////////////////////////////////////////////////////////////
        FIX-VERIFICATION ROUND 2 — adversarial probes of the skip try/catch
//////////////////////////////////////////////////////////////////////////*/

/// @dev Minimal ERC20-alike; behaves normally until `mode` is set.
///      mode 0 = healthy, 1 = balanceOf reverts, 2 = balanceOf returns
///      SUCCESS with EMPTY returndata (bricked-proxy emulation: delegatecall
///      to an empty implementation returns ok + 0 bytes), 3 = adaptive
///      returnbomb (expands memory until gas nearly exhausted, returns it
///      all), 4 = burns ALL forwarded gas (invalid opcode), 5 = returns
///      type(uint256).max.
contract EvilToken {
    string public name = "Evil";
    string public symbol = "EVL";
    uint8 public constant decimals = 18;
    uint256 public mode;
    mapping(address => uint256) internal _bal;
    mapping(address => mapping(address => uint256)) public allowance;

    function setMode(uint256 m) external { mode = m; }
    function mint(address to, uint256 amt) external { _bal[to] += amt; }

    function balanceOf(address a) external view returns (uint256) {
        uint256 m = mode;
        if (m == 1) revert("VIEW_BRICKED");
        if (m == 2) assembly { return(0, 0) } // success, empty returndata
        if (m == 3) {
            assembly {
                // Expand memory in 32KB strides until almost out of gas,
                // then return the whole zero-filled region. The callee pays
                // the quadratic expansion with its 63/64; the caller must pay
                // roughly the same again to copy/decode it with only 1/64
                // left -> OOG in the CALLER frame at any gas limit.
                let p := 0
                for {} gt(gas(), 40000) { p := add(p, 0x8000) } { mstore(p, 1) }
                return(0, p)
            }
        }
        if (m == 4) assembly { invalid() } // burn all forwarded gas
        if (m == 5) return type(uint256).max;
        if (m == 6) {
            // PARTIAL word: success with 16 bytes of 0xff garbage. If the
            // reader ever consumed this, the blended stale-scratch word
            // would be huge garbage instead of 0.
            assembly {
                mstore(0x00, not(0))
                return(0x00, 0x10)
            }
        }
        if (m == 7) {
            // EXCESS returndata: true balance word followed by garbage tail.
            uint256 b = _bal[a];
            assembly {
                mstore(0x00, b)
                mstore(0x20, not(0))
                return(0x00, 0x40)
            }
        }
        return _bal[a];
    }

    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt; return true;
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        _bal[msg.sender] -= amt; _bal[to] += amt; return true;
    }
    function transferFrom(address f, address to, uint256 amt) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= amt, "ALLOW");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - amt;
        _bal[f] -= amt; _bal[to] += amt; return true;
    }
}

/// @dev balanceOf declared NON-view so it may attempt mutation; tries to
///      re-enter redeem. NavIndexToken calls balanceOf through the IERC20
///      interface (view) => STATICCALL => any state change reverts the frame.
contract ReentrantToken {
    string public name = "Reenter";
    string public symbol = "REE";
    uint8 public constant decimals = 18;
    uint256 public mode;
    uint256 public reentrySucceeded; // set iff a reentrant redeem ever lands
    NavIndexToken public target;
    mapping(address => uint256) internal _bal;
    mapping(address => mapping(address => uint256)) public allowance;

    function setMode(uint256 m) external { mode = m; }
    function setTarget(NavIndexToken t) external { target = t; }
    function mint(address to, uint256 amt) external { _bal[to] += amt; }

    function balanceOf(address a) external returns (uint256) {
        if (mode == 1 && address(target) != address(0)) {
            try target.redeem(1, address(this)) {
                reentrySucceeded = 1; // this write alone also kills a staticcall
            } catch {}
        }
        return _bal[a];
    }

    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt; return true;
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        _bal[msg.sender] -= amt; _bal[to] += amt; return true;
    }
    function transferFrom(address f, address to, uint256 amt) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= amt, "ALLOW");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - amt;
        _bal[f] -= amt; _bal[to] += amt; return true;
    }
}

contract PlainToken2 is EvilToken {}


/// @dev Minimal ERC1967-style proxy: implementation in the standard 1967 slot
///      (no storage collision with the delegated ERC20 layout). Emulates a
///      legitimately proxied component so the 50k-gas cap on the skipped-leg
///      balance read can be verified across a delegatecall hop.
contract MiniProxy1967 {
    bytes32 private constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor(address impl_) {
        assembly { sstore(IMPL_SLOT, impl_) }
    }

    fallback() external payable {
        assembly {
            let impl := sload(IMPL_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

contract AuditFixVerify2PoC is Test {
    address minter = address(0xBEEF);

    function _mkIndex(address evil, address good) internal returns (NavIndexToken index) {
        address[] memory comps = new address[](2);
        comps[0] = evil;
        comps[1] = good;
        uint256[] memory units = new uint256[](2);
        units[0] = 1e18;
        units[1] = 1e18;
        index = new NavIndexToken(
            NavIndexToken.IndexConfig({
                name: "PoC2", symbol: "POC2", creator: address(this),
                components: comps, unitsPerShare: units,
                mintFeeBps: 0, redeemFeeBps: 0, streamFeeBps: 0
            })
        );
    }

    function _seedEvil(NavIndexToken index, EvilToken evil, EvilToken good) internal {
        evil.mint(minter, 1000e18);
        good.mint(minter, 1000e18);
        vm.startPrank(minter);
        evil.approve(address(index), type(uint256).max);
        good.approve(address(index), type(uint256).max);
        index.issue(100e18, minter);
        vm.stopPrank();
    }

    function _skipRedeemCall(NavIndexToken index, uint256 shares, bool[] memory skip, uint256 gasBudget)
        internal
        returns (bool ok)
    {
        vm.prank(minter);
        (ok,) = address(index).call{gas: gasBudget}(
            abi.encodeWithSignature("redeem(uint256,address,bool[])", shares, minter, skip)
        );
    }

    /*//////////////////////////////////////////////////////////////////
        1. Regression: revert-on-balanceOf skip works (prior M-01 core)
    //////////////////////////////////////////////////////////////////*/

    function test_fix2_revertingBalanceOf_skipExits() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        evil.setMode(1); // balanceOf reverts
        bool[] memory skip = new bool[](2);
        skip[0] = true;
        uint256 goodBefore = good.balanceOf(minter);
        vm.prank(minter);
        index.redeem(100e18, minter, skip); // full exit
        assertEq(index.balanceOf(minter), 0, "all shares burned");
        assertEq(good.balanceOf(minter), goodBefore + 100e18, "healthy leg fully paid");
    }

    /*//////////////////////////////////////////////////////////////////
        2. M-02 REGRESSION (originally demonstrated the trap, now pins
           the fix): balanceOf SUCCEEDS with EMPTY returndata (bricked
           proxy: delegatecall to empty implementation). Solidity's catch
           does NOT catch return-data decode failures — they revert in
           the CALLER frame — but the skip path now reads the balance via
           a bounded low-level staticcall (`_skippedBalance`), which
           treats short returndata as 0. The skip redeem must succeed.
           The 2-arg path remains fail-closed by design (reverts on any
           bricked leg); the 3-arg skip is the guaranteed exit.
    //////////////////////////////////////////////////////////////////*/

    function test_poc2_emptyReturndataBalanceOf_vsSkip() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        evil.setMode(2); // success + 0-byte returndata
        bool[] memory skip = new bool[](2);
        skip[0] = true;

        // 2-arg path stays fail-closed (intended): decode failure reverts.
        vm.prank(minter);
        (bool ok2,) = address(index).call{gas: 5_000_000}(
            abi.encodeWithSignature("redeem(uint256,address)", 100e18, minter)
        );
        assertFalse(ok2, "2-arg path fail-closed on bricked leg (by design)");

        // Post-fix: the 3-arg skip path survives the decode trap and exits.
        bool ok = _skipRedeemCall(index, 100e18, skip, 5_000_000);
        assertTrue(ok, "skip redemption must survive success-empty-returndata component");
        assertEq(index.balanceOf(minter), 0, "full exit");
        assertEq(good.balanceOf(minter), 1000e18, "healthy leg fully recovered");
    }

    /*//////////////////////////////////////////////////////////////////
        3. ATTACK: adaptive returnbomb. VERDICT (empirical): NOT a brick.
           For a statically-typed return (uint256) solc 0.8.36 copies only
           the 32 bytes it needs — the bomb never enters the caller's
           memory. The callee still burns its 63/64 building the bomb, so
           the attack degrades to plain gas griefing: a too-tight budget
           fails (residual 1/64 can't finish the healthy legs), a normal
           budget exits fine. The caller controls the budget => survivable.
    //////////////////////////////////////////////////////////////////*/

    function test_fix2_returnBombBalanceOf_isOnlyGasGriefing() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        evil.setMode(3); // adaptive returnbomb
        bool[] memory skip = new bool[](2);
        skip[0] = true;

        // Generous budget: bomb burns ~63/64, the reserved slice finishes.
        bool ok = _skipRedeemCall(index, 100e18, skip, 30_000_000);
        assertTrue(ok, "returnbomb must not block exit given adequate gas");
        assertEq(index.balanceOf(minter), 0, "full exit");
        assertEq(good.balanceOf(minter), 1000e18, "healthy leg fully recovered");
    }

    /*//////////////////////////////////////////////////////////////////
        4. Gas-burning balanceOf (all-gas invalid opcode) IS survivable:
           the OOG happens inside the callee, the catch absorbs it, and
           the caller's reserved 1/64 finishes the exit.
    //////////////////////////////////////////////////////////////////*/

    function test_fix2_gasBurnerBalanceOf_skipSurvives() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        evil.setMode(4); // balanceOf burns all forwarded gas
        bool[] memory skip = new bool[](2);
        skip[0] = true;

        bool ok = _skipRedeemCall(index, 100e18, skip, 10_000_000);
        assertTrue(ok, "gas-burner leg must not block exit given adequate gas");
        assertEq(index.balanceOf(minter), 0, "full exit");
        assertEq(good.balanceOf(minter), 1000e18, "healthy leg fully recovered");
    }

    /*//////////////////////////////////////////////////////////////////
        5. balanceOf returning type(uint256).max on the skipped leg must
           not overflow ComponentSkipped math (netShares <= supply).
    //////////////////////////////////////////////////////////////////*/

    function test_fix2_maxUintBalance_skipNoOverflow() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        evil.setMode(5); // balanceOf -> type(uint256).max
        bool[] memory skip = new bool[](2);
        skip[0] = true;
        vm.prank(minter);
        index.redeem(100e18, minter, skip); // full exit: mulDiv(max, S, S) fits
        assertEq(index.balanceOf(minter), 0, "full exit despite max-uint balance");
    }

    /*//////////////////////////////////////////////////////////////////
        6. Reentrancy via balanceOf is impossible: IERC20.balanceOf is
           view => STATICCALL; the inner redeem (and even the marker
           SSTORE) reverts inside the static frame. The skip exit still
           succeeds because the catch absorbs the frame failure — and no
           second redemption ever lands.
    //////////////////////////////////////////////////////////////////*/

    function test_fix2_reentrantBalanceOf_neutralized() public {
        ReentrantToken evil = new ReentrantToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        evil.setTarget(index);
        evil.mint(minter, 1000e18);
        good.mint(minter, 1000e18);
        vm.startPrank(minter);
        evil.approve(address(index), type(uint256).max);
        good.approve(address(index), type(uint256).max);
        index.issue(100e18, minter);
        vm.stopPrank();

        evil.setMode(1); // attempt reentry from balanceOf
        bool[] memory skip = new bool[](2);
        skip[0] = true;

        uint256 supplyBefore = index.totalSupply();
        vm.prank(minter);
        index.redeem(50e18, minter, skip);
        // Exactly one redemption: supply fell by exactly the burned shares.
        assertEq(index.totalSupply(), supplyBefore - 50e18, "exactly one burn, no reentrant redeem");
        assertEq(evil.reentrySucceeded(), 0, "reentry never landed");
    }

    /*//////////////////////////////////////////////////////////////////
        7. Skip stays non-extractive: redeemer receives ZERO of the
           skipped leg; the forfeited slice stays in the vault.
    //////////////////////////////////////////////////////////////////*/

    function test_fix2_skipForfeit_nonExtractive() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        evil.setMode(1);
        bool[] memory skip = new bool[](2);
        skip[0] = true;
        evil.setMode(0);
        uint256 evilUserBefore = evil.balanceOf(minter);
        uint256 evilVaultBefore = evil.balanceOf(address(index));
        evil.setMode(1);

        vm.prank(minter);
        index.redeem(50e18, minter, skip);

        evil.setMode(0);
        assertEq(evil.balanceOf(minter), evilUserBefore, "redeemer got none of the skipped leg");
        assertEq(evil.balanceOf(address(index)), evilVaultBefore, "forfeit stays in vault");
    }

    /*//////////////////////////////////////////////////////////////////
        8. Strict mask rule edges: truncated mask reverts, all-true mask
           reverts, empty mask on the 3-arg overload reverts; the 2-arg
           overload still works and still fails closed on a bricked leg.
    //////////////////////////////////////////////////////////////////*/

    function test_fix2_maskRule_edges() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        // truncated
        bool[] memory one = new bool[](1);
        one[0] = true;
        vm.prank(minter);
        vm.expectRevert(NavIndexToken.BadSkips.selector);
        index.redeem(10e18, minter, one);

        // oversized
        bool[] memory three = new bool[](3);
        vm.prank(minter);
        vm.expectRevert(NavIndexToken.BadSkips.selector);
        index.redeem(10e18, minter, three);

        // empty
        bool[] memory zero = new bool[](0);
        vm.prank(minter);
        vm.expectRevert(NavIndexToken.BadSkips.selector);
        index.redeem(10e18, minter, zero);

        // all-true
        bool[] memory allTrue = new bool[](2);
        allTrue[0] = true;
        allTrue[1] = true;
        vm.prank(minter);
        vm.expectRevert(NavIndexToken.BadSkips.selector);
        index.redeem(10e18, minter, allTrue);

        // 2-arg still works while healthy
        vm.prank(minter);
        index.redeem(10e18, minter);
        assertEq(index.balanceOf(minter), 90e18);

        // 2-arg fails closed once a leg is view-bricked (intended)
        evil.setMode(1);
        vm.prank(minter);
        vm.expectRevert(bytes("VIEW_BRICKED"));
        index.redeem(10e18, minter);
    }

    event ComponentSkipped(address indexed component, uint256 forfeited);

    /*//////////////////////////////////////////////////////////////////
        PASS 3 — probes of the `_skippedBalance` bounded staticcall
    //////////////////////////////////////////////////////////////////*/

    /// 9. PARTIAL returndata (16 bytes of 0xff): the staticcall writes the
    ///    partial word into scratch 0x00 BEFORE the guard is evaluated, and
    ///    scratch is provably dirty at that point (_burn's mapping-slot
    ///    keccaks use [0x00,0x40)). The guard must yield forfeited == 0 —
    ///    never a stale/blended word — and the exit must complete.
    function test_pass3_partialReturndata_yieldsZeroNotStaleScratch() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        evil.setMode(6); // success + 16 bytes of 0xff
        bool[] memory skip = new bool[](2);
        skip[0] = true;

        vm.expectEmit(true, false, false, true, address(index));
        emit ComponentSkipped(address(evil), 0); // exactly 0 — no garbage
        vm.prank(minter);
        index.redeem(100e18, minter, skip);
        assertEq(index.balanceOf(minter), 0, "full exit");
        assertEq(good.balanceOf(minter), 1000e18, "healthy leg fully recovered");
    }

    /// 10. CODELESS component (EOA-shaped): staticcall to an account with no
    ///     code SUCCEEDS with 0 returndata. Must report 0 and exit.
    function test_pass3_codelessComponent_skipExits() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        vm.etch(address(evil), ""); // strip all code post-seeding
        bool[] memory skip = new bool[](2);
        skip[0] = true;

        vm.expectEmit(true, false, false, true, address(index));
        emit ComponentSkipped(address(evil), 0);
        vm.prank(minter);
        index.redeem(100e18, minter, skip);
        assertEq(index.balanceOf(minter), 0, "full exit");
        assertEq(good.balanceOf(minter), 1000e18, "healthy leg fully recovered");
    }

    /// 11. EXCESS returndata (64 bytes: true balance word + 0xff tail):
    ///     rds > 32 passes the guard; only the FIRST word is consumed —
    ///     identical to a high-level uint256 decode. True forfeit reported.
    function test_pass3_excessReturndata_firstWordConsumed() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        evil.setMode(7); // returns (bal, garbage)
        bool[] memory skip = new bool[](2);
        skip[0] = true;

        // vault holds 100e18 evil; redeem 50e18 of 100e18 supply, 0 fees:
        // forfeited = mulDiv(100e18, 50e18, 100e18) = 50e18.
        vm.expectEmit(true, false, false, true, address(index));
        emit ComponentSkipped(address(evil), 50e18);
        vm.prank(minter);
        index.redeem(50e18, minter, skip);
        assertEq(index.balanceOf(minter), 50e18);
    }

    /// 12. HEALTHY skipped leg behind a live ERC1967-style proxy: the 50k
    ///     stipend must cover SLOAD(impl) + delegatecall + balance SLOAD, so
    ///     the true forfeited amount is still reported through the hop.
    function test_pass3_healthyProxiedLeg_trueForfeitUnder50k() public {
        EvilToken impl = new EvilToken();
        MiniProxy1967 proxy = new MiniProxy1967(address(impl));
        EvilToken evil = EvilToken(address(proxy)); // proxied component
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        bool[] memory skip = new bool[](2);
        skip[0] = true; // healthy, just skipped

        vm.expectEmit(true, false, false, true, address(index));
        emit ComponentSkipped(address(evil), 50e18); // true pro-rata forfeit
        vm.prank(minter);
        index.redeem(50e18, minter, skip);
        assertEq(index.balanceOf(minter), 50e18);
        assertEq(good.balanceOf(minter), 950e18, "non-skipped leg paid");
    }

    /// 13. L-01 ERASED: two simultaneous all-gas-burning skipped legs. Under
    ///     the old 63/64 forwarding, two burners left g/64^2 (~7k at a 30M
    ///     limit) — unconditionally fatal. With the 50k cap, each burner
    ///     costs <=~50k and a modest ~800k budget exits in full.
    function test_pass3_twoGasBurners_boundedAndSurvivable() public {
        EvilToken evil1 = new EvilToken();
        EvilToken evil2 = new EvilToken();
        PlainToken2 good = new PlainToken2();

        address[] memory comps = new address[](3);
        comps[0] = address(evil1);
        comps[1] = address(evil2);
        comps[2] = address(good);
        uint256[] memory units = new uint256[](3);
        units[0] = 1e18;
        units[1] = 1e18;
        units[2] = 1e18;
        NavIndexToken index = new NavIndexToken(
            NavIndexToken.IndexConfig({
                name: "PoC3", symbol: "POC3", creator: address(this),
                components: comps, unitsPerShare: units,
                mintFeeBps: 0, redeemFeeBps: 0, streamFeeBps: 0
            })
        );
        evil1.mint(minter, 1000e18);
        evil2.mint(minter, 1000e18);
        good.mint(minter, 1000e18);
        vm.startPrank(minter);
        evil1.approve(address(index), type(uint256).max);
        evil2.approve(address(index), type(uint256).max);
        good.approve(address(index), type(uint256).max);
        index.issue(100e18, minter);
        vm.stopPrank();

        evil1.setMode(4); // burn all forwarded gas
        evil2.setMode(4);
        bool[] memory skip = new bool[](3);
        skip[0] = true;
        skip[1] = true;

        vm.prank(minter);
        (bool ok,) = address(index).call{gas: 800_000}(
            abi.encodeWithSignature("redeem(uint256,address,bool[])", 100e18, minter, skip)
        );
        assertTrue(ok, "two burner legs must cost <=~50k each, not 63/64 each");
        assertEq(index.balanceOf(minter), 0, "full exit");
        assertEq(good.balanceOf(minter), 1000e18, "healthy leg fully recovered");
    }

    /// 14. Returnbomb now BOUNDED: the 50k stipend prevents building any
    ///     meaningful bomb and retsize is fixed at 0x20 — a modest budget
    ///     exits in full (previously needed a generous 63/64 headroom).
    function test_pass3_returnBomb_boundedBudgetExits() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        evil.setMode(3);
        bool[] memory skip = new bool[](2);
        skip[0] = true;

        vm.prank(minter);
        (bool ok,) = address(index).call{gas: 500_000}(
            abi.encodeWithSignature("redeem(uint256,address,bool[])", 100e18, minter, skip)
        );
        assertTrue(ok, "bounded read: bomb cannot force a large gas budget");
        assertEq(index.balanceOf(minter), 0, "full exit");
        assertEq(good.balanceOf(minter), 1000e18, "healthy leg fully recovered");
    }

    /// 15. Gas-shaping is display-only: even when the outer budget starves
    ///     the 50k stipend (63/64 rule), either the exit completes atomically
    ///     — possibly reporting forfeited = 0 on the skipped leg — or the
    ///     WHOLE call reverts. Transfers can never be affected because the
    ///     helper's value feeds only the ComponentSkipped event. Scan a
    ///     budget ladder and assert all-or-nothing semantics at every rung.
    function test_pass3_gasShaping_allOrNothing() public {
        EvilToken evil = new EvilToken();
        PlainToken2 good = new PlainToken2();
        NavIndexToken index = _mkIndex(address(evil), address(good));
        _seedEvil(index, evil, EvilToken(address(good)));

        bool[] memory skip = new bool[](2);
        skip[0] = true; // healthy skipped leg

        uint256 shares = 1e18;
        for (uint256 g = 40_000; g <= 400_000; g += 4_000) {
            uint256 sharesBefore = index.balanceOf(minter);
            uint256 goodBefore = good.balanceOf(minter);
            vm.prank(minter);
            (bool ok,) = address(index).call{gas: g}(
                abi.encodeWithSignature("redeem(uint256,address,bool[])", shares, minter, skip)
            );
            if (ok) {
                assertEq(index.balanceOf(minter), sharesBefore - shares, "burn landed");
                // 0 fees and skip-forfeits keep vault good-balance == supply,
                // so the pro-rata payout for `shares` is exactly `shares`.
                assertEq(good.balanceOf(minter), goodBefore + shares, "payout landed in full");
            } else {
                assertEq(index.balanceOf(minter), sharesBefore, "no partial burn");
                assertEq(good.balanceOf(minter), goodBefore, "no partial payout");
            }
        }
    }
}
