/* The Pit — payoff at expiry. Custom SVG hockey-stick from the PitPricer
   mirror: loss floor = premium paid, kink at strike, breakeven and live price
   marked. Everything derives from the live price and the user's inputs. */
import { breakeven, pnl, type PitSide } from "../../lib/pitPricer";
import { fmt } from "../../lib/format";
import { useWidth } from "./useWidth";

const H = 236;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 16;
const PAD_B = 26;

const INK3 = "#1b3049";
const CRT = "#4ae58a";
const GOLD = "#c9a227";
const PAPER = "#f5f1e8";
const MUTED = "#8fa3b8";
const RED = "#e5484d";

function px(v: number): number {
  return Math.round(v) + 0.5;
}

export function PayoffChart({
  side,
  strike,
  qty,
  premiumPerUnit,
  livePrice,
}: {
  side: PitSide;
  strike: number;
  qty: number;
  premiumPerUnit: number;
  livePrice: number;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const w = Math.max(width, 280);

  const premTotal = qty * premiumPerUnit;
  const be = breakeven(side, strike, premiumPerUnit);

  /* x domain: strike ± span, wide enough to include BE and live price */
  const span = Math.max(strike * 0.18, premiumPerUnit * 2.5, Math.abs(livePrice - strike) * 1.35);
  const lo = Math.max(strike - span, 0);
  const hi = strike + span;

  /* y domain: symmetric-ish around 0, driven by max gain in view vs premium */
  const gainAtEdge = Math.max(pnl(side, lo, strike, qty, premTotal), pnl(side, hi, strike, qty, premTotal), 0);
  const yTop = Math.max(gainAtEdge, premTotal) * 1.1;
  const yBot = -premTotal * 1.45;

  const x0 = PAD_L;
  const x1 = w - PAD_R;
  const X = (p: number) => x0 + ((p - lo) / (hi - lo)) * (x1 - x0);
  const Y = (v: number) => PAD_T + ((yTop - v) / (yTop - yBot)) * (H - PAD_T - PAD_B);

  /* hockey stick: 3 anchor points, kink at K */
  const pts: [number, number][] =
    side === "CALL"
      ? [
          [lo, -premTotal],
          [strike, -premTotal],
          [hi, pnl("CALL", hi, strike, qty, premTotal)],
        ]
      : [
          [lo, pnl("PUT", lo, strike, qty, premTotal)],
          [strike, -premTotal],
          [hi, -premTotal],
        ];
  const line = pts.map(([p, v], i) => `${i === 0 ? "M" : "L"} ${px(X(p))} ${px(Y(v))}`).join(" ");

  const lineColor = side === "PUT" ? RED : CRT;
  const pnlAtLive = pnl(side, livePrice, strike, qty, premTotal);

  return (
    <div ref={ref} className="min-w-0">
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={`P&L at expiry for ${qty} ${side} at strike ${fmt.usd(strike)}`}>
        {/* zero line */}
        <line x1={x0} x2={x1} y1={px(Y(0))} y2={px(Y(0))} stroke={PAPER} strokeOpacity={0.4} strokeWidth={1} shapeRendering="crispEdges" />
        {/* premium floor */}
        <line x1={x0} x2={x1} y1={px(Y(-premTotal))} y2={px(Y(-premTotal))} stroke={INK3} strokeWidth={1} strokeDasharray="4 4" shapeRendering="crispEdges" />

        {/* breakeven vertical */}
        <line x1={px(X(be))} x2={px(X(be))} y1={PAD_T} y2={H - PAD_B} stroke={MUTED} strokeWidth={1} strokeDasharray="2 4" shapeRendering="crispEdges" />
        {/* live price vertical */}
        <line x1={px(X(livePrice))} x2={px(X(livePrice))} y1={PAD_T} y2={H - PAD_B} stroke={GOLD} strokeWidth={1} strokeDasharray="6 4" shapeRendering="crispEdges" />

        {/* payoff line */}
        <path d={line} fill="none" stroke={lineColor} strokeWidth={2} shapeRendering="crispEdges" />

        {/* strike tick on the x axis */}
        <rect x={Math.round(X(strike)) - 2} y={H - PAD_B - 2} width={5} height={5} fill={lineColor} shapeRendering="crispEdges" />

        {/* labels */}
        <text x={Math.min(Math.max(X(be) + 5, x0 + 2), x1 - 78)} y={PAD_T + 12} fontSize={14} fill={MUTED} stroke="#122234" strokeWidth={4} paintOrder="stroke" style={{ fontFamily: "var(--font-pixel)" }}>
          BE {fmt.usd(be)}
        </text>
        <text
          x={X(livePrice) > (x0 + x1) / 2 ? X(livePrice) - 5 : X(livePrice) + 5}
          y={H - PAD_B - 8}
          fontSize={14}
          fill={GOLD}
          textAnchor={X(livePrice) > (x0 + x1) / 2 ? "end" : "start"}
          stroke="#122234"
          strokeWidth={4}
          paintOrder="stroke"
          style={{ fontFamily: "var(--font-pixel)" }}
        >
          P {fmt.usd(livePrice)}
        </text>
        <text x={x0} y={Math.min(Y(-premTotal) + 15, H - PAD_B - 2)} fontSize={14} fill={MUTED} stroke="#122234" strokeWidth={4} paintOrder="stroke" style={{ fontFamily: "var(--font-pixel)" }}>
          MAX LOSS −{fmt.usd(premTotal)}
        </text>
        <text x={x0} y={H - 7} fontSize={13} fill={MUTED} style={{ fontFamily: "var(--font-pixel)" }}>
          {fmt.usd(lo)}
        </text>
        <text x={x1} y={H - 7} fontSize={13} fill={MUTED} textAnchor="end" style={{ fontFamily: "var(--font-pixel)" }}>
          {fmt.usd(hi)}
        </text>
      </svg>

      {/* readouts — all derived from the quote above */}
      <div className="grid gap-y-1.5 border-t border-ink-3 pt-3 text-[13px] text-muted-dark">
        <div className="flex justify-between gap-3">
          <span>Premium</span>
          <b className="num font-medium text-paper">{fmt.usd(premTotal)}</b>
        </div>
        <div className="flex justify-between gap-3">
          <span>Breakeven</span>
          <b className="num font-medium text-paper">{fmt.usd(be)}</b>
        </div>
        <div className="flex justify-between gap-3">
          <span>Max loss</span>
          <b className="num font-medium text-paper">−{fmt.usd(premTotal)}</b>
        </div>
        <div className="flex justify-between gap-3">
          <span>At live price</span>
          <b className={`num font-medium ${pnlAtLive >= 0 ? "up" : "down"}`}>
            {pnlAtLive >= 0 ? "+" : "−"}{fmt.usd(Math.abs(pnlAtLive))} · {premTotal > 0 ? ((pnlAtLive / premTotal) * 100).toFixed(1) : "0.0"}%
          </b>
        </div>
      </div>
    </div>
  );
}
