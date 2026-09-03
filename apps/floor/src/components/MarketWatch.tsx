/* MARKET WATCH — every USDG-paired stock pool on the chain, live slot0
   prices, depth-ranked. Click a row to load it into the order ticket. */
import { useEffect, useRef, useState } from "react";
import type { Listing } from "../lib/data";
import { fmt } from "../lib/format";

export function MarketWatch({ listings, booted, selected, onSelect }: {
  listings: Listing[]; booted: boolean; selected: string; onSelect: (sym: string) => void;
}) {
  const prev = useRef<Map<string, number>>(new Map());
  const [flashes, setFlashes] = useState<Map<string, "up" | "dn">>(new Map());

  useEffect(() => {
    const next = new Map<string, "up" | "dn">();
    for (const l of listings) {
      const p = prev.current.get(l.token.symbol);
      if (p !== undefined && p !== l.price) next.set(l.token.symbol, l.price > p ? "up" : "dn");
      prev.current.set(l.token.symbol, l.price);
    }
    if (next.size) {
      setFlashes(next);
      const id = setTimeout(() => setFlashes(new Map()), 950);
      return () => clearTimeout(id);
    }
  }, [listings]);

  return (
    <section className="panel h-full flex flex-col min-h-0" aria-label="market watch">
      <div className="panel-title">
        <span>MARKET WATCH · TOKENIZED STOCKS</span>
        <span className="text-txt-dim normal-case tracking-normal">{listings.length} LISTED</span>
      </div>
      <div className="overflow-auto flex-1 min-h-0">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-panel">
            <tr className="text-left">
              {["SYM", "LAST", "DEPTH", "TIER"].map((h, i) => (
                <th key={h} className={`cell-label px-2 py-1 border-b border-rule font-medium ${i > 0 ? "text-right" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {listings.map((l) => {
              const flash = flashes.get(l.token.symbol);
              const sel = l.token.symbol === selected;
              return (
                <tr key={l.token.symbol}
                  className={`cursor-pointer hover:bg-panel-2 ${sel ? "bg-amber/10" : ""} ${flash === "up" ? "flash-up" : flash === "dn" ? "flash-dn" : ""}`}
                  onClick={() => onSelect(l.token.symbol)}
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(l.token.symbol); } }}
                  aria-current={sel ? "true" : undefined}>
                  <td className={`px-2 py-[3px] text-[11.5px] font-semibold ${sel ? "text-amber-2" : "text-amber"}`}>
                    {sel ? "▶" : ""}{l.token.symbol}
                  </td>
                  <td className="px-2 py-[3px] text-right text-[11.5px] text-txt whitespace-nowrap">
                    {fmt.usd(l.price, l.price < 1 ? 4 : 2)}
                  </td>
                  <td className="px-2 py-[3px] text-right text-[11px] text-txt-dim">{fmt.usdCompact(l.usdgDepth)}</td>
                  <td className="px-2 py-[3px] text-right text-[10.5px] text-txt-dim">{(l.fee / 10_000).toFixed(2)}%</td>
                </tr>
              );
            })}
            {!booted && (
              <tr><td colSpan={4} className="px-2 py-3 text-[11.5px] text-amber-dim">
                DISCOVERING POOLS ACROSS 95 TOKENS<span className="blink">▮</span>
              </td></tr>
            )}
            {booted && listings.length === 0 && (
              <tr><td colSpan={4} className="px-2 py-3 text-[11.5px] text-dn">RPC UNREACHABLE — RETRYING</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-txt-dim px-2 py-1.5 border-t border-rule">
        LAST = deepest USDG pool slot0 · DEPTH = USDG side of pool · poll 10s
      </p>
    </section>
  );
}
