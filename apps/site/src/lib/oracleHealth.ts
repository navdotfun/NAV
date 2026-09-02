/* Oracle heartbeat health — audit v3 guard #1 (finding P3-01, CRITICAL).

   PitOracle.snapshotSettlement only applies its settlement clamp when
   `lastValidTwap != 0` (`hasRef`). A market that has never been poked has
   `lastValidTwap == 0`, so settlement takes the RAW 30-minute TWAP with no
   band — and the written settlement price is immutable. On a thin Uniswap v3
   pool that is a cheap collateral-extraction vector against writers.

   `poke()` is permissionless and a single call arms the clamp forever, so this
   is an operational fix — but until the heartbeat exists on a given market,
   the UI must HARD-BLOCK writer deposits into that market. Buying is not
   blocked (a buyer's downside is capped at the premium they paid), but the
   staleness of the heartbeat is disclosed everywhere.

   See navfun/qa/AUDIT-PROTOCOL-v3.md §8 guards 1, 4 and 17. */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { publicClient } from "./chain";
import { PIT } from "./pit";

export const pitOracleAbi = [
  {
    type: "function",
    name: "lastValidTwap",
    stateMutability: "view",
    inputs: [{ name: "underlying", type: "address" }],
    outputs: [{ name: "price", type: "uint256" }, { name: "updatedAt", type: "uint256" }],
  },
  {
    type: "function",
    name: "poke",
    stateMutability: "nonpayable",
    inputs: [{ name: "underlying", type: "address" }],
    outputs: [{ name: "stored", type: "uint256" }],
  },
] as const;

/** Contract constant: PitOracle.POKE_MIN_INTERVAL. */
export const POKE_MIN_INTERVAL_S = 5 * 60;
/** Heartbeat older than this widens the settlement clamp — disclose it (guard 4). */
export const HEARTBEAT_WARN_S = 24 * 60 * 60;

export type HeartbeatStatus =
  /** never poked — settlement clamp INERT. Writer deposits must be blocked. */
  | "cold"
  /** poked, but the last heartbeat is over 24h old — clamp band is widened. */
  | "stale"
  /** healthy heartbeat. */
  | "armed"
  | "loading"
  | "error";

export interface Heartbeat {
  status: HeartbeatStatus;
  /** last recorded reference price, 1e18 fp (0 when cold). */
  price: bigint | null;
  /** unix seconds of the last poke (0 when cold). */
  updatedAt: number | null;
  /** seconds since the last poke, null when cold/unknown. */
  ageS: number | null;
}

const COLD: Heartbeat = { status: "cold", price: 0n, updatedAt: 0, ageS: null };

function classify(price: bigint, updatedAt: bigint): Heartbeat {
  if (price === 0n || updatedAt === 0n) return COLD;
  const at = Number(updatedAt);
  const ageS = Math.max(0, Math.floor(Date.now() / 1000) - at);
  return { status: ageS > HEARTBEAT_WARN_S ? "stale" : "armed", price, updatedAt: at, ageS };
}

/** Read one market's oracle heartbeat. Refreshes every 60s so a poke landing
    while the page is open unlocks the deposit path without a reload. */
export function useHeartbeat(underlying: Address | null): Heartbeat {
  const [hb, setHb] = useState<Heartbeat>({ status: "loading", price: null, updatedAt: null, ageS: null });

  useEffect(() => {
    if (!underlying) {
      setHb({ status: "loading", price: null, updatedAt: null, ageS: null });
      return;
    }
    let stop = false;
    const pull = async () => {
      try {
        const [price, updatedAt] = await publicClient.readContract({
          address: PIT.oracle,
          abi: pitOracleAbi,
          functionName: "lastValidTwap",
          args: [underlying],
        });
        if (!stop) setHb(classify(price, updatedAt));
      } catch {
        if (!stop) setHb({ status: "error", price: null, updatedAt: null, ageS: null });
      }
    };
    void pull();
    const id = setInterval(() => void pull(), 60_000);
    return () => { stop = true; clearInterval(id); };
  }, [underlying]);

  return hb;
}

/** Batch heartbeat read across markets — used for the Pit-wide coverage banner. */
export async function heartbeatCoverage(underlyings: Address[]): Promise<{
  armed: number;
  stale: number;
  cold: number;
  total: number;
}> {
  const res = await publicClient.multicall({
    contracts: underlyings.map((u) => ({
      address: PIT.oracle,
      abi: pitOracleAbi,
      functionName: "lastValidTwap" as const,
      args: [u] as const,
    })),
    allowFailure: true,
  });
  let armed = 0, stale = 0, cold = 0;
  for (const r of res) {
    if (r.status !== "success") { cold++; continue; }
    const [price, updatedAt] = r.result as readonly [bigint, bigint];
    const c = classify(price, updatedAt);
    if (c.status === "armed") armed++;
    else if (c.status === "stale") stale++;
    else cold++;
  }
  return { armed, stale, cold, total: underlyings.length };
}

export function heartbeatAgeLabel(ageS: number | null): string {
  if (ageS === null) return "never";
  if (ageS < 90) return `${ageS}s ago`;
  if (ageS < 5400) return `${Math.round(ageS / 60)}m ago`;
  if (ageS < 172_800) return `${Math.round(ageS / 3600)}h ago`;
  return `${Math.round(ageS / 86_400)}d ago`;
}

/** Clamp band the oracle will allow at settlement given heartbeat age.
    Mirrors PitOracle._clampWithDecay: the base band widens by one band per
    elapsed decay period, capped at 7x. Purely informational (guard 4). */
export function clampBandBps(baseBps: number, ageS: number | null): number {
  if (ageS === null) return 0; // cold — NO clamp at all
  const periods = 1 + Math.floor(ageS / HEARTBEAT_WARN_S);
  return baseBps * Math.min(periods, 7);
}
