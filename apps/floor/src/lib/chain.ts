/* FLOOR — floor.nav.fun · Robinhood Chain (live) — chain definition, addresses, viem client.
   All addresses verified on-chain (cast code) or sourced from official deployment docs:
   - Uniswap: developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
   - up. (up33.xyz): extracted from the live frontend bundle and verified via cast code
   - NAV protocol: nav.fun docs (deployed + Sourcify-verified this session's protocol) */
import { createPublicClient, defineChain, fallback, http, type Address } from "viem";

/** Robinhood Chain mainnet (Arbitrum Orbit L2). Chain ID 4663 = 0x1237. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const EXPLORER = "https://robinhoodchain.blockscout.com";

/** Uniswap v3 on Robinhood Chain. */
export const UNISWAP = {
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2" as Address,
  v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" as Address,
  quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
} as const;

/** up. (up33.xyz) — Velodrome-lineage DEX on Robinhood Chain. */
export const UP = {
  v2Router: "0xf5198743240fAC98db71868F34c70139b1eb0474" as Address,
  v2Factory: "0xFA5429AEBa338BEa2BFcc1b9a889862Ee395bc28" as Address,
  clSwapRouter: "0xC062b870E813fcA720f1e002c234369Ab3aB9415" as Address,
  clFactory: "0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3" as Address,
  clQuoter: "0x03983AB2C057a2eac211ff01738a1e49ff325B49" as Address,
} as const;

/** NAV protocol (nav.fun) — live. */
export const NAV = {
  vault: "0xb8F008322671179E2C93dd8610be8d5D7876087b" as Address,
  accumulator: "0x3620Da2708734d1eE64D929cF9a05EAf9a7778a0" as Address,
  pitOracleV2: "0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd" as Address,
} as const;

/** NavSwapRouter — deployed 2026-09-01, Sourcify-verified (exact match, creation + runtime).
 *  tx 0xee0d48105a14d058196cac29d26e40dcecf88edbdaa59e12992ad7eb66a03b3c · immutables
 *  cross-checked on-chain against the audited constructor args. */
export const FLOOR_ROUTER: Address | null = "0xc8156712C1A654db7dcb805D8B9De15683fdc680";

/** Interface fee taken by NavSwapRouter, in bps (compile-time constant there). */
export const FEE_BPS = 20;

export const TOKENS = {
  WETH: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address, symbol: "WETH", decimals: 18 },
  USDG: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address, symbol: "USDG", decimals: 6 },
} as const;

export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;
export const CL_TICK_SPACINGS = [1, 50, 100, 200, 2000] as const;

/* ---------- minimal ABIs ---------- */
export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const quoterV2Abi = [
  {
    type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "fee", type: "uint24" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** up. CL quoter — same shape but keyed by int24 tickSpacing. */
export const clQuoterAbi = [
  {
    type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "tickSpacing", type: "int24" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const upV2RouterAbi = [
  {
    type: "function", name: "getAmountsOut", stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      {
        name: "routes", type: "tuple[]", components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

export const v3FactoryAbi = [
  {
    type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }, { name: "b", type: "address" }, { name: "fee", type: "uint24" }],
    outputs: [{ type: "address" }],
  },
] as const;

export const v3PoolAbi = [
  {
    type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "event", name: "Swap",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "amount0", type: "int256", indexed: false },
      { name: "amount1", type: "int256", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
    ],
  },
] as const;

export const pitOracleAbi = [
  {
    type: "function", name: "anchorPrice", stateMutability: "view",
    inputs: [{ name: "underlying", type: "address" }],
    outputs: [
      { name: "price", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "fromChainlink", type: "bool" },
    ],
  },
  {
    type: "function", name: "spotTwap", stateMutability: "view",
    inputs: [{ name: "underlying", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Official Robinhood Chain RPC — always tried first. */
const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

/** Same-origin JSON-RPC relay (rpc.php at the site docroot). The official RPC
    intermittently emits a duplicated `Access-Control-Allow-Origin: *,*` header;
    when a browser connection lands on an affected upstream every request on it
    is CORS-blocked. The relay forwards the identical request server-to-server
    to the SAME official endpoint — no third party, no state. Only used when
    the direct transport fails. */
const RELAY_URL =
  typeof window !== "undefined" && window.location.protocol.startsWith("http")
    ? `${window.location.origin}/rpc.php`
    : null;

/** Shared viem public client (batched JSON-RPC + Multicall3). */
export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: RELAY_URL
    ? fallback(
        [
          http(RPC_URL, { batch: true, retryCount: 0 }), // fail fast → relay
          http(RELAY_URL, { batch: true, retryCount: 1 }),
        ],
        { rank: false, retryCount: 1 },
      )
    : http(RPC_URL, { batch: true }),
  batch: { multicall: { wait: 32 } },
});

/** Uniswap v3 sqrtPriceX96 → price of `base` quoted in `quote` (human units). */
export function sqrtPriceToPrice(
  sqrtPriceX96: bigint,
  baseIsToken0: boolean,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const raw = baseIsToken0 ? ratio : 1 / ratio;
  return raw * 10 ** (baseDecimals - quoteDecimals);
}

export function shortAddr(a: string): string {
  return a.slice(0, 6) + "…" + a.slice(-4);
}
