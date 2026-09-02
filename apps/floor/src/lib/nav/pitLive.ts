/* NAV — nav.fun · The Pit: client-side live price sampling.
   Builds an in-session price series for one token by re-reading its deepest
   Uniswap v3 pool's slot0 on an interval — the same read path the rest of the
   site uses (lib/live.ts discovers the pool; this file keeps sampling it).
   The series always starts empty and only ever contains real on-chain reads. */
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { publicClient, sqrtPriceToPrice, TOKENS, v3PoolAbi } from "./chain";
import { useTokenPrice, type PriceEntry } from "./live";
import type { StockToken } from "./data";

export interface PricePoint {
  /** ms epoch of the read */
  t: number;
  /** USD price from slot0 at that read */
  price: number;
}

const SAMPLE_MS = 10_000;
const MAX_POINTS = 360; // one hour of 10s samples

export interface PitPriceFeed {
  /** Pool discovery state from the shared price store. */
  entry: PriceEntry | null;
  /** In-session sampled series (only real reads; empty until the first print). */
  series: PricePoint[];
  /** Latest sampled price (falls back to the discovery read). */
  last: number | null;
}

/** Sample the selected token's Uniswap v3 pool price on an interval.
    Series resets when the token changes. */
export function usePitPriceFeed(token: StockToken | null): PitPriceFeed {
  const probe = useTokenPrice(token ?? TOKENS.WETH, token !== null);
  const entry = token ? probe : null;
  const [series, setSeries] = useState<PricePoint[]>([]);
  const key = token ? token.address.toLowerCase() : "";
  const poolKey = entry?.status === "ok" && entry.pool ? entry.pool.toLowerCase() : "";
  const seeded = useRef<string>("");

  /* reset on token switch */
  useEffect(() => {
    setSeries([]);
    seeded.current = "";
  }, [key]);

  /* seed with the discovery read, then poll slot0 */
  useEffect(() => {
    if (!token || !poolKey || entry?.status !== "ok" || !entry.pool || entry.price === undefined) return;
    const pool = entry.pool as Address;
    const quote = entry.quote === "USDC" ? TOKENS.USDC : TOKENS.USDG;
    // Uniswap v3 orders token0 < token1 by address
    const baseIsToken0 = token.address.toLowerCase() < quote.address.toLowerCase();
    const seedKey = key + poolKey;
    if (seeded.current !== seedKey) {
      seeded.current = seedKey;
      const p = entry.price;
      setSeries([{ t: Date.now(), price: p }]);
    }
    let stop = false;
    const read = async () => {
      try {
        const slot0 = await publicClient.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" });
        if (stop) return;
        const sqrtPriceX96 = slot0[0];
        if (sqrtPriceX96 === 0n) return;
        const price = sqrtPriceToPrice(sqrtPriceX96, baseIsToken0, token.decimals, quote.decimals);
        if (!isFinite(price) || price <= 0) return;
        setSeries((s) => [...s.slice(-(MAX_POINTS - 1)), { t: Date.now(), price }]);
      } catch {
        /* keep last series on transient RPC failure */
      }
    };
    const timer = setInterval(read, SAMPLE_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, poolKey, entry?.status]);

  const last = series.length > 0 ? series[series.length - 1].price : entry?.status === "ok" && entry.price !== undefined ? entry.price : null;
  return { entry, series, last };
}
