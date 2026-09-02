/* FLOOR mark — octagonal trading pit, viewed from above: concentric steps
   descending to the point of execution. Geometric, monochrome, currentColor. */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="FLOOR" role="img">
      <path d="M7.5 1.5h9l6 6v9l-6 6h-9l-6-6v-9l6-6z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 5.5h6l3.5 3.5v6L15 18.5H9L5.5 15V9L9 5.5z" stroke="currentColor" strokeWidth="1.2" opacity="0.7" />
      <rect x="10.4" y="10.4" width="3.2" height="3.2" fill="currentColor" />
    </svg>
  );
}
