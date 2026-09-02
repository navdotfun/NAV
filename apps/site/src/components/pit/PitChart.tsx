/* The Pit — live price chart. Custom SVG, pixel-crisp stepped line in the
   NavChart style. Series = in-session slot0 samples only; overlays = strike,
   breakeven, current price. No external chart libs, no fabricated points. */
import type { PricePoint } from "../../lib/pitLive";
import type { PitSide } from "../../lib/pitPricer";
import { fmt } from "../../lib/format";
import { spreadLabels, useWidth } from "./useWidth";

const H = 248;
const PAD_L = 8;
const PAD_R = 86; // room for right-edge labels
const PAD_T = 14;
const PAD_B = 20;

const INK3 = "#1b3049";
const CRT = "#4ae58a";
const GOLD = "#c9a227";
const PAPER = "#f5f1e8";
const MUTED = "#8fa3b8";
const RED = "#e5484d";

function px(v: number): number {
  return Math.round(v) + 0.5;
}

export function PitChart({
  series,
  strike,
  breakevenPrice,
  side,
  symbol,
}: {
  series: PricePoint[];
  strike: number | null;
  breakevenPrice: number | null;
  side: PitSide;
  symbol: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();

  if (series.length === 0) {
    return (
      <div ref={ref} className="pit-chart-empty" role="img" aria-label="Awaiting first live price read">
        <span className="px-label text-muted-dark">AWAITING FIRST ON-CHAIN PRICE READ</span>
        <span className="text-[13px] text-muted-dark">
          The series plots slot0 reads from the {symbol}/USD pool as they arrive. Nothing is drawn before the first read.
        </span>
      </div>
    );
  }

  const w = Math.max(width, 280);
  const last = series[series.length - 1].price;

  /* y domain: samples ∪ overlays, padded */
  const vals = series.map((p) => p.price);
  if (strike !== null) vals.push(strike);
  if (breakevenPrice !== null) vals.push(breakevenPrice);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.12, hi * 0.004, 1e-9);
  lo -= pad;
  hi += pad;

  const x0 = PAD_L;
  const x1 = w - PAD_R;
  const y = (v: number) => PAD_T + ((hi - v) / (hi - lo)) * (H - PAD_T - PAD_B);

  /* x: sample index → pixels (fixed spacing keeps the line readable early on) */
  const n = series.length;
  const x = (i: number) => (n === 1 ? x1 : x0 + (i / (n - 1)) * (x1 - x0));

  /* stepped path */
  let d = "";
  series.forEach((p, i) => {
    const X = px(x(i));
    const Y = px(y(p.price));
    if (i === 0) d = `M ${X} ${Y}`;
    else d += ` H ${X} V ${Y}`;
  });

  /* horizontal gridlines: 4 even ticks */
  const grid = [0.25, 0.5, 0.75].map((f) => lo + (hi - lo) * f);

  /* right-edge labels, collision-spread */
  const marks: { v: number; label: string; color: string }[] = [{ v: last, label: `P ${fmt.usd(last)}`, color: CRT }];
  if (strike !== null) marks.push({ v: strike, label: `K ${fmt.usd(strike)}`, color: GOLD });
  if (breakevenPrice !== null) marks.push({ v: breakevenPrice, label: `BE ${fmt.usd(breakevenPrice)}`, color: side === "PUT" ? RED : PAPER });
  const labelYs = spreadLabels(marks.map((m) => y(m.v)), 16, PAD_T + 4, H - PAD_B - 2);

  const t0 = new Date(series[0].t);
  const t1 = new Date(series[n - 1].t);
  const tf = (dt: Date) =>
    `${String(dt.getUTCHours()).padStart(2, "0")}:${String(dt.getUTCMinutes()).padStart(2, "0")}:${String(dt.getUTCSeconds()).padStart(2, "0")}`;

  return (
    <div ref={ref} className="min-w-0">
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={`${symbol} live price with strike and breakeven overlays`}>
        {grid.map((g, i) => (
          <line key={i} x1={x0} x2={x1} y1={px(y(g))} y2={px(y(g))} stroke={INK3} strokeOpacity={0.6} strokeWidth={1} shapeRendering="crispEdges" />
        ))}

        {/* strike + breakeven overlays */}
        {strike !== null && (
          <line x1={x0} x2={x1} y1={px(y(strike))} y2={px(y(strike))} stroke={GOLD} strokeWidth={1} strokeDasharray="6 4" shapeRendering="crispEdges" />
        )}
        {breakevenPrice !== null && (
          <line x1={x0} x2={x1} y1={px(y(breakevenPrice))} y2={px(y(breakevenPrice))} stroke={side === "PUT" ? RED : PAPER} strokeOpacity={0.75} strokeWidth={1} strokeDasharray="2 4" shapeRendering="crispEdges" />
        )}

        {/* sampled series (single read renders as a dotted level line until the next print) */}
        {n === 1 ? (
          <line x1={x0} x2={x1} y1={px(y(last))} y2={px(y(last))} stroke={CRT} strokeWidth={2} strokeDasharray="2 6" shapeRendering="crispEdges" />
        ) : (
          <path d={d} fill="none" stroke={CRT} strokeWidth={2} shapeRendering="crispEdges" />
        )}
        {/* current price pixel marker */}
        <rect x={Math.round(x(n - 1)) - 2} y={Math.round(y(last)) - 2} width={5} height={5} fill={CRT} shapeRendering="crispEdges" />

        {/* right-edge labels */}
        {marks.map((m, i) => (
          <text
            key={m.label}
            x={x1 + 6}
            y={labelYs[i] + 4}
            fontSize={14}
            fill={m.color}
            style={{ fontFamily: "var(--font-pixel)", letterSpacing: "0.03em" }}
          >
            {m.label}
          </text>
        ))}

        {/* time span, UTC */}
        <text x={x0} y={H - 5} fontSize={13} fill={MUTED} style={{ fontFamily: "var(--font-pixel)" }}>
          {tf(t0)} UTC
        </text>
        <text x={x1} y={H - 5} fontSize={13} fill={MUTED} textAnchor="end" style={{ fontFamily: "var(--font-pixel)" }}>
          {n === 1 ? "1 READ" : `${tf(t1)} UTC · ${n} READS`}
        </text>
      </svg>
    </div>
  );
}
