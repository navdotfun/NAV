/* ============================================================================
   WallStreetBanner — the nav.fun opening scene.
   A hand-built, animated 2D pixel-art Wall Street: layered skyline with
   flickering lit windows, a classical NAV EXCHANGE facade, streetlamps,
   WALL ST / NAV.FUN signposts, a $NAV zeppelin, an LED ticker band, and
   pixel bankers doing the 8-bit walk cycle with ticker-engraved briefcases.

   All art is inline SVG rect-grid pixel art (shape-rendering="crispEdges"),
   generated deterministically at module scope — no raster images, no AI
   assets, no runtime JS loops. Motion is pure CSS keyframes (steps() for the
   sprite walk), and everything freezes under prefers-reduced-motion.
   Palette = the site design tokens (ink / paper / CRT green / gold / red).
   ========================================================================== */

import { navHash } from "../lib/data";

/* ---------- scene constants (viewBox units = px at 1280 wide) ---------- */
const W = 1280;
const H = 480;
const GROUND = 412; // building baseline / sidewalk top
const SIDEWALK_H = 24; // 412..436
const ROAD_TOP = GROUND + SIDEWALK_H; // 436..480

/* ---------- shared pixel palette ---------- */
const C = {
  ink: "#0c1116",       /* cool charcoal sky */
  deep: "#070b0f",
  far: "#151c23",       /* far skyline — silvered charcoal */
  mid: "#1f2831",       /* mid skyline */
  near: "#070b0f",
  ink3: "#2a333b",
  paper: "#f5f7f8",     /* silver-white */
  paper2: "#dfe6ea",    /* brushed silver */
  crt: "#00c805",       /* Robinhood green phosphor */
  green: "#009a39",     /* deep green fills */
  gold: "#c9a227",      /* reserved for $NAV props */
  goldLight: "#e0c25c",
  goldDark: "#8a6f1c",
  muted: "#5a6b78",
  mutedDark: "#93a4b1", /* silver haze */
  red: "#d92d20",
  road: "#0a0f14",
  walk: "#1a232b",
} as const;

/* ---------- tiny sprite engine (ASCII map → <rect> runs) ---------- */
type Pal = Record<string, string>;

function spriteRects(art: readonly string[], pal: Pal, u: number): JSX.Element[] {
  const out: JSX.Element[] = [];
  art.forEach((row, ry) => {
    let cx = 0;
    while (cx < row.length) {
      const ch = row[cx];
      if (pal[ch]) {
        let end = cx;
        while (end + 1 < row.length && row[end + 1] === ch) end++;
        out.push(
          <rect key={`${ry}-${cx}`} x={cx * u} y={ry * u} width={(end - cx + 1) * u} height={u} fill={pal[ch]} />,
        );
        cx = end + 1;
      } else cx++;
    }
  });
  return out;
}

function Sprite({ art, pal, u = 4, x = 0, y = 0 }: { art: readonly string[]; pal: Pal; u?: number; x?: number; y?: number }) {
  return <g transform={`translate(${x} ${y})`}>{spriteRects(art, pal, u)}</g>;
}

/* ---------- buildings (procedural, deterministic) ---------- */
interface Tier { w: number; h: number }
interface BldgSpec {
  x: number;          // left edge of the widest (bottom) tier
  tiers: Tier[];      // bottom-up; upper tiers centered on the one below
  body: string;
  lit: number;        // 0..1 share of window slots that glow
  seed: string;
  winFill?: string;
  winAlpha?: number;
  flicker?: boolean;  // some windows get the flicker animation
  antenna?: boolean;  // rooftop mast + red beacon
}

