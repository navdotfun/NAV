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

async function fetchHistory(): Promise<VaultFill[]> {
  const vault = PROTOCOL.vaultAddress;
  if (!vault) return [];
  const base = { event: TRANSFER, fromBlock: VAULT_DEPLOY_BLOCK, toBlock: "latest" } as const;
  const [inLogs, outLogs] = await Promise.all([
    publicClient.getLogs({ ...base, args: { to: vault } }),
    publicClient.getLogs({ ...base, args: { from: vault } }),
  ]);

  const raw = [
    ...inLogs.map((l) => ({ l, direction: "in" as const })),
    ...outLogs.map((l) => ({ l, direction: "out" as const })),
  ].filter(({ l }) => (l.args.value ?? 0n) > 0n);

  const blocks = [...new Set(raw.map(({ l }) => l.blockNumber))].filter(
    (b) => !blockTimeCache.has(b),
  );
  await Promise.all(
    blocks.map(async (b) => {
      const blk = await publicClient.getBlock({ blockNumber: b });
      blockTimeCache.set(b, Number(blk.timestamp));
    }),
  );

  return raw
    .map(({ l, direction }) => ({
      token: l.address as Address,
      amount: l.args.value!,
      direction,
      block: l.blockNumber,
      time: blockTimeCache.get(l.blockNumber) ?? 0,
      tx: l.transactionHash as Hash,
    }))
    .sort((a, b) => (a.block === b.block ? Number(a.time - b.time) : a.block < b.block ? -1 : 1));
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
