/* NAV — nav.fun · The Pit: client-side premium quoting.
   TS mirror of the on-chain PitPricer library (contracts/src/pit/PitPricer.sol,
   in development). Same constants, same formula:

     premium = intrinsic + timeValue
     intrinsic_call = max(P − K, 0) · intrinsic_put = max(K − P, 0)
     timeValue      = P · σ · √T_years · PHI            (bounded approximation)
     weekend floor  = timeValue × 1.5 when now is Sat/Sun UTC
     premium floor  = 0.5% of P

   Every quote produced here derives from a live Uniswap v3 read (P) and user
   inputs (K, T, qty). Nothing in this file fabricates data. */

export type PitSide = "CALL" | "PUT";

/** Per-market volatility parameter default. On-chain bounds: [20%, 300%], timelocked. */
export const PIT_SIGMA_DEFAULT = 0.6;
/** Time-value shape factor φ in P·σ·√T·φ (bounded approximation of ATM BSM time value). */
export const PIT_TV_PHI = 0.4;
/** Minimum premium floor as a fraction of P (dust-griefing guard, rec 13). */
export const PIT_MIN_PREMIUM_PCT = 0.005;
/** Weekend time-value floor multiplier — underlyings do not trade Sat/Sun (rec 7/8). */
export const PIT_WEEKEND_TV_MULT = 1.5;
/** Protocol fee on premium, bps (default 200 = 2%; bounds [50, 500]). Display only pre-launch. */
export const PIT_FEE_BPS = 200;

/** True when `now` falls on Saturday or Sunday, UTC. */
export function isWeekendUtc(now: Date = new Date()): boolean {
  const d = now.getUTCDay();
  return d === 0 || d === 6;
}

/** Intrinsic value per 1 underlying at price P for strike K. */
export function intrinsic(side: PitSide, P: number, K: number): number {
  return side === "CALL" ? Math.max(P - K, 0) : Math.max(K - P, 0);
}

/** Bounded time-value approximation per 1 underlying. Total for all inputs (T ≤ 0 ⇒ 0). */
export function timeValue(P: number, tYears: number, sigma: number = PIT_SIGMA_DEFAULT, now: Date = new Date()): number {
  if (!(P > 0) || !(tYears > 0)) return 0;
  const base = P * sigma * Math.sqrt(tYears) * PIT_TV_PHI;
  return isWeekendUtc(now) ? base * PIT_WEEKEND_TV_MULT : base;
}

/** Premium per 1 underlying: intrinsic + timeValue, floored at 0.5% of P. */
export function premium(
  side: PitSide,
  P: number,
  K: number,
  tYears: number,
  sigma: number = PIT_SIGMA_DEFAULT,
  now: Date = new Date(),
): number {
  if (!(P > 0) || !(K > 0)) return 0;
  const p = intrinsic(side, P, K) + timeValue(P, tYears, sigma, now);
  return Math.max(p, PIT_MIN_PREMIUM_PCT * P);
}

/** P&L at expiry for a call: qty·max(P−K,0) − premiumPaid (premiumPaid = total, quote units). */
export function pnlCall(P: number, K: number, qty: number, premiumPaid: number): number {
  return qty * Math.max(P - K, 0) - premiumPaid;
}

/** P&L at expiry for a put: qty·max(K−P,0) − premiumPaid. */
export function pnlPut(P: number, K: number, qty: number, premiumPaid: number): number {
  return qty * Math.max(K - P, 0) - premiumPaid;
}

export function pnl(side: PitSide, P: number, K: number, qty: number, premiumPaid: number): number {
  return side === "CALL" ? pnlCall(P, K, qty, premiumPaid) : pnlPut(P, K, qty, premiumPaid);
}

/** Breakeven underlying price at expiry, given premium per 1 underlying. */
export function breakeven(side: PitSide, K: number, premiumPerUnit: number): number {
  return side === "CALL" ? K + premiumPerUnit : Math.max(K - premiumPerUnit, 0);
}

/* ---------- expiries: weekly, Mondays 20:00 UTC — MUST mirror PitPool.EXPIRY_ANCHOR ---------- */

/** On-chain grid: PitPool.EXPIRY_ANCHOR = 4 days + 20 hours past the epoch week
    (epoch began Thu 1 Jan 1970, so the anchor lands on MONDAY 20:00 UTC).
    PitPool.buy() reverts BadExpiry for any timestamp off this grid, so these
    values are derived from the same modular arithmetic — never from weekday
    rolling, which silently drifts off-grid. */
const EXPIRY_ANCHOR_S = 4 * 86_400 + 20 * 3_600; // 417_600
const WEEK_S = 7 * 86_400;

/** Next `n` on-grid weekly expiries strictly after `now`. */
export function nextExpiries(n = 4, now: Date = new Date()): Date[] {
  const nowS = Math.floor(now.getTime() / 1000);
  const sinceAnchor = nowS - EXPIRY_ANCHOR_S;
  let next = EXPIRY_ANCHOR_S + (Math.floor(sinceAnchor / WEEK_S) + 1) * WEEK_S;
  const out: Date[] = [];
  for (let i = 0; i < n; i++) {
    out.push(new Date(next * 1000));
    next += WEEK_S;
  }
  return out;
}

/** Time to expiry in years (365-day convention, matches on-chain seconds/31_536_000). */
export function yearsTo(expiry: Date, now: Date = new Date()): number {
  return Math.max(expiry.getTime() - now.getTime(), 0) / (365 * 24 * 3600 * 1000);
}

/* ---------- strike grid: discrete, factory-set spacing per market (rec 9) ---------- */

/** Strike spacing derived from price magnitude — 1/2.5/5 × 10^n ladder, ≈2.5% of P. */
export function strikeSpacing(P: number): number {
  if (!(P > 0)) return 1;
  const raw = P * 0.025;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = n < 1.5 ? 1 : n < 3.5 ? 2.5 : n < 7.5 ? 5 : 10;
  return step * mag;
}

/** Discrete strike grid centred on the nearest on-grid strike to P: `half` each side. */
export function strikeGrid(P: number, half = 4): number[] {
  const s = strikeSpacing(P);
  const atm = Math.max(Math.round(P / s) * s, s);
  const out: number[] = [];
  for (let i = -half; i <= half; i++) {
    const k = atm + i * s;
    if (k > 0) out.push(Number(k.toFixed(6)));
  }
  return out;
}