function Bldg({ spec }: { spec: BldgSpec }) {
  const { x, tiers, body, lit, seed, winFill = C.gold, winAlpha = 1, flicker = false, antenna = false } = spec;
  const rects: JSX.Element[] = [];
  const wins: JSX.Element[] = [];
  let bottom = GROUND;
  let cx = x + tiers[0].w / 2;
  let topY = GROUND;
  let topCx = cx;
  tiers.forEach((t, ti) => {
    const left = cx - t.w / 2;
    const top = bottom - t.h;
    rects.push(<rect key={`t${ti}`} x={left} y={top} width={t.w} height={t.h} fill={body} />);
    /* window grid: 6×9 windows on a 16×20 pitch */
    if (lit > 0) {
      for (let wy = top + 10; wy < bottom - 12; wy += 20) {
        for (let wx = left + 8; wx < left + t.w - 10; wx += 16) {
          const r = navHash(`${seed}:${ti}:${wx}:${wy}`) % 1000;
          if (r < lit * 1000) {
            const green = r % 29 === 0; // the occasional trader still at the desk
            const fl = flicker && r % 17 === 0;
            wins.push(
              <rect
                key={`w${ti}-${wx}-${wy}`}
                x={wx}
                y={wy}
                width={6}
                height={9}
                fill={green ? C.crt : winFill}
                opacity={winAlpha}
                className={fl ? "ws-flick" : undefined}
                style={fl ? { animationDelay: `${(r % 40) / 10}s`, animationDuration: `${2.2 + (r % 23) / 10}s` } : undefined}
              />,
            );
          }
        }
      }
    }
    topY = top;
    topCx = cx;
    bottom = top;
  });
  return (
    <g>
      {rects}
      {wins}
      {antenna && (
        <g>
          <rect x={topCx - 2} y={topY - 26} width={4} height={26} fill={body} />
          <rect x={topCx - 3} y={topY - 32} width={6} height={6} fill={C.red} className="ws-beacon" />
        </g>
      )}
    </g>
  );
}

/* ---------- skyline layer specs ---------- */
const FAR: BldgSpec[] = [
  { x: -40, tiers: [{ w: 120, h: 250 }], body: C.far, lit: 0, seed: "f1" },
  { x: 70, tiers: [{ w: 90, h: 200 }], body: C.far, lit: 0, seed: "f2" },
  { x: 150, tiers: [{ w: 130, h: 300 }, { w: 70, h: 28 }], body: C.far, lit: 0, seed: "f3" },
  { x: 275, tiers: [{ w: 100, h: 225 }], body: C.far, lit: 0, seed: "f4" },
  { x: 370, tiers: [{ w: 140, h: 270 }], body: C.far, lit: 0, seed: "f5" },
  { x: 505, tiers: [{ w: 90, h: 195 }], body: C.far, lit: 0, seed: "f6" },
  { x: 590, tiers: [{ w: 120, h: 310 }, { w: 56, h: 26 }], body: C.far, lit: 0, seed: "f7" },
  { x: 705, tiers: [{ w: 100, h: 215 }], body: C.far, lit: 0, seed: "f8" },
  { x: 800, tiers: [{ w: 130, h: 280 }], body: C.far, lit: 0, seed: "f9" },
  { x: 925, tiers: [{ w: 90, h: 205 }], body: C.far, lit: 0, seed: "f10" },
  { x: 1010, tiers: [{ w: 140, h: 305 }, { w: 64, h: 30 }], body: C.far, lit: 0, seed: "f11" },
  { x: 1145, tiers: [{ w: 100, h: 230 }], body: C.far, lit: 0, seed: "f12" },
  { x: 1240, tiers: [{ w: 110, h: 265 }], body: C.far, lit: 0, seed: "f13" },
];

const MID: BldgSpec[] = [
  { x: -40, tiers: [{ w: 110, h: 218 }], body: C.mid, lit: 0.16, seed: "m1", winFill: C.mutedDark, winAlpha: 0.4 },
  { x: 80, tiers: [{ w: 130, h: 240 }], body: C.mid, lit: 0.18, seed: "m2", winFill: C.gold, winAlpha: 0.4 },
  { x: 215, tiers: [{ w: 95, h: 190 }], body: C.mid, lit: 0.15, seed: "m3", winFill: C.mutedDark, winAlpha: 0.4 },
  { x: 310, tiers: [{ w: 140, h: 260 }, { w: 76, h: 30 }], body: C.mid, lit: 0.17, seed: "m4", winFill: C.gold, winAlpha: 0.42 },
  { x: 455, tiers: [{ w: 105, h: 226 }], body: C.mid, lit: 0.15, seed: "m5", winFill: C.mutedDark, winAlpha: 0.38 },
  { x: 560, tiers: [{ w: 125, h: 252 }], body: C.mid, lit: 0.17, seed: "m6", winFill: C.gold, winAlpha: 0.4 },
  { x: 690, tiers: [{ w: 100, h: 200 }], body: C.mid, lit: 0.14, seed: "m7", winFill: C.mutedDark, winAlpha: 0.4 },
  { x: 790, tiers: [{ w: 135, h: 252 }, { w: 70, h: 28 }], body: C.mid, lit: 0.18, seed: "m8", winFill: C.gold, winAlpha: 0.42 },
  { x: 930, tiers: [{ w: 100, h: 214 }], body: C.mid, lit: 0.15, seed: "m9", winFill: C.mutedDark, winAlpha: 0.38 },
  { x: 1030, tiers: [{ w: 130, h: 244 }], body: C.mid, lit: 0.17, seed: "m10", winFill: C.gold, winAlpha: 0.4 },
  { x: 1165, tiers: [{ w: 105, h: 236 }], body: C.mid, lit: 0.16, seed: "m11", winFill: C.gold, winAlpha: 0.4 },
  { x: 1270, tiers: [{ w: 80, h: 200 }], body: C.mid, lit: 0.14, seed: "m12", winFill: C.mutedDark, winAlpha: 0.4 },
];

