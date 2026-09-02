/* NAV — nav.fun · wallet connect control. One component for the Vault
   terminal and The Pit: full Connect Wallet modal with every connectivity
   level always visible — browser wallets (EIP-6963 injected), Coinbase
   Wallet SDK, WalletConnect when configured, and mobile deep links into
   wallet in-app browsers — plus a connected chip with chain state and an
   explicit DISCONNECT. */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  connectWallet,
  disconnectWallet,
  ensureChain,
  isMobileUA,
  mobileWalletLinks,
  useWallet,
} from "../lib/wallet";

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState<"picker" | "menu" | null>(null);
  const [err, setErr] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  /* Panels dispatch this when requestConnect() needs the user to pick a
     wallet — open our picker so there is exactly one picker UI (M-04). */
  useEffect(() => {
    const openPicker = () => setOpen("picker");
    window.addEventListener("nav:open-wallet-picker", openPicker);
    return () => window.removeEventListener("nav:open-wallet-picker", openPicker);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (pickerRef.current?.contains(t)) return;
      setOpen(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  /* ---- connected chip + menu ---- */
  if (w.status === "connected" || w.status === "wrong-chain") {
    return (
      <div className="relative" ref={ref}>
        <button
          className="btn flex items-center gap-2 !px-3.5 !py-2 text-[13px]"
          onClick={() => setOpen(open === "menu" ? null : "menu")}
          aria-haspopup="menu"
          aria-expanded={open === "menu"}
        >
          <span
            className={`inline-block h-2 w-2 ${w.status === "connected" ? "bg-crt" : "bg-gold"}`}
            aria-hidden
          />
          <span className="num">{w.account ? shortAddr(w.account) : "—"}</span>
        </button>
        {open === "menu" && (
          <div role="menu" className="absolute right-0 z-50 mt-1.5 w-56 border border-ink-3 bg-ink p-1.5 shadow-xl">
            {w.status === "wrong-chain" && (
              <button
                role="menuitem"
                className="block w-full px-3 py-2.5 text-left text-[12.5px] text-gold hover:bg-ink-2"
                onClick={() => {
                  setOpen(null);
                  void ensureChain();
                }}
              >
                SWITCH TO ROBINHOOD CHAIN
              </button>
            )}
            <a
              role="menuitem"
              className="block w-full px-3 py-2.5 text-left text-[12.5px] text-paper hover:bg-ink-2"
              href={`https://robinhoodchain.blockscout.com/address/${w.account}`}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(null)}
            >
              View on Blockscout ↗
            </a>
            <button
              role="menuitem"
              className="block w-full px-3 py-2.5 text-left text-[12.5px] text-red hover:bg-ink-2"
              onClick={() => {
                setOpen(null);
                disconnectWallet();
              }}
            >
              DISCONNECT
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ---- disconnected: connect button + full-levels modal ---- */
  const injected = w.wallets.filter((x) => x.kind === "injected");
  const sdk = w.wallets.filter((x) => x.kind !== "injected");
  const mobile = isMobileUA();

  const rowCls =
    "flex w-full items-center gap-2.5 border border-ink-3 px-3.5 py-3 text-left text-[13px] tracking-wide text-crt hover:border-crt/60 hover:bg-ink-2";
  const tagCls = "ml-auto text-[10.5px] tracking-widest text-muted-dark";

  return (
    <div className="relative" ref={ref}>
      <button
        className="btn btn-primary !px-3.5 !py-2 text-[13px]"
        onClick={() => {
          setErr(false);
          setOpen(open === "picker" ? null : "picker");
        }}
        disabled={w.status === "connecting"}
      >
        {w.status === "connecting" ? "AWAITING WALLET…" : "CONNECT WALLET"}
      </button>
      {open === "picker" &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 px-3 py-10 sm:items-center">
            <div
              ref={pickerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Connect Wallet"
              className="w-full max-w-md border border-crt/40 bg-ink p-5 shadow-2xl"
            >
              {/* header */}
              <div className="flex items-center justify-between">
                <div className="text-[17px] font-bold text-paper">Connect Wallet</div>
                <button
                  aria-label="Close"
                  className="px-2 py-1 text-[15px] text-muted-dark hover:text-paper"
                  onClick={() => setOpen(null)}
                >
                  ✕
                </button>
              </div>
              <div className="mt-2 text-[12.5px] leading-relaxed text-muted-dark">
                Connect to <span className="text-crt">Robinhood Chain</span>{" "}
                <span className="num">(id 4663)</span> to mint, redeem and trade The Pit.
              </div>

              {/* level 1 — browser wallets (always visible) */}
              <div className="mt-4 grid gap-1.5">
                {injected.length > 0 ? (
                  injected.map((x) => {
                    // FP-M01: when two providers announce the same display name,
                    // the name alone cannot identify which is genuine. Show the
                    // rdns on every ambiguous row so a cloned wallet is visible.
                    const ambiguous =
                      injected.filter((y) => y.name.toLowerCase() === x.name.toLowerCase()).length > 1;
                    return (
                      <button
                        key={x.rdns}
                        className={rowCls}
                        title={x.rdns}
                        onClick={() => {
                          setOpen(null);
                          void connectWallet(x.rdns);
                        }}
                      >
                        {x.icon ? (
                          <img src={x.icon} alt="" className="h-5 w-5 shrink-0" />
                        ) : (
                          <span className="h-5 w-5 shrink-0 rounded-sm border border-hair" aria-hidden="true" />
                        )}
                        <span className="truncate">{x.name.toUpperCase()}</span>
                        <span className={tagCls}>INJECTED</span>
                        {ambiguous && (
                          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-dark" title={x.rdns}>
                            {x.rdns}
                          </span>
                        )}
                      </button>
                    );
                  })
                ) : (
                  <button className={rowCls} onClick={() => setErr(true)}>
                    BROWSER WALLET
                    <span className={tagCls}>INJECTED</span>
                  </button>
                )}

                {/* level 2 — SDK connectors (Coinbase always; WalletConnect when configured) */}
                {sdk.map((x) => (
                  <button
                    key={x.rdns}
                    className={rowCls}
                    onClick={() => {
                      setOpen(null);
                      void connectWallet(x.rdns);
                    }}
                  >
                    <img src={x.icon} alt="" className="h-5 w-5" />
                    {x.name.toUpperCase()}
                    <span className={tagCls}>{x.kind === "coinbase" ? "COINBASE" : "WALLETCONNECT"}</span>
                  </button>
                ))}
              </div>

              {err && injected.length === 0 && (
                <div className="mt-3 text-[12.5px] leading-relaxed text-red">
                  No browser wallet detected. Install Phantom, MetaMask or Rabby, then retry.
                </div>
              )}

              {/* level 3 — mobile deep links (always on phones) */}
              {mobile && (
                <>
                  <div className="mt-5 border-t border-ink-3 pt-4 text-[11.5px] tracking-widest text-gold">
                    :: ON A PHONE — OR OPEN THIS PAGE INSIDE YOUR WALLET
                  </div>
                  <div className="mt-2 text-[12.5px] leading-relaxed text-muted-dark">
                    A mobile browser has no wallet built in. These reopen nav.fun in the wallet's own
                    browser, where connecting works normally.
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-1.5">
                    {mobileWalletLinks().map((l) => (
                      <a key={l.name} className={`${rowCls} !px-3 !py-2.5 text-[12px]`} href={l.href}>
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center text-[11px] font-bold"
                          style={{ background: l.color, color: l.fg }}
                          aria-hidden
                        >
                          {l.name[0]}
                        </span>
                        {l.name}
                      </a>
                    ))}
                  </div>
                </>
              )}

              <div className="mt-5 text-center text-[11px] tracking-widest text-muted-dark">
                PHANTOM CARRIES ROBINHOOD CHAIN NATIVELY
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
