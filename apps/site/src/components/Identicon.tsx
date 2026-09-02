import { navHash } from "../lib/data";

const COLORS = ["#00c805", "#009a39", "#c9a227", "#aeb9c2", "#242c34"] as const;

/** 4x4 mirrored pixel identicon, unique per ticker, brand hues only. */
export function Identicon({ t }: { t: string }) {
  const h = navHash(t);
  const cells: React.ReactNode[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 2; x++) {
      const on = (h >> (y * 2 + x)) & 1;
      if (on) {
        const c = COLORS[(h >> (8 + y * 2 + x)) % COLORS.length];
        cells.push(<rect key={`${x}-${y}a`} x={x} y={y} width={1} height={1} fill={c} />);
        cells.push(<rect key={`${x}-${y}b`} x={3 - x} y={y} width={1} height={1} fill={c} />);
      }
    }
  }
  return (
    <svg className="tk-icon" viewBox="0 0 4 4" shapeRendering="crispEdges" aria-hidden="true">
      <rect width="4" height="4" fill="#101418" />
      {cells}
    </svg>
  );
}
