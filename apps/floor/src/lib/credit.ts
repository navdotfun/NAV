/* CREDIT — CreditPair/CreditFactory integration. Isolated, immutable,
   ownerless lending pairs: supply USDG, borrow USDG against tokenized
   stock collateral. Morpho-Blue share accounting + Aave-v3 rate curve,
   priced by PitOracleV2 Chainlink anchors. No admin, no keepers.

   Every number shown in the UI is read from the contract (marketState /
   accounts / debtOf / healthFactor / priceStatus) — the UI performs no
   local interest math, so what you see is bit-exactly what the chain
   charges. All writes are simulated before signing (executeSwap rails). */
import { BaseError, ContractFunctionRevertedError } from "viem";
import type { Address, Hex } from "viem";
import { publicClient, robinhoodChain, erc20Abi, TOKENS, NAV } from "./chain";
import { walletClient, ensureChain } from "./wallet";
import { limited } from "./nav/rpc";
import registry from "./stocktokens.json";

/** CreditFactory — deployed 2026-09-02, Sourcify exact_match. Pairs enumerated on-chain. */
export const CREDIT_FACTORY: Address | null = "0x9A9feC2B6b05F94D8c3861d0202C05Df4Dcfd4A7";

/* Mirrors of contract constants — display only; the chain is authoritative. */
export const ORIGINATION_BPS = 30n;
export const RESERVE_FACTOR_BPS = 2000n;
export const MIN_DEBT = 10_000_000n;          // 10 USDG (6-dec) — contract dust floor
export const MAX_PRICE_AGE_S = 93_600;         // 26h — mirrors CreditPair.MAX_PRICE_AGE
export const RAY = 10n ** 27n;
export const WAD = 10n ** 18n;

/* Custom errors — REQUIRED for viem to decode reverts into readable names. */
const creditErrors = [
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "StalePrice", inputs: [] },
  { type: "error", name: "InvalidPrice", inputs: [] },
  { type: "error", name: "SupplyCapExceeded", inputs: [] },
  { type: "error", name: "BorrowCapExceeded", inputs: [] },
  { type: "error", name: "InsufficientLiquidity", inputs: [] },
  { type: "error", name: "InsufficientShares", inputs: [] },
  { type: "error", name: "InsufficientCollateral", inputs: [] },
  { type: "error", name: "LtvExceeded", inputs: [] },
  { type: "error", name: "DebtTooSmall", inputs: [] },
  { type: "error", name: "NotLiquidatable", inputs: [] },
  { type: "error", name: "RepayTooSmall", inputs: [] },
  { type: "error", name: "NothingToSkim", inputs: [] },
  /* PitOracleV2 — bubbled through ORACLE.anchorPrice() in the constructor path */
  { type: "error", name: "MarketUnknown", inputs: [] },
] as const;

export const creditPairAbi = [
  ...creditErrors,
  /* views */
  { type: "function", name: "COLLATERAL", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "LTV_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "LIQ_THRESHOLD_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "LIQ_BONUS_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "BORROW_CAP", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "SUPPLY_CAP", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "marketState", stateMutability: "view", inputs: [],
    outputs: [
      { name: "supplyAssets", type: "uint256" }, { name: "borrowAssets", type: "uint256" },
      { name: "cash", type: "uint256" }, { name: "utilization", type: "uint256" },
      { name: "borrowRate", type: "uint256" }, { name: "supplyRate", type: "uint256" },
      { name: "reserveShares", type: "uint256" }, { name: "price", type: "uint256" },
      { name: "priceUpdatedAt", type: "uint256" },
    ],
  },
  {
    type: "function", name: "priceStatus", stateMutability: "view", inputs: [],
    outputs: [{ name: "price", type: "uint256" }, { name: "updatedAt", type: "uint256" }, { name: "fresh", type: "bool" }],
  },
  {
    type: "function", name: "accounts", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "supplyShares", type: "uint128" },
      { name: "borrowShares", type: "uint128" },
      { name: "collateral", type: "uint128" },
    ],
  },
  { type: "function", name: "debtOf", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "supplyBalanceOf", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "healthFactor", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "availableLiquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  /* writes */
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ name: "shares", type: "uint256" }] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ name: "assets", type: "uint256" }] },
  { type: "function", name: "addCollateral", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "removeCollateral", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "borrow", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ name: "fee", type: "uint256" }] },
  { type: "function", name: "repay", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "borrower", type: "address" }], outputs: [{ name: "repaid", type: "uint256" }] },
  { type: "function", name: "skimReserves", stateMutability: "nonpayable", inputs: [], outputs: [{ name: "swept", type: "uint256" }, { name: "bounty", type: "uint256" }] },
] as const;

