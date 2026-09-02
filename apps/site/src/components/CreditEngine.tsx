/* ============================================================================
   CreditEngine — the CREDIT section's living schematic (2D canvas).

   A phosphor flow-diagram of an isolated lending market: four collateral
   cells feed a central USDG liquidity ring; draws stream to borrowers and
   every draw peels a gold fee particle into the $NAV accumulator. Repays
   trickle home; the reserve drips gold. One canvas, one RAF, additive glow.

   Contract (owner directive):
   - schematic only — every printed figure is a deployed immutable parameter,
     never a synthetic balance;
   - RAF pauses off-screen (IntersectionObserver) and on tab hide;
   - prefers-reduced-motion renders a single static frame, zero animation;
   - DPR capped at 2; ResizeObserver drives layout; full cleanup on unmount.
   ========================================================================== */
import { useEffect, useRef } from "react";

const GREEN = "#00c805";
const GREEN_DIM = "#6fd97a";
const GREEN_FAINT = "rgba(0, 200, 5, 0.16)";
const GOLD = "#e8c14a";
const GOLD_DIM = "rgba(214, 178, 64, 0.75)";
const MUTED = "#a7b7c2";
const MONO = "'IBM Plex Mono', 'Menlo', 'Consolas', monospace";

type Market = { sym: string; ltv: number; lt: number; bonus: number };
const MARKETS: Market[] = [
  { sym: "NVDA", ltv: 60, lt: 70, bonus: 8 },
  { sym: "QQQ", ltv: 65, lt: 75, bonus: 6 },
  { sym: "AAPL", ltv: 55, lt: 65, bonus: 8 },
  { sym: "TSLA", ltv: 50, lt: 60, bonus: 10 },
];

type Pt = { x: number; y: number };
type Rail = [Pt, Pt, Pt, Pt]; // cubic bezier
type Particle = {
  rail: Rail;
  t: number;
  speed: number;
  size: number;
  color: string;
  trail: number; // trail length in t-units
  onArrive?: () => void;
};

function cubic(r: Rail, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * r[0].x + b * r[1].x + c * r[2].x + d * r[3].x,
    y: a * r[0].y + b * r[1].y + c * r[2].y + d * r[3].y,
  };
}

function rail(from: Pt, to: Pt, bend = 0.35): Rail {
  const mx = (from.x + to.x) / 2;
  return [
    from,
    { x: mx + (to.x - from.x) * -bend * 0.2, y: from.y },
    { x: mx, y: to.y },
    to,
  ];
}

