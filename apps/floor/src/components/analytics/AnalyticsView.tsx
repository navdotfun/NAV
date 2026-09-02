/* STATS — protocol analytics floor. Minimal text, heavy on live charts.
   Every series is rebuilt from chain logs / live contract reads via
   lib/analytics.ts — no indexer, no backend, nothing off-chain. */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Chart, LineController, LineElement, PointElement,
  BarController, BarElement, DoughnutController, ArcElement,
  LinearScale, CategoryScale, Filler, Tooltip,
} from "chart.js";
import { formatUnits } from "viem";
import {
  fetchOptionsDesks, fetchOptionsFlow, fetchPitFlow, fetchSwapStats,
  type DeskRow, type OptionsFlow, type PitFlow, type SwapStats,
} from "../../lib/analytics";
import { STOCK_TOKENS } from "../../lib/nav/data";
import { useVaultState, useNavMarket } from "../../lib/nav/protocol";
import { useVaultHistory } from "../../lib/nav/history";
import { getPriceEntry, usePriceFeed, useEthUsd } from "../../lib/nav/live";
import { heartbeatCoverage } from "../pit/PitWriter";
import { PIT_MARKETS } from "../../lib/nav/pit";
import { fmt } from "../../lib/format";

Chart.register(
  LineController, LineElement, PointElement,
  BarController, BarElement, DoughnutController, ArcElement,
  LinearScale, CategoryScale, Filler, Tooltip,
);

const MONO = "'IBM Plex Mono', monospace";
const TICKS = { color: "#9a968a", font: { family: MONO, size: 9 } } as const;
const TOOLTIP = {
  backgroundColor: "#12110d", borderColor: "#3d3a2e", borderWidth: 1,
  titleColor: "#ad7522", bodyColor: "#e8e4d8",
  titleFont: { family: MONO, size: 10 }, bodyFont: { family: MONO, size: 11 },
} as const;

/* B-17: poll results are new object identities every 60s even when the data
   is unchanged — which re-memoized every chart config and destroy/recreated
   every canvas (visible flash). Keep the previous state object when the fresh
   read is deep-equal so charts only rebuild on REAL data changes. */
function keepStable<T>(prev: T | null, next: T): T {
  if (prev === null || next === null) return next;
  const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
  try { return ser(prev) === ser(next) ? prev : next; } catch { return next; }
}

/** One canvas, one Chart instance, config rebuilt when `config` changes. */
function TermChart({ config, label }: { config: (c: HTMLCanvasElement) => Chart; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const chart = config(c);
    return () => chart.destroy();
  }, [config]);
  return <canvas ref={ref} aria-label={label} role="img" />;
}

function Panel({ title, right, h, children }: { title: string; right?: string; h?: number; children: React.ReactNode }) {
  return (
    <section className="panel flex flex-col min-h-0">
      <div className="panel-title">
        <span>{title}</span>
        {right ? <span className="text-txt-dim normal-case tracking-normal">{right}</span> : null}
      </div>
      <div className="p-2" style={h ? { height: h } : undefined}>{children}</div>
    </section>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "dn" | "amber" }) {
  const toneCls = tone === "up" ? "text-up" : tone === "dn" ? "text-dn" : tone === "amber" ? "text-amber-2" : "text-txt";
  return (
    <div className="panel px-2.5 py-2">
      <div className="cell-label">{label}</div>
      <div className={`text-[15px] tabular-nums ${toneCls}`}>{value}</div>
      {sub ? <div className="text-[10px] text-txt-dim tabular-nums">{sub}</div> : null}
    </div>
  );
}

/* legend chip for doughnuts — HTML, not chart.js legend (keeps text small) */
function Chip({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-txt-dim mr-2">
      <span className="inline-block w-2 h-2" style={{ background: color }} />{label}
    </span>
  );
}

