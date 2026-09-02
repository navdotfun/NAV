// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NavIndexToken} from "./NavIndexToken.sol";

/// @dev PitOracleV2 — live at 0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd.
interface IPitOracleQuote {
    function quotePrice(address underlying) external view returns (uint256 price);
}

/// @title  NavIndexFactory — permissionless personal-ETF launchpad
/// @notice Anyone composes an index over live Robinhood Chain tokenized equities
///         and deploys it as a NavIndexToken in one transaction. The factory's
///         only gate is *reality*: every component must be a live, quotable
///         market on PitOracleV2 at creation time — no allowlist, no owner, no
///         curation. The registry exists purely so the UI can enumerate indices.
contract NavIndexFactory {
    /*//////////////////////////////////////////////////////////////////////
                                    STORAGE
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Price oracle used as the live-market probe.
    IPitOracleQuote public immutable oracle;

    /// @notice Every index ever created, in creation order.
    address[] public allIndices;
    /// @notice True for tokens deployed by this factory.
    mapping(address => bool) public isIndex;
    /// @notice Indices created by a given account.
    mapping(address => address[]) private _byCreator;

    /*//////////////////////////////////////////////////////////////////////
                                EVENTS / ERRORS
    //////////////////////////////////////////////////////////////////////*/

    /// @dev Name and symbol are readable from the index token itself; fee bps
    ///      are included so indexers never need a follow-up call.
    event IndexCreated(
        address indexed index,
        address indexed creator,
        address[] components,
        uint256[] unitsPerShare,
        uint256 mintFeeBps,
        uint256 redeemFeeBps,
        uint256 streamFeeBps
    );

    error BadOracle();
    error BadName();
    error DeadComponent(address component);

    /*//////////////////////////////////////////////////////////////////////
                                  CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////*/

    constructor(IPitOracleQuote oracle_) {
        if (address(oracle_) == address(0)) revert BadOracle();
        oracle = oracle_;
    }

    /*//////////////////////////////////////////////////////////////////////
                                    CREATE
    //////////////////////////////////////////////////////////////////////*/

    /// @notice Creation parameters. `creator` is always msg.sender.
    /// @param name          ERC-20 name (1..48 chars).
    /// @param symbol        ERC-20 symbol (1..16 chars).
    /// @param components    2..10 distinct tokens; each must quote live on the oracle.
    /// @param unitsPerShare 1e18-scaled units of each component per 1e18 shares.
    /// @param mintFeeBps    Creator mint fee, <= 100.
    /// @param redeemFeeBps  Creator redeem fee, <= 100.
    /// @param streamFeeBps  Creator streaming fee per year, <= 200.
    struct CreateParams {
        string name;
        string symbol;
        address[] components;
        uint256[] unitsPerShare;
        uint256 mintFeeBps;
        uint256 redeemFeeBps;
        uint256 streamFeeBps;
    }

    /// @notice Deploy a new index token. Permissionless.
    function createIndex(CreateParams calldata p) external returns (address index) {
        if (
            bytes(p.name).length == 0 || bytes(p.name).length > 48 || bytes(p.symbol).length == 0
                || bytes(p.symbol).length > 16
        ) revert BadName();

        // Reality gate: every component must be a live market the oracle can
        // price right now. quotePrice reverts for unknown/stale markets; a zero
        // answer is equally disqualifying. The revert is caught and rethrown as
        // DeadComponent so callers always learn *which* component failed.
        for (uint256 i; i < p.components.length; ++i) {
            try oracle.quotePrice(p.components[i]) returns (uint256 price) {
                if (price == 0) revert DeadComponent(p.components[i]);
            } catch {
                revert DeadComponent(p.components[i]);
            }
        }

        index = address(
            new NavIndexToken(
                NavIndexToken.IndexConfig({
                    name: p.name,
                    symbol: p.symbol,
                    creator: msg.sender,
                    components: p.components,
                    unitsPerShare: p.unitsPerShare,
                    mintFeeBps: p.mintFeeBps,
                    redeemFeeBps: p.redeemFeeBps,
                    streamFeeBps: p.streamFeeBps
                })
            )
        );

        allIndices.push(index);
        isIndex[index] = true;
        _byCreator[msg.sender].push(index);

        emit IndexCreated(
            index, msg.sender, p.components, p.unitsPerShare, p.mintFeeBps, p.redeemFeeBps, p.streamFeeBps
        );
    }

    /*//////////////////////////////////////////////////////////////////////
                                     VIEWS
    //////////////////////////////////////////////////////////////////////*/

    function indexCount() external view returns (uint256) {
        return allIndices.length;
    }

    function indicesOf(address creator_) external view returns (address[] memory) {
        return _byCreator[creator_];
    }

    /// @notice Paginated registry read for the UI.
    function indices(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = allIndices.length;
        if (offset >= total) return new address[](0);
        // Overflow-safe clamp: offset + limit could wrap for adversarial limits.
        uint256 end = limit > total - offset ? total : offset + limit;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = allIndices[i];
        }
    }
}
