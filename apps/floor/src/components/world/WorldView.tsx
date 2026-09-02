/* WORLD — the FLOOR game map. A pixel-art overworld where every location
   is a live protocol venue: the Bazaar is the swap desk, the Bank is
   credit, the Treasury is the vault, the Mage Tower is options, the
   Colosseum is the arena and the Kingdoms are the index factory.
   Pure navigation — no protocol data is duplicated here. */
import { useEffect, useState } from "react";
import type { FloorView } from "../../App";
import { useWallet } from "../../lib/wallet";
import { publicClient, erc20Abi, TOKENS } from "../../lib/chain";
import { PROTOCOL } from "../../lib/nav/protocol";
import { ARENA_ADDRESS, INDEX_FACTORY } from "../../lib/deployments";
import type { Address } from "viem";
import { formatUnits } from "viem";

interface Spot {
  id: string;
  label: string;
  desc: string;
  view: FloorView;
  /** hotspot centre, % of map width/height */
  x: number; y: number;
  live: boolean;
}

const SPOTS: Spot[] = [
  { id: "kingdoms", label: "THE KINGDOMS", desc: "FOUND & RULE STOCK INDEXES", view: "INDEX", x: 18, y: 22, live: INDEX_FACTORY !== null },
  { id: "tower", label: "MAGE TOWER", desc: "OPTIONS — CALLS & PUTS", view: "DERIVS", x: 84, y: 18, live: true },
  { id: "bazaar", label: "THE BAZAAR", desc: "SWAP TOKENIZED STOCKS", view: "SWAP", x: 25, y: 55, live: true },
  { id: "bank", label: "THE BANK", desc: "LEND & BORROW USDG", view: "CREDIT", x: 72, y: 52, live: true },
  { id: "treasury", label: "THE TREASURY", desc: "NAV VAULT — STAKE & EARN", view: "VAULT", x: 22, y: 84, live: true },
  { id: "colosseum", label: "THE COLOSSEUM", desc: "STOCK VS STOCK BOUTS", view: "ARENA", x: 76, y: 82, live: ARENA_ADDRESS !== null },
];

/** Connected adventurer's on-chain purse (NAV + USDG). Live reads only. */
function usePurse(account: string | null): { nav: string; usdg: string } | null {
  const [purse, setPurse] = useState<{ nav: string; usdg: string } | null>(null);
  useEffect(() => {
    setPurse(null);
    if (!account) return;
    let dead = false;
    const tick = async () => {
      try {
        const [nav, usdg] = await Promise.all([
          publicClient.readContract({
            address: PROTOCOL.tokenAddress as Address, abi: erc20Abi, functionName: "balanceOf", args: [account as Address],
          }) as Promise<bigint>,
          publicClient.readContract({
            address: TOKENS.USDG.address, abi: erc20Abi, functionName: "balanceOf", args: [account as Address],
          }) as Promise<bigint>,
        ]);
        if (!dead) setPurse({
          nav: Number(formatUnits(nav, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 }),
          usdg: Number(formatUnits(usdg, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 }),
        });
      } catch { /* keep last-good */ }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { dead = true; clearInterval(id); };
  }, [account]);
  return purse;
}

export function WorldView({ setView }: { setView: (v: FloorView) => void }) {
  const wallet = useWallet();
  const purse = usePurse(wallet.account);
  const [hover, setHover] = useState<string | null>(null);

  return (
    <main className="flex-1 min-h-0 flex flex-col gap-[2px] p-[2px] lg:overflow-hidden">
      {/* adventurer strip */}
      <div className="panel flex items-center gap-4 px-3 py-1.5 text-[11px] flex-wrap">
        <span className="panel-title !p-0">WORLD MAP</span>
        <span className="text-txt-dim">EVERY LOCATION IS A LIVE ON-CHAIN VENUE — NOTHING HERE IS A GAME ASSET, IT IS THE PROTOCOL.</span>
        <span className="ml-auto flex items-center gap-3">
          {wallet.account ? (
            <>
              <span className="text-amber-dim">ADVENTURER</span>
              <span className="text-amber-2">{wallet.account.slice(0, 6)}…{wallet.account.slice(-4)}</span>
              {purse && (
                <>
                  <span className="text-txt-dim">{purse.nav} NAV</span>
                  <span className="text-txt-dim">{purse.usdg} USDG</span>
                </>
              )}
            </>
          ) : (
            <span className="text-txt-dim">CONNECT A WALLET TO CARRY YOUR PURSE ONTO THE MAP</span>
          )}
        </span>
      </div>

      {/* the map */}
      <div className="panel relative flex-1 min-h-[420px] overflow-hidden">
        <img
          src="./world/map.png"
          alt="FLOOR world map — pixel-art overworld linking every protocol venue"
          className="absolute inset-0 w-full h-full object-cover select-none"
          style={{ imageRendering: "pixelated" }}
          draggable={false}
        />
        {/* scanline vignette to blend with terminal chrome */}
        <div className="absolute inset-0 pointer-events-none" style={{ boxShadow: "inset 0 0 120px rgba(0,0,0,0.75)" }} />

        {SPOTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setView(s.view)}
            onMouseEnter={() => setHover(s.id)}
            onMouseLeave={() => setHover(null)}
            aria-label={`${s.label} — ${s.live ? s.desc : "gates sealed — enter to preview the venue"}`}
            className="absolute -translate-x-1/2 -translate-y-1/2 group"
            style={{ left: `${s.x}%`, top: `${s.y}%` }}
          >
            {/* pixel beacon */}
            <span
              className={`block w-4 h-4 mx-auto border-2 ${s.live ? "border-amber bg-amber/30 venue-ping" : "border-rule-2 bg-panel"}`}
              style={{ imageRendering: "pixelated" }}
            />
            <span
              className={`mt-1 block px-2 py-0.5 text-[10px] max-w-[120px] whitespace-normal sm:max-w-none sm:whitespace-nowrap border transition-opacity ${
                hover === s.id ? "opacity-100" : "opacity-80"
              } ${s.live ? "border-amber text-amber-2 bg-black/85" : "border-rule text-txt-dim bg-black/85"}`}
            >
              {s.label}
              <span className="block text-[9px] text-txt-dim">{s.live ? s.desc : "GATES SEALED — ENTER TO PREVIEW"}</span>
            </span>
          </button>
        ))}
      </div>

      {/* accessibility / mobile list of the same destinations */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-[2px]">
        {SPOTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setView(s.view)}
            className="fkey text-left px-3 py-2 min-w-0"
          >
            <span className={s.live ? "text-amber-2" : "text-txt-dim"}>{s.label}</span>
            <span className="block text-[9px] text-txt-dim truncate">{s.live ? s.desc : "SEALED — PREVIEW"}</span>
          </button>
        ))}
      </div>
    </main>
  );
}
