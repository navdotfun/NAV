interface LogoProps {
  size?: number;
  field?: string; // pixel-field color behind the stairs
  withWordmark?: boolean;
  wordColor?: string;
}

/** NAV pixel-grid vault mark: CRT-green staircase (the NAV line), one gold "up" pixel. */
export function LogoMark({ size = 34, field = "#101418" }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      shapeRendering="crispEdges"
      role="img"
      aria-label="NAV pixel vault mark"
    >
      <rect width="10" height="10" fill={field} />
      <rect x="2" y="7" width="2" height="1" fill="#00c805" />
      <rect x="3" y="6" width="2" height="1" fill="#00c805" />
      <rect x="4" y="5" width="2" height="1" fill="#00c805" />
      <rect x="5" y="4" width="2" height="1" fill="#00c805" />
      <rect x="6" y="3" width="2" height="1" fill="#00c805" />
      <rect x="7" y="2" width="1" height="1" fill="#c9a227" />
    </svg>
  );
}

export function Wordmark({ color }: { color?: string }) {
  return (
    <span className="brand-word" style={color ? { color } : undefined}>
      NAV<span className="fun">.fun</span>
    </span>
  );
}
