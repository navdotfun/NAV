// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {Strings} from "openzeppelin-contracts/contracts/utils/Strings.sol";
import {Base64} from "openzeppelin-contracts/contracts/utils/Base64.sol";

/// @title PitTicket — ERC-721 option positions for The Pit
/// @notice One ticket = one option position (side, strike, expiry, qty) in a PitPool.
///         Mint/burn is restricted to pools registered by the PitFactory.
///         Uses plain `_mint` — no receiver callback, no reentrancy surface on mint
///         (OWASP SCWE-138 / Panoptic C4 2023-11 class eliminated by construction).
///         tokenURI is fully on-chain (pixel ticket SVG).
contract PitTicket is ERC721 {
    using Strings for uint256;

    struct TicketData {
        address pool; // issuing PitPool
        address underlying;
        bool isCall;
        uint64 expiry;
        uint128 strike1e18; // quote per whole underlying, 1e18 fp (fits: < 3.4e38)
        uint128 qty; // 1e18 = 1 contract on 1 whole underlying
        uint128 premiumPaid; // quote wei actually paid (incl. fee)
        uint128 writeMultiplier; // uiMultiplier at write (1e18 default)
    }

    address public immutable factory;
    uint256 public nextId = 1;
    mapping(uint256 => TicketData) public tickets;
    mapping(address => bool) public isPool;

    event PoolRegistered(address indexed pool);

    error OnlyFactory();
    error OnlyPool();

    constructor(address factory_) ERC721("Pit Ticket", "PITTKT") {
        factory = factory_;
    }

    function registerPool(address pool) external {
        if (msg.sender != factory) revert OnlyFactory();
        isPool[pool] = true;
        emit PoolRegistered(pool);
    }

    /// @dev CEI-safe: state written before _mint; _mint performs no external call.
    function mint(address to, TicketData calldata d) external returns (uint256 id) {
        if (!isPool[msg.sender]) revert OnlyPool();
        id = nextId++;
        tickets[id] = d;
        _mint(to, id);
    }

    /// @dev Only the issuing pool may burn (on settlement/exercise).
    function burn(uint256 id) external {
        if (msg.sender != tickets[id].pool) revert OnlyPool();
        delete tickets[id];
        _burn(id);
    }

    function getTicket(uint256 id) external view returns (TicketData memory) {
        return tickets[id];
    }

    function ownerOfTicket(uint256 id) external view returns (address) {
        return _ownerOf(id);
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        TicketData memory d = tickets[id];
        string memory side = d.isCall ? "CALL" : "PUT";
        string memory strikeStr = _fp(d.strike1e18);
        string memory qtyStr = _fp(d.qty);
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" style="image-rendering:pixelated">',
            '<rect width="600" height="300" fill="#0B1622"/>',
            '<rect x="12" y="12" width="576" height="276" fill="none" stroke="#C9A227" stroke-width="4" stroke-dasharray="12 6"/>',
            '<text x="36" y="70" font-family="monospace" font-size="34" fill="#4AE58A">PIT TICKET #',
            id.toString(),
            '</text><text x="36" y="120" font-family="monospace" font-size="26" fill="#F5F1E8">',
            side,
            ' &#183; STRIKE ',
            strikeStr,
            '</text><text x="36" y="160" font-family="monospace" font-size="22" fill="#8FA3B8">QTY ',
            qtyStr,
            ' &#183; EXP ',
            uint256(d.expiry).toString(),
            '</text><text x="36" y="240" font-family="monospace" font-size="18" fill="#5C6B7A">NAV &#183; THE PIT &#183; FULLY COLLATERALIZED</text></svg>'
        );
        string memory json = string.concat(
            '{"name":"Pit Ticket #',
            id.toString(),
            '","description":"Fully collateralized ',
            side,
            ' option on The Pit (nav.fun).","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev render 1e18 fp with 2 decimals
    function _fp(uint256 x) internal pure returns (string memory) {
        uint256 whole = x / 1e18;
        uint256 cents = (x % 1e18) / 1e16;
        return string.concat(whole.toString(), ".", cents < 10 ? string.concat("0", cents.toString()) : cents.toString());
    }
}
