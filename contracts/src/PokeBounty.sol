// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {PitOracle} from "./pit/PitOracle.sol";

/// @title PokeBounty — fully on-chain keeper incentive for PitOracle heartbeats
/// @notice Anyone may call `pokeMany` with a list of underlyings; every oracle
///         market whose `lastValidTwap` heartbeat is at least `minAge` old gets
///         poked, and the caller earns `bountyPerPoke` USDG per successful poke.
///         No off-chain scheduler is trusted: bots discover work purely on-chain
///         via `pendingPokes()` over an owner-maintained market list.
/// @dev    Deliberately minimal trust surface:
///         - the ONLY external calls are `oracle.lastValidTwap` / `oracle.poke`
///           and USDG transfers — no price logic lives here;
///         - per-market failures (unknown market, PokeTooSoon, frozen pool)
///           are skipped, never reverting the batch;
///         - a poke only counts if the oracle's `updatedAt` actually advanced,
///           so a no-op cannot earn a bounty;
///         - payout is capped at the contract's USDG balance (`Shortfall` is
///           emitted instead of reverting, so keepers are never griefed by an
///           underfunded bounty pot mid-transaction).
///         Funding is a plain USDG transfer to this contract.
contract PokeBounty is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice hard cap on the per-poke bounty (5 USDG)
    uint256 public constant MAX_BOUNTY_PER_POKE = 5e6;
    /// @notice hard floor for `minAge` (below the oracle's own 5-min poke interval is useless)
    uint256 public constant MIN_AGE_FLOOR = 600;
    /// @notice hard ceiling for `minAge`
    uint256 public constant MIN_AGE_CEIL = 1 days;

    IERC20 public immutable usdg;
    PitOracle public immutable oracle;

    /// @notice USDG paid per successful poke (6 decimals)
    uint256 public bountyPerPoke = 0.25e6;
    /// @notice minimum heartbeat age (seconds) before a poke is bounty-eligible
    uint256 public minAge = 1500;

    /// @dev owner-curated market list backing `pendingPokes()` discovery
    address[] private _markets;

    event BountyPerPokeSet(uint256 bounty);
    event MinAgeSet(uint256 minAge);
    event MarketsSet(uint256 count);
    event PokesRewarded(address indexed keeper, uint256 count, uint256 paid);
    event Shortfall(uint256 owed, uint256 paid);
    event Swept(address indexed to, uint256 amount);

    error ZeroAddress();
    error BountyTooHigh();
    error AgeOutOfBounds();

    constructor(address owner_, IERC20 usdg_, PitOracle oracle_) Ownable(owner_) {
        if (address(usdg_) == address(0) || address(oracle_) == address(0)) revert ZeroAddress();
        usdg = usdg_;
        oracle = oracle_;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setBountyPerPoke(uint256 bounty) external onlyOwner {
        if (bounty > MAX_BOUNTY_PER_POKE) revert BountyTooHigh();
        bountyPerPoke = bounty;
        emit BountyPerPokeSet(bounty);
    }

    function setMinAge(uint256 minAge_) external onlyOwner {
        if (minAge_ < MIN_AGE_FLOOR || minAge_ > MIN_AGE_CEIL) revert AgeOutOfBounds();
        minAge = minAge_;
        emit MinAgeSet(minAge_);
    }

    /// @notice Replace the market list used by `pendingPokes()` discovery.
    /// @dev    The list is discovery-only; `pokeMany` accepts arbitrary
    ///         underlyings and is safe because unknown markets are skipped.
    function setMarkets(address[] calldata underlyings) external onlyOwner {
        delete _markets;
        for (uint256 i; i < underlyings.length; ++i) {
            if (underlyings[i] == address(0)) revert ZeroAddress();
            _markets.push(underlyings[i]);
        }
        emit MarketsSet(underlyings.length);
    }

    /// @notice Recover USDG from the bounty pot (owner is trusted).
    function sweep(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        usdg.safeTransfer(to, amount);
        emit Swept(to, amount);
    }

    // ------------------------------------------------------------------
    // Keeper entrypoint (permissionless)
    // ------------------------------------------------------------------

    /// @notice Poke every sufficiently-stale market in `underlyings` and earn
    ///         `bountyPerPoke` USDG per poke that actually advanced the
    ///         oracle heartbeat. Never reverts on a per-market basis:
    ///         fresh, unknown or failing markets are simply skipped.
    /// @dev    Duplicate entries cannot double-earn: the second poke hits the
    ///         oracle's PokeTooSoon guard and is skipped. If the pot cannot
    ///         cover the full amount owed, the remaining balance is paid and
    ///         `Shortfall` is emitted (pay-what-is-available, never revert).
    /// @return count number of successful (bounty-eligible) pokes
    function pokeMany(address[] calldata underlyings) external nonReentrant returns (uint256 count) {
        for (uint256 i; i < underlyings.length; ++i) {
            address u = underlyings[i];
            (, uint256 updatedAt) = oracle.lastValidTwap(u);
            // too fresh — not bounty-eligible yet (unknown markets have
            // updatedAt == 0 and fall through to poke(), which reverts
            // MarketUnknown and is skipped by the catch below)
            if (block.timestamp < updatedAt + minAge) continue;
            try oracle.poke(u) returns (uint256) {
                // verify the heartbeat actually advanced — a poke that does
                // not move `updatedAt` earns nothing
                (, uint256 newUpdatedAt) = oracle.lastValidTwap(u);
                if (newUpdatedAt <= updatedAt) continue;
                unchecked {
                    ++count;
                }
            } catch {
                continue; // MarketUnknown / PokeTooSoon / frozen pool: skip
            }
        }

        uint256 owed = count * bountyPerPoke;
        uint256 paid = owed;
        uint256 bal = usdg.balanceOf(address(this));
        if (paid > bal) {
            paid = bal;
            emit Shortfall(owed, paid);
        }
        if (paid > 0) usdg.safeTransfer(msg.sender, paid);
        emit PokesRewarded(msg.sender, count, paid);
    }

    // ------------------------------------------------------------------
    // Views (on-chain work discovery)
    // ------------------------------------------------------------------

    /// @notice Markets from the owner-set list whose heartbeat is at least
    ///         `minAge` old — i.e. bounty-eligible work, discoverable fully
    ///         on-chain by any bot.
    function pendingPokes() external view returns (address[] memory stale) {
        uint256 n = _markets.length;
        address[] memory tmp = new address[](n);
        uint256 c;
        for (uint256 i; i < n; ++i) {
            (, uint256 updatedAt) = oracle.lastValidTwap(_markets[i]);
            if (block.timestamp >= updatedAt + minAge) {
                tmp[c] = _markets[i];
                unchecked {
                    ++c;
                }
            }
        }
        stale = new address[](c);
        for (uint256 i; i < c; ++i) {
            stale[i] = tmp[i];
        }
    }

    /// @notice Current USDG available for bounties.
    function bountyBalance() external view returns (uint256) {
        return usdg.balanceOf(address(this));
    }

    /// @notice Full owner-set market list.
    function markets() external view returns (address[] memory) {
        return _markets;
    }
}
