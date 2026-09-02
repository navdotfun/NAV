// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CreditPair} from "./CreditPair.sol";

interface IERC20DecimalsMinimal {
    function decimals() external view returns (uint8);
}

/// @title  CreditFactory — registry + deployer for isolated CreditPair markets
/// @notice Deploys immutable, isolated lending pairs (tokenized stock/ETF collateral
///         against USDG) and keeps the canonical on-chain list that the NAV frontend
///         and integrators enumerate. Shared plumbing (USDG, PitOracleV2 anchor,
///         AccumulatorV2) is fixed here at deploy time and inherited by every pair.
///
/// @dev    TRUST MODEL — the only permission in the entire credit system is WHO can
///         list a new market. `deployPair` is restricted to the immutable DEPLOYER so
///         nobody can pollute the registry with hostile listings the UI would render.
///         Listing power grants NOTHING over existing pairs: every deployed pair is
///         ownerless and parameter-frozen the block it is created, and funds in one
///         pair are unreachable from any other. Anyone can verify this by reading
///         CreditPair — there is no admin surface to misuse.
contract CreditFactory {
    error NotDeployer();
    error PairExists();
    error BadCollateral();

    event PairDeployed(
        address indexed pair,
        address indexed collateral,
        uint256 ltvBps,
        uint256 liqThresholdBps,
        uint256 liqBonusBps,
        uint256 borrowCap,
        uint256 supplyCap
    );

    /// @notice Only address allowed to list new markets (deployment key).
    address public immutable DEPLOYER;
    /// @notice Debt/supply asset shared by all pairs (live USDG).
    address public immutable USDG;
    /// @notice PitOracleV2 anchor source shared by all pairs.
    address public immutable ORACLE;
    /// @notice AccumulatorV2 fee sink shared by all pairs (buys NAV).
    address public immutable ACCUMULATOR;

    /// @notice Every pair ever deployed, in listing order.
    address[] public allPairs;
    /// @notice Collateral token => pair (one market per collateral).
    mapping(address => address) public pairFor;

    constructor(address usdg, address oracle, address accumulator) {
        require(usdg != address(0) && oracle != address(0) && accumulator != address(0), "ZERO");
        DEPLOYER = msg.sender;
        USDG = usdg;
        ORACLE = oracle;
        ACCUMULATOR = accumulator;
    }

    /// @notice Number of listed markets.
    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice Full registry in one call (small N; frontend convenience).
    function getAllPairs() external view returns (address[] memory) {
        return allPairs;
    }

    /// @notice Deploy and register a new isolated market. DEPLOYER only.
    /// @dev    All economic parameters are validated by the CreditPair constructor
    ///         (LTV < threshold < 100%, threshold*(1+bonus) <= 100%, capped rates,
    ///         oracle coverage probe). One market per collateral token.
    function deployPair(
        address collateral,
        uint256 ltvBps,
        uint256 liqThresholdBps,
        uint256 liqBonusBps,
        uint256 borrowCap,
        uint256 supplyCap,
        uint256 maxPriceAge,
        uint256 optimalUtilizationRay,
        uint256 baseRateRay,
        uint256 slope1Ray,
        uint256 slope2Ray
    ) external returns (address pair) {
        if (msg.sender != DEPLOYER) revert NotDeployer();
        if (pairFor[collateral] != address(0)) revert PairExists();
        // CreditPair hard-codes the 18-dec collateral / 6-dec USDG scaling
        // (USDG_TO_WAD): a mis-decimal listing would misprice by powers of ten,
        // and the one-pair-per-collateral registry binding is permanent, so the
        // mistake could never be relisted (audit A, I-04).
        if (collateral == USDG) revert BadCollateral();
        if (IERC20DecimalsMinimal(collateral).decimals() != 18) revert BadCollateral();

        pair = address(
            new CreditPair(
                CreditPair.PairParams({
                    collateral: collateral,
                    usdg: USDG,
                    oracle: ORACLE,
                    accumulator: ACCUMULATOR,
                    ltvBps: ltvBps,
                    liqThresholdBps: liqThresholdBps,
                    liqBonusBps: liqBonusBps,
                    borrowCap: borrowCap,
                    supplyCap: supplyCap,
                    maxPriceAge: maxPriceAge,
                    optimalUtilizationRay: optimalUtilizationRay,
                    baseRateRay: baseRateRay,
                    slope1Ray: slope1Ray,
                    slope2Ray: slope2Ray
                })
            )
        );

        pairFor[collateral] = pair;
        allPairs.push(pair);
        emit PairDeployed(pair, collateral, ltvBps, liqThresholdBps, liqBonusBps, borrowCap, supplyCap);
    }
}
