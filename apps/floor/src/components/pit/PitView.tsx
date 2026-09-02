/* PIT view — The Pit options floor inside the terminal. LIVE on Robinhood
   Chain: every number derives from live on-chain reads or user inputs.
   Orders route to source-verified PitPool contracts; the indicative breakdown
   mirrors the on-chain PitPricer, and the order path re-quotes on-chain.
   State + derivations ported verbatim from site Pit.tsx; layout mirrors
   OptionsView.tsx (lg:grid-cols-12, three columns). */
import { useCallback, useEffect, useMemo, useState } from "react";
import { EXPLORER } from "../../lib/nav/chain";
import { PIT, PIT_MARKET_COUNT, PIT_MARKETS } from "../../lib/nav/pit";
import { STOCK_TOKENS, type StockToken } from "../../lib/nav/data";
import { usePitPriceFeed } from "../../lib/nav/pitLive";
import { useBlockNumber } from "../../lib/nav/live";
import {
  breakeven,
  nextExpiries,
  premium,
  strikeGrid,
  yearsTo,
  type PitSide,
} from "../../lib/nav/pitPricer";
import { PitTicket } from "./PitTicket";
import { PitBook } from "./PitBook";
import { PitPositions } from "./PitPositions";
import { PitWriter, heartbeatCoverage } from "./PitWriter";

const DEFAULT_SYMBOL = "NVDA";

/** The 18 live Pit markets resolved against the verified Stock Token registry.
    Every symbol in PIT_MARKETS exists in STOCK_TOKENS; the fallback constructs
    the token from the market's own on-chain underlying address. */
const PIT_TOKENS: StockToken[] = Object.entries(PIT_MARKETS).map(([sym, m]) =>
  STOCK_TOKENS.find((t) => t.symbol === sym) ?? { symbol: sym, name: sym, address: m.underlying, decimals: 18 },
);

