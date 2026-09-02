/* ANALYTICS — protocol-wide aggregates, rebuilt on demand from chain logs
   and live contract reads. No indexer, no backend, no cache server: every
   number on the STATS page derives from eth_getLogs + eth_call against the
   verified contracts.

   Volume identity: NavSwapRouter charges FEE_BPS (20 bps) of the USDG
   notional on every fill, so notional = feeUsdg * 10000 / FEE_BPS. This is
   exact per the audited contract, uniform across pairs and venues. */
import { formatUnits } from "viem";
import { FEE_BPS, FLOOR_ROUTER, publicClient } from "./chain";
import { ROUTER_DEPLOY_BLOCK, routeExecutedEvent, tokenMeta } from "./fills";
import { PIT } from "./nav/pit";
import { loadOptMarkets, NAV_OPTIONS } from "./options";
import { limited } from "./nav/rpc";

/** Safe lower bound for NavOptions logs — first on-chain event (MarketListed)
    sits at block 51,908,261; scanning from just below costs nothing extra. */
export const OPTIONS_DEPLOY_BLOCK = 51_908_000n;

/* Polite RPC scheduling lives in ./nav/rpc — one shared 4-lane queue for
   the whole app (STATS, vault history, fills), so concurrently mounted
   views can never combine into a burst the RPC edge would reset. */

/* ---------- shared: block → unix time with bounded RPC cost ---------- */

const timeCache = new Map<bigint, number>();

/** Exact timestamps for ≤ `exactCap` unique blocks; beyond that, linear
    interpolation between the exact endpoints (charts stay honest at any
    scale without unbounded getBlock fan-out). */
async function stampBlocks(blocks: bigint[], exactCap = 120): Promise<Map<bigint, number>> {
  const uniq = [...new Set(blocks)].sort((a, b) => (a < b ? -1 : 1));
  const out = new Map<bigint, number>();
  if (uniq.length === 0) return out;
  const fetchOne = async (bn: bigint) => {
    const hit = timeCache.get(bn);
    if (hit !== undefined) { out.set(bn, hit); return; }
    const b = await limited(() => publicClient.getBlock({ blockNumber: bn }));
    timeCache.set(bn, Number(b.timestamp));
    out.set(bn, Number(b.timestamp));
  };
  if (uniq.length <= exactCap) {
    await Promise.all(uniq.map(fetchOne));
    return out;
  }
  const first = uniq[0], last = uniq[uniq.length - 1];
  await Promise.all([fetchOne(first), fetchOne(last)]);
  const t0 = out.get(first)!, t1 = out.get(last)!;
  const span = Number(last - first) || 1;
  for (const bn of uniq) {
    if (!out.has(bn)) out.set(bn, Math.round(t0 + ((t1 - t0) * Number(bn - first)) / span));
  }
  return out;
}

function hourLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:00`;
}

/* ------------------------------ SWAP ------------------------------ */

const VENUE_NAMES: Record<number, string> = { 1: "UNISWAP V3", 2: "UP CL", 3: "UP V2" };

export interface SwapStats {
  fills: number;
  traders: number;
  volumeUsdg: number;
  feesUsdg: number;
  venues: { name: string; legs: number }[];
  pairs: { pair: string; volume: number }[];
  buckets: { label: string; volume: number; cumFees: number }[];
}

/* A-13: incremental scan cursors — emitted logs are immutable, so each poll
   fetches ONLY [cursor+1, tip] and appends to the module cache instead of
   rescanning from the deploy block every 60s. On any RPC failure the cursor
   does not advance and the next poll retries the same range. */
let swapCursor: bigint | null = null;
let swapLogCache: Awaited<ReturnType<typeof getSwapLogs>> = [];
async function getSwapLogs(fromBlock: bigint, toBlock: bigint) {
  return limited(() => publicClient.getLogs({
    address: FLOOR_ROUTER!, event: routeExecutedEvent, fromBlock, toBlock,
  }));
}

export async function fetchSwapStats(): Promise<SwapStats | null> {
  if (!FLOOR_ROUTER) return null;
  const latest = await limited(() => publicClient.getBlockNumber({ cacheTime: 0 }));
  const from = swapCursor === null ? ROUTER_DEPLOY_BLOCK : swapCursor + 1n;
  if (from <= latest) {
    swapLogCache = swapLogCache.concat(await getSwapLogs(from, latest));
    swapCursor = latest;
  }
  const logs = swapLogCache;
  const stamps = await stampBlocks(logs.map((l) => l.blockNumber));
  const traders = new Set<string>();
  const venues = new Map<string, number>();
  const pairs = new Map<string, number>();
  const hours = new Map<string, { volume: number; fees: number; ts: number }>();
  let volume = 0, fees = 0;
  for (const l of logs) {
    const fee = Number(formatUnits(l.args.feeUsdg!, 6));
    const vol = (fee * 10_000) / FEE_BPS;
    fees += fee; volume += vol;
    traders.add(l.args.trader!.toLowerCase());
    for (const v of [l.args.venueIn!, l.args.venueOut!]) {
      const name = VENUE_NAMES[v];
      if (name) venues.set(name, (venues.get(name) ?? 0) + 1);
    }
    const pair = `${tokenMeta(l.args.tokenIn!).symbol}→${tokenMeta(l.args.tokenOut!).symbol}`;
    pairs.set(pair, (pairs.get(pair) ?? 0) + vol);
    const ts = stamps.get(l.blockNumber) ?? 0;
    const label = hourLabel(ts);
    const h = hours.get(label) ?? { volume: 0, fees: 0, ts };
    h.volume += vol; h.fees += fee;
    hours.set(label, h);
  }
  let cum = 0;
  const buckets = [...hours.entries()]
    .sort((a, b) => a[1].ts - b[1].ts)
    .map(([label, h]) => ({ label, volume: h.volume, cumFees: (cum += h.fees) }));
  return {
    fills: logs.length,
    traders: traders.size,
    volumeUsdg: volume,
    feesUsdg: fees,
    venues: [...venues.entries()].map(([name, legs]) => ({ name, legs })).sort((a, b) => b.legs - a.legs),
    pairs: [...pairs.entries()].map(([pair, v]) => ({ pair, volume: v })).sort((a, b) => b.volume - a.volume).slice(0, 8),
    buckets,
  };
}

/* ----------------------------- OPTIONS ----------------------------- */

const openedEvent = {
  type: "event", name: "Opened",
  inputs: [
    { name: "id", type: "uint256", indexed: true },
    { name: "buyer", type: "address", indexed: true },
    { name: "marketId", type: "uint256", indexed: true },
    { name: "isCall", type: "bool", indexed: false },
    { name: "bucket", type: "uint8", indexed: false },
    { name: "size", type: "uint128", indexed: false },
    { name: "strike", type: "uint128", indexed: false },
    { name: "expiry", type: "uint64", indexed: false },
    { name: "premium", type: "uint256", indexed: false },
    { name: "origination", type: "uint256", indexed: false },
    { name: "notional", type: "uint256", indexed: false },
  ],
} as const;

const settledEvent = {
  type: "event", name: "Settled",
  inputs: [
    { name: "id", type: "uint256", indexed: true },
    { name: "settler", type: "address", indexed: true },
    { name: "settlePrice", type: "uint256", indexed: false },
    { name: "payout", type: "uint256", indexed: false },
    { name: "bounty", type: "uint256", indexed: false },
    { name: "releasedToVault", type: "uint256", indexed: false },
  ],
} as const;

export interface OptionsFlow {
  opened: number;
  settled: number;
  open: number;
  buyers: number;
  premiumUsdg: number;   // premium + origination paid by buyers
  notionalUsdg: number;  // notional opened, lifetime
  callsOpened: number;
  putsOpened: number;
}

/* A-13: incremental cursors for the options flow scans. */
let optCursor: bigint | null = null;
let openedCache: Awaited<ReturnType<typeof getOpenedLogs>> = [];
let settledCache: Awaited<ReturnType<typeof getSettledLogs>> = [];
async function getOpenedLogs(fromBlock: bigint, toBlock: bigint) {
  return limited(() => publicClient.getLogs({ address: NAV_OPTIONS!, event: openedEvent, fromBlock, toBlock }));
}
async function getSettledLogs(fromBlock: bigint, toBlock: bigint) {
  return limited(() => publicClient.getLogs({ address: NAV_OPTIONS!, event: settledEvent, fromBlock, toBlock }));
}

export async function fetchOptionsFlow(): Promise<OptionsFlow | null> {
  if (!NAV_OPTIONS) return null;
  const latest = await limited(() => publicClient.getBlockNumber({ cacheTime: 0 }));
  const from = optCursor === null ? OPTIONS_DEPLOY_BLOCK : optCursor + 1n;
  if (from <= latest) {
    // both ranges must land before the cursor advances — no partial appends
    const [o, s] = await Promise.all([getOpenedLogs(from, latest), getSettledLogs(from, latest)]);
    openedCache = openedCache.concat(o);
    settledCache = settledCache.concat(s);
    optCursor = latest;
  }
  const opened = openedCache, settled = settledCache;
  const buyers = new Set<string>();
  let premium = 0, notional = 0, calls = 0, puts = 0;
  for (const l of opened) {
    buyers.add(l.args.buyer!.toLowerCase());
    premium += Number(formatUnits(l.args.premium! + l.args.origination!, 6));
    notional += Number(formatUnits(l.args.notional!, 6));
    if (l.args.isCall) calls += 1; else puts += 1;
  }
  return {
    opened: opened.length,
    settled: settled.length,
    open: Math.max(0, opened.length - settled.length),
    buyers: buyers.size,
    premiumUsdg: premium,
    notionalUsdg: notional,
    callsOpened: calls,
    putsOpened: puts,
  };
}

/** Live per-market desk utilization, straight off the options vaults. */
export interface DeskRow {
  symbol: string;
  /** null = the underlying read failed this poll — render “—”, never 0. */
  oiUsdg: number | null;
  callFree: number | null;   // stock units valued in USDG at oracle price
  callEscrow: number | null;
  putFree: number | null;    // USDG
  putEscrow: number | null;
}

export async function fetchOptionsDesks(): Promise<DeskRow[]> {
  const markets = await loadOptMarkets();
  return markets.map((m) => {
    const px = m.price !== null && m.price > 0 ? m.price : null; // null = oracle read failed (R4 F-01)
    return {
      symbol: m.symbol,
      oiUsdg: m.oiNotional !== null ? Number(formatUnits(m.oiNotional, 6)) : null,
      callFree: m.callVault !== null && px !== null ? Number(formatUnits(m.callVault.freeAssets, 18)) * px : null,
      callEscrow: m.callVault !== null && px !== null ? Number(formatUnits(m.callVault.escrowed, 18)) * px : null,
      putFree: m.putVault !== null ? Number(formatUnits(m.putVault.freeAssets, 6)) : null,
      putEscrow: m.putVault !== null ? Number(formatUnits(m.putVault.escrowed, 6)) : null,
    };
  });
}

/* ------------------------------- PIT ------------------------------- */

const erc721TransferEvent = {
  type: "event", name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "tokenId", type: "uint256", indexed: true },
  ],
} as const;

const ZERO = "0x0000000000000000000000000000000000000000";

export interface PitFlow {
  minted: number;
  open: number;
  holders: number;
  cumulative: { label: string; count: number }[];
}

/* A-13: incremental cursor for the pit ticket Transfer scan. */
let pitCursor: bigint | null = null;
let pitLogCache: Awaited<ReturnType<typeof getPitLogs>> = [];
async function getPitLogs(fromBlock: bigint, toBlock: bigint) {
  return limited(() => publicClient.getLogs({
    address: PIT.ticket, event: erc721TransferEvent, fromBlock, toBlock,
  }));
}

export async function fetchPitFlow(): Promise<PitFlow> {
  const latest = await limited(() => publicClient.getBlockNumber({ cacheTime: 0 }));
  const from = pitCursor === null ? PIT.ticketDeployBlock : pitCursor + 1n;
  if (from <= latest) {
    pitLogCache = pitLogCache.concat(await getPitLogs(from, latest));
    pitCursor = latest;
  }
  const logs = pitLogCache;
  const owner = new Map<string, string>(); // tokenId → current owner
  const mints: { block: bigint }[] = [];
  for (const l of logs) {
    const id = l.args.tokenId!.toString();
    if (l.args.from!.toLowerCase() === ZERO) mints.push({ block: l.blockNumber });
    if (l.args.to!.toLowerCase() === ZERO) owner.delete(id);
    else owner.set(id, l.args.to!.toLowerCase());
  }
  const stamps = await stampBlocks(mints.map((m) => m.block));
  const byHour = new Map<string, { ts: number; n: number }>();
  for (const m of mints) {
    const ts = stamps.get(m.block) ?? 0;
    const label = hourLabel(ts);
    const h = byHour.get(label) ?? { ts, n: 0 };
    h.n += 1;
    byHour.set(label, h);
  }
  let cum = 0;
  const cumulative = [...byHour.entries()]
    .sort((a, b) => a[1].ts - b[1].ts)
    .map(([label, h]) => ({ label, count: (cum += h.n) }));
  return {
    minted: mints.length,
    open: owner.size,
    holders: new Set(owner.values()).size,
    cumulative,
  };
}

