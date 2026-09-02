/* Function-key strip — classic terminal chrome, doubles as the site footer.
   F1 is the WORLD hub — the map routes to every venue; F2–F6 jump straight
   to a venue (real keydown too — B-25). ARENA and INDEX are reached through
   the F1 WORLD map (each has ← MAP). */
import { useEffect } from "react";
import type { FloorView } from "../App";

const VIEWS: { k: string; view: FloorView }[] = [
  { k: "F1", view: "WORLD" },
  { k: "F2", view: "SWAP" },
  { k: "F3", view: "DERIVS" },
  { k: "F4", view: "VAULT" },
  { k: "F5", view: "CREDIT" },
  { k: "F6", view: "STATS" },
];

export function FKeyBar({ view, setView }: { view: FloorView; setView: (v: FloorView) => void }) {
  /* B-25: the strip advertises F-keys — honour the physical keys as well.
     Only unmodified F1–F6 are claimed; browser shortcuts stay untouched. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const hit = VIEWS.find((v) => v.k === e.key);
      if (!hit) return;
      e.preventDefault();
      setView(hit.view);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  return (
    <footer className="flex items-center gap-[2px] px-[2px] pb-[2px] select-none flex-wrap">
      {VIEWS.map(({ k, view: v }) => (
        <button key={k} type="button"
          className={`fkey flex-1 text-center min-w-[90px] ${view === v || (v === "WORLD" && (view === "ARENA" || view === "INDEX")) ? "!border-amber !text-amber-2" : ""}`}
          aria-pressed={view === v} onClick={() => setView(v)}>
          <span className="text-amber-dim">{k}</span> {v}
        </button>
      ))}
      <span className="fkey flex-[2] text-center min-w-[220px] !cursor-default !text-txt-dim">
        FLOOR © 2026 · A NAV.FUN PRODUCT · NOT INVESTMENT ADVICE · TOKENIZED STOCKS ARE NOT EQUITIES
      </span>
    </footer>
  );
}
