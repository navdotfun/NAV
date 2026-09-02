// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LpTimelock} from "./LpTimelock.sol";

/// @title NavLister — atomic TGE listing for $NAV / WETH
/// @notice Executes the entire listing in ONE transaction so there is no gap
///         between mint and lock, and no dependence on a tokenId predicted at
///         simulation time (position ids on the shared NonfungiblePositionManager
///         advance constantly, so any pre-computed id goes stale):
///
///           1. pull $NAV from the caller (prior approval required)
///           2. wrap the ETH sent with the call
///           3. createAndInitializePoolIfNecessary at the given sqrtPriceX96
///           4. mint the full-range position to THIS contract — the real
///              tokenId is returned right here, in-tx
///           5. deploy LpTimelock bound to that exact tokenId
///           6. safeTransferFrom the position into the timelock
///           7. refund any rounding dust (WETH + NAV) to the caller
///
///         If anything in the sequence reverts, the whole listing reverts and
///         all funds stay with the caller.
contract NavLister {
    address public constant NAV = 0x3e7f2c3A81a1c8302eacE254928e0fBa5A3Bc447;
    address public constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address public constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address public constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;

    uint24 public constant FEE = 10000; // 1%, tickSpacing 200
    int24 public constant MIN_TICK = -887200;
    int24 public constant MAX_TICK = 887200;

    event Listed(address pool, uint256 tokenId, address timelock, uint128 liquidity, uint256 wethUsed, uint256 navUsed);

    /// @param navAmount    $NAV to place in the pool (approve this contract first)
    /// @param sqrtPriceX96 opening price, computed off-chain from navAmount / msg.value
    /// @param controller   LpTimelock controller (extend / collectFees / release)
    /// @param lockDays     lock term in days
    function list(uint256 navAmount, uint160 sqrtPriceX96, address controller, uint256 lockDays)
        external
        payable
        returns (address pool, uint256 tokenId, address timelock)
    {
        require(msg.value > 0 && navAmount > 0, "zero side");
        require(lockDays > 0, "lock term");
        // The pool must not pre-exist: a pre-existing pool could sit at a
        // different price and skew the mint ratio.
        require(IUniswapV3Factory(V3_FACTORY).getPool(WETH, NAV, FEE) == address(0), "pool exists");

        // 1. pull NAV
        require(IERC20(NAV).transferFrom(msg.sender, address(this), navAmount), "NAV pull");

        // 2. wrap ETH
        IWETH(WETH).deposit{value: msg.value}();

        // 3. approvals + pool creation at target price
        IERC20(WETH).approve(NPM, msg.value);
        IERC20(NAV).approve(NPM, navAmount);
        pool = INPM(NPM).createAndInitializePoolIfNecessary(WETH, NAV, FEE, sqrtPriceX96);

        // 4. full-range mint to this contract — real tokenId returned in-tx
        (uint256 id, uint128 liquidity, uint256 used0, uint256 used1) = INPM(NPM).mint(
            INPM.MintParams({
                token0: WETH,
                token1: NAV,
                fee: FEE,
                tickLower: MIN_TICK,
                tickUpper: MAX_TICK,
                amount0Desired: msg.value,
                amount1Desired: navAmount,
                amount0Min: (msg.value * 995) / 1000,
                amount1Min: (navAmount * 995) / 1000,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        tokenId = id;

        // 5. lock bound to the actual tokenId
        LpTimelock lock = new LpTimelock(NPM, controller, tokenId, block.timestamp + lockDays * 1 days);
        timelock = address(lock);

        // 6. move the position in (onERC721Received verifies the id)
        IERC721(NPM).safeTransferFrom(address(this), timelock, tokenId);

        // 7. refund dust
        uint256 wethDust = IERC20(WETH).balanceOf(address(this));
        uint256 navDust = IERC20(NAV).balanceOf(address(this));
        if (wethDust > 0) IERC20(WETH).transfer(msg.sender, wethDust);
        if (navDust > 0) IERC20(NAV).transfer(msg.sender, navDust);

        emit Listed(pool, tokenId, timelock, liquidity, used0, used1);
    }

    /// @notice Accept position NFTs during the mint step.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

interface IWETH {
    function deposit() external payable;
}

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC721 {
    function safeTransferFrom(address, address, uint256) external;
}

interface IUniswapV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

interface INPM {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(address, address, uint24, uint160) external payable returns (address);
    function mint(MintParams calldata) external payable returns (uint256, uint128, uint256, uint256);
}
