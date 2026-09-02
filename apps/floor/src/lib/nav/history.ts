/* NAV — on-chain acquisition history.
 *
 * Reconstructs every vault inflow/outflow from raw ERC-20 `Transfer` logs
 * (indexed to/from = vault address), the same primary source block explorers
 * index. No backend, no indexer, no synthetic data: if it isn't in a chain
 * log, it isn't drawn.
 *
 * Read-only module — issues zero transactions and holds no keys.
 */
import { useEffect, useRef, useState } from "react";
import { parseAbiItem, type Address, type Hash } from "viem";
import { publicClient } from "./chain";
import { PROTOCOL } from "./protocol";
import { limited } from "./rpc";

/** Vault deployment block (creation tx 0x7090553d…, Robinhood Chain).
    Bounds the log scan — nothing vault-related can exist before it. */
const VAULT_DEPLOY_BLOCK = 50_307_943n;

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export interface VaultFill {
  token: Address;
  /** Token amount moved (raw units). */
  amount: bigint;
  direction: "in" | "out";
  block: bigint;
  /** Unix seconds (block timestamp). */
  time: number;
  tx: Hash;
}

export interface VaultHistory {
  status: "loading" | "ok" | "error";
  /** Chronological (oldest first). Empty array + "ok" = no fills yet. */
  fills: VaultFill[];
}

/* Block timestamps are immutable — cache forever within the session. */
const blockTimeCache = new Map<bigint, number>();

/* A-14: incremental cursor — fills are immutable chain logs, so the full
   scan from the vault deploy block runs once per app load; every later 60s
   tick scans ONLY [cursor+1, tip] and appends. On failure the cursor stays
   put and the same range is retried next tick. */
let fillCursor: bigint | null = null;
let fillCache: VaultFill[] = [];

async function fetchHistory(): Promise<VaultFill[]> {
  const vault = PROTOCOL.vaultAddress;
  if (!vault) return [];
  const latest = await limited(() => publicClient.getBlockNumber({ cacheTime: 0 }));
  const from = fillCursor === null ? VAULT_DEPLOY_BLOCK : fillCursor + 1n;
  if (from > latest) return fillCache;
  const base = { event: TRANSFER, fromBlock: from, toBlock: latest } as const;
  const [inLogs, outLogs] = await Promise.all([
    limited(() => publicClient.getLogs({ ...base, args: { to: vault } })),
    limited(() => publicClient.getLogs({ ...base, args: { from: vault } })),
  ]);

  const raw = [
    ...inLogs.map((l) => ({ l, direction: "in" as const })),
    ...outLogs.map((l) => ({ l, direction: "out" as const })),
  ].filter(({ l }) => (l.args.value ?? 0n) > 0n);

  const blocks = [...new Set(raw.map(({ l }) => l.blockNumber))].filter(
    (b) => !blockTimeCache.has(b),
  );
  /* Block-stamp fan-out goes through the shared 4-lane limiter: an
     unbounded Promise.all here was exactly the burst shape the RPC edge
     resets (→ growth chart stuck on READING CHAIN… as fills accumulate). */
  await Promise.all(
    blocks.map(async (b) => {
      const blk = await limited(() => publicClient.getBlock({ blockNumber: b }));
      blockTimeCache.set(b, Number(blk.timestamp));
    }),
  );

  const fresh = raw.map(({ l, direction }) => ({
    token: l.address as Address,
    amount: l.args.value!,
    direction,
    block: l.blockNumber,
    time: blockTimeCache.get(l.blockNumber) ?? 0,
    tx: l.transactionHash as Hash,
  }));
  fillCache = [...fillCache, ...fresh]
    .sort((a, b) => (a.block === b.block ? Number(a.time - b.time) : a.block < b.block ? -1 : 1));
  fillCursor = latest;
  return fillCache;
}

const POLL_MS = 60_000;

/** Poll the vault's full transfer history. Keeps the last good result on a
    failed refresh (RPC hiccups must never blank a working ledger). */
export function useVaultHistory(): VaultHistory {
  const [state, setState] = useState<VaultHistory>({ status: "loading", fills: [] });
  const lastGood = useRef<VaultFill[] | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const fills = await fetchHistory();
        if (!alive) return;
        lastGood.current = fills;
        setState({ status: "ok", fills });
      } catch {
        if (!alive) return;
        setState(
          lastGood.current !== null
            ? { status: "ok", fills: lastGood.current }
            : { status: "error", fills: [] },
        );
      } finally {
        if (alive) timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  return state;
}
