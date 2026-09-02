/* ============================================================================
   HOME — R4.1 "THE GREEN EXCHANGE FLOOR"
   The daylight inverse of the amber Floor terminal: Robinhood green on cool
   silver, brushed-metal chrome, phosphor-jewel screens, ruled ledgers.

   Discipline:
   - ONE door into the app: the header's Launch App button → /floor/.
     Everything else is at most a plain inline text link.
   - The homepage previews and points — it never re-implements the app. No
     swap, vault, or derivatives functionality is rebuilt here; the
     derivatives section is a short editorial panel (the desk lives at F2
     DERIVS inside the Floor terminal, whose #pit anchor id survives here).
   - Every number is a live hook read or an imported constant; addresses are
     never hand-typed. Loading renders "…", errors render "—".
   - Each fact is rendered exactly once (owner-directed exception: the three
     derivatives contracts carry verify links in the editorial panel AND sit
     in the complete registry).
   - Mobile ≤ 8500px at 375px: compressed copy, m-hide/m-trim helpers, the
     top tape is the single horizontal scroller.
   ========================================================================== */
import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Address } from "viem";
import { Tape } from "../components/Tape";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { Identicon } from "../components/Identicon";
import { STOCK_TOKENS, STOCK_TOKEN_COUNT, type StockToken } from "../lib/data";
import { EXPLORER, robinhoodChain, shortAddr } from "../lib/chain";
import { LAUNCH, PROTOCOL, TGE, useNavMarket, useVaultState, type VaultState } from "../lib/protocol";
import { useEthUsd, useInView, useTokenPrice } from "../lib/live";
import { fmt } from "../lib/format";
import { WallStreetScene } from "../components/WallStreetBanner";
import { PIT, PIT_MARKET_COUNT } from "../lib/pit";
import {
  CREDIT_FACTORY,
  CREDIT_MARKETS,
  CREDIT_ORIGINATION_BPS,
  CREDIT_RESERVE_FACTOR_PCT,
  CREDIT_CAMPAIGN_CHECKS_M,
} from "../lib/credit";
import CreditEngine from "../components/CreditEngine";
import { YIELD_VAULTS } from "../lib/yield";
import { Reveal, CountUp, Led } from "../components/Motion";
import coinsImg from "../assets/coins.gif";
import vaultImg from "../assets/vault.gif";
import walletImg from "../assets/wallet.gif";

/* GPU market-depth field — lazy chunk, requested only after first paint and
   only when the device clears the capability gate below. */
const HeroField = lazy(() => import("../components/HeroField"));

function useHeroFx() {
  const [fx, setFx] = useState(false);
  useEffect(() => {
    const capable = () => {
      try {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
        if (window.innerWidth < 768) return false;
        if ((navigator.hardwareConcurrency ?? 0) < 4) return false;
        const c = document.createElement("canvas");
        return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
      } catch {
        return false;
      }
    };
    type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
    const w = window as IdleWindow;
    const schedule = (cb: () => void) =>
      w.requestIdleCallback ? w.requestIdleCallback(cb, { timeout: 1200 }) : window.setTimeout(cb, 350);
    schedule(() => {
      if (capable()) setFx(true);
    });
  }, []);
  return fx;
}

const STEPS = [
  {
    no: "STEP 01",
    img: coinsImg,
    alt: "Animated pixel-art gold coins arcing into the fee intake, LED flashing on each capture",
    title: "Fees accrue",
    body: "Every swap pays the pool's 1% fee. The LP is 100% protocol-owned and locked, so every fee is captured and split 80/15/5 — vault, ops, LP incentives — with the 80% routed to the buy engine.",
    drift: false,
    contract: "FeeSplitter",
    addr: PROTOCOL.feeSplitterAddress,
  },
  {
    no: "STEP 02",
    img: vaultImg,
    alt: "Animated pixel-art brushed-steel vault door with a spinning spoke wheel and gold hub",
    title: "The vault buys everything",
    body: "Fees market-buy the verified Stock Tokens on Robinhood Chain — the whole list, never a pick — into an on-chain vault. Holding $NAV is holding the vault, pro-rata.",
    drift: false,
    contract: "AccumulatorV2",
    addr: PROTOCOL.accumulatorAddress,
  },
  {
    no: "STEP 03",
    img: walletImg,
    alt: "Animated pixel-art wallet with stock certificates rising out and a gold coin flipping",
    title: "Redeem in-kind",
    body: "Burn $NAV any time and your exact slice of every stock token lands in your wallet. The 0.5% exit fee stays in the vault, lifting NAV for everyone who stays.",
    drift: false,
    contract: "NAVVault",
    addr: PROTOCOL.vaultAddress,
  },
] as const;

const GUARANTEES = [
  {
    no: "G-01",
    title: "No manufactured liquidity",
    body: `100% of the Uniswap LP is protocol-owned, locked in an on-chain timelock (LP NFT #${TGE.lpTokenId}). No market-maker deals, no rented depth.`,
  },
  {
    no: "G-02",
    title: "Insolvency-impossible derivatives",
    body: "Both books escrow the maximum payout at open — call books hold the stock, put books hold the quote asset. No liquidations, no margin calls, no bad debt.",
  },
  {
    no: "G-03",
    title: "Nothing off-chain",
    body: "No indexer, no backend, no admin server. This page and the FLOOR terminal render from public RPC in your browser. If nav.fun vanished tomorrow, the protocol would not notice.",
  },
  {
    no: "G-04",
    title: "A closed fee loop",
    body: "The pool's 1% swap fee and the desk's premium fees split 80/15/5 through the FeeSplitter; the 0.5% redemption fee never leaves the vault at all.",
  },
] as const;

