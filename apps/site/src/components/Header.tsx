import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LogoMark, Wordmark } from "./Logo";

export interface NavLinkItem {
  label: string;
  to: string;        // route path or hash link
  hash?: boolean;    // plain anchor (same-page hash)
  pill?: string;     // small VT323 gold badge after the label (e.g. "SOON")
  external?: boolean; // plain <a> — leaves the SPA (e.g. the Floor terminal)
  glow?: boolean;    // illuminated amber phosphor treatment
}

interface HeaderProps {
  dark?: boolean;
  links: NavLinkItem[];
  action: ReactNode; // CTA button (Launch App / Connect Wallet)
}

export function Header({ dark = false, links, action }: HeaderProps) {
  const [open, setOpen] = useState(false);
  return (
    <header className="site-header" style={dark ? { background: "rgba(12,17,22,0.92)", borderBottom: "1px solid #242c34" } : undefined}>
      <div className="wrap flex h-[68px] items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-3 no-underline" aria-label="NAV — nav.fun home" style={{ color: dark ? "#f5f7f8" : "inherit" }}>
          <LogoMark field={dark ? "#14191f" : "#101418"} />
          <Wordmark />
        </Link>
        <nav
          className={`main-nav ${open ? "open" : ""} ${dark ? "dark-drawer" : ""}`}
          aria-label="Main"
          style={{ color: dark ? "#f5f7f8" : "#101418" }}
        >
          {links.map((l) =>
            l.external ? (
              <a key={l.label} href={l.to} className={l.glow ? "nav-glow" : undefined} onClick={() => setOpen(false)}>
                {l.label}
                {l.pill ? <span className="nav-pill">{l.pill}</span> : null}
              </a>
            ) : (
              <Link key={l.label} to={l.to} onClick={() => setOpen(false)}>
                {l.label}
                {l.pill ? <span className="nav-pill">{l.pill}</span> : null}
              </Link>
            ),
          )}
          {action}
        </nav>
        <button className="nav-toggle md:hidden" aria-label="Toggle menu" onClick={() => setOpen(!open)}>
          MENU
        </button>
      </div>
    </header>
  );
}
