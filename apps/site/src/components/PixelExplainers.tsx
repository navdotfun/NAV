/* ============================================================================
   PixelExplainers — hand-built pixel-art SVG diagrams for the docs.
   All art is rect-grid pixel art (shape-rendering="crispEdges"), authored as
   ASCII sprite maps on a fixed base unit so everything stays on-grid and
   razor sharp at any size. No raster images, no AI-generated assets.
   Palette = the site's design tokens (ink/paper/CRT-green/gold).
   ========================================================================== */

import type { ReactNode } from "react";

const PAL: Record<string, string> = {
  k: "#0c1116", // ink
  K: "#2a333b", // ink-3
  d: "#070b0f", // ink-deep
  p: "#f5f7f8", // paper
  P: "#dfe6ea", // paper-2
  g: "#00c805", // crt green
  G: "#009a39", // green
  o: "#c9a227", // gold
  O: "#8a6f1c", // gold-dark
  y: "#e0c25c", // gold-light
  m: "#93a4b1", // muted-dark
  M: "#5a6b78", // muted
  r: "#ff6b6f", // red
};

type Run = { x: number; y: number; w: number; c: string };

/** Compress an ASCII sprite map into horizontal runs of same-colour pixels. */
function runs(art: readonly string[]): Run[] {
  const out: Run[] = [];
  art.forEach((row, ry) => {
    let cx = 0;
    while (cx < row.length) {
      const ch = row[cx];
      if (PAL[ch]) {
        let end = cx;
        while (end + 1 < row.length && row[end + 1] === ch) end++;
        out.push({ x: cx, y: ry, w: end - cx + 1, c: PAL[ch] });
        cx = end + 1;
      } else {
        cx++;
      }
    }
  });
  return out;
}

function Sprite({
  art,
  x = 0,
  y = 0,
  u = 6,
}: {
  art: readonly string[];
  x?: number;
  y?: number;
  u?: number;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      {runs(art).map((r, i) => (
        <rect key={i} x={r.x * u} y={r.y * u} width={r.w * u} height={u} fill={r.c} />
      ))}
    </g>
  );
}

/** VT323 label inside an SVG scene. */
function L({
  x,
  y,
  children,
  fill = "#00c805",
  anchor = "middle",
  size = 15,
}: {
  x: number;
  y: number;
  children: string;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  size?: number;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={size}
      fill={fill}
      style={{ fontFamily: "var(--font-pixel)", letterSpacing: "0.05em" }}
    >
      {children}
    </text>
  );
}

/** Dotted pixel trail between two x positions (conveyor for the coins). */
function Trail({ x1, x2, y, c = "#8a6f1c" }: { x1: number; x2: number; y: number; c?: string }) {
  const dots = [];
  for (let x = x1; x <= x2 - 6; x += 18) dots.push(<rect key={x} x={x} y={y} width={6} height={6} fill={c} />);
  return <g>{dots}</g>;
}

/** Orthogonal step-line (chart) made of 6px pixel runs. */
function StepLine({ pts, c }: { pts: [number, number][]; c: string }) {
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    if (y1 === y2) segs.push(<rect key={i} x={Math.min(x1, x2)} y={y1} width={Math.abs(x2 - x1) + 6} height={6} fill={c} />);
    else segs.push(<rect key={i} x={x1} y={Math.min(y1, y2)} width={6} height={Math.abs(y2 - y1) + 6} fill={c} />);
  }
  return <g>{segs}</g>;
}

/* ---------------- sprites (every row is width-audited) ---------------- */

const COIN = [
  "..oooo..",
  ".oyyyyo.",
  "oyyppyyo",
  "oyyppyyo",
  "oyyppyyo",
  ".oyyyyo.",
  "..oooo..",
] as const;

const TRADER = [
  "..pppp..",
  "..pppp..",
  "..KKKK..",
  ".KKggKK.",
  ".KKggKK.",
  ".KKKKKK.",
  ".KKKKKK.",
  "..K..K..",
  "..K..K..",
  "..m..m..",
] as const;

const BANK = [
  "......oooo......",
  "....oooooooo....",
  "..pppppppppppp..",
  ".PPPPPPPPPPPPPP.",
  ".pp..pp..pp..pp.",
  ".pp..pp..pp..pp.",
  ".pp..pp..pp..pp.",
  ".pp..pp..pp..pp.",
  ".PPPPPPPPPPPPPP.",
  "pppppppppppppppp",
] as const;

