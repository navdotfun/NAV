/* NAV — nav.fun · Robinhood Chain (live) — chain definition, addresses, viem client */
import { createPublicClient, defineChain, http, type Address } from "viem";

/** Robinhood Chain mainnet (Arbitrum Orbit L2). Chain ID 4663 = 0x1237 ("HOOD" on a keypad). */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    // Canonical Multicall3 — verified deployed on Robinhood Chain (used by viem for batched reads).
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const EXPLORER = "https://robinhoodchain.blockscout.com";

/** Uniswap deployment on Robinhood Chain. */
export const UNISWAP = {
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2" as Address,
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904" as Address,
  v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  /** UniswapInterfaceMulticall (Uniswap's own multicall on this chain). */
  multicall: "0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3" as Address,
} as const;

/** Core tokens — sources: docs.robinhood.com/chain/contracts (WETH, USDG), docs.paxos.com (USDG),
 *  bridged USDC computed via L2GatewayRouter.calculateL2TokenAddress(USDC L1) and verified on-chain. */
export const TOKENS = {
  WETH: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address, symbol: "WETH", decimals: 18 },
  USDG: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address, symbol: "USDG", decimals: 6 },
  /** Bridged USDC via the canonical Arbitrum-style gateway. NOTE: most bridge routes convert
   *  USDC → USDG on arrival; USDG is the chain's house dollar and holds nearly all stable liquidity. */
  USDC: { address: "0x80E0e24718DbfcAd49ecAA6f1E6c89A190586ca8" as Address, symbol: "USDC", decimals: 6 },
} as const;

export const V3_FEE_TIERS = [500, 3000, 100, 10000] as const;

/* ---------- minimal ABIs ---------- */
export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
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
] as const;

/** Shared viem public client (batched JSON-RPC + Multicall3). */
export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http("https://rpc.mainnet.chain.robinhood.com", { batch: true }),
  batch: { multicall: { wait: 32 } },
});

/** Uniswap v3 sqrtPriceX96 → price of `base` quoted in `quote` (human units). */
export function sqrtPriceToPrice(
  sqrtPriceX96: bigint,
  baseIsToken0: boolean,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // token1 per token0, raw units
  const raw = baseIsToken0 ? ratio : 1 / ratio;
  return raw * 10 ** (baseDecimals - quoteDecimals);
}

export function shortAddr(a: string): string {
  return a.slice(0, 6) + "…" + a.slice(-4);
}
