/* VAULT — connected wallet's own $NAV position. Live reads only. */
import { useEffect, useRef, useState } from "react";
import { erc20Abi, publicClient } from "../../lib/chain";
import { PROTOCOL } from "../../lib/nav/protocol";
import { useWallet } from "../../lib/wallet";
import { fmt } from "../../lib/format";

interface Pos { nav: bigint; supply: bigint }

export function YourPositionStrip() {
  const w = useWallet();
  const [pos, setPos] = useState<Pos | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (w.status !== "connected" || !w.account || !PROTOCOL.tokenAddress) {
      setPos(null);
      return;
    }
    const my = ++seq.current;
    const pull = async () => {
      try {
        const [nav, supply] = await Promise.all([
          publicClient.readContract({
            address: PROTOCOL.tokenAddress!, abi: erc20Abi, functionName: "balanceOf", args: [w.account!],
          }) as Promise<bigint>,
          publicClient.readContract({
            address: PROTOCOL.tokenAddress!, abi: erc20Abi, functionName: "totalSupply",
          }) as Promise<bigint>,
        ]);
        if (seq.current === my) setPos({ nav, supply });
      } catch { /* next poll retries */ }
    };
    void pull();
    const t = setInterval(pull, 30_000);
    return () => clearInterval(t);
  }, [w.status, w.account]);

  const navF = pos ? Number(pos.nav) / 1e18 : null;
  const sharePct = pos && pos.supply > 0n ? (Number(pos.nav) / Number(pos.supply)) * 100 : null;

  return (
    <section className="panel" aria-label="your position">
      <div className="panel-title">
        <span>YOUR POSITION</span>
        <span className="text-txt-dim normal-case tracking-normal">LIVE · 30S</span>
      </div>
      {w.status !== "connected" ? (
        <div className="px-2.5 py-2 text-[11px] text-txt-dim">
          CONNECT A WALLET TO SEE YOUR $NAV BALANCE, SHARE OF SUPPLY AND PRO-RATA CLAIM.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-px bg-rule">
          <div className="bg-panel px-2.5 py-2">
            <div className="cell-label">$NAV BALANCE</div>
            <div className="text-[14px] text-amber-2 tabular-nums">{navF !== null ? fmt.num(navF) : "…"}</div>
          </div>
          <div className="bg-panel px-2.5 py-2">
            <div className="cell-label">SHARE OF SUPPLY</div>
            <div className="text-[14px] text-txt tabular-nums">{sharePct !== null ? `${sharePct.toFixed(4)}%` : "…"}</div>
          </div>
        </div>
      )}
    </section>
  );
}
