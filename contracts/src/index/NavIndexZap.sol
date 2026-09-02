// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/*//////////////////////////////////////////////////////////////////////////
                        EXTERNAL INTERFACES (live contracts)
//////////////////////////////////////////////////////////////////////////*/

/// @dev NavSwapRouter — live at 0xc8156712C1A654db7dcb805D8B9De15683fdc680.
///      USDG is the mandatory route waypoint; the interface fee (20 bps, USDG,
///      immutable) is skimmed inside the router on every swap.
interface INavSwapRouter {
    struct Leg {
        uint8 venue;
        int24 param;
    }

    struct SwapParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        Leg legIn;
        Leg legOut;
        address recipient;
        uint256 deadline;
        bytes32 quoteId;
        uint8 altVenue;
        uint256 altQuote;
    }

    function swapExactIn(SwapParams calldata p) external returns (uint256 amountOut);
}

interface INavIndexToken {
    function components() external view returns (address[] memory);
    function issueAmounts(uint256 grossShares) external view returns (uint256[] memory);
    function issue(uint256 grossShares, address to) external returns (uint256 netShares);
    function redeem(uint256 shares, address to) external;
}

interface INavIndexFactory {
    function isIndex(address token) external view returns (bool);
}

/*//////////////////////////////////////////////////////////////////////////
                                NAV INDEX ZAP
//////////////////////////////////////////////////////////////////////////*/

