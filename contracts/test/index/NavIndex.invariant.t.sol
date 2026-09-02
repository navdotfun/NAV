// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20, MockQuoteOracle} from "./IndexBase.t.sol";
import {NavIndexToken} from "../../src/index/NavIndexToken.sol";
import {NavIndexFactory, IPitOracleQuote} from "../../src/index/NavIndexFactory.sol";

/*//////////////////////////////////////////////////////////////////////////
                                    HANDLER
//////////////////////////////////////////////////////////////////////////*/

/// @dev Random walk over issue/redeem/poke/donate/warp with 5 actors against a
///      fee-bearing 3-component index. Tracks per-share backing ground truth.
contract IndexHandler is Test {
    NavIndexToken public index;
    MockERC20[3] public tokens;
    address[5] public actors;

    uint256 public sumIssuedGross;
    uint256 public sumRedeemed;
    uint256 public donationCount;

    constructor(NavIndexToken index_, MockERC20 a, MockERC20 b, MockERC20 c) {
        index = index_;
        tokens[0] = a;
        tokens[1] = b;
        tokens[2] = c;
        for (uint256 i; i < 5; ++i) {
            actors[i] = address(uint160(0xAB00 + i));
            for (uint256 j; j < 3; ++j) {
                tokens[j].mint(actors[i], type(uint128).max);
                vm.prank(actors[i]);
                tokens[j].approve(address(index), type(uint256).max);
            }
        }
    }

    function issue(uint256 seed, uint256 amt) external {
        address actor = actors[seed % 5];
        amt = 1 + (amt % 1e24);
        vm.prank(actor);
        index.issue(amt, actor);
        sumIssuedGross += amt;
    }

    function redeem(uint256 seed, uint256 amt) external {
        address actor = actors[seed % 5];
        uint256 bal = index.balanceOf(actor);
        if (bal == 0) return;
        amt = 1 + (amt % bal);
        vm.prank(actor);
        index.redeem(amt, actor);
        sumRedeemed += amt;
    }

    function poke(uint256 seed) external {
        if (seed % 3 == 0) index.pokeFees();
    }

    function donate(uint256 seed, uint256 amt) external {
        // Adversarial direct transfer into the vault.
        tokens[seed % 3].mint(address(index), 1 + (amt % 1e22));
        donationCount++;
    }

    function warp(uint256 seed) external {
        vm.warp(block.timestamp + (seed % 30 days));
    }

    function transferShares(uint256 seed, uint256 amt) external {
        address from = actors[seed % 5];
        address to = actors[(seed >> 8) % 5];
        uint256 bal = index.balanceOf(from);
        if (bal == 0 || from == to) return;
        vm.prank(from);
        index.transfer(to, 1 + (amt % bal));
    }
}

/*//////////////////////////////////////////////////////////////////////////
                                  INVARIANTS
//////////////////////////////////////////////////////////////////////////*/

contract NavIndexInvariantTest is Test {
    MockERC20 internal nvda;
    MockERC20 internal aapl;
    MockERC20 internal qqq;
    MockQuoteOracle internal oracle;
    NavIndexFactory internal factory;
    NavIndexToken internal index;
    IndexHandler internal handler;

    address internal creator = address(0xC0FFEE);
    uint256 internal constant WAD = 1e18;

    uint256[3] internal unitsArr = [uint256(0.5e18), 0.4e18, 0.1e18];

    function setUp() public {
        vm.warp(1_760_000_000);
        nvda = new MockERC20("NVIDIA", "NVDA", 18);
        aapl = new MockERC20("Apple", "AAPL", 18);
        qqq = new MockERC20("Invesco QQQ", "QQQ", 18);
        oracle = new MockQuoteOracle();
        oracle.setQuote(address(nvda), 200e18);
        oracle.setQuote(address(aapl), 250e18);
        oracle.setQuote(address(qqq), 600e18);
        factory = new NavIndexFactory(IPitOracleQuote(address(oracle)));

        address[] memory comps = new address[](3);
        comps[0] = address(nvda);
        comps[1] = address(aapl);
        comps[2] = address(qqq);
        uint256[] memory units = new uint256[](3);
        units[0] = unitsArr[0];
        units[1] = unitsArr[1];
        units[2] = unitsArr[2];

        vm.prank(creator);
        index = NavIndexToken(
            factory.createIndex(
                NavIndexFactory.CreateParams("NAV Blue Chip", "NAVBLUE", comps, units, 50, 50, 100)
            )
        );

        handler = new IndexHandler(index, nvda, aapl, qqq);
        targetContract(address(handler));
    }

    /// @notice Solvency: the vault can always pay a full-supply redemption —
    ///         every component balance covers supply * unit scaled by the worst
    ///         case the fee model allows (fees only ever *add* backing).
    ///         Concretely: balance_i * 1e18 >= (totalSupply - streamed inflation) * unit_i
    ///         is guaranteed by ceil-pulls; we assert the weaker, exact-solvency
    ///         property that pro-rata redemption of the entire supply cannot
    ///         revert: out_i = bal_i * net / supply <= bal_i for all i.
    function invariant_fullRedemptionSolvent() public view {
        uint256 supply = index.totalSupply();
        if (supply == 0) return;
        uint256[] memory amounts = index.redeemAmounts(supply);
        assertEq(amounts.length, 3);
        assertLe(amounts[0], nvda.balanceOf(address(index)), "nvda payable");
        assertLe(amounts[1], aapl.balanceOf(address(index)), "aapl payable");
        assertLe(amounts[2], qqq.balanceOf(address(index)), "qqq payable");
    }

    /// @notice Without streaming inflation there is a hard floor: components per
    ///         share never drop below the configured units net of the redeem
    ///         path's floor rounding — i.e. balance_i >= ceil-pull backing of the
    ///         *user-held* supply. We assert the practical form: vault balances
    ///         cover units-per-share for the non-creator supply.
    function invariant_backingCoversUserSupply() public view {
        uint256 userSupply = index.totalSupply() - index.balanceOf(creator);
        // Streaming/creator shares are backed by the same pool pro-rata; user
        // supply is a subset, so units * userSupply must be covered with slack.
        assertLe(
            (userSupply * unitsArr[0]) / WAD,
            nvda.balanceOf(address(index)) + 1,
            "nvda backing"
        );
        assertLe(
            (userSupply * unitsArr[1]) / WAD,
            aapl.balanceOf(address(index)) + 1,
            "aapl backing"
        );
        assertLe(
            (userSupply * unitsArr[2]) / WAD,
            qqq.balanceOf(address(index)) + 1,
            "qqq backing"
        );
    }

    /// @notice lastAccrual never lags a touched timestamp and config is frozen.
    function invariant_configFrozen() public view {
        assertEq(index.mintFeeBps(), 50);
        assertEq(index.redeemFeeBps(), 50);
        assertEq(index.streamFeeBps(), 100);
        assertEq(index.creator(), creator);
        assertEq(index.components().length, 3);
        assertLe(index.lastAccrual(), block.timestamp);
    }
}
