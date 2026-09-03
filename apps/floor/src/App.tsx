/* FLOOR — single-screen terminal. All data live from Robinhood Chain. */
import { useCallback, useEffect, useRef, useState } from "react";
import { TOKENS, publicClient } from "./lib/chain";
import {
  discoverListings, refreshPrices, fetchAnchor, fetchTape,
  type Listing, type Anchor, type TapePrint, TOKEN_BY_SYMBOL,
} from "./lib/data";
import { quoteRoute, type RouteQuote } from "./lib/venues";
import { parseUnits, type Address } from "viem";
import { TopBar } from "./components/TopBar";
import { TickerTape } from "./components/TickerTape";
import { SwapPanel, type OrderState } from "./components/SwapPanel";
import { RoutingTheatre } from "./components/RoutingTheatre";
import { FairPriceShield } from "./components/FairPriceShield";
import { MarketWatch } from "./components/MarketWatch";
import { TapePanel } from "./components/TapePanel";
import { FKeyBar } from "./components/FKeyBar";
import { WalletPicker } from "./components/WalletPicker";
import { MyFills } from "./components/MyFills";
import { DerivsView } from "./components/derivs/DerivsView";
import { VaultView } from "./components/vault/VaultView";
import { AnalyticsView } from "./components/analytics/AnalyticsView";
import { CreditView } from "./components/credit/CreditView";
import { WorldView } from "./components/world/WorldView";
import { ArenaView } from "./components/arena/ArenaView";
import { KingdomsView } from "./components/kingdoms/KingdomsView";

export type FloorView = "SWAP" | "DERIVS" | "VAULT" | "CREDIT" | "STATS" | "WORLD" | "ARENA" | "INDEX";

/* Venue chrome — SWAP/DERIVS/VAULT/CREDIT are locations on the F1 WORLD map
   (the Bazaar, the Mage Tower, the Treasury, the Bank), so each carries the
   same ← MAP bar the Colosseum and the Kingdoms use. Pure navigation. */
const VENUE_META: Partial<Record<FloorView, { name: string; desc: string; key: string }>> = {
  SWAP: { name: "THE BAZAAR", desc: "SWAP TOKENIZED STOCKS", key: "F2" },
  DERIVS: { name: "MAGE TOWER", desc: "OPTIONS — CALLS & PUTS", key: "F3" },
  VAULT: { name: "THE TREASURY", desc: "NAV VAULT — STAKE & EARN", key: "F4" },
  CREDIT: { name: "THE BANK", desc: "LEND & BORROW USDG", key: "F5" },
};

const USDG = TOKENS.USDG.address;

