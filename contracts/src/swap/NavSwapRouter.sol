// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/*//////////////////////////////////////////////////////////////////////////
                            EXTERNAL VENUE INTERFACES
//////////////////////////////////////////////////////////////////////////*/

/// @dev Uniswap V3 SwapRouter02 (deadline-less variant of exactInputSingle).
interface IUniV3SwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @dev up. Slipstream (Velodrome CL) SwapRouter — keyed by tickSpacing, carries a deadline.
interface IUpClSwapRouter {
    struct ClExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ClExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @dev up. v2 (Velodrome v2) Router — constant-product / stable pools.
interface IUpV2Router {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @dev Canonical Permit2 (SignatureTransfer subset).
interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

/*//////////////////////////////////////////////////////////////////////////
                                NAV SWAP ROUTER
//////////////////////////////////////////////////////////////////////////*/

/// @title NavSwapRouter — StockSwap best-execution router for nav.fun
/// @notice Non-custodial, immutable swap router that executes stock / ETF token
///         swaps across multiple on-chain venues (Uniswap V3, up. Slipstream,
///         up. v2) and skims a fixed 20 bps interface fee — in USDG, at the
///         USDG waypoint of every route — straight into the NAV Accumulator,
///         where the existing permissionless crank converts it into vault
///         stock holdings.
///
///         Design invariants:
///           - ZERO custody: tokens enter and leave within a single tx; the
///             contract holds no balances between transactions.
///           - Every route passes through USDG (all stock liquidity on
///             Robinhood Chain is USDG-paired), so the fee is always skimmed
///             in one asset, at exactly one point.
///           - No owner, no admin keys, no upgrade path, no pause switch.
///             Venue routers and fee parameters are immutable at deploy.
///           - Anything stranded in the contract is protocol property:
///             `sweep` is permissionless and pushes USDG to the Accumulator
///             and any other token to the NAV Vault.
///
/// @dev    Quoting happens off-chain (QuoterV2 / up. quoter / v2 getAmountsOut
///         via eth_call). The route is chosen client-side; execution enforces
///         `minAmountOut` and `deadline`. The emitted RouteExecuted event is
///         the on-chain record of what was executed; `altVenue`/`altQuote`
///         are client-reported context (indicative, for transparency UIs) and
///         are NOT consensus-verified claims.
contract NavSwapRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 VENUES
    //////////////////////////////////////////////////////////////*/

    /// @dev Venue identifiers used in Leg.venue.
    uint8 public constant VENUE_NONE = 0; // leg not executed (that side is USDG)
    uint8 public constant VENUE_UNIV3 = 1; // Uniswap V3 (param = fee tier, e.g. 500)
    uint8 public constant VENUE_UP_CL = 2; // up. Slipstream CL (param = tickSpacing)
    uint8 public constant VENUE_UP_V2 = 3; // up. v2 AMM (param = 1 for stable pool, 0 volatile)

    /// @notice One route leg: a single-hop swap on one venue.
    /// @param venue  VENUE_* identifier.
    /// @param param  Venue-specific pool key: UniV3 fee tier (cast to uint24),
    ///               Slipstream tickSpacing, or v2 stable flag (0/1).
    struct Leg {
        uint8 venue;
        int24 param;
    }

    /// @notice Full swap request.
    /// @param tokenIn      Asset the trader pays.
    /// @param tokenOut     Asset the trader receives.
    /// @param amountIn     Exact input amount.
    /// @param minAmountOut Minimum acceptable output (slippage guard). MUST be > 0.
    /// @param legIn        tokenIn -> USDG leg. venue MUST be VENUE_NONE iff tokenIn == USDG.
    /// @param legOut       USDG -> tokenOut leg. venue MUST be VENUE_NONE iff tokenOut == USDG.
    /// @param recipient    Receiver of tokenOut.
    /// @param deadline     Unix timestamp after which the tx reverts.
    /// @param quoteId      Client-generated id tying this execution to a quote table (event context only).
    /// @param altVenue     Best losing venue at quote time (client-reported, indicative).
    /// @param altQuote     That venue's quoted output (client-reported, indicative).
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