const NEAR: BldgSpec[] = [
  { x: -30, tiers: [{ w: 150, h: 282 }], body: C.near, lit: 0.4, seed: "n1", flicker: true },
  { x: 130, tiers: [{ w: 116, h: 206 }], body: C.near, lit: 0.36, seed: "n2", flicker: true },
  { x: 256, tiers: [{ w: 130, h: 252 }, { w: 84, h: 46 }, { w: 44, h: 24 }], body: C.near, lit: 0.4, seed: "n3", flicker: true, antenna: true },
  { x: 396, tiers: [{ w: 96, h: 168 }], body: C.near, lit: 0.35, seed: "n4", flicker: true },
  /* 500..780 = NAV Exchange (hand-drawn below) */
  { x: 790, tiers: [{ w: 118, h: 238 }], body: C.near, lit: 0.38, seed: "n5", flicker: true },
  { x: 918, tiers: [{ w: 142, h: 262 }, { w: 88, h: 42 }], body: C.near, lit: 0.4, seed: "n6", flicker: true, antenna: true },
  { x: 1070, tiers: [{ w: 108, h: 186 }], body: C.near, lit: 0.36, seed: "n7", flicker: true },
  { x: 1188, tiers: [{ w: 132, h: 288 }], body: C.near, lit: 0.4, seed: "n8", flicker: true },
];

/* ---------- hand-drawn set pieces ---------- */

/** Classical exchange facade — the centerpiece at 500..780. */
function NavExchange() {
  const left = 500;
  const width = 280;
  const cx = left + width / 2;
  const cols: JSX.Element[] = [];
  for (let i = 0; i < 8; i++) {
    const x = left + 26 + i * 32;
    cols.push(<rect key={`c${i}`} x={x} y={310} width={12} height={78} fill={C.mutedDark} />);
    cols.push(<rect key={`ct${i}`} x={x - 2} y={306} width={16} height={4} fill={C.mutedDark} />);
    cols.push(<rect key={`cb${i}`} x={x - 2} y={388} width={16} height={4} fill={C.mutedDark} />);
    cols.push(<rect key={`cs${i}`} x={x + 8} y={310} width={4} height={78} fill={C.muted} />);
  }
  /* stepped pediment */
  const ped: JSX.Element[] = [];
  const widths = [264, 220, 176, 132, 88, 44];
  widths.forEach((w, i) => {
    ped.push(<rect key={`p${i}`} x={cx - w / 2} y={286 - (i + 1) * 7} width={w} height={7} fill={C.mid} />);
  });
  return (
    <g>
      {/* steps */}
      <rect x={left} y={GROUND - 6} width={width} height={6} fill={C.ink3} />
      <rect x={left + 8} y={GROUND - 12} width={width - 16} height={6} fill={C.mid} />
      <rect x={left + 16} y={GROUND - 18} width={width - 32} height={6} fill={C.ink3} />
      {/* main hall behind the columns */}
      <rect x={left + 12} y={294} width={width - 24} height={100} fill={C.deep} />
      {/* lit doorway */}
      <rect x={cx - 12} y={352} width={24} height={42} fill={C.goldLight} opacity={0.9} />
      <rect x={cx - 2} y={352} width={4} height={42} fill={C.goldDark} />
      {cols}
      {/* entablature + name */}
      <rect x={left + 4} y={286} width={width - 8} height={20} fill={C.mid} />
      <rect x={left + 4} y={286} width={width - 8} height={3} fill={C.mutedDark} />
      <text x={cx} y={301} textAnchor="middle" fontFamily="'VT323', monospace" fontSize="15" fill={C.gold} letterSpacing="2">
        NAV EXCHANGE
      </text>
      {ped}
      <rect x={cx - 3} y={236} width={6} height={8} fill={C.gold} />
    </g>
  );
}

