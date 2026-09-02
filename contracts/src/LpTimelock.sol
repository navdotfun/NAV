// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LpTimelock — time-locked custody for a single Uniswap V3 LP position
/// @notice Holds the $NAV/WETH position NFT and makes the seeded liquidity
///         provably immovable until `unlockTime`. Deliberately minimal so a
///         reader (or a launch scanner) can verify the guarantee by eye.
///
///         THE GUARANTEE
///         -------------
///         There is NO function on this contract that can decrease liquidity.
///         Not access-controlled — absent. The contract cannot call
///         `decreaseLiquidity`, `burn`, `approve`, `setApprovalForAll`, or any
///         arbitrary target. While it owns the position, the pooled ETH and
///         $NAV cannot leave the Uniswap pool, by anyone, for any reason,
///         until `unlockTime`. That guarantee does not depend on trusting the
///         controller.
///
///         WHAT THE CONTROLLER CAN DO
///         --------------------------
///           * `release(to)` — AFTER `unlockTime` only, hand the NFT to any
///             address of the controller's choosing. Destination is chosen at
///             call time, so the operator is not locked into a wallet decided
///             at deploy time.
///           * `extend` / `extendBy` — push `unlockTime` FORWARD. There is no
///             path to shorten it. Callable before or after expiry, so an
///             expired lock can be re-armed without the NFT moving.
///           * `collectFees(to)` — forward accrued swap fees at any time. On a
///             position whose liquidity has never been decreased, Uniswap's
///             `tokensOwed` accumulators contain fees only, never principal, so
///             this cannot drain the pool.
///           * `transferController` / `acceptController` — two-step handover,
///             so custody can be rotated to a fresh wallet or a multisig
///             without touching the position. A two-step flow means a typo'd
///             address cannot orphan the lock.
///
///         WHAT NOBODY CAN DO
///         ------------------
///         Shorten the lock, withdraw liquidity before expiry, or move the NFT
///         before expiry. No owner override, no proxy, no pause, no upgrade.
///
///         This is a timelock, not a burn. After `unlockTime` the controller
///         can take the position back and withdraw the liquidity. Anyone
///         evaluating this token should read the expiry as the date the
///         liquidity becomes movable again.
contract LpTimelock {
    /// @notice Uniswap V3 NonfungiblePositionManager holding the position.
    address public immutable positionManager;

    /// @notice The position this lock was built for. Any other tokenId is
    ///         rejected on receipt.
    uint256 public immutable tokenId;

    /// @notice Unix timestamp before which the NFT cannot move. Forward-only.
    uint256 public unlockTime;

    /// @notice Address permitted to extend, collect fees, and (after expiry)
    ///         choose the release destination.
    address public controller;

    /// @notice Pending controller in the two-step handover.
    address public pendingController;

    event Locked(uint256 indexed tokenId, uint256 unlockTime, address controller);
    event Extended(uint256 oldUnlockTime, uint256 newUnlockTime);
    event Released(uint256 indexed tokenId, address indexed to);
    event FeesCollected(address indexed to, uint256 amount0, uint256 amount1);
    event ControllerTransferStarted(address indexed from, address indexed to);
    event ControllerTransferred(address indexed from, address indexed to);

    error NotController();
    error NotPendingController();
    error StillLocked(uint256 unlocksAt);
    error NotLater();
    error WrongToken();
    error NotHeld();
    error ZeroAddress();

    constructor(address positionManager_, address controller_, uint256 tokenId_, uint256 unlockTime_) {
        if (positionManager_ == address(0) || controller_ == address(0)) revert ZeroAddress();
        require(unlockTime_ > block.timestamp, "unlock in past");
        positionManager = positionManager_;
        controller = controller_;
        tokenId = tokenId_;
        unlockTime = unlockTime_;
        emit Locked(tokenId_, unlockTime_, controller_);
    }

    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    /* ───────────────────────── views ───────────────────────── */

    /// @notice True once the lock has expired.
    function unlocked() external view returns (bool) {
        return block.timestamp >= unlockTime;
    }

    /// @notice Seconds until unlock, or 0 if already unlocked.
    function timeRemaining() external view returns (uint256) {
        return block.timestamp >= unlockTime ? 0 : unlockTime - block.timestamp;
    }

    /// @notice True while this contract actually holds the position.
    function holdsPosition() external view returns (bool) {
        return IERC721(positionManager).ownerOf(tokenId) == address(this);
    }

    /* ──────────────────────── lock term ────────────────────── */

    /// @notice Push the unlock out to an absolute timestamp. Forward-only.
    function extend(uint256 newUnlockTime) external onlyController {
        if (newUnlockTime <= unlockTime) revert NotLater();
        uint256 old = unlockTime;
        unlockTime = newUnlockTime;
        emit Extended(old, newUnlockTime);
    }

    /// @notice Push the unlock out by `seconds_` from the current unlock time.
    function extendBy(uint256 seconds_) external onlyController {
        uint256 old = unlockTime;
        uint256 next = old + seconds_;
        if (next <= old) revert NotLater();
        unlockTime = next;
        emit Extended(old, next);
    }

    /* ─────────────────────── fees & release ────────────────── */

    /// @notice Send accrued swap fees to `to`. Cannot touch principal — this
    ///         contract has no way to decrease liquidity, so Uniswap's owed
    ///         balances only ever hold fees.
    function collectFees(address to) external onlyController returns (uint256 amount0, uint256 amount1) {
        if (to == address(0)) revert ZeroAddress();
        (amount0, amount1) = INonfungiblePositionManager(positionManager).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: to,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        emit FeesCollected(to, amount0, amount1);
    }

    /// @notice After `unlockTime`, hand the position NFT to any address the
    ///         controller chooses.
    function release(address to) external onlyController {
        if (to == address(0)) revert ZeroAddress();
        if (block.timestamp < unlockTime) revert StillLocked(unlockTime);
        if (IERC721(positionManager).ownerOf(tokenId) != address(this)) revert NotHeld();
        IERC721(positionManager).transferFrom(address(this), to, tokenId);
        emit Released(tokenId, to);
    }

    /* ──────────────────── controller handover ──────────────── */

    /// @notice Begin handing custody to `newController`. Takes effect only when
    ///         that address calls `acceptController`.
    function transferController(address newController) external onlyController {
        if (newController == address(0)) revert ZeroAddress();
        pendingController = newController;
        emit ControllerTransferStarted(controller, newController);
    }

    /// @notice Complete the handover. Must be called by the pending controller.
    function acceptController() external {
        if (msg.sender != pendingController) revert NotPendingController();
        address old = controller;
        controller = pendingController;
        pendingController = address(0);
        emit ControllerTransferred(old, controller);
    }

    /* ────────────────────────── receipt ────────────────────── */

    /// @notice Accept only the position this lock was built for.
    function onERC721Received(address, address, uint256 id, bytes calldata) external view returns (bytes4) {
        if (msg.sender != positionManager) revert WrongToken();
        if (id != tokenId) revert WrongToken();
        return this.onERC721Received.selector;
    }
}

interface IERC721 {
    function ownerOf(uint256) external view returns (address);
    function transferFrom(address, address, uint256) external;
}

interface INonfungiblePositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata) external payable returns (uint256 amount0, uint256 amount1);
}
