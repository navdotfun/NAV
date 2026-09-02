/* NAV — nav.fun · The Pit: options trading floor — LIVE on Robinhood Chain.
   Every number on this page derives from live on-chain reads or user inputs.
   Orders route to source-verified PitPool contracts; the indicative breakdown
   mirrors the on-chain PitPricer, and the order path re-quotes on-chain. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Tape } from "../components/Tape";
import { Header } from "../components/Header";
import { FooterSlim } from "../components/Footer";
import { PitAssetPicker } from "../components/pit/PitAssetPicker";
import { PitChart } from "../components/pit/PitChart";
import { PositionBuilder } from "../components/pit/PositionBuilder";
import { PayoffChart } from "../components/pit/PayoffChart";
import { TradeAction } from "../components/pit/TradeAction";
import { Positions } from "../components/pit/Positions";
import { WriterPanel } from "../components/pit/WriterPanel";
import { YieldPanel } from "../components/pit/YieldPanel";
import { WalletButton } from "../components/WalletButton";
import { PIT, PIT_MARKET_COUNT, PIT_MARKETS } from "../lib/pit";
import { heartbeatCoverage } from "../lib/oracleHealth";
import { STOCK_TOKENS, type StockToken } from "../lib/data";
import { usePitPriceFeed } from "../lib/pitLive";
import { useBlockNumber } from "../lib/live";
import {
  breakeven,
  nextExpiries,
  premium,
  strikeGrid,
  yearsTo,
  type PitSide,
} from "../lib/pitPricer";
import { fmt } from "../lib/format";
import { Led } from "../components/Motion";

const DEFAULT_SYMBOL = "NVDA";

export function Pit() {
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

  /* underlying */
  const [token, setToken] = useState<StockToken | null>(
    () => STOCK_TOKENS.find((t) => t.symbol === DEFAULT_SYMBOL) ?? STOCK_TOKENS[0] ?? null,
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
  const qtyNum = Number.parseFloat(qty);
  const qtyOk = Number.isFinite(qtyNum) && qtyNum > 0;

  return (
    <div className="on-dark min-h-screen bg-ink text-paper">
      <Tape />
      <Header
        dark
        links={[
          { label: "Home", to: "/" },
          { label: "Docs", to: "/docs/the-pit" },
          { label: "FLOOR", to: "/floor/", external: true, glow: true, pill: "APP" },
        ]}
        action={<WalletButton />}
      />

      {/* deadpan status strip */}
      <div className="border-b border-ink-3 bg-ink-2">
        <div className="wrap flex flex-wrap items-baseline gap-x-5 gap-y-1 py-2.5">
          <span className="px-label text-crt"><Led />LIVE — {PIT_MARKET_COUNT} MARKETS · MAINNET</span>
          {/* "Live" = anchor recorded (fresh OR widened-clamp): the contract never
              disarms on staleness — it widens the settlement band per 24h period.
              Only genuinely cold markets (no anchor ever) block writer deposits. */}
          {coverage && coverage.cold > 0 && (
            <span
              className="px-label text-red"
              title="Cold markets have no reference price recorded yet — writer deposits are blocked there until an oracle anchor lands. Markets with an aged anchor stay live with a widened settlement clamp."
            >
              {coverage.armed + coverage.stale}/{coverage.total} ORACLES LIVE · {coverage.cold} COLD
              {coverage.stale > 0 ? ` · ${coverage.stale} WIDENED CLAMP` : ""}
            </span>
          )}
          {coverage && coverage.cold === 0 && coverage.stale > 0 && (
            <span
              className="px-label text-gold"
              title="Aged anchors widen the settlement clamp per 24h period (capped at 7×) — normal over weekends when equity feeds pause. Markets stay fully live."
            >
              {coverage.armed + coverage.stale}/{coverage.total} ORACLES LIVE · {coverage.stale} WIDENED CLAMP
            </span>
          )}
          <span className="text-[12.5px] text-muted-dark">
            Fully collateralized at write. European settlement from a 30-minute TWAP.{" "}
            <a
              className="underline decoration-dotted underline-offset-2"
              href={`https://robinhoodchain.blockscout.com/address/${PIT.factory}`}
              target="_blank"
              rel="noreferrer"
            >
              Source-verified contracts
            </a>
            .
          </span>
        </div>
      </div>

      <main className="py-9 pb-20">
        <div className="wrap">
          <div className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
            <div>
              <h1 className="text-[24px] md:text-[30px]">The Pit</h1>
              <p className="mt-1 text-[13.5px] text-muted-dark">
                Fully-collateralized weekly calls and puts on Robinhood Chain stock tokens.
                Buyer risk is the premium. No liquidations.
              </p>
            </div>
            <span className="num text-[13.5px] text-muted-dark">
              Robinhood Chain · block{" "}
              {block !== null ? <span className="text-crt">{block.toLocaleString("en-US")}</span> : "…"}
            </span>
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(340px,5fr)] xl:grid-cols-[minmax(0,1fr)_420px]">
            {/* ORDER RAIL — first in DOM: pick → configure → trade. Sticky on desktop. */}
            <aside className="order-rail grid min-w-0 gap-4 lg:order-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto dark-scroll">
              <PitAssetPicker selected={token} onPick={setToken} />
              <PositionBuilder
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
                action={
                  <TradeAction
                    market={market}
                    symbol={token?.symbol ?? ""}
                    side={side}
                    strike={strike}
                    expiry={expiry}
                    qty={qtyNum}
                    onFilled={onFilled}
                  />
                }
              />
            </aside>

            {/* MAIN — chart, payoff, writer book, tickets */}
            <div className="grid min-w-0 gap-4 lg:order-1">
              <section className="panel">
                <div className="panel-head flex-wrap">
                  <span className="px-label">
                    {token ? `${token.symbol} / USD` : "SELECT UNDERLYING"} · SLOT0 SAMPLES
                  </span>
                  <span className="num text-[13.5px] text-muted-dark">
                    {live !== null ? (
                      <>
                        last read <span className="text-crt">{fmt.usd(live)}</span>
                        {feed.entry?.status === "ok" && feed.entry.fee !== undefined
                          ? ` · v3 ${(feed.entry.fee / 10000).toFixed(2)}% / ${feed.entry.quote}`
                          : ""}
                      </>
                    ) : feed.entry?.status === "loading" || !feed.entry ? (
                      "locating pool…"
                    ) : feed.entry?.status === "error" ? (
                      "price read failed — retrying"
                    ) : (
                      "no pool with liquidity on-chain"
                    )}
                  </span>
                </div>
                <div className="p-4.5">
                  <PitChart
                    series={feed.series}
                    strike={strike}
                    breakevenPrice={be}
                    side={side}
                    symbol={token?.symbol ?? "—"}
                  />
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <span className="px-label">P&L AT EXPIRY</span>
                  <span className={`px-label ${side === "PUT" ? "text-red" : "text-crt"}`}>
                    {qtyOk ? `${qty} × ` : ""}{side}
                  </span>
                </div>
                <div className="p-4.5">
                  {live !== null && strike !== null && premiumPerUnit !== null && qtyOk ? (
                    <PayoffChart
                      side={side}
                      strike={strike}
                      qty={qtyNum}
                      premiumPerUnit={premiumPerUnit}
                      livePrice={live}
                    />
                  ) : (
                    <div className="pit-chart-empty">
                      <span className="px-label text-muted-dark">NO QUOTE</span>
                      <span className="text-[13px] text-muted-dark">
                        A payoff curve requires an underlying with a live pool, a strike, and a
                        quantity greater than zero.
                      </span>
                    </div>
                  )}
                </div>
              </section>

              <WriterPanel
                market={market}
                symbol={token?.symbol ?? ""}
                side={side}
                strike={strike}
              />

              <YieldPanel symbol={token?.symbol ?? ""} />

              <Positions refreshKey={fillCount} />

              <section className="panel">
                <div className="p-4.5 text-[13.5px] text-muted-dark">
                  Positions in The Pit are fully collateralized at write: call books escrow the
                  underlying, put books escrow the quote asset. Settlement is European, from a
                  30-minute TWAP at Monday 20:00 UTC. Every premium routes a protocol fee through
                  the existing FeeSplitter — 80% market-buys stock tokens into the NAV vault.
                  All contracts are deployed and source-verified on Blockscout — addresses in the docs.{" "}
                  <Link className="text-crt underline decoration-dotted underline-offset-2" to="/docs/the-pit">
                    Read the full spec
                  </Link>
                  .
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>

      <FooterSlim />
    </div>
  );
}