export function PitView() {
  const block = useBlockNumber();

  /* AUDIT v3 GUARD #4 — Pit-wide oracle heartbeat coverage strip. Cold markets
     have an inert settlement clamp; the count is surfaced in the status strip. */
  const [coverage, setCoverage] = useState<{ armed: number; stale: number; cold: number; total: number } | null>(null);
  useEffect(() => {
    let stop = false;
    const underlyings = Object.values(PIT_MARKETS).map((m) => m.underlying);
    const pull = () =>
      heartbeatCoverage(underlyings)
        .then((c) => { if (!stop) setCoverage(c); })
        .catch(() => { /* banner is best-effort; per-market guards still enforce */ });
    void pull();
    const t = setInterval(pull, 120_000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  /* underlying — scoped to the 18 live PIT markets */
  const [token, setToken] = useState<StockToken | null>(
    () => PIT_TOKENS.find((t) => t.symbol === DEFAULT_SYMBOL) ?? PIT_TOKENS[0] ?? null,
  );
  const feed = usePitPriceFeed(token);
  const live = feed.last;

  /* position inputs */
  const [side, setSide] = useState<PitSide>("CALL");
  const [strike, setStrike] = useState<number | null>(null);
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [qty, setQty] = useState("1");
  const [fillCount, setFillCount] = useState(0);
  const onFilled = useCallback(() => setFillCount((c) => c + 1), []);

  /* strike grid anchored to the first live read per token (re-anchors on >10% drift
     so the grid stays stable while the price ticks) */
  const [anchor, setAnchor] = useState<number | null>(null);
  const tokenKey = token?.address ?? "";
  useEffect(() => {
    setAnchor(null);
    setStrike(null);
  }, [tokenKey]);
  useEffect(() => {
    if (live === null) return;
    setAnchor((a) => (a === null || Math.abs(live - a) / a > 0.1 ? live : a));
  }, [live]);

  /* live market for the selected underlying (null → view-only, no order path) */
  const market = token ? (PIT_MARKETS[token.symbol] ?? null) : null;
  const sigma = market ? market.sigmaBps / 10000 : undefined;

  /* strikes: live markets snap to the pool's immutable on-chain spacing;
     unlisted assets fall back to the generic indicative grid */
  const strikes = useMemo(() => {
    if (anchor === null) return [];
    if (market) {
      const spacing = Number(market.strikeSpacing) / 1e18;
      const mid = Math.max(1, Math.round(anchor / spacing));
      const out: number[] = [];
      for (let n = Math.max(1, mid - 4); n <= mid + 4; n++) out.push(Number((n * spacing).toFixed(6)));
      return out;
    }
    return strikeGrid(anchor, 4);
  }, [anchor, market]);
  useEffect(() => {
    if (strikes.length === 0) return;
    setStrike((k) => (k !== null && strikes.includes(k) ? k : strikes[Math.floor(strikes.length / 2)]));
  }, [strikes]);

  const expiries = useMemo(() => nextExpiries(4), []);
  const expiry = expiries[Math.min(expiryIdx, expiries.length - 1)];

  /* quote — PitPricer mirror on live price + inputs */
  /* AUDIT v4 UI-01 — pass the market's own sigma; omitting it silently priced
     16/18 markets with the default vol. */
  const premiumPerUnit =
    live !== null && strike !== null ? premium(side, live, strike, yearsTo(expiry), sigma) : null;
  const be = premiumPerUnit !== null && strike !== null ? breakeven(side, strike, premiumPerUnit) : null;

  return (
    <main className="flex-1 flex flex-col min-h-0">
      {/* deadpan status strip */}
      <div className="border-b border-rule bg-panel px-2 py-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[10.5px]">
        <span className="text-up font-bold tracking-[0.14em]">
          <span aria-hidden="true">●</span> LIVE — {PIT_MARKET_COUNT} MARKETS · MAINNET
        </span>
        {/* "Live" = anchor recorded (fresh OR widened-clamp): the contract never
            disarms on staleness — it widens the settlement band per 24h period.
            Only genuinely cold markets (no anchor ever) block writer deposits. */}
        {coverage && coverage.cold > 0 && (
          <span
            className="text-dn font-bold tracking-[0.1em] tabular-nums"
            title="Cold markets have no reference price recorded yet — writer deposits are blocked there until an oracle anchor lands. Markets with an aged anchor stay live with a widened settlement clamp."
          >
            {coverage.armed + coverage.stale}/{coverage.total} ORACLES LIVE · {coverage.cold} COLD
            {coverage.stale > 0 ? ` · ${coverage.stale} WIDENED CLAMP` : ""}
          </span>
        )}
        {coverage && coverage.cold === 0 && coverage.stale > 0 && (
          <span
            className="text-amber-2 font-bold tracking-[0.1em] tabular-nums"
            title="Aged anchors widen the settlement clamp per 24h period (capped at 7×) — normal over weekends when equity feeds pause. Markets stay fully live."
          >
            {coverage.armed + coverage.stale}/{coverage.total} ORACLES LIVE · {coverage.stale} WIDENED CLAMP
          </span>
        )}
        <span className="text-txt-dim">
          FULLY COLLATERALIZED AT WRITE · EUROPEAN SETTLEMENT FROM A 30-MINUTE TWAP ·{" "}
          <a
            className="text-cyan hover:underline"
            href={`${EXPLORER}/address/${PIT.factory}`}
            target="_blank"
            rel="noreferrer"
          >
            SOURCE-VERIFIED CONTRACTS
          </a>
        </span>
        <span className="ml-auto text-txt-dim tabular-nums">
          ROBINHOOD CHAIN · BLOCK{" "}
          {block !== null ? <span className="text-up">{block.toLocaleString("en-US")}</span> : "…"}
        </span>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-[2px] p-[2px] min-h-0 lg:overflow-hidden">
        {/* ORDER RAIL — pick → configure → trade */}
        <div className="lg:col-span-3 flex flex-col gap-[2px] min-h-0 lg:overflow-y-auto">
          <PitTicket
            tokens={PIT_TOKENS}
            token={token}
            onToken={setToken}
            symbol={token?.symbol ?? ""}
            side={side}
            onSide={setSide}
            strikes={strikes}
            strike={strike}
            onStrike={setStrike}
            expiries={expiries}
            expiryIdx={expiryIdx}
            onExpiry={setExpiryIdx}
            qty={qty}
            onQty={setQty}
            livePrice={live}
            premiumPerUnit={premiumPerUnit}
            sigma={sigma}
            market={market}
            onFilled={onFilled}
          />
        </div>

        {/* BOOK — per-strike writer liquidity + OI, live price header */}
        <div className="lg:col-span-5 min-h-0 flex flex-col gap-[2px] lg:overflow-y-auto">
          <PitBook
            market={market}
            symbol={token?.symbol ?? ""}
            strikes={strikes}
            strike={strike}
            onStrike={setStrike}
            side={side}
            expiry={expiry}
            live={live}
            feedEntry={feed.entry}
            refreshKey={fillCount}
          />
          {be !== null && strike !== null && (
            <div className="panel p-2 text-[10.5px] text-txt-dim flex flex-wrap gap-x-4 gap-y-0.5">
              <span>
                <span className="cell-label">BREAKEVEN AT EXPIRY </span>
                <span className={`tabular-nums font-bold ${side === "PUT" ? "text-dn" : "text-up"}`}>
                  {"$" + be.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </span>
              <span>
                <span className="cell-label">K </span>
                <span className="tabular-nums text-amber-2">
                  {"$" + strike.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </span>
              {live !== null && (
                <span>
                  <span className="cell-label">P </span>
                  <span className="tabular-nums text-txt">
                    {"$" + live.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </span>
              )}
            </div>
          )}
          <div className="panel p-2 text-[10px] leading-relaxed text-txt-dim">
            POSITIONS IN THE PIT ARE FULLY COLLATERALIZED AT WRITE: CALL BOOKS ESCROW THE UNDERLYING,
            PUT BOOKS ESCROW THE QUOTE ASSET. SETTLEMENT IS EUROPEAN, FROM A 30-MINUTE TWAP AT MONDAY
            20:00 UTC. EVERY PREMIUM ROUTES A PROTOCOL FEE THROUGH THE EXISTING FEESPLITTER — 80%
            MARKET-BUYS STOCK TOKENS INTO THE NAV VAULT. ALL CONTRACTS ARE DEPLOYED AND
            SOURCE-VERIFIED ON BLOCKSCOUT. BUYER RISK IS THE PREMIUM. NO LIQUIDATIONS.
          </div>
        </div>

        {/* TICKETS + WRITER DESK */}
        <div className="lg:col-span-4 flex flex-col gap-[2px] min-h-0 lg:overflow-y-auto">
          <PitPositions refreshKey={fillCount} />
          <PitWriter
            market={market}
            symbol={token?.symbol ?? ""}
            side={side}
            strike={strike}
          />
        </div>
      </div>
    </main>
  );
}
