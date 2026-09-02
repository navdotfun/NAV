/* Terminal-styled wallet picker — listens for the `nav:open-wallet-picker`
   event fired by requestConnect() in lib/wallet.ts. */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useWallet, connectWallet, ensureChain, disconnectWallet, isMobileUA, mobileWalletLinks } from "../lib/wallet";
import { shortAddr } from "../lib/chain";

export function WalletPicker() {
  const [open, setOpen] = useState(false);
  const w = useWallet();

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("nav:open-wallet-picker", show);
    return () => window.removeEventListener("nav:open-wallet-picker", show);
  }, []);

  useEffect(() => {
    if (w.status === "connected") setOpen(false);
  }, [w.status]);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  if (!open) return null;

  const mobile = isMobileUA();
  const hasInjected = w.wallets.some((x) => x.kind === "injected");

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
      role="dialog" aria-modal="true" aria-label="connect wallet"
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="panel w-full max-w-sm">
        <div className="panel-title">
          <span>CONNECT · SELECT WALLET</span>
          <button className="text-cyan text-[13px] hover:text-amber-2" onClick={() => setOpen(false)} aria-label="close">×</button>
        </div>
        {w.status === "wrong-chain" && w.account ? (
          <div className="p-2 flex flex-col gap-[6px]">
            <p className="text-[11.5px] text-txt p-1">
              <span className="text-dn font-bold">WRONG NETWORK.</span>{" "}
              {shortAddr(w.account)} IS CONNECTED{w.chainId !== null ? ` TO CHAIN ${w.chainId}` : ""} — FLOOR RUNS ON ROBINHOOD CHAIN (4663).
            </p>
            <button className="btn-exec !py-2.5" onClick={() => void ensureChain()}>
              SWITCH TO ROBINHOOD CHAIN
            </button>
            <p className="text-[10.5px] text-txt-dim p-1">
              IF NOTHING HAPPENS, YOUR WALLET CANNOT SWITCH AUTOMATICALLY.
              PHANTOM: UPDATE THE APP, THEN SETTINGS → ACTIVE NETWORKS → ENABLE ROBINHOOD
              CHAIN, AND RETRY. OTHER WALLETS: ADD CHAIN 4663 (RPC
              RPC.MAINNET.CHAIN.ROBINHOOD.COM) OR USE METAMASK.
            </p>
            <button className="fkey !py-2" onClick={disconnectWallet}>DISCONNECT</button>
          </div>
        ) : (
        <div className="p-2 flex flex-col gap-[2px]">
          {w.wallets.map((x) => (
            <button key={x.rdns} className="fkey !py-2.5 flex items-center gap-2 text-left"
              onClick={() => void connectWallet(x.rdns)}>
              <img src={x.icon} alt="" width={18} height={18} />
              <span className="flex-1">{x.name.toUpperCase()}</span>
              <span className="text-txt-dim text-[10px]">
                {x.kind === "injected" ? "DETECTED" : x.kind === "coinbase" ? "QR / APP" : "WALLETCONNECT"}
              </span>
            </button>
          ))}
          {w.wallets.length === 0 && (
            <p className="text-[11.5px] text-txt-dim p-2">
              NO WALLET DETECTED.
              {mobile ? " OPEN FLOOR.NAV.FUN INSIDE YOUR WALLET'S BROWSER:" : " INSTALL A WALLET EXTENSION AND RELOAD."}
            </p>
          )}
          {mobile && !hasInjected && mobileWalletLinks().map((l) => (
            <a key={l.name} href={l.href} className="fkey !py-2.5 no-underline text-center">{l.name.toUpperCase()}</a>
          ))}
        </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
