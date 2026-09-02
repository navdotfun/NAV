/* FLOOR — multi-venue quote engine.
   Mirrors NavSwapRouter's route model exactly: every route passes through the
   USDG waypoint; the 20 bps interface fee is skimmed in USDG at the waypoint.
   Quotes are genuine eth_calls against the live venue quoters — nothing here
   is estimated client-side. */
import type { Address } from "viem";
import {
  publicClient, UNISWAP, UP, TOKENS, FEE_BPS,
  V3_FEE_TIERS, CL_TICK_SPACINGS,
  quoterV2Abi, clQuoterAbi, upV2RouterAbi,
} from "./chain";
import { isRevert } from "./nav/rpc";

/** Thrown when a quote failed for TRANSPORT reasons (HTTP/CORS/timeout) —
    callers must keep the last-good quote and re-quote, never render "—". */
export class QuoteTransportError extends Error {
  constructor() { super("quote transport failure"); this.name = "QuoteTransportError"; }
}

const QUOTE_TRIES = 3;

/** Run one venue simulation. Decoded revert → null (genuine no-pool /
    no-liquidity). Transport failure → retried with backoff (concurrent
    retries re-coalesce into one JSON-RPC batch), then thrown. */
async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (isRevert(e)) return null;
      if (i >= QUOTE_TRIES - 1) throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
}

/** Router venue ids (must match NavSwapRouter constants). */
export const VENUE_NONE = 0;
export const VENUE_UNIV3 = 1;
export const VENUE_UP_CL = 2;
export const VENUE_UP_V2 = 3;

export interface VenueQuote {
  venue: 1 | 2 | 3;
  /** fee tier (UniV3) · tickSpacing (up. CL) · stable flag 0/1 (up. v2) */
  param: number;
  amountOut: bigint;
  gasEstimate: bigint;
}

export interface LegBook {
  /** every venue that returned a real quote, best first */
  quotes: VenueQuote[];
  best: VenueQuote | null;
}

export interface RouteQuote {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** USDG amount at the waypoint BEFORE fee */
  waypoint: bigint;
  feeUsdg: bigint;
  amountOut: bigint;
  legIn: LegBook | null;  // null when tokenIn is USDG
  legOut: LegBook | null; // null when tokenOut is USDG
  quotedAt: number;
}

const USDG = TOKENS.USDG.address;

async function quoteUniV3(tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number): Promise<VenueQuote | null> {
  const r = await attempt(() => publicClient.simulateContract({
    address: UNISWAP.quoterV2,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  }));
  if (r === null) return null;
  const [amountOut, , , gasEstimate] = r.result;
  return amountOut > 0n ? { venue: VENUE_UNIV3, param: fee, amountOut, gasEstimate } : null;
}

async function quoteUpCl(tokenIn: Address, tokenOut: Address, amountIn: bigint, tickSpacing: number): Promise<VenueQuote | null> {
  const r = await attempt(() => publicClient.simulateContract({
    address: UP.clQuoter,
    abi: clQuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
  }));
  if (r === null) return null;
  const [amountOut, , , gasEstimate] = r.result;
  return amountOut > 0n ? { venue: VENUE_UP_CL, param: tickSpacing, amountOut, gasEstimate } : null;
}

async function quoteUpV2(tokenIn: Address, tokenOut: Address, amountIn: bigint, stable: boolean): Promise<VenueQuote | null> {
  const amounts = await attempt(() => publicClient.readContract({
    address: UP.v2Router,
    abi: upV2RouterAbi,
    functionName: "getAmountsOut",
    args: [amountIn, [{ from: tokenIn, to: tokenOut, stable, factory: UP.v2Factory }]],
  }));
  if (amounts === null) return null;
  const amountOut = amounts[amounts.length - 1];
  return amountOut > 0n ? { venue: VENUE_UP_V2, param: stable ? 1 : 0, amountOut, gasEstimate: 150000n } : null;
}

type Candidate = { venue: 1 | 2 | 3; param: number };

const ALL_CANDIDATES: Candidate[] = [
  ...V3_FEE_TIERS.map((f): Candidate => ({ venue: VENUE_UNIV3, param: f })),
  ...CL_TICK_SPACINGS.map((ts): Candidate => ({ venue: VENUE_UP_CL, param: ts })),
  { venue: VENUE_UP_V2, param: 0 },
];

