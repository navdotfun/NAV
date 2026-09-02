/* CREDIT — markets board. One row per isolated pair: real asset logo,
   anchor price, supply/borrow APR, utilization, risk params, liquidity.
   Every figure is a direct chain read; failed reads render "—", never 0. */
import { formatUnits } from "viem";
import { fmt } from "../../lib/format";
import { rayToApr, type CreditMarket } from "../../lib/credit";

function pct(v: number | null, d = 2): string {
  return v === null ? "—" : v.toFixed(d) + "%";
}
function usdg(v: bigint | null): string {
  return v === null ? "—" : fmt.usdCompact(Number(formatUnits(v, 6)));
}

export function CreditMarketsBoard({ markets, selected, onSelect }: {
  markets: CreditMarket[] | null;
  selected: string | null;
  onSelect: (pair: string) => void;
}) {
  return (
    <section className="panel flex-1 min-h-0 flex flex-col">
      <div className="panel-title">
        <span>CREDIT MARKETS · ISOLATED USDG POOLS</span>
        <span className="text-txt-dim normal-case tracking-normal">collateral-backed · immutable · no admin</span>
      </div>
      <div className="overflow-x-auto overflow-y-auto flex-1 min-h-0">
        <table className="w-full text-[12.5px] whitespace-nowrap">
          <thead>
            <tr className="text-left cell-label border-b border-rule">
              <th className="px-2 py-1.5 font-normal">MARKET</th>
              <th className="px-2 py-1.5 font-normal text-right">ANCHOR</th>
              <th className="px-2 py-1.5 font-normal text-right">SUPPLY APR</th>
              <th className="px-2 py-1.5 font-normal text-right">BORROW APR</th>
              <th className="px-2 py-1.5 font-normal text-right">UTIL</th>
              <th className="px-2 py-1.5 font-normal text-right">SUPPLIED</th>
              <th className="px-2 py-1.5 font-normal text-right">AVAILABLE</th>
              <th className="px-2 py-1.5 font-normal text-right">MAX LTV</th>
              <th className="px-2 py-1.5 font-normal text-right">LIQ AT</th>
            </tr>
          </thead>
          <tbody>
            {markets === null && (
              <tr><td colSpan={9} className="px-3 py-6 text-txt-dim">reading markets from chain…</td></tr>
            )}
            {markets !== null && markets.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-txt-dim">no markets listed</td></tr>
            )}
            {(markets ?? []).map((m) => {
              const util = m.utilizationRay === null ? null : Number(m.utilizationRay / 10n ** 18n) / 1e9 * 100;
              const active = m.pair === selected;
              return (
                <tr
                  key={m.pair}
                  onClick={() => onSelect(m.pair)}
                  className={`cursor-pointer border-b border-rule/60 hover:bg-panel-2 ${active ? "bg-panel-2" : ""}`}
                  aria-selected={active}
                >
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      <img
                        src={`logos/${m.symbol}.png`} alt="" width={18} height={18}
                        className="rounded-full bg-black/40"
                        onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }}
                      />
                      <span className={active ? "text-amber-2" : "text-txt"}>{m.symbol}</span>
                      <span className="text-txt-dim text-[10.5px]">/ USDG</span>
                      {m.priceFresh === false && (
                        <span className="text-dn text-[10px] border border-dn/50 px-1">STALE</span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right text-txt">{m.price === null ? "—" : fmt.usd(m.price)}</td>
                  <td className="px-2 py-2 text-right text-up">{pct(rayToApr(m.supplyRateRay))}</td>
                  <td className="px-2 py-2 text-right text-amber-2">{pct(rayToApr(m.borrowRateRay))}</td>
                  <td className="px-2 py-2 text-right text-txt">{pct(util, 1)}</td>
                  <td className="px-2 py-2 text-right text-txt">{usdg(m.supplyAssets)}</td>
                  <td className="px-2 py-2 text-right text-txt">{usdg(m.cash)}</td>
                  <td className="px-2 py-2 text-right text-txt-dim">{(m.ltvBps / 100).toFixed(0)}%</td>
                  <td className="px-2 py-2 text-right text-txt-dim">{(m.liqThresholdBps / 100).toFixed(0)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-rule px-2 py-1 text-[10.5px] text-txt-dim flex flex-wrap gap-x-4">
        <span>rates accrue linearly per second · 30 bps origination on draws → NAV accumulator · 20% of interest reserved → NAV accumulator</span>
      </div>
    </section>
  );
}
