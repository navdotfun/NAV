/* Measure a container's rendered width so SVG charts draw pixel-crisp at 1:1. */
import { useEffect, useRef, useState } from "react";

export function useWidth<T extends HTMLElement>(): { ref: React.MutableRefObject<T | null>; width: number } {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return { ref, width };
}

/** Spread label y-positions at least `gap` apart inside [min,max] (keeps order). */
export function spreadLabels(ys: number[], gap: number, min: number, max: number): number[] {
  const idx = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < idx.length; k++) {
    if (idx[k].y - idx[k - 1].y < gap) idx[k].y = idx[k - 1].y + gap;
  }
  const over = idx.length > 0 ? idx[idx.length - 1].y - max : 0;
  if (over > 0) for (const e of idx) e.y -= over;
  for (const e of idx) e.y = Math.max(e.y, min);
  for (let k = 1; k < idx.length; k++) {
    if (idx[k].y - idx[k - 1].y < gap) idx[k].y = idx[k - 1].y + gap;
  }
  const out = new Array<number>(ys.length);
  for (const e of idx) out[e.i] = e.y;
  return out;
}
