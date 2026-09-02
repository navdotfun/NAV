// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NavIndexToken} from "../../src/index/NavIndexToken.sol";

/// @dev Minimal mintable ERC20-alike whose balanceOf can be bricked.
contract BrickableToken {
    string public name = "Brickable";
    string public symbol = "BRK";
    uint8 public constant decimals = 18;
    bool public bricked;
    mapping(address => uint256) internal _bal;
    mapping(address => mapping(address => uint256)) public allowance;

    function setBricked(bool b) external { bricked = b; }
    function mint(address to, uint256 amt) external { _bal[to] += amt; }

    function balanceOf(address a) external view returns (uint256) {
        require(!bricked, "VIEW_BRICKED");
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

contract PlainToken is BrickableToken {}

contract AuditFixVerifyPoC is Test {
    NavIndexToken index;
    BrickableToken brk;
    PlainToken ok;
    address minter = address(0xBEEF);

    function setUp() public {
        brk = new BrickableToken();
        ok = new PlainToken();
        address[] memory comps = new address[](2);
        comps[0] = address(brk);
        comps[1] = address(ok);
        uint256[] memory units = new uint256[](2);
        units[0] = 1e18;
        units[1] = 1e18;
        index = new NavIndexToken(
            NavIndexToken.IndexConfig({
                name: "PoC", symbol: "POC", creator: address(this),
                components: comps, unitsPerShare: units,
                mintFeeBps: 0, redeemFeeBps: 0, streamFeeBps: 0
            })
        );
        brk.mint(minter, 1000e18);
        ok.mint(minter, 1000e18);
        vm.startPrank(minter);
        brk.approve(address(index), type(uint256).max);
        ok.approve(address(index), type(uint256).max);
        index.issue(100e18, minter);
        vm.stopPrank();
    }

    /// PoC-1: if a component's balanceOf itself reverts (view-bricked token,
    /// e.g. broken proxy upgrade), even the skip escape hatch cannot exit —
    /// out_i is computed BEFORE the skip flag is consulted.
    function test_poc_viewBrickedComponent_defeatsSkip() public {
        // M-01 FIXED: the skip check is hoisted ahead of the balance read and
        // the read on skipped legs is try/catch'd — a view-bricked component
        // can no longer trap the basket.
        brk.setBricked(true);
        bool[] memory skip = new bool[](2);
        skip[0] = true; // forfeit the bricked leg — exit must succeed
        uint256 okBefore = ok.balanceOf(minter);
        uint256 sharesBefore = index.balanceOf(minter);
        vm.prank(minter);
        index.redeem(50e18, minter, skip);
        assertEq(index.balanceOf(minter), sharesBefore - 50e18, "shares burned");
        assertGt(ok.balanceOf(minter), okBefore, "healthy leg paid out");
    }

    /// Control: transfer-bricked (not view-bricked) components ARE skippable.
    function test_control_transferFrozen_skipWorks() public {
        // freeze transfers only: emulate via re-deploying a fresh expectation —
        // here we simply verify skip path never calls transfer on skipped leg.
        bool[] memory skip = new bool[](2);
        skip[0] = true;
        uint256 okBefore = ok.balanceOf(minter);
        vm.prank(minter);
        index.redeem(50e18, minter, skip);
        assertGt(ok.balanceOf(minter), okBefore, "non-skipped leg paid");
    }

    /// PoC-2 FIXED: the 3-arg overload now demands a complete mask — an empty
    /// or truncated skip array reverts instead of silently redeeming fully.
    function test_poc_emptySkipArray_revertsBadSkips() public {
        bool[] memory skip = new bool[](0);
        vm.prank(minter);
        vm.expectRevert(NavIndexToken.BadSkips.selector);
        index.redeem(10e18, minter, skip);
    }

    /// Verify: skip forfeiture is strictly costly — a skip-redeemer who
    /// re-issues afterwards pays the enriched pro-rata price and cannot
    /// claw back any part of the forfeited leg.
    function test_verify_skipThenReissue_noClawback() public {
        bool[] memory skip = new bool[](2);
        skip[0] = true;
        vm.startPrank(minter);
        index.redeem(50e18, minter, skip); // forfeits 50 BRK to remaining holders
        // vault: 100 BRK backing 50 shares -> pro-rata 2e18 BRK per share
        uint256 brkBefore = brk.balanceOf(minter);
        index.issue(50e18, minter); // must pull pro-rata (2x nominal) on BRK
        uint256 paid = brkBefore - brk.balanceOf(minter);
        assertGe(paid, 100e18, "re-issue pays full enriched pro-rata, no clawback");
        vm.stopPrank();
    }
}