const TOKENOMICS = [
  { k: "SUPPLY", big: "1,000,000,000", body: "Fixed at TGE. Supply only falls — every in-kind redemption burns $NAV forever." },
  { k: "FEE", big: "1% per swap", body: "100% of the LP is protocol-owned and locked, so every fee is captured and split 80/15/5. Derivatives premiums route the same split." },
  { k: "FEE DESTINATION", big: "80% → vault", body: "The accumulation share market-buys stock tokens every epoch — enforced on-chain by the FeeSplitter." },
  { k: "REDEMPTION", big: "In-kind, any time", body: "Burn $NAV for your pro-rata slice of every holding. The 0.5% exit fee accrues to remaining holders. No lockup, no permission." },
  { k: "CHAIN", big: "Robinhood Chain", body: "An Arbitrum Orbit L2 where real equities live as tokens. NAV buys all of them, indiscriminately." },
  { k: "VAULT STANDARD", big: "ERC-4626 style", body: "The boring, industry-standard vault interface, extended for a multi-asset basket." },
] as const;

const DOCS = [
  { no: "01", title: "Litepaper", to: "/docs/litepaper", body: "The mechanism in four pages: fee routing, buy cadence, vault accounting, redemption math." },
  { no: "02", title: "Contracts", to: "/docs/contracts", body: "NAVToken, NAVVault, FeeSplitter, Accumulator — architecture, tests, verification policy." },
  { no: "03", title: "The Pit", to: "/docs/the-pit", body: "The machinery behind F2 DERIVS — strike books, tickets, premiums feeding the vault." },
  { no: "04", title: "Credit", to: "/docs/credit", body: "The lending floor — four isolated USDG markets, ownerless, every fee routed to $NAV." },
  { no: "05", title: "Yield Layer", to: "/docs/yield-layer", body: "Idle collateral as Uniswap v4 liquidity — instant recall, hook fee-skim, on-chain keepers." },
] as const;

/* Contract registry — addresses come ONLY from the typed lib configs, never
   hand-typed here. Null entries (pre-deploy) are dropped, not faked. */
const REGISTRY: { name: string; role: string; addr: Address | null }[] = [
  { name: "NAVToken", role: "The $NAV ERC-20 — burn-to-redeem entrypoint, fixed 1B supply", addr: PROTOCOL.tokenAddress },
  { name: "NAVVault", role: "Multi-asset vault — holds every stock token, pays redemptions in-kind", addr: PROTOCOL.vaultAddress },
  { name: "FeeSplitter", role: "Enforces the 80/15/5 fee split on-chain, immutably", addr: PROTOCOL.feeSplitterAddress },
  { name: "AccumulatorV2", role: "The buy engine — market-buys stock tokens each epoch, TWAP-floored", addr: PROTOCOL.accumulatorAddress },
  { name: "NavCrank", role: "Permissionless crank — anyone turns it, 0.10% reward on actual spend", addr: PROTOCOL.navCrankAddress },
  { name: "NAV/WETH pool", role: "Uniswap v3 pool, 1% fee tier — 100% of LP protocol-owned", addr: TGE.poolAddress },
  { name: "LpTimelock", role: `Locks LP NFT #${TGE.lpTokenId} — the liquidity cannot be pulled`, addr: TGE.lpTimelock },
  { name: "PitOracleV2", role: "Chainlink-anchored TWAP oracle with Pyth backup — settles every expiry", addr: PIT.oracle },
  { name: "Pit factory", role: "Deploys fully-collateralized strike-book markets per equity", addr: PIT.factory },
  { name: "PitTicket", role: "ERC-721 positions — the ticket is the receipt, drawn on-chain as SVG", addr: PIT.ticket },
  ...YIELD_VAULTS.map((v) => ({ name: v.key, role: v.name, addr: v.address as Address | null })),
];
const REGISTRY_LIVE = REGISTRY.flatMap((r) => (r.addr ? [{ name: r.name, role: r.role, addr: r.addr }] : []));

/* Liquid tickers for the terminal-preview marquee — all are also on the top
   tape, so prices come from the shared cache at zero extra RPC cost. */
const FLR_TICKER_SYMBOLS = ["NVDA", "AAPL", "TSLA", "MSFT", "AMZN", "SPY", "COIN", "PLTR"];
const FLR_TICKER: StockToken[] = FLR_TICKER_SYMBOLS
  .map((s) => STOCK_TOKENS.find((t) => t.symbol === s))
  .filter((t): t is StockToken => Boolean(t));