/** LED ticker band wrapped around building n2 (x 130..246). */
function LedBand() {
  const tick = "NAV.FUN ▲ AAPL · TSLA · NVDA · MSFT · AMZN · SPY · QQQ · META · GOOGL · COIN · PLTR ▲ ";
  return (
    <g>
      <rect x={132} y={238} width={112} height={22} fill={C.deep} stroke={C.ink3} strokeWidth={2} />
      <clipPath id="ws-led-clip">
        <rect x={136} y={240} width={104} height={18} />
      </clipPath>
      <g clipPath="url(#ws-led-clip)">
        <g className="ws-led">
          <text x={136} y={255} fontFamily="'VT323', monospace" fontSize="16" fill={C.crt} textLength={560}>{tick}</text>
          <text x={696} y={255} fontFamily="'VT323', monospace" fontSize="16" fill={C.crt} textLength={560}>{tick}</text>
        </g>
      </g>
    </g>
  );
}

/** Street sign post: WALL ST over NAV.FUN. */
function SignPost({ x }: { x: number }) {
  return (
    <g>
      <rect x={x - 3} y={330} width={6} height={GROUND - 330} fill={C.ink3} />
      <rect x={x - 3} y={GROUND - 4} width={6} height={4} fill={C.deep} />
      {/* WALL ST plate */}
      <rect x={x - 46} y={326} width={92} height={22} fill={C.green} />
      <rect x={x - 46} y={326} width={92} height={2} fill={C.crt} />
      <text x={x} y={343} textAnchor="middle" fontFamily="'VT323', monospace" fontSize="17" fill={C.paper} letterSpacing="1">WALL ST</text>
      {/* NAV.FUN plate below */}
      <rect x={x - 40} y={352} width={80} height={20} fill={C.gold} />
      <rect x={x - 40} y={352} width={80} height={2} fill={C.goldLight} />
      <text x={x} y={368} textAnchor="middle" fontFamily="'VT323', monospace" fontSize="16" fill={C.ink} letterSpacing="1">NAV.FUN</text>
    </g>
  );
}

/** Streetlamp with a soft pulsing glow. */
function Lamp({ x }: { x: number }) {
  return (
    <g>
      <rect x={x - 2} y={344} width={4} height={GROUND - 344} fill={C.ink3} />
      <rect x={x - 6} y={340} width={12} height={6} fill={C.ink3} />
      <rect x={x - 5} y={332} width={10} height={8} fill={C.goldLight} />
      <rect x={x - 10} y={340} width={20} height={4} fill={C.goldLight} opacity={0.18} className="ws-lamp" />
    </g>
  );
}

/** Fire hydrant (gold, obviously). */
function Hydrant({ x }: { x: number }) {
  return (
    <g>
      <rect x={x - 5} y={GROUND + 8} width={10} height={12} fill={C.gold} />
      <rect x={x - 7} y={GROUND + 12} width={14} height={4} fill={C.gold} />
      <rect x={x - 3} y={GROUND + 4} width={6} height={4} fill={C.goldDark} />
    </g>
  );
}

/* ---------- sprites ---------- */

const BANKER_HEAD = [
  "..kkkkkk....",
  ".kkkkkkkk...",
  "..pppppp....",
  "..pppppp....",
] as const;

const BANKER_BODY_A = [
  ".SSSooSSS...",
  ".SSSooSSS...",
  ".S.SooSS.S..",
  ".S.SSSSS.S..",
  ".p.SSSSS.p..",
  "..SSSSSS....",
  "..SS..SS....",
  ".SS....SS...",
  ".dd....dd...",
] as const;

