// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {NAVToken} from "./NAVToken.sol";

/// @title NAVVault — multi-asset vault holding every Stock Token on Robinhood Chain
/// @notice $NAV is the vault's share token. The asset registry is EXTENSIBLE:
///         governance can list new stocks/ETFs as they come into existence
///         (`addAsset`) and deactivate frozen/delisted ones (`setAssetActive`).
///         Redemption is in-kind: burn shares, receive a pro-rata slice of
///         every active asset, straight to your wallet.
/// @dev    The share token ($NAV) is fixed-supply and minted entirely at
///         deployment — the vault can only BURN it (via allowance), never mint.
///
/// @dev    audit-v4 hardening (see qa/audit-v4/01-navtoken-navvault.md):
///         - V4-01 (CRITICAL): outstanding `credited[]` is RESERVED via
///           `totalCredited[]` and removed from the pro-rata numerator, so
///           `Σ credited[·][a] ≤ balanceOf(a)` holds by construction and the
///           split-redemption credit amplification is gone.
///         - V4-02 (HIGH): redemption reverts if the whole registry is inactive
///           or if nothing at all would be settled; slices of listed-but-
///           inactive assets are CREDITED instead of silently forfeited.
///         - V4-05 (HIGH): every asset transfer is a gas-bounded low-level
///           call, so a hostile/upgraded asset can no longer burn 63/64 of the
///           gas and brick the exit for all holders — its slice is credited.
///         - V4-06 (HIGH): SafeERC20-style returndata handling — empty
///           returndata from a pre-EIP-20 token is a success, not an
///           uncatchable `abi.decode` revert.
///         - V4-04 (MEDIUM): `claimCredit` is `whenNotPaused`, so no asset can
///           leave the vault by any path while the brake is on.
///         - V4-03 (MEDIUM): `redeemInKindGuarded` takes `maxFeeBps` and
///           per-asset `minOut`, so an owner fee bump cannot sandwich an exit.
contract NAVVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct AssetInfo {
        bool listed;   // ever added to the registry
        bool active;   // included in accumulation + redemption
        uint64 addedAt;
    }

    NAVToken public immutable share;
    address public accumulator; // advisory only; NOT an authorization (never read by the vault)

    address[] public assets;                    // enumerable registry
    mapping(address => AssetInfo) public assetInfo;

    /// @notice redemption fee in basis points, stays in vault (accrues to remaining holders)
    uint16 public redeemFeeBps = 50; // 0.5%
    uint16 public constant MAX_REDEEM_FEE_BPS = 200; // hard cap 2%

    /// @notice hard cap on registry size — keeps the redemption loop bounded (V4-05/V4-13)
    uint256 public constant MAX_ASSETS = 512;

    /// @dev bounds on the per-asset transfer gas budget (V4-05)
    uint256 public constant MIN_TRANSFER_GAS = 100_000;
    uint256 public constant MAX_TRANSFER_GAS = 1_000_000;
    /// @dev gas that must remain, on top of the transfer budget, before an
    ///      external transfer is attempted; below it the slice is credited so
    ///      the loop always makes progress instead of reverting the redemption.
    uint256 internal constant GAS_TAIL_BUFFER = 80_000;

    /// @notice gas forwarded to each asset `transfer` during redemption (V4-05)
    uint256 public transferGasLimit = 200_000;

    /// @dev credited amounts when an asset transfer fails mid-redemption (skip-and-credit)
    mapping(address => mapping(address => uint256)) public credited; // user => asset => amount

    /// @notice outstanding credits per asset — RESERVED out of the redeemable
    ///         balance so later redeemers can never be over-credited (V4-01)
    mapping(address => uint256) public totalCredited; // asset => outstanding credits

    event AssetAdded(address indexed asset);
    event AssetActiveSet(address indexed asset, bool active);
    event RedeemedInKind(address indexed holder, uint256 shares, uint256 assetsTouched);
    event TransferCredited(address indexed holder, address indexed asset, uint256 amount);
    event CreditClaimed(address indexed holder, address indexed asset, uint256 amount);
    event RedeemFeeSet(uint16 bps);
    event AccumulatorSet(address accumulator);
    event TransferGasLimitSet(uint256 gasLimit);

    error AlreadyListed();
    error NotListed();
    error ZeroAddress();
    error ZeroShares();
    error FeeTooHigh();
    /// @notice every registry asset is inactive (or the registry is empty) —
    ///         refuse to burn NAV for nothing (V4-02)
    error AllAssetsInactive();
    /// @notice the redemption would neither pay nor credit anything (V4-02)
    error NothingRedeemed();
    /// @notice the effective fee exceeded the caller's `maxFeeBps` (V4-03)
    error FeeAboveMax(uint16 feeBps, uint16 maxFeeBps);
    /// @notice a guarded asset paid out less than the caller's `minOut` (V4-03)
    error InsufficientOutput(address asset, uint256 paid, uint256 minOut);
    error LengthMismatch();
    error RegistryFull();
    error BadGasLimit();

    constructor(address owner_, NAVToken share_) Ownable(owner_) {
        if (address(share_) == address(0)) revert ZeroAddress();
        share = share_;
    }

    // ---------------------------------------------------------------- registry

    /// @notice List a new stock/ETF token. Callable as new Stock Tokens launch
    ///         on Robinhood Chain — the vault basket grows with the chain.
    function addAsset(address asset) external onlyOwner {
        _addAsset(asset);
    }

    /// @notice Batch convenience for listing many new assets at once.
    function addAssets(address[] calldata newAssets) external onlyOwner {
        for (uint256 i; i < newAssets.length; ++i) {
            _addAsset(newAssets[i]);
        }
    }

    function _addAsset(address asset) internal {
        if (asset == address(0)) revert ZeroAddress();
        if (assetInfo[asset].listed) revert AlreadyListed();
        if (assets.length >= MAX_ASSETS) revert RegistryFull();
        assetInfo[asset] = AssetInfo({listed: true, active: true, addedAt: uint64(block.timestamp)});
        assets.push(asset);
        emit AssetAdded(asset);
    }

    /// @notice Deactivate (or reactivate) an asset — e.g. issuer freeze/delist.
    ///         Inactive assets are not accumulated into, and their redemption
    ///         slice is CREDITED rather than transferred (V4-02): the slice is
    ///         never silently forfeited, and it is reserved out of the
    ///         redeemable balance until claimed.
    function setAssetActive(address asset, bool active) external onlyOwner {
        if (!assetInfo[asset].listed) revert NotListed();
        assetInfo[asset].active = active;
        emit AssetActiveSet(asset, active);
    }

    function assetCount() external view returns (uint256) {
        return assets.length;
    }

    function allAssets() external view returns (address[] memory) {
        return assets;
    }

    /// @notice Balance of `asset` available to redeemers: holdings net of the
    ///         credits already promised to earlier redeemers (V4-01).
    function redeemableBalance(address asset) public view returns (uint256) {
        uint256 bal = IERC20(asset).balanceOf(address(this));
        uint256 reserved = totalCredited[asset];
        return bal > reserved ? bal - reserved : 0;
    }

    // ---------------------------------------------------------------- admin

    function setRedeemFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_REDEEM_FEE_BPS) revert FeeTooHigh();
        redeemFeeBps = bps;
        emit RedeemFeeSet(bps);
    }

    function setAccumulator(address accumulator_) external onlyOwner {
        if (accumulator_ == address(0)) revert ZeroAddress();
        accumulator = accumulator_;
        emit AccumulatorSet(accumulator_);
    }

    /// @notice Gas budget forwarded to each asset `transfer` in redemption.
    ///         Bounded so it can neither be set low enough to force credits on
    ///         well-behaved tokens nor high enough to reopen the V4-05 gas bomb.
    function setTransferGasLimit(uint256 gasLimit) external onlyOwner {
        if (gasLimit < MIN_TRANSFER_GAS || gasLimit > MAX_TRANSFER_GAS) revert BadGasLimit();
        transferGasLimit = gasLimit;
        emit TransferGasLimitSet(gasLimit);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------- redemption

    /// @notice Burn `shares` of $NAV and receive a pro-rata slice of EVERY active
    ///         asset in the vault, in kind, to `to`. A `redeemFeeBps` haircut
    ///         stays in the vault and accrues to remaining holders.
    /// @dev Unguarded legacy entrypoint, kept byte-compatible for the UI and
    ///      existing integrations. Prefer `redeemInKindGuarded`, which adds the
    ///      V4-03 fee/output protections.
    function redeemInKind(uint256 shares, address to) external nonReentrant whenNotPaused {
        _redeem(shares, to, MAX_REDEEM_FEE_BPS, new address[](0), new uint256[](0));
    }

    /// @notice Slippage-guarded redemption (V4-03).
    /// @param shares         $NAV to burn
    /// @param to             recipient of the in-kind slices (and of any credits)
    /// @param maxFeeBps      revert if `redeemFeeBps` exceeds this at execution time
    /// @param minOutAssets   assets the caller demands a minimum payout for
    /// @param minOutAmounts  minimum amount ACTUALLY TRANSFERRED to `to` per
    ///                       asset (a credit is not a payout and does not count)
    function redeemInKindGuarded(
        uint256 shares,
        address to,
        uint16 maxFeeBps,
        address[] calldata minOutAssets,
        uint256[] calldata minOutAmounts
    ) external nonReentrant whenNotPaused {
        if (minOutAssets.length != minOutAmounts.length) revert LengthMismatch();
        _redeem(shares, to, maxFeeBps, minOutAssets, minOutAmounts);
    }

    /// @dev Pro-rata is computed against totalSupply BEFORE the burn, on the
    ///      balance NET of outstanding credits (V4-01). Every transfer is a
    ///      gas-bounded low-level call with SafeERC20-style returndata handling
    ///      (V4-05/V4-06); anything that does not pay is credited and reserved.
    function _redeem(
        uint256 shares,
        address to,
        uint16 maxFeeBps,
        address[] memory minOutAssets,
        uint256[] memory minOutAmounts
    ) internal {
        if (shares == 0) revert ZeroShares();
        if (to == address(0)) revert ZeroAddress();

        uint16 feeBps = redeemFeeBps;
        // V4-03: the fee in force at execution time must satisfy the caller
        if (feeBps > maxFeeBps) revert FeeAboveMax(feeBps, maxFeeBps);

        uint256[] memory balBefore = _snapshotBalances(minOutAssets, to);

        uint256 supplyBefore = share.totalSupply();
        // burns via ERC20Burnable allowance — holder approves the vault once
        share.burnFrom(msg.sender, shares);

        uint256 touched = _settleAssets(to, shares - (shares * feeBps) / 10_000, supplyBefore);

        // V4-03: per-asset minimum amounts ACTUALLY RECEIVED by `to`
        _checkMinOut(minOutAssets, minOutAmounts, to, balBefore);

        emit RedeemedInKind(msg.sender, shares, touched);
    }

    /// @dev Walk the registry, paying or crediting each asset's slice.
    ///      Returns the number of assets actually PAID. Reverts (V4-02) if the
    ///      basket has nothing active in it, or if nothing at all was settled.
    function _settleAssets(address to, uint256 effectiveShares, uint256 supplyBefore)
        internal
        returns (uint256 touched)
    {
        uint256 n = assets.length;
        uint256 settled; // paid OR credited: every burned share maps to one
        bool anyActive;
        uint256 gasBudget = transferGasLimit;

        for (uint256 i; i < n; ++i) {
            address asset = assets[i];
            bool active = assetInfo[asset].active;
            if (active) anyActive = true;

            // V4-01: numerator is net of the credits already promised
            uint256 amount = redeemableBalance(asset);
            if (amount == 0) continue;
            amount = (amount * effectiveShares) / supplyBefore; // floor: dust favors vault
            if (amount == 0) continue;

            // V4-02: an inactive asset's slice is credited, never forfeited.
            // V4-05: only attempt the external call while enough gas remains to
            // bound it AND continue the loop; otherwise credit the slice.
            if (active && gasleft() > gasBudget + GAS_TAIL_BUFFER && _tryTransfer(asset, to, amount, gasBudget)) {
                ++touched;
            } else {
                credited[to][asset] += amount;
                totalCredited[asset] += amount; // V4-01: reserve it
                emit TransferCredited(to, asset, amount);
            }
            ++settled;
        }

        // V4-02: never burn NAV against a basket with nothing active in it
        // (this covers an empty / mis-wired registry too), and never burn for a
        // redemption that settles neither a payment nor a credit.
        if (!anyActive) revert AllAssetsInactive();
        if (settled == 0) revert NothingRedeemed();
    }

    function _snapshotBalances(address[] memory tokens, address who)
        internal
        view
        returns (uint256[] memory out)
    {
        out = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            out[i] = IERC20(tokens[i]).balanceOf(who);
        }
    }

    /// @dev V4-03: a credit is NOT a payout, so `minOut` is measured against
    ///      the recipient's real balance delta.
    function _checkMinOut(
        address[] memory tokens,
        uint256[] memory minAmounts,
        address who,
        uint256[] memory balBefore
    ) internal view {
        for (uint256 i; i < tokens.length; ++i) {
            uint256 need = minAmounts[i];
            if (need == 0) continue;
            uint256 got = IERC20(tokens[i]).balanceOf(who) - balBefore[i];
            if (got < need) revert InsufficientOutput(tokens[i], got, need);
        }
    }

    /// @dev Gas-bounded, SafeERC20-style ERC20 transfer (V4-05 + V4-06).
    ///      Returns false — never reverts — on: revert, `false` return, gas
    ///      exhaustion inside the callee, or a non-contract target. Empty
    ///      returndata from a contract counts as success (pre-EIP-20 tokens).
    function _tryTransfer(address asset, address to, uint256 amount, uint256 gasBudget)
        internal
        returns (bool)
    {
        if (asset.code.length == 0) return false;
        (bool ok, bytes memory ret) =
            asset.call{gas: gasBudget}(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return true; // success, no returndata: pre-EIP-20 token
        if (ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }

    /// @notice Claim amounts that were credited when an asset transfer failed.
    /// @dev V4-04: gated by `pause()` — while the brake is on, NO asset can
    ///      leave the vault by any path. V4-01: releases the reservation.
    function claimCredit(address asset) external nonReentrant whenNotPaused {
        uint256 amount = credited[msg.sender][asset];
        credited[msg.sender][asset] = 0;
        if (amount > 0) {
            uint256 reserved = totalCredited[asset];
            totalCredited[asset] = reserved > amount ? reserved - amount : 0;
            IERC20(asset).safeTransfer(msg.sender, amount);
            emit CreditClaimed(msg.sender, asset, amount);
        }
    }
}
