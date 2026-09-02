/* The Pit — position builder. Side, strike grid, weekly expiry, quantity.
   The indicative breakdown mirrors the on-chain PitPricer; the live order
   path (on-chain quote + approve/buy state machine) renders in the `action`
   slot supplied by the page. */
import type { ReactNode } from "react";
import {
  intrinsic,
  isWeekendUtc,
  PIT_FEE_BPS,
  PIT_MIN_PREMIUM_PCT,
  breakeven,
  PIT_SIGMA_DEFAULT,
  timeValue,
  yearsTo,
  type PitSide,
} from "../../lib/pitPricer";
import { fmt } from "../../lib/format";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function expiryLabel(d: Date): string {
  const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return `${DAYS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} · 20:00 UTC`;
}

export function PositionBuilder({
  symbol,
  side,
  onSide,
  strikes,
  strike,
  onStrike,
  expiries,
  expiryIdx,
  onExpiry,
  qty,
  onQty,
  livePrice,
  premiumPerUnit,
  sigma = PIT_SIGMA_DEFAULT,
  action,
}: {
  symbol: string;
  side: PitSide;
  onSide: (s: PitSide) => void;
  strikes: number[];
  strike: number | null;
  onStrike: (k: number) => void;
  expiries: Date[];
  expiryIdx: number;
  onExpiry: (i: number) => void;
  qty: string;
  onQty: (v: string) => void;
  livePrice: number | null;
  premiumPerUnit: number | null;
  /** annualized volatility used in the indicative breakdown (per-market when live) */
  sigma?: number;
  /** live order path — rendered under the quote breakdown */
  action?: ReactNode;
}) {
  const expiry = expiries[expiryIdx];
  const weekend = isWeekendUtc();
  const T = expiry ? yearsTo(expiry) : 0;
  const intr = livePrice !== null && strike !== null ? intrinsic(side, livePrice, strike) : null;
  const tv = livePrice !== null ? timeValue(livePrice, T, sigma) : null;
  /* the 0.5%-of-P floor binds when it exceeds intrinsic + time value */
  const floored =
    livePrice !== null && intr !== null && tv !== null
      ? PIT_MIN_PREMIUM_PCT * livePrice > intr + tv
      : false;

  return (
    <section className="panel">
      <div className="flex border-b border-ink-3" role="radiogroup" aria-label="Option side">
        <button
          className={`trade-tab ${side === "CALL" ? "active" : ""}`}
          role="radio"
          aria-checked={side === "CALL"}
          onClick={() => onSide("CALL")}
        >
          CALL
        </button>
        <button
          className={`trade-tab put ${side === "PUT" ? "active" : ""}`}
          role="radio"
          aria-checked={side === "PUT"}
          onClick={() => onSide("PUT")}
        >
          PUT
        </button>
      </div>

      <div className="p-4.5">
        {/* strike grid */}
        <div className="mb-3.5">
          <span className="field-label">Strike — discrete grid around live price</span>
          {strikes.length === 0 ? (
            <div className="border border-dashed border-ink-3 px-3.5 py-3 text-[13px] text-muted-dark">
              Select an underlying with a live pool to load the strike grid.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Strike">
              {strikes.map((k) => (
                <button
                  key={k}
                  role="radio"
                  aria-checked={strike === k}
                  className={`asset-pick num ${strike === k ? (side === "PUT" ? "active-put" : "active") : ""}`}
                  onClick={() => onStrike(k)}
                >
                  {fmt.usd(k)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* expiry */}
        <div className="mb-3.5">
          <span className="field-label">Expiry — weekly, Mondays 20:00 UTC</span>
          <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Expiry">
            {expiries.map((d, i) => (
              <button
                key={d.getTime()}
                role="radio"
                aria-checked={expiryIdx === i}
                className={`asset-pick !text-[15px] ${expiryIdx === i ? (side === "PUT" ? "active-put" : "active") : ""}`}
                onClick={() => onExpiry(i)}
              >
                {expiryLabel(d)}
              </button>
            ))}
          </div>
        </div>

        {/* qty */}
        <div className="mb-3.5">
          <label className="field-label" htmlFor="pit-qty">
            Quantity — contracts of 1 {symbol || "token"} each
          </label>
          <div className="amt-row">
            <input
              id="pit-qty"
              type="number"
              min="0"
              step="any"
              placeholder="1"
              inputMode="decimal"
              value={qty}
              onChange={(e) => onQty(e.target.value)}
            />
            <span className="asset">× {symbol || "—"}</span>
          </div>
        </div>

        {/* quote total — the one number the buyer signs for */}
        <div className="quote-total">
          <span className="fig">
            {premiumPerUnit !== null && Number.isFinite(Number.parseFloat(qty)) && Number.parseFloat(qty) > 0
              ? fmt.usd(premiumPerUnit * Number.parseFloat(qty))
              : "—"}
          </span>
          <span className="be num">
            {premiumPerUnit !== null && strike !== null
              ? `BREAKEVEN ${fmt.usd(breakeven(side, strike, premiumPerUnit))}`
              : "TOTAL PREMIUM"}
          </span>
        </div>

        {/* quote breakdown — every figure from live P + inputs */}
        <details className="quote-derivation mb-4">
          <summary>DERIVATION +</summary>
        <div className="mt-2.5 grid gap-1.5 text-[13px] text-muted-dark">
          <div className="flex justify-between gap-3">
            <span>Intrinsic ({side === "CALL" ? "max(P−K,0)" : "max(K−P,0)"})</span>
            <b className="num font-medium text-paper">{intr !== null ? fmt.usd(intr) : "—"}</b>
          </div>
          <div className="flex justify-between gap-3">
            <span>
              Time value (σ {Math.round(sigma * 100)}%{weekend ? " · weekend floor ×1.5" : ""})
            </span>
            <b className="num font-medium text-paper">{tv !== null ? fmt.usd(tv) : "—"}</b>
          </div>
          {floored && (
            <div className="flex justify-between gap-3">
              <span>Minimum premium floor ({fmt.pct(PIT_MIN_PREMIUM_PCT, 1)} of P)</span>
              <b className="num font-medium text-paper">applied</b>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <span>Premium / contract</span>
            <b className="num font-medium text-paper">{premiumPerUnit !== null ? fmt.usd(premiumPerUnit) : "—"}</b>
          </div>
          <div className="flex justify-between gap-3">
            <span>Protocol fee (of premium, to FeeSplitter)</span>
            <b className="num font-medium text-paper">{(PIT_FEE_BPS / 100).toFixed(0)}% · 80/15/5</b>
          </div>
        </div>
        </details>

        {action ?? null}
      </div>
    </section>
  );
}
