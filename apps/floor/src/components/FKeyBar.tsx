/* Function-key strip — classic terminal chrome, doubles as the site footer.
   F1–F5 switch the active view (real keydown too — B-25); the rest are links. */
import { useEffect } from "react";
import { EXPLORER } from "../lib/chain";
import type { FloorView } from "../App";

const VIEWS: { k: string; view: FloorView }[] = [
  { k: "F1", view: "SWAP" },
  { k: "F2", view: "DERIVS" },
  { k: "F3", view: "VAULT" },
  { k: "F4", view: "CREDIT" },
  { k: "F5", view: "STATS" },
];

const LINKS: { k: string; label: string; href: string }[] = [
  { k: "F6", label: "NAV.FUN", href: "https://nav.fun" },
  { k: "F7", label: "DOCS", href: "https://nav.fun/#/docs" },
  { k: "F8", label: "EXPLORER", href: EXPLORER },
];

export function FKeyBar({ view, setView }: { view: FloorView; setView: (v: FloorView) => void }) {
  /* B-25: the strip advertises F-keys — honour the physical keys as well.
     Only unmodified F1–F5 are claimed; browser shortcuts stay untouched. */
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
          className={`fkey flex-1 text-center min-w-[90px] ${view === v ? "!border-amber !text-amber-2" : ""}`}
          aria-pressed={view === v} onClick={() => setView(v)}>
          <span className="text-amber-dim">{k}</span> {v}
        </button>
      ))}
      {LINKS.map(({ k, label, href }) => (
        <a key={k} href={href} target={href.startsWith("http") ? "_blank" : undefined}
          rel="noopener noreferrer" className="fkey no-underline flex-1 text-center min-w-[90px]">
          <span className="text-amber-dim">{k}</span> {label}
        </a>
      ))}
      <span className="fkey flex-[2] text-center min-w-[220px] !cursor-default !text-txt-dim">
        FLOOR © 2026 · A NAV.FUN PRODUCT · NOT INVESTMENT ADVICE · TOKENIZED STOCKS ARE NOT EQUITIES
      </span>
    </footer>
  );
}