export default function CreditEngine({ className = "" }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let W = 0, H = 0, dpr = 1, narrow = false;
    let raf = 0, inView = true, alive = true, last = 0, t = 0;

    /* --- layout ------------------------------------------------------- */
    type Layout = {
      cells: (Pt & { m: Market })[];
      cellW: number; cellH: number;
      pool: Pt; poolR: number;
      borrow: Pt; accum: Pt; nodeW: number; nodeH: number;
      railsIn: Rail[]; railDraw: Rail; railRepay: Rail; railFee: Rail;
    };
    let L: Layout | null = null;

    const layout = () => {
      const w = W, h = H;
      narrow = w < 640;
      const cellW = narrow ? 92 : 118;
      const cellH = narrow ? 40 : 48;
      const leftX = narrow ? 10 : 26;
      const gap = (h - MARKETS.length * cellH) / (MARKETS.length + 1);
      const cells = MARKETS.map((m, i) => ({
        m,
        x: leftX,
        y: gap + i * (cellH + gap) + cellH / 2,
      }));
      const pool: Pt = { x: w * (narrow ? 0.48 : 0.47), y: h / 2 };
      const poolR = Math.min(h * 0.30, narrow ? 52 : 96);
      const nodeW = narrow ? 108 : 150;
      const nodeH = narrow ? 40 : 52;
      const rightX = w - nodeW / 2 - (narrow ? 8 : 26);
      const borrow: Pt = { x: rightX, y: h * 0.26 };
      const accum: Pt = { x: rightX, y: h * 0.74 };
      const railsIn = cells.map((c) =>
        rail({ x: c.x + cellW, y: c.y }, { x: pool.x - poolR - 6, y: pool.y + (c.y - pool.y) * 0.22 }),
      );
      const railDraw = rail({ x: pool.x + poolR * 0.72, y: pool.y - poolR * 0.6 }, { x: borrow.x - nodeW / 2, y: borrow.y });
      const railRepay = rail({ x: borrow.x - nodeW / 2, y: borrow.y + 10 }, { x: pool.x + poolR * 0.86, y: pool.y - poolR * 0.28 });
      const railFee = rail({ x: pool.x + poolR * 0.72, y: pool.y + poolR * 0.6 }, { x: accum.x - nodeW / 2, y: accum.y });
      L = { cells, cellW, cellH, pool, poolR, borrow, accum, nodeW, nodeH, railsIn, railDraw, railRepay, railFee };
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      if (!rect.width) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width;
      H = rect.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      layout();
      if (reduced) drawFrame(0);
    };

    /* --- state -------------------------------------------------------- */
    const particles: Particle[] = [];
    let accumPulse = 0; // 0..1 decaying pulse on fee arrival
    let borrowFlash = 0;
    let nextDraw = 0.8;
    let nextDeposit = 0.3;
    let nextRepay = 2.2;
    let nextReserve = 3.6;

    const spawn = (p: Particle) => {
      if (particles.length < 90) particles.push(p);
    };

    /* --- drawing ------------------------------------------------------ */
    const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    const drawRail = (r: Rail, alpha: number) => {
      ctx.strokeStyle = `rgba(0, 200, 5, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r[0].x, r[0].y);
      ctx.bezierCurveTo(r[1].x, r[1].y, r[2].x, r[2].y, r[3].x, r[3].y);
      ctx.stroke();
    };

    const label = (s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "center", ls = 1.5) => {
      ctx.font = `${size}px ${MONO}`;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      // manual letterspacing for the terminal feel
      if (ls > 0 && align === "center") {
        const chars = s.split("");
        const widths = chars.map((c) => ctx.measureText(c).width + ls);
        const total = widths.reduce((a, b) => a + b, 0) - ls;
        let cx = x - total / 2;
        for (let i = 0; i < chars.length; i++) {
          ctx.textAlign = "left";
          ctx.fillText(chars[i], cx, y);
          cx += widths[i];
        }
        ctx.textAlign = "center";
      } else {
        ctx.fillText(s, x, y);
      }
    };

    const drawFrame = (dt: number) => {
      if (!L) return;
      t += dt;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const fs = narrow ? 9 : 10.5;

      /* rails */
      L.railsIn.forEach((r) => drawRail(r, 0.32));
      drawRail(L.railDraw, 0.42);
      drawRail(L.railRepay, 0.22);
      ctx.save();
      ctx.strokeStyle = GOLD_DIM;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(L.railFee[0].x, L.railFee[0].y);
      ctx.bezierCurveTo(L.railFee[1].x, L.railFee[1].y, L.railFee[2].x, L.railFee[2].y, L.railFee[3].x, L.railFee[3].y);
      ctx.stroke();
      ctx.restore();

      /* collateral cells */
      L.cells.forEach((c, i) => {
        const x = c.x, y = c.y - L!.cellH / 2, w = L!.cellW, h = L!.cellH;
        ctx.fillStyle = "rgba(0, 200, 5, 0.05)";
        roundRect(x, y, w, h, 3);
        ctx.fill();
        ctx.strokeStyle = GREEN_FAINT;
        ctx.stroke();
        label(c.m.sym, x + w / 2, y + h * 0.34, fs + 2, GREEN_DIM, "center", 2);
        /* LTV meter — deployed parameter, breathing highlight */
        const mw = w - 20;
        const mx = x + 10, my = y + h - 10;
        ctx.strokeStyle = "rgba(0,200,5,0.18)";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + mw, my); ctx.stroke();
        const breathe = reduced ? 1 : 0.85 + 0.15 * Math.sin(t * 1.4 + i * 1.3);
        ctx.strokeStyle = `rgba(0, 200, 5, ${0.75 * breathe})`;
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + mw * (c.m.ltv / 100), my); ctx.stroke();
        /* liquidation tick */
        ctx.strokeStyle = "rgba(255, 107, 111, 0.95)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mx + mw * (c.m.lt / 100), my - 4);
        ctx.lineTo(mx + mw * (c.m.lt / 100), my + 4);
        ctx.stroke();
        label(`LTV ${c.m.ltv}`, x + w / 2, y + h - 18, fs - 2, MUTED, "center", 1);
      });

      /* pool ring */
      const { pool, poolR } = L;
      const rot = reduced ? 0 : t * 0.22;
      ctx.save();
      ctx.translate(pool.x, pool.y);
      ctx.rotate(rot);
      ctx.strokeStyle = "rgba(0, 200, 5, 0.5)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([10, 14]);
      ctx.beginPath(); ctx.arc(0, 0, poolR, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      const br = reduced ? 0 : Math.sin(t * 1.1) * 2.5;
      ctx.strokeStyle = GREEN_FAINT;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(pool.x, pool.y, poolR * 0.78 + br, 0, Math.PI * 2); ctx.stroke();
      /* soft core glow */
      const g = ctx.createRadialGradient(pool.x, pool.y, 4, pool.x, pool.y, poolR * 0.8);
      g.addColorStop(0, "rgba(0, 200, 5, 0.14)");
      g.addColorStop(1, "rgba(0, 200, 5, 0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(pool.x, pool.y, poolR * 0.8, 0, Math.PI * 2); ctx.fill();
      label("USDG", pool.x, pool.y - (narrow ? 8 : 12), narrow ? 15 : 20, GREEN, "center", 3);
      label("ISOLATED LIQUIDITY", pool.x, pool.y + (narrow ? 8 : 12), fs - 1.5, GREEN_DIM, "center", 1.5);
      if (!narrow) label("RATES ACCRUE PER SECOND", pool.x, pool.y + 30, fs - 2.5, MUTED, "center", 1);

      /* borrow node */
      const node = (p: Pt, title: string, sub: string, gold: boolean, flash: number) => {
        const x = p.x - L!.nodeW / 2, y = p.y - L!.nodeH / 2;
        ctx.fillStyle = gold ? "rgba(201, 162, 39, 0.07)" : "rgba(0, 200, 5, 0.06)";
        roundRect(x, y, L!.nodeW, L!.nodeH, 3);
        ctx.fill();
        ctx.strokeStyle = gold
          ? `rgba(232, 193, 74, ${0.35 + 0.65 * flash})`
          : `rgba(0, 200, 5, ${0.25 + 0.75 * flash})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        label(title, p.x, p.y - 8, fs + 0.5, gold ? GOLD : GREEN_DIM, "center", 1.5);
        label(sub, p.x, p.y + 10, fs - 2, MUTED, "center", 0.5);
        if (flash > 0.02) {
          ctx.strokeStyle = gold ? `rgba(232, 193, 74, ${flash * 0.5})` : `rgba(0,200,5,${flash * 0.5})`;
          roundRect(x - 3 - 4 * (1 - flash), y - 3 - 4 * (1 - flash), L!.nodeW + 6 + 8 * (1 - flash), L!.nodeH + 6 + 8 * (1 - flash), 4);
          ctx.stroke();
        }
      };
      node(L.borrow, "BORROWERS", narrow ? "DRAW USDG" : "DRAW AGAINST STOCK", false, borrowFlash);
      node(L.accum, "ACCUMULATOR", narrow ? "FEES → $NAV" : "EVERY FEE → $NAV BUYS", true, accumPulse);

      /* rail captions */
      if (!narrow) {
        const mid = cubic(L.railDraw, 0.55);
        label("DRAW · 30 BPS ORIGINATION", mid.x - 10, mid.y - 12, fs - 1, MUTED, "center", 1);
        const fm = cubic(L.railFee, 0.42);
        label("FEE RAIL · PERMISSIONLESS SKIM", fm.x - 6, fm.y + 24, fs - 1, GOLD, "center", 1);
        const cm = cubic(L.railsIn[0], 0.45);
        label("COLLATERAL LOCKS", cm.x, cm.y - 12, fs - 1, MUTED, "center", 1);
      }

      /* particles — additive pass */
      if (!reduced) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i];
          p.t += p.speed * dt;
          if (p.t >= 1) {
            p.onArrive?.();
            particles.splice(i, 1);
            continue;
          }
          /* trail */
          for (let k = 0; k < 5; k++) {
            const tt = p.t - (k / 5) * p.trail;
            if (tt < 0) break;
            const pos = cubic(p.rail, tt);
            const a = (1 - k / 5) * 0.8;
            ctx.fillStyle = p.color;
            ctx.globalAlpha = a;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, p.size * (1 - k / 6), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      /* decay pulses */
      accumPulse = Math.max(0, accumPulse - dt * 1.6);
      borrowFlash = Math.max(0, borrowFlash - dt * 2.2);
    };

    /* --- scheduler ------------------------------------------------------ */
    const step = (dt: number) => {
      nextDeposit -= dt;
      nextDraw -= dt;
      nextRepay -= dt;
      nextReserve -= dt;
      if (nextDeposit <= 0 && L) {
        nextDeposit = 0.5 + Math.random() * 0.9;
        const idx = Math.floor(Math.random() * L.railsIn.length);
        spawn({ rail: L.railsIn[idx], t: 0, speed: 0.55, size: 1.6, color: GREEN_DIM, trail: 0.06 });
      }
      if (nextDraw <= 0 && L) {
        nextDraw = 1.6 + Math.random() * 1.4;
        spawn({
          rail: L.railDraw, t: 0, speed: 0.7, size: 2.4, color: GREEN, trail: 0.1,
          onArrive: () => { borrowFlash = 1; },
        });
        /* the fee peels off ~at the same draw */
        spawn({
          rail: L.railFee, t: -0.06, speed: 0.55, size: 2.0, color: GOLD, trail: 0.09,
          onArrive: () => { accumPulse = 1; },
        });
      }
      if (nextRepay <= 0 && L) {
        nextRepay = 2.6 + Math.random() * 2.2;
        spawn({ rail: L.railRepay, t: 0, speed: 0.5, size: 1.5, color: "rgba(111, 217, 122, 0.8)", trail: 0.07 });
      }
      if (nextReserve <= 0 && L) {
        nextReserve = 3.8 + Math.random() * 2.4;
        spawn({
          rail: L.railFee, t: 0, speed: 0.4, size: 1.3, color: GOLD_DIM, trail: 0.05,
          onArrive: () => { accumPulse = Math.max(accumPulse, 0.55); },
        });
      }
    };

    const frame = (now: number) => {
      raf = 0;
      if (!alive || !inView || document.hidden) return;
      const dt = Math.min((now - last) / 1000 || 0.016, 0.05);
      last = now;
      step(dt);
      drawFrame(dt);
      raf = requestAnimationFrame(frame);
    };
    const wake = () => {
      if (alive && !raf && inView && !document.hidden && !reduced) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    const io = new IntersectionObserver(([e]) => {
      inView = e.isIntersecting;
      wake();
    });
    io.observe(host);
    const onVis = () => wake();
    document.addEventListener("visibilitychange", onVis);
    if (reduced) drawFrame(0); else wake();

    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      io.disconnect();
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={hostRef} className={className} aria-hidden="true">
      <canvas ref={canvasRef} style={{ display: "block" }} />
    </div>
  );
}