const ROBOT = [
  ".....gg.....",
  ".....gg.....",
  "..mmmmmmmm..",
  "..mggmmggm..",
  "..mmmmmmmm..",
  "..mKKKKKKm..",
  "..mmmmmmmm..",
  "....m..m....",
  "...mm..mm...",
] as const;

const VAULT = [
  "....pppppppp....",
  "..pppppppppppp..",
  ".pppPPPPPPPPppp.",
  ".ppPPkkkkkkPPpp.",
  "pppPkk.gg.kkPppp",
  "pppPk.gggg.kPppp",
  "pppPk.gggg.kPppp",
  "pppPkk.gg.kkPppp",
  ".ppPPkkkkkkPPpp.",
  ".pppPPPPPPPPppp.",
  "..pppppppppppp..",
  "....pppppppp....",
] as const;

const WALLET = [
  "...pp..gg.....",
  "...pp..gg.....",
  ".OOOOOOOOOOOO.",
  "OOOOOOOOOOOOOO",
  "OOOOOOOOOOOOOO",
  "OOOOOOOOOooOOO",
  "OOOOOOOOOooOOO",
  "OOOOOOOOOOOOOO",
  ".OOOOOOOOOOOO.",
] as const;

const FLAME = [
  "...r....",
  "..rrr...",
  ".rrrrr..",
  ".rroor..",
  "rrooorr.",
  "rroooor.",
  ".roooo..",
  "..ooo...",
] as const;

const TILE_G = ["gggg", "gppg", "gppg", "gggg"] as const;
const TILE_O = ["oooo", "oppo", "oppo", "oooo"] as const;
const TILE_P = ["pppp", "pKKp", "pKKp", "pppp"] as const;

const CHEV_R = [
  "g....",
  "gg...",
  ".gg..",
  "..gg.",
  ".gg..",
  "gg...",
  "g....",
] as const;

const CHEV_R_GOLD = [
  "o....",
  "oo...",
  ".oo..",
  "..oo.",
  ".oo..",
  "oo...",
  "o....",
] as const;

const ARROW_UP = [
  "..g..",
  ".ggg.",
  "ggggg",
  "..g..",
  "..g..",
  "..g..",
  "..g..",
] as const;

/* ---------------- figure wrapper ---------------- */

function Fig({
  label,
  caption,
  children,
  viewBox,
}: {
  label: string;
  caption: string;
  children: ReactNode;
  viewBox: string;
}) {
  return (
    <figure className="docs-fig">
      <svg
        viewBox={viewBox}
        role="img"
        aria-label={label}
        shapeRendering="crispEdges"
        preserveAspectRatio="xMidYMid meet"
      >
        {children}
      </svg>
      <figcaption className="docs-fig-cap">{caption}</figcaption>
    </figure>
  );
}

/* ============================ 1 · THE FLYWHEEL ============================ */

export function FlywheelFig() {
  return (
    <Fig
      viewBox="0 0 744 216"
      label="Pixel-art diagram: a trader pays the 1% pool fee on the protocol-owned locked LP; the FeeSplitter splits collected fees 80/15/5; the Accumulator keeper swaps the 80% on Uniswap v3 into stock tokens that land in the vault holding the ~190-token basket."
      caption="FIG. A — THE FLYWHEEL · 1% POOL FEE → SPLIT 80/15/5 → KEEPER BUYS → STOCKS LOCK IN THE VAULT"
    >
      {/* trader */}
      <Sprite art={TRADER} x={18} y={66} />
      <L x={42} y={150}>TRADER</L>

      {/* fee trail + animated coins */}
      <Trail x1={72} x2={150} y={90} />
      <L x={111} y={60} fill="#c9a227">FEE 2%</L>
      <g transform="translate(66 72)"><g className="fw-coin fw-coin-a"><Sprite art={COIN} u={4} /></g></g>
      <g transform="translate(66 72)"><g className="fw-coin fw-coin-b"><Sprite art={COIN} u={4} /></g></g>

      {/* fee splitter */}
      <Sprite art={BANK} x={156} y={66} />
      <L x={204} y={150}>FEESPLITTER</L>

      {/* 15 / 5 side splits */}
      <StepLine pts={[[252, 78], [270, 78], [270, 42], [294, 42]]} c="#5a6b78" />
      <L x={306} y={48} fill="#93a4b1" anchor="start">15% OPS</L>
      <StepLine pts={[[252, 108], [270, 108], [270, 162], [294, 162]]} c="#5a6b78" />
      <L x={306} y={168} fill="#93a4b1" anchor="start">5% LP</L>

      {/* 80% trunk */}
      <Trail x1={258} x2={318} y={90} c="#c9a227" />
      <L x={288} y={78} fill="#c9a227">80%</L>

      {/* accumulator keeper */}
      <Sprite art={ROBOT} x={318} y={66} />
      <L x={354} y={150}>ACCUMULATOR</L>

      {/* swap */}
      <Trail x1={396} x2={432} y={90} />
      <Sprite art={CHEV_R_GOLD} x={438} y={66} u={4} />
      <Sprite art={CHEV_R_GOLD} x={450} y={66} u={4} />
      <Sprite art={CHEV_R} x={438} y={102} u={4} />
      <Sprite art={CHEV_R} x={450} y={102} u={4} />
      <L x={456} y={150}>UNISWAP V3</L>

      {/* bought stock tile travelling to the vault */}
      <g transform="translate(480 84)"><g className="fw-tile"><Sprite art={TILE_G} /></g></g>

      {/* vault + basket */}
      <Sprite art={VAULT} x={540} y={54} />
      <L x={588} y={150}>VAULT</L>
      {[0, 1, 2].map((cx) =>
        [0, 1, 2, 3].map((cy) => (
          <Sprite
            key={`${cx}-${cy}`}
            art={cy < 2 ? TILE_G : cx === 1 && cy === 2 ? TILE_O : TILE_P}
            x={648 + cx * 30}
            y={54 + cy * 30}
          />
        )),
      )}
      <L x={690} y={186} fill="#c9a227">×190 STOCK TOKENS</L>
      <L x={372} y={210} fill="#93a4b1" size={14}>PERMISSIONLESS · KEEPER BOUNTY 0.10% · NO ADMIN CLOCK</L>
    </Fig>
  );
}

