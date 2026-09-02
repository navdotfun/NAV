/* MY FILLS — the connected wallet's own blotter, straight from
   RouteExecuted logs on the verified router. ADD TO WALLET fires
   EIP-747 so the received token appears in the wallet UI. */
import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { EXPLORER } from "../lib/chain";
import { addTokenToWallet, fetchMyFills, tokenMeta, type Fill } from "../lib/fills";
import { useWallet } from "../lib/wallet";
import { fmt } from "../lib/format";

const POLL_MS = 30_000;

function utc(ts: number, block: bigint): string {
  if (ts === 0) return `#${block.toString()}`;
  const d = new Date(ts * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function qty(amount: bigint, decimals: number): string {
  const n = Number(formatUnits(amount, decimals));
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 });
}

export function MyFills() {
  const w = useWallet();
  // chain reads go through the public RPC — only an account is needed
  const connected = !!w.account;
  const [fills, setFills] = useState<Fill[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [added, setAdded] = useState<string | null>(null); // last token added
  const seq = useRef(0);

  useEffect(() => {
    if (!connected) { setFills(null); setFailed(false); return; }
    const my = ++seq.current;
    const pull = async () => {
      try {
        const f = await fetchMyFills(w.account!);
        if (seq.current === my) { setFills(f); setFailed(false); }
      } catch {
        if (seq.current === my) setFailed(true);
      }
    };
    void pull();
    const t = setInterval(pull, POLL_MS);
    return () => clearInterval(t);
  }, [connected, w.account]);

  const watch = async (addr: `0x${string}`) => {
    const ok = await addTokenToWallet(addr);
    if (ok) {
      setAdded(addr.toLowerCase());
      setTimeout(() => setAdded(null), 4000);
    }
  };

  return (
    <section className="panel" aria-label="my fills">
      <div className="panel-title">
        <span>MY FILLS · BLOTTER</span>
        <span className="text-txt-dim normal-case tracking-normal">ROUTER LOGS · LIVE</span>
      </div>
      {!connected ? (
        <div className="px-2.5 py-2 text-[11px] text-txt-dim">
          CONNECT A WALLET — YOUR EXECUTIONS ARE READ STRAIGHT FROM ROUTEEXECUTED LOGS ON THE VERIFIED ROUTER.
        </div>
      ) : fills === null ? (
        <div className="px-2.5 py-2 text-[11px] text-txt-dim">{failed ? "LOG READ FAILED — RETRYING…" : "READING CHAIN LOGS…"}</div>
      ) : fills.length === 0 ? (
        <div className="px-2.5 py-2 text-[11px] text-txt-dim">NO FILLS YET — YOUR FIRST EXECUTION PRINTS HERE.</div>
      ) : (
        <div className="overflow-x-auto max-h-[190px] overflow-y-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-amber-dim">
                <th className="font-normal px-2.5 py-1 tracking-wider">UTC</th>
                <th className="font-normal px-2 py-1 tracking-wider">PAIR</th>
                <th className="font-normal px-2 py-1 tracking-wider text-right">IN</th>
                <th className="font-normal px-2 py-1 tracking-wider text-right">OUT</th>
                <th className="font-normal px-2 py-1 tracking-wider text-right">FEE</th>
                <th className="font-normal px-2.5 py-1 tracking-wider text-right">TRACK</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((f) => {
                const tin = tokenMeta(f.tokenIn);
                const tout = tokenMeta(f.tokenOut);
                return (
                  <tr key={f.tx} className="border-t border-rule hover:bg-panel-2">
                    <td className="px-2.5 py-1 whitespace-nowrap">
                      <a className="text-cyan hover:underline tabular-nums" href={`${EXPLORER}/tx/${f.tx}`} target="_blank" rel="noopener noreferrer">
                        {utc(f.timestamp, f.block)}
                      </a>
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-txt">{tin.symbol}<span className="text-txt-dim">→</span>{tout.symbol}</td>
                    <td className="px-2 py-1 text-right text-dn tabular-nums">{qty(f.amountIn, tin.decimals)}</td>
                    <td className="px-2 py-1 text-right text-up tabular-nums">{qty(f.amountOut, tout.decimals)}</td>
                    <td className="px-2 py-1 text-right text-txt-dim tabular-nums">{fmt.usd(Number(formatUnits(f.feeUsdg, 6)), 4)}</td>
                    <td className="px-2.5 py-1 text-right whitespace-nowrap">
                      <button type="button"
                        className={`text-[10px] border px-1.5 py-0.5 ${added === f.tokenOut.toLowerCase() ? "border-up text-up" : "border-rule-2 text-cyan hover:border-cyan"}`}
                        title={`EIP-747 — add ${tout.symbol} to your wallet's token list`}
                        onClick={() => void watch(f.tokenOut)}>
                        {added === f.tokenOut.toLowerCase() ? "ADDED ✓" : "+WALLET"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
