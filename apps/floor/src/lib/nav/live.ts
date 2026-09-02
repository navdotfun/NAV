/* NAV — nav.fun · live on-chain data: block polling + lazy Uniswap v3 price discovery.
   Prices are read client-side from Uniswap v3 pools on Robinhood Chain:
   factory.getPool(token, USDG|USDC, fee) → deepest pool → slot0.sqrtPriceX96 → USD price. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Address } from "viem";
import {
  publicClient, sqrtPriceToPrice, TOKENS, UNISWAP, V3_FEE_TIERS,
  v3FactoryAbi, v3PoolAbi,
} from "./chain";

/* ---------- live block number ---------- */
let blockNumber: bigint | null = null;
let blockSubs = new Set<() => void>();
let blockTimer: ReturnType<typeof setInterval> | null = null;

async function pollBlock() {
  try {
    const n = await publicClient.getBlockNumber({ cacheTime: 0 });
    if (n !== blockNumber) {
      blockNumber = n;
      blockSubs.forEach((f) => f());
    }
  } catch { /* keep last value */ }
}

export function useBlockNumber(): bigint | null {
  return useSyncExternalStore(
    (cb) => {
      blockSubs.add(cb);
      if (!blockTimer) {
        void pollBlock();
        blockTimer = setInterval(pollBlock, 12_000);
      }
      return () => {
        blockSubs.delete(cb);
        if (blockSubs.size === 0 && blockTimer) { clearInterval(blockTimer); blockTimer = null; }
      };
    },
    () => blockNumber,
  );
}

/* ---------- lazy price store ---------- */
export interface PriceEntry {
  status: "loading" | "ok" | "none" | "error";
  /** USD price (quoted in USDG or USDC, both $1 stables). */
  price?: number;
  pool?: Address;
  fee?: number;
  quote?: "USDG" | "USDC";
}

const QUOTES = [TOKENS.USDG, TOKENS.USDC] as const;
const priceMap = new Map<string, PriceEntry>();
const priceSubs = new Set<() => void>();
const pending: { address: Address; decimals: number }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/* Refresh metadata per resolved token — pool discovery is stable, but slot0
   moves every trade, so re-read prices on a TTL instead of caching forever (M-02). */
interface RefreshMeta { address: Address; decimals: number; pool: Address; baseIsToken0: boolean; quoteDecimals: number }
const refreshMeta = new Map<string, RefreshMeta>();
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const PRICE_TTL_MS = 60_000;

async function refreshPrices() {
  if (priceSubs.size === 0) return;
  /* Heal errored entries: re-enqueue every "error" token with a fresh retry
     budget once per sweep — bounded retry per minute, permanent-death removed. */
  if (errorTokens.size > 0) {
    for (const [key, tok] of [...errorTokens]) {
      errorTokens.delete(key);
      retryCount.delete(key);
      priceMap.delete(key);
      requestPrice(tok);
    }
  }
  if (refreshMeta.size === 0) return;
  const metas = [...refreshMeta.values()];
  try {
    const reads = await publicClient.multicall({
      contracts: metas.map((m) => ({ address: m.pool, abi: v3PoolAbi, functionName: "slot0" as const })),
      allowFailure: true,
    });
    let changed = false;
    metas.forEach((m, i) => {
      const r = reads[i];
      if (r.status !== "success") return;
      const [sqrtPriceX96] = r.result as readonly [bigint, number, number, number, number, number, boolean];
      if (sqrtPriceX96 === 0n) return;
      const price = sqrtPriceToPrice(sqrtPriceX96, m.baseIsToken0, m.decimals, m.quoteDecimals);
      if (!isFinite(price) || price <= 0) return;
      const key = m.address.toLowerCase();
      const cur = priceMap.get(key);
      if (cur?.status === "ok" && cur.price !== price) {
        priceMap.set(key, { ...cur, price });
        changed = true;
      }
    });
    if (changed) notify();
  } catch { /* keep last known prices */ }
}

function ensureRefreshLoop() {
  if (!refreshTimer) refreshTimer = setInterval(() => void refreshPrices(), PRICE_TTL_MS);
}

let priceVersion = 0;
function notify() { priceVersion++; priceSubs.forEach((f) => f()); }

