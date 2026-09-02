// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {PitPool, IPitOracle} from "./PitPool.sol";
import {PitTicket} from "./PitTicket.sol";

/// @title PitPoolDeployer — holds PitPool's creation code so PitFactory stays
///        under the EIP-170 24,576-byte deployed-code limit.
/// @notice Pure deployment helper. Holds no funds, no parameters and no
///         authority over any pool: PitPool reads every mutable parameter
///         (pause, fees, feeSink) from the factory address it is constructed
///         with, and only pools registered by the factory can mint tickets.
///         `factory` is write-once, so this deployer can only ever mint pools
///         bound to that one factory.
contract PitPoolDeployer {
    address public factory;

    error AlreadySet();
    error NotFactory();
    error ZeroAddress();

    /// @notice Bind this deployer to its factory. Write-once and irreversible.
    function setFactory(address factory_) external {
        if (factory != address(0)) revert AlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    function deploy(
        IERC20 underlying,
        IERC20 quote,
        IPitOracle oracle,
        PitTicket ticket,
        uint256 strikeSpacing,
        uint256 underlyingScale,
        uint256 quoteScale,
        uint16 sigmaBps,
        uint128 maxOiPerSeries
    ) external returns (address pool) {
        if (msg.sender != factory) revert NotFactory();
        pool = address(
            new PitPool(
                underlying,
                quote,
                oracle,
                ticket,
                msg.sender, // factory — source of pause/fee params
                strikeSpacing,
                underlyingScale,
                quoteScale,
                sigmaBps,
                maxOiPerSeries
            )
        );
    }
}