export default function App() {
  const [view, setView] = useState<FloorView>("WORLD");
  const [listings, setListings] = useState<Listing[]>([]);
  const [booted, setBooted] = useState(false);
  const [block, setBlock] = useState<bigint>(0n);
  const [tape, setTape] = useState<TapePrint[]>([]);

  // order state
  const [order, setOrder] = useState<OrderState>({ side: "BUY", symbol: "NVDA", amount: "" });
  const [quote, setQuote] = useState<RouteQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  /** Unix ms of the last SUCCESSFUL quote — drives the STALE badge (B-22). */
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const quoteSeq = useRef(0);
  const lastQuoteKey = useRef<string | null>(null);

  /* B-08: polls read listings through a ref — they never close over a stale
     boot-time array and never need the listings identity in their deps. */
  const listingsRef = useRef<Listing[]>([]);
  useEffect(() => { listingsRef.current = listings; }, [listings]);

  /* boot: discover pools — retries with backoff until the chain answers
     (B-01: a single CORS blip at first paint must not dead-end the app). */
  useEffect(() => {
    let dead = false;
    let delay = 1_000;
    let timer: ReturnType<typeof setTimeout>;
    const boot = async () => {
      try {
        const ls = await discoverListings();
        if (!dead) { setListings(ls); setBooted(true); }
      } catch {
        if (!dead) { timer = setTimeout(() => void boot(), delay); delay = Math.min(delay * 2, 15_000); }
      }
    };
    void boot();
    return () => { dead = true; clearTimeout(timer); };
  }, []);

  /* price + block poll */
  useEffect(() => {
    if (!booted || listings.length === 0) return;
    let dead = false;
    const tick = async () => {
      try {
        const [ls, bn] = await Promise.all([refreshPrices(listingsRef.current), publicClient.getBlockNumber()]);
        if (!dead) { setListings(ls); setBlock(bn); }
      } catch { /* transient RPC noise — keep last-good listings/block */ }
    };
    void tick();
    const id = setInterval(tick, 10_000);
    return () => { dead = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, listings.length]);

  /* tape poll */
  useEffect(() => {
    if (!booted || listings.length === 0) return;
    let dead = false;
    const tick = async () => {
      try { const t = await fetchTape(listingsRef.current); if (!dead) setTape(t); } catch { /* keep last-good tape */ }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { dead = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, listings.length]);

  /* quote loop: debounce on order change + 15s refresh */
  const runQuote = useCallback(async () => {
    const tok = TOKEN_BY_SYMBOL.get(order.symbol);
    const amt = Number(order.amount);
    if (!tok || !order.amount || !isFinite(amt) || amt <= 0) {
      setQuote(null); setQuotedAt(null); lastQuoteKey.current = null; return;
    }
    const key = `${order.side}|${order.symbol}|${order.amount}`;
    const seq = ++quoteSeq.current;
    setQuoting(true);
    try {
      let tokenIn: Address, tokenOut: Address, amountIn: bigint;
      if (order.side === "BUY") {
        tokenIn = USDG; tokenOut = tok.address;
        amountIn = parseUnits(order.amount, 6);
      } else {
        tokenIn = tok.address; tokenOut = USDG;
        amountIn = parseUnits(order.amount, tok.decimals);
      }
      const q = await quoteRoute(tokenIn, tokenOut, amountIn);
      if (seq === quoteSeq.current) { setQuote(q); setQuotedAt(Date.now()); lastQuoteKey.current = key; }
    } catch {
      /* B-02: transport failure. If the order hasn't changed since the last
         good quote, KEEP it (the STALE badge ages it); a quote for different
         params must never be shown, so only then blank it. */
      if (seq === quoteSeq.current && lastQuoteKey.current !== key) { setQuote(null); setQuotedAt(null); }
    } finally {
      if (seq === quoteSeq.current) setQuoting(false);
    }
  }, [order]);

  useEffect(() => {
    const t = setTimeout(runQuote, 450);
    const id = setInterval(runQuote, 15_000);
    return () => { clearTimeout(t); clearInterval(id); };
  }, [runQuote]);

  /* anchor for the traded stock — fetchAnchor THROWS on transport failure
     (A-06), so a blip keeps the last-good anchor; switching stocks clears it
     immediately so the previous stock's anchor is never shown. */
  useEffect(() => {
    const tok = TOKEN_BY_SYMBOL.get(order.symbol);
    setAnchor(null);
    if (!tok) return;
    let dead = false;
    const tick = async () => {
      try {
        const a = await fetchAnchor(tok.address);
        if (!dead) setAnchor(a);
      } catch { /* transport failure — keep last-good, retry on next tick */ }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { dead = true; clearInterval(id); };
  }, [order.symbol]);

  const listing = listings.find((l) => l.token.symbol === order.symbol) ?? null;

  /* R5-02: moving between map and venue rebuilds the screen — move focus to
     the venue heading so keyboard/AT users land somewhere meaningful. */
  const venueHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { venueHeading.current?.focus({ preventScroll: true }); }, [view]);

  return (
    <div className={`crt min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-screen${view === "CREDIT" ? " theme-credit" : view === "ARENA" ? " theme-arena" : view === "INDEX" ? " theme-kingdom" : ""}`}>
      <TopBar block={block} />
      <TickerTape listings={listings} />
      {VENUE_META[view] && (
        <div className="mx-[2px] mt-[2px] panel flex items-center gap-3 px-3 py-1.5">
          <h1 ref={venueHeading} tabIndex={-1} className="panel-title !p-0 outline-none text-[inherit] m-0">
            {VENUE_META[view]!.name} <span className="text-amber-dim">· {VENUE_META[view]!.key}</span>
          </h1>
          <span className="text-txt-dim text-[10px] hidden sm:inline">{VENUE_META[view]!.desc}</span>
          <button type="button" className="fkey ml-auto px-3 py-1 text-[11px]" onClick={() => setView("WORLD")}>← MAP</button>
        </div>
      )}
      {view === "DERIVS" ? <DerivsView /> : view === "VAULT" ? <VaultView /> : view === "CREDIT" ? <CreditView /> : view === "STATS" ? <AnalyticsView /> : view === "WORLD" ? <WorldView setView={setView} /> : view === "ARENA" ? <ArenaView setView={setView} /> : view === "INDEX" ? <KingdomsView setView={setView} /> : (
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-[2px] p-[2px] min-h-0 lg:overflow-hidden">
        <div className="lg:col-span-3 flex flex-col gap-[2px] min-h-0 lg:overflow-y-auto">
          <SwapPanel
            order={order} setOrder={setOrder} listings={listings}
            quote={quote} quoting={quoting} booted={booted} quotedAt={quotedAt}
          />
          <FairPriceShield order={order} quote={quote} anchor={anchor} listing={listing} />
        </div>
        <div className="lg:col-span-5 min-h-0 flex flex-col gap-[2px]">
          <RoutingTheatre quote={quote} quoting={quoting} order={order} quotedAt={quotedAt} />
        </div>
        <div className="lg:col-span-4 min-h-0 flex flex-col gap-[2px]">
          <div className="flex-1 min-h-0">
            <MarketWatch
              listings={listings} booted={booted}
              selected={order.symbol}
              onSelect={(sym) => setOrder((o) => ({ ...o, symbol: sym }))}
            />
          </div>
          <MyFills />
        </div>
      </main>
      )}
      <TapePanel prints={tape} />
      <FKeyBar view={view} setView={setView} />
      <WalletPicker />
    </div>
  );
}