export const creditFactoryAbi = [
  { type: "function", name: "getAllPairs", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
] as const;

/* ---------- types ---------- */

export interface CreditMarket {
  pair: Address;
  collateral: Address;
  symbol: string;
  /* risk params (immutable — read once, cached forever) */
  ltvBps: number;
  liqThresholdBps: number;
  liqBonusBps: number;
  borrowCap: bigint;   // USDG 6-dec
  supplyCap: bigint;   // USDG 6-dec
  /* live state — null = read failed, render "—", NEVER a fabricated zero */
  supplyAssets: bigint | null;
  borrowAssets: bigint | null;
  cash: bigint | null;
  utilizationRay: bigint | null;
  borrowRateRay: bigint | null;  // annual, RAY
  supplyRateRay: bigint | null;  // annual, RAY, net of reserve factor
  price: number | null;          // anchor USD
  priceUpdatedAt: number | null; // unix s
  priceFresh: boolean | null;
}

export interface CreditAccount {
  /** null = read failed — render "—", never a fabricated zero. */
  supplyShares: bigint | null;
  supplyBalance: bigint | null;  // USDG 6-dec
  borrowShares: bigint | null;
  debt: bigint | null;           // USDG 6-dec (rounded up, live-accrued)
  collateral: bigint | null;     // stock wei (18-dec)
  healthFactor: bigint | null;   // 1e18 · type(uint256).max when no debt
  usdgBalance: bigint | null;
  stockBalance: bigint | null;
}

export type CreditExecPhase =
  | { k: "idle" }
  | { k: "approving"; hash?: Hex }
  | { k: "sending"; hash?: Hex }
  | { k: "done"; hash: Hex; result?: bigint }
  | { k: "error"; message: string; hash?: Hex };

/* ---------- reads ---------- */

const SYMBOL_BY_ADDR = new Map<string, string>(
  (registry as { symbol: string; address: string }[]).map((t) => [t.address.toLowerCase(), t.symbol]),
);

/* Immutable pair metadata never changes — cache per address forever. */
interface PairMeta {
  collateral: Address; symbol: string;
  ltvBps: number; liqThresholdBps: number; liqBonusBps: number;
  borrowCap: bigint; supplyCap: bigint;
}
const pairMetaCache = new Map<string, PairMeta>();
let pairListCache: Address[] | null = null;
let pairListAt = 0;
const PAIR_LIST_TTL_MS = 3_600_000; // re-enumerate the factory hourly (audit I-3)

/* Three panels poll this — share one in-flight promise + 15s snapshot. */
let mktCache: { at: number; data: CreditMarket[] } | null = null;
let mktInflight: Promise<CreditMarket[]> | null = null;
const MKT_TTL_MS = 15_000;

/** `force` bypasses the snapshot (post-tx refresh must show new state now).
    A forced call never reuses an in-flight pre-tx read — it chains a fresh
    read behind it so post-tx panels always reflect confirmed state (audit L-1). */
export async function loadCreditMarkets(force = false): Promise<CreditMarket[]> {
  if (!force && mktCache && Date.now() - mktCache.at < MKT_TTL_MS) return mktCache.data;
  if (mktInflight && !force) return mktInflight;
  const prev = mktInflight;
  const p: Promise<CreditMarket[]> = (prev ? prev.catch(() => null) : Promise.resolve(null))
    .then(() => loadCreditMarketsUncached())
    .then((data) => { mktCache = { at: Date.now(), data }; return data; })
    .finally(() => { if (mktInflight === p) mktInflight = null; });
  mktInflight = p;
  return p;
}

async function loadCreditMarketsUncached(): Promise<CreditMarket[]> {
  if (!CREDIT_FACTORY) return [];
  if (!pairListCache || Date.now() - pairListAt > PAIR_LIST_TTL_MS) {
    pairListCache = [...((await limited(() => publicClient.readContract({
      address: CREDIT_FACTORY!, abi: creditFactoryAbi, functionName: "getAllPairs",
    }))) as readonly Address[])];
    pairListAt = Date.now();
  }
  const pairs = pairListCache;
  if (pairs.length === 0) return [];

  /* immutable metadata for pairs we have not seen yet */
  const unseen = pairs.filter((p) => !pairMetaCache.has(p.toLowerCase()));
  if (unseen.length > 0) {
    const metaCalls = unseen.flatMap((p) => [
      { address: p, abi: creditPairAbi, functionName: "COLLATERAL" } as const,
      { address: p, abi: creditPairAbi, functionName: "LTV_BPS" } as const,
      { address: p, abi: creditPairAbi, functionName: "LIQ_THRESHOLD_BPS" } as const,
      { address: p, abi: creditPairAbi, functionName: "LIQ_BONUS_BPS" } as const,
      { address: p, abi: creditPairAbi, functionName: "BORROW_CAP" } as const,
      { address: p, abi: creditPairAbi, functionName: "SUPPLY_CAP" } as const,
    ]);
    const metaRes = await limited(() => publicClient.multicall({ contracts: metaCalls, allowFailure: true }));
    unseen.forEach((p, i) => {
      const b = i * 6;
      /* all-or-nothing: immutables cannot legitimately half-fail */
      if (metaRes.slice(b, b + 6).some((r) => r.status !== "success")) return;
      const collateral = metaRes[b].result as Address;
      pairMetaCache.set(p.toLowerCase(), {
        collateral,
        symbol: SYMBOL_BY_ADDR.get(collateral.toLowerCase()) ?? collateral.slice(0, 8),
        ltvBps: Number(metaRes[b + 1].result as bigint),
        liqThresholdBps: Number(metaRes[b + 2].result as bigint),
        liqBonusBps: Number(metaRes[b + 3].result as bigint),
        borrowCap: metaRes[b + 4].result as bigint,
        supplyCap: metaRes[b + 5].result as bigint,
      });
    });
  }

  /* live state sweep — one multicall for all pairs */
  const known = pairs.filter((p) => pairMetaCache.has(p.toLowerCase()));
  const liveCalls = known.flatMap((p) => [
    { address: p, abi: creditPairAbi, functionName: "marketState" } as const,
    { address: p, abi: creditPairAbi, functionName: "priceStatus" } as const,
  ]);
  const live = await limited(() => publicClient.multicall({ contracts: liveCalls, allowFailure: true }));

  return known.map((p, i) => {
    const meta = pairMetaCache.get(p.toLowerCase())!;
    const ms = live[i * 2], ps = live[i * 2 + 1];
    let supplyAssets: bigint | null = null, borrowAssets: bigint | null = null, cash: bigint | null = null;
    let utilizationRay: bigint | null = null, borrowRateRay: bigint | null = null, supplyRateRay: bigint | null = null;
    let price: number | null = null, priceUpdatedAt: number | null = null, priceFresh: boolean | null = null;
    if (ms.status === "success") {
      const [sa, ba, c, u, br, sr] = ms.result as readonly bigint[];
      supplyAssets = sa; borrowAssets = ba; cash = c;
      utilizationRay = u; borrowRateRay = br; supplyRateRay = sr;
    }
    if (ps.status === "success") {
      const [px, at, fresh] = ps.result as readonly [bigint, bigint, boolean];
      price = px > 0n ? Number(px) / 1e18 : null;
      priceUpdatedAt = Number(at);
      priceFresh = fresh;
    }
    return { pair: p, ...meta, supplyAssets, borrowAssets, cash, utilizationRay, borrowRateRay, supplyRateRay, price, priceUpdatedAt, priceFresh };
  });
}

/** Per-account snapshot on one pair — single multicall, null-safe fields. */
export async function fetchCreditAccount(mkt: CreditMarket, account: Address): Promise<CreditAccount> {
  const res = await limited(() => publicClient.multicall({
    contracts: [
      { address: mkt.pair, abi: creditPairAbi, functionName: "accounts", args: [account] },
      { address: mkt.pair, abi: creditPairAbi, functionName: "supplyBalanceOf", args: [account] },
      { address: mkt.pair, abi: creditPairAbi, functionName: "debtOf", args: [account] },
      { address: mkt.pair, abi: creditPairAbi, functionName: "healthFactor", args: [account] },
      { address: TOKENS.USDG.address, abi: erc20Abi, functionName: "balanceOf", args: [account] },
      { address: mkt.collateral, abi: erc20Abi, functionName: "balanceOf", args: [account] },
    ] as const,
    allowFailure: true,
  }));
  const acct = res[0].status === "success"
    ? (res[0].result as readonly [bigint, bigint, bigint]) : null;
  return {
    supplyShares: acct ? acct[0] : null,
    borrowShares: acct ? acct[1] : null,
    collateral: acct ? acct[2] : null,
    supplyBalance: res[1].status === "success" ? (res[1].result as bigint) : null,
    debt: res[2].status === "success" ? (res[2].result as bigint) : null,
    healthFactor: res[3].status === "success" ? (res[3].result as bigint) : null,
    usdgBalance: res[4].status === "success" ? (res[4].result as bigint) : null,
    stockBalance: res[5].status === "success" ? (res[5].result as bigint) : null,
  };
}

/* ---------- derived math (mirrors contract; display only) ---------- */

/** Max additional USDG borrowable for a position (6-dec). Conservative by
    construction (audit M-1/L-4): price floors (never rounds up), a 0.1%
    safety factor absorbs interest accrual and oracle drift between quote and
    inclusion, the draw is clamped to fee-adjusted pool cash and borrow-cap
    headroom, and a first draw below MIN_DEBT returns 0. The contract remains
    the authority — this max must merely never exceed it. */
export function maxBorrow(mkt: CreditMarket, collateral: bigint, debt: bigint): bigint {
  if (mkt.price === null || !mkt.priceFresh) return 0n;
  if (mkt.cash === null || mkt.borrowAssets === null) return 0n;
  const priceWad = BigInt(Math.floor(mkt.price * 1e6)) * 10n ** 12n; // floor: never overstate
  const collateralUsd = (collateral * priceWad) / WAD;               // 1e18 USD
  const capacityWad = (collateralUsd * BigInt(mkt.ltvBps)) / 10_000n;
  const capacity6 = (capacityWad / 10n ** 12n) * 9_990n / 10_000n;   // 0.1% accrual/drift margin
  if (capacity6 <= debt) return 0n;
  /* every leg must cover the ceil'd origination fee the contract adds */
  const feeAdj = (x: bigint) => (x * 10_000n) / (10_000n + ORIGINATION_BPS);
  const ltvLeg = feeAdj(capacity6 - debt);
  const cashLeg = feeAdj(mkt.cash);
  const capRoom = mkt.borrowCap > mkt.borrowAssets ? mkt.borrowCap - mkt.borrowAssets : 0n;
  const capLeg = feeAdj(capRoom);
  let out = ltvLeg < cashLeg ? ltvLeg : cashLeg;
  if (capLeg < out) out = capLeg;
  if (out <= 0n) return 0n;
  const fee = (out * ORIGINATION_BPS + 9_999n) / 10_000n;
  if (debt + out + fee < MIN_DEBT) return 0n; // first draw below dust floor
  return out;
}

/** Annual percentage from a RAY per-year rate. */
export function rayToApr(ray: bigint | null): number | null {
  if (ray === null) return null;
  return Number(ray / 10n ** 18n) / 1e9 * 100;
}

/* ---------- writes (approve → simulate → send, mirroring options rails) ---------- */

async function ensureAllowance(
  token: Address, owner: Address, spender: Address, amount: bigint,
  onPhase: (p: CreditExecPhase) => void,
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
  try {
    const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rc.status !== "success") throw new Error("approval reverted");
  } catch (e) {
    tagHash(e, hash);
    throw e;
  }
}

