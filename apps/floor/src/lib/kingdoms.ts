/* KINGDOMS (Index Factory) — NavIndexFactory / NavIndexToken / NavIndexZap
   integration. Anyone can found a kingdom: an immutable basket of tokenized
   stocks minted as an ERC-20 share. Fully-backed issue/redeem at fixed
   units-per-share; the zap swaps USDG into every component and issues in
   one atomic transaction through NavSwapRouter.

   Every number shown in the UI is read from the contracts; writes are
   simulated before signing (same rails as credit/options). */
import { BaseError, ContractFunctionRevertedError } from "viem";
import type { Address, Hex } from "viem";
import { publicClient, robinhoodChain, erc20Abi, TOKENS } from "./chain";
import { walletClient, ensureChain } from "./wallet";
import { limited } from "./nav/rpc";
import { quoteLeg } from "./venues";
import { INDEX_FACTORY, INDEX_ZAP } from "./deployments";
export { INDEX_FACTORY, INDEX_ZAP } from "./deployments";
import registry from "./stocktokens.json";

export const USDG = TOKENS.USDG.address;
export const WAD = 10n ** 18n;
export const BPS = 10_000n;

/* Mirrors of contract constants — display only; the chain is authoritative. */
export const MAX_MINT_FEE_BPS = 100n;
export const MAX_REDEEM_FEE_BPS = 100n;
export const MAX_STREAM_FEE_BPS = 200n;
export const CREATOR_SHARE_BPS = 9000n;
export const MIN_COMPONENTS = 2;
export const MAX_COMPONENTS = 10;

const indexErrors = [
  { type: "error", name: "BadConfig", inputs: [] },
  { type: "error", name: "ZeroShares", inputs: [] },
  { type: "error", name: "EmptySupply", inputs: [] },
  { type: "error", name: "ComponentShortfall", inputs: [{ name: "component", type: "address" }] },
  { type: "error", name: "BadSkips", inputs: [] },
  { type: "error", name: "BadOracle", inputs: [] },
  { type: "error", name: "BadName", inputs: [] },
  { type: "error", name: "DeadComponent", inputs: [{ name: "component", type: "address" }] },
  { type: "error", name: "NotAnIndex", inputs: [] },
  { type: "error", name: "LengthMismatch", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "SlippageExceeded", inputs: [{ name: "usdgOut", type: "uint256" }, { name: "minUsdgOut", type: "uint256" }] },
] as const;

export const factoryAbi = [
  ...indexErrors,
  { type: "function", name: "indexCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "indices", stateMutability: "view",
    inputs: [{ name: "offset", type: "uint256" }, { name: "limit", type: "uint256" }],
    outputs: [{ type: "address[]" }],
  },
  { type: "function", name: "isIndex", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "createIndex", stateMutability: "nonpayable",
    inputs: [{
      name: "p", type: "tuple", components: [
        { name: "name", type: "string" },
        { name: "symbol", type: "string" },
        { name: "components", type: "address[]" },
        { name: "unitsPerShare", type: "uint256[]" },
        { name: "mintFeeBps", type: "uint256" },
        { name: "redeemFeeBps", type: "uint256" },
        { name: "streamFeeBps", type: "uint256" },
      ],
    }],
    outputs: [{ name: "index", type: "address" }],
  },
] as const;

