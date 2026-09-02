/* OPTIONS — positions blotter. Reads the position book straight from the
   contract (no indexer): scans the most recent ids via multicall and shows
   the connected wallet's book. Settlement is permissionless. */
import { useRef, useState } from "react";
import { formatUnits } from "viem";
import { EXPLORER } from "../../lib/chain";
import { useWallet } from "../../lib/wallet";
import { fmt } from "../../lib/format";
import { settlePosition, type OptMarket, type OptPosition, type OptExecPhase } from "../../lib/options";

export function PositionsBlotter({ positions, markets, loading, truncated, onSettled }: {
  positions: OptPosition[];
  markets: OptMarket[];
  loading: boolean;
  /** R4 F-03: true when older ids may exist beyond the scan (log seed down). */
  truncated: boolean;
  onSettled: () => void;
}) {
  const w = useWallet();
  const [phase, setPhase] = useState<OptExecPhase>({ k: "idle" });
  const [busyId, setBusyId] = useState<bigint | null>(null);
  /* R4 F-07: synchronous double-submit guard — state alone races the
     re-render, two rapid clicks could broadcast two settle txs. */
  const inFlight = useRef(false);
  const now = Math.floor(Date.now() / 1000);

  const settle = async (id: bigint) => {
    if (!w.account || inFlight.current) return;
    inFlight.current = true;
    setBusyId(id);
    setPhase({ k: "idle" });
    try {
      await settlePosition(id, w.account, setPhase);
    } finally {
      inFlight.current = false;
      setBusyId(null);
    }
    onSettled();
  };

  return (
    <section className="panel flex flex-col min-h-0" aria-label="my positions">
      <div className="panel-title">
        <span>MY POSITIONS</span>
        <span className="text-txt-dim normal-case tracking-normal">CASH-SETTLED AT EXPIRY</span>
      </div>
      <div className="overflow-y-auto flex-1">
        <table className="w-full text-[11.5px]">
          <thead>
            <tr className="text-left">
              {["#", "MKT", "TYPE", "SIZE", "STRIKE", "EXPIRY (UTC)", "STATUS", ""].map((h, i) => (
                <th key={i} className="cell-label px-1.5 py-1 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const mk = markets.find((m) => m.id === p.marketId);
              const expired = Number(p.expiry) <= now;
              /* R4 F-01: no oracle price → moneyness is UNKNOWN (null), never a
                 fabricated OTM from comparing against a fake $0. */
              const itm = mk && mk.price !== null
                ? p.isCall ? mk.price > Number(formatUnits(p.strike, 18)) : mk.price < Number(formatUnits(p.strike, 18))
                : null;
              return (
                <tr key={p.id.toString()} className="border-t border-rule">
                  <td className="px-1.5 py-1 text-txt-dim tabular-nums">{p.id.toString()}</td>
                  <td className="px-1.5 py-1 font-bold text-txt">{mk?.symbol ?? p.marketId}</td>
                  <td className={`px-1.5 py-1 font-bold ${p.isCall ? "text-up" : "text-dn"}`}>{p.isCall ? "CALL" : "PUT"}</td>
                  <td className="px-1.5 py-1 tabular-nums text-txt">{fmt.num(Number(formatUnits(p.size, 18)))}</td>
                  <td className="px-1.5 py-1 tabular-nums text-txt">{fmt.usd(Number(formatUnits(p.strike, 18)))}</td>
                  <td className="px-1.5 py-1 tabular-nums text-txt-dim whitespace-nowrap">
                    {new Date(Number(p.expiry) * 1000).toISOString().slice(5, 16).replace("T", " ")}
                  </td>
                  <td className="px-1.5 py-1">
                    {p.settled ? <span className="text-txt-dim">SETTLED</span>
                      : expired ? <span className="text-amber-2">EXPIRED{itm === true ? " · ITM" : ""}</span>
                      : itm === null ? <span className="text-txt-dim">—</span>
                      : <span className={itm ? "text-up" : "text-txt-dim"}>{itm ? "ITM" : "OTM"}</span>}
                  </td>
                  <td className="px-1.5 py-1 text-right">
                    {!p.settled && expired && (
                      <button className="fkey !px-2 !py-0.5 text-[10.5px]" disabled={busyId !== null}
                        onClick={() => void settle(p.id)}>
                        {busyId === p.id ? "…" : "SETTLE"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {positions.length === 0 && (
              <tr><td colSpan={8} className="px-2 py-4 text-center text-txt-dim">
                {w.status !== "connected" ? "CONNECT WALLET TO VIEW POSITIONS" : loading ? "SCANNING BOOK…" : "NO POSITIONS"}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      {truncated && positions.length > 0 && (
        <p className="px-2 py-1 text-[10px] text-txt-dim border-t border-rule">
          BOOK SCAN: LAST 500 IDS + YOUR TRACKED POSITIONS — OLDER UNTRACKED IDS MAY BE OMITTED UNTIL THE LOG SCAN RECOVERS
        </p>
      )}
      {phase.k === "error" && (
        <p className="p-2 text-[11px] text-dn" role="alert">
          ✕ {phase.message}
          {phase.hash && (
            <>{" "}· <a className="text-cyan hover:underline" href={`${EXPLORER}/tx/${phase.hash}`} target="_blank" rel="noopener noreferrer">TX</a></>
          )}
        </p>
      )}
      {phase.k === "done" && (
        <p className="p-2 text-[11px] text-up" role="status">
          ✓ SETTLED ·{" "}
          <a className="text-cyan hover:underline" href={`${EXPLORER}/tx/${phase.hash}`} target="_blank" rel="noopener noreferrer">TX</a>
        </p>
      )}
    </section>
  );
}
