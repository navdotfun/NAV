/* VAULT — the $NAV fee-vault desk inside the Floor terminal.
   Buy / redeem-in-kind / crank / growth — all reads live from chain,
   all writes simulated before signing. Logic ported 1:1 from the
   audited site Dashboard; only the presentation is terminal-styled. */
import { useMemo } from "react";
import { formatUnits } from "viem";
import { useNavMarket, useVaultState, PROTOCOL } from "../../lib/nav/protocol";
import { STOCK_TOKENS } from "../../lib/nav/data";
import { getPriceEntry, useEthUsd, usePriceFeed } from "../../lib/nav/live";
import { useVaultHistory } from "../../lib/nav/history";
import { EXPLORER } from "../../lib/chain";
import { fmt } from "../../lib/format";
import { VaultTicket } from "./VaultTicket";
import { HoldingsBoard, type LedgerRow } from "./HoldingsBoard";
import { CrankDesk } from "./CrankDesk";
import { YourPositionStrip } from "./YourPositionStrip";

function utcStamp(t: number): string {
  const d = new Date(t * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function VaultView() {
  const vault = useVaultState();
  const navMkt = useNavMarket();
  const ethUsd = useEthUsd();
  const history = useVaultHistory();

  const tokenByAddr = useMemo(
    () => new Map(STOCK_TOKENS.map((t) => [t.address.toLowerCase(), t])),
    [],
  );
  const holdingsByAddr = useMemo(
    () => new Map((vault.holdings ?? []).map((h) => [h.address.toLowerCase(), h.balance])),
    [vault.holdings],
  );
  const nonZeroTokens = useMemo(
    () =>
      (vault.holdings ?? [])
        .filter((h) => h.balance !== null && h.balance > 0n)
        .map((h) => tokenByAddr.get(h.address.toLowerCase()))
        .filter((t): t is (typeof STOCK_TOKENS)[number] => !!t),
    [vault.holdings, tokenByAddr],
  );
  /* fill tokens join the feed so history values at live prices */
  const feedTokens = useMemo(() => {
    const map = new Map(nonZeroTokens.map((t) => [t.address.toLowerCase(), t]));
    for (const f of history.fills) {
      const meta = tokenByAddr.get(f.token.toLowerCase());
      if (meta) map.set(meta.address.toLowerCase(), meta);
    }
    return [...map.values()];
  }, [nonZeroTokens, history.fills, tokenByAddr]);
  const priceTick = usePriceFeed(feedTokens);

  /* B-12: partial AUM with explicit coverage instead of all-or-nothing.
     One unpriced token used to blank the whole AUM figure; now the priced
     subtotal renders with a "PRICING n/m" coverage note until complete.
     Unknown balances (failed reads, balance === null) count as unpriced. */
  const aum = useMemo(() => {
    if (vault.status !== "live" || vault.holdings === null) return null;
    const unknownBal = vault.holdings.filter((h) => h.balance === null).length;
    let usd = 0;
    let priced = 0;
    for (const t of nonZeroTokens) {
      const bal = holdingsByAddr.get(t.address.toLowerCase());
      if (bal === null || bal === undefined) continue;
      const p = getPriceEntry(t.address);
      if (p?.status === "ok" && p.price !== undefined) {
        usd += (Number(bal) / 10 ** t.decimals) * p.price;
        priced += 1;
      }
    }
    return { usd, priced, total: nonZeroTokens.length + unknownBal };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.status, vault.holdings, nonZeroTokens, holdingsByAddr, priceTick]);
  /* Full-coverage AUM only — backing/premium/chart must never use a partial
     subtotal (that would understate backing as fact). */
  const vaultValue = aum !== null && aum.total > 0 && aum.priced === aum.total ? aum.usd
    : aum !== null && aum.total === 0 ? 0
    : null;

  const supplyF = vault.totalSupply !== null ? Number(formatUnits(vault.totalSupply, 18)) : null;
  const navPerToken = vaultValue !== null && supplyF !== null && supplyF > 0 ? vaultValue / supplyF : null;
  const ethUsdPrice = ethUsd?.status === "ok" && ethUsd.price !== undefined ? ethUsd.price : null;
  const navUsd = navMkt.priceEth !== null && ethUsdPrice !== null ? navMkt.priceEth * ethUsdPrice : null;
  const premium = navUsd !== null && navPerToken !== null && navPerToken > 0 ? (navUsd / navPerToken - 1) * 100 : null;

  /* growth series + acquisition ledger — replayed from chain logs */
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
      ? { labels: [...labels, "NOW"], data: [...data, vaultValue ?? data[data.length - 1]] }
      : null;
    return { series, rows: rows.reverse() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, priceTick, tokenByAddr, vaultValue]);

  const stat = (v: string | null | undefined) => v ?? "…";

  return (
    <main className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden mx-[2px] mb-[2px] grid grid-cols-1 gap-[2px] lg:grid-cols-12">
      {/* left: market stats + buy/redeem ticket */}
      <div className="lg:col-span-3 flex flex-col gap-[2px] min-h-0 lg:overflow-y-auto">
        <section className="panel" aria-label="nav market">
          <div className="panel-title"><span>$NAV · MARKET</span>
            <a className="text-cyan normal-case tracking-normal no-underline hover:underline" href={`${EXPLORER}/address/${PROTOCOL.vaultAddress ?? ""}?tab=contract`} target="_blank" rel="noopener noreferrer">VAULT SRC ↗</a>
          </div>
          <div className="grid grid-cols-2 gap-px bg-rule">
            <div className="bg-panel px-2.5 py-2">
              <div className="cell-label">NAV PRICE</div>
              <div className="text-[15px] text-amber-2 tabular-nums">{stat(navUsd !== null ? fmt.usdTiny(navUsd) : null)}</div>
              <div className="text-[10px] text-txt-dim tabular-nums">{navMkt.priceEth !== null ? `${navMkt.priceEth.toFixed(8)} ETH` : "…"}</div>
            </div>
            <div className="bg-panel px-2.5 py-2">
              <div className="cell-label">BACKING / TOKEN</div>
              <div className="text-[15px] text-txt tabular-nums">{stat(navPerToken !== null ? fmt.usdTiny(navPerToken) : null)}</div>
              <div className="text-[10px] text-txt-dim tabular-nums">
                {premium !== null ? (
                  <span className={premium >= 0 ? "text-up" : "text-dn"}>{premium >= 0 ? "+" : ""}{premium.toFixed(1)}% VS BACKING</span>
                ) : "…"}
              </div>
            </div>
            <div className="bg-panel px-2.5 py-2">
              <div className="cell-label">VAULT AUM</div>
              <div className="text-[15px] text-txt tabular-nums">
                {aum === null ? "…" : aum.total === 0 ? fmt.usd(0, 2) : aum.priced === 0 ? "…" : fmt.usd(aum.usd, 2)}
              </div>
              {aum !== null && aum.total > 0 && aum.priced < aum.total && (
                <div className="text-[10px] text-txt-dim tabular-nums">PRICING {aum.priced}/{aum.total}</div>
              )}
            </div>
            <div className="bg-panel px-2.5 py-2">
              <div className="cell-label">$NAV SUPPLY</div>
              <div className="text-[15px] text-txt tabular-nums">{stat(supplyF !== null ? fmt.num(supplyF, 0) : null)}</div>
              <div className="text-[10px] text-txt-dim">DEFLATIONARY · BURN-ON-CRANK</div>
            </div>
          </div>
        </section>
        <VaultTicket vault={vault} navMkt={navMkt} ethUsd={ethUsdPrice} />
        <YourPositionStrip />
      </div>

      {/* middle: holdings + growth + ledger */}
      <div className="lg:col-span-5 flex flex-col gap-[2px] min-h-0 lg:overflow-y-auto">
        <HoldingsBoard
          vault={vault}
          tokenByAddr={tokenByAddr}
          aum={aum}
          series={chartData?.series ?? null}
          ledger={chartData?.rows ?? null}
          historyStatus={history.status}
        />
      </div>

      {/* right: the crank */}
      <div className="lg:col-span-4 flex flex-col gap-[2px] min-h-0 lg:overflow-y-auto">
        <CrankDesk />
      </div>
    </main>
  );
}
