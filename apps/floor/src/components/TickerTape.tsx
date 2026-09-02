import type { Listing } from "../lib/data";
import { fmt } from "../lib/format";

/** Scrolling top tape — live pool prices, duplicated for a seamless loop. */
export function TickerTape({ listings }: { listings: Listing[] }) {
  const top = listings.slice(0, 24);
  if (top.length === 0) {
    return (
      <div className="h-7 border-b border-rule bg-screen flex items-center px-3">
        <span className="text-amber-dim text-[11px] tracking-[0.2em]">SCANNING VENUES<span className="blink">▮</span></span>
      </div>
    );
  }
  /* B-23: stable symbol-based keys (second pass suffixed — duplicated loop). */
  const cell = (l: Listing, dup = false) => (
    <span key={dup ? `${l.token.symbol}-dup` : l.token.symbol} className="inline-flex items-baseline gap-1.5 px-4 whitespace-nowrap">
      <span className="text-amber text-[11.5px] font-semibold">{l.token.symbol}</span>
      <span className="text-txt text-[11.5px]">{fmt.usd(l.price, l.price < 1 ? 4 : 2)}</span>
      <span className="text-txt-dim text-[10px]">{fmt.usdCompact(l.usdgDepth)}</span>
    </span>
  );
  return (
    <div className="h-7 border-b border-rule bg-screen overflow-hidden relative" aria-hidden="true">
      <div className="tape-track inline-flex items-center h-full will-change-transform">
        {top.map((l) => cell(l))}
        {top.map((l) => cell(l, true))}
      </div>
    </div>
  );
}
