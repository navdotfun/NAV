// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";

/// @title  NavIndexToken — a personal on-chain ETF over tokenized equities
/// @notice One ERC-20 share class over a fixed basket of Robinhood Chain
///         tokenized stocks/ETFs. Anyone can `issue` shares by depositing the
///         basket and `redeem` shares for a pro-rata slice of the vault's actual
///         holdings. The index creator earns flow fees; the component set, the
///         units per share, and every fee are frozen at construction — there is
///         no admin, no upgrade path, and no way to touch user collateral.
///
///         Issuance pricing (surplus-monotone): while supply exists, each
///         component pull is the *greater* of the nominal fixed units and the
///         current pro-rata backing — `max(ceil(g·u_i/1e18), ceil(g·bal_i/S))`.
///         Per-share backing can therefore never be diluted by an issue, which
///         makes a mint→redeem round trip strictly unprofitable and lets
///         donations, unminted fees, and rounding dust accrue safely to
///         holders. The flip side (documented, favours holders): once the
///         streaming fee has diluted backing below nominal, new issuers still
///         pay full nominal units — late entry into an old index carries a
///         small premium that flows to existing holders, never out.
///
///         Fee model (TokenSets-style, hard-capped):
///           - mint fee (<= 1%): taken in shares on issue — 90% minted to the
///             creator, 10% *never minted*. The unminted remainder is a backing
///             boost: components enter for the full gross amount while supply
///             rises by less, so every existing holder's share appreciates.
///             That is the protocol's cut, expressed without custody.
///           - redeem fee (<= 1%): same split, taken in shares on exit.
///           - streaming fee (<= 2%/year): lazily accrued supply inflation
///             minted to the creator on every touch (or via `pokeFees`).
///
///         Redemption is pro-rata of *actual balances*, so tokens donated or
///         air-dropped to the vault accrue to all holders and the vault can
///         never owe more than it holds. If a component ever freezes (paused,
///         blacklisted, bricked), holders exit through the skip overload of
///         `redeem`, forfeiting only the frozen leg's slice to the remaining
///         holders — one dead token can never trap the rest of the basket.
///
///         Integrator note: never price index shares off `nominalAmounts`
///         alone — use `min(nominal, pro-rata)` (see `redeemAmounts`) so a
///         donation-inflated NAV cannot be used to overvalue collateral.
contract NavIndexToken is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////////////
                                   CONSTANTS
    //////////////////////////////////////////////////////////////////////*/

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 private constant YEAR = 365 days;

    /// @notice Hard caps on creator fees, immutable economics of every index.
    uint256 public constant MAX_MINT_FEE_BPS = 100;
    uint256 public constant MAX_REDEEM_FEE_BPS = 100;
    uint256 public constant MAX_STREAM_FEE_BPS = 200;
    /// @notice Creator's share of mint/redeem fee shares; the rest is unminted.
    uint256 public constant CREATOR_SHARE_BPS = 9000;
    /// @notice Component count bounds.
    uint256 public constant MIN_COMPONENTS = 2;
    uint256 public constant MAX_COMPONENTS = 10;

    /*//////////////////////////////////////////////////////////////////////
                                  IMMUTABLES
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Index creator — receives all creator fees. Fixed forever.
    address public immutable creator;
    /// @notice Mint fee in bps of gross shares.
    uint256 public immutable mintFeeBps;
    /// @notice Redeem fee in bps of shares redeemed.
    uint256 public immutable redeemFeeBps;
    /// @notice Streaming fee in bps of supply per year.
    uint256 public immutable streamFeeBps;

    /*//////////////////////////////////////////////////////////////////////
                                    STORAGE
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Basket definition, frozen at construction.
    address[] private _components;
    /// @notice 1e18-scaled units of each component backing 1e18 shares.
    uint256[] private _unitsPerShare;
    /// @notice Timestamp of the last streaming-fee accrual.
    uint64 public lastAccrual;

    /*//////////////////////////////////////////////////////////////////////
                                EVENTS / ERRORS
    //////////////////////////////////////////////////////////////////////*/

    event Issued(address indexed caller, address indexed to, uint256 grossShares, uint256 netShares);
    event Redeemed(address indexed caller, address indexed to, uint256 shares, uint256 netShares);
    event ComponentSkipped(address indexed component, uint256 forfeited);
    event StreamingFeeAccrued(uint256 creatorShares, uint64 elapsed);

    error BadConfig();
    error ZeroShares();
    error EmptySupply();
    error ComponentShortfall(address component);
    error BadSkips();

    /*//////////////////////////////////////////////////////////////////////
                                  CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Full construction config, packed to keep call sites stack-safe.
    struct IndexConfig {
        string name;
        string symbol;
        address creator;
        address[] components;
        uint256[] unitsPerShare;
        uint256 mintFeeBps;
        uint256 redeemFeeBps;
        uint256 streamFeeBps;
    }

    /// @dev Deployed only by NavIndexFactory, which validates component liveness
    ///      against PitOracleV2. Structural bounds are re-validated here so the
    ///      token is safe even standalone.
    constructor(IndexConfig memory cfg) ERC20(cfg.name, cfg.symbol) {
        uint256 n = cfg.components.length;
        if (n < MIN_COMPONENTS || n > MAX_COMPONENTS || cfg.unitsPerShare.length != n) revert BadConfig();
        if (cfg.creator == address(0)) revert BadConfig();
        if (
            cfg.mintFeeBps > MAX_MINT_FEE_BPS || cfg.redeemFeeBps > MAX_REDEEM_FEE_BPS
                || cfg.streamFeeBps > MAX_STREAM_FEE_BPS
        ) {
            revert BadConfig();
        }
        for (uint256 i; i < n; ++i) {
            if (cfg.components[i] == address(0) || cfg.unitsPerShare[i] == 0) revert BadConfig();
            for (uint256 j = i + 1; j < n; ++j) {
                if (cfg.components[i] == cfg.components[j]) revert BadConfig();
            }
        }
        creator = cfg.creator;
        _components = cfg.components;
        _unitsPerShare = cfg.unitsPerShare;
        mintFeeBps = cfg.mintFeeBps;
        redeemFeeBps = cfg.redeemFeeBps;
        streamFeeBps = cfg.streamFeeBps;
        lastAccrual = uint64(block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////////////
                                 ISSUE / REDEEM
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Mint `grossShares` worth of the basket to `to`. While supply
    ///         exists each component pull is `max(nominal units, pro-rata of
    ///         current backing)` — see the contract notice — so an issue can
    ///         never dilute per-share backing. Receiver is credited gross minus
    ///         the mint fee. Pulls round *up* and received amounts are verified
    ///         by balance difference; rounding always favours the vault.
    function issue(uint256 grossShares, address to) external nonReentrant returns (uint256 netShares) {
        if (grossShares == 0) revert ZeroShares();
        _accrueStreamingFee();

        uint256 supply = totalSupply();
        uint256 n = _components.length;
        for (uint256 i; i < n; ++i) {
            IERC20 c = IERC20(_components[i]);
            uint256 balBefore = c.balanceOf(address(this));
            uint256 amt = Math.mulDiv(grossShares, _unitsPerShare[i], WAD, Math.Rounding.Ceil);
            if (supply != 0) {
                uint256 proRata = Math.mulDiv(balBefore, grossShares, supply, Math.Rounding.Ceil);
                if (proRata > amt) amt = proRata;
            }
            c.safeTransferFrom(msg.sender, address(this), amt);
            // Fee-on-transfer / rebasing guard: full nominal amounts must land.
            if (c.balanceOf(address(this)) < balBefore + amt) revert ComponentShortfall(_components[i]);
        }

        uint256 feeShares = (grossShares * mintFeeBps) / BPS;
        uint256 creatorShares = (feeShares * CREATOR_SHARE_BPS) / BPS;
        netShares = grossShares - feeShares;

        _mint(to, netShares);
        if (creatorShares != 0) _mint(creator, creatorShares);
        emit Issued(msg.sender, to, grossShares, netShares);
    }

    /// @notice Burn `shares` and send `to` a pro-rata slice of every component
    ///         balance, net of the redeem fee. Payouts round *down*; dust accrues
    ///         to remaining holders.
    function redeem(uint256 shares, address to) external nonReentrant {
        _redeem(shares, to, new bool[](0));
    }

    /// @notice Escape-hatch redemption: burn `shares` and receive the pro-rata
    ///         slice of every component *not* flagged in `skip`. The skipped
    ///         legs' slices are forfeited — they stay in the vault and accrue
    ///         to the remaining holders, never back to the redeemer. Use only
    ///         when a component is frozen (paused/blacklisted/bricked) and a
    ///         full redemption would revert; skipping is strictly costly.
    function redeem(uint256 shares, address to, bool[] calldata skip) external nonReentrant {
        // The no-skip path is the 2-arg overload; this one demands an explicit,
        // complete mask so a truncated array can never silently change
        // semantics into a full redemption.
        if (skip.length != _components.length) revert BadSkips();
        _redeem(shares, to, skip);
    }

    function _redeem(uint256 shares, address to, bool[] memory skip) internal {
        if (shares == 0) revert ZeroShares();
        uint256 n = _components.length;
        bool skipping = skip.length != 0;
        if (skipping) {
            if (skip.length != n) revert BadSkips();
            bool allSkipped = true;
            for (uint256 i; i < n; ++i) {
                if (!skip[i]) {
                    allSkipped = false;
                    break;
                }
            }
            if (allSkipped) revert BadSkips();
        }

        _accrueStreamingFee();

        uint256 supply = totalSupply();
        if (supply == 0) revert EmptySupply();

        uint256 feeShares = (shares * redeemFeeBps) / BPS;
        uint256 creatorShares = (feeShares * CREATOR_SHARE_BPS) / BPS;
        uint256 netShares = shares - feeShares;

        // Burn first (checks balance), then pay out against the pre-burn supply:
        // out_i = balance_i * netShares / supplyBeforeBurn.
        _burn(msg.sender, shares);
        if (creatorShares != 0) _mint(creator, creatorShares);

        for (uint256 i; i < n; ++i) {
            address comp = _components[i];
            if (skipping && skip[i]) {
                // A skipped leg must never be able to block the exit: even the
                // balance read is best-effort, because a bricked component is
                // precisely what this escape hatch is for. `try` alone is not
                // enough (audit M-02): a call that SUCCEEDS with short/empty
                // returndata — the signature of a cleared proxy — reverts the
                // caller frame during decode, outside any catch. The bounded
                // low-level read below survives that too. Forfeited value
                // stays in the vault either way.
                emit ComponentSkipped(comp, Math.mulDiv(_skippedBalance(comp), netShares, supply));
                continue;
            }
            IERC20 c = IERC20(comp);
            uint256 out = Math.mulDiv(c.balanceOf(address(this)), netShares, supply);
            if (out != 0) c.safeTransfer(to, out);
        }
        emit Redeemed(msg.sender, to, shares, netShares);
    }

    /// @dev Decode-safe, gas-bounded balanceOf for SKIPPED legs only (audit
    ///      M-02 / L-01). Caps the callee at 50k gas, copies at most one word
    ///      of returndata, and returns 0 on ANY irregularity: revert, OOG,
    ///      or returndata shorter than 32 bytes. Emission/forfeiture display
    ///      accounting only — never used for transfers, so understating to 0
    ///      is always safe. mulDiv(bal, netShares, supply) cannot overflow its
    ///      result because netShares <= supply (528-bit intermediate handled
    ///      by Math.mulDiv).
    function _skippedBalance(address token) private view returns (uint256 bal) {
        bytes memory cd = abi.encodeCall(IERC20.balanceOf, (address(this)));
        assembly ("memory-safe") {
            let ok := staticcall(50000, token, add(cd, 0x20), mload(cd), 0x00, 0x20)
            if and(ok, gt(returndatasize(), 0x1f)) { bal := mload(0x00) }
        }
    }

    /// @notice Accrue the streaming fee without touching the basket. Anyone may
    ///         poke; issuance and redemption poke automatically.
    function pokeFees() external {
        _accrueStreamingFee();
    }

    /*//////////////////////////////////////////////////////////////////////
                                     VIEWS
    //////////////////////////////////////////////////////////////////////*/

    function components() external view returns (address[] memory) {
        return _components;
    }

    function unitsPerShare() external view returns (uint256[] memory) {
        return _unitsPerShare;
    }

    /// @notice Exact component amounts a caller must approve to issue
    ///         `grossShares` *right now* — `max(nominal, pro-rata)` per leg.
    ///         State-dependent: concurrent issues can only raise it, redeems
    ///         and accruals can only lower it toward nominal. Quote in the same
    ///         block where possible, or approve with headroom.
    function issueAmounts(uint256 grossShares) external view returns (uint256[] memory amounts) {
        uint256 supply = totalSupply();
        uint256 n = _components.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 amt = Math.mulDiv(grossShares, _unitsPerShare[i], WAD, Math.Rounding.Ceil);
            if (supply != 0) {
                uint256 proRata =
                    Math.mulDiv(IERC20(_components[i]).balanceOf(address(this)), grossShares, supply, Math.Rounding.Ceil);
                if (proRata > amt) amt = proRata;
            }
            amounts[i] = amt;
        }
    }

    /// @notice Nominal (fixed-units) component amounts for `shares`, independent
    ///         of vault state. Integrators pricing index shares must use
    ///         `min(nominalAmounts, redeemAmounts)` per component — never the
    ///         nominal alone — so donation-inflated NAV cannot overvalue shares.
    function nominalAmounts(uint256 shares) external view returns (uint256[] memory amounts) {
        uint256 n = _components.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            amounts[i] = Math.mulDiv(shares, _unitsPerShare[i], WAD);
        }
    }

    /// @notice Component amounts `redeem(shares)` would pay right now. Streaming
    ///         accrual is NOT simulated: a real redeem first mints any accrued
    ///         management-fee shares (growing supply), so actual payouts can be
    ///         marginally BELOW these amounts. Direct donations between the call
    ///         and the redeem are the only way actual payouts exceed them.
    function redeemAmounts(uint256 shares) external view returns (uint256[] memory amounts) {
        uint256 supply = totalSupply();
        uint256 n = _components.length;
        amounts = new uint256[](n);
        if (supply == 0) return amounts;
        uint256 feeShares = (shares * redeemFeeBps) / BPS;
        uint256 netShares = shares - feeShares;
        for (uint256 i; i < n; ++i) {
            amounts[i] = Math.mulDiv(IERC20(_components[i]).balanceOf(address(this)), netShares, supply);
        }
    }

    /*//////////////////////////////////////////////////////////////////////
                                   INTERNALS
    //////////////////////////////////////////////////////////////////////*/

    /// @dev Streaming fee: supply * bps * elapsed / year, minted to the creator.
    ///      Lazy accrual bounded by the 2%/yr cap; safe against supply == 0.
    function _accrueStreamingFee() internal {
        uint64 nowTs = uint64(block.timestamp);
        uint64 elapsed = nowTs - lastAccrual;
        if (elapsed == 0) return;
        lastAccrual = nowTs;

        if (streamFeeBps == 0) return;
        uint256 supply = totalSupply();
        if (supply == 0) return;

        uint256 feeShares = Math.mulDiv(supply, streamFeeBps * elapsed, BPS * YEAR);
        if (feeShares != 0) {
            _mint(creator, feeShares);
            emit StreamingFeeAccrued(feeShares, elapsed);
        }
    }
}