export function AnalyticsView() {
  const vault = useVaultState();
  const navMkt = useNavMarket();
  const ethUsd = useEthUsd();
  const history = useVaultHistory();

  const [swap, setSwap] = useState<SwapStats | null>(null);
  const [flow, setFlow] = useState<OptionsFlow | null>(null);
  const [desks, setDesks] = useState<DeskRow[] | null>(null);
  const [pit, setPit] = useState<PitFlow | null>(null);
  const [coverage, setCoverage] = useState<{ armed: number; stale: number; cold: number; total: number } | null>(null);

  /* pollers — logs every 60s, desks every 30s */
  useEffect(() => {
    let stop = false;
    const logsPull = async () => {
      const [s, f, p, c] = await Promise.allSettled([
        fetchSwapStats(), fetchOptionsFlow(), fetchPitFlow(),
        heartbeatCoverage(Object.values(PIT_MARKETS).map((m) => m.underlying)),
      ]);
      if (stop) return;
      if (s.status === "fulfilled" && s.value) setSwap((prev) => keepStable(prev, s.value));
      if (f.status === "fulfilled" && f.value) setFlow((prev) => keepStable(prev, f.value));
      if (p.status === "fulfilled") setPit((prev) => keepStable(prev, p.value));
      if (c.status === "fulfilled") setCoverage((prev) => keepStable(prev, c.value));
    };
    const deskPull = async () => {
      try { const d = await fetchOptionsDesks(); if (!stop) setDesks((prev) => keepStable(prev, d)); } catch { /* next tick */ }
    };
    void logsPull(); void deskPull();
    const t1 = setInterval(logsPull, 60_000);
    const t2 = setInterval(deskPull, 30_000);
    return () => { stop = true; clearInterval(t1); clearInterval(t2); };
  }, []);

  /* vault pricing (same live path as the VAULT desk) */
  const tokenByAddr = useMemo(() => new Map(STOCK_TOKENS.map((t) => [t.address.toLowerCase(), t])), []);
  const feedTokens = useMemo(() => {
    const map = new Map<string, (typeof STOCK_TOKENS)[number]>();
    for (const h of vault.holdings ?? []) {
      if (h.balance === null || h.balance <= 0n) continue;
      const t = tokenByAddr.get(h.address.toLowerCase());
      if (t) map.set(t.address.toLowerCase(), t);
    }
    for (const f of history.fills) {
      const t = tokenByAddr.get(f.token.toLowerCase());
      if (t) map.set(t.address.toLowerCase(), t);
    }
    return [...map.values()];
  }, [vault.holdings, history.fills, tokenByAddr]);
  const priceTick = usePriceFeed(feedTokens);

  /* B-12: partial TVL with explicit "PRICING n/m" coverage — one unpriced or
     unread token no longer blanks the whole KPI. Unknown balances count as
     unpriced; only a FULL-coverage figure feeds derived stats (floor, chart). */
  const aum = useMemo(() => {
    if (vault.status !== "live" || vault.holdings === null) return null;
    let usd = 0;
    let priced = 0;
    let total = 0;
    for (const h of vault.holdings) {
      if (h.balance === null) { total += 1; continue; }
      if (h.balance <= 0n) continue;
      const t = tokenByAddr.get(h.address.toLowerCase());
      if (!t) continue;
      total += 1;
      const p = getPriceEntry(t.address);
      if (p?.status === "ok" && p.price !== undefined) {
        usd += (Number(h.balance) / 10 ** t.decimals) * p.price;
        priced += 1;
      }
    }
    return { usd, priced, total };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.status, vault.holdings, tokenByAddr, priceTick]);
  const vaultValue = aum !== null && aum.total > 0 && aum.priced === aum.total ? aum.usd
    : aum !== null && aum.total === 0 ? 0
    : null;

  const growth = useMemo(() => {
    if (history.status !== "ok" || history.fills.length === 0) return null;
    const cum = new Map<string, bigint>();
    const labels: string[] = [];
    const data: number[] = [];
    for (const f of history.fills) {
      const key = f.token.toLowerCase();
      cum.set(key, (cum.get(key) ?? 0n) + (f.direction === "in" ? f.amount : -f.amount));
      let usd = 0;
      for (const [addr, bal] of cum) {
        if (bal <= 0n) continue;
        const m = tokenByAddr.get(addr);
        const e = m ? getPriceEntry(m.address) : null;
        if (!m || !e) continue;
        if (e.status === "ok" && e.price !== undefined) usd += (Number(bal) / 10 ** m.decimals) * e.price;
      }
      const d = new Date(f.time * 1000);
      labels.push(`${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
      data.push(usd);
    }
    if (vaultValue !== null) { labels.push("NOW"); data.push(vaultValue); }
    return { labels, data };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, tokenByAddr, priceTick, vaultValue]);

  const supplyF = vault.totalSupply !== null ? Number(formatUnits(vault.totalSupply, 18)) : null;
  const ethUsdPrice = ethUsd?.status === "ok" && ethUsd.price !== undefined ? ethUsd.price : null;
  const navUsd = navMkt.priceEth !== null && ethUsdPrice !== null ? navMkt.priceEth * ethUsdPrice : null;
  const navPerToken = vaultValue !== null && supplyF !== null && supplyF > 0 ? vaultValue / supplyF : null;
  /* total OI is only known when EVERY desk read succeeded — else "—" (A-03). */
  const totalOi = desks && desks.length > 0 && desks.every((d) => d.oiUsdg !== null)
    ? desks.reduce((a, d) => a + (d.oiUsdg as number), 0)
    : null;

  /* ---- chart configs (memoized so canvases only rebuild on data change) ---- */

  const swapConfig = useMemo(() => {
    if (!swap || swap.buckets.length === 0) return null;
    return (c: HTMLCanvasElement) => new Chart(c, {
      data: {
        labels: swap.buckets.map((b) => b.label),
        datasets: [
          { type: "bar" as const, data: swap.buckets.map((b) => b.volume), backgroundColor: "rgba(251,139,30,0.75)", borderColor: "#fb8b1e", borderWidth: 1, yAxisID: "y" },
          { type: "line" as const, data: swap.buckets.map((b) => b.cumFees), borderColor: "#37d0e6", borderWidth: 1.5, pointRadius: 0, tension: 0, yAxisID: "y1" },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: { tooltip: { ...TOOLTIP, callbacks: { label: (x) => (x.datasetIndex === 0 ? " VOL " : " CUM FEES ") + fmt.usd(x.parsed.y ?? 0, 2) } } },
        scales: {
          x: { grid: { display: false }, ticks: { ...TICKS, maxTicksLimit: 6 } },
          y: { grid: { color: "rgba(43,41,33,0.7)" }, ticks: { ...TICKS, callback: (v) => fmt.usdCompact(Number(v)) } },
          y1: { position: "right", grid: { display: false }, ticks: { ...TICKS, color: "#37d0e6", callback: (v) => fmt.usdCompact(Number(v)) } },
        },
      },
    });
  }, [swap]);

  const venueConfig = useMemo(() => {
    if (!swap || swap.venues.length === 0) return null;
    const colors = ["#fb8b1e", "#37d0e6", "#ad7522", "#944454"];
    return (c: HTMLCanvasElement) => new Chart(c, {
      type: "doughnut",
      data: {
        labels: swap.venues.map((v) => v.name),
        datasets: [{ data: swap.venues.map((v) => v.legs), backgroundColor: colors.slice(0, swap.venues.length), borderColor: "#0a0a08", borderWidth: 2 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "62%",
        plugins: { tooltip: { ...TOOLTIP, callbacks: { label: (x) => ` ${x.label}: ${x.parsed} LEGS` } } },
      },
    });
  }, [swap]);

  const pairsConfig = useMemo(() => {
    if (!swap || swap.pairs.length === 0) return null;
    return (c: HTMLCanvasElement) => new Chart(c, {
      type: "bar",
      data: {
        labels: swap.pairs.map((p) => p.pair),
        datasets: [{ data: swap.pairs.map((p) => p.volume), backgroundColor: "rgba(255,176,30,0.7)", borderColor: "#ffb01e", borderWidth: 1 }],
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { tooltip: { ...TOOLTIP, callbacks: { label: (x) => " VOL " + fmt.usd(x.parsed.x ?? 0, 2) } } },
        scales: {
          x: { grid: { color: "rgba(43,41,33,0.7)" }, ticks: { ...TICKS, callback: (v) => fmt.usdCompact(Number(v)) } },
          y: { grid: { display: false }, ticks: TICKS },
        },
      },
    });
  }, [swap]);

  const growthConfig = useMemo(() => {
    if (!growth) return null;
    return (c: HTMLCanvasElement) => new Chart(c, {
      type: "line",
      data: {
        labels: growth.labels,
        datasets: [{ data: growth.data, borderColor: "#ffb01e", borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: "rgba(251,139,30,0.07)", tension: 0, stepped: true }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: { tooltip: { ...TOOLTIP, callbacks: { label: (x) => " VAULT " + fmt.usd(x.parsed.y ?? 0, 2) } } },
        scales: {
          x: { grid: { display: false }, ticks: { ...TICKS, maxTicksLimit: 6 } },
          y: { grid: { color: "rgba(43,41,33,0.7)" }, ticks: { ...TICKS, callback: (v) => fmt.usdCompact(Number(v)) } },
        },
      },
    });
  }, [growth]);

  const desksConfig = useMemo(() => {
    if (!desks || desks.length === 0) return null;
    return (c: HTMLCanvasElement) => new Chart(c, {
      type: "bar",
      data: {
        labels: desks.map((d) => d.symbol),
        datasets: [
          { label: "CALL ESCROW", data: desks.map((d) => d.callEscrow), backgroundColor: "#00d964", stack: "call" },
          { label: "CALL FREE", data: desks.map((d) => d.callFree), backgroundColor: "rgba(0,217,100,0.3)", stack: "call" },
          { label: "PUT ESCROW", data: desks.map((d) => d.putEscrow), backgroundColor: "#ff3b30", stack: "put" },
          { label: "PUT FREE", data: desks.map((d) => d.putFree), backgroundColor: "rgba(255,59,48,0.3)", stack: "put" },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { tooltip: { ...TOOLTIP, callbacks: { label: (x) => ` ${x.dataset.label} ${fmt.usd(x.parsed.y ?? 0, 2)}` } } },
        scales: {
          x: { grid: { display: false }, ticks: TICKS, stacked: true },
          y: { grid: { color: "rgba(43,41,33,0.7)" }, ticks: { ...TICKS, callback: (v) => fmt.usdCompact(Number(v)) }, stacked: true },
        },
      },
    });
  }, [desks]);

  const pitConfig = useMemo(() => {
    if (!pit || pit.cumulative.length === 0) return null;
    return (c: HTMLCanvasElement) => new Chart(c, {
      type: "line",
      data: {
        labels: pit.cumulative.map((p) => p.label),
        datasets: [{ data: pit.cumulative.map((p) => p.count), borderColor: "#37d0e6", borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: "rgba(55,208,230,0.06)", tension: 0, stepped: true }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: { tooltip: { ...TOOLTIP, callbacks: { label: (x) => ` ${x.parsed.y} TICKETS` } } },
        scales: {
          x: { grid: { display: false }, ticks: { ...TICKS, maxTicksLimit: 6 } },
          y: { grid: { color: "rgba(43,41,33,0.7)" }, ticks: { ...TICKS, precision: 0 } },
        },
      },
    });
  }, [pit]);

  const coverageConfig = useMemo(() => {
    if (!coverage) return null;
    return (c: HTMLCanvasElement) => new Chart(c, {
      type: "doughnut",
      data: {
        labels: ["ARMED", "STALE", "COLD"],
        datasets: [{ data: [coverage.armed, coverage.stale, coverage.cold], backgroundColor: ["#00d964", "#ffb01e", "#ff3b30"], borderColor: "#0a0a08", borderWidth: 2 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "62%",
        plugins: { tooltip: { ...TOOLTIP, callbacks: { label: (x) => ` ${x.label}: ${x.parsed}/${coverage.total}` } } },
      },
    });
  }, [coverage]);

  const callPutConfig = useMemo(() => {
    if (!flow) return null;
    return (c: HTMLCanvasElement) => new Chart(c, {
      type: "bar",
      data: {
        labels: ["CALLS", "PUTS"],
        datasets: [{ data: [flow.callsOpened, flow.putsOpened], backgroundColor: ["#00d964", "#ff3b30"], borderWidth: 0 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { tooltip: { ...TOOLTIP, callbacks: { label: (x) => ` ${x.parsed.y} OPENED` } } },
        scales: {
          x: { grid: { display: false }, ticks: TICKS },
          y: { grid: { color: "rgba(43,41,33,0.7)" }, ticks: { ...TICKS, precision: 0 } },
        },
      },
    });
  }, [flow]);

  const wait = <span className="text-txt-dim text-[11px]">READING CHAIN…</span>;
  const empty = <span className="text-txt-dim text-[11px]">NO PRINTS YET</span>;

  return (
    <main className="flex-1 min-h-0 overflow-y-auto p-[2px] flex flex-col gap-[2px]" aria-label="protocol analytics">
      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-[2px]">
        <Kpi label="SWAP VOLUME · LIFE" value={swap ? fmt.usd(swap.volumeUsdg, 2) : "…"} sub={swap ? `${swap.fills} FILLS · ${swap.traders} TRADERS` : undefined} tone="amber" />
        <Kpi label="SWAP FEES · USDG" value={swap ? fmt.usd(swap.feesUsdg, 4) : "…"} sub="20 BPS OF NOTIONAL" />
        <Kpi label="NAV MARKET PX" value={navUsd !== null ? fmt.usdTiny(navUsd) : "…"} sub={navPerToken !== null ? `FLOOR ${fmt.usdTiny(navPerToken)}` : undefined} tone="amber" />
        <Kpi label="VAULT TVL"
          value={aum === null ? "…" : aum.total === 0 ? fmt.usd(0, 2) : aum.priced === 0 ? "…" : fmt.usd(aum.usd, 2)}
          sub={aum !== null && aum.total > 0 && aum.priced < aum.total ? `PRICING ${aum.priced}/${aum.total}` : supplyF !== null ? `${fmt.compact(supplyF)} $NAV OUT` : undefined} />
        <Kpi label="OPTIONS OI" value={totalOi !== null ? fmt.usd(totalOi, 2) : "…"} sub={flow ? `${flow.open} OPEN / ${flow.settled} SETTLED` : undefined} tone="up" />
        <Kpi label="OPT PREMIUM · LIFE" value={flow ? fmt.usd(flow.premiumUsdg, 2) : "…"} sub={flow ? `${flow.buyers} BUYERS` : undefined} />
        <Kpi label="PIT TICKETS" value={pit ? String(pit.minted) : "…"} sub={pit ? `${pit.open} OPEN · ${pit.holders} HOLDERS` : undefined} tone="up" />
        <Kpi label="ORACLE COVERAGE" value={coverage ? `${coverage.armed}/${coverage.total}` : "…"} sub="ARMED FEEDS" tone={coverage && coverage.cold > 0 ? "dn" : "up"} />
      </div>

      {/* row: swap flow / venue split / top pairs */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-[2px]">
        <div className="lg:col-span-6"><Panel title="SWAP FLOW · HOURLY" right="BARS VOL · LINE CUM FEES" h={220}>{swapConfig ? <TermChart config={swapConfig} label="Hourly swap volume with cumulative fees" /> : swap ? empty : wait}</Panel></div>
        <div className="lg:col-span-3">
          <Panel title="VENUE SPLIT" right="ROUTED LEGS" h={220}>
            {venueConfig ? <TermChart config={venueConfig} label="Venue split of routed legs" /> : swap ? empty : wait}
          </Panel>
        </div>
        <div className="lg:col-span-3"><Panel title="TOP PAIRS" right="USDG VOL" h={220}>{pairsConfig ? <TermChart config={pairsConfig} label="Top pairs by volume" /> : swap ? empty : wait}</Panel></div>
      </div>

      {/* row: vault growth / options desks */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-[2px]">
        <div className="lg:col-span-6"><Panel title="NAV VAULT · GROWTH" right="FEE-FUNDED ACCUMULATION" h={230}>{growthConfig ? <TermChart config={growthConfig} label="Vault value over time" /> : history.status === "ok" && history.fills.length === 0 ? empty : wait}</Panel></div>
        <div className="lg:col-span-6">
          <Panel title="OPTIONS DESKS · CAPITAL" right="ESCROWED VS FREE · USD" h={230}>
            {desksConfig ? (
              <div className="h-full flex flex-col">
                <div className="mb-1"><Chip color="#00d964" label="CALL ESCROW" /><Chip color="rgba(0,217,100,0.3)" label="CALL FREE" /><Chip color="#ff3b30" label="PUT ESCROW" /><Chip color="rgba(255,59,48,0.3)" label="PUT FREE" /></div>
                <div className="flex-1 min-h-0"><TermChart config={desksConfig} label="Options desk capital by market" /></div>
              </div>
            ) : wait}
          </Panel>
        </div>
      </div>

      {/* row: pit tickets / coverage / call-put */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-[2px]">
        <div className="lg:col-span-6"><Panel title="PIT TICKETS · CUMULATIVE" right="ERC-721 MINTS" h={210}>{pitConfig ? <TermChart config={pitConfig} label="Cumulative pit tickets minted" /> : pit ? empty : wait}</Panel></div>
        <div className="lg:col-span-3">
          <Panel title="PIT ORACLE HEALTH" right={`${coverage?.total ?? Object.keys(PIT_MARKETS).length} MARKETS`} h={210}>
            {coverageConfig ? (
              <div className="h-full flex flex-col">
                <div className="mb-1"><Chip color="#00d964" label="ARMED" /><Chip color="#ffb01e" label="STALE" /><Chip color="#ff3b30" label="COLD" /></div>
                <div className="flex-1 min-h-0"><TermChart config={coverageConfig} label="Pit oracle heartbeat coverage" /></div>
              </div>
            ) : wait}
          </Panel>
        </div>
        <div className="lg:col-span-3"><Panel title="OPTIONS FLOW" right="CALLS VS PUTS" h={210}>{callPutConfig ? <TermChart config={callPutConfig} label="Calls versus puts opened" /> : flow ? empty : wait}</Panel></div>
      </div>

    </main>
  );
}
