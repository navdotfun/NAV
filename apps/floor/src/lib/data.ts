/* FLOOR — market data layer: pool discovery, live prices, anchors, tape.
   Everything on-chain via multicall-batched reads. No synthetic data. */
import type { Address } from "viem";
import {
  publicClient, UNISWAP, NAV, TOKENS,
  erc20Abi, v3FactoryAbi, v3PoolAbi, pitOracleAbi, sqrtPriceToPrice,
} from "./chain";
import rawTokens from "./stocktokens.json";
import { limited, isRevert } from "./nav/rpc";

export interface StockToken {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
}

export const STOCK_TOKENS: StockToken[] = (rawTokens as StockToken[]).map((t) => ({ ...t }));
export const TOKEN_BY_ADDR = new Map(STOCK_TOKENS.map((t) => [t.address.toLowerCase(), t]));
export const TOKEN_BY_SYMBOL = new Map(STOCK_TOKENS.map((t) => [t.symbol, t]));

const USDG = TOKENS.USDG.address;

export interface Listing {
  token: StockToken;
  pool: Address;
  fee: number;
  baseIsToken0: boolean;
  /** USDG side of the pool (proxy for depth) */
  usdgDepth: number;
  price: number;
  tick: number;
}

let listingsCache: Listing[] | null = null;
let listingsInFlight: Promise<Listing[]> | null = null;

/** Discover the deepest USDG-paired UniV3 pool for every stock token.
    Success is cached for the session; concurrent callers share one flight;
    a failed flight clears the slot so the next call retries. */
export async function discoverListings(): Promise<Listing[]> {
  if (listingsCache) return listingsCache;
  if (listingsInFlight) return listingsInFlight;
  listingsInFlight = discoverListingsRaw()
    .then((ls) => { listingsCache = ls; return ls; })
    .finally(() => { listingsInFlight = null; });
  return listingsInFlight;
}

async function discoverListingsRaw(): Promise<Listing[]> {
  const fees = [500, 3000, 10000] as const;

  const poolCalls = STOCK_TOKENS.flatMap((t) =>
    fees.map((fee) => ({
      address: UNISWAP.v3Factory,
      abi: v3FactoryAbi,
      functionName: "getPool" as const,
      args: [t.address, USDG, fee] as const,
    })),
  );
  const poolResults = await limited(() => publicClient.multicall({ contracts: poolCalls, allowFailure: true }));

  interface Cand { token: StockToken; pool: Address; fee: number }
  const cands: Cand[] = [];
  poolResults.forEach((r, i) => {
    if (r.status !== "success") return;
    const pool = r.result as Address;
    if (pool === "0x0000000000000000000000000000000000000000") return;
    cands.push({ token: STOCK_TOKENS[Math.floor(i / fees.length)], pool, fee: fees[i % fees.length] });
  });

  // depth (USDG balance) + slot0 + token0 for every candidate
  const detail = await limited(() => publicClient.multicall({
    contracts: cands.flatMap((c) => [
      { address: USDG, abi: erc20Abi, functionName: "balanceOf" as const, args: [c.pool] as const },
      { address: c.pool, abi: v3PoolAbi, functionName: "slot0" as const },
      { address: c.pool, abi: v3PoolAbi, functionName: "token0" as const },
    ]),
    allowFailure: true,
  }));

  const bySymbol = new Map<string, Listing>();
  cands.forEach((c, i) => {
    const bal = detail[i * 3], slot = detail[i * 3 + 1], t0 = detail[i * 3 + 2];
    if (bal.status !== "success" || slot.status !== "success" || t0.status !== "success") return;
    const usdgDepth = Number(bal.result as bigint) / 1e6;
    if (usdgDepth < 1) return; // dust pool
    const s = slot.result as readonly [bigint, number, number, number, number, number, boolean];
    const baseIsToken0 = (t0.result as Address).toLowerCase() === c.token.address.toLowerCase();
    const price = sqrtPriceToPrice(s[0], baseIsToken0, c.token.decimals, 6);
    const existing = bySymbol.get(c.token.symbol);
    if (!existing || usdgDepth > existing.usdgDepth) {
      bySymbol.set(c.token.symbol, { token: c.token, pool: c.pool, fee: c.fee, baseIsToken0, usdgDepth, price, tick: s[1] });
    }
  });

  return [...bySymbol.values()].sort((a, b) => b.usdgDepth - a.usdgDepth);
}

