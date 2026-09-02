import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";

/* ------------------------------------------------------------------ */
/* Motion primitives — broadsheet × terminal.                          */
/* Scroll-reveal + numeric count-up, both honoring                     */
/* prefers-reduced-motion (the CSS side no-ops the transforms and      */
/* CountUp renders the final value immediately).                       */
/* ------------------------------------------------------------------ */

const reduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Fade-and-rise on first scroll into view. `delay` staggers siblings (ms). */
export function Reveal({
  children,
  delay = 0,
  as: Tag = "div",
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  as?: "div" | "section" | "span" | "li" | "p";
  className?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced()) {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ref={ref as any}
      className={`reveal ${inView ? "in" : ""} ${className}`}
      style={{ "--rv-delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </Tag>
  );
}

/** Counts from 0 to `value` in stepped increments when scrolled into view.
    Stepped (not smooth) on purpose — split-flap board, not spreadsheet. */
export function CountUp({
  value,
  duration = 900,
  format = (v: number) => Math.round(v).toLocaleString("en-US"),
}: {
  value: number;
  duration?: number;
  format?: (v: number) => string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [display, setDisplay] = useState(() => (reduced() ? format(value) : format(0)));
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || done.current) return;
    if (reduced()) {
      setDisplay(format(value));
      return;
    }
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || done.current) return;
      done.current = true;
      io.disconnect();
      const steps = 12;
      let i = 0;
      const t = setInterval(() => {
        i++;
        setDisplay(format((value * i) / steps));
        if (i >= steps) clearInterval(t);
      }, duration / steps);
    });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <span ref={ref} className="num">
      {display}
    </span>
  );
}

/** Small pulsing LED for live panels. Color via CSS (--led). */
export function Led({ tone = "crt" }: { tone?: "crt" | "gold" | "red" | "amber" }) {
  return <span className={`led led-${tone}`} aria-hidden="true" />;
}
