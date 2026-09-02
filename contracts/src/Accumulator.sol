// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {NAVVault} from "./NAVVault.sol";

/// @title Accumulator — turns fee revenue into the whole market
/// @notice Holds the accumulation share of fees (in `feeToken`) and swaps it
///         into vault-registry assets via a whitelisted DEX router/aggregator,
///         sending proceeds straight to the vault. Keeper-incentivized and
///         permissionless to execute; routes are constrained to the registry.
contract Accumulator is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable feeToken;
    NAVVault public immutable vault;

    mapping(address => bool) public routerWhitelist;
    /// @notice caller reward in bps of amount swapped per accumulate() call
    uint16 public keeperRewardBps = 10; // 0.10%
    uint16 public constant MAX_KEEPER_REWARD_BPS = 50;

    event Accumulated(address indexed asset, uint256 amountIn, uint256 amountOut, address indexed keeper);
    event RouterSet(address router, bool allowed);
    event KeeperRewardSet(uint16 bps);

    error RouterNotWhitelisted();
    error AssetNotInRegistry();
    error SwapFailed();
    error NoOutput();
    error RewardTooHigh();

    constructor(address owner_, IERC20 feeToken_, NAVVault vault_) Ownable(owner_) {
        feeToken = feeToken_;
        vault = vault_;
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        routerWhitelist[router] = allowed;
        emit RouterSet(router, allowed);
    }

    function setKeeperRewardBps(uint16 bps) external onlyOwner {
        if (bps > MAX_KEEPER_REWARD_BPS) revert RewardTooHigh();
        keeperRewardBps = bps;
        emit KeeperRewardSet(bps);
    }

    /// @notice Swap `amountIn` of feeToken into `asset` through a whitelisted
    ///         router and forward all output to the vault. Permissionless —
    ///         the caller earns `keeperRewardBps` of amountIn in feeToken.
    /// @param router  whitelisted router/aggregator
    /// @param asset   target asset; must be listed + active in the vault registry
    /// @param amountIn feeToken amount to swap (before keeper reward)
    /// @param minOut   slippage floor for the swap output
    /// @param swapCalldata router calldata (must swap feeToken -> asset, recipient = this)
    function accumulate(
        address router,
        address asset,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata swapCalldata
    ) external nonReentrant {
        if (!routerWhitelist[router]) revert RouterNotWhitelisted();
        (bool listed, bool active,) = _assetInfo(asset);
        if (!listed || !active) revert AssetNotInRegistry();

        uint256 reward = (amountIn * keeperRewardBps) / 10_000;
        if (reward > 0) feeToken.safeTransfer(msg.sender, reward);

        uint256 balBefore = IERC20(asset).balanceOf(address(this));
        feeToken.forceApprove(router, amountIn);
        (bool ok,) = router.call(swapCalldata);
        if (!ok) revert SwapFailed();
        feeToken.forceApprove(router, 0);

        uint256 out = IERC20(asset).balanceOf(address(this)) - balBefore;
        if (out < minOut || out == 0) revert NoOutput();

        IERC20(asset).safeTransfer(address(vault), out);
        emit Accumulated(asset, amountIn, out, msg.sender);
    }

    function _assetInfo(address asset) internal view returns (bool listed, bool active, uint64 addedAt) {
        return vault.assetInfo(asset);
    }
}