function tagHash(e: unknown, hash: Hex): void {
  if (e && typeof e === "object") (e as { txHash?: Hex }).txHash = hash;
}
function hashOf(e: unknown): Hex | undefined {
  return e && typeof e === "object" ? (e as { txHash?: Hex }).txHash : undefined;
}

const ERR_COPY: Record<string, string> = {
  StalePrice: "oracle anchor is older than 26h — borrows, collateral removal and liquidations pause until it refreshes; repay and supply remain open",
  InvalidPrice: "oracle returned no price — try again shortly",
  SupplyCapExceeded: "market supply cap reached — try a smaller amount",
  BorrowCapExceeded: "market borrow cap reached — try a smaller amount",
  InsufficientLiquidity: "not enough un-lent USDG in the pool — wait for repayments or new supply",
  InsufficientShares: "amount exceeds your supplied balance",
  InsufficientCollateral: "amount exceeds your posted collateral",
  LtvExceeded: "this would push your loan above the max LTV — add collateral or borrow less",
  DebtTooSmall: "positions below 10 USDG debt are not allowed — repay in full or leave at least 10 USDG",
  NotLiquidatable: "position is healthy — nothing to liquidate",
  RepayTooSmall: "nothing to repay",
  NothingToSkim: "no reserves above the buffer to skim",
  ZeroAmount: "amount is zero",
  MarketUnknown: "oracle does not cover this market",
};

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
    : /transfer amount exceeds balance|insufficient balance/i.test(raw) ? "wallet balance can't cover this amount"
    : /insufficient allowance/i.test(raw) ? "token approval too small — retry the action"
    : /timed out|timeout/i.test(raw) ? "timed out waiting for confirmation — the tx may still land, check the explorer"
    : raw.split("\n")[0].slice(0, 90);
}

