/* OPTIONS — NavOptions integration. European covered options, USDG-prepaid,
   settled on-chain against PitOracleV2 snapshots. Contract is immutable:
   no owner, no keepers, no off-chain anything.

   Every number shown in the UI is read from the contract (previewOpen /
   vaultInfo / position / dailyRateX18 / bandDepthUsdg) — the UI performs
   no local pricing math, so what you see is bit-exactly what the chain
   charges. maxCostUsdg re-enforces the on-screen quote at execution. */
import { BaseError, ContractFunctionRevertedError, parseEventLogs } from "viem";
import type { Address, Hex } from "viem";
import { publicClient, robinhoodChain, erc20Abi, TOKENS } from "./chain";
import { walletClient, ensureChain } from "./wallet";
import { limited } from "./nav/rpc";

/** NavOptions — set post-deployment (Sourcify-verified). null = view gated. */
export const NAV_OPTIONS: Address | null = "0xd628eFeC572eE000D4Eb040E675744FEB35F2467";

export const OPTION_TERMS = [
  { label: "1H", seconds: 3600n },
  { label: "1D", seconds: 86400n },
  { label: "3D", seconds: 259200n },
  { label: "7D", seconds: 604800n },
] as const;

export const BUCKETS = [
  { id: 0, call: "ATM", put: "ATM" },
  { id: 1, call: "+5%", put: "−5%" },
  { id: 2, call: "+10%", put: "−10%" },
] as const;

/* Pricer clamps — mirrors of contract constants (display/warning only; the
   contract remains the sole pricing authority). R4 M-01: when the measured
   pool-fee rate sits at the cap, quotes are clamped and may underprice
   realised volatility — the UI must say so. */
export const OPT_RATE_CAP = 0.03;    // 300 bps/day hard cap
export const OPT_RATE_FLOOR = 0.0008; // 8 bps/day floor

/* Custom errors — REQUIRED for viem to decode reverts into readable names.
   Includes NavOptions' own errors plus PitOracleV2 errors that bubble up
   through quotePrice() inside open/previewOpen (oracle deviation gate). */
const navOptionsErrors = [
  { type: "error", name: "BadParams", inputs: [] },
  { type: "error", name: "UnknownMarket", inputs: [] },
  { type: "error", name: "BadTerm", inputs: [] },
  { type: "error", name: "BadBucket", inputs: [] },
  { type: "error", name: "DepthLow", inputs: [] },
  { type: "error", name: "DepthCapExceeded", inputs: [] },
  { type: "error", name: "NotionalTooSmall", inputs: [] },
  { type: "error", name: "InsufficientFreeCapital", inputs: [] },
  { type: "error", name: "ZeroShares", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "NotExpired", inputs: [] },
  { type: "error", name: "AlreadySettled", inputs: [] },
  { type: "error", name: "UnknownPosition", inputs: [] },
  { type: "error", name: "Overflow", inputs: [] },
  { type: "error", name: "SameBlock", inputs: [] },
  { type: "error", name: "EmptyVault", inputs: [] },
  { type: "error", name: "CostTooHigh", inputs: [] },
  /* PitOracleV2 — bubbled through ORACLE.quotePrice() */
  { type: "error", name: "MarketUnknown", inputs: [] },
  { type: "error", name: "FeedDeviation", inputs: [] },
  { type: "error", name: "NoPrice", inputs: [] },
  { type: "error", name: "AnchorPending", inputs: [] },
] as const;

/* Events — field order matches NavOptions.sol:195/208 exactly. Used to
   decode the true position id / payout from the receipt (R4 F-15) and to
   seed the blotter from Opened(buyer) logs (R4 F-03). */
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

