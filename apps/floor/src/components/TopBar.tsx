import { useEffect, useState } from "react";
import { Logo } from "./Logo";
import { useWallet, requestConnect, disconnectWallet, ensureChain } from "../lib/wallet";
import { shortAddr } from "../lib/chain";

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const utc = now.toISOString().slice(11, 19);
  return (
    <span className="text-txt-dim text-[11px] tracking-wider" aria-label="UTC time">
      {now.toISOString().slice(0, 10)} <span className="text-txt">{utc}</span> UTC
    </span>
  );
}

export function TopBar({ block }: { block: bigint }) {
  const w = useWallet();
  return (
    <header className="flex items-center gap-3 px-2 h-9 border-b border-rule bg-panel select-none">
      <span className="flex items-center gap-2 text-amber">
        <Logo size={17} />
        <span className="font-bold tracking-[0.22em] text-[14px]">FLOOR</span>
      </span>
      <span className="text-amber-dim text-[10.5px] tracking-widest hidden sm:inline">ON-CHAIN STOCK TERMINAL</span>
      <span className="text-txt-dim text-[10.5px] tracking-widest hidden md:inline">ROBINHOOD CHAIN 4663</span>
      <span className="flex-1" />
      <span className="text-[11px] text-txt-dim hidden sm:inline" aria-label="latest block">
        BLK <span className="text-cyan">{block > 0n ? block.toString() : "———"}</span>
      </span>
      <Clock />
      {(w.status === "connected" || w.status === "wrong-chain") && w.account ? (
        <span className="flex items-center gap-1">
          {w.status === "wrong-chain" && (
            <button className="fkey !text-dn" onClick={() => void ensureChain()}>WRONG CHAIN</button>
          )}
          <button className="fkey" onClick={disconnectWallet} title="disconnect">
            {shortAddr(w.account)} ×
          </button>
        </span>
      ) : (
        <button className="fkey" onClick={requestConnect} disabled={w.status === "connecting"}>
          {w.status === "connecting" ? "CONNECTING…" : "CONNECT"}
        </button>
      )}
    </header>
  );
}
