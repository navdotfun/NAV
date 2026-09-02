/* ARENA (Colosseum) — NavArena integration. Head-to-head outperformance
   bouts between two tokenized stocks: stake USDG on side A or B before
   entry closes, prices snap at lock and settle through PitOracleV2's
   anchor-verified settlement rails, winners split the losing pot pro-rata.
   Fully permissionless: anyone can create, lock, settle, void, claim.

   Every number shown in the UI is read from the contract; writes are
   simulated before signing (same rails as credit/options). */
import { BaseError, ContractFunctionRevertedError } from "viem";
import type { Address, Hex } from "viem";
import { publicClient, robinhoodChain, erc20Abi, TOKENS } from "./chain";
import { walletClient, ensureChain } from "./wallet";
import { limited } from "./nav/rpc";
import { ARENA_ADDRESS } from "./deployments";
export { ARENA_ADDRESS } from "./deployments";
import registry from "./stocktokens.json";

export const USDG = TOKENS.USDG.address;
export const BPS = 10_000n;
/* Mirrors of contract constants — display only; the chain is authoritative. */
export const FEE_BPS_ARENA = 200n; // 2% of the losing pot at settlement
export const BOUNTY_SHARE_BPS = 1000n; // 10% of the fee to the settling caller
export const MIN_STAKE = 1_000_000n; // 1 USDG
export const RESOLUTION_WINDOW_S = 24 * 3600;
export const STAKE_BUFFER_S = 30 * 60;

const arenaErrors = [
  { type: "error", name: "BadAssets", inputs: [] },
  { type: "error", name: "BadWindow", inputs: [] },
  { type: "error", name: "BadState", inputs: [] },
  { type: "error", name: "TooEarly", inputs: [] },
  { type: "error", name: "TooLate", inputs: [] },
  { type: "error", name: "StakeTooSmall", inputs: [] },
  { type: "error", name: "StakeOverflow", inputs: [] },
  { type: "error", name: "NothingToClaim", inputs: [] },
  { type: "error", name: "OracleDead", inputs: [] },
  /* PitOracleV2 — bubbled through lock/settle snapshot calls */
  { type: "error", name: "AnchorPending", inputs: [] },
  { type: "error", name: "MarketUnknown", inputs: [] },
] as const;