export const navOptionsAbi = [
  ...navOptionsErrors,
  openedEvent,
  settledEvent,
  { type: "function", name: "marketsLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "market", stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [
      { name: "token", type: "address" }, { name: "pool", type: "address" },
      { name: "usdgIsToken0", type: "bool" }, { name: "minLiquidity", type: "uint128" },
    ],
  },
  {
    type: "function", name: "vaultInfo", stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }, { name: "side", type: "uint8" }],
    outputs: [
      { name: "totalShares", type: "uint128" }, { name: "assets", type: "uint128" },
      { name: "escrowed", type: "uint128" }, { name: "premiumUsdg", type: "uint128" },
      { name: "freeAssets", type: "uint256" },
    ],
  },
  {
    type: "function", name: "previewOpen", stateMutability: "view",
    inputs: [
      { name: "marketId", type: "uint256" }, { name: "isCall", type: "bool" },
      { name: "bucket", type: "uint8" }, { name: "size", type: "uint128" }, { name: "term", type: "uint256" },
    ],
    outputs: [
      { name: "premium", type: "uint256" }, { name: "origination", type: "uint256" },
      { name: "strike", type: "uint128" }, { name: "expiry", type: "uint64" },
      { name: "notional", type: "uint128" }, { name: "escrow", type: "uint128" },
    ],
  },
  {
    type: "function", name: "open", stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "uint256" }, { name: "isCall", type: "bool" },
      { name: "bucket", type: "uint8" }, { name: "size", type: "uint128" },
      { name: "term", type: "uint256" }, { name: "maxCostUsdg", type: "uint256" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function", name: "settle", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "payout", type: "uint256" }, { name: "bounty", type: "uint256" }],
  },
  {
    type: "function", name: "deposit", stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "uint256" }, { name: "side", type: "uint8" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "uint256" }, { name: "side", type: "uint8" }, { name: "shares", type: "uint256" }],
    outputs: [{ name: "amount", type: "uint256" }, { name: "premium", type: "uint256" }],
  },
  {
    type: "function", name: "harvestPremium", stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function", name: "pendingPremium", stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }, { name: "writer", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "sharesOf", stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }, { name: "side", type: "uint256" }, { name: "writer", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "position", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{
      name: "p", type: "tuple", components: [
        { name: "owner", type: "address" }, { name: "marketId", type: "uint32" },
        { name: "isCall", type: "bool" }, { name: "settled", type: "bool" },
        { name: "expiry", type: "uint64" }, { name: "size", type: "uint128" },
        { name: "strike", type: "uint128" }, { name: "escrow", type: "uint128" },
        { name: "notional", type: "uint128" },
      ],
    }],
  },
  { type: "function", name: "nextPositionId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dailyRateX18", stateMutability: "view", inputs: [{ name: "marketId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "bandDepthUsdg", stateMutability: "view", inputs: [{ name: "marketId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "oiNotional", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ type: "uint128" }] },
] as const;

/* ---------- types ---------- */

export interface OptMarket {
  id: number;
  token: Address;
  symbol: string;
  pool: Address;
  minLiquidity: bigint;
  /* live stats */
  /** R4 F-01: null = oracle read failed — render “—”, NEVER a fabricated $0. */
  price: number | null;
  bandDepthUsdg: bigint | null;  // 6-dec · null = read failed
  dailyRateX18: bigint | null;   // measured, pre floor/cap · null = read failed
  oiNotional: bigint | null;     // 6-dec · null = read failed
  /** A-03: null = vaultInfo read failed — NEVER a fabricated all-zero vault. */
  callVault: VaultStats | null;
  putVault: VaultStats | null;
}

export interface VaultStats {
  totalShares: bigint;
  assets: bigint;
  escrowed: bigint;
  premiumUsdg: bigint;
  freeAssets: bigint;
}

export interface OptQuote {
  premium: bigint;     // USDG 6-dec
  origination: bigint; // USDG 6-dec
  strike: bigint;      // 1e18
  expiry: bigint;
  notional: bigint;    // 6-dec
  escrow: bigint;      // stock wei (CALL) / USDG 6-dec (PUT)
  quotedAt: number;
}

export interface OptPosition {
  id: bigint;
  owner: Address;
  marketId: number;
  isCall: boolean;
  settled: boolean;
  expiry: bigint;
  size: bigint;
  strike: bigint;
  escrow: bigint;
  notional: bigint;
}

export type OptExecPhase =
  | { k: "idle" }
  | { k: "approving"; hash?: Hex }
  | { k: "sending"; hash?: Hex }
  | { k: "done"; hash: Hex; result?: bigint }
  /** R4 F-08: hash present when a tx was broadcast before the failure —
      the UI links the explorer so a receipt-timeout is never a dead end. */
  | { k: "error"; message: string; hash?: Hex };