/** Refresh slot0 prices for known listings (cheap poll). */
export async function refreshPrices(listings: Listing[]): Promise<Listing[]> {
  const res = await publicClient.multicall({
    contracts: listings.map((l) => ({ address: l.pool, abi: v3PoolAbi, functionName: "slot0" as const })),
    allowFailure: true,
  });
  return listings.map((l, i) => {
    const r = res[i];
    if (r.status !== "success") return l;
    const s = r.result as readonly [bigint, number, number, number, number, number, boolean];
    return { ...l, price: sqrtPriceToPrice(s[0], l.baseIsToken0, l.token.decimals, 6), tick: s[1] };
  });
}

export interface Anchor {
  price: number;      // USDG per token, human units
  updatedAt: number;  // unix seconds
  source: "CHAINLINK" | "PYTH";
}

/** Fair-Price Shield anchor via PitOracleV2 (Chainlink primary, Pyth fallback).
    Only Pit-listed underlyings have anchors; others resolve to null. */
export async function fetchAnchor(underlying: Address): Promise<Anchor | null> {
  try {
    const [price, updatedAt, fromChainlink] = await limited(() => publicClient.readContract({
      address: NAV.pitOracleV2,
      abi: pitOracleAbi,
      functionName: "anchorPrice",
      args: [underlying],
    }));
    if (price === 0n) return null;
    return {
      price: Number(price) / 1e18,
      updatedAt: Number(updatedAt),
      source: fromChainlink ? "CHAINLINK" : "PYTH",
    };
  } catch (e) {
    if (isRevert(e)) return null; // genuinely unanchored underlying
    throw e;                      // transport — caller keeps last-good
  }
}

export interface TapePrint {
  id: string;
  ts: number;         // block timestamp (unix s)
  symbol: string;
  side: "BUY" | "SELL"; // relative to the stock (BUY = USDG in, stock out)
  qty: number;          // stock units
  price: number;        // USDG per unit
  notional: number;     // USDG
  txHash: string;
}

/** Times & sales: real Swap events from the deepest stock/USDG pools.
    The chain prints thousands of swaps per hour, so the window is kept small
    (~6k blocks ≈ 25 min) and widened once only if it comes back empty —
    a 60k-block × 12-pool query overruns the RPC response limit. */
export async function fetchTape(listings: Listing[]): Promise<TapePrint[]> {
  const top = listings.slice(0, 12);
  if (top.length === 0) return [];
  const latest = await limited(() => publicClient.getBlockNumber());
  const event = v3PoolAbi.find((x) => x.type === "event")!;
  const query = (from: bigint, to: bigint) => limited(() => publicClient.getLogs({
    address: top.map((l) => l.pool),
    event,
    fromBlock: from < 0n ? 0n : from,
    toBlock: to,
  }));
  let logs = await query(latest - 6_000n, latest);
  if (logs.length === 0) {
    logs = await query(latest - 60_000n, latest - 6_000n).catch(() => []);
  }
  logs = logs.slice(-400); // newest tail is enough for a 60-print tape
  const byPool = new Map(top.map((l) => [l.pool.toLowerCase(), l]));
  const blockNums = [...new Set(logs.map((l) => l.blockNumber))].slice(-40);
  const blocks = await Promise.all(blockNums.map((n) => limited(() => publicClient.getBlock({ blockNumber: n })).catch(() => null)));
  const tsByBlock = new Map(blocks.filter(Boolean).map((b) => [b!.number, Number(b!.timestamp)]));

  const prints: TapePrint[] = [];
  for (const log of logs) {
    const l = byPool.get(log.address.toLowerCase());
    if (!l) continue;
    const { amount0, amount1, sqrtPriceX96 } = log.args as { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint };
    const stockAmt = l.baseIsToken0 ? amount0 : amount1;
    const usdgAmt = l.baseIsToken0 ? amount1 : amount0;
    const qty = Math.abs(Number(stockAmt)) / 10 ** l.token.decimals;
    const notional = Math.abs(Number(usdgAmt)) / 1e6;
    if (qty === 0 || notional < 0.01) continue;
    prints.push({
      id: `${log.transactionHash}-${log.logIndex}`,
      ts: tsByBlock.get(log.blockNumber) ?? 0,
      symbol: l.token.symbol,
      side: stockAmt < 0n ? "BUY" : "SELL",
      qty,
      price: sqrtPriceToPrice(sqrtPriceX96, l.baseIsToken0, l.token.decimals, 6),
      notional,
      txHash: log.transactionHash,
    });
  }
  return prints.filter((p) => p.ts > 0).sort((a, b) => b.ts - a.ts).slice(0, 60);
}
