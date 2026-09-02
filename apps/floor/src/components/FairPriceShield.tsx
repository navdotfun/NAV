/* FAIR PRICE SHIELD — execution price vs external oracle anchor
   (PitOracleV2: Chainlink primary, Pyth fallback — read live on-chain). */
import { formatUnits } from "viem";
import type { OrderState } from "./SwapPanel";
import type { Anchor, Listing } from "../lib/data";
import { TOKEN_BY_SYMBOL } from "../lib/data";
import type { RouteQuote } from "../lib/venues";
import { fmt } from "../lib/format";

export function FairPriceShield({ order, quote, anchor, listing }: {
  order: OrderState; quote: RouteQuote | null; anchor: Anchor | null; listing: Listing | null;
}) {
  const tok = TOKEN_BY_SYMBOL.get(order.symbol);

  /* execution price implied by the live quote (USDG per share) */
  let execPrice: number | null = null;
  if (quote && tok) {
    if (order.side === "BUY") {
      const sharesOut = Number(formatUnits(quote.amountOut, tok.decimals));
      const usdgIn = Number(formatUnits(quote.amountIn, 6));
      if (sharesOut > 0) execPrice = usdgIn / sharesOut;
    } else {
      const sharesIn = Number(formatUnits(quote.amountIn, tok.decimals));
      const usdgOut = Number(formatUnits(quote.amountOut, 6));
      if (sharesIn > 0) execPrice = usdgOut / sharesIn;
    }
  }

  const refPrice = anchor?.price ?? null;
  const devBps = execPrice !== null && refPrice !== null && refPrice > 0
    ? ((execPrice - refPrice) / refPrice) * 10_000
    : null;
  /* BUY above anchor = paying up (bad); SELL below anchor = giving up (bad) */
  const adverse = devBps !== null ? (order.side === "BUY" ? devBps : -devBps) : null;
  const verdict = adverse === null ? null : adverse <= 30 ? "FAIR" : adverse <= 100 ? "CHECK" : "WIDE";
  const verdictColor = verdict === "FAIR" ? "text-up" : verdict === "CHECK" ? "text-amber-2" : "text-dn";
  const age = anchor ? Math.max(0, Math.floor(Date.now() / 1000 - anchor.updatedAt)) : null;

  return (
    <section className="panel" aria-label="fair price shield">
      <div className="panel-title">
        <span>FAIR PRICE SHIELD</span>
        {anchor && <span className="text-txt-dim normal-case tracking-normal">{anchor.source}</span>}
      </div>
      <div className="p-2 grid grid-cols-2 gap-x-2 gap-y-1.5 text-[11.5px]">
        <span className="cell-label">Exec px</span>
        <span className="text-right text-txt">{execPrice !== null ? fmt.usd(execPrice, execPrice < 1 ? 4 : 2) : "—"}</span>
        <span className="cell-label">Anchor px</span>
        <span className="text-right text-txt">
          {refPrice !== null ? fmt.usd(refPrice, refPrice < 1 ? 4 : 2) : listing ? "NO ANCHOR" : "—"}
        </span>
        <span className="cell-label">Anchor age</span>
        <span className="text-right text-txt-dim">{age !== null ? (age < 90 ? `${age}s` : `${Math.round(age / 60)}m`) : "—"}</span>
        <span className="cell-label">Deviation</span>
        <span className={`text-right ${devBps !== null ? (adverse! <= 30 ? "text-up" : adverse! <= 100 ? "text-amber-2" : "text-dn") : "text-txt-dim"}`}>
          {devBps !== null ? `${devBps >= 0 ? "+" : ""}${devBps.toFixed(1)} BPS` : "—"}
        </span>
        <span className="cell-label">Verdict</span>
        <span className={`text-right font-bold tracking-[0.14em] ${verdict ? verdictColor : "text-txt-dim"}`}>
          {verdict ?? (anchor === null && listing !== null ? "UNANCHORED" : "—")}
        </span>
      </div>
      <p className="text-[10px] text-txt-dim leading-snug px-2 pb-2">
        Anchor read live from PitOracleV2 (Chainlink push feed primary, Pyth fallback).
        Names without an oracle market show UNANCHORED — the pool price stands alone.
      </p>
    </section>
  );
}