/* ---------- reads ---------- */

const oracleAbi = [
  { type: "function", name: "quotePrice", stateMutability: "view", inputs: [{ name: "u", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

import { NAV } from "./chain";
import registry from "./stocktokens.json";

const SYMBOL_BY_ADDR = new Map<string, string>(
  (registry as { symbol: string; address: string }[]).map((t) => [t.address.toLowerCase(), t.symbol]),
);

/* A-17: three views poll this independently — share one in-flight promise and
   a 15s snapshot so the chain sees ONE market sweep instead of three. */
let optMktCache: { at: number; data: OptMarket[] } | null = null;
let optMktInflight: Promise<OptMarket[]> | null = null;
const OPT_MKT_TTL_MS = 15_000;

/** R4 F-05: `force` bypasses the snapshot (post-fill refresh must show the
    new vault state immediately, not a ≤15s-old cache). In-flight dedupe kept. */
export async function loadOptMarkets(force = false): Promise<OptMarket[]> {
  if (!force && optMktCache && Date.now() - optMktCache.at < OPT_MKT_TTL_MS) return optMktCache.data;
  if (optMktInflight) return optMktInflight;
  optMktInflight = loadOptMarketsUncached()
    .then((data) => { optMktCache = { at: Date.now(), data }; return data; })
    .finally(() => { optMktInflight = null; });
  return optMktInflight;
}

async function loadOptMarketsUncached(): Promise<OptMarket[]> {
  if (!NAV_OPTIONS) return [];
  const n = (await limited(() => publicClient.readContract({
    address: NAV_OPTIONS!, abi: navOptionsAbi, functionName: "marketsLength",
  }))) as bigint;
  const ids = Array.from({ length: Number(n) }, (_, i) => BigInt(i));

  const calls = ids.flatMap((id) => [
    { address: NAV_OPTIONS!, abi: navOptionsAbi, functionName: "market", args: [id] } as const,
    { address: NAV_OPTIONS!, abi: navOptionsAbi, functionName: "vaultInfo", args: [id, 0] } as const,
    { address: NAV_OPTIONS!, abi: navOptionsAbi, functionName: "vaultInfo", args: [id, 1] } as const,
    { address: NAV_OPTIONS!, abi: navOptionsAbi, functionName: "bandDepthUsdg", args: [id] } as const,
    { address: NAV_OPTIONS!, abi: navOptionsAbi, functionName: "dailyRateX18", args: [id] } as const,
    { address: NAV_OPTIONS!, abi: navOptionsAbi, functionName: "oiNotional", args: [id] } as const,
  ]);
  const res = await limited(() => publicClient.multicall({ contracts: calls, allowFailure: true }));

  const out: OptMarket[] = [];
  for (let i = 0; i < ids.length; i++) {
    const base = i * 6;
    const mkt = res[base];
    if (mkt.status !== "success") continue;
    const [token, pool, , minLiquidity] = mkt.result as readonly [Address, Address, boolean, bigint];
    const vc = res[base + 1], vp = res[base + 2], bd = res[base + 3], dr = res[base + 4], oi = res[base + 5];
    const vaultOf = (r: typeof vc): VaultStats | null => {
      if (r.status !== "success") return null; // A-03: failed read ≠ empty vault
      const [totalShares, assets, escrowed, premiumUsdg, freeAssets] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
      return { totalShares, assets, escrowed, premiumUsdg, freeAssets };
    };
    out.push({
      id: i,
      token, pool, minLiquidity,
      symbol: SYMBOL_BY_ADDR.get(token.toLowerCase()) ?? token.slice(0, 8),
      price: null,
      bandDepthUsdg: bd.status === "success" ? (bd.result as bigint) : null,
      dailyRateX18: dr.status === "success" ? (dr.result as bigint) : null,
      oiNotional: oi.status === "success" ? (oi.result as bigint) : null,
      callVault: vaultOf(vc),
      putVault: vaultOf(vp),
    });
  }

  /* oracle prices in one multicall */
  const px = await limited(() => publicClient.multicall({
    contracts: out.map((m) => ({
      address: NAV.pitOracleV2, abi: oracleAbi, functionName: "quotePrice", args: [m.token],
    } as const)),
    allowFailure: true,
  }));
  px.forEach((r, i) => {
    if (r.status === "success") out[i].price = Number(r.result as bigint) / 1e18;
  });
  return out;
}

export async function fetchOptQuote(
  marketId: number, isCall: boolean, bucket: number, size: bigint, term: bigint,
): Promise<OptQuote> {
  if (!NAV_OPTIONS) throw new Error("options not deployed");
  const [premium, origination, strike, expiry, notional, escrow] = (await publicClient.readContract({
    address: NAV_OPTIONS, abi: navOptionsAbi, functionName: "previewOpen",
    args: [BigInt(marketId), isCall, bucket, size, term],
  })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  return { premium, origination, strike, expiry, notional, escrow, quotedAt: Date.now() };
}

/* B-13: position immutability lets us cache aggressively — owner never changes
   and a settled position never mutates again. Per-account cache stores foreign
   ids (skip forever) and settled own positions (final); only OPEN own positions
   and ids never seen before are re-read each poll. */
type PosCacheEntry = { kind: "foreign" } | { kind: "settled"; pos: OptPosition };
const posCache = new Map<string, Map<bigint, PosCacheEntry>>();

/* R4 F-03: the blotter must never silently lose positions older than the
   scan window. Three complementary, fully client-side/on-chain sources:
     1. the last-`window` id scan (catches everything recent);
     2. a once-per-account Opened(buyer=account) log seed — the complete
        on-chain list of ids this wallet ever opened;
     3. localStorage persistence of ids confirmed ours, so the book
        survives reloads even when the log seed is unavailable.
   No indexer, no backend, no keeper. */
const OPTIONS_DEPLOY_BLOCK = 52_489_544n; // NavOptions creation block — Opened logs cannot exist before it
const seededAccounts = new Set<string>();

const ownedLsKey = (account: string) => `nav.opt.owned.${(NAV_OPTIONS ?? "").toLowerCase()}.${account}`;

function loadOwnedIds(account: string): Set<bigint> {
  try {
    const raw = localStorage.getItem(ownedLsKey(account));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string" && /^\d+$/.test(x)).map(BigInt));
  } catch { return new Set(); } // privacy mode / corrupt entry — degrade to window scan
}

function saveOwnedIds(account: string, ids: Set<bigint>): void {
  try {
    const arr = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(-2000); // bound growth
    localStorage.setItem(ownedLsKey(account), JSON.stringify(arr.map(String)));
  } catch { /* quota / privacy mode — non-fatal, window scan still works */ }
}

/** Complete owned-id list from Opened(buyer) logs. True on success. */
async function seedOwnedFromLogs(account: Address, into: Set<bigint>): Promise<boolean> {
  try {
    const logs = await limited(() => publicClient.getLogs({
      address: NAV_OPTIONS!, event: openedEvent, args: { buyer: account },
      fromBlock: OPTIONS_DEPLOY_BLOCK, toBlock: "latest",
    }));
    for (const l of logs) if (l.args.id !== undefined) into.add(l.args.id);
    return true;
  } catch { return false; } // RPC hiccup — retried on the next poll
}

export interface PositionBook {
  positions: OptPosition[];
  /** true when ids below the scan window may exist that we could not cover
      (log seed unavailable) — the UI shows a truncation notice. */
  truncated: boolean;
}

/** All positions owned by `account` — fully on-chain (window scan + log seed). */
export async function fetchMyPositions(account: Address, window = 500): Promise<PositionBook> {
  if (!NAV_OPTIONS) return { positions: [], truncated: false };
  const next = (await limited(() => publicClient.readContract({
    address: NAV_OPTIONS!, abi: navOptionsAbi, functionName: "nextPositionId",
  }))) as bigint;
  const hi = next - 1n;
  if (hi < 1n) return { positions: [], truncated: false };
  const lo = hi > BigInt(window) ? hi - BigInt(window) + 1n : 1n;

  const key = account.toLowerCase();
  const owned = loadOwnedIds(key);
  const ownedBefore = owned.size;
  if (!seededAccounts.has(key)) {
    if (await seedOwnedFromLogs(account, owned)) seededAccounts.add(key);
  }

  let cache = posCache.get(key);
  if (!cache) { cache = new Map(); posCache.set(key, cache); }

  /* candidates = recent window ∪ every id known to be ours (any age) */
  const candidates = new Set<bigint>();
  for (let id = lo; id <= hi; id++) candidates.add(id);
  for (const id of owned) if (id >= 1n && id <= hi) candidates.add(id);

  const ids: bigint[] = [];
  const cached: OptPosition[] = [];
  for (const id of candidates) {
    const c = cache.get(id);
    if (c === undefined) { ids.push(id); continue; }        // never seen — read
    if (c.kind === "foreign") continue;                       // not ours — skip forever
    if (c.kind === "settled") { cached.push(c.pos); continue; } // final — reuse
  }
  /* open own positions must be re-read (settled flag can flip) — they were
     never cached, so they are already in `ids` from the branch above. */

  if (ids.length > 0) {
    const res = await limited(() => publicClient.multicall({
      contracts: ids.map((id) => ({
        address: NAV_OPTIONS!, abi: navOptionsAbi, functionName: "position", args: [id],
      } as const)),
      allowFailure: true,
    }));
    res.forEach((r, i) => {
      if (r.status !== "success") return; // transient failure — retried next poll, never cached
      const p = r.result as {
        owner: Address; marketId: number; isCall: boolean; settled: boolean;
        expiry: bigint; size: bigint; strike: bigint; escrow: bigint; notional: bigint;
      };
      if (p.owner.toLowerCase() !== key) { cache!.set(ids[i], { kind: "foreign" }); return; }
      const pos: OptPosition = { id: ids[i], ...p, marketId: Number(p.marketId) };
      if (p.settled) cache!.set(ids[i], { kind: "settled", pos });
      cached.push(pos);
      owned.add(ids[i]);
    });
  }
  if (owned.size !== ownedBefore) saveOwnedIds(key, owned);
  cached.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)); // newest first
  /* coverage is complete when the log seed succeeded — only flag truncation
     when older ids exist AND we could not enumerate ownership from logs. */
  return { positions: cached, truncated: lo > 1n && !seededAccounts.has(key) };
}

export interface WriterStats {
  /** null = read failed — render “—”, never a fabricated zero balance. */
  callShares: bigint | null; putShares: bigint | null; pending: bigint | null;
}

export async function fetchWriterStats(marketId: number, account: Address): Promise<WriterStats> {
  /* R4 F-09: view gated — unknown, not zero. Consistent with the null contract. */
  if (!NAV_OPTIONS) return { callShares: null, putShares: null, pending: null };
  const res = await limited(() => publicClient.multicall({
    contracts: [
      { address: NAV_OPTIONS, abi: navOptionsAbi, functionName: "sharesOf", args: [BigInt(marketId), 0n, account] },
      { address: NAV_OPTIONS, abi: navOptionsAbi, functionName: "sharesOf", args: [BigInt(marketId), 1n, account] },
      { address: NAV_OPTIONS, abi: navOptionsAbi, functionName: "pendingPremium", args: [BigInt(marketId), account] },
    ] as const,
    allowFailure: true,
  }));
  return {
    callShares: res[0].status === "success" ? (res[0].result as bigint) : null,
    putShares: res[1].status === "success" ? (res[1].result as bigint) : null,
    pending: res[2].status === "success" ? (res[2].result as bigint) : null,
  };
}

/* ---------- writes (approve → simulate → send, mirroring executeSwap rails) ---------- */

const QUOTE_MAX_AGE_MS = 45_000;

async function ensureAllowance(
  token: Address, owner: Address, amount: bigint, onPhase: (p: OptExecPhase) => void,
): Promise<void> {
  const wc = walletClient();
  if (!wc) throw new Error("wallet not connected");
  const allowance = (await publicClient.readContract({
    address: token, abi: erc20Abi, functionName: "allowance", args: [owner, NAV_OPTIONS!],
  })) as bigint;
  if (allowance >= amount) return;
  onPhase({ k: "approving" });
  const { request } = await publicClient.simulateContract({
    address: token, abi: erc20Abi, functionName: "approve",
    args: [NAV_OPTIONS!, amount], account: owner, chain: robinhoodChain,
  });
  const hash = await wc.writeContract(request);
  onPhase({ k: "approving", hash });
  try {
    const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rc.status !== "success") throw new Error("approval reverted");
  } catch (e) {
    tagHash(e, hash); // R4 F-08: surface the broadcast tx on timeout/failure
    throw e;
  }
}

/** R4 F-08: attach the broadcast tx hash to an error so the UI can link it. */
function tagHash(e: unknown, hash: Hex): void {
  if (e && typeof e === "object") (e as { txHash?: Hex }).txHash = hash;
}

function hashOf(e: unknown): Hex | undefined {
  return e && typeof e === "object" ? (e as { txHash?: Hex }).txHash : undefined;
}

/* Human copy for every custom error the options stack can raise. Decoded via
   ContractFunctionRevertedError (errors are now in navOptionsAbi) — never
   again a blank "reverted with the following signature". */
const ERR_COPY: Record<string, string> = {
  InsufficientFreeCapital: "no free writer capacity on this side — reduce size or deposit on the WRITE tab",
  EmptyVault: "no writers in this market side yet — deposit on the WRITE tab to open it",
  DepthLow: "pool liquidity below this market's depth gate — temporarily untradable",
  DepthCapExceeded: "open-interest cap reached (20% of pool depth) — reduce size",
  NotionalTooSmall: "minimum trade is 10 USDG notional — increase size",
  CostTooHigh: "quote moved beyond your max cost — requote",
  FeedDeviation: "oracle gate: pool price deviates from the Chainlink anchor — paused until it normalises",
  NoPrice: "oracle has no fresh price for this market — try again shortly",
  AnchorPending: "oracle anchor is updating — try again shortly",
  MarketUnknown: "oracle does not cover this market",
  SameBlock: "wait one block after deposit before withdrawing",
  NotExpired: "position has not expired yet",
  AlreadySettled: "already settled",
  UnknownPosition: "unknown position id",
  UnknownMarket: "unknown market — refresh",
  BadTerm: "invalid term — refresh and retry",
  BadBucket: "invalid strike bucket — refresh and retry",
  BadParams: "invalid order parameters — refresh and retry",
  ZeroAmount: "amount is zero",
  ZeroShares: "no shares to withdraw",
  Overflow: "size too large",
};

/** R4 F-02/F-10: exported so views can name previewOpen reverts; `overrides`
    lets context-specific flows (e.g. writer withdraw) reword shared errors. */
export function friendly(e: unknown, overrides?: Record<string, string>): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      const name = r.data?.errorName ?? "";
      if (name && overrides?.[name]) return overrides[name];
      if (name && ERR_COPY[name]) return ERR_COPY[name];
      if (name) return `contract rejected: ${name}`;
      if (r.signature) return `contract rejected (${r.signature}) — refresh and retry`;
    }
  }
  const raw = e instanceof Error ? e.message : String(e);
  return /user rejected|denied/i.test(raw) ? "rejected in wallet"
    : /insufficient funds/i.test(raw) ? "insufficient ETH for gas"
    : /timed out|timeout/i.test(raw) ? "timed out waiting for confirmation — the tx may still land, check the explorer"
    : raw.split("\n")[0].slice(0, 90);
}