/** Read a resolved price entry without subscribing (pair with usePriceFeed). */
export function getPriceEntry(address: string): PriceEntry | null {
  return priceMap.get(address.toLowerCase()) ?? null;
}

/** Request prices for a set of tokens and re-render whenever any price
    resolves or refreshes. Returns a version counter; read entries with
    getPriceEntry. Safe for variable-length token lists (no hook-in-loop). */
export function usePriceFeed(tokens: { address: Address; decimals: number }[]): number {
  const keyStr = tokens.map((t) => t.address.toLowerCase()).join(",");
  useEffect(() => {
    tokens.forEach((t) => requestPrice(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyStr]);
  return useSyncExternalStore(
    (cb) => { priceSubs.add(cb); return () => { priceSubs.delete(cb); }; },
    () => priceVersion,
  );
}

function requestPrice(token: { address: Address; decimals: number }) {
  const key = token.address.toLowerCase();
  if (priceMap.has(key)) return;
  priceMap.set(key, { status: "loading" });
  pending.push(token);
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, 40);
}

/* Retry bookkeeping (mobile QA bug): a partially-failed multicall (RPC 429
   burst) used to mark priced tokens "none" → the UI claimed "no pool" for
   tokens that trade with deep liquidity. "no pool" is a factual on-chain claim
   and must only render when every read for that token SUCCEEDED and returned
   nothing. Failures are "error" and retry with backoff (capped). */
const retryCount = new Map<string, number>();
const MAX_PRICE_RETRIES = 4;
const RETRY_BASE_MS = 6_000;

/* Tokens whose last read failed (transport) — healed by the 60s sweep above
   with a fresh retry budget. Without this, an entry that exhausted its 4
   retries stayed "error" until full page reload. */
const errorTokens = new Map<string, { address: Address; decimals: number }>();

/* Transport-failure streak for whole-batch flush failures: a failed HTTP
   batch is NOT a per-token failure, so it must not consume per-token retry
   budgets — it gets its own capped exponential backoff instead. */
let flushFailStreak = 0;

function scheduleRetry(token: { address: Address; decimals: number }) {
  const key = token.address.toLowerCase();
  const n = retryCount.get(key) ?? 0;
  if (n >= MAX_PRICE_RETRIES) return; // give up quietly — stays "error", never lies
  retryCount.set(key, n + 1);
  setTimeout(() => {
    priceMap.delete(key); // allow requestPrice to re-queue
    requestPrice(token);
  }, RETRY_BASE_MS * 2 ** n);
}

async function flush() {
  const batch = pending.splice(0, pending.length);
  if (batch.length === 0) return;
  notify();
  try {
    // 1. discover candidate pools: token × {USDG, USDC} × fee tiers, one multicall
    const calls = batch.flatMap((t) =>
      QUOTES.flatMap((q) =>
        V3_FEE_TIERS.map((fee) => ({
          address: UNISWAP.v3Factory, abi: v3FactoryAbi,
          functionName: "getPool" as const, args: [t.address, q.address, fee] as const,
        })),
      ),
    );
    const found = await publicClient.multicall({ contracts: calls, allowFailure: true });
    interface Candidate { token: typeof batch[number]; quote: typeof QUOTES[number]; fee: number; pool: Address }
    const candidates: Candidate[] = [];
    /* any failed call for a token taints its result: "none" is then unprovable */
    const tainted = new Set<string>();
    let i = 0;
    for (const t of batch) for (const q of QUOTES) for (const fee of V3_FEE_TIERS) {
      const r = found[i++];
      if (r.status !== "success") { tainted.add(t.address.toLowerCase()); continue; }
      if (r.result && r.result !== "0x0000000000000000000000000000000000000000") {
        candidates.push({ token: t, quote: q, fee, pool: r.result as Address });
      }
    }
    // 2. read liquidity + slot0 + token0 for every candidate pool, one multicall
    const reads = await publicClient.multicall({
      contracts: candidates.flatMap((c) => [
        { address: c.pool, abi: v3PoolAbi, functionName: "liquidity" as const },
        { address: c.pool, abi: v3PoolAbi, functionName: "slot0" as const },
        { address: c.pool, abi: v3PoolAbi, functionName: "token0" as const },
      ]),
      allowFailure: true,
    });
    // 3. pick deepest pool per token, compute price
    const best = new Map<string, { liquidity: bigint; entry: PriceEntry }>();
    candidates.forEach((c, ci) => {
      const liq = reads[ci * 3], slot0 = reads[ci * 3 + 1], token0 = reads[ci * 3 + 2];
      if (liq.status !== "success" || slot0.status !== "success" || token0.status !== "success") {
        tainted.add(c.token.address.toLowerCase());
        return;
      }
      const liquidity = liq.result as bigint;
      if (liquidity === 0n) return;
      const [sqrtPriceX96] = slot0.result as readonly [bigint, number, number, number, number, number, boolean];
      if (sqrtPriceX96 === 0n) return;
      const baseIsToken0 = (token0.result as string).toLowerCase() === c.token.address.toLowerCase();
      const price = sqrtPriceToPrice(sqrtPriceX96, baseIsToken0, c.token.decimals, c.quote.decimals);
      if (!isFinite(price) || price <= 0) return;
      const key = c.token.address.toLowerCase();
      const prev = best.get(key);
      if (!prev || liquidity > prev.liquidity) {
        best.set(key, { liquidity, entry: { status: "ok", price, pool: c.pool, fee: c.fee, quote: c.quote.symbol } });
        refreshMeta.set(key, { address: c.token.address, decimals: c.token.decimals, pool: c.pool, baseIsToken0, quoteDecimals: c.quote.decimals });
      }
    });
    for (const t of batch) {
      const key = t.address.toLowerCase();
      const hit = best.get(key)?.entry;
      if (hit) {
        priceMap.set(key, hit);
        retryCount.delete(key);
        errorTokens.delete(key);
      } else if (tainted.has(key)) {
        // reads failed — we do NOT know there's no pool. Mark error + retry.
        priceMap.set(key, { status: "error" });
        errorTokens.set(key, t);
        scheduleRetry(t);
      } else {
        priceMap.set(key, { status: "none" }); // proven: no pool with liquidity
        errorTokens.delete(key);
      }
    }
    flushFailStreak = 0;
    if (refreshMeta.size > 0 || errorTokens.size > 0) ensureRefreshLoop();
  } catch {
    /* Transport-level failure (multicall with allowFailure never throws for
       item failures): mark error for honesty, but re-queue the whole batch
       on its own capped backoff WITHOUT touching per-token retry budgets. */
    flushFailStreak += 1;
    for (const t of batch) {
      const key = t.address.toLowerCase();
      priceMap.set(key, { status: "error" });
      errorTokens.set(key, t);
    }
    ensureRefreshLoop();
    const delay = Math.min(3_000 * 2 ** (flushFailStreak - 1), 30_000);
    setTimeout(() => {
      if (priceSubs.size === 0) return; // nobody watching — the sweep will heal later
      for (const t of batch) {
        priceMap.delete(t.address.toLowerCase());
        requestPrice(t);
      }
    }, delay);
  }
  notify();
}

/** Lazily resolve a token's live USD price from Uniswap v3. Pass enabled=false to defer
    (e.g. until the row scrolls into view). */
export function useTokenPrice(token: { address: Address; decimals: number }, enabled = true): PriceEntry | null {
  const key = token.address.toLowerCase();
  useEffect(() => {
    if (enabled) requestPrice(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  return useSyncExternalStore(
    (cb) => { priceSubs.add(cb); return () => { priceSubs.delete(cb); }; },
    () => priceMap.get(key) ?? null,
  );
}

/** True once the element has scrolled into view (used to lazy-load prices per row). */
export function useInView<T extends HTMLElement>(): { ref: React.MutableRefObject<T | null>; inView: boolean } {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
    const obs = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setInView(true); obs.disconnect(); } },
      { rootMargin: "120px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView]);
  return { ref, inView };
}

/** Live ETH/USD — WETH priced from its deepest USDG/USDC Uniswap v3 pool
    (no WETH/USDC pool exists on Robinhood Chain today; USDG is the house dollar). */
export function useEthUsd(): PriceEntry | null {
  return useTokenPrice(TOKENS.WETH);
}