function errPhase(e: unknown, overrides?: Record<string, string>): CreditExecPhase {
  return { k: "error", message: friendly(e, overrides), hash: hashOf(e) };
}

async function drive(
  pair: Address,
  fn: "deposit" | "withdraw" | "addCollateral" | "removeCollateral" | "borrow" | "repay" | "skimReserves",
  args: readonly unknown[],
  account: Address,
  onPhase: (p: CreditExecPhase) => void,
  overrides?: Record<string, string>,
): Promise<boolean> {
  try {
    const wc = walletClient();
    if (!wc) throw new Error("wallet not connected");
    if (!(await ensureChain())) throw new Error("switch wallet to Robinhood Chain");
    onPhase({ k: "sending" });
    const { request, result } = await publicClient.simulateContract({
      address: pair, abi: creditPairAbi, functionName: fn,
      args: args as never, account, chain: robinhoodChain,
    });
    const hash = await wc.writeContract(request);
    onPhase({ k: "sending", hash });
    try {
      const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (rc.status !== "success") throw new Error(`${fn} reverted on-chain`);
      const r = Array.isArray(result) ? (result[0] as bigint) : (result as bigint | undefined);
      onPhase({ k: "done", hash, result: r });
      return true;
    } catch (e) {
      tagHash(e, hash);
      throw e;
    }
  } catch (e) {
    onPhase(errPhase(e, overrides));
    return false;
  }
}

