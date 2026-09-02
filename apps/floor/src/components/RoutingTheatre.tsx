/* ROUTING — the theatre. Every venue's genuine quote for each leg of the
   route, best execution highlighted. This is the product's proof-of-work:
   the user watches the floor get shopped. */
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import type { OrderState } from "./SwapPanel";
import { TOKEN_BY_SYMBOL } from "../lib/data";
import { venueName, VENUE_UNIV3, VENUE_UP_CL, type LegBook, type RouteQuote, type VenueQuote } from "../lib/venues";
import { FEE_BPS } from "../lib/chain";
import { fmt } from "../lib/format";

function VenueRow({ q, best, outDec, outSym, bestOut }: {
  q: VenueQuote; best: boolean; outDec: number; outSym: string; bestOut: bigint;
}) {
  const out = Number(formatUnits(q.amountOut, outDec));
  const top = Number(formatUnits(bestOut, outDec));
  /* shortfall vs best execution, in bps (0 for the best row) */
  const lag = top > 0 ? ((out - top) / top) * 10_000 : 0;
  const lagLabel = best ? "BEST" : lag <= -9_900 ? "<-99%" : `${lag.toFixed(1)} BPS`;
  return (
    <tr className={best ? "bg-amber/10" : ""}>
      <td className={`px-2 py-[3px] text-[11px] ${best ? "text-amber-2 font-semibold" : "text-txt"}`}>
        {best ? "▶ " : "  "}{venueName(q)}
      </td>
      <td className="px-2 py-[3px] text-right text-[11px] text-txt">
        {fmt.num(out, out < 1 ? 6 : 4)} <span className="text-txt-dim">{outSym}</span>
      </td>
      <td className={`px-2 py-[3px] text-right text-[11px] ${best ? "text-up" : "text-txt-dim"}`}>
        {lagLabel}
      </td>
      <td className="px-2 py-[3px] text-right text-[10.5px] text-txt-dim hidden xl:table-cell">
        {q.venue === VENUE_UNIV3 ? `FEE ${q.param}` : q.venue === VENUE_UP_CL ? `TS ${q.param}` : q.param ? "STABLE" : "VOLATILE"}
      </td>
    </tr>
  );
}

function Leg({ title, book, outDec, outSym, quoting }: {
  title: string; book: LegBook | null; outDec: number; outSym: string; quoting: boolean;
}) {
  if (!book) return null;
  const bestOut = book.best ? book.best.amountOut : 0n;
  return (
    <div className="border border-rule">
      <div className="px-2 py-1 text-[10.5px] tracking-[0.14em] text-amber border-b border-rule flex justify-between">
        <span>{title}</span>
        <span className="text-txt-dim">{book.quotes.length} VENUE{book.quotes.length === 1 ? "" : "S"} QUOTED</span>
      </div>
      <table className="w-full border-collapse">
        <tbody>
          {book.quotes.map((q, i) => (
            <VenueRow key={`${q.venue}-${q.param}`} q={q} best={i === 0} outDec={outDec} outSym={outSym} bestOut={bestOut} />
          ))}
          {book.quotes.length === 0 && (
            <tr><td className={`px-2 py-2 text-[11px] ${quoting ? "text-amber-dim venue-ping" : "text-dn"}`}>
              {quoting ? "SWEEPING VENUES…" : "NO LIQUIDITY"}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function RoutingTheatre({ quote, quoting, order, quotedAt }: {
  quote: RouteQuote | null; quoting: boolean; order: OrderState;
  /** Unix ms of the last successful quote — drives the LIVE / STALE badge. */
  quotedAt: number | null;
}) {
  const tok = TOKEN_BY_SYMBOL.get(order.symbol);
  const stockDec = tok?.decimals ?? 18;

  /* B-21: the quote-age line froze at its render-time value — tick it. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!quote) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [quote]);
  const ageS = quote ? Math.max(0, Math.round((now - (quotedAt ?? quote.quotedAt)) / 1000)) : 0;
  const stale = quote !== null && ageS > 20;

  return (
    <section className="panel flex-1 flex flex-col min-h-0" aria-label="routing">
      <div className="panel-title">
        <span>ROUTING · BEST EXECUTION</span>
        {quoting ? <span className="text-amber-2 normal-case venue-ping">SWEEP<span className="blink">▮</span></span>
          : quote ? <span className={stale ? "text-dn" : "text-up"}>{stale ? "STALE" : "LIVE"}</span> : null}
      </div>
      <div className="p-2 flex flex-col gap-2 overflow-y-auto">
        {!quote && !quoting && (
          <div className="text-txt-dim text-[12px] p-3 leading-relaxed">
            ENTER AN ORDER TO OPEN THE FLOOR.
            <br />
            <span className="text-amber-dim">
              Every venue on Robinhood Chain is quoted live — Uniswap V3 (4 fee tiers),
              up. Slipstream (5 tick spacings), up. V2 — and the route is settled through
              the USDG waypoint with a {FEE_BPS} bps fee funding NAV vault accretion.
            </span>
          </div>
        )}
        {quote && (
          <>
            {quote.legIn && (
              <Leg title={`LEG 1 · ${order.symbol} → USDG`} book={quote.legIn} outDec={6} outSym="USDG" quoting={quoting} />
            )}
            <div className="flex items-center gap-2 px-1">
              <span className="text-amber-dim text-[10.5px] tracking-[0.14em]">USDG WAYPOINT</span>
              <span className="flex-1 border-t border-dashed border-rule-2" />
              <span className="text-[11px] text-txt">
                {fmt.num(Number(formatUnits(quote.waypoint, 6)), 2)} USDG
                <span className="text-txt-dim"> − {fmt.num(Number(formatUnits(quote.feeUsdg, 6)), 4)} FEE ({FEE_BPS} BPS → VAULT)</span>
              </span>
            </div>
            {quote.legOut && (
              <Leg title={`LEG 2 · USDG → ${order.symbol}`} book={quote.legOut} outDec={stockDec} outSym={order.symbol} quoting={quoting} />
            )}
            <div className="border border-amber/40 bg-amber/5 px-2 py-1.5 flex items-baseline justify-between">
              <span className="text-[10.5px] tracking-[0.16em] text-amber">ROUTE SETTLES</span>
              <span className="text-[13px] text-amber-2 font-semibold">
                {order.side === "BUY"
                  ? `${fmt.num(Number(formatUnits(quote.amountOut, stockDec)), 4)} ${order.symbol}`
                  : `${fmt.num(Number(formatUnits(quote.amountOut, 6)), 2)} USDG`}
              </span>
            </div>
            <p className="text-[10px] text-txt-dim px-1">
              Quote age {ageS}s · auto-refresh 15s ·
              identical venue set and fee math to the NavSwapRouter contract.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
