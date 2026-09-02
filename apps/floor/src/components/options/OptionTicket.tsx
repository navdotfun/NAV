/* OPTIONS — order ticket. Every figure comes from previewOpen on-chain;
   the OPEN button enforces the on-screen cost via maxCostUsdg (+0.5%). */
import { useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { EXPLORER, TOKENS, erc20Abi, publicClient } from "../../lib/chain";
import { useWallet, requestConnect } from "../../lib/wallet";
import { fmt } from "../../lib/format";
import {
  BUCKETS, OPTION_TERMS, NAV_OPTIONS, OPT_RATE_CAP, OPT_RATE_FLOOR, openOption,
  type OptMarket, type OptQuote, type OptExecPhase,
} from "../../lib/options";
import { limited } from "../../lib/nav/rpc";

export interface TicketState {
  marketId: number;
  isCall: boolean;
  bucket: number;
  termIdx: number;
  size: string; // stock qty, decimal string
}

/** B-07: the quote carries a snapshot of the EXACT params it was priced for —
    OPEN submits these, never the (possibly re-edited) live ticket state. */
export type TicketQuote = OptQuote & {
  sizeWei: bigint;
  marketId: number;
  isCall: boolean;
  bucket: number;
  term: bigint;
};

export function OptionTicket({ ticket, setTicket, markets, quote, quoting, quotedAt, quoteNote, onFilled }: {
  ticket: TicketState;
  setTicket: (fn: (t: TicketState) => TicketState) => void;
  markets: OptMarket[];
  quote: TicketQuote | null;
  quoting: boolean;
  /** Unix ms of the last successful quote — drives the STALE badge (B-22). */
  quotedAt: number | null;
  /** R4 F-02: reason the contract rejected the quote (revert), if any. */
  quoteNote: string | null;
  onFilled: () => void;
}) {
  const w = useWallet();
  const m = markets.find((x) => x.id === ticket.marketId) ?? null;
  const [balUsdg, setBalUsdg] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<OptExecPhase>({ k: "idle" });
  /* B-04: synchronous double-submit guard. */
  const inFlight = useRef(false);

  /* B-15 (same pattern as SwapPanel): 30s poll, keep last-good on failure. */
  useEffect(() => {
    if (w.status !== "connected" || !w.account) { setBalUsdg(null); return; }
    let dead = false;
    const tick = async () => {
      try {
        const b = (await limited(() => publicClient.readContract({
          address: TOKENS.USDG.address, abi: erc20Abi, functionName: "balanceOf", args: [w.account!],
        }))) as bigint;
        if (!dead) setBalUsdg(b);
      } catch { /* transport failure — keep last-good, retry on next tick */ }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { dead = true; clearInterval(id); };
  }, [w.status, w.account, phase.k]);

  /* B-22: quote aging → STALE badge past 20s. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (quotedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [quotedAt]);
  const quoteStale = quote !== null && quotedAt !== null && now - quotedAt > 20_000;

  /* B-07: figures on screen are what you sign — OPEN is disabled unless the
     displayed quote matches the CURRENT ticket exactly. */
  let sizeWeiNow: bigint | null = null;
  try { sizeWeiNow = ticket.size ? parseUnits(ticket.size, 18) : null; } catch { sizeWeiNow = null; }
  const paramsMatch = quote !== null && sizeWeiNow !== null
    && quote.marketId === ticket.marketId && quote.isCall === ticket.isCall
    && quote.bucket === ticket.bucket && quote.term === OPTION_TERMS[ticket.termIdx].seconds
    && quote.sizeWei === sizeWeiNow;

  const cost = quote ? quote.premium + quote.origination : null;
  const busy = phase.k === "approving" || phase.k === "sending";
  const insufficient = cost !== null && balUsdg !== null && cost > balUsdg;

  /* Writer-capacity gate: open() escrows from the side vault's FREE assets
     (stock for CALLs, USDG for PUTs). previewOpen does NOT check capacity,
     so without this gate a valid-looking quote reverts InsufficientFreeCapital
     at execution. Board data is the live vaultInfo read (null = read failed —
     never gate on a failed read, the chain remains the authority). */
  const sideVault = m ? (ticket.isCall ? m.callVault : m.putVault) : null;
  const freeCap = sideVault ? sideVault.freeAssets : null;
  const noCapacity = quote !== null && freeCap !== null && quote.escrow > freeCap;

  /* R4 M-01: surface the measured pool-fee rate and whether the pricer is
     clamping it. At the cap the quote stops tracking volatility — buyers may
     be under-charged relative to true risk and writers under-compensated;
     both sides deserve the flag before signing. */
  const rateRaw = m && m.dailyRateX18 !== null ? Number(m.dailyRateX18) / 1e18 : null;
  const rateEff = rateRaw !== null ? (rateRaw === 0 ? OPT_RATE_FLOOR : Math.min(Math.max(rateRaw, OPT_RATE_FLOOR), OPT_RATE_CAP)) : null;
  const rateCapped = rateRaw !== null && rateRaw >= OPT_RATE_CAP;
  const capacityStr = m === null ? "—"
    : sideVault === null ? "—"
    : ticket.isCall
      ? `${fmt.num(Number(formatUnits(freeCap!, 18)), 4)} ${m.symbol}`
      : fmt.usd(Number(formatUnits(freeCap!, 6)));

  const submit = async () => {
    if (!quote || !w.account || !m || !paramsMatch || inFlight.current) return;
    inFlight.current = true;
    setPhase({ k: "idle" });
    try {
      /* B-07: submit the exact params the quote priced — never live state. */
      await openOption({
        marketId: quote.marketId, isCall: quote.isCall, bucket: quote.bucket,
        size: quote.sizeWei, term: quote.term,
        quote, account: w.account, onPhase: setPhase,
      });
      onFilled();
    } finally { inFlight.current = false; }
  };

  return (
    <section className="panel flex flex-col" aria-label="option ticket">
      <div className="panel-title">
        <span>OPTIONS · ORDER TICKET</span>
        <span className="text-txt-dim normal-case tracking-normal">EUROPEAN · PREPAID</span>
      </div>
      <div className="p-2 flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-[2px]" role="tablist" aria-label="type">
          <button role="tab" aria-selected={ticket.isCall}
            className={`py-1.5 text-[12px] font-bold tracking-[0.18em] border ${ticket.isCall ? "bg-up/15 border-up text-up" : "border-rule-2 text-txt-dim hover:border-up/50"}`}
            onClick={() => setTicket((t) => ({ ...t, isCall: true }))}>CALL</button>
          <button role="tab" aria-selected={!ticket.isCall}
            className={`py-1.5 text-[12px] font-bold tracking-[0.18em] border ${!ticket.isCall ? "bg-dn/15 border-dn text-dn" : "border-rule-2 text-txt-dim hover:border-dn/50"}`}
            onClick={() => setTicket((t) => ({ ...t, isCall: false }))}>PUT</button>
        </div>

        <div>
          <label className="cell-label" htmlFor="opt-sym">Underlying</label>
          <select id="opt-sym" className="term-input mt-0.5" value={ticket.marketId}
            onChange={(e) => setTicket((t) => ({ ...t, marketId: Number(e.target.value) }))}>
            {markets.map((mk) => (
              <option key={mk.id} value={mk.id}>{mk.symbol} — {mk.price !== null ? fmt.usd(mk.price) : "—"}</option>
            ))}
            {markets.length === 0 && <option value={0}>—</option>}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="cell-label">Strike</span>
            <div className="grid grid-cols-3 gap-[2px] mt-0.5" role="tablist" aria-label="strike bucket">
              {BUCKETS.map((b) => (
                <button key={b.id} role="tab" aria-selected={ticket.bucket === b.id}
                  className={`py-1 text-[11px] font-bold border ${ticket.bucket === b.id ? "border-amber text-amber-2 bg-amber/10" : "border-rule-2 text-txt-dim hover:border-amber/60"}`}
                  onClick={() => setTicket((t) => ({ ...t, bucket: b.id }))}>
                  {ticket.isCall ? b.call : b.put}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="cell-label">Term</span>
            <div className="grid grid-cols-4 gap-[2px] mt-0.5" role="tablist" aria-label="term">
              {OPTION_TERMS.map((t, i) => (
                <button key={t.label} role="tab" aria-selected={ticket.termIdx === i}
                  className={`py-1 text-[11px] font-bold border ${ticket.termIdx === i ? "border-amber text-amber-2 bg-amber/10" : "border-rule-2 text-txt-dim hover:border-amber/60"}`}
                  onClick={() => setTicket((tk) => ({ ...tk, termIdx: i }))}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <label className="cell-label" htmlFor="opt-size">Size ({m?.symbol ?? "—"} qty)</label>
          <input id="opt-size" className="term-input mt-0.5" inputMode="decimal" autoComplete="off"
            placeholder="0.00" value={ticket.size}
            onChange={(e) => {
              const v = e.target.value;
              if (/^\d*\.?\d*$/.test(v)) setTicket((t) => ({ ...t, size: v }));
            }} />
          <div className="flex justify-between mt-1 text-[10.5px] text-txt-dim">
            <span>
              USDG BAL{" "}
              {w.status === "connected"
                ? balUsdg !== null ? fmt.num(Number(formatUnits(balUsdg, 6))) : "…"
                : "— CONNECT"}
            </span>
            {m && <span>NOTIONAL {quote ? fmt.usd(Number(formatUnits(quote.notional, 6))) : "—"}</span>}
          </div>
        </div>

        {/* quote readout — all figures from previewOpen.
            B-32: uniform discipline — "…" while quoting, "—" when absent. */}
        <div className="border border-rule bg-panel-2 p-2 flex flex-col gap-1 text-[12px]">
          {quoteStale && (
            <div className="text-dn text-[10px] tracking-[0.14em]" role="status">STALE · REFRESHING</div>
          )}
          <Row k="STRIKE" v={quote ? fmt.usd(Number(formatUnits(quote.strike, 18))) : quoting ? "…" : "—"} hot />
          <Row k="EXPIRY (UTC)" v={quote ? new Date(Number(quote.expiry) * 1000).toISOString().slice(0, 16).replace("T", " ") : quoting ? "…" : "—"} />
          <Row k="PREMIUM" v={quote ? fmt.usd(Number(formatUnits(quote.premium, 6)), 4) : quoting ? "…" : "—"} hot />
          <Row k="ORIGINATION (20 BPS)" v={quote ? fmt.usd(Number(formatUnits(quote.origination, 6)), 4) : quoting ? "…" : "—"} />
          <div className="border-t border-rule my-0.5" />
          <Row k="TOTAL COST" v={cost !== null ? fmt.usd(Number(formatUnits(cost, 6)), 4) : quoting ? "…" : "—"} hot big />
          <Row k="MAX COST ENFORCED" v={cost !== null ? fmt.usd(Number(formatUnits(cost + cost / 200n, 6)), 4) : quoting ? "…" : "—"} />
          <div className="border-t border-rule my-0.5" />
          {/* R4 M-01: rate transparency — measured vs applied, cap/floor flags */}
          <div className="flex justify-between items-baseline">
            <span className="cell-label">RATE/DAY (POOL-MEASURED)</span>
            <span className={`tabular-nums ${rateCapped ? "text-dn" : "text-txt"}`}>
              {rateEff !== null
                ? `${(rateEff * 10_000).toFixed(1)} BPS${rateCapped ? " (CAP)" : rateRaw === 0 ? " (FLOOR)" : ""}`
                : "—"}
            </span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="cell-label">WRITER CAPACITY ({ticket.isCall ? "CALL" : "PUT"} SIDE)</span>
            <span className={`tabular-nums ${noCapacity || (freeCap !== null && freeCap === 0n) ? "text-dn" : "text-txt"}`}>{capacityStr}</span>
          </div>
        </div>

        {quoteNote && (
          <p className="text-[10.5px] leading-relaxed text-dn" role="status">
            QUOTE UNAVAILABLE — {quoteNote.toUpperCase()}
          </p>
        )}

        {rateCapped && (
          <p className="text-[10.5px] leading-relaxed text-dn" role="status">
            MEASURED POOL FEE RATE IS AT THE 300 BPS/DAY CAP — QUOTED PREMIUM IS
            CLAMPED AND MAY UNDERPRICE CURRENT VOLATILITY. SIZE ACCORDINGLY.
          </p>
        )}

        {(noCapacity || (freeCap !== null && freeCap === 0n)) && (
          <p className="text-[10.5px] leading-relaxed text-dn" role="status">
            {freeCap === 0n
              ? "NO WRITER CAPITAL ON THIS SIDE YET — OPENS WILL REVERT."
              : "SIZE EXCEEDS FREE WRITER CAPITAL — THIS ORDER WOULD REVERT."}{" "}
            DEPOSIT ON THE WRITE TAB TO EARN PREMIUMS, OR REDUCE SIZE.
          </p>
        )}

        {w.status !== "connected" ? (
          <button className="btn-exec" onClick={() => requestConnect()}>CONNECT WALLET</button>
        ) : (
          <button className="btn-exec" disabled={!NAV_OPTIONS || !quote || busy || insufficient || quoting || !paramsMatch || noCapacity}
            onClick={() => void submit()}>
            {!NAV_OPTIONS ? "DEPLOYING…"
              : busy ? (phase.k === "approving" ? "APPROVING USDG…" : "OPENING…")
              : insufficient ? "INSUFFICIENT USDG"
              : noCapacity ? "NO WRITER CAPACITY"
              : quoting || (quote && !paramsMatch) ? "REPRICING…"
              : `OPEN ${ticket.isCall ? "CALL" : "PUT"}`}
          </button>
        )}

        {phase.k === "error" && (
          <p className="text-[11px] text-dn" role="alert">
            ✕ {phase.message}
            {phase.hash && (
              <>{" "}· <a className="text-cyan hover:underline" href={`${EXPLORER}/tx/${phase.hash}`} target="_blank" rel="noopener noreferrer">TX</a></>
            )}
          </p>
        )}
        {phase.k === "done" && (
          <p className="text-[11px] text-up" role="status">
            ✓ FILLED{phase.result !== undefined ? ` · POSITION #${phase.result.toString()}` : ""} ·{" "}
            <a className="text-cyan hover:underline" href={`${EXPLORER}/tx/${phase.hash}`} target="_blank" rel="noopener noreferrer">TX</a>
          </p>
        )}

        <p className="text-[10px] leading-relaxed text-txt-dim">
          FULLY COLLATERALISED AT OPEN · CASH-SETTLED IN {ticket.isCall ? "STOCK" : "USDG"} AT EXPIRY ·
          SETTLEMENT = PITORACLE SNAPSHOT · NO KEEPERS, ANYONE CAN SETTLE (5 BPS BOUNTY)
        </p>
      </div>
    </section>
  );
}

function Row({ k, v, hot, big }: { k: string; v: string; hot?: boolean; big?: boolean }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="cell-label">{k}</span>
      <span className={`${hot ? "text-amber-2" : "text-txt"} ${big ? "text-[14px] font-bold" : ""} tabular-nums`}>{v}</span>
    </div>
  );
}
