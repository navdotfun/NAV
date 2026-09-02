/* Order entry — the SWAP panel. Execution is gated until the audited
   NavSwapRouter is deployed + verified (FLOOR_ROUTER != null). */
import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import type { Listing } from "../lib/data";
import { TOKEN_BY_SYMBOL } from "../lib/data";
import type { RouteQuote } from "../lib/venues";
import { FLOOR_ROUTER, FEE_BPS, TOKENS, erc20Abi, publicClient, EXPLORER } from "../lib/chain";
import { limited } from "../lib/nav/rpc";
import { useWallet, requestConnect } from "../lib/wallet";
import { executeSwap, type ExecPhase } from "../lib/execute";
import { fmt } from "../lib/format";

export interface OrderState {
  side: "BUY" | "SELL";
  symbol: string;
  amount: string; // BUY: USDG in · SELL: stock qty in
}

export function SwapPanel({ order, setOrder, listings, quote, quoting, booted, quotedAt }: {
  order: OrderState;
  setOrder: (fn: (o: OrderState) => OrderState) => void;
  listings: Listing[];
  quote: RouteQuote | null;
  quoting: boolean;
  booted: boolean;
  /** Unix ms of the last successful quote (null = none). Drives STALE badge. */
  quotedAt: number | null;
}) {
  const w = useWallet();
  const tok = TOKEN_BY_SYMBOL.get(order.symbol);
  const [balUsdg, setBalUsdg] = useState<bigint | null>(null);
  const [balStock, setBalStock] = useState<bigint | null>(null);
  const [slippageBps, setSlippageBps] = useState(50);
  const [phase, setPhase] = useState<ExecPhase>({ k: "idle" });
  const [refreshKey, setRefreshKey] = useState(0);
  /* B-04: synchronous double-submit guard — phase state only flips after
     async pre-work (ensureChain + allowance read), leaving a click window. */
  const inFlight = useRef(false);

  /* B-15: balances poll every 30s (retried via limited()); a failed tick
     keeps the last-good figure instead of freezing "…" forever. */
  useEffect(() => {
    if (w.status !== "connected" || !w.account || !tok) { setBalUsdg(null); setBalStock(null); return; }
    let dead = false;
    setBalUsdg(null); setBalStock(null); // token switch — never show the previous token's balance
    const tick = async () => {
      try {
        const [u, s] = await limited(() => publicClient.multicall({
          contracts: [
            { address: TOKENS.USDG.address, abi: erc20Abi, functionName: "balanceOf", args: [w.account!] },
            { address: tok.address, abi: erc20Abi, functionName: "balanceOf", args: [w.account!] },
          ],
          allowFailure: true,
        }));
        if (!dead) {
          if (u.status === "success") setBalUsdg(u.result as bigint);
          if (s.status === "success") setBalStock(s.result as bigint);
        }
      } catch { /* transport failure — keep last-good, retry on next tick */ }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { dead = true; clearInterval(id); };
  }, [w.status, w.account, tok, refreshKey]);

  /* B-22: age the displayed quote — execute.ts hard-refuses quotes >45s old,
     so surface "aging" at >20s instead of failing silently at the button. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (quotedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [quotedAt]);
  const quoteStale = quote !== null && quotedAt !== null && now - quotedAt > 20_000;

  const outDecimals = order.side === "BUY" ? (tok?.decimals ?? 18) : 6;
  const outSymbol = order.side === "BUY" ? order.symbol : "USDG";
  const inSymbol = order.side === "BUY" ? "USDG" : order.symbol;
  const amountOut = quote ? Number(formatUnits(quote.amountOut, outDecimals)) : null;
  const minOut = quote ? quote.amountOut - (quote.amountOut * BigInt(slippageBps)) / 10_000n : null;

  const setSide = (side: "BUY" | "SELL") => setOrder((o) => ({ ...o, side }));

  return (
    <section className="panel flex flex-col" aria-label="order entry">
      <div className="panel-title">
        <span>SWAP · ORDER ENTRY</span>
        <span className="text-txt-dim normal-case tracking-normal">{FEE_BPS} BPS</span>
      </div>
      <div className="p-2 flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-[2px]" role="tablist" aria-label="side">
          <button role="tab" aria-selected={order.side === "BUY"}
            className={`py-1.5 text-[12px] font-bold tracking-[0.18em] border ${order.side === "BUY" ? "bg-up/15 border-up text-up" : "border-rule-2 text-txt-dim hover:border-up/50"}`}
            onClick={() => setSide("BUY")}>BUY</button>
          <button role="tab" aria-selected={order.side === "SELL"}
            className={`py-1.5 text-[12px] font-bold tracking-[0.18em] border ${order.side === "SELL" ? "bg-dn/15 border-dn text-dn" : "border-rule-2 text-txt-dim hover:border-dn/50"}`}
            onClick={() => setSide("SELL")}>SELL</button>
        </div>

        <div>
          <label className="cell-label" htmlFor="sym">Ticker</label>
          <select id="sym" className="term-input mt-0.5" value={order.symbol}
            onChange={(e) => setOrder((o) => ({ ...o, symbol: e.target.value }))}>
            {listings.map((l) => (
              <option key={l.token.symbol} value={l.token.symbol}>
                {l.token.symbol} — {l.token.name}
              </option>
            ))}
            {listings.length === 0 && <option value="NVDA">NVDA — NVIDIA</option>}
          </select>
        </div>

        <div>
          <label className="cell-label" htmlFor="amt">
            {order.side === "BUY" ? "Spend (USDG)" : `Sell qty (${order.symbol})`}
          </label>
          <input id="amt" className="term-input mt-0.5" inputMode="decimal" autoComplete="off"
            placeholder="0.00" value={order.amount}
            onChange={(e) => {
              const v = e.target.value;
              if (/^\d*\.?\d*$/.test(v)) setOrder((o) => ({ ...o, amount: v }));
            }} />
          <div className="flex justify-between mt-1 text-[10.5px] text-txt-dim">
            <span>
              BAL{" "}
              {w.status === "connected"
                ? order.side === "BUY"
                  ? balUsdg !== null ? fmt.num(Number(formatUnits(balUsdg, 6))) + " USDG" : "…"
                  : balStock !== null ? fmt.num(Number(formatUnits(balStock, tok?.decimals ?? 18), )) + " " + order.symbol : "…"
                : "— CONNECT"}
            </span>
            {w.status === "connected" && (
              <button className="text-cyan hover:underline" onClick={() => {
                const b = order.side === "BUY" ? balUsdg : balStock;
                const d = order.side === "BUY" ? 6 : (tok?.decimals ?? 18);
                if (b !== null) setOrder((o) => ({ ...o, amount: formatUnits(b, d) }));
              }}>MAX</button>
            )}
          </div>
        </div>

        <div className="border border-rule bg-screen p-2 min-h-[64px]" aria-live="polite">
          <div className="cell-label flex justify-between">
            <span>Receive (est)</span>
            {quoteStale && <span className="text-dn">STALE · REFRESHING</span>}
          </div>
          {quoting && !quote ? (
            <div className="text-amber-2 text-[15px] mt-1">QUOTING<span className="blink">▮</span></div>
          ) : quote && amountOut !== null ? (
            <>
              <div className="text-amber-2 text-[19px] font-semibold leading-tight mt-0.5">
                {fmt.num(amountOut, amountOut < 1 ? 6 : 4)} <span className="text-[12px] text-amber">{outSymbol}</span>
              </div>
              <div className="text-[10.5px] text-txt-dim mt-0.5">
                FEE {fmt.num(Number(formatUnits(quote.feeUsdg, 6)), 4)} USDG · MIN OUT{" "}
                {minOut !== null ? fmt.num(Number(formatUnits(minOut, outDecimals)), 4) : "—"}
              </div>
            </>
          ) : order.amount && booted ? (
            <div className="text-dn text-[13px] mt-1">NO ROUTE</div>
          ) : (
            <div className="text-txt-dim text-[13px] mt-1">ENTER {inSymbol} AMOUNT</div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <span className="cell-label">Slippage</span>
          <span className="flex gap-[2px]" role="radiogroup" aria-label="slippage tolerance">
            {[10, 50, 100].map((bps) => (
              <button key={bps} role="radio" aria-checked={slippageBps === bps}
                className={`fkey !px-2 ${slippageBps === bps ? "!border-amber !text-amber-2" : ""}`}
                onClick={() => setSlippageBps(bps)}>
                {(bps / 100).toFixed(1)}%
              </button>
            ))}
          </span>
        </div>

        {FLOOR_ROUTER === null ? (
          <button className="btn-exec" disabled title="Execution opens when the audited router contract is deployed and verified">
            EXECUTION PENDING ROUTER AUDIT
          </button>
        ) : (() => {
          const busy = phase.k === "approving" || phase.k === "swapping";
          const balIn = order.side === "BUY" ? balUsdg : balStock;
          const short = quote && balIn !== null && balIn < quote.amountIn;
          const label =
            w.status !== "connected" ? "CONNECT TO TRADE"
            : phase.k === "approving" ? "APPROVING…"
            : phase.k === "swapping" ? "EXECUTING…"
            : short ? `INSUFFICIENT ${inSymbol}`
            : order.side === "BUY" ? `BUY ${order.symbol}` : `SELL ${order.symbol}`;
          const run = () => {
            if (w.status !== "connected") { requestConnect(); return; }
            if (!quote || !w.account || busy || short || inFlight.current) return;
            inFlight.current = true;
            setPhase({ k: "idle" });
            void executeSwap({ quote, account: w.account, slippageBps, onPhase: (p) => {
              setPhase(p);
              if (p.k === "filled") setRefreshKey((n) => n + 1);
            }}).finally(() => { inFlight.current = false; });
          };
          return (
            <>
              <button className="btn-exec" disabled={w.status === "connected" && (!quote || busy || !!short)} onClick={run}>
                {label}
              </button>
              {phase.k === "filled" && (
                <p className="text-[10px] leading-snug" style={{ color: "var(--color-up)" }}>
                  FILLED · {fmt.num(Number(formatUnits(phase.amountOut, outDecimals)), 6)} {outSymbol} ·{" "}
                  <a className="underline" href={`${EXPLORER}/tx/${phase.hash}`} target="_blank" rel="noreferrer">TX ↗</a>
                </p>
              )}
              {phase.k === "error" && (
                <p className="text-[10px] leading-snug" style={{ color: "var(--color-dn)" }}>
                  REJECTED · {phase.message.toUpperCase()}
                </p>
              )}
              {(phase.k === "approving" || phase.k === "swapping") && phase.hash && (
                <p className="text-[10px] text-txt-dim leading-snug">
                  PENDING · <a className="underline" href={`${EXPLORER}/tx/${phase.hash}`} target="_blank" rel="noreferrer">TX ↗</a>
                </p>
              )}
            </>
          );
        })()}
        <p className="text-[10px] text-txt-dim leading-snug">
          Routed on-chain through the USDG waypoint. {FEE_BPS} bps interface fee funds NAV vault
          accretion. Quotes are live eth_calls to venue quoters — never estimates.
        </p>
      </div>
    </section>
  );
}