export const arenaAbi = [
  ...arenaErrors,
  { type: "function", name: "nextBoutId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "getBout", stateMutability: "view",
    inputs: [{ name: "boutId", type: "uint256" }],
    outputs: [{
      type: "tuple", components: [
        { name: "assetA", type: "address" },
        { name: "entryClose", type: "uint64" },
        { name: "state", type: "uint8" },
        { name: "winner", type: "uint8" },
        { name: "assetB", type: "address" },
        { name: "settleTime", type: "uint64" },
        { name: "potA", type: "uint128" },
        { name: "potB", type: "uint128" },
        { name: "configHash", type: "bytes32" },
        { name: "startA", type: "uint256" },
        { name: "startB", type: "uint256" },
        { name: "endA", type: "uint256" },
        { name: "endB", type: "uint256" },
      ],
    }],
  },
  {
    type: "function", name: "preview", stateMutability: "view",
    inputs: [{ name: "boutId", type: "uint256" }],
    outputs: [{ name: "perfA", type: "uint256" }, { name: "perfB", type: "uint256" }],
  },
  {
    type: "function", name: "stakeA", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint128" }],
  },
  {
    type: "function", name: "stakeB", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint128" }],
  },
  {
    type: "function", name: "createBout", stateMutability: "nonpayable",
    inputs: [
      { name: "assetA", type: "address" }, { name: "assetB", type: "address" },
      { name: "entryClose", type: "uint64" }, { name: "settleTime", type: "uint64" },
    ],
    outputs: [{ name: "boutId", type: "uint256" }],
  },
  {
    type: "function", name: "stake", stateMutability: "nonpayable",
    inputs: [{ name: "boutId", type: "uint256" }, { name: "sideA", type: "bool" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
  { type: "function", name: "lock", stateMutability: "nonpayable", inputs: [{ name: "boutId", type: "uint256" }], outputs: [] },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [{ name: "boutId", type: "uint256" }], outputs: [] },
  { type: "function", name: "voidBout", stateMutability: "nonpayable", inputs: [{ name: "boutId", type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "boutId", type: "uint256" }], outputs: [] },
] as const;

/* ---------- types ---------- */

export type BoutState = "Open" | "Locked" | "Settled" | "Voided";
const STATES: BoutState[] = ["Open", "Locked", "Settled", "Voided"];

export interface Bout {
  id: bigint;
  assetA: Address;
  assetB: Address;
  symA: string;
  symB: string;
  entryClose: number; // unix s
  settleTime: number;
  state: BoutState;
  winner: 0 | 1 | 2;
  potA: bigint; // USDG 6-dec
  potB: bigint;
  startA: bigint; // 1e18-scaled
  startB: bigint;
  endA: bigint;
  endB: bigint;
  /** Live performance in WAD (1e18 = flat), null until locked. */
  perfA: bigint | null;
  perfB: bigint | null;
}

export interface MyStake { boutId: bigint; a: bigint; b: bigint }

const SYM_BY_ADDR = new Map<string, string>(
  (registry as { symbol: string; address: string }[]).map((t) => [t.address.toLowerCase(), t.symbol]),
);
export function symbolOf(addr: Address): string {
  return SYM_BY_ADDR.get(addr.toLowerCase()) ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/* ---------- reads ---------- */

/** All bouts, newest first. Chain is the only source; empty when none exist. */
export async function fetchBouts(): Promise<Bout[]> {
  if (!ARENA_ADDRESS) return [];
  const next = (await limited(() => publicClient.readContract({
    address: ARENA_ADDRESS, abi: arenaAbi, functionName: "nextBoutId",
  }))) as bigint;
  const n = Number(next);
  if (n === 0) return [];
  const ids = Array.from({ length: n }, (_, i) => BigInt(n - 1 - i)); // newest first
  const bouts = await Promise.all(ids.map(async (id) => {
    const b = (await limited(() => publicClient.readContract({
      address: ARENA_ADDRESS!, abi: arenaAbi, functionName: "getBout", args: [id],
    }))) as {
      assetA: Address; entryClose: bigint; state: number; winner: number; assetB: Address;
      settleTime: bigint; potA: bigint; potB: bigint; configHash: Hex;
      startA: bigint; startB: bigint; endA: bigint; endB: bigint;
    };
    let perfA: bigint | null = null, perfB: bigint | null = null;
    if (STATES[b.state] === "Locked") {
      try {
        const [pA, pB] = (await limited(() => publicClient.readContract({
          address: ARENA_ADDRESS!, abi: arenaAbi, functionName: "preview", args: [id],
        }))) as [bigint, bigint];
        perfA = pA; perfB = pB;
      } catch { /* oracle quote unavailable — show pots without live perf */ }
    }
    return {
      id, assetA: b.assetA, assetB: b.assetB,
      symA: symbolOf(b.assetA), symB: symbolOf(b.assetB),
      entryClose: Number(b.entryClose), settleTime: Number(b.settleTime),
      state: STATES[b.state], winner: b.winner as 0 | 1 | 2,
      potA: b.potA, potB: b.potB,
      startA: b.startA, startB: b.startB, endA: b.endA, endB: b.endB,
      perfA, perfB,
    };
  }));
  return bouts;
}

/** Caller's live stakes across the given bouts (zeroed once claimed). */
export async function fetchMyStakes(owner: Address, bouts: Bout[]): Promise<MyStake[]> {
  if (!ARENA_ADDRESS || bouts.length === 0) return [];
  const rows = await Promise.all(bouts.map(async (b) => {
    const [a, bb] = await Promise.all([
      limited(() => publicClient.readContract({
        address: ARENA_ADDRESS!, abi: arenaAbi, functionName: "stakeA", args: [b.id, owner],
      })) as Promise<bigint>,
      limited(() => publicClient.readContract({
        address: ARENA_ADDRESS!, abi: arenaAbi, functionName: "stakeB", args: [b.id, owner],
      })) as Promise<bigint>,
    ]);
    return { boutId: b.id, a, b: bb };
  }));
  return rows.filter((r) => r.a > 0n || r.b > 0n);
}

/* ---------- payout math (mirrors contract; display only) ---------- */

/** Winner payout for `mine` staked on the winning pot. */
export function previewPayout(mine: bigint, winPot: bigint, losePot: bigint): bigint {
  if (mine === 0n || winPot === 0n) return 0n;
  const fee = (losePot * FEE_BPS_ARENA) / BPS;
  const distributable = losePot - fee;
  return mine + (distributable * mine) / winPot;
}

/* ---------- writes (approve → simulate → send) ---------- */

export type ArenaPhase =
  | { k: "approving"; hash?: Hex }
  | { k: "sending"; hash?: Hex }
  | { k: "confirming"; hash: Hex }
  | { k: "done"; hash: Hex };

function tagHash(e: unknown, hash: Hex): void {
  if (e && typeof e === "object") (e as { txHash?: Hex }).txHash = hash;
}

/** Human-readable revert reason from a viem error. */
export function arenaRevertName(e: unknown): string | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? null;
  }
  return null;
}

async function ensureAllowance(owner: Address, amount: bigint, onPhase: (p: ArenaPhase) => void): Promise<void> {
  const wc = walletClient();
  if (!wc || !ARENA_ADDRESS) throw new Error("wallet not connected");
  const allowance = (await publicClient.readContract({
    address: USDG, abi: erc20Abi, functionName: "allowance", args: [owner, ARENA_ADDRESS],
  })) as bigint;
  if (allowance >= amount) return;
  onPhase({ k: "approving" });
  const { request } = await publicClient.simulateContract({
    address: USDG, abi: erc20Abi, functionName: "approve",
    args: [ARENA_ADDRESS, amount], account: owner, chain: robinhoodChain,
  });
  const hash = await wc.writeContract(request);
  onPhase({ k: "approving", hash });
  const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") { const err = new Error("approval reverted"); tagHash(err, hash); throw err; }
}

async function send(
  fn: "createBout" | "stake" | "lock" | "settle" | "voidBout" | "claim",
  args: readonly unknown[],
  owner: Address,
  onPhase: (p: ArenaPhase) => void,
): Promise<Hex> {
  const wc = walletClient();
  if (!wc || !ARENA_ADDRESS) throw new Error("wallet not connected");
  if (!(await ensureChain())) throw new Error("wrong chain");
  onPhase({ k: "sending" });
  const { request } = await publicClient.simulateContract({
    address: ARENA_ADDRESS, abi: arenaAbi, functionName: fn,
    args: args as never, account: owner, chain: robinhoodChain,
  });
  const hash = await wc.writeContract(request);
  onPhase({ k: "confirming", hash });
  try {
    const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success") throw new Error(`${fn} reverted`);
  } catch (e) { tagHash(e, hash); throw e; }
  onPhase({ k: "done", hash });
  return hash;
}

export async function stakeBout(
  owner: Address, boutId: bigint, sideA: boolean, amount: bigint, onPhase: (p: ArenaPhase) => void,
): Promise<Hex> {
  await ensureAllowance(owner, amount, onPhase);
  return send("stake", [boutId, sideA, amount], owner, onPhase);
}

export async function createBout(
  owner: Address, assetA: Address, assetB: Address, entryClose: number, settleTime: number,
  onPhase: (p: ArenaPhase) => void,
): Promise<Hex> {
  return send("createBout", [assetA, assetB, BigInt(entryClose), BigInt(settleTime)], owner, onPhase);
}

export async function lockBout(owner: Address, boutId: bigint, onPhase: (p: ArenaPhase) => void): Promise<Hex> {
  return send("lock", [boutId], owner, onPhase);
}
export async function settleBout(owner: Address, boutId: bigint, onPhase: (p: ArenaPhase) => void): Promise<Hex> {
  return send("settle", [boutId], owner, onPhase);
}
export async function voidBoutTx(owner: Address, boutId: bigint, onPhase: (p: ArenaPhase) => void): Promise<Hex> {
  return send("voidBout", [boutId], owner, onPhase);
}
export async function claimBout(owner: Address, boutId: bigint, onPhase: (p: ArenaPhase) => void): Promise<Hex> {
  return send("claim", [boutId], owner, onPhase);
}