    /*//////////////////////////////////////////////////////////////
                               IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice USDG — the fee asset and mandatory route waypoint (6 decimals).
    IERC20 public immutable USDG;
    /// @notice NAV AccumulatorV2 — receives all interface fees (USDG).
    address public immutable ACCUMULATOR;
    /// @notice NAVVault — receives non-USDG sweeps.
    address public immutable VAULT;
    /// @notice Uniswap V3 SwapRouter02.
    address public immutable UNIV3_ROUTER;
    /// @notice up. Slipstream SwapRouter.
    address public immutable UP_CL_ROUTER;
    /// @notice up. v2 Router.
    address public immutable UP_V2_ROUTER;
    /// @notice up. v2 PoolFactory (default factory passed in v2 routes).
    address public immutable UP_V2_FACTORY;
    /// @notice Canonical Permit2.
    IPermit2 public immutable PERMIT2;

    /// @notice Interface fee in basis points, skimmed in USDG. Immutable by construction.
    uint256 public constant FEE_BPS = 20;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted once per executed swap — the on-chain execution record.
    event RouteExecuted(
        bytes32 indexed quoteId,
        address indexed trader,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeUsdg,
        uint8 venueIn,
        uint8 venueOut,
        uint8 altVenue,
        uint256 altQuote
    );

    /// @notice Emitted when stranded tokens are swept to the protocol.
    event Swept(address indexed token, address indexed to, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error DeadlineExpired();
    error ZeroAmount();
    error ZeroAddress();
    error IdenticalTokens();
    error MinOutNotSet();
    error LegVenueMismatch();
    error UnknownVenue();
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);
    error NothingToSweep();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address usdg,
        address accumulator,
        address vault,
        address univ3Router,
        address upClRouter,
        address upV2Router,
        address upV2Factory,
        address permit2
    ) {
        if (
            usdg == address(0) || accumulator == address(0) || vault == address(0)
                || univ3Router == address(0) || upClRouter == address(0) || upV2Router == address(0)
                || upV2Factory == address(0) || permit2 == address(0)
        ) revert ZeroAddress();
        USDG = IERC20(usdg);
        ACCUMULATOR = accumulator;
        VAULT = vault;
        UNIV3_ROUTER = univ3Router;
        UP_CL_ROUTER = upClRouter;
        UP_V2_ROUTER = upV2Router;
        UP_V2_FACTORY = upV2Factory;
        PERMIT2 = IPermit2(permit2);
    }

    /*//////////////////////////////////////////////////////////////
                             SWAP ENTRYPOINTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Execute a swap using a standard ERC20 allowance on this contract.
    function swapExactIn(SwapParams calldata p) external nonReentrant returns (uint256 amountOut) {
        _validate(p);
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        amountOut = _execute(p);
    }

