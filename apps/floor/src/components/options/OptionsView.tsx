/* OPTIONS view — orchestrates markets, quote loop and position polling.
   All state is read from NavOptions on-chain; no indexer, no backend. */
import { useCallback, useEffect, useRef, useState } from "react";
import { parseUnits } from "viem";
import { useWallet } from "../../lib/wallet";
import {
  NAV_OPTIONS, OPTION_TERMS, loadOptMarkets, fetchOptQuote, fetchMyPositions, friendly,
  type OptMarket, type OptPosition,
} from "../../lib/options";
import { isRevert } from "../../lib/nav/rpc";
import { OptionTicket, type TicketState, type TicketQuote } from "./OptionTicket";
import { OptionsBoard } from "./OptionsBoard";
import { PositionsBlotter } from "./PositionsBlotter";
import { WriterDesk } from "./WriterDesk";

export function OptionsView() {
  const w = useWallet();
  const [markets, setMarkets] = useState<OptMarket[]>([]);
  const [booted, setBooted] = useState(false);
  const [ticket, setTicket] = useState<TicketState>({ marketId: 0, isCall: true, bucket: 0, termIdx: 1, size: "" });
  const [quote, setQuote] = useState<TicketQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  /** Unix ms of the last SUCCESSFUL option quote — drives STALE badge (B-22). */
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  /** R4 F-02: human-readable reason when previewOpen REVERTS (a definitive
      on-chain "no", distinct from a transport failure which keeps last-good). */
  const [quoteNote, setQuoteNote] = useState<string | null>(null);
  const [positions, setPositions] = useState<OptPosition[]>([]);
  const [posTruncated, setPosTruncated] = useState(false);
  const [posLoading, setPosLoading] = useState(false);
  const quoteSeq = useRef(0);
  const lastQuoteKey = useRef<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  /* R4 F-11: the retry branch must see the LIVE booted flag, not the value
     captured when the effect mounted (deps only include refreshKey). */
  const bootedRef = useRef(false);

  /* markets poll (30s; 2s retry until first success) — booted only flips on a
     REAL answer, so a read failure shows LOADING, never "NOT YET DEPLOYED". */
  useEffect(() => {
    let dead = false;
    let retry: ReturnType<typeof setTimeout>;
    /* R4 F-05: a refresh triggered by a fill must bypass the 15s snapshot so
       the new vault state is visible immediately; steady-state polls use it. */
    let force = refreshKey > 0;
    const tick = async () => {
      try {
        const ms = await loadOptMarkets(force);
        force = false;
        if (!dead) { setMarkets(ms); setBooted(true); bootedRef.current = true; }
      } catch {
        /* keep last-good markets; fast retry only while nothing is on screen */
        if (!dead && !bootedRef.current) retry = setTimeout(() => void tick(), 2_000);
      }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { dead = true; clearInterval(id); clearTimeout(retry); };
  }, [refreshKey]);

  /* quote loop: debounce + 15s refresh */
  const runQuote = useCallback(async () => {
    const amt = Number(ticket.size);
    if (!NAV_OPTIONS || !ticket.size || !isFinite(amt) || amt <= 0) {
      setQuote(null); setQuotedAt(null); setQuoteNote(null); lastQuoteKey.current = null; return;
    }
    const key = `${ticket.marketId}|${ticket.isCall}|${ticket.bucket}|${ticket.termIdx}|${ticket.size}`;
    const seq = ++quoteSeq.current;
    /* B-07: snapshot the exact params this quote prices — OPEN submits these. */
    const sizeWei = parseUnits(ticket.size, 18);
    const snap = {
      sizeWei, marketId: ticket.marketId, isCall: ticket.isCall,
      bucket: ticket.bucket, term: OPTION_TERMS[ticket.termIdx].seconds,
    };
    setQuoting(true);
    try {
      const q = await fetchOptQuote(snap.marketId, snap.isCall, snap.bucket, sizeWei, snap.term);
      if (seq === quoteSeq.current) {
        setQuote({ ...q, ...snap }); setQuotedAt(Date.now()); setQuoteNote(null); lastQuoteKey.current = key;
      }
    } catch (e) {
      if (seq !== quoteSeq.current) return; // superseded — ignore (R4 F-13)
      if (isRevert(e)) {
        /* R4 F-02: the contract REJECTED these params — blank the quote and
           tell the user WHY (DepthLow, NotionalTooSmall, FeedDeviation…)
           instead of a silent "—". */
        setQuote(null); setQuotedAt(null); setQuoteNote(friendly(e)); lastQuoteKey.current = null;
      } else if (lastQuoteKey.current !== key) {
        /* B-02: transport failure — keep the last-good quote for identical
           params; only a quote for DIFFERENT params must be blanked. */
        setQuote(null); setQuotedAt(null);
      }
    } finally {
      if (seq === quoteSeq.current) setQuoting(false);
    }
  }, [ticket]);

  useEffect(() => {
    const t = setTimeout(runQuote, 450);
    const id = setInterval(runQuote, 15_000);
    return () => { clearTimeout(t); clearInterval(id); };
  }, [runQuote]);

  /* positions poll (20s) */
  useEffect(() => {
    if (w.status !== "connected" || !w.account || !NAV_OPTIONS) { setPositions([]); setPosTruncated(false); return; }
    let dead = false;
    const tick = async () => {
      setPosLoading(true);
      try {
        const book = await fetchMyPositions(w.account!);
        if (!dead) { setPositions(book.positions); setPosTruncated(book.truncated); }
      } catch { /* noop */ } finally { if (!dead) setPosLoading(false); }
    };
    void tick();
    const id = setInterval(tick, 20_000);
    return () => { dead = true; clearInterval(id); };
  }, [w.status, w.account, refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);
  const selMarket = markets.find((m) => m.id === ticket.marketId) ?? null;

  return (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-[2px] p-[2px] min-h-0 lg:overflow-hidden">
      <div className="lg:col-span-3 flex flex-col gap-[2px] min-h-0 lg:overflow-y-auto">
        <OptionTicket ticket={ticket} setTicket={setTicket} markets={markets}
          quote={quote} quoting={quoting} quotedAt={quotedAt} quoteNote={quoteNote} onFilled={refresh} />
      </div>
      <div className="lg:col-span-5 min-h-0 flex flex-col gap-[2px] lg:overflow-y-auto">
        <OptionsBoard markets={markets} selected={ticket.marketId}
          onSelect={(id) => setTicket((t) => ({ ...t, marketId: id }))} booted={booted} />
      </div>
      <div className="lg:col-span-4 flex flex-col gap-[2px] min-h-0 lg:overflow-y-auto">
        <PositionsBlotter positions={positions} markets={markets} loading={posLoading}
          truncated={posTruncated} onSettled={refresh} />
        <WriterDesk market={selMarket} onChanged={refresh} />
      </div>
    </main>
  );
}
