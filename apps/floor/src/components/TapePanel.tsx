/* TAPE — times & sales. Real Swap events from the deepest stock/USDG pools. */
import type { TapePrint } from "../lib/data";
import { EXPLORER } from "../lib/chain";
import { fmt } from "../lib/format";

function ago(ts: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function TapePanel({ prints }: { prints: TapePrint[] }) {
  return (
    <section className="panel mx-[2px] mb-[2px]" aria-label="times and sales">
      <div className="panel-title">
        <span>TAPE · TIMES &amp; SALES</span>
        <span className="text-txt-dim normal-case tracking-normal">ON-CHAIN PRINTS · TOP POOLS</span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex gap-0 min-w-max px-1 py-1.5">
          {prints.length === 0 && (
            <span className="text-[11px] text-amber-dim px-2 py-1">READING SWAP LOGS<span className="blink">▮</span></span>
          )}
          {prints.slice(0, 40).map((p) => (
            <a key={p.id} href={`${EXPLORER}/tx/${p.txHash}`} target="_blank" rel="noopener noreferrer"
              className="flex flex-col px-2.5 py-0.5 border-r border-rule last:border-r-0 hover:bg-panel-2 no-underline"
              title={`${p.side} ${fmt.num(p.qty, 4)} ${p.symbol} @ ${fmt.usd(p.price, 2)} — view tx`}>
              <span className="text-[10px] text-txt-dim">{ago(p.ts)}</span>
              <span className={`text-[11.5px] font-semibold ${p.side === "BUY" ? "text-up" : "text-dn"}`}>
                {p.symbol} {p.side === "BUY" ? "▲" : "▼"}
              </span>
              <span className="text-[10.5px] text-txt">{fmt.usdCompact(p.notional)}</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
