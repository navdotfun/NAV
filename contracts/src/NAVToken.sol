// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Burnable} from "openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title NAVToken ($NAV) — vault share token of the NAV protocol (nav.fun)
/// @notice Deliberately scanner-clean. The full supply is minted once in the
///         constructor and can NEVER be minted again: no mint function exists,
///         no owner, no proxy, no tax, no blacklist, no transfer hooks, no
///         pause. Supply only goes DOWN (burn on in-kind redemption).
///         Every property launch scanners screen for is intentionally green:
///         fixed supply, immutable code, standard OZ ERC-20 + Permit + Burnable.
contract NAVToken is ERC20, ERC20Permit, ERC20Burnable {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18; // 1B, fixed forever

    constructor(address distributor) ERC20("Net Asset Value", "NAV") ERC20Permit("Net Asset Value") {
        _mint(distributor, TOTAL_SUPPLY);
    }
}