/** Build the error phase: friendly copy + broadcast hash when one exists. */
function errPhase(e: unknown, overrides?: Record<string, string>): OptExecPhase {
  return { k: "error", message: friendly(e, overrides), hash: hashOf(e) };
}

async function drive(
  fn: "open" | "settle" | "deposit" | "withdraw" | "harvestPremium",
  args: readonly unknown[],
  account: Address,
  onPhase: (p: OptExecPhase) => void,
): Promise<void> {
  const wc = walletClient();
  if (!wc) throw new Error("wallet not connected");
  if (!(await ensureChain())) throw new Error("switch wallet to Robinhood Chain");
  onPhase({ k: "sending" });
  const { request, result } = await publicClient.simulateContract({
    address: NAV_OPTIONS!, abi: navOptionsAbi, functionName: fn,
    args: args as never, account, chain: robinhoodChain,
  });
  const hash = await wc.writeContract(request);
  onPhase({ k: "sending", hash });
  try {
    const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success") throw new Error(`${fn} reverted on-chain`);
    /* R4 F-15: the authoritative result is the receipt's own event, not the
       pre-send simulation (which can drift if state moved between simulate
       and inclusion). Fall back to the simulated value if decoding fails. */
    let r = Array.isArray(result) ? (result[0] as bigint) : (result as bigint | undefined);
    if (fn === "open" || fn === "settle") {
      try {
        const evs = parseEventLogs({
          abi: navOptionsAbi, logs: rc.logs,
          eventName: fn === "open" ? "Opened" : "Settled",
        });
        if (evs.length > 0) {
          r = fn === "open"
            ? (evs[0].args as { id: bigint }).id
            : (evs[0].args as { payout: bigint }).payout;
        }
      } catch { /* keep simulated value */ }
    }
    onPhase({ k: "done", hash, result: r });
  } catch (e) {
    tagHash(e, hash); // R4 F-08
    throw e;
  }
}

