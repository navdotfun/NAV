// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";

/// @title FeeSplitter — routes protocol fee revenue 80/15/5
/// @notice Receives the swap-fee stream (in `feeToken`, e.g. USDC) and splits it:
///         80% → Accumulator (market-buys the whole basket into the vault)
///         15% → operations
///          5% → LP incentives
contract FeeSplitter is Ownable2Step {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    uint16 public accumulationBps = 8_000;
    uint16 public opsBps = 1_500;
    uint16 public lpBps = 500;

    IERC20 public immutable feeToken;
    address public accumulator;
    address public opsWallet;
    address public lpIncentives;

    event Distributed(uint256 toAccumulator, uint256 toOps, uint256 toLp);
    event SplitSet(uint16 accumulationBps, uint16 opsBps, uint16 lpBps);
    event RecipientsSet(address accumulator, address opsWallet, address lpIncentives);

    error BadSplit();
    error ZeroAddress();

    constructor(address owner_, IERC20 feeToken_, address accumulator_, address opsWallet_, address lpIncentives_)
        Ownable(owner_)
    {
        if (accumulator_ == address(0) || opsWallet_ == address(0) || lpIncentives_ == address(0)) {
            revert ZeroAddress();
        }
        feeToken = feeToken_;
        accumulator = accumulator_;
        opsWallet = opsWallet_;
        lpIncentives = lpIncentives_;
    }

    /// @notice Permissionless: anyone can trigger distribution of accrued fees.
    function distribute() external {
        uint256 bal = feeToken.balanceOf(address(this));
        if (bal == 0) return;
        uint256 toAcc = (bal * accumulationBps) / BPS;
        uint256 toOps = (bal * opsBps) / BPS;
        uint256 toLp = bal - toAcc - toOps;
        if (toAcc > 0) feeToken.safeTransfer(accumulator, toAcc);
        if (toOps > 0) feeToken.safeTransfer(opsWallet, toOps);
        if (toLp > 0) feeToken.safeTransfer(lpIncentives, toLp);
        emit Distributed(toAcc, toOps, toLp);
    }

    function setSplit(uint16 accBps, uint16 opsBps_, uint16 lpBps_) external onlyOwner {
        if (uint256(accBps) + opsBps_ + lpBps_ != BPS) revert BadSplit();
        accumulationBps = accBps;
        opsBps = opsBps_;
        lpBps = lpBps_;
        emit SplitSet(accBps, opsBps_, lpBps_);
    }

    function setRecipients(address accumulator_, address opsWallet_, address lpIncentives_) external onlyOwner {
        if (accumulator_ == address(0) || opsWallet_ == address(0) || lpIncentives_ == address(0)) {
            revert ZeroAddress();
        }
        accumulator = accumulator_;
        opsWallet = opsWallet_;
        lpIncentives = lpIncentives_;
        emit RecipientsSet(accumulator_, opsWallet_, lpIncentives_);
    }
}