/* Per-pair venue book: after a full sweep, only the venues that actually
   held liquidity (top 3) are re-quoted on subsequent keystrokes; a fresh
   full sweep runs every SWEEP_TTL_MS or when the cached venues dry up.
   Cuts steady-state quote cost from ~10 eth_calls/leg to ≤3. */
const venueBook = new Map<string, { candidates: Candidate[]; sweepAt: number }>();
const SWEEP_TTL_MS = 60_000;
const pairKey = (a: Address, b: Address) => `${a.toLowerCase()}>${b.toLowerCase()}`;

function quoteCandidate(c: Candidate, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<VenueQuote | null> {
  if (c.venue === VENUE_UNIV3) return quoteUniV3(tokenIn, tokenOut, amountIn, c.param);
  if (c.venue === VENUE_UP_CL) return quoteUpCl(tokenIn, tokenOut, amountIn, c.param);
  return quoteUpV2(tokenIn, tokenOut, amountIn, c.param === 1);
}

async function runCandidates(cands: Candidate[], tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<LegBook> {
  const settled = await Promise.allSettled(cands.map((c) => quoteCandidate(c, tokenIn, tokenOut, amountIn)));
  const quotes: VenueQuote[] = [];
  let transportFailures = 0;
  for (const s of settled) {
    if (s.status === "fulfilled") { if (s.value !== null) quotes.push(s.value); }
    else transportFailures += 1;
  }
  /* Nothing quoted AND at least one transport failure → we genuinely do not
     know the book. Throw so callers keep their last-good quote (never "—").
     All-reverts with zero transport failures is an honest empty book. */
  if (quotes.length === 0 && transportFailures > 0) throw new QuoteTransportError();
  quotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  return { quotes, best: quotes[0] ?? null };
}

/** Quote one leg (token↔USDG). Full venue sweep on first sight of a pair
    (and every 60s); cached liquid venues only in between. */
export async function quoteLeg(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<LegBook> {
  const key = pairKey(tokenIn, tokenOut);
  const cached = venueBook.get(key);
  const fresh = !!cached && cached.candidates.length > 0 && Date.now() - cached.sweepAt < SWEEP_TTL_MS;

  if (fresh) {
    const book = await runCandidates(cached.candidates, tokenIn, tokenOut, amountIn);
    if (book.best) return book;
    /* cached venues dried up — immediately re-sweep everything */
  }
  const book = await runCandidates(ALL_CANDIDATES, tokenIn, tokenOut, amountIn);
  venueBook.set(key, {
    candidates: book.quotes.slice(0, 3).map((q) => ({ venue: q.venue, param: q.param })),
    sweepAt: Date.now(),
  });
  return book;
}

/** Full route quote mirroring NavSwapRouter fee semantics exactly. */
export async function quoteRoute(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<RouteQuote | null> {
  if (amountIn <= 0n || tokenIn === tokenOut) return null;
  const inIsUsdg = tokenIn === USDG;
  const outIsUsdg = tokenOut === USDG;

  let legIn: LegBook | null = null;
  let waypoint: bigint;
  if (inIsUsdg) {
    waypoint = amountIn;
  } else {
    legIn = await quoteLeg(tokenIn, USDG, amountIn);
    if (!legIn.best) return null;
    waypoint = legIn.best.amountOut;
  }

  const feeUsdg = (waypoint * BigInt(FEE_BPS)) / 10_000n;
  const net = waypoint - feeUsdg;
  if (net <= 0n) return null;

  let legOut: LegBook | null = null;
  let amountOut: bigint;
  if (outIsUsdg) {
    amountOut = net;
  } else {
    legOut = await quoteLeg(USDG, tokenOut, net);
    if (!legOut.best) return null;
    amountOut = legOut.best.amountOut;
  }

  return { tokenIn, tokenOut, amountIn, waypoint, feeUsdg, amountOut, legIn, legOut, quotedAt: Date.now() };
}

export function venueName(q: VenueQuote): string {
  if (q.venue === VENUE_UNIV3) return `UNISWAP V3 ${(q.param / 10_000).toFixed(2)}%`;
  if (q.venue === VENUE_UP_CL) return `UP· CL TS${q.param}`;
  return q.param === 1 ? "UP· V2 STABLE" : "UP· V2";
}

export function venueShort(q: VenueQuote): string {
  if (q.venue === VENUE_UNIV3) return "UNI V3";
  if (q.venue === VENUE_UP_CL) return "UP CL";
  return "UP V2";
}