/** Supply USDG to a pair. Exact-amount approval — never unlimited. */
export async function creditSupply(opts: {
  mkt: CreditMarket; amount: bigint; account: Address; onPhase: (p: CreditExecPhase) => void;
}): Promise<boolean> {
  const { mkt, amount, account, onPhase } = opts;
  try {
    if (!(await ensureChain())) throw new Error("switch wallet to Robinhood Chain");
    await ensureAllowance(TOKENS.USDG.address, account, mkt.pair, amount, onPhase);
  } catch (e) {
    onPhase(errPhase(e));
    return false;
  }
  return drive(mkt.pair, "deposit", [amount], account, onPhase);
}

/** Withdraw supplied USDG. `shares === max` withdraws everything. */
export async function creditWithdraw(opts: {
  mkt: CreditMarket; shares: bigint; account: Address; onPhase: (p: CreditExecPhase) => void;
}): Promise<boolean> {
  const { mkt, shares, account, onPhase } = opts;
  return drive(mkt.pair, "withdraw", [shares], account, onPhase, {
    InsufficientLiquidity:
      "withdrawal exceeds un-lent USDG — capital lent to borrowers unlocks as they repay; withdraw less for now",
  });
}

/** Post stock collateral. Exact-amount approval — never unlimited. */
export async function creditAddCollateral(opts: {
  mkt: CreditMarket; amount: bigint; account: Address; onPhase: (p: CreditExecPhase) => void;
}): Promise<boolean> {
  const { mkt, amount, account, onPhase } = opts;
  try {
    if (!(await ensureChain())) throw new Error("switch wallet to Robinhood Chain");
    await ensureAllowance(mkt.collateral, account, mkt.pair, amount, onPhase);
  } catch (e) {
    onPhase(errPhase(e));
    return false;
  }
  return drive(mkt.pair, "addCollateral", [amount], account, onPhase);
}

