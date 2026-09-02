import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { Tape } from "../components/Tape";
import { Header } from "../components/Header";
import { WalletButton } from "../components/WalletButton";
import { YourPosition } from "../components/YourPosition";
import { FooterSlim } from "../components/Footer";
import { Identicon } from "../components/Identicon";
import { NavChart } from "../components/NavChart";
import { STOCK_TOKENS, STOCK_TOKEN_COUNT, type StockToken } from "../lib/data";
import { RedeemPreview } from "../components/RedeemPreview";
import { LAUNCH, PROTOCOL, TGE, useNavMarket, useVaultState } from "../lib/protocol";
import { EXPLORER, shortAddr } from "../lib/chain";
import { getPriceEntry, useBlockNumber, useEthUsd, useInView, usePriceFeed, useTokenPrice } from "../lib/live";
import { fmt } from "../lib/format";
import certImg from "../assets/certificates.png";
import { Led } from "../components/Motion";
import { CrankPanel } from "../components/CrankPanel";
import { requestConnect, ensureChain, useWallet } from "../lib/wallet";
import {
  quoteBuyEth, quoteBuyUsdg, sendBuy, sendRedeem,
  SLIPPAGE_BPS, type PayAsset, type TxPhase,
} from "../lib/tx";
import { TxStatusLine } from "../components/TxStatusLine";
import { useVaultHistory } from "../lib/history";
import { AcquisitionLedger, type LedgerRow } from "../components/AcquisitionLedger";