/* ======================== 2 · NAV FLOOR ARBITRAGE ======================== */

export function ArbitrageFig() {
  const price: [number, number][] = [
    [48, 54], [144, 54], [144, 72], [228, 72], [228, 108], [318, 108],
    [318, 138], [402, 138], [402, 90], [486, 90], [486, 66], [600, 66], [600, 54], [690, 54],
  ];
  const floorDashes = [];
  for (let x = 48; x <= 672; x += 30) floorDashes.push(<rect key={x} x={x} y={84} width={18} height={6} fill="#c9a227" />);
  const gapDashes = [];
  for (let x = 330; x <= 390; x += 24) gapDashes.push(<rect key={x} x={x} y={96} width={6} height={36} fill="#ff6b6f" />);
  return (
    <Fig
      viewBox="0 0 744 228"
      label="Pixel-art chart: the market price steps down below the gold NAV-per-token floor line; an arbitrageur buys the discount, burns and redeems, and the price snaps back above the floor."
      caption="FIG. B — THE NAV FLOOR · TRADE BELOW NAV AND ARBS BUY, BURN, REDEEM — THE DISCOUNT CLOSES ITSELF"
    >
      {/* axes */}
      <rect x={36} y={18} width={6} height={162} fill="#5a6b78" />
      <rect x={36} y={174} width={660} height={6} fill="#5a6b78" />

      {/* NAV floor */}
      {floorDashes}
      <L x={54} y={78} fill="#c9a227" anchor="start">NAV / TOKEN — THE FLOOR</L>

      {/* discount gap */}
      {gapDashes}
      <L x={360} y={160} fill="#ff6b6f">GAP</L>

      {/* price line */}
      <StepLine pts={price} c="#00c805" />
      <L x={648} y={44} fill="#00c805">$NAV PRICE</L>

      {/* arbitrageur + recovery arrow */}
      <Sprite art={TRADER} x={342} y={114} u={4} />
      <g className="arb-blink"><Sprite art={ARROW_UP} x={402} y={96} u={4} /></g>

      {/* numbered beats */}
      <L x={330} y={132} fill="#f5f7f8">1</L>
      <L x={420} y={84} fill="#f5f7f8">2</L>
      <L x={516} y={60} fill="#f5f7f8">3</L>
      <L x={372} y={216} size={14} fill="#93a4b1">1 BUY BELOW NAV · 2 BURN + REDEEM IN-KIND · 3 GAP CLOSES — MECHANICAL, LIKE ETF ARBITRAGE</L>
    </Fig>
  );
}

/* ========================= 3 · IN-KIND REDEMPTION ======================== */