/** Open an option. Pays premium+origination in USDG; maxCost enforces the on-screen quote +0.5%. */
export async function openOption(opts: {
  marketId: number; isCall: boolean; bucket: number; size: bigint; term: bigint;
  quote: OptQuote; account: Address; onPhase: (p: OptExecPhase) => void;
}): Promise<void> {
  const { marketId, isCall, bucket, size, term, quote, account, onPhase } = opts;
  try {
    if (!NAV_OPTIONS) throw new Error("options not deployed");
    if (Date.now() - quote.quotedAt > QUOTE_MAX_AGE_MS) throw new Error("quote stale — repriced, try again");
    /* R4 F-04: verify the chain BEFORE the approval — an approval signed on
       the wrong network is a silent no-op that burns gas and confuses. */
    if (!(await ensureChain())) throw new Error("switch wallet to Robinhood Chain");
    const cost = quote.premium + quote.origination;
    const maxCost = cost + cost / 200n; // +0.5% headroom against snapshot drift
    await ensureAllowance(TOKENS.USDG.address, account, maxCost, onPhase);
    await drive("open", [BigInt(marketId), isCall, bucket, size, term, maxCost], account, onPhase);
  } catch (e) {
    onPhase(errPhase(e));
  }
}

export async function settlePosition(id: bigint, account: Address, onPhase: (p: OptExecPhase) => void): Promise<void> {
  try {
    await drive("settle", [id], account, onPhase);
  } catch (e) {
    onPhase(errPhase(e));
  }
}

