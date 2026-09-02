/* NAV — nav.fun · The Pit: live deployment registry + on-chain interface.
   Every address below is a real, source-verified mainnet contract on
   Robinhood Chain (4663). Markets were configured from on-chain state:
   deepest Uniswap v3 USDG pool per underlying, strike spacing ≈2.5% of
   spot at configuration, sigma per asset class (immutable per pool). */
import type { Address } from "viem";
import { publicClient } from "./chain";
import { limited, isRevert } from "./rpc";

export const PIT = {
  oracle: "0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd" as Address,
  factory: "0x63859B6f3F6A717c35a872B55eaA0F2B6e7fDB77" as Address,
  ticket: "0xd51C868353c084DA4c7685d755E7BFb9D41CA7b4" as Address,
  /** Block PitTicket v3 was deployed (security-campaign v6 redeploy).
      Lower bound for Transfer-log indexing so we never scan pre-deploy history. */
  ticketDeployBlock: 50_878_595n,
} as const;

export interface PitMarket {
  underlying: Address;
  pitPool: Address;
  v3Pool: Address;
  strikeSpacing: bigint; // 1e18 fp, quote per whole underlying
  sigmaBps: number;
  maxOiPerSeries: bigint;
}

/** Live Pit markets, keyed by vault-asset symbol. */
export const PIT_MARKETS: Record<string, PitMarket> = {
  NVDA: { underlying: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", pitPool: "0x8d7B83931e60e6a8364335C9aa62003Cf7Ae53Cf", v3Pool: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3", strikeSpacing: 5000000000000000000n, sigmaBps: 5000, maxOiPerSeries: 250000000000000000000n },
  SPCX: { underlying: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", pitPool: "0x1a446B069AaCeC3873F9d0F6EF7f334248e15cBe", v3Pool: "0xc61284332117c3FB23A2A56cceFFD07F7aF60029", strikeSpacing: 2000000000000000000n, sigmaBps: 9000, maxOiPerSeries: 250000000000000000000n },
  AMZN: { underlying: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", pitPool: "0xd041577c8d473423Db9004677C44bCdfEc9D79aF", v3Pool: "0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef", strikeSpacing: 5000000000000000000n, sigmaBps: 3500, maxOiPerSeries: 250000000000000000000n },
  GME: { underlying: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", pitPool: "0x009F1EE1bC5C0cec9f754FC98FD66C91b1fDA422", v3Pool: "0xE9713f453aDB9245B19559790c96F470a18F2fDF", strikeSpacing: 200000000000000000n, sigmaBps: 10000, maxOiPerSeries: 1000000000000000000000n },
  GOOGL: { underlying: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", pitPool: "0x16A0eBE405897B626BE3cB9881C9F6Cf9b3AD853", v3Pool: "0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7", strikeSpacing: 5000000000000000000n, sigmaBps: 3200, maxOiPerSeries: 250000000000000000000n },
  MU: { underlying: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", pitPool: "0x906D8334c6b59cBa02DB40d714e967b7921464d4", v3Pool: "0xd057B1Bc54917855BBee58eAd58647f47caB35E5", strikeSpacing: 20000000000000000000n, sigmaBps: 6000, maxOiPerSeries: 250000000000000000000n },
  QQQ: { underlying: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", pitPool: "0x0a4557b8167B4425922ef8F5CeB743E2fd9406A6", v3Pool: "0xEbD78dcfc8a6b3A696f1E191aD1ff321f9579f79", strikeSpacing: 20000000000000000000n, sigmaBps: 2500, maxOiPerSeries: 250000000000000000000n },
  USO: { underlying: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", pitPool: "0xdA7f45f33D9eca6C633F91662e08626fe720b270", v3Pool: "0x02175608F1b5E6b5ed221cCFdC7Be197D111D915", strikeSpacing: 2000000000000000000n, sigmaBps: 4000, maxOiPerSeries: 250000000000000000000n },
  SLV: { underlying: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", pitPool: "0xF6E2524E33840c93823500569D2Dc9200DEC4cd5", v3Pool: "0x8cB787e6c315D464775289BaD00FDD67d53Ecb3D", strikeSpacing: 1000000000000000000n, sigmaBps: 3000, maxOiPerSeries: 1000000000000000000000n },
  META: { underlying: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", pitPool: "0x54EEbB729491E324a7Bb7f92D7c6f6a5E8b48BDE", v3Pool: "0x107a7Cb40d8665360ba10E59471Af06150A50922", strikeSpacing: 10000000000000000000n, sigmaBps: 4000, maxOiPerSeries: 250000000000000000000n },
  AAPL: { underlying: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", pitPool: "0x305192fa78dc0ceAf9470CEd0f4472263C006D76", v3Pool: "0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D", strikeSpacing: 5000000000000000000n, sigmaBps: 3000, maxOiPerSeries: 250000000000000000000n },
  TSM: { underlying: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", pitPool: "0xA13C3af9b992e88d796a630932D050a9520eB1D2", v3Pool: "0x07e8Ea83D4C1340774c8965125e26e12bf943bf1", strikeSpacing: 10000000000000000000n, sigmaBps: 4000, maxOiPerSeries: 250000000000000000000n },
  SPY: { underlying: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", pitPool: "0xc8eE90783dBEfE504C7029Ce90A9B54dd6a7F5a6", v3Pool: "0xa7Bb1AC63BBaB0C44316E6c8C455213441689167", strikeSpacing: 10000000000000000000n, sigmaBps: 2500, maxOiPerSeries: 250000000000000000000n },
  TSLA: { underlying: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", pitPool: "0xE3322015C8F19E194a08457bb97D3FB5d264cf1E", v3Pool: "0xf4ACdAEEB7022862A763C9B1B885e11191c889E3", strikeSpacing: 5000000000000000000n, sigmaBps: 6000, maxOiPerSeries: 250000000000000000000n },
  MSFT: { underlying: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", pitPool: "0x4796a05dD57c13C31753B284DbDB64c616fcb18c", v3Pool: "0xeb60bCD1D920ad6E102690CCFC6fB488899E1510", strikeSpacing: 10000000000000000000n, sigmaBps: 3000, maxOiPerSeries: 250000000000000000000n },
  CRCL: { underlying: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", pitPool: "0x75CAf294de88963DE7B94b222860ccbbEc80E9B3", v3Pool: "0x654E4143e82a5824445Ade0824351C2A9ACD95a8", strikeSpacing: 2000000000000000000n, sigmaBps: 9000, maxOiPerSeries: 1000000000000000000000n },
  PLTR: { underlying: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", pitPool: "0x9E4433c10Df0c8761B0922FB74b673b0F18291F5", v3Pool: "0x851680416A4f4E1c463d45171d61ACDdBc8554c0", strikeSpacing: 2000000000000000000n, sigmaBps: 7000, maxOiPerSeries: 250000000000000000000n },
  AMD: { underlying: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", pitPool: "0xc7168D52942d135C419A87244b91915a00fc53A5", v3Pool: "0x48D284A2A4d3DC1b3Da08231Fe44317e7e7Aa51f", strikeSpacing: 10000000000000000000n, sigmaBps: 5000, maxOiPerSeries: 250000000000000000000n },
};

export const PIT_MARKET_COUNT = Object.keys(PIT_MARKETS).length;

export function marketFor(underlying: string): { symbol: string; market: PitMarket } | null {
  const hit = Object.entries(PIT_MARKETS).find(([, m]) => m.underlying.toLowerCase() === underlying.toLowerCase());
  return hit ? { symbol: hit[0], market: hit[1] } : null;
}

/* ---------------------------------------------------------------- ABIs */

export const pitPoolAbi = [
  /* custom errors — required so viem can decode simulation reverts by name */
  { type: "error", name: "SharesLocked", inputs: [] },
  { type: "error", name: "TooManyActiveExpiries", inputs: [] },
  { type: "error", name: "SweepTooEarly", inputs: [] },
  { type: "error", name: "Paused", inputs: [] },
  { type: "error", name: "BadStrike", inputs: [] },
  { type: "error", name: "BadExpiry", inputs: [] },
  { type: "error", name: "BadQty", inputs: [] },
  { type: "error", name: "SlippageExceeded", inputs: [] },
  { type: "error", name: "InsufficientLiquidity", inputs: [] },
  { type: "error", name: "OiCapExceeded", inputs: [] },
  { type: "error", name: "FrozenWindow", inputs: [] },
  { type: "error", name: "NotSettled", inputs: [] },
  { type: "error", name: "NotReconciled", inputs: [] },
  { type: "error", name: "AlreadyReconciled", inputs: [] },
  { type: "error", name: "NothingToClaim", inputs: [] },
  { type: "error", name: "NotTicketHolder", inputs: [] },
  { type: "error", name: "KeeperTooEarly", inputs: [] },
  { type: "error", name: "MultiplierChanged", inputs: [] },
  { type: "error", name: "NonStandardToken", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "WrongPoolTicket", inputs: [] },
  { type: "function", name: "quotePremium", stateMutability: "view", inputs: [{ name: "isCall", type: "bool" }, { name: "strike", type: "uint256" }, { name: "expiry", type: "uint64" }, { name: "qty", type: "uint128" }], outputs: [{ name: "premium", type: "uint256" }, { name: "price", type: "uint256" }] },
  { type: "function", name: "buy", stateMutability: "nonpayable", inputs: [{ name: "isCall", type: "bool" }, { name: "strike", type: "uint256" }, { name: "expiry", type: "uint64" }, { name: "qty", type: "uint128" }, { name: "maxPremium", type: "uint256" }], outputs: [{ name: "ticketId", type: "uint256" }, { name: "premium", type: "uint256" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "isCall", type: "bool" }, { name: "strike", type: "uint256" }, { name: "amount", type: "uint256" }], outputs: [{ name: "shares", type: "uint256" }] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "isCall", type: "bool" }, { name: "strike", type: "uint256" }, { name: "shares_", type: "uint256" }], outputs: [{ name: "amount", type: "uint256" }] },
  { type: "function", name: "claimPremiums", stateMutability: "nonpayable", inputs: [{ name: "isCall", type: "bool" }, { name: "strike", type: "uint256" }], outputs: [{ name: "owed", type: "uint256" }] },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [{ name: "expiry", type: "uint64" }], outputs: [{ name: "price", type: "uint256" }] },
  { type: "function", name: "settleTicket", stateMutability: "nonpayable", inputs: [{ name: "ticketId", type: "uint256" }], outputs: [{ name: "payout", type: "uint256" }] },
  { type: "function", name: "buckets", stateMutability: "view", inputs: [{ name: "", type: "bool" }, { name: "", type: "uint256" }], outputs: [{ name: "free", type: "uint128" }, { name: "locked", type: "uint128" }, { name: "totalShares", type: "uint128" }, { name: "accPremPerShare", type: "uint256" }] },
  { type: "function", name: "lps", stateMutability: "view", inputs: [{ name: "", type: "bool" }, { name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "shares", type: "uint128" }, { name: "premDebt", type: "int256" }] },
  /* AUDIT v3 GUARD #7 (P3-04) — per-series payout reserve. The claimable amount
     is capped at the series' remaining owedPayout, so the UI must show
     min(intrinsic, owedPayout) rather than theoretical intrinsic. */
  { type: "function", name: "series", stateMutability: "view", inputs: [{ name: "", type: "bool" }, { name: "", type: "uint256" }, { name: "", type: "uint64" }], outputs: [
    { name: "lockedColl", type: "uint128" }, { name: "oiQty", type: "uint128" },
    { name: "owedPayout", type: "uint128" }, { name: "multiplier", type: "uint128" },
    { name: "reconciled", type: "bool" },
  ] },
] as const;

/* AUDIT v4 X-01 — settlement prices are recorded on the PitOracle, keyed by
   (underlying, expiry). PitPool exposes no settlePrice accessor. */
export const pitOracleSettleAbi = [
  { type: "function", name: "settlementPrice", stateMutability: "view", inputs: [{ name: "underlying", type: "address" }, { name: "expiry", type: "uint64" }], outputs: [{ type: "uint256" }] },
] as const;

export const pitTicketAbi = [
  { type: "function", name: "nextId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "tickets", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [
    { name: "pool", type: "address" }, { name: "underlying", type: "address" }, { name: "isCall", type: "bool" },
    { name: "expiry", type: "uint64" }, { name: "strike1e18", type: "uint128" }, { name: "qty", type: "uint128" },
    { name: "premiumPaid", type: "uint128" }, { name: "writeMultiplier", type: "uint128" },
  ] },
] as const;

/* Robinhood Stock Tokens expose a corporate-action multiplier. Read live so the
   UI can detect a shifted payout basis (audit v3 P3-04). */
export const uiMultiplierAbi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const erc20WriteAbi = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/* ------------------------------------------------------- position reads */

export interface PitPosition {
  ticketId: bigint;
  pool: Address;
  underlying: Address;
  symbol: string;
  isCall: boolean;
  expiry: number;
  strike: number; // quote per whole underlying (float, from 1e18 — display only)
  qty: number; // contracts (float, from 1e18 — display only)
  strike1e18: bigint; // exact on-chain strike — use for contract args
  qty1e18: bigint; // exact on-chain qty — use for contract args
  premiumPaid: number; // USDG (float, from 6-dec wei)
  settled: boolean; // expiry passed and pool settle price recorded
  settlePrice: number | null;
  /* AUDIT v3 GUARD #6 (P3-04) — the corporate-action multiplier is read LIVE at
     both reconcile and settle, so if the underlying's uiMultiplier changes in
     between, identical tickets can pay unequal amounts and settlement becomes a
     first-come-first-served race. Carry both values so the UI can warn. */
  writeMultiplier: bigint; // multiplier stored in the ticket at write time
  liveMultiplier: bigint | null; // underlying's current uiMultiplier (null if unreadable)
  /* GUARD #7: series owedPayout remaining, in collateral units, when the series
     is reconciled — the true payout ceiling. null ⇒ not reconciled / unknown. */
  owedPayoutColl: bigint | null;
}

/* Poll-to-poll caches (M-08): ticket structs are immutable once minted and a
   burned id can never be resurrected, so neither needs re-reading every 20s. */
const burnedIds = new Set<string>();
const ticketStructCache = new Map<string, readonly [Address, Address, boolean, bigint, bigint, bigint, bigint, bigint]>();

/* AUDIT v5 M-2 — `fetchPositions` used to read `ownerOf` for EVERY id ever
   minted, on a 20s poll, for every viewer. That is O(nextId) RPC work per user
   per poll: at 50k tickets each viewer forces ~50k `ownerOf` calls every 20s,
   degrading into an RPC-cost DoS that grows with adoption.

   PitTicket is a plain ERC721, so the authoritative record of which ids an
   account could possibly hold is the Transfer log: an account can only own id X
   if it was once the `to` of a Transfer of X. We fetch that set (indexed topic,
   so the node filters server-side) and then confirm CURRENT ownership with
   `ownerOf` — the ownership answer is still read from chain state, never
   inferred from logs. Work becomes O(ids this account ever touched).

   Logs are used for CANDIDATE DISCOVERY only. If the node fails or rate-limits
   `eth_getLogs` we fall back to the exhaustive scan rather than silently
   showing an incomplete portfolio. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Ids this account was ever transferred, via indexed Transfer logs.
    Returns null when the node cannot serve the query — caller must fall back. */
async function candidateIdsFromLogs(account: Address): Promise<bigint[] | null> {
  try {
    const padded = ("0x" + account.slice(2).toLowerCase().padStart(64, "0")) as `0x${string}`;
    const logs = (await publicClient.request({
      method: "eth_getLogs" as never,
      params: [{
        address: PIT.ticket,
        fromBlock: `0x${PIT.ticketDeployBlock.toString(16)}`,
        toBlock: "latest",
        // [Transfer, from=any, to=account] — tokenId is the 3rd indexed topic
        topics: [TRANSFER_TOPIC, null, padded],
      }],
    } as never)) as { topics: string[] }[];
    const ids = new Set<string>();
    for (const l of logs) {
      if (l.topics && l.topics.length >= 4) ids.add(BigInt(l.topics[3]).toString());
    }
    return [...ids].map((s) => BigInt(s));
  } catch {
    return null; // fail to the exhaustive fallback, never to an empty portfolio
  }
}

/** All issued ticket ids — exhaustive fallback when log queries are unavailable. */
async function candidateIdsFromScan(): Promise<bigint[]> {
  const nextId = (await limited(() => publicClient.readContract({
    address: PIT.ticket, abi: pitTicketAbi, functionName: "nextId",
  }))) as bigint;
  const total = Number(nextId) - 1;
  if (total <= 0) return [];
  return Array.from({ length: total }, (_, i) => BigInt(i + 1));
}

/** Return the connected account's open positions. Ownership is always confirmed
    against live chain state via `ownerOf`. */
export async function fetchPositions(account: Address): Promise<PitPosition[]> {
  const fromLogs = await candidateIdsFromLogs(account);
  const candidates = fromLogs ?? (await candidateIdsFromScan());

  // Skip ids we already know are burned — they can never own again (M-08).
  const ids = candidates.filter((id) => !burnedIds.has(id.toString()));
  if (ids.length === 0) return [];
  const owners = await limited(() => publicClient.multicall({
    contracts: ids.map((id) => ({ address: PIT.ticket, abi: pitTicketAbi, functionName: "ownerOf" as const, args: [id] })),
    allowFailure: true,
  }));
  const mine: bigint[] = [];
  ids.forEach((id, i) => {
    const r = owners[i];
    /* A failed ownerOf means "burned" ONLY when it is an on-chain REVERT
       (ERC721NonexistentToken) — a transport/CORS failure must never be cached
       as a permanent burn (A-10). Log-discovered ids provably existed, so even
       reverts there are treated as burns only under the full scan. */
    if (r.status !== "success") { if (!fromLogs && isRevert(r.error)) burnedIds.add(id.toString()); return; }
    if ((r.result as string).toLowerCase() === account.toLowerCase()) mine.push(id);
  });
  if (mine.length === 0) return [];

  // Ticket structs are immutable — only fetch ids not seen before (M-08).
  const fresh = mine.filter((id) => !ticketStructCache.has(id.toString()));
  if (fresh.length > 0) {
    const data = await limited(() => publicClient.multicall({
      contracts: fresh.map((id) => ({ address: PIT.ticket, abi: pitTicketAbi, functionName: "tickets" as const, args: [id] })),
      allowFailure: false,
    }));
    fresh.forEach((id, i) => {
      ticketStructCache.set(id.toString(), data[i] as unknown as readonly [Address, Address, boolean, bigint, bigint, bigint, bigint, bigint]);
    });
  }

  const out: PitPosition[] = [];
  for (const id of mine) {
    const t = ticketStructCache.get(id.toString())!;
    const m = marketFor(t[1]);
    out.push({
      ticketId: id,
      pool: t[0],
      underlying: t[1],
      symbol: m?.symbol ?? "?",
      isCall: t[2],
      expiry: Number(t[3]),
      strike: Number(t[4]) / 1e18,
      qty: Number(t[5]) / 1e18,
      strike1e18: t[4],
      qty1e18: t[5],
      premiumPaid: Number(t[6]) / 1e6,
      settled: false,
      settlePrice: null,
      writeMultiplier: t[7],
      liveMultiplier: null,
      owedPayoutColl: null,
    });
  }

  /* Live uiMultiplier per distinct underlying (P3-04 guard). Tokens without the
     accessor simply report null and no warning is shown. */
  const uniqueUnderlyings = [...new Set(out.map((p) => p.underlying.toLowerCase()))] as Address[];
  if (uniqueUnderlyings.length > 0) {
    const mults = await limited(() => publicClient.multicall({
      contracts: uniqueUnderlyings.map((u) => ({
        address: u, abi: uiMultiplierAbi, functionName: "uiMultiplier" as const,
      })),
      allowFailure: true,
    }));
    const byToken = new Map<string, bigint>();
    uniqueUnderlyings.forEach((u, i) => {
      const r = mults[i];
      if (r.status === "success") byToken.set(u.toLowerCase(), r.result as bigint);
    });
    for (const p of out) p.liveMultiplier = byToken.get(p.underlying.toLowerCase()) ?? null;
  }

  // settle-price + series-reserve lookups for expired positions
  const expired = out.filter((p) => p.expiry * 1000 < Date.now());
  if (expired.length > 0) {
    const [sp, sr] = await Promise.all([
      limited(() => publicClient.multicall({
        /* AUDIT v4 X-01 — settle price lives on the oracle (settlementPrice), not on PitPool. */
        contracts: expired.map((p) => ({ address: PIT.oracle, abi: pitOracleSettleAbi, functionName: "settlementPrice" as const, args: [p.underlying, BigInt(p.expiry)] })),
        allowFailure: true,
      })),
      limited(() => publicClient.multicall({
        contracts: expired.map((p) => ({ address: p.pool, abi: pitPoolAbi, functionName: "series" as const, args: [p.isCall, p.strike1e18, BigInt(p.expiry)] })),
        allowFailure: true,
      })),
    ]);
    expired.forEach((p, i) => {
      const r = sp[i];
      if (r.status === "success" && (r.result as bigint) > 0n) {
        p.settled = true;
        p.settlePrice = Number(r.result as bigint) / 1e18;
      }
      const s = sr[i];
      if (s.status === "success") {
        const [, , owedPayout, , reconciled] = s.result as readonly [bigint, bigint, bigint, bigint, boolean];
        if (reconciled) p.owedPayoutColl = owedPayout;
      }
    });
  }
  return out;
}

/** Live on-chain premium quote from the pool itself (the exact number buy() will charge). */
export async function quotePremiumOnChain(
  pool: Address, isCall: boolean, strike1e18: bigint, expiry: number, qty1e18: bigint,
): Promise<{ premium: bigint; price: bigint } | null> {
  try {
    const [premium, price] = (await publicClient.readContract({
      address: pool, abi: pitPoolAbi, functionName: "quotePremium",
      args: [isCall, strike1e18, BigInt(expiry), qty1e18],
    })) as readonly [bigint, bigint];
    return { premium, price };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- series depth */

export interface SeriesDepth {
  /** Free writer collateral in the (side, strike) bucket, native wei. */
  free: bigint;
  /** Max contracts buyable at this strike right now (1e18 fp qty). */
  maxQty1e18: bigint;
}

/** Read writer-side depth for a series. CALL buckets escrow the underlying
    (1 token per contract); PUT buckets escrow USDG (strike per contract). */
export async function seriesDepth(
  m: PitMarket, isCall: boolean, strike1e18: bigint,
): Promise<SeriesDepth | null> {
  try {
    const [free] = (await publicClient.readContract({
      address: m.pitPool, abi: pitPoolAbi, functionName: "buckets",
      args: [isCall, strike1e18],
    })) as readonly [bigint, bigint, bigint, bigint];
    let maxQty1e18: bigint;
    if (isCall) {
      // free is underlying wei (18 dec) — 1e18 fp qty locks qty tokens.
      maxQty1e18 = free;
    } else {
      // free is USDG wei (6 dec); lock per 1e18 qty = strike1e18 scaled to 6 dec.
      const lockPerUnit = strike1e18 / 10n ** 12n; // USDG wei per whole contract
      maxQty1e18 = lockPerUnit === 0n ? 0n : (free * 10n ** 18n) / lockPerUnit;
      // The pool ceils its required lock; our floor division can overshoot by
      // one rounding step at the exact boundary. Verify and trim (L-02).
      while (maxQty1e18 > 0n && (maxQty1e18 * lockPerUnit + 10n ** 18n - 1n) / 10n ** 18n > free) {
        maxQty1e18 -= 1n;
      }
    }
    return { free, maxQty1e18 };
  } catch {
    return null;
  }
}