export function RedemptionFig() {
  const fan: { x: number; y: number; art: readonly string[] }[] = [
    { x: 252, y: 48, art: TILE_G }, { x: 252, y: 84, art: TILE_P }, { x: 252, y: 120, art: TILE_O },
    { x: 300, y: 36, art: TILE_P }, { x: 300, y: 84, art: TILE_G }, { x: 300, y: 132, art: TILE_P },
    { x: 348, y: 24, art: TILE_O }, { x: 348, y: 84, art: TILE_P }, { x: 348, y: 144, art: TILE_G },
  ];
  return (
    <Fig
      viewBox="0 0 744 204"
      label="Pixel-art diagram: one $NAV coin burns in a pixel flame and fans out into many small stock-token tiles that fly into a pixel wallet; a 0.5% sliver stays behind in the vault."
      caption="FIG. C — IN-KIND REDEMPTION · BURN ONE $NAV, RECEIVE YOUR SLICE OF EVERY POSITION. 0.5% STAYS FOR HOLDERS"
    >
      {/* the burning $NAV coin */}
      <Sprite art={COIN} x={36} y={30} u={12} />
      <g className="flame-flicker"><Sprite art={FLAME} x={24} y={102} /></g>
      <L x={84} y={168} fill="#c9a227">1 × $NAV</L>
      <L x={84} y={186} fill="#ff6b6f">BURNED</L>

      {/* burn → fan */}
      <Sprite art={CHEV_R} x={174} y={70} u={4} />
      <Sprite art={CHEV_R} x={186} y={70} u={4} />

      {/* fan of stock tiles */}
      {fan.map((t, i) => (
        <Sprite key={i} art={t.art} x={t.x} y={t.y} />
      ))}
      <L x={312} y={186} fill="#f5f7f8" size={14}>PRO-RATA SLICE OF ALL ~190 POSITIONS</L>

      {/* fan → wallet */}
      <Sprite art={CHEV_R} x={420} y={70} u={4} />
      <Sprite art={CHEV_R} x={432} y={70} u={4} />

      {/* wallet */}
      <Sprite art={WALLET} x={492} y={48} u={8} />
      <L x={548} y={156} fill="#00c805">YOUR WALLET</L>
      <L x={660} y={186} fill="#c9a227" size={14}>0.5% EXIT FEE → VAULT</L>
    </Fig>
  );
}

/* =========================== 4 · REGISTRY GROWS ========================== */

export function RegistryFig() {
  const grid = [];
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === 6 && j === 2) continue; // empty slot — the new tile drops here
      grid.push(
        <Sprite key={`${i}-${j}`} art={j === 0 ? TILE_G : j === 1 ? TILE_P : i % 3 === 0 ? TILE_O : TILE_P} x={246 + i * 36} y={66 + j * 36} />,
      );
    }
  }
  return (
    <Fig
      viewBox="0 0 744 204"
      label="Pixel-art diagram: a vault grid of stock tiles with one empty slot; a new green tile drops into the slot as governance calls addAsset, growing the registry."
      caption="FIG. D — THE REGISTRY GROWS · NEW LISTING → addAsset() → JOINS THE ROTATION IMMEDIATELY"
    >
      {/* vault frame */}
      <rect x={228} y={48} width={288} height={6} fill="#f5f7f8" />
      <rect x={228} y={162} width={288} height={6} fill="#f5f7f8" />
      <rect x={228} y={48} width={6} height={120} fill="#f5f7f8" />
      <rect x={510} y={48} width={6} height={120} fill="#f5f7f8" />
      {grid}

      {/* empty slot outline */}
      {[[462, 138], [480, 138], [462, 156], [480, 156]].map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={6} height={6} fill="#2a333b" />
      ))}

      {/* the dropping tile */}
      <g transform="translate(462 138)"><g className="reg-drop"><Sprite art={TILE_G} /></g></g>
      <L x={474} y={36} fill="#00c805">addAsset(NEW)</L>

      {/* left + bottom copy */}
      <L x={24} y={90} fill="#f5f7f8" anchor="start">ROBINHOOD LISTS</L>
      <L x={24} y={108} fill="#f5f7f8" anchor="start">A NEW STOCK ─►</L>
      <L x={24} y={138} fill="#93a4b1" anchor="start" size={14}>DELISTED? PAUSED WITH</L>
      <L x={24} y={156} fill="#93a4b1" anchor="start" size={14}>setAssetActive(FALSE)</L>
      <L x={558} y={90} fill="#c9a227" anchor="start">REGISTRY: ~190</L>
      <L x={558} y={108} fill="#c9a227" anchor="start">AND GROWING</L>
      <L x={372} y={192} fill="#93a4b1" size={14}>THE ROTATION PICKS UP NEW ASSETS AUTOMATICALLY — SHORTFALL-WEIGHTED, SELF-BALANCING</L>
    </Fig>
  );
}