/** "31 AUG 22:41" — UTC stamp for chart labels and ledger rows. */
function utcStamp(t: number): string {
  const d = new Date(t * 1000);
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" }).toUpperCase();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${mon} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/* USDC intentionally absent: it has no Uniswap v3 route to WETH or USDG on
   this chain (factory probed 31 Aug 2026) — offering it would just revert. */
const PAY_ASSETS = ["ETH", "USDG"] as const satisfies readonly PayAsset[];

function TokenRow({ token, index, vaultQty }: { token: StockToken; index: number; vaultQty: bigint | null | undefined }) {
  const { ref, inView } = useInView<HTMLTableRowElement>();
  const p = useTokenPrice(token, inView);
  return (
    <tr ref={ref}>
      <td className="num text-muted-dark">{String(index + 1).padStart(3, "0")}</td>
      <td>
        <span className="tk">
          <Identicon t={token.symbol} />
          <span className="tk-sym">{token.symbol}</span>
          <span className="tk-name">{token.name}</span>
        </span>
      </td>
      <td className="num">
        {p?.status === "ok" && p.price !== undefined ? (
          fmt.usd(p.price)
        ) : p?.status === "loading" ? (
          <span className="text-muted-dark">…</span>
        ) : p?.status === "none" ? (
          <span className="text-muted-dark" title="No Uniswap v3 pool with liquidity found on-chain">no pool</span>
        ) : p?.status === "error" ? (
          <span className="text-muted-dark" title="RPC read failed — retrying with backoff">retrying…</span>
        ) : (
          <span className="text-muted-dark">·</span>
        )}
      </td>
      <td className="num">
        {p?.status === "ok" && p.fee !== undefined ? (
          <span className="text-muted-dark">v3 · {(p.fee / 10000).toFixed(2)}% / {p.quote}</span>
        ) : (
          <span className="text-muted-dark">—</span>
        )}
      </td>
      <td className="num">
        <a
          className="text-muted-dark hover:text-crt no-underline"
          href={`${EXPLORER}/token/${token.address}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {shortAddr(token.address)}
        </a>
      </td>
      <td className="num text-muted-dark">
        {vaultQty === undefined ? (
          <span title="Not yet registered in the vault">—</span>
        ) : vaultQty === null ? (
          "…"
        ) : vaultQty === 0n ? (
          <span title="Registered in the vault — awaiting its first accumulation epoch">0</span>
        ) : (
          (Number(vaultQty) / 10 ** token.decimals).toLocaleString("en-US", { maximumFractionDigits: 4 })
        )}
      </td>
    </tr>
  );
}

/** Genesis mint — fixed at deploy; supply can only fall from here (ERC20Burnable, no mint function). */
const GENESIS_SUPPLY = 1_000_000_000;

export function Dashboard() {
  const block = useBlockNumber();
  const ethUsd = useEthUsd();
  const vault = useVaultState();
  const navMkt = useNavMarket();
  const navMktUsd =
    navMkt.status === "ok" && navMkt.priceEth !== null && ethUsd?.status === "ok" && ethUsd.price !== undefined
      ? navMkt.priceEth * ethUsd.price
      : null;
  const navMktCap = navMktUsd !== null && vault.totalSupply !== null
    ? navMktUsd * (Number(vault.totalSupply) / 1e18)
    : null;

  /* AUDIT v3 GUARD #2 (P3-05) — NAVVault.redeemInKind skips inactive assets
     WITHOUT crediting the holder, so redeeming while any listed asset is
     inactive permanently forfeits that slice. Fails closed: a live vault whose
     inactive set is unknown counts as blocked. */
  const redeemBlocked = vault.status === "live" && (vault.inactiveAssets?.length ?? 0) > 0;

  /* Live vault valuation (H-03): value the registry holdings at live Uniswap
     prices. Zero-balance holdings contribute exactly 0 without a price read. */
  const holdingsByAddr = useMemo(() => {
    const map = new Map<string, bigint>();
    vault.holdings?.forEach((h) => map.set(h.address.toLowerCase(), h.balance));
    return map;
  }, [vault.holdings]);
  const nonZeroTokens = useMemo(
    () => STOCK_TOKENS.filter((t) => (holdingsByAddr.get(t.address.toLowerCase()) ?? 0n) > 0n),
    [holdingsByAddr],
  );
  /* Acquisition history — rebuilt from raw chain logs (lib/history). Fill
     tokens join the price feed so historic fills value at live prices even
     if a redemption later empties the balance. */
  const history = useVaultHistory();
  const tokenByAddr = useMemo(
    () => new Map(STOCK_TOKENS.map((t) => [t.address.toLowerCase(), t])),
    [],
  );
  const feedTokens = useMemo(() => {
    const map = new Map(nonZeroTokens.map((t) => [t.address.toLowerCase(), t]));
    for (const f of history.fills) {
      const meta = tokenByAddr.get(f.token.toLowerCase());
      if (meta) map.set(meta.address.toLowerCase(), meta);
    }
    return [...map.values()];
  }, [nonZeroTokens, history.fills, tokenByAddr]);
  const priceTick = usePriceFeed(feedTokens);
  const vaultValue = useMemo(() => {
    if (vault.status !== "live" || vault.holdings === null) return null;
    let usd = 0;
    for (const t of nonZeroTokens) {
      const p = getPriceEntry(t.address);
      if (!p || p.status === "loading") return null; // still resolving
      if (p.status === "ok" && p.price !== undefined) {
        usd += (Number(holdingsByAddr.get(t.address.toLowerCase()) ?? 0n) / 10 ** t.decimals) * p.price;
      }
    }
    return usd;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.status, vault.holdings, nonZeroTokens, holdingsByAddr, priceTick]);
  const navPerToken = useMemo(() => {
    if (vaultValue === null || vault.totalSupply === null || vault.totalSupply === 0n) return null;
    return vaultValue / (Number(vault.totalSupply) / 1e18);
  }, [vaultValue, vault.totalSupply]);

  /* Epoch chart + ledger: replay the log-derived fills chronologically,
     valuing the cumulative basket at live Uniswap prices after each one.
     Every number is either a chain log or a live pool read — nothing else. */
  const chartData = useMemo(() => {
    if (history.status !== "ok" || history.fills.length === 0) return null;
    const cum = new Map<string, bigint>();
    const labels: string[] = [];
    const data: number[] = [];
    const rows: LedgerRow[] = [];
    let priced = true;
    for (const f of history.fills) {
      const key = f.token.toLowerCase();
      cum.set(key, (cum.get(key) ?? 0n) + (f.direction === "in" ? f.amount : -f.amount));
      const meta = tokenByAddr.get(key);
      const qty = Number(f.amount) / 10 ** (meta?.decimals ?? 18);
      const entry = meta ? getPriceEntry(meta.address) : null;
      const px = entry && entry.status === "ok" && entry.price !== undefined ? entry.price : null;
      rows.push({
        key: `${f.tx}-${rows.length}`,
        symbol: meta?.symbol ?? `${f.token.slice(0, 6)}…${f.token.slice(-4)}`,
        qty,
        usd: px !== null ? qty * px : null,
        direction: f.direction,
        when: utcStamp(f.time),
        tx: f.tx,
      });
      let usd = 0;
      for (const [addr, bal] of cum) {
        if (bal <= 0n) continue;
        const m = tokenByAddr.get(addr);
        const e = m ? getPriceEntry(m.address) : null;
        if (!m || !e || e.status === "loading") { priced = false; continue; }
        if (e.status === "ok" && e.price !== undefined) usd += (Number(bal) / 10 ** m.decimals) * e.price;
      }
      labels.push(utcStamp(f.time));
      data.push(usd);
    }
    const series = priced
      ? {
          labels: [...labels, "NOW"],
          data: [...data, vaultValue ?? data[data.length - 1]],
        }
      : null;
    return { series, rows: rows.reverse() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, priceTick, tokenByAddr, vaultValue]);
  const statusBadge =
    vault.status === "live" ? LAUNCH.badge
      : vault.status === "loading" ? "SYNCING…"
      : vault.status === "error" ? "RPC ERROR — RETRY"
      : "PRE-LAUNCH";

  /* universe filter */
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    return STOCK_TOKENS.filter((x) => !q || x.symbol.toUpperCase().includes(q) || x.name.toUpperCase().includes(q));
  }, [query]);

  /* trade panel */
  const wallet = useWallet();
  const connected = wallet.status === "connected";
  const wrongChain = wallet.status === "wrong-chain";
  const [tab, setTab] = useState<"buy" | "redeem">("buy");
  const [payAsset, setPayAsset] = useState<PayAsset>("ETH");
  const [buyAmt, setBuyAmt] = useState("");
  const [rdAmt, setRdAmt] = useState("");
  const [buyPhase, setBuyPhase] = useState<TxPhase>({ step: "idle" });
  const [rdPhase, setRdPhase] = useState<TxPhase>({ step: "idle" });

  const ethUsdPrice = ethUsd?.status === "ok" && ethUsd.price !== undefined ? ethUsd.price : null;
  const quote = useMemo(
    () => (payAsset === "ETH"
      ? quoteBuyEth(buyAmt, navMkt.priceEth)
      : quoteBuyUsdg(buyAmt, navMkt.priceEth, ethUsdPrice)),
    [payAsset, buyAmt, navMkt.priceEth, ethUsdPrice],
  );
  const buyBusy = buyPhase.step === "pending" || buyPhase.step === "approving";
  const rdShares = useMemo(() => {
    const n = Number(rdAmt);
    if (!Number.isFinite(n) || n <= 0) return null;
    try { return parseUnits(rdAmt, 18); } catch { return null; }
  }, [rdAmt]);
  const rdBusy = rdPhase.step === "pending";

  const prelaunch = vault.status === "prelaunch";
  const dash = <span aria-label="value unavailable — chain read retrying">—</span>;

  return (
    <div className="on-dark min-h-screen bg-ink text-paper">
      <Tape />
      <Header
        dark
        links={[
          { label: "Home", to: "/" },
          { label: "Protocol", to: "/#protocol", hash: true },
          { label: "Docs", to: "/docs" },
          { label: "FLOOR", to: "/floor/", external: true, glow: true, pill: "APP" },
        ]}
        action={<WalletButton />}
      />

      <main className="py-9 pb-20">
        <div className="wrap">
          <div className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
            <h1 className="text-[24px] md:text-[30px]">
              Vault Terminal <span className="demo-badge">{statusBadge}</span>
            </h1>
            <span className="num text-[13.5px] text-muted-dark">
              Robinhood Chain · block{" "}
              {block !== null ? <span className="text-crt">{block.toLocaleString("en-US")}</span> : "…"}
              {" "}· $NAV:{" "}
              <a
                className="text-crt underline decoration-dotted underline-offset-2"
                href={`${EXPLORER}/address/${PROTOCOL.tokenAddress ?? ""}`}
                target="_blank"
                rel="noreferrer"
              >
                {PROTOCOL.tokenAddress ? `${shortAddr(PROTOCOL.tokenAddress)} ✓` : "—"}
              </a>
            </span>
          </div>

          <YourPosition />

          {/* KPIs */}
          <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-3 lg:gap-4">
            {[
              {
                label: "$NAV PRICE",
                value: navMktUsd !== null ? fmt.usdTiny(navMktUsd) : navMkt.status === "error" ? dash : "…",
                sub: (
                  <span className="up">
                    live · NAV/WETH 1% pool slot0 ·{" "}
                    <a className="underline decoration-dotted" href={`https://robinhoodchain.blockscout.com/address/${TGE.poolAddress}`} target="_blank" rel="noreferrer">pool</a>
                  </span>
                ),
              },
              {
                label: "MARKET CAP",
                value: navMktCap !== null ? fmt.usdCompact(navMktCap) : navMkt.status === "error" ? dash : "…",
                sub: (
                  <span>
                    price × live supply ·{" "}
                    <a className="underline decoration-dotted" href={`https://robinhoodchain.blockscout.com/address/${TGE.lpTimelock}?tab=contract`} target="_blank" rel="noreferrer">LP locked → 2 DEC 2026</a>
                  </span>
                ),
              },
              {
                label: "NAV / TOKEN",
                value: prelaunch ? dash : navPerToken !== null ? fmt.usdTiny(navPerToken) : vault.status === "error" ? dash : "…",
                sub: navPerToken === 0 ? "vault seeds from live fee flow — 80% of protocol fees" : "Σ holdings × price ÷ supply · live",
              },
              {
                label: "$NAV SUPPLY",
                value: prelaunch ? dash : vault.totalSupply !== null ? fmt.compact(Number(vault.totalSupply) / 1e18) : vault.status === "error" ? dash : "…",
                sub: "of 1B genesis · burns on every redemption",
              },
              {
                label: "ETH / USD",
                value: ethUsd?.status === "ok" && ethUsd.price !== undefined ? fmt.usd(ethUsd.price) : ethUsd?.status === "loading" || !ethUsd ? "…" : dash,
                sub: <span className="up">live · Uniswap v3 WETH/{ethUsd?.quote ?? "USDG"} slot0</span>,
              },
              {
                label: "VAULT VALUE",
                value: prelaunch ? dash : vaultValue !== null ? fmt.usd(vaultValue) : vault.status === "error" ? dash : "…",
                sub: vaultValue === 0
                  ? `${vault.holdings?.length ?? 0} assets registered · seeding from fee flow`
                  : "Σ holdings × live Uniswap price",
              },
            ].map((k) => (
              <div key={k.label} className="panel px-4 py-4 lg:px-5 lg:py-5">
                <div className="stat-label">{k.label}</div>
                <div className="stat-value num text-[21px] md:text-[28px]">{k.value}</div>
                <div className="stat-sub text-[12.5px]">{k.sub}</div>
              </div>
            ))}
          </div>

          {/* BURN TRACKER — genesis 1B minus live totalSupply(); covers fee-flow
              burns and every in-kind-redemption burn. Pure chain read, no indexer. */}
          <div className="panel mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 lg:px-5">
            <span className="stat-label">NAV BURNED · TOTAL</span>
            <span className="stat-value num text-[19px] text-gold md:text-[22px]">
              {vault.totalSupply !== null ? fmt.compact(GENESIS_SUPPLY - Number(vault.totalSupply) / 1e18) : vault.status === "error" ? dash : "…"}
            </span>
            <span className="stat-sub text-[12.5px]">
              {vault.totalSupply !== null
                ? `${(((GENESIS_SUPPLY - Number(vault.totalSupply) / 1e18) / GENESIS_SUPPLY) * 100).toFixed(3)}% of 1B genesis · `
                : ""}
              supply only goes down — fee-flow burns + redemption burns ·{" "}
              <a className="underline decoration-dotted" href={`${EXPLORER}/tx/0xf9d112dfdd82d2cbe32085297f120d5c1deaf7799928ed93337ffd59164b39d0`} target="_blank" rel="noreferrer">22.38M fee-flow burn tx ↗</a>
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-start">
            {/* left: chart + universe */}
            <div className="grid gap-4 min-w-0">
              <section className="panel">
                <div className="panel-head">
                  <span className="px-label">VAULT GROWTH · SINCE TGE</span>
                  <span className="text-[12.5px] text-muted-dark">one step per accumulation epoch · valued at live prices</span>
                </div>
                <div className="p-4.5">
                  <NavChart
                    series={chartData?.series ?? null}
                    placeholder={{
                      badge:
                        history.status === "error" ? "CHAIN READ — RETRYING…"
                          : chartData ? "PRICING HOLDINGS…"
                          : history.status === "loading" ? "READING CHAIN LOGS…"
                          : LAUNCH.chartBadge,
                      note: "The series is replayed from the vault's raw on-chain transfer logs and valued at live Uniswap prices — one step per accumulation epoch. No indexer, no synthetic history.",
                    }}
                  />
                  <AcquisitionLedger rows={chartData?.rows ?? []} />
                </div>
              </section>

              <section className="panel" id="holdings">
                <div className="panel-head flex-wrap">
                  <span className="px-label">STOCK TOKEN UNIVERSE · {rows.length} OF {STOCK_TOKEN_COUNT} VERIFIED</span>
                  <input
                    className="search-box"
                    type="search"
                    placeholder="FILTER: AAPL…"
                    aria-label="Filter stock tokens"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className="holdings-scroll dark-scroll">
                  <table className="fin">
                    <thead>
                      <tr>
                        <th>#</th><th>Token</th><th className="num">Price · live</th>
                        <th className="num">Pool</th><th className="num">Contract</th><th className="num">Vault qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="!text-center text-muted-dark py-7">
                            No tokens match “{query.trim().toUpperCase()}”.
                          </td>
                        </tr>
                      ) : (
                        rows.map((x) => (
                          <TokenRow
                            key={x.address}
                            token={x}
                            index={STOCK_TOKENS.indexOf(x)}
                            vaultQty={vault.holdings === null ? null : holdingsByAddr.has(x.address.toLowerCase()) ? holdingsByAddr.get(x.address.toLowerCase()) : undefined}
                          />
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap justify-between gap-2.5 border-t border-ink-3 px-4 py-3 text-[12.5px] text-muted-dark">
                  <span>
                    {STOCK_TOKEN_COUNT} on-chain-verified Stock Token contracts · prices read live from Uniswap v3 ·
                    vault holdings accrue from live fee flow
                  </span>
                  <span className="px-label text-crt"><Led />LIVE CHAIN DATA</span>
                </div>
              </section>
            </div>

            {/* right: trade + protocol parameters */}
            <div className="grid gap-4 min-w-0">
              <section className="panel">
                <div className="flex border-b border-ink-3" role="tablist">
                  <button className={`trade-tab ${tab === "buy" ? "active" : ""}`} role="tab" aria-selected={tab === "buy"} onClick={() => setTab("buy")}>
                    BUY $NAV
                  </button>
                  <button className={`trade-tab ${tab === "redeem" ? "active" : ""}`} role="tab" aria-selected={tab === "redeem"} onClick={() => setTab("redeem")}>
                    REDEEM IN-KIND
                  </button>
                </div>

                {tab === "buy" ? (
                  <div className="p-4.5">
                    <div className="mb-3.5">
                      <span className="field-label">You pay with</span>
                      <div className="flex gap-1.5 mb-2.5" role="radiogroup" aria-label="Input asset">
                        {PAY_ASSETS.map((a) => (
                          <button
                            key={a}
                            role="radio"
                            aria-checked={payAsset === a}
                            className={`asset-pick ${payAsset === a ? "active" : ""}`}
                            onClick={() => setPayAsset(a)}
                          >
                            {a}
                          </button>
                        ))}
                      </div>
                      <div className="amt-row">
                        <input id="buy-amt" type="number" min="0" placeholder="0.00" inputMode="decimal" aria-label="Amount you pay" value={buyAmt} onChange={(e) => setBuyAmt(e.target.value)} />
                        <span className="asset">{payAsset}</span>
                      </div>
                    </div>
                    <div className="mb-3.5">
                      <label className="field-label" htmlFor="buy-out">You receive (est.)</label>
                      <div className="amt-row">
                        <input id="buy-out" type="text" readOnly placeholder="—" value={quote ? fmt.compact(quote.navOut) : ""} />
                        <span className="asset">$NAV</span>
                      </div>
                    </div>
                    <div className="my-4 grid gap-1.5 text-[13px] text-muted-dark">
                      <div className="flex justify-between gap-3"><span>Route</span><b className="num font-medium text-paper">{payAsset === "ETH" ? "ETH → $NAV" : "USDG → WETH → $NAV"} · Uniswap v3</b></div>
                      <div className="flex justify-between gap-3"><span>Pool fee</span><b className="num font-medium text-paper">{payAsset === "ETH" ? "1%" : "1% + 0.05%"} → locked protocol LP</b></div>
                      <div className="flex justify-between gap-3">
                        <span>Min. received ({(Number(SLIPPAGE_BPS) / 100).toFixed(1)}% slippage)</span>
                        <b className="num font-medium text-paper">{quote ? `${fmt.compact(Number(quote.minOut) / 1e18)} $NAV` : "—"}</b>
                      </div>
                    </div>
                    <button
                      className="btn btn-primary w-full py-3.5 text-[15px]"
                      disabled={buyBusy || (connected && (!quote || navMkt.status !== "ok"))}
                      title={wrongChain ? "Your wallet is on another network — switch to Robinhood Chain (4663)" : !connected ? "Connect a wallet to buy $NAV" : !quote ? "Enter an amount" : "Simulated before signing · min-out enforced on-chain"}
                      onClick={() => {
                        if (wrongChain) { void ensureChain(); return; }
                        if (!connected) { requestConnect(); return; }
                        if (!quote) return;
                        void sendBuy(payAsset, quote.amountIn, quote.minOut, setBuyPhase);
                      }}
                    >
                      {wrongChain ? "SWITCH TO ROBINHOOD CHAIN" : !connected ? "CONNECT WALLET" : buyBusy ? "BUYING…" : "BUY $NAV"}
                    </button>
                    <TxStatusLine phase={buyPhase} />
                  </div>
                ) : (
                  <div className="p-4.5">
                    <div className="mb-3.5">
                      <label className="field-label" htmlFor="rd-amt">Burn</label>
                      <div className="amt-row">
                        <input id="rd-amt" type="number" min="0" placeholder="0.00" inputMode="decimal" value={rdAmt} onChange={(e) => setRdAmt(e.target.value)} />
                        <span className="asset">$NAV</span>
                      </div>
                    </div>
                    <RedeemPreview vault={vault} amt={rdAmt} onMax={setRdAmt} />
                    <div className="my-4 grid gap-1.5 text-[13px] text-muted-dark">
                      <div className="flex justify-between gap-3"><span>Exit fee</span><b className="num font-medium text-paper">0.5%</b></div>
                      <div className="flex justify-between gap-3"><span>Fee destination</span><b className="font-medium text-paper">Paid back into the vault</b></div>
                      <div className="flex justify-between gap-3"><span>Effect</span><b className="font-medium text-paper">Increases NAV for every remaining holder</b></div>
                      <div className="flex justify-between gap-3"><span>Delivery</span><b className="font-medium text-paper">Direct to wallet, one tx</b></div>
                      <div className="flex justify-between gap-3">
                        <span>Registry status</span>
                        <b className={`font-medium ${redeemBlocked ? "text-red" : "text-paper"}`}>
                          {vault.inactiveAssets === null
                            ? "checking…"
                            : redeemBlocked
                              ? `${vault.inactiveAssets.length} asset${vault.inactiveAssets.length === 1 ? "" : "s"} inactive`
                              : "all assets active"}
                        </b>
                      </div>
                    </div>

                    {/* AUDIT v3 GUARD #2 (P3-05) — redeemInKind silently forfeits the
                        slice of any asset flagged inactive. Hard-block, never warn. */}
                    {redeemBlocked && (
                      <div className="status-plate mb-3">
                        <span className="px-label text-red">REDEMPTION LOCKED — ASSET INACTIVE</span>
                        <span className="text-[12.5px] text-muted-dark">
                          {vault.inactiveAssets!.length} vault asset
                          {vault.inactiveAssets!.length === 1 ? " is" : "s are"} currently flagged
                          inactive. Redeeming now would burn your $NAV and{" "}
                          <b className="text-paper">permanently forfeit</b> your slice of{" "}
                          {vault.inactiveAssets!.length === 1 ? "that asset" : "those assets"} with no
                          credit recorded. Redemption reopens automatically once every listed asset is
                          active again.
                        </span>
                      </div>
                    )}

                    <button
                      className="btn w-full py-3.5 text-[15px] !border-gold !text-gold"
                      disabled={rdBusy || redeemBlocked || vault.inactiveAssets === null || (connected && rdShares === null)}
                      title={
                        redeemBlocked ? "Redemption locked — a vault asset is inactive"
                          : vault.inactiveAssets === null ? "Checking asset registry…"
                          : wrongChain ? "Your wallet is on another network — switch to Robinhood Chain (4663)"
                          : !connected ? "Connect a wallet to redeem"
                          : rdShares === null ? "Enter a $NAV amount"
                          : "redeemInKindGuarded · fee pinned at 0.5% · simulated before signing"
                      }
                      onClick={() => {
                        if (wrongChain) { void ensureChain(); return; }
                        if (!connected) { requestConnect(); return; }
                        if (rdShares === null || redeemBlocked) return;
                        void sendRedeem(rdShares, setRdPhase);
                      }}
                    >
                      {redeemBlocked ? "Redemption locked — asset inactive"
                        : wrongChain ? "SWITCH TO ROBINHOOD CHAIN"
                        : !connected ? "CONNECT WALLET"
                        : rdBusy ? "REDEEMING…"
                        : "REDEEM IN-KIND · BURN $NAV"}
                    </button>
                    <TxStatusLine phase={rdPhase} />
                  </div>
                )}
              </section>

              <CrankPanel />

              <section className="panel">
                <div className="panel-head">
                  <span className="px-label">PROTOCOL PARAMETERS</span>
                  <span className="px-label text-crt"><Led />ON-CHAIN</span>
                </div>
                <div className="p-4.5">
                  <div>
                    {[
                      { k: "Uniswap pool fee (buy/sell $NAV)", v: "1% → locked protocol LP" },
                      { k: "Collected-fee split", v: "80% vault · 15% ops · 5% LP" },
                      { k: "In-kind redemption exit fee", v: "0.5% → stays in vault" },
                      { k: "Wallet-to-wallet transfer tax", v: "None — no tax, no hooks" },
                      { k: "Keeper reward (public cranks)", v: "0.10% of amount moved" },
                    ].map((r) => (
                      <div key={r.k} className="flex items-baseline justify-between gap-3 border-b border-[rgba(143,163,184,0.1)] py-2.5 text-sm">
                        <span className="text-muted-dark">{r.k}</span>
                        <span className="num font-medium">{r.v}</span>
                      </div>
                    ))}
                    <div className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
                      <span className="text-muted-dark">First accumulation epoch</span>
                      <span className="px-label text-crt">EXECUTED · 31 AUG 2026</span>
                    </div>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <span className="px-label">CHAIN STATUS</span>
                  <span className="px-label text-crt"><Led />LIVE</span>
                </div>
                <div className="p-4.5">
                  {[
                    {
                      k: "Latest block",
                      v: block !== null ? <span className="num text-crt">{block.toLocaleString("en-US")}</span> : "…",
                    },
                    { k: "Chain", v: "Robinhood Chain · 4663" },
                    {
                      k: "ETH / USD",
                      v: ethUsd?.status === "ok" && ethUsd.price !== undefined ? <span className="num">{fmt.usd(ethUsd.price)}</span> : "…",
                    },
                    {
                      k: "Explorer",
                      v: (
                        <a className="text-crt no-underline hover:underline" href={EXPLORER} target="_blank" rel="noopener noreferrer">
                          blockscout ↗
                        </a>
                      ),
                    },
                  ].map((r) => (
                    <div key={r.k} className="flex items-baseline justify-between gap-3 border-b border-[rgba(143,163,184,0.1)] py-2.5 text-sm last:border-b-0">
                      <span className="text-muted-dark">{r.k}</span>
                      <span className="font-medium">{r.v}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="panel">
                <div className="flex items-center gap-4 p-4.5">
                  <img className="px h-[72px] w-[72px] flex-none" src={certImg} alt="Pixel-art stock certificates with a gold seal" />
                  <p className="text-[13.5px] text-muted-dark">
                    Redemptions are <b className="text-paper">in-kind</b>: you receive the underlying stock tokens
                    themselves — not cash, not an IOU. The 0.5% exit fee stays in the vault, so every
                    redemption nudges NAV up for everyone who stays.
                  </p>
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
