// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {PitPool, IPitOracle} from "./PitPool.sol";
import {PitTicket} from "./PitTicket.sol";
import {PitPoolDeployer} from "./PitPoolDeployer.sol";

interface INAVVaultRegistry {
    function assetInfo(address asset) external view returns (bool listed, bool active, uint64 addedAt);
}

interface IERC20DecimalsView {
    function decimals() external view returns (uint8);
}

/// @title PitFactory — deploys and parameterizes PitPools
/// @notice One pool per underlying; underlyings must be listed in the NAVVault registry.
///         Holds the ONLY mutable protocol parameters (fee bps, keeper bps, pause) —
///         all hard-bounded, none can touch pool funds. Pause blocks new deposits and
///         buys only; withdrawals, settlement and exercise can never be paused.
contract PitFactory is Ownable2Step {
    uint16 public constant BPS = 10_000;
    // hard parameter bounds
    uint16 public constant MIN_PIT_FEE_BPS = 50; // 0.5% of premium
    uint16 public constant MAX_PIT_FEE_BPS = 500; // 5% of premium
    uint16 public constant MAX_KEEPER_FEE_BPS = 100; // 1% of payout
    uint16 public constant MIN_SIGMA_BPS = 2_000; // 20% annualized
    uint16 public constant MAX_SIGMA_BPS = 30_000; // 300% annualized

    INAVVaultRegistry public immutable vault;
    IPitOracle public immutable oracle;
    PitTicket public immutable ticket;
    /// @dev Holds PitPool's creation code so this factory fits EIP-170. Pure
    ///      deployment helper — no funds, no parameters, no pool authority.
    PitPoolDeployer public immutable poolDeployer;
    IERC20 public immutable quote; // USDG — same asset FeeSplitter distributes
    address public immutable feeSink; // existing FeeSplitter

    bool public paused;
    uint16 public pitFeeBps = 200; // 2% of premium
    uint16 public keeperFeeBps = 25; // 0.25% of payout

    mapping(address => address) public poolFor; // underlying => pool
    address[] public allPools;

    event PoolCreated(address indexed underlying, address pool, uint256 strikeSpacing, uint16 sigmaBps, uint128 maxOi);
    event PausedSet(bool paused);
    event PitFeeSet(uint16 bps);
    event KeeperFeeSet(uint16 bps);

    error AlreadyExists();
    error NotInRegistry();
    error OutOfBounds();
    error ZeroAddress();
    error OracleQuoteMismatch(); // M-04: oracle market quote must equal the pool quote

    constructor(address owner_, address vault_, address oracle_, address quote_, address feeSink_) Ownable(owner_) {
        if (vault_ == address(0) || oracle_ == address(0) || quote_ == address(0) || feeSink_ == address(0)) {
            revert ZeroAddress();
        }
        vault = INAVVaultRegistry(vault_);
        oracle = IPitOracle(oracle_);
        quote = IERC20(quote_);
        feeSink = feeSink_;
        ticket = new PitTicket(address(this));
        PitPoolDeployer d = new PitPoolDeployer();
        d.setFactory(address(this));
        poolDeployer = d;
    }

    /// @notice Deploy the pool for `underlying`. Requires a NAVVault registry listing
    ///         and a configured oracle market. Pool params are immutable after deploy.
    function createPool(address underlying, uint256 strikeSpacing, uint16 sigmaBps, uint128 maxOiPerSeries)
        external
        onlyOwner
        returns (address pool)
    {
        if (poolFor[underlying] != address(0)) revert AlreadyExists();
        // M-04: honour the registry `active` flag, not just `listed`
        (bool listed, bool active,) = vault.assetInfo(underlying);
        if (!listed || !active) revert NotInRegistry();
        if (sigmaBps < MIN_SIGMA_BPS || sigmaBps > MAX_SIGMA_BPS) revert OutOfBounds();
        if (strikeSpacing == 0 || maxOiPerSeries == 0) revert OutOfBounds();
        // oracle market must exist (reverts inside if unknown)
        oracle.spotTwap(underlying);
        // M-04: the oracle market must be denominated in THIS factory's quote asset,
        // otherwise the pool prices in one asset and collateralises in another.
        _requireOracleQuote(underlying);

        uint256 uScale = 10 ** IERC20DecimalsView(underlying).decimals();
        uint256 qScale = 10 ** IERC20DecimalsView(address(quote)).decimals();
        pool = poolDeployer.deploy(
            IERC20(underlying), quote, oracle, ticket, strikeSpacing, uScale, qScale, sigmaBps, maxOiPerSeries
        );
        poolFor[underlying] = pool;
        allPools.push(pool);
        ticket.registerPool(pool);
        emit PoolCreated(underlying, pool, strikeSpacing, sigmaBps, maxOiPerSeries);
    }

    // ---------------------------------------------------------------- params (bounded)

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function setPitFeeBps(uint16 bps) external onlyOwner {
        if (bps < MIN_PIT_FEE_BPS || bps > MAX_PIT_FEE_BPS) revert OutOfBounds();
        pitFeeBps = bps;
        emit PitFeeSet(bps);
    }

    function setKeeperFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_KEEPER_FEE_BPS) revert OutOfBounds();
        keeperFeeBps = bps;
        emit KeeperFeeSet(bps);
    }

    function poolCount() external view returns (uint256) {
        return allPools.length;
    }

    /// @dev Read the oracle market's quote asset without binding to a concrete oracle
    ///      version. Both PitOracle v1 and PitOracleV2 expose a public `markets(address)`
    ///      whose first three words are (pool, underlying, quote), so decoding the first
    ///      three words is version-agnostic.
    function _requireOracleQuote(address underlying) internal view {
        (bool ok, bytes memory ret) =
            address(oracle).staticcall(abi.encodeWithSignature("markets(address)", underlying));
        if (!ok || ret.length < 96) revert NotInRegistry();
        address oQuote;
        assembly {
            oQuote := mload(add(ret, 0x60)) // third word of the return data
        }
        if (oQuote != address(quote)) revert OracleQuoteMismatch();
    }
}