export async function writerDeposit(opts: {
  marketId: number; side: 0 | 1; amount: bigint; assetToken: Address;
  account: Address; onPhase: (p: OptExecPhase) => void;
}): Promise<void> {
  const { marketId, side, amount, assetToken, account, onPhase } = opts;
  try {
    if (!NAV_OPTIONS) throw new Error("options not deployed");
    /* R4 F-04: chain check precedes the approval (see openOption). */
    if (!(await ensureChain())) throw new Error("switch wallet to Robinhood Chain");
    await ensureAllowance(assetToken, account, amount, onPhase);
    await drive("deposit", [BigInt(marketId), side, amount], account, onPhase);
  } catch (e) {
    onPhase(errPhase(e));
  }
}

export async function writerWithdraw(opts: {
  marketId: number; side: 0 | 1; shares: bigint; account: Address; onPhase: (p: OptExecPhase) => void;
}): Promise<void> {
  const { marketId, side, shares, account, onPhase } = opts;
  try {
    await drive("withdraw", [BigInt(marketId), side, shares], account, onPhase);
  } catch (e) {
    /* R4 F-10: in the withdraw context this error means escrow is locked
       behind open options — the buyer-framed default copy would mislead. */
    onPhase(errPhase(e, {
      InsufficientFreeCapital:
        "amount exceeds unescrowed vault capital — capital backing open options unlocks as they settle; withdraw less for now",
    }));
  }
}

export async function harvestPremium(marketId: number, account: Address, onPhase: (p: OptExecPhase) => void): Promise<void> {
  try {
    await drive("harvestPremium", [BigInt(marketId)], account, onPhase);
  } catch (e) {
    onPhase(errPhase(e));
  }
}