/// @title  NavIndexZap — one-transaction USDG entry/exit for NAV indices
/// @notice Turns a basket mint into a single USDG action: `zapIssue` swaps USDG
///         into every component through NavSwapRouter and issues index shares;
///         `zapRedeem` unwinds shares back to USDG. The zap is stateless — it
///         holds no balances between transactions and sweeps every touched token
///         back to the caller at the end of each call. It can only operate on
///         tokens deployed by the canonical NavIndexFactory.
contract NavIndexZap is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////////////
                                  IMMUTABLES
    //////////////////////////////////////////////////////////////////////*/

    IERC20 public immutable usdg;
    INavSwapRouter public immutable router;
    INavIndexFactory public immutable factory;

    /*//////////////////////////////////////////////////////////////////////
                                EVENTS / ERRORS
    //////////////////////////////////////////////////////////////////////*/

    event ZapIssued(
        address indexed index, address indexed caller, uint256 usdgIn, uint256 netShares, uint256 usdgRefund
    );
    event ZapRedeemed(address indexed index, address indexed caller, uint256 shares, uint256 usdgOut);

    error NotAnIndex();
    error LengthMismatch();
    error ZeroAmount();
    error Expired();
    error SlippageExceeded(uint256 usdgOut, uint256 minUsdgOut);

    /*//////////////////////////////////////////////////////////////////////
                                  CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////*/

    constructor(IERC20 usdg_, INavSwapRouter router_, INavIndexFactory factory_) {
        if (address(usdg_) == address(0) || address(router_) == address(0) || address(factory_) == address(0)) {
            revert ZeroAmount();
        }
        usdg = usdg_;
        router = router_;
        factory = factory_;
    }

    /*//////////////////////////////////////////////////////////////////////
                                     TYPES
    //////////////////////////////////////////////////////////////////////*/

    /// @param leg     USDG<->component pool route (venue + pool key) on the router.
    /// @param usdgIn  USDG budget for this component (zapIssue only).
    /// @param minOut  Slippage floor for the swap output. Must be > 0.
    struct RouteLeg {
        INavSwapRouter.Leg leg;
        uint256 usdgIn;
        uint256 minOut;
    }

    /*//////////////////////////////////////////////////////////////////////
                                    ZAP IN
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Swap USDG into every component and issue `grossShares` of `index`
    ///         to the caller. Leftover components and USDG are refunded in full.
    /// @dev The caller (frontend) sizes `legs[i].usdgIn` so each swap clears the
    ///      exact `issueAmounts(grossShares)[i]` requirement plus slippage room;
    ///      `legs[i].minOut` should be at least that requirement, making the
    ///      whole zap atomic: any shortfall reverts inside the router or on the
    ///      component pull.
    function zapIssue(address index, uint256 grossShares, RouteLeg[] calldata legs, uint256 deadline)
        external
        nonReentrant
        returns (uint256 netShares)
    {
        if (block.timestamp > deadline) revert Expired();
        if (!factory.isIndex(index)) revert NotAnIndex();
        if (grossShares == 0) revert ZeroAmount();

        address[] memory comps = INavIndexToken(index).components();
        uint256 n = comps.length;
        if (legs.length != n) revert LengthMismatch();

        // Pull the total USDG budget once.
        uint256 totalIn;
        for (uint256 i; i < n; ++i) {
            totalIn += legs[i].usdgIn;
        }
        if (totalIn == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), totalIn);

        // Swap USDG -> each component via the live router.
        usdg.forceApprove(address(router), totalIn);
        for (uint256 i; i < n; ++i) {
            router.swapExactIn(
                INavSwapRouter.SwapParams({
                    tokenIn: address(usdg),
                    tokenOut: comps[i],
                    amountIn: legs[i].usdgIn,
                    minAmountOut: legs[i].minOut,
                    legIn: INavSwapRouter.Leg({venue: 0, param: 0}),
                    legOut: legs[i].leg,
                    recipient: address(this),
                    deadline: deadline,
                    quoteId: bytes32(0),
                    altVenue: 0,
                    altQuote: 0
                })
            );
        }
        usdg.forceApprove(address(router), 0);

        // Approve the full post-swap component balances, then issue to the
        // caller. Issuance pulls max(nominal, pro-rata) — a state-dependent
        // amount that can rise between quote and execution — so approving the
        // whole swap output (instead of a pre-quoted exact figure) makes the
        // zap succeed whenever the swaps bought enough, and revert atomically
        // inside `issue` when they did not. Approvals are zeroed right after,
        // so no allowance ever outlives the transaction.
        for (uint256 i; i < n; ++i) {
            IERC20 c = IERC20(comps[i]);
            c.forceApprove(index, c.balanceOf(address(this)));
        }
        netShares = INavIndexToken(index).issue(grossShares, msg.sender);

        // Sweep everything back: component dust and unspent USDG.
        for (uint256 i; i < n; ++i) {
            IERC20 c = IERC20(comps[i]);
            c.forceApprove(index, 0);
            uint256 bal = c.balanceOf(address(this));
            if (bal != 0) c.safeTransfer(msg.sender, bal);
        }
        uint256 refund = usdg.balanceOf(address(this));
        if (refund != 0) usdg.safeTransfer(msg.sender, refund);

        emit ZapIssued(index, msg.sender, totalIn, netShares, refund);
    }

    /*//////////////////////////////////////////////////////////////////////
                                    ZAP OUT
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Redeem `shares` of `index` and swap every component back to USDG.
    ///         Reverts unless total USDG received >= `minUsdgOut`.
    /// @dev `legs[i].usdgIn` is ignored here; `legs[i].minOut` is the per-leg
    ///      swap floor. Components whose redemption pays zero are skipped.
    function zapRedeem(address index, uint256 shares, RouteLeg[] calldata legs, uint256 minUsdgOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (!factory.isIndex(index)) revert NotAnIndex();
        if (shares == 0) revert ZeroAmount();
        // A zero floor would let MEV sandwich every leg to dust; the caller
        // must always state a real minimum.
        if (minUsdgOut == 0) revert ZeroAmount();

        address[] memory comps = INavIndexToken(index).components();
        uint256 n = comps.length;
        if (legs.length != n) revert LengthMismatch();

        // Pull shares and redeem the basket to this contract.
        IERC20(index).safeTransferFrom(msg.sender, address(this), shares);
        INavIndexToken(index).redeem(shares, address(this));

        // Swap every received component back to USDG.
        for (uint256 i; i < n; ++i) {
            IERC20 c = IERC20(comps[i]);
            uint256 bal = c.balanceOf(address(this));
            if (bal == 0) continue;
            c.forceApprove(address(router), bal);
            router.swapExactIn(
                INavSwapRouter.SwapParams({
                    tokenIn: comps[i],
                    tokenOut: address(usdg),
                    amountIn: bal,
                    minAmountOut: legs[i].minOut,
                    legIn: legs[i].leg,
                    legOut: INavSwapRouter.Leg({venue: 0, param: 0}),
                    recipient: address(this),
                    deadline: deadline,
                    quoteId: bytes32(0),
                    altVenue: 0,
                    altQuote: 0
                })
            );
            c.forceApprove(address(router), 0);
        }

        usdgOut = usdg.balanceOf(address(this));
        if (usdgOut < minUsdgOut) revert SlippageExceeded(usdgOut, minUsdgOut);
        if (usdgOut != 0) usdg.safeTransfer(msg.sender, usdgOut);

        emit ZapRedeemed(index, msg.sender, shares, usdgOut);
    }
}