const BANKER_BODY_B = [
  ".SSSooSSS...",
  ".SSSooSSS...",
  ".S.SooSS.S..",
  ".S.SSSSS.S..",
  ".p.SSSSS.p..",
  "..SSSSSS....",
  "...SSSS.....",
  "...SSSS.....",
  "...dddd.....",
] as const;

function bankerPal(suit: string): Pal {
  return { k: C.ink3, p: C.paper, S: suit, d: C.deep, o: C.gold };
}

/**
 * A walking pixel banker with a ticker-engraved $NAV briefcase.
 * Outer <g> gets the translateX walk animation; the inner frames swap on a
 * steps() cadence for the authentic 8-bit walk cycle.
 */
function Banker({
  ticker,
  suit,
  dir,
  dur,
  delay,
  hideOnMobile = false,
}: {
  ticker: string;
  suit: string;
  dir: "r" | "l";
  dur: number;
  delay: number;
  hideOnMobile?: boolean;
}) {
  const pal = bankerPal(suit);
  const u = 4;
  const spriteH = (BANKER_HEAD.length + BANKER_BODY_A.length) * u; // 52
  const footY = ROAD_TOP - 4; // walk mid-sidewalk
  const topY = footY - spriteH;
  const cls = `ws-banker ws-walk-${dir}${hideOnMobile ? " ws-hide-sm" : ""}`;
  /* briefcase drawn outside the mirror transform so the engraved ticker
     always reads left-to-right; bx mirrors its position for left-walkers */
  const bx = dir === "l" ? 0 : 34;
  const briefcase = (
    <g transform={`translate(0 ${topY})`}>
      <rect x={bx} y={30} width={30} height={20} fill={C.gold} />
      <rect x={bx} y={30} width={30} height={2} fill={C.goldLight} />
      <rect x={bx} y={48} width={30} height={2} fill={C.goldDark} />
      <rect x={bx + 10} y={26} width={10} height={4} fill={C.goldDark} />
      <text x={bx + 15} y={44} textAnchor="middle" fontFamily="'VT323', monospace" fontSize="11" fill={C.ink}>{ticker}</text>
    </g>
  );
  const frames = (
    <g transform={`translate(0 ${topY})`}>
      <Sprite art={BANKER_HEAD} pal={pal} u={u} />
      <g className="ws-fA"><Sprite art={BANKER_BODY_A} pal={pal} u={u} y={BANKER_HEAD.length * u} /></g>
      <g className="ws-fB"><Sprite art={BANKER_BODY_B} pal={pal} u={u} y={BANKER_HEAD.length * u} /></g>
    </g>
  );
  return (
    <g className={cls} style={{ animationDuration: `${dur}s`, animationDelay: `${delay}s` }}>
      {dir === "l" ? <g transform="translate(64 0) scale(-1 1)">{frames}</g> : frames}
      {briefcase}
    </g>
  );
}

const ZEPPELIN = [
  "......mmmmmmmmmmmm..",
  ".mm..mPPPPPPPPPPPPm.",
  "mmm.mPPPPPPPPPPPPPPm",
  "mmm.mPPPPPPPPPPPPPPm",
  ".mm..mPPPPPPPPPPPPm.",
  "......mmmmmmmmmmmm..",
  "..........KK........",
  ".........KooK.......",
] as const;

function Zeppelin() {
  return (
    <g className="ws-zep ws-hide-sm">
      {/* towed $NAV banner */}
      <rect x={-96} y={16} width={72} height={24} fill={C.ink3} stroke={C.gold} strokeWidth={2} />
      <text x={-60} y={34} textAnchor="middle" fontFamily="'VT323', monospace" fontSize="18" fill={C.crt}>$NAV</text>
      <rect x={-24} y={26} width={24} height={2} fill={C.muted} />
      <Sprite art={ZEPPELIN} pal={{ m: C.muted, P: C.paper2, K: C.ink3, o: C.goldLight }} u={4} />
    </g>
  );
}

const CLOUD = [
  "....mmmmm.......",
  ".mmmmmmmmmmm....",
  "mmmmmmmmmmmmmmm.",
] as const;

const MOON = [
  "..yyyy..",
  ".yyyyyy.",
  "yyyyyyyy",
  "yyyyyyoy",
  "yoyyyyyy",
  "yyyyyyyy",
  ".yyyyoy.",
  "..yyyy..",
] as const;

