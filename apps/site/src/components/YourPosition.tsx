/* NAV — nav.fun · connected wallet's own position in the vault.
   Live reads only: $NAV balance, share of supply, and the pro-rata claim
   across every vault holding. Zero-balance states render honestly. */
import { useEffect, useRef, useState } from "react";
import { erc20Abi, publicClient } from "../lib/chain";
import { PROTOCOL } from "../lib/protocol";
import { useWallet } from "../lib/wallet";
import { fmt } from "../lib/format";

interface Pos {
  nav: bigint; // user $NAV balance (18 dec)
  supply: bigint; // total supply (18 dec)
}

export function YourPosition() {
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
      } catch {
        /* keep previous state; next poll retries */
      }
    };
    void pull();
    const t = setInterval(pull, 30_000);
    return () => clearInterval(t);
  }, [w.status, w.account]);

  if (w.status !== "connected") {
    return (
      <section className="panel mb-6">
        <div className="panel-head">
          <span className="px-label">YOUR POSITION</span>
        </div>
        <div className="p-4.5 text-[13px] text-muted-dark">
          Connect a wallet to see your $NAV balance, share of supply, and your pro-rata claim on
          every asset in the vault.
        </div>
      </section>
    );
  }

  const navF = pos ? Number(pos.nav) / 1e18 : null;
  const sharePct = pos && pos.supply > 0n ? (Number(pos.nav) / Number(pos.supply)) * 100 : null;

  return (
    <section className="panel mb-6">
      <div className="panel-head">
        <span className="px-label">YOUR POSITION</span>
        <span className="num text-[12.5px] text-muted-dark">live · 30s refresh</span>
      </div>
      <div className="grid grid-cols-1 gap-px bg-ink-3 sm:grid-cols-3">
        <div className="bg-ink p-4.5">
          <div className="text-[11.5px] tracking-wide text-muted-dark">$NAV BALANCE</div>
          <div className="num mt-1 text-[22px] text-paper">
            {navF !== null ? fmt.num(navF) : "…"}
          </div>
        </div>
        <div className="bg-ink p-4.5">
          <div className="text-[11.5px] tracking-wide text-muted-dark">SHARE OF SUPPLY</div>
          <div className="num mt-1 text-[22px] text-paper">
            {sharePct !== null ? `${sharePct.toFixed(4)}%` : "…"}
          </div>
        </div>
        <div className="bg-ink p-4.5">
          <div className="text-[11.5px] tracking-wide text-muted-dark">REDEEMABLE</div>
          <div className="num mt-1 text-[22px] text-paper">
            {navF !== null && navF === 0 ? "—" : "pro-rata slice"}
          </div>
          <div className="text-[11.5px] text-muted-dark">
            Burn $NAV → your share of every vault asset, in kind (0.5% exit fee stays in the vault).
          </div>
        </div>
      </div>
    </section>
  );
}
