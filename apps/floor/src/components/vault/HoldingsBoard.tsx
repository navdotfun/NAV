/* VAULT — holdings board, growth chart and acquisition ledger.
   Holdings are live vault balances valued at live Uniswap pool prices;
   the chart replays Transfer-log fills chronologically (lib/nav/history). */
import { useEffect, useRef } from "react";
import {
  Chart, LineController, LineElement, PointElement,
  LinearScale, CategoryScale, Filler, Tooltip,
} from "chart.js";
import { formatUnits } from "viem";
import type { StockToken } from "../../lib/nav/data";
import type { VaultState } from "../../lib/nav/protocol";
import { getPriceEntry } from "../../lib/nav/live";
import { EXPLORER } from "../../lib/chain";
import { fmt } from "../../lib/format";

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);

export interface LedgerRow {
  key: string;
  symbol: string;
  qty: number;
  usd: number | null;
  direction: "in" | "out";
  when: string;
  tx: string;
}

interface Series { labels: string[]; data: number[] }

function GrowthChart({ series }: { series: Series }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  /* B-17: update the existing chart in place on series changes — full
     destroy/recreate on every 60s price tick flashed the canvas blank and
     re-ran layout for no reason. Create once, mutate data, chart.update(). */
  useEffect(() => {
    const chart = chartRef.current;
    if (chart) {
      chart.data.labels = series.labels;
      chart.data.datasets[0].data = series.data;
      chart.update("none");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    chartRef.current = new Chart(canvas, {
      type: "line",
      data: {
        labels: series.labels,
        datasets: [{
          data: series.data,
          borderColor: "#ffb01e",
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          backgroundColor: "rgba(251,139,30,0.07)",
          tension: 0,
          stepped: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: {
          tooltip: {
            backgroundColor: "#12110d",
            borderColor: "#3d3a2e",
            borderWidth: 1,
            titleColor: "#ad7522",
            bodyColor: "#e8e4d8",
            titleFont: { family: "'IBM Plex Mono', monospace", size: 10 },
            bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
            callbacks: { label: (c) => " VAULT " + fmt.usd(c.parsed.y ?? 0, 2) },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: "#9a968a", maxTicksLimit: 6, font: { family: "'IBM Plex Mono', monospace", size: 9 } },
          },
          y: {
            grid: { color: "rgba(43,41,33,0.7)" },
            ticks: {
              color: "#9a968a",
              font: { family: "'IBM Plex Mono', monospace", size: 9 },
              callback: (v) => fmt.usdCompact(Number(v)),
            },
          },
        },
      },
    });
  }, [series]);
  useEffect(() => () => { chartRef.current?.destroy(); chartRef.current = null; }, []);
  return <canvas ref={canvasRef} aria-label="Vault value over time, one step per accumulation epoch" role="img" />;
}

export function HoldingsBoard({ vault, tokenByAddr, aum, series, ledger, historyStatus }: {
  vault: VaultState;
  tokenByAddr: Map<string, StockToken>;
  /** Priced AUM subtotal with coverage — usd is partial until priced === total. */
  aum: { usd: number; priced: number; total: number } | null;
  series: Series | null;
  ledger: LedgerRow[] | null;
  historyStatus: string;
}) {
  /* balance === null ⇔ the balanceOf read failed — unknown, never zero. */
  const unreadCount = (vault.holdings ?? []).filter((h) => h.balance === null).length;
  const holdings = (vault.holdings ?? [])
    .filter((h): h is { address: typeof h.address; balance: bigint } => h.balance !== null && h.balance > 0n)
    .map((h) => {
      const t = tokenByAddr.get(h.address.toLowerCase());
      if (!t) return null;
      const qty = Number(formatUnits(h.balance, t.decimals));
      const p = getPriceEntry(t.address);
      const px = p?.status === "ok" && p.price !== undefined ? p.price : null;
      return { t, qty, px, usd: px !== null ? qty * px : null };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));

  const inactiveSet = new Set((vault.inactiveAssets ?? []).map((a) => a.toLowerCase()));

  return (
    <>
      {/* holdings */}
      <section className="panel" aria-label="vault holdings">
        <div className="panel-title">
          <span>VAULT HOLDINGS · LIVE</span>
          <span className="text-txt-dim normal-case tracking-normal">
            {vault.holdings === null ? "READING CHAIN…" : `${holdings.length} HELD / ${vault.holdings.length} REGISTERED${unreadCount > 0 ? ` · ${unreadCount} UNREAD` : ""}`}
          </span>
        </div>
        {vault.holdings === null ? (
          <div className="px-2.5 py-2 text-[11px] text-txt-dim">{vault.status === "error" ? "RPC ERROR — RETRYING" : "READING CHAIN…"}</div>
        ) : holdings.length === 0 ? (
          <div className="px-2.5 py-2 text-[11px] text-txt-dim">
            VAULT UNSEEDED — HOLDINGS ACCRUE FROM FEE FLOW EVERY CRANK EPOCH.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-amber-dim">
                  <th className="font-normal px-2.5 py-1 tracking-wider">ASSET</th>
                  <th className="font-normal px-2 py-1 tracking-wider text-right">QTY</th>
                  <th className="font-normal px-2 py-1 tracking-wider text-right">PRICE</th>
                  <th className="font-normal px-2 py-1 tracking-wider text-right">VALUE</th>
                  <th className="font-normal px-2.5 py-1 tracking-wider text-right">WEIGHT</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((r) => (
                  <tr key={r.t.address} className="border-t border-rule hover:bg-panel-2">
                    <td className="px-2.5 py-1 whitespace-nowrap">
                      <a className="text-txt hover:text-amber-2" href={`${EXPLORER}/token/${r.t.address}`} target="_blank" rel="noopener noreferrer">
                        {r.t.symbol}
                      </a>
                      {inactiveSet.has(r.t.address.toLowerCase()) && <span className="text-dn"> · INACTIVE</span>}
                    </td>
                    <td className="px-2 py-1 text-right text-txt tabular-nums">{r.qty.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                    <td className="px-2 py-1 text-right text-txt tabular-nums">{r.px !== null ? fmt.usd(r.px, 2) : "…"}</td>
                    <td className="px-2 py-1 text-right text-amber-2 tabular-nums">{r.usd !== null ? fmt.usd(r.usd, 2) : "…"}</td>
                    <td className="px-2.5 py-1 text-right text-txt-dim tabular-nums">
                      {r.usd !== null && aum !== null && aum.priced === aum.total && aum.usd > 0 ? `${((r.usd / aum.usd) * 100).toFixed(1)}%` : "…"}
                    </td>
                  </tr>
                ))}
                {aum !== null && aum.priced > 0 && (
                  <tr className="border-t border-rule-2">
                    <td className="px-2.5 py-1 text-amber-dim">TOTAL AUM</td>
                    <td colSpan={3} className="px-2 py-1 text-right text-amber-2 tabular-nums">
                      {fmt.usd(aum.usd, 2)}{aum.priced < aum.total ? ` · PRICING ${aum.priced}/${aum.total}` : ""}
                    </td>
                    <td className="px-2.5 py-1 text-right text-txt-dim tabular-nums">{aum.priced === aum.total ? "100%" : "…"}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* growth chart */}
      <section className="panel" aria-label="vault growth">
        <div className="panel-title">
          <span>VAULT VALUE · PER FILL</span>
          <span className="text-txt-dim normal-case tracking-normal">TRANSFER-LOG REPLAY · LIVE PRICES</span>
        </div>
        {series ? (
          <div className="px-1.5 py-1.5 h-[160px]">
            <GrowthChart series={series} />
          </div>
        ) : (
          <div className="px-2.5 py-2 text-[11px] text-txt-dim">
            {historyStatus === "loading" ? "REPLAYING TRANSFER LOGS…"
              : historyStatus === "error" ? "LOG READ FAILED — RETRYING"
              : "NOTHING DRAWN UNTIL THE CHAIN HAS PRINTED IT — SERIES STARTS AT THE FIRST FILL."}
          </div>
        )}
      </section>

      {/* acquisition ledger */}
      <section className="panel" aria-label="acquisition ledger">
        <div className="panel-title">
          <span>ACQUISITION LEDGER</span>
          <span className="text-txt-dim normal-case tracking-normal">RAW CHAIN LOGS</span>
        </div>
        {ledger === null ? (
          <div className="px-2.5 py-2 text-[11px] text-txt-dim">
            {historyStatus === "loading" ? "READING TRANSFER LOGS…" : "NO FILLS PRINTED YET."}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[220px] overflow-y-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-amber-dim">
                  <th className="font-normal px-2.5 py-1 tracking-wider">UTC</th>
                  <th className="font-normal px-2 py-1 tracking-wider">SIDE</th>
                  <th className="font-normal px-2 py-1 tracking-wider">ASSET</th>
                  <th className="font-normal px-2 py-1 tracking-wider text-right">QTY</th>
                  <th className="font-normal px-2.5 py-1 tracking-wider text-right">≈USD (LIVE)</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((r) => (
                  <tr key={r.key} className="border-t border-rule hover:bg-panel-2">
                    <td className="px-2.5 py-1 whitespace-nowrap">
                      <a className="text-cyan hover:underline tabular-nums" href={`${EXPLORER}/tx/${r.tx}`} target="_blank" rel="noopener noreferrer">{r.when}</a>
                    </td>
                    <td className={`px-2 py-1 ${r.direction === "in" ? "text-up" : "text-dn"}`}>{r.direction === "in" ? "IN" : "OUT"}</td>
                    <td className="px-2 py-1 text-txt">{r.symbol}</td>
                    <td className="px-2 py-1 text-right text-txt tabular-nums">{r.qty.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                    <td className="px-2.5 py-1 text-right text-txt tabular-nums">{r.usd !== null ? fmt.usd(r.usd, 2) : "…"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