/* stars — deterministic scatter across the sky */
const STARS = Array.from({ length: 30 }, (_, i) => {
  const h = navHash(`star:${i}`);
  return {
    x: (h % W),
    y: 14 + ((h >> 8) % 170),
    s: 2 + (i % 2),
    tw: i % 3 === 0,
    c: i % 9 === 0 ? C.crt : i % 7 === 0 ? C.gold : C.mutedDark,
    d: (h % 50) / 10,
  };
});

/* road dashes */
const DASHES = Array.from({ length: 21 }, (_, i) => i * 64);

/* ---------- the scene ---------- */
export function WallStreetScene() {
  return (
    <svg
      className="ws-scene"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMax slice"
      shapeRendering="crispEdges"
      role="img"
      aria-label="Animated pixel-art Wall Street at night: a skyline of towers with flickering lit windows behind the classical NAV Exchange facade, a zeppelin towing a $NAV banner, and pixel bankers walking the street carrying gold briefcases engraved with stock tickers"
    >
      {/* sky */}
      <rect x={0} y={0} width={W} height={H} fill={C.ink} />
      {STARS.map((s, i) => (
        <rect
          key={i}
          x={s.x}
          y={s.y}
          width={s.s}
          height={s.s}
          fill={s.c}
          opacity={0.75}
          className={s.tw ? "ws-flick" : undefined}
          style={s.tw ? { animationDelay: `${s.d}s`, animationDuration: "4.4s" } : undefined}
        />
      ))}
      <Sprite art={MOON} pal={{ y: C.goldLight, o: C.gold }} u={4} x={1148} y={28} />

      {/* drifting clouds (parallax speeds) */}
      <g className="ws-cloud ws-cloud-a" opacity={0.5}>
        <Sprite art={CLOUD} pal={{ m: C.mid }} u={6} x={0} y={92} />
      </g>
      <g className="ws-cloud ws-cloud-b ws-hide-sm" opacity={0.38}>
        <Sprite art={CLOUD} pal={{ m: C.mid }} u={5} x={0} y={168} />
      </g>

      <Zeppelin />

      {/* skyline layers — far/mid sway at different amplitudes for depth */}
      <g className="ws-far ws-hide-sm">
        {FAR.map((b) => <Bldg key={b.seed} spec={b} />)}
      </g>
      <g className="ws-mid">
        {MID.map((b) => <Bldg key={b.seed} spec={b} />)}
      </g>
      <g>
        {NEAR.map((b) => <Bldg key={b.seed} spec={b} />)}
        <NavExchange />
        <LedBand />
        {/* rooftop water tower on n5 */}
        <g transform="translate(830 148)">
          <rect x={0} y={8} width={28} height={18} fill={C.ink3} />
          <rect x={2} y={2} width={24} height={6} fill={C.mid} />
          <rect x={3} y={26} width={4} height={8} fill={C.ink3} />
          <rect x={21} y={26} width={4} height={8} fill={C.ink3} />
        </g>
      </g>

      {/* street */}
      <rect x={0} y={GROUND} width={W} height={SIDEWALK_H} fill={C.walk} />
      <rect x={0} y={ROAD_TOP - 3} width={W} height={3} fill={C.deep} />
      <rect x={0} y={ROAD_TOP} width={W} height={H - ROAD_TOP} fill={C.road} />
      {DASHES.map((x) => (
        <rect key={x} x={x} y={456} width={26} height={4} fill={C.gold} opacity={0.4} />
      ))}

      {/* street furniture */}
      <Lamp x={96} />
      <Lamp x={468} />
      <Lamp x={854} />
      <Lamp x={1196} />
      <SignPost x={392} />
      <Hydrant x={1024} />

      {/* the commute — $NAV briefcases on the move */}
      <Banker ticker="AAPL" suit={C.ink3} dir="r" dur={46} delay={-6} />
      <Banker ticker="TSLA" suit={C.muted} dir="l" dur={52} delay={-30} />
      <Banker ticker="NVDA" suit="#2b3640" dir="r" dur={58} delay={-38} hideOnMobile />
      <Banker ticker="MSFT" suit="#1c252d" dir="l" dur={44} delay={-12} hideOnMobile />
      <Banker ticker="SPY" suit="#3a4750" dir="r" dur={64} delay={-52} hideOnMobile />
    </svg>
  );
}