function UniverseRow({ token, index }: { token: StockToken; index: number }) {
  const { ref, inView } = useInView<HTMLTableRowElement>();
  const p = useTokenPrice(token, inView);
  return (
    <tr ref={ref} className={index >= 4 ? "m-trim" : undefined}>
      <td className="num text-muted m-hide">{String(index + 1).padStart(2, "0")}</td>
      <td>
        <span className="tk">
          <Identicon t={token.symbol} />
          <span className="tk-sym">{token.symbol}</span>
          <span className="tk-name">{token.name}</span>
        </span>
      </td>
      <td className="num" data-th="PRICE · LIVE">
        {p?.status === "ok" && p.price !== undefined ? (
          fmt.usd(p.price)
        ) : p?.status === "loading" ? (
          <span className="text-muted">…</span>
        ) : p?.status === "none" ? (
          <span className="text-muted" title="No Uniswap v3 pool with liquidity found on-chain">no pool</span>
        ) : p?.status === "error" ? (
          <span className="text-muted" title="RPC read failed — retrying with backoff">retrying…</span>
        ) : (
          <span className="text-muted">·</span>
        )}
      </td>
      <td className="num m-hide">
        <a
          className="text-muted hover:text-green-ink no-underline"
          href={`${EXPLORER}/token/${token.address}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {shortAddr(token.address)}
        </a>
      </td>
      <td className="num text-muted m-hide">—</td>
    </tr>
  );
}

/* ---------- FLOOR terminal preview (Fig. 01) — the green jewel ---------- */

function FlrClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="flr-label flr-label--dim">
      {p(now.getUTCHours())}:{p(now.getUTCMinutes())}:{p(now.getUTCSeconds())} UTC
    </span>
  );
}

function FlrTickerItem({ token, enabled }: { token: StockToken; enabled: boolean }) {
  const p = useTokenPrice(token, enabled);
  return (
    <span className="tape-item">
      <span className="t">{token.symbol}</span>
      <span>{p?.status === "ok" && p.price !== undefined ? fmt.usd(p.price) : p?.status === "none" ? "no pool" : "…"}</span>
    </span>
  );
}

/* F-key rail — presentational chrome only. The one door into the app is the
   header's Launch App button; these chips name the terminal's real views. */
const FKEYS = ["F1 SWAP", "F2 DERIVS", "F3 VAULT", "F4 STATS", "F5 NAV.FUN", "F6 DOCS", "F7 EXPLORER"] as const;

function FloorPreview({
  vault,
  navMktUsd,
}: {
  vault: VaultState;
  navMktUsd: number | null;
}) {
  const { ref, inView } = useInView<HTMLElement>();
  const redeemPct = vault.redeemFeeBps !== null ? `${(vault.redeemFeeBps / 100).toFixed(2)}%` : null;
  const selftest = [
    { k: "CHAIN", v: `ROBINHOOD CHAIN · ID ${robinhoodChain.id}`, ok: true },
    {
      k: "VAULT",
      v: vault.status === "live" ? "OK — LIVE READ" : vault.status === "error" ? "RPC ERROR — RETRYING" : "READING…",
      ok: vault.status !== "error",
    },
    { k: "HOLDINGS REGISTRY", v: vault.holdings !== null ? `${vault.holdings.length} TOKENS TRACKED` : "…", ok: true },
    { k: "REDEEM FEE", v: redeemPct !== null ? `${redeemPct} · READ FROM NAVVault` : vault.status === "error" ? "—" : "…", ok: true },
  ];
  return (
    <section className="flr-band py-8 md:py-20" id="floor" aria-label="FLOOR terminal — live preview" ref={ref}>
      <div className="wrap">
        <div className="mb-6 md:mb-10 text-center">
          <Reveal as="p" className="flr-label">THE TERMINAL &middot; GREEN PHOSPHOR &middot; F-KEY NATIVE</Reveal>
          <Reveal delay={90}>
            <h2 className="mt-4 text-[26px] md:text-[42px] text-paper">The app is already on.</h2>
          </Reveal>
          <Reveal delay={170}>
            <p className="mx-auto mt-3 max-w-[38em] text-[14px] md:text-[15px]" style={{ color: "#8fbf98" }}>
              FLOOR is NAV's on-chain stock terminal — quotes, swaps, the F2 derivatives desk and
              the vault, rendered from public RPC. This preview is not a mock-up: every number is a
              live read.
            </p>
          </Reveal>
        </div>

        <Reveal delay={120}>
          <div className="flr-frame st-glow" role="img" aria-label="Live preview of the FLOOR terminal showing current on-chain reads">
            <div className="flr-head">
              <span className="flr-label">NAV.FUN — FLOOR &middot; ON-CHAIN STOCK TERMINAL</span>
              <span className="flex items-center gap-2.5">
                <span className="hidden sm:inline"><FlrClock /></span>
                <Led tone="crt" />
                <span className="flr-label">LIVE</span>
              </span>
            </div>

            <div className="flr-ticker m-hide" aria-hidden="true">
              <div className="tape-track">
                {[0, 1].map((g) => (
                  <div className="tape-group" key={g}>
                    {FLR_TICKER.map((t) => (
                      <FlrTickerItem key={`${g}-${t.symbol}`} token={t} enabled={inView} />
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="flr-tile py-5 md:py-10 text-center" aria-live="polite">
              <span className="flr-label flr-label--dim">$NAV / USD — LIVE MARK</span>
              <div className="flr-value flr-value--big ge-glow">
                {navMktUsd !== null ? fmt.usdTiny(navMktUsd) : "…"}
                <span className="flr-cursor" aria-hidden="true" />
              </div>
              <div className="sub">{LAUNCH.badge}</div>
            </div>

            <div className="border-t border-flr-line px-4 py-3.5 md:px-6">
              <span className="flr-label flr-label--mut">SELF-TEST — LIVE READS FROM PUBLIC RPC, NO BACKEND</span>
              <div className="mt-1.5">
                {selftest.map((r) => (
                  <div key={r.k} className="flr-row">
                    <span className="flr-label flr-label--dim">{r.k}</span>
                    <span className="dots" aria-hidden="true" />
                    <span className={`flr-label ${r.ok ? "" : "warn"}`}>{r.v}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flr-fkeys m-hide">
              {FKEYS.map((k, i) => (
                <span key={k} className={`flr-fkey ${i === 0 ? "flr-fkey--hot" : ""}`}>
                  <span className="k">{k.split(" ")[0]}</span> {k.split(" ").slice(1).join(" ")}
                </span>
              ))}
            </div>
          </div>
        </Reveal>
        <p className="plate-caption on-dark mt-3">
          <span className="fig">Fig. 01</span> — The FLOOR terminal, reading Robinhood Chain over
          public RPC. <span className="m-hide">Zero backend; what it shows is what the chain says.</span>{" "}
          <a className="verify-link" href="/floor/">STEP ONTO THE FLOOR →</a>
        </p>
      </div>
    </section>
  );
}

export function Home() {
  const fx = useHeroFx();
  const ethUsd = useEthUsd();
  const navMkt = useNavMarket();
  const vault = useVaultState();
  /* Honest vault figure, read live: $0.00 while every registry balance is zero
     (fee flow hasn't accrued yet); once anything lands, defer to the terminal's
     full priced valuation instead of guessing here. */
  const vaultTile =
    vault.status !== "live" || vault.holdings === null
      ? "…"
      : vault.holdings.every((h) => h.balance === 0n)
        ? fmt.usd(0)
        : "LIVE";
  const navMktUsd =
    navMkt.status === "ok" && navMkt.priceEth !== null && ethUsd?.status === "ok" && ethUsd.price !== undefined
      ? navMkt.priceEth * ethUsd.price
      : null;
  const supplyCompact =
    vault.totalSupply !== null
      ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Number(vault.totalSupply) / 1e18)
      : null;
  const top = STOCK_TOKENS.slice(0, 8);

  const vitals: {
    label: string;
    value: ReactNode;
    sub: ReactNode;
    reserved: boolean;
    receipt: { call: string; addr: Address; name: string } | null;
  }[] = [
    {
      label: "$NAV SUPPLY",
      value: supplyCompact ?? (vault.status === "error" ? "—" : "…"),
      sub: <span className="up"><Led />live · burn-only, fixed at TGE</span>,
      reserved: false,
      receipt: PROTOCOL.tokenAddress
        ? { call: "NAVToken.totalSupply()", addr: PROTOCOL.tokenAddress, name: "NAVToken" }
        : null,
    },
    {
      label: "REDEEM FEE",
      value: vault.redeemFeeBps !== null ? `${(vault.redeemFeeBps / 100).toFixed(2)}%` : vault.status === "error" ? "—" : "…",
      sub: "stays in the vault — accrues to remaining holders",
      reserved: false,
      receipt: PROTOCOL.vaultAddress
        ? { call: "NAVVault.redeemFeeBps()", addr: PROTOCOL.vaultAddress, name: "NAVVault" }
        : null,
    },
    {
      label: "ETH / USD",
      value:
        ethUsd?.status === "ok" && ethUsd.price !== undefined ? (
          <CountUp value={ethUsd.price} format={(v) => fmt.usd(v)} />
        ) : ethUsd?.status === "error" ? (
          "—"
        ) : (
          "…"
        ),
      sub: "Uniswap v3 — the chain's own quote, no price API",
      reserved: false,
      receipt: null,
    },
    {
      label: "VAULT VALUE",
      value: <span aria-label="vault value, live read">{vaultTile}</span>,
      sub: "vault live & verified — seeds from fee flow, no fake numbers",
      reserved: true,
      receipt: PROTOCOL.vaultAddress
        ? { call: "NAVVault holdings, priced live", addr: PROTOCOL.vaultAddress, name: "NAVVault" }
        : null,
    },
  ];

  return (
    <>
      <Tape />
      <Header
        links={[
          { label: "Protocol", to: "/#protocol", hash: true },
          { label: "Vault", to: "/#vault", hash: true },
          { label: "Derivatives", to: "/#pit", hash: true },
          { label: "Credit", to: "/#credit", hash: true },
          { label: "Tokenomics", to: "/#tokenomics", hash: true },
          { label: "Docs", to: "/docs" },
        ]}
        action={
          /* THE one door into the app — the only Launch App button on the page */
          <a href="/floor/" className="btn btn-floor" aria-label="Launch App — FLOOR on-chain stock terminal">
            ▰ LAUNCH APP
          </a>
        }
      />

      {/* hero — the daylight exchange lobby */}
      <section className="hero-ge">
        {fx && (
          <Suspense fallback={null}>
            <HeroField className="hero-fx" />
          </Suspense>
        )}
        <div className="wrap relative z-10 flex flex-col items-center text-center pt-8 md:pt-16">
          <Reveal as="p" className="kicker">NAV Markets &middot; Robinhood Chain</Reveal>
          <Reveal delay={90}>
            <h1 className="my-4 md:my-5 text-[38px] leading-[1.05] md:text-[66px]">
              Hold one token.<br />Own the <em>whole market</em>.<span className="hero-cursor" aria-hidden="true" />
            </h1>
          </Reveal>
          <Reveal as="p" delay={180} className="text-[15px] md:text-lg text-muted max-w-[30em] mb-6">
            Every fee the protocol earns market-buys the tokenized stocks on Robinhood Chain — AAPL
            to SPY — into an on-chain vault. $NAV is the pro-rata claim on everything inside. Burn
            it, and the stocks land in your wallet.
          </Reveal>
          <Reveal delay={260} className="mb-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <span className="px-label text-gold-ink">THE VAULT ONLY ACCUMULATES</span>
            <span className="px-label text-green-ink">NO INDEXER &middot; NO BACKEND &middot; NOTHING OFF-CHAIN</span>
          </Reveal>
          <Reveal delay={340} className="flex flex-wrap items-center justify-center gap-3.5">
            <Link to="/#protocol" className="btn btn-primary">How it works</Link>
            <Link to="/docs" className="btn">Read the docs</Link>
          </Reveal>
        </div>
        {/* the pixel Wall Street scene — a phosphor jewel in a brushed bezel */}
        <div className="wrap relative z-10 pb-8 md:pb-20 pt-7 md:pt-14">
          <Reveal delay={140}>
            <div className="bezel st-glow">
              <div className="crt on-dark relative overflow-hidden bg-ink">
                <WallStreetScene />
              </div>
            </div>
          </Reveal>
          <p className="plate-caption mt-3 text-center">
            <span className="fig">Plate 00</span> — The exchange, in 8-bit.{" "}
            <span className="m-hide">Green phosphor on silver: the daylight face of the amber terminal.</span>
          </p>
        </div>
      </section>

      {/* protocol vitals — every number carries its receipt */}
      <section className="border-y hairline bg-paper-2 grain" aria-label="Protocol statistics">
        <div className="wrap">
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-b hairline py-3">
            <span className="px-label text-muted">PROTOCOL VITALS — LIVE READS FROM ROBINHOOD CHAIN</span>
            <span className="flex items-center gap-2"><Led tone="crt" /><span className="px-label text-green-ink">PUBLIC RPC</span></span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4">
            {vitals.map((s, i) => (
              <div
                key={s.label}
                className={`flex flex-col px-4 py-4 md:px-7 md:py-7 ${s.reserved ? "opacity-[0.72]" : ""} ${i % 2 === 1 ? "border-l hairline" : ""} ${i >= 2 ? "border-t hairline lg:border-t-0" : ""} ${i > 0 ? "lg:border-l lg:hairline" : ""}`}
              >
                <div className="stat-label">{s.label}</div>
                <div className="stat-value">{s.value}</div>
                <div className="stat-sub">{s.sub}</div>
                {s.receipt && (
                  <div className="verify-row mt-auto pt-3 m-hide">
                    <span className="addr text-[12px] sm:text-[13px]">{s.receipt.call}</span>
                    <a
                      className="verify-link"
                      href={`${EXPLORER}/address/${s.receipt.addr}?tab=contract`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Verify ${s.receipt.name} contract on Blockscout`}
                    >
                      VERIFY ↗
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FLOOR terminal preview — Fig. 01, the green jewel */}
      <FloorPreview vault={vault} navMktUsd={navMktUsd} />

      {/* how it works */}
      <section className="py-8 md:py-24" id="protocol">
        <div className="wrap">
          <div className="mb-5 md:mb-14">
            <Reveal className="masthead mb-3 md:mb-8"><p className="kicker">The mechanism</p><span className="sec-no">No. 01</span></Reveal>
            <hr className="metal-rule st-rule mb-4 md:mb-8" aria-hidden="true" />
            <div className="max-w-[640px]">
              <h2 className="mt-4 text-[26px] md:text-[42px]">Fees in. Stocks in vault. Stocks out.</h2>
              <p className="mt-3 text-[15px] md:text-[17px] text-muted">
                <span className="m-hide">No manager, no mandate meetings, no 2-and-20.</span> A fee
                switch and a vault contract do the whole job — each step names the verified
                contract that executes it.
              </p>
            </div>
          </div>
          <div className="grid md:grid-cols-3 border hairline bg-white">
            {STEPS.map((s, i) => (
              <Reveal key={s.no} delay={i * 110} className={`relative flex flex-col px-5 py-5 md:px-8 md:py-10 md:pb-7 ${i > 0 ? "border-t md:border-t-0 md:border-l hairline" : ""}`}>
                <span className="px-label text-muted-ink">{s.no}</span>
                <img className={`m-hide px h-24 w-auto max-w-none self-start my-4 md:my-5 md:block ${s.drift ? "drift" : ""}`} width={160} height={96} src={s.img} alt={s.alt} />
                <h3 className="text-[22px] mb-2.5">{s.title}</h3>
                <p className="text-[14.5px] md:text-[15px] text-muted mb-1 md:mb-4">{s.body}</p>
                {s.addr && (
                  <div className="verify-row mt-auto m-hide">
                    <span className="addr">{s.contract} · {shortAddr(s.addr)}</span>
                    <a
                      className="verify-link"
                      href={`${EXPLORER}/address/${s.addr}?tab=contract`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Verify ${s.contract} contract on Blockscout`}
                    >
                      VERIFY ↗
                    </a>
                  </div>
                )}
                {i < STEPS.length - 1 && <span className="step-arrow hidden md:flex" aria-hidden="true">&gt;</span>}
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* the guarantees — falsifiable claims as ruled ledger rows */}
      <section className="pb-8 md:pb-24" id="guarantees">
        <div className="wrap">
          <div className="mb-5 md:mb-14">
            <Reveal className="masthead mb-3 md:mb-8"><p className="kicker">The guarantees</p><span className="sec-no">No. 02</span></Reveal>
            <hr className="metal-rule st-rule mb-4 md:mb-8" aria-hidden="true" />
            <div className="max-w-[640px]">
              <h2 className="mt-4 text-[26px] md:text-[42px]">Boring by construction</h2>
              <p className="mt-3 text-[15px] md:text-[17px] text-muted">
                Four claims enforced by immutable code, not policy.{" "}
                <span className="m-hide">
                  Every contract behind them is in the registry below — read the source and try to
                  falsify them.
                </span>
              </p>
            </div>
          </div>
          <div className="ledger border hairline bg-white">
            {GUARANTEES.map((g, gi) => (
              <Reveal key={g.no} delay={(gi % 2) * 90}>
                <div className="grid gap-x-8 gap-y-1 px-5 py-4 md:grid-cols-[88px_260px_1fr] md:px-8 md:py-7">
                  <span className="px-label text-gold-ink pt-0.5">{g.no}</span>
                  <h3 className="text-[18px] md:text-[21px] leading-tight">{g.title}</h3>
                  <p className="text-[13.5px] md:text-[14.5px] text-muted">{g.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* stock token universe */}
      <section className="pb-8 md:pb-24" id="vault">
        <div className="wrap">
          <div className="mb-5 md:mb-14">
            <Reveal className="masthead mb-3 md:mb-8"><p className="kicker">The universe</p><span className="sec-no">No. 03</span></Reveal>
            <hr className="metal-rule st-rule mb-4 md:mb-8" aria-hidden="true" />
            <div className="max-w-[640px]">
              <h2 className="mt-4 text-[26px] md:text-[42px]">
                {STOCK_TOKEN_COUNT} holdings-to-be, zero decisions <span className="live-badge">LIVE CHAIN DATA</span>
              </h2>
              <p className="mt-3 text-[15px] md:text-[17px] text-muted">
                Not a curated basket — the market. Verified Stock Token contracts on Robinhood
                Chain, prices read live from Uniswap v3<span className="m-hide">; vault quantities
                accrue every accumulation epoch</span>.
              </p>
            </div>
          </div>
          <div className="border hairline bg-white">
            <table className="fin cardify">
              <thead>
                <tr>
                  <th className="m-hide">#</th><th>Token</th><th className="num">Price · live</th>
                  <th className="num m-hide">Contract</th><th className="num m-hide">Vault qty</th>
                </tr>
              </thead>
              <tbody>
                {top.map((x, i) => (
                  <UniverseRow key={x.address} token={x} index={i} />
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-t hairline px-4 py-3 text-[12.5px] text-muted">
              <span className="m-hide">+ {STOCK_TOKEN_COUNT - top.length} further verified contracts</span>
              <a href="/floor/" className="font-semibold text-green-ink no-underline">the full list trades on the terminal →</a>
            </div>
          </div>
        </div>
      </section>

      {/* the derivatives desk — a short editorial panel; the desk itself lives
          at F2 DERIVS inside the Floor terminal (anchor id kept for old links) */}
      <section className="py-8 md:py-24 border-y hairline bg-paper-2 grain" id="pit">
        <div className="wrap">
          <div className="mb-5 md:mb-12">
            <Reveal className="masthead mb-3 md:mb-8"><p className="kicker">The derivatives desk</p><span className="sec-no">No. 04</span></Reveal>
            <hr className="metal-rule st-rule mb-4 md:mb-8" aria-hidden="true" />
            <div className="max-w-[640px]">
              <h2 className="mt-4 text-[26px] md:text-[42px]">
                Press <span className="ge-num">F2</span>. The terminal becomes a desk.
              </h2>
              <p className="mt-3 text-[15px] md:text-[17px] text-muted">
                There is no second app — DERIVS is a view inside the Floor terminal.{" "}
                <span className="m-hide">
                  Two fully-collateralized books trade against the same vault: dated European calls
                  and puts priced from the underlying pool's own live fee rate (20 bps origination,
                  5 bps settle bounty), and strike-book markets settled weekly from a 30-minute
                  TWAP, Mondays 20:00 UTC, with positions as transferable ERC-721 tickets.
                </span>{" "}
                Every premium routes 80% through the same FeeSplitter into stock-token
                accumulation. The desk funds the fund.
              </p>
            </div>
          </div>

          <Reveal>
            <div className="ge-panel max-w-[860px]">
              <div className="flex items-center justify-between gap-3 border-b hairline px-5 py-2.5">
                <span className="px-label text-green-ink">F2 DERIVS — INSIDE THE FLOOR TERMINAL</span>
                <span className="flex items-center gap-2"><Led tone="crt" /><span className="px-label text-green-ink m-hide">LIVE</span></span>
              </div>
              <div className="px-5 py-4 md:px-7 md:py-5">
                <p className="text-[14.5px] text-muted">
                  <span className="ge-num text-[17px] text-ink">{PIT_MARKET_COUNT}</span> live
                  strike-book markets · max buyer loss is the premium — no liquidations, no margin
                  calls. The desk itself lives in the app:{" "}
                  <a href="/floor/" className="font-semibold text-green-ink">open F2 DERIVS on the Floor →</a>
                  <span className="mx-2 opacity-50">·</span>
                  <Link to="/docs/the-pit" className="font-semibold text-green-ink">read the spec →</Link>
                </p>
                <div className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-3 border-t hairline pt-3">
                  {[
                    { name: "PitOracleV2", addr: PIT.oracle },
                    { name: "Pit factory", addr: PIT.factory },
                    { name: "PitTicket", addr: PIT.ticket },
                  ].map((c) => (
                    <div key={c.name} className="verify-row !border-t-0">
                      <span className="addr">{c.name} · {shortAddr(c.addr)}</span>
                      <a
                        className="verify-link"
                        href={`${EXPLORER}/address/${c.addr}?tab=contract`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Verify ${c.name} contract on Blockscout`}
                      >
                        VERIFY ↗
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* the credit floor — flagship: isolated USDG lending against the vault's stocks */}
      <section className="credit-band py-8 md:py-24" id="credit">
        <div className="wrap relative">
          <div className="mb-5 md:mb-12">
            <Reveal className="masthead mb-3 md:mb-8">
              <p className="kicker !text-[#6fd97a]">The credit floor · flagship</p>
              <span className="sec-no !text-[#3f5a46]">No. 05</span>
            </Reveal>
            <hr className="metal-rule st-rule mb-4 md:mb-8 opacity-30" aria-hidden="true" />
            <div className="max-w-[680px]">
              <h2 className="mt-4 text-[26px] md:text-[42px] text-paper">
                Press <span className="ge-num">F4</span>. The portfolio becomes a credit line.
              </h2>
              <p className="mt-3 text-[15px] md:text-[17px] text-muted-dark">
                CREDIT is the lending floor inside the terminal — four isolated USDG markets
                against tokenized NVDA, QQQ, AAPL and TSLA. Morpho-style share accounting, an
                Aave-v3 kinked rate curve, close-factor liquidations — rebuilt as one ownerless
                contract per market.{" "}
                <span className="m-hide">
                  No admin keys, no pause switch over funds, no governance queue: risk parameters
                  are constructor constants burned into the bytecode, and deposits, repayments and
                  withdrawals can never be halted.
                </span>{" "}
                And the desk pays the house — {CREDIT_ORIGINATION_BPS} bps origination on every
                draw plus {CREDIT_RESERVE_FACTOR_PCT}% of all interest routes to the Accumulator,
                where it becomes $NAV buy pressure.
              </p>
            </div>
          </div>

          {/* the lending engine — living schematic */}
          <Reveal>
            <div className="flr-frame">
              <div className="flr-head flex items-center justify-between gap-3 px-4 py-2.5 md:px-6">
                <span className="flr-label">NAV CREDIT — THE LENDING ENGINE</span>
                <span className="flex items-center gap-2">
                  <Led tone="crt" />
                  <span className="flr-label flr-label--dim m-hide">SCHEMATIC · PARAMETERS AS DEPLOYED</span>
                  <span className="flr-label flr-label--dim md:hidden">AS DEPLOYED</span>
                </span>
              </div>
              <CreditEngine className="h-[320px] md:h-[420px]" />
              <div className="border-t border-[rgba(0,200,5,0.18)] px-4 py-2 md:px-6 flex flex-wrap items-center gap-x-6 gap-y-1">
                <span className="flr-label flr-label--mut">RATES ACCRUE PER SECOND</span>
                <span className="flr-label flr-label--mut m-hide">LIQUIDATIONS · CLOSE-FACTOR, HF-GATED</span>
                <span className="flr-label flr-label--mut">FEE SKIM · PERMISSIONLESS, 5 BPS BOUNTY</span>
              </div>
            </div>
          </Reveal>

          {/* four isolated markets — deployed parameters, verified source */}
          <div className="mt-4 md:mt-6 grid grid-cols-2 lg:grid-cols-4 gap-3">
            {CREDIT_MARKETS.map((m, i) => (
              <Reveal key={m.sym} delay={i * 90}>
                <div className="credit-chip p-3.5 md:p-4">
                  <div className="flex items-baseline justify-between">
                    <span className="font-term text-[15px] md:text-[17px] font-semibold text-crt tracking-[0.08em]">{m.sym}</span>
                    <span className="flr-label flr-label--mut">{m.name}</span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-1">
                    {[
                      { k: "LTV", v: `${m.ltv}%` },
                      { k: "LIQ", v: `${m.lt}%` },
                      { k: "BONUS", v: `${m.bonus}%` },
                    ].map((s) => (
                      <div key={s.k}>
                        <div className="flr-label flr-label--mut">{s.k}</div>
                        <div className="font-term text-[13px] md:text-[14px] text-[#7dff86]">{s.v}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2.5 border-t border-[rgba(0,200,5,0.14)] pt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <span className="flr-label flr-label--mut whitespace-nowrap">{shortAddr(m.pair)}</span>
                    <a
                      className="verify-link !text-[#6fd97a]"
                      href={`${EXPLORER}/address/${m.pair}?tab=contract`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Verify the ${m.sym} credit market contract on Blockscout`}
                    >
                      VERIFY ↗
                    </a>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          {/* the campaign strip */}
          <Reveal delay={120}>
            <div className="mt-5 md:mt-8 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-4">
              {[
                { v: <CountUp value={CREDIT_CAMPAIGN_CHECKS_M} format={(x) => `${x.toFixed(1)}M`} />, k: "CHECKS IN THE VERIFICATION CAMPAIGN" },
                { v: <CountUp value={CREDIT_MARKETS.length} />, k: "ISOLATED MARKETS · NO SHARED RISK" },
                { v: <>0</>, k: "ADMIN KEYS · OWNERLESS AT DEPLOY" },
                { v: <>{CREDIT_ORIGINATION_BPS} bps</>, k: "OF EVERY DRAW → $NAV BUY PRESSURE" },
              ].map((s, i) => (
                <div key={i} className="credit-stat pl-3">
                  <div className="font-term text-[22px] md:text-[30px] font-semibold text-crt">{s.v}</div>
                  <div className="flr-label flr-label--mut mt-1">{s.k}</div>
                </div>
              ))}
            </div>
          </Reveal>

          <p className="plate-caption on-dark mt-5 md:mt-8 flex-wrap">
            <span>
              <span className="fig whitespace-nowrap">Fig. 02</span> — The lending engine:
              collateral locks in, USDG draws out, and every fee rail terminates at the
              Accumulator. Factory {shortAddr(CREDIT_FACTORY)} · all five contracts verified.{" "}
              <a
                className="verify-link"
                href={`${EXPLORER}/address/${CREDIT_FACTORY}?tab=contract`}
                target="_blank"
                rel="noopener noreferrer"
              >
                VERIFY ↗
              </a>
            </span>
            <span>
              <Link className="verify-link whitespace-nowrap" to="/docs/credit">READ THE CREDIT DOCS →</Link>
              <span className="mx-2 opacity-50">·</span>
              <a className="verify-link whitespace-nowrap" href="/floor/">OPEN F4 CREDIT →</a>
            </span>
          </p>
        </div>
      </section>

      {/* the registry — every address on the table */}
      <section className="py-8 md:py-24" id="registry">
        <div className="wrap">
          <div className="mb-5 md:mb-14">
            <Reveal className="masthead mb-3 md:mb-8"><p className="kicker">The registry</p><span className="sec-no">No. 06</span></Reveal>
            <hr className="metal-rule st-rule mb-4 md:mb-8" aria-hidden="true" />
            <div className="max-w-[640px]">
              <h2 className="mt-4 text-[26px] md:text-[42px]">Every address, on the table</h2>
              <p className="mt-3 text-[15px] md:text-[17px] text-muted">
                The protocol's complete deployed surface — verified on Blockscout<span className="m-hide">,
                rendered straight from the site's typed config</span>.
              </p>
            </div>
          </div>
          <Reveal>
            <div className="border hairline bg-white">
              <table className="reg">
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th className="reg-role">Role</th>
                    <th>Address</th>
                    <th aria-label="Verification link" />
                  </tr>
                </thead>
                <tbody>
                  {REGISTRY_LIVE.map((r) => (
                    <tr key={r.addr}>
                      <td className="font-semibold whitespace-nowrap">{r.name}</td>
                      <td className="reg-role text-muted">{r.role}</td>
                      <td className="addr-cell whitespace-nowrap">{shortAddr(r.addr)}</td>
                      <td className="text-right">
                        <a
                          className="verify-link"
                          href={`${EXPLORER}/address/${r.addr}?tab=contract`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Verify ${r.name} contract on Blockscout`}
                        >
                          VERIFY ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>

          {/* yield layer — condensed strip; deep links to #yield keep working */}
          <Reveal delay={120}>
            <div className="mt-6 md:mt-8 border hairline bg-paper-2 grain px-5 py-4 md:px-8 md:py-6" id="yield">
              <div className="flex items-center gap-2.5 mb-3"><Led tone="crt" /><span className="px-label">THE YIELD LAYER — LIVE</span></div>
              <p className="text-[14px] md:text-[14.5px] text-muted max-w-[70em]">
                Idle derivatives collateral can opt into concentrated Uniswap v4 liquidity — the
                NavPitHook skims 10% of LP fees into the same 80/15/5 FeeSplitter, and recall is
                instant and can never be gated.{" "}
                <span className="m-hide">
                  The pyNVDA and pyUSDG share vaults price deposits off the oracle's TWAP (stale
                  oracle ⇒ deposits fail closed, exits stay open), the YieldRouter bounds every op
                  by slippage and deadline, and there are no schedulers: cranks earn 0.10% on
                  actual spend, expired-ticket settlement pays 0.25%.
                </span>
              </p>
              <p className="mt-3 text-[13.5px] text-muted">
                <Link to="/docs/yield-layer" className="font-semibold text-green-ink">read the yield spec →</Link>
                <span className="mx-2.5 opacity-50">·</span>
                <a
                  className="font-semibold text-green-ink"
                  href={`${EXPLORER}/address/${YIELD_VAULTS[0].address}?tab=contract`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  verified on Blockscout ↗
                </a>
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* tokenomics — the index card, as a ruled ledger */}
      <section className="py-8 md:py-24 bg-paper-2 grain border-y hairline" id="tokenomics">
        <div className="wrap">
          <div className="mb-5 md:mb-14">
            <Reveal className="masthead mb-3 md:mb-8"><p className="kicker">Tokenomics</p><span className="sec-no">No. 07</span></Reveal>
            <hr className="metal-rule st-rule mb-4 md:mb-8" aria-hidden="true" />
            <div className="max-w-[640px]">
              <h2 className="mt-4 text-[26px] md:text-[42px]">Boring on purpose</h2>
              <p className="mt-3 text-[15px] md:text-[17px] text-muted">The prospectus fits on an index card. That is the point.</p>
            </div>
          </div>
          <div className="ledger border hairline bg-white">
            {TOKENOMICS.map((c, ci) => (
              <Reveal key={c.k} delay={(ci % 2) * 90}>
                <div className="grid gap-x-8 gap-y-1 px-5 py-3.5 md:grid-cols-[170px_240px_1fr] md:items-baseline md:px-8 md:py-6">
                  <span className={`px-label ${c.k === "FEE DESTINATION" ? "text-gold-ink" : "text-muted"}`}>{c.k}</span>
                  <div className="ge-num text-[20px] md:text-[24px]">{c.big}</div>
                  <p className="m-hide md:block text-[14.5px] text-muted">{c.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* docs — an index, not a card rack */}
      <section className="py-8 md:py-24" id="docs">
        <div className="wrap">
          <div className="mb-5 md:mb-14">
            <Reveal className="masthead mb-3 md:mb-8"><p className="kicker">Read the fine print</p><span className="sec-no">No. 08</span></Reveal>
            <hr className="metal-rule st-rule mb-4 md:mb-8" aria-hidden="true" />
            <h2 className="mt-4 text-[26px] md:text-[42px]">Documentation</h2>
          </div>
          <div className="ledger border hairline bg-white">
            {DOCS.map((d, di) => (
              <Reveal key={d.no} delay={di * 80}>
                <Link
                  to={d.to}
                  className="grid gap-x-8 gap-y-1 px-5 py-4 md:grid-cols-[88px_200px_1fr_24px] md:items-baseline md:px-8 md:py-6 no-underline text-inherit metal-sheen"
                >
                  <span className="px-label text-muted-ink">{d.no}</span>
                  <h3 className="text-[19px] md:text-[20px] leading-tight">{d.title}</h3>
                  <p className="m-hide md:block text-[14.5px] text-muted">{d.body}</p>
                  <span className="hidden md:block text-green-ink" aria-hidden="true">→</span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* closing band — the floor is open (text link only; the door is above) */}
      <section className="py-8 md:py-20 text-center border-t hairline bg-paper-2 grain" aria-label="Closing">
        <div className="wrap">
          <Reveal as="p" className="px-label text-muted">FLOOR © 2026 &middot; A NAV.FUN PRODUCT &middot; ON-CHAIN STOCK TERMINAL</Reveal>
          <Reveal delay={90}>
            <h2 className="mt-4 text-[26px] md:text-[44px]">The floor is open.</h2>
          </Reveal>
          <Reveal delay={170}>
            <p className="mx-auto mt-3 max-w-[36em] text-[14px] md:text-[15px] text-muted">
              Charts, the derivatives desk, tickets, vault — rendered from public RPC in your
              browser. Bring a wallet; the Launch App key at the top of the page is the door.
            </p>
          </Reveal>
          <p className="px-label text-muted mt-5 md:mt-7">NOT INVESTMENT ADVICE &middot; TOKENIZED STOCKS ARE NOT EQUITIES</p>
        </div>
      </section>

      <Footer />
    </>
  );
}
