import { Link, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

// Repository tab is code-split: it carries full contract/frontend source snapshots.
const Repo = lazy(() => import("../repo/Repo"));
import { FlywheelFig, ArbitrageFig, RedemptionFig, RegistryFig } from "../components/PixelExplainers";
import { Tape } from "../components/Tape";
import { Header } from "../components/Header";
import { FooterSlim } from "../components/Footer";
import litepaperMd from "../content/LITEPAPER.md?raw";
import contractsMd from "../content/CONTRACTS.md?raw";
import pitMd from "../content/THE-PIT.md?raw";
import yieldMd from "../content/YIELD-LAYER.md?raw";
import creditMd from "../content/CREDIT.md?raw";

const DOCS = [
  { slug: "litepaper", label: "Litepaper", kicker: "01", md: litepaperMd },
  { slug: "contracts", label: "Contracts", kicker: "02", md: contractsMd },
  { slug: "the-pit", label: "Derivatives", kicker: "03", md: pitMd },
  { slug: "credit", label: "Credit", kicker: "04", md: creditMd },
  { slug: "yield-layer", label: "Yield Layer", kicker: "05", md: yieldMd },
  { slug: "repository", label: "Repository", kicker: "06", md: "" },
] as const;

/**
 * Pixel-art explainer figures, keyed by doc slug + a lowercase substring of the
 * section heading they should follow. The markdown is split on ##/### headings
 * and each figure is rendered right after its matching section.
 */
const FIGS: Record<string, { match: string; fig: ReactNode }[]> = {
  litepaper: [
    { match: "3.1 the vault", fig: <FlywheelFig /> },
    { match: "3.3 in-kind redemption", fig: <RedemptionFig /> },
    { match: "3.4 buy pressure loop", fig: <ArbitrageFig /> },
    { match: "accumulation rotation", fig: <RegistryFig /> },
  ],
  contracts: [
    { match: "feesplitter", fig: <FlywheelFig /> },
    { match: "accumulator", fig: <RegistryFig /> },
  ],
  "the-pit": [{ match: "why \"regenerative\"", fig: <FlywheelFig /> }],
  credit: [{ match: "every draw feeds the vault", fig: <FlywheelFig /> }],
  "yield-layer": [{ match: "keeper economy", fig: <RegistryFig /> }],
};

/** Split markdown into blocks, each starting at a ## or ### heading. */
function splitSections(md: string): { heading: string; body: string }[] {
  return md.split(/\n(?=#{2,3} )/).map((body) => ({
    heading: (body.split("\n", 1)[0] ?? "").replace(/^#+\s*/, "").toLowerCase(),
    body,
  }));
}

export function Docs() {
  const { slug } = useParams();
  const active = DOCS.find((d) => d.slug === slug) ?? DOCS[0];

  return (
    <>
      <Tape />
      <Header
        links={[
          { label: "Home", to: "/" },
          { label: "Protocol", to: "/#protocol", hash: true },
          { label: "Tokenomics", to: "/#tokenomics", hash: true },
          { label: "Derivatives", to: "/#pit", hash: true },
          { label: "Credit", to: "/#credit", hash: true },
        ]}
        action={<a href="/floor/" className="btn btn-primary" aria-label="Launch App — FLOOR on-chain stock terminal">Launch App</a>}
      />

      <main className="py-10 md:py-14">
        <div className="wrap">
          <div className="max-w-[640px] mb-8 md:mb-12">
            <p className="kicker">Read the fine print</p>
            <h1 className="mt-4 text-[34px] md:text-[46px]">Documentation</h1>
          </div>

          <div className="grid grid-cols-1 gap-8 md:grid-cols-[220px_minmax(0,1fr)] items-start">
            {/* left nav */}
            <nav className="docs-nav md:sticky md:top-[88px]" aria-label="Documentation">
              {DOCS.map((d) => (
                <Link
                  key={d.slug}
                  to={`/docs/${d.slug}`}
                  className={`docs-nav-link ${d.slug === active.slug ? "active" : ""}`}
                  aria-current={d.slug === active.slug ? "page" : undefined}
                >
                  <span className="px-label text-gold-ink">{d.kicker}</span>
                  <span>{d.label}</span>
                </Link>
              ))}
              <div className="mt-5 px-1 text-[12.5px] text-muted">
                Docs current as of TGE · 31 Aug 2026. All deployed contract addresses are live and
                source-verified on Blockscout — see the Contracts page.
              </div>
            </nav>

            {/* document */}
            {active.slug === "repository" ? (
              <Suspense
                fallback={
                  <div className="border hairline bg-white px-6 py-10 text-center">
                    <span className="px-label text-muted">Loading repository…</span>
                  </div>
                }
              >
                <Repo />
              </Suspense>
            ) : (
              <article className="docs-prose border hairline bg-white px-6 py-8 md:px-12 md:py-12">
                {splitSections(active.md).map((sec, i) => {
                  const fig = FIGS[active.slug]?.find((f) => sec.heading.includes(f.match));
                  return (
                    <div key={i}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{sec.body}</ReactMarkdown>
                      {fig ? fig.fig : null}
                    </div>
                  );
                })}
              </article>
            )}
          </div>
        </div>
      </main>

      <FooterSlim />
    </>
  );
}