export const indexTokenAbi = [
  ...indexErrors,
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "creator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "mintFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "redeemFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "streamFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "components", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "unitsPerShare", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
  {
    type: "function", name: "issueAmounts", stateMutability: "view",
    inputs: [{ name: "grossShares", type: "uint256" }], outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function", name: "redeemAmounts", stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }], outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function", name: "issue", stateMutability: "nonpayable",
    inputs: [{ name: "grossShares", type: "uint256" }, { name: "to", type: "address" }],
    outputs: [{ name: "netShares", type: "uint256" }],
  },
  {
    type: "function", name: "redeem", stateMutability: "nonpayable",
    inputs: [{ name: "shares", type: "uint256" }, { name: "to", type: "address" }], outputs: [],
  },
  {
    type: "function", name: "redeem", stateMutability: "nonpayable",
    inputs: [{ name: "shares", type: "uint256" }, { name: "to", type: "address" }, { name: "skip", type: "bool[]" }],
    outputs: [],
  },
  { type: "function", name: "pokeFees", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

export const zapAbi = [
  ...indexErrors,
  {
    type: "function", name: "zapIssue", stateMutability: "nonpayable",
    inputs: [
      { name: "index", type: "address" },
      { name: "grossShares", type: "uint256" },
      {
        name: "legs", type: "tuple[]", components: [
          { name: "leg", type: "tuple", components: [{ name: "venue", type: "uint8" }, { name: "param", type: "int24" }] },
          { name: "usdgIn", type: "uint256" },
          { name: "minOut", type: "uint256" },
        ],
      },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "netShares", type: "uint256" }],
  },
  {
    type: "function", name: "zapRedeem", stateMutability: "nonpayable",
    inputs: [
      { name: "index", type: "address" },
      { name: "shares", type: "uint256" },
      {
        name: "legs", type: "tuple[]", components: [
          { name: "leg", type: "tuple", components: [{ name: "venue", type: "uint8" }, { name: "param", type: "int24" }] },
          { name: "usdgIn", type: "uint256" },
          { name: "minOut", type: "uint256" },
        ],
      },
      { name: "minUsdgOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "usdgOut", type: "uint256" }],
  },
] as const;

/* ---------- types ---------- */

export interface Component {
  address: Address;
  symbol: string;
  decimals: number;
  unitsPerShare: bigint;
}

export interface Kingdom {
  address: Address;
  name: string;
  symbol: string;
  creator: Address;
  totalSupply: bigint; // 18-dec shares
  mintFeeBps: bigint;
  redeemFeeBps: bigint;
  streamFeeBps: bigint;
  components: Component[];
}

const REG = registry as { symbol: string; address: string; decimals?: number }[];
const TOKEN_BY_ADDR = new Map(REG.map((t) => [t.address.toLowerCase(), t]));
export function tokenMeta(addr: Address): { symbol: string; decimals: number } {
  const t = TOKEN_BY_ADDR.get(addr.toLowerCase());
  return { symbol: t?.symbol ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`, decimals: t?.decimals ?? 18 };
}

/* ---------- reads ---------- */

/** All kingdoms from the factory, newest first. Empty when none exist. */
export async function fetchKingdoms(): Promise<Kingdom[]> {
  if (!INDEX_FACTORY) return [];
  const count = (await limited(() => publicClient.readContract({
    address: INDEX_FACTORY, abi: factoryAbi, functionName: "indexCount",
  }))) as bigint;
  if (count === 0n) return [];
  const addrs = (await limited(() => publicClient.readContract({
    address: INDEX_FACTORY, abi: factoryAbi, functionName: "indices", args: [0n, count],
  }))) as Address[];
  const rows = await Promise.all(addrs.map((a) => fetchKingdom(a)));
  return rows.reverse();
}

export async function fetchKingdom(addr: Address): Promise<Kingdom> {
  const rd = <T,>(functionName: string, args: unknown[] = []) =>
    limited(() => publicClient.readContract({
      address: addr, abi: indexTokenAbi, functionName: functionName as never, args: args as never,
    })) as Promise<T>;
  const [name, symbol, creator, totalSupply, mintFeeBps, redeemFeeBps, streamFeeBps, comps, units] =
    await Promise.all([
      rd<string>("name"), rd<string>("symbol"), rd<Address>("creator"), rd<bigint>("totalSupply"),
      rd<bigint>("mintFeeBps"), rd<bigint>("redeemFeeBps"), rd<bigint>("streamFeeBps"),
      rd<Address[]>("components"), rd<bigint[]>("unitsPerShare"),
    ]);
  return {
    address: addr, name, symbol, creator, totalSupply, mintFeeBps, redeemFeeBps, streamFeeBps,
    components: comps.map((c, i) => ({ address: c, ...tokenMeta(c), unitsPerShare: units[i] })),
  };
}

/** Exact component amounts pulled for `grossShares` (contract view). */
export async function fetchIssueAmounts(index: Address, grossShares: bigint): Promise<bigint[]> {
  return (await limited(() => publicClient.readContract({
    address: index, abi: indexTokenAbi, functionName: "issueAmounts", args: [grossShares],
  }))) as bigint[];
}

/** Exact component amounts paid for `shares` (contract view). */
export async function fetchRedeemAmounts(index: Address, shares: bigint): Promise<bigint[]> {
  return (await limited(() => publicClient.readContract({
    address: index, abi: indexTokenAbi, functionName: "redeemAmounts", args: [shares],
  }))) as bigint[];
}

/** Caller's share balance. */
export async function fetchShareBalance(index: Address, owner: Address): Promise<bigint> {
  return (await limited(() => publicClient.readContract({
    address: index, abi: indexTokenAbi, functionName: "balanceOf", args: [owner],
  }))) as bigint;
}

/* ---------- zap quoting ---------- */

export interface ZapLeg {
  leg: { venue: number; param: number };
  usdgIn: bigint;
  minOut: bigint;
}

export interface ZapIssueQuote {
  legs: ZapLeg[];
  totalUsdg: bigint; // sum of leg budgets (upper bound; leftovers refunded)
  unroutable: Address[]; // components with no USDG pool route
}

/** Size zapIssue legs: for each component, find the USDG amount whose swap
    output clears issueAmounts[i], with `slipBps` headroom on the budget.
    minOut is pinned to the exact requirement — shortfalls revert atomically. */
export async function quoteZapIssue(k: Kingdom, grossShares: bigint, slipBps = 100n): Promise<ZapIssueQuote> {
  const need = await fetchIssueAmounts(k.address, grossShares);
  const legs: ZapLeg[] = [];
  const unroutable: Address[] = [];
  let totalUsdg = 0n;
  for (let i = 0; i < k.components.length; i++) {
    const comp = k.components[i];
    const req = need[i];
    if (req === 0n) { legs.push({ leg: { venue: 0, param: 0 }, usdgIn: 0n, minOut: 1n }); continue; }
    /* probe: quote 1 unit notional → derive USDG-in per component-out, then
       verify with a real quote at the sized budget (2 RPC round-trips/leg). */
    const probeIn = 10_000_000n; // 10 USDG probe
    const probe = await quoteLeg(USDG, comp.address, probeIn);
    if (!probe.best || probe.best.amountOut === 0n) { unroutable.push(comp.address); continue; }
    let budget = (probeIn * req) / probe.best.amountOut;
    budget = (budget * (BPS + slipBps)) / BPS + 1n;
    const sized = await quoteLeg(USDG, comp.address, budget);
    if (!sized.best || sized.best.amountOut < req) {
      /* price impact at size — widen once, then give up honestly */
      budget = (budget * (BPS + slipBps * 4n)) / BPS;
      const retry = await quoteLeg(USDG, comp.address, budget);
      if (!retry.best || retry.best.amountOut < req) { unroutable.push(comp.address); continue; }
      legs.push({ leg: { venue: retry.best.venue, param: retry.best.param }, usdgIn: budget, minOut: req });
    } else {
      legs.push({ leg: { venue: sized.best.venue, param: sized.best.param }, usdgIn: budget, minOut: req });
    }
    totalUsdg += budget;
  }
  return { legs, totalUsdg, unroutable };
}

export interface ZapRedeemQuote {
  legs: ZapLeg[];
  expectedUsdg: bigint;
  unroutable: Address[];
}

/** Size zapRedeem legs: swap every component payout to USDG at best venue. */
export async function quoteZapRedeem(k: Kingdom, shares: bigint, slipBps = 100n): Promise<ZapRedeemQuote> {
  const pay = await fetchRedeemAmounts(k.address, shares);
  const legs: ZapLeg[] = [];
  const unroutable: Address[] = [];
  let expectedUsdg = 0n;
  for (let i = 0; i < k.components.length; i++) {
    const comp = k.components[i];
    const amt = pay[i];
    if (amt === 0n) { legs.push({ leg: { venue: 0, param: 0 }, usdgIn: 0n, minOut: 1n }); continue; }
    const q = await quoteLeg(comp.address, USDG, amt);
    if (!q.best || q.best.amountOut === 0n) { unroutable.push(comp.address); continue; }
    const minOut = (q.best.amountOut * (BPS - slipBps)) / BPS;
    legs.push({ leg: { venue: q.best.venue, param: q.best.param }, usdgIn: 0n, minOut: minOut > 0n ? minOut : 1n });
    expectedUsdg += q.best.amountOut;
  }
  return { legs, expectedUsdg, unroutable };
}

/* ---------- writes (approve → simulate → send) ---------- */

export type KingdomPhase =
  | { k: "approving"; hash?: Hex }
  | { k: "sending"; hash?: Hex }
  | { k: "confirming"; hash: Hex }
  | { k: "done"; hash: Hex };

function tagHash(e: unknown, hash: Hex): void {
  if (e && typeof e === "object") (e as { txHash?: Hex }).txHash = hash;
}

export function kingdomRevertName(e: unknown): string | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? null;
  }
  return null;
}

async function ensureAllowance(
  token: Address, owner: Address, spender: Address, amount: bigint, onPhase: (p: KingdomPhase) => void,
): Promise<void> {
  const wc = walletClient();
  if (!wc) throw new Error("wallet not connected");
  const allowance = (await publicClient.readContract({
    address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender],
  })) as bigint;
  if (allowance >= amount) return;
  onPhase({ k: "approving" });
  const { request } = await publicClient.simulateContract({
    address: token, abi: erc20Abi, functionName: "approve",
    args: [spender, amount], account: owner, chain: robinhoodChain,
  });
  const hash = await wc.writeContract(request);
  onPhase({ k: "approving", hash });
  const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") { const err = new Error("approval reverted"); tagHash(err, hash); throw err; }
}

async function send(
  address: Address, abi: typeof factoryAbi | typeof indexTokenAbi | typeof zapAbi,
  fn: string, args: readonly unknown[], owner: Address, onPhase: (p: KingdomPhase) => void,
): Promise<Hex> {
  const wc = walletClient();
  if (!wc) throw new Error("wallet not connected");
  if (!(await ensureChain())) throw new Error("wrong chain");
  onPhase({ k: "sending" });
  const { request } = await publicClient.simulateContract({
    address, abi: abi as never, functionName: fn as never,
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

/** Direct issue: approves every component for its exact issueAmounts pull. */
export async function issueShares(
  owner: Address, k: Kingdom, grossShares: bigint, onPhase: (p: KingdomPhase) => void,
): Promise<Hex> {
  const need = await fetchIssueAmounts(k.address, grossShares);
  for (let i = 0; i < k.components.length; i++) {
    if (need[i] > 0n) await ensureAllowance(k.components[i].address, owner, k.address, need[i], onPhase);
  }
  return send(k.address, indexTokenAbi, "issue", [grossShares, owner], owner, onPhase);
}

/** Direct redeem (no skips — full basket delivery). */
export async function redeemShares(
  owner: Address, k: Kingdom, shares: bigint, onPhase: (p: KingdomPhase) => void,
): Promise<Hex> {
  return send(k.address, indexTokenAbi, "redeem", [shares, owner], owner, onPhase);
}

/** Zap in: USDG → all components → shares, one atomic tx. */
export async function zapIssueShares(
  owner: Address, k: Kingdom, grossShares: bigint, q: ZapIssueQuote, onPhase: (p: KingdomPhase) => void,
): Promise<Hex> {
  if (!INDEX_ZAP) throw new Error("zap not deployed");
  if (q.unroutable.length > 0) throw new Error("unroutable components");
  await ensureAllowance(USDG, owner, INDEX_ZAP, q.totalUsdg, onPhase);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  return send(INDEX_ZAP, zapAbi, "zapIssue", [k.address, grossShares, q.legs, deadline], owner, onPhase);
}

/** Zap out: shares → all components → USDG, one atomic tx. */
export async function zapRedeemShares(
  owner: Address, k: Kingdom, shares: bigint, q: ZapRedeemQuote, slipBps: bigint, onPhase: (p: KingdomPhase) => void,
): Promise<Hex> {
  if (!INDEX_ZAP) throw new Error("zap not deployed");
  if (q.unroutable.length > 0) throw new Error("unroutable components");
  await ensureAllowance(k.address, owner, INDEX_ZAP, shares, onPhase);
  const minUsdgOut = (q.expectedUsdg * (BPS - slipBps)) / BPS;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  return send(INDEX_ZAP, zapAbi, "zapRedeem", [k.address, shares, q.legs, minUsdgOut, deadline], owner, onPhase);
}

/** Found a kingdom. */
export async function foundKingdom(
  owner: Address,
  p: {
    name: string; symbol: string; components: Address[]; unitsPerShare: bigint[];
    mintFeeBps: bigint; redeemFeeBps: bigint; streamFeeBps: bigint;
  },
  onPhase: (p: KingdomPhase) => void,
): Promise<Hex> {
  if (!INDEX_FACTORY) throw new Error("factory not deployed");
  return send(INDEX_FACTORY, factoryAbi, "createIndex", [p], owner, onPhase);
}
