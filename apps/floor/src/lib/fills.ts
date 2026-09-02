/* MY FILLS — the connected wallet's own execution history, rebuilt from
   RouteExecuted logs on the verified NavSwapRouter. One full-range
   eth_getLogs filtered by the trader topic — no indexer, no backend.
   ADD TO WALLET fires EIP-747 wallet_watchAsset so the received token
   shows up in the user's wallet UI. */
import type { Address, Hex } from "viem";
import { FLOOR_ROUTER, TOKENS, publicClient } from "./chain";
import { STOCK_TOKENS } from "./data";
import { walletClient } from "./wallet";
import { limited } from "./nav/rpc";

/** NavSwapRouter deploy block — logs cannot exist before it. */
export const ROUTER_DEPLOY_BLOCK = 51_706_116n;

/** event RouteExecuted — field order matches NavSwapRouter.sol:201 exactly. */
export const routeExecutedEvent = {
  type: "event",
  name: "RouteExecuted",
  inputs: [
    { name: "quoteId", type: "bytes32", indexed: true },
    { name: "trader", type: "address", indexed: true },
    { name: "tokenIn", type: "address", indexed: true },
    { name: "tokenOut", type: "address", indexed: false },
    { name: "amountIn", type: "uint256", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "feeUsdg", type: "uint256", indexed: false },
    { name: "venueIn", type: "uint8", indexed: false },
    { name: "venueOut", type: "uint8", indexed: false },
    { name: "altVenue", type: "uint8", indexed: false },
    { name: "altQuote", type: "uint256", indexed: false },
  ],
} as const;

export interface Fill {
  tx: Hex;
  block: bigint;
  timestamp: number; // unix seconds
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  feeUsdg: bigint;
}

interface TokenMeta { symbol: string; decimals: number }

/** Known token registry: stocks + core pair tokens. */
const META = new Map<string, TokenMeta>([
  ...STOCK_TOKENS.map((t) => [t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals }] as const),
  ...Object.values(TOKENS).map((t) => [t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals }] as const),
  // $NAV itself — not routed by the swap desk today, listed for completeness
  ["0x3e7f2c3a81a1c8302eace254928e0fba5a3bc447", { symbol: "NAV", decimals: 18 }],
]);

export function tokenMeta(addr: Address): TokenMeta {
  return META.get(addr.toLowerCase()) ?? { symbol: `${addr.slice(0, 6)}…${addr.slice(-4)}`, decimals: 18 };
}

/** All fills for `trader`, newest first. Single full-range getLogs —
    verified to work against the Robinhood Chain RPC. */
export async function fetchMyFills(trader: Address): Promise<Fill[]> {
  const router = FLOOR_ROUTER; // const capture — TS can't narrow module lets inside closures
  if (!router) return [];
  const logs = await limited(() => publicClient.getLogs({
    address: router,
    event: routeExecutedEvent,
    args: { trader },
    fromBlock: ROUTER_DEPLOY_BLOCK,
    toBlock: "latest",
  }));
  /* timestamps: one getBlock per unique block (fills are sparse; cap 40),
     through the shared 4-lane limiter so this can't burst the RPC edge. */
  const recent = logs.slice(-40);
  const uniq = [...new Set(recent.map((l) => l.blockNumber))];
  const stamps = new Map<bigint, number>();
  await Promise.all(uniq.map(async (bn) => {
    try {
      const b = await limited(() => publicClient.getBlock({ blockNumber: bn }));
      stamps.set(bn, Number(b.timestamp));
    } catch { /* row renders block number instead */ }
  }));
  return recent
    .map((l) => ({
      tx: l.transactionHash,
      block: l.blockNumber,
      timestamp: stamps.get(l.blockNumber) ?? 0,
      tokenIn: l.args.tokenIn!,
      tokenOut: l.args.tokenOut!,
      amountIn: l.args.amountIn!,
      amountOut: l.args.amountOut!,
      feeUsdg: l.args.feeUsdg!,
    }))
    .reverse();
}

/** EIP-747: ask the connected wallet to track an ERC-20. Returns true if
    the wallet accepted. No-ops (false) when no wallet is connected. */
export async function addTokenToWallet(addr: Address): Promise<boolean> {
  const wc = walletClient();
  if (!wc) return false;
  const meta = tokenMeta(addr);
  try {
    return await wc.watchAsset({
      type: "ERC20",
      options: { address: addr, symbol: meta.symbol.slice(0, 11), decimals: meta.decimals },
    });
  } catch {
    return false;
  }
}
