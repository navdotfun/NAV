/* Function-key strip — classic terminal chrome, doubles as the site footer.
   Only WORLD and STATS render as tabs: every venue is entered through the
   F1 WORLD map (each shows ← MAP), exactly like the Colosseum and the
   Kingdoms. The full F1–F6 keymap is kept as invisible deep-links (B-25)
   so keyboard traders still teleport straight to a venue. R5-01: F1–F6 are
   DELIBERATELY claimed from the browser (F1 help, F5 reload) — the terminal
   is F-key native and every venue advertises its key in the venue bar. The
   keymap is ignored while a modal dialog (wallet picker) is open. */
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

/** The only views that render as visible tabs — the rest live on the map. */
const TABS: FloorView[] = ["WORLD", "STATS"];

export function FKeyBar({ view, setView }: { view: FloorView; setView: (v: FloorView) => void }) {
  /* B-25: the strip advertises F-keys — honour the physical keys as well.
     Only unmodified F1–F6 are claimed; browser shortcuts stay untouched. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (document.querySelector('[aria-modal="true"]')) return; // R5: dialog owns the keyboard
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
      {VIEWS.filter(({ view: v }) => TABS.includes(v)).map(({ k, view: v }) => (
        <button key={k} type="button"
          className={`fkey flex-1 text-center min-w-[90px] max-w-[220px] ${(v === "WORLD" ? view !== "STATS" : view === v) ? "!border-amber !text-amber-2" : ""}`}
          aria-current={(v === "WORLD" ? view !== "STATS" : view === v) ? "true" : undefined} onClick={() => setView(v)}>
          <span className="text-amber-dim">{k}</span> {v}
        </button>
      ))}
      <span className="fkey flex-[2] text-center min-w-[220px] !cursor-default !text-txt-dim">
        FLOOR © 2026 · A NAV.FUN PRODUCT · NOT INVESTMENT ADVICE · TOKENIZED STOCKS ARE NOT EQUITIES
      </span>
    </footer>
  );
}