export async function creditRemoveCollateral(opts: {
  mkt: CreditMarket; amount: bigint; account: Address; onPhase: (p: CreditExecPhase) => void;
}): Promise<boolean> {
  const { mkt, amount, account, onPhase } = opts;
  return drive(mkt.pair, "removeCollateral", [amount], account, onPhase);
}

export async function creditBorrow(opts: {
  mkt: CreditMarket; amount: bigint; account: Address; onPhase: (p: CreditExecPhase) => void;
}): Promise<boolean> {
  const { mkt, amount, account, onPhase } = opts;
  return drive(mkt.pair, "borrow", [amount], account, onPhase);
}

/** Repay USDG debt. Approves debt+0.5% headroom for full repays (interest
    accrues between quote and inclusion); the contract only pulls what is owed. */
export async function creditRepay(opts: {
  mkt: CreditMarket; amount: bigint; full: boolean; debt: bigint;
  account: Address; onPhase: (p: CreditExecPhase) => void;
}): Promise<boolean> {
  const { mkt, amount, full, debt, account, onPhase } = opts;
  try {
    if (!(await ensureChain())) throw new Error("switch wallet to Robinhood Chain");
    const approveAmt = full ? debt + debt / 200n + 1n : amount;
    await ensureAllowance(TOKENS.USDG.address, account, mkt.pair, approveAmt, onPhase);
  } catch (e) {
    onPhase(errPhase(e));
    return false;
  }
  const sendAmt = full ? (2n ** 256n - 1n) : amount;
  return drive(mkt.pair, "repay", [sendAmt, account], account, onPhase);
}