    /// @notice Execute a swap pulling tokenIn via a Permit2 signature (one-signature UX).
    /// @dev    permit.permitted.token MUST equal p.tokenIn and requestedAmount equals p.amountIn.
    function swapExactInPermit2(
        SwapParams calldata p,
        IPermit2.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant returns (uint256 amountOut) {
        _validate(p);
        if (permit.permitted.token != p.tokenIn) revert LegVenueMismatch();
        PERMIT2.permitTransferFrom(
            permit,
            IPermit2.SignatureTransferDetails({to: address(this), requestedAmount: p.amountIn}),
            msg.sender,
            signature
        );
        amountOut = _execute(p);
    }

    /*//////////////////////////////////////////////////////////////
                              CORE EXECUTION
    //////////////////////////////////////////////////////////////*/

    function _validate(SwapParams calldata p) internal view {
        if (block.timestamp > p.deadline) revert DeadlineExpired();
        if (p.amountIn == 0) revert ZeroAmount();
        if (p.minAmountOut == 0) revert MinOutNotSet();
        if (p.recipient == address(0)) revert ZeroAddress();
        if (p.tokenIn == p.tokenOut) revert IdenticalTokens();

        bool inIsUsdg = p.tokenIn == address(USDG);
        bool outIsUsdg = p.tokenOut == address(USDG);
        // legIn executes iff tokenIn != USDG; legOut executes iff tokenOut != USDG.
        if (inIsUsdg != (p.legIn.venue == VENUE_NONE)) revert LegVenueMismatch();
        if (outIsUsdg != (p.legOut.venue == VENUE_NONE)) revert LegVenueMismatch();
    }

    function _execute(SwapParams calldata p) internal returns (uint256 amountOut) {
        // ---- Leg 1: tokenIn -> USDG (skipped when tokenIn == USDG) ----
        uint256 usdgAmount;
        if (p.tokenIn == address(USDG)) {
            usdgAmount = p.amountIn;
        } else {
            uint256 balBefore = USDG.balanceOf(address(this));
            _swapSingle(p.legIn, p.tokenIn, address(USDG), p.amountIn, address(this));
            usdgAmount = USDG.balanceOf(address(this)) - balBefore;
        }

        // ---- Fee skim: 20 bps of the USDG waypoint, straight to the Accumulator ----
        uint256 fee = (usdgAmount * FEE_BPS) / BPS_DENOMINATOR;
        if (fee > 0) USDG.safeTransfer(ACCUMULATOR, fee);
        uint256 usdgNet = usdgAmount - fee;

        // ---- Leg 2: USDG -> tokenOut (skipped when tokenOut == USDG) ----
        if (p.tokenOut == address(USDG)) {
            USDG.safeTransfer(p.recipient, usdgNet);
            amountOut = usdgNet;
        } else {
            uint256 recipientBefore = IERC20(p.tokenOut).balanceOf(p.recipient);
            _swapSingle(p.legOut, address(USDG), p.tokenOut, usdgNet, p.recipient);
            amountOut = IERC20(p.tokenOut).balanceOf(p.recipient) - recipientBefore;
        }

        if (amountOut < p.minAmountOut) revert InsufficientOutput(amountOut, p.minAmountOut);

        emit RouteExecuted(
            p.quoteId,
            msg.sender,
            p.tokenIn,
            p.tokenOut,
            p.amountIn,
            amountOut,
            fee,
            p.legIn.venue,
            p.legOut.venue,
            p.altVenue,
            p.altQuote
        );
    }

    /// @dev Executes one single-hop swap on the specified venue with an exact,
    ///      transient approval (granted before, revoked after).
    function _swapSingle(Leg calldata leg, address tokenIn, address tokenOut, uint256 amountIn, address to)
        internal
    {
        if (leg.venue == VENUE_UNIV3) {
            IERC20(tokenIn).forceApprove(UNIV3_ROUTER, amountIn);
            IUniV3SwapRouter02(UNIV3_ROUTER).exactInputSingle(
                IUniV3SwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: uint24(uint256(int256(leg.param))),
                    recipient: to,
                    amountIn: amountIn,
                    amountOutMinimum: 0, // total minAmountOut enforced in _execute
                    sqrtPriceLimitX96: 0
                })
            );
            IERC20(tokenIn).forceApprove(UNIV3_ROUTER, 0);
        } else if (leg.venue == VENUE_UP_CL) {
            IERC20(tokenIn).forceApprove(UP_CL_ROUTER, amountIn);
            IUpClSwapRouter(UP_CL_ROUTER).exactInputSingle(
                IUpClSwapRouter.ClExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    tickSpacing: leg.param,
                    recipient: to,
                    deadline: block.timestamp,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            IERC20(tokenIn).forceApprove(UP_CL_ROUTER, 0);
        } else if (leg.venue == VENUE_UP_V2) {
            IERC20(tokenIn).forceApprove(UP_V2_ROUTER, amountIn);
            IUpV2Router.Route[] memory routes = new IUpV2Router.Route[](1);
            routes[0] = IUpV2Router.Route({
                from: tokenIn,
                to: tokenOut,
                stable: leg.param != 0,
                factory: UP_V2_FACTORY
            });
            IUpV2Router(UP_V2_ROUTER).swapExactTokensForTokens(amountIn, 0, routes, to, block.timestamp);
            IERC20(tokenIn).forceApprove(UP_V2_ROUTER, 0);
        } else {
            revert UnknownVenue();
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  SWEEP
    //////////////////////////////////////////////////////////////*/

    /// @notice Permissionless: pushes any balance stranded in this contract to
    ///         the protocol. USDG goes to the Accumulator (becomes vault fees);
    ///         anything else goes to the NAV Vault.
    /// @dev    The router never retains balances during normal operation, so
    ///         anything here was sent by mistake and is treated as a donation.
    function sweep(address token) external nonReentrant {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) revert NothingToSweep();
        address to = token == address(USDG) ? ACCUMULATOR : VAULT;
        IERC20(token).safeTransfer(to, bal);
        emit Swept(token, to, bal);
    }
}
