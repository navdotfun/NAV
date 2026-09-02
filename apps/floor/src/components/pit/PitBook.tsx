/* PIT — strike book board. Per-strike writer liquidity (free / locked) and
   open interest for the selected market and expiry, both sides. Every figure
   is a live on-chain read from the pool's `buckets` and `series` accessors —
   the exact storage the order path draws on (same reads TradeAction's
   seriesDepth gate uses). Strike rows are clickable and drive the ticket.
   Live-price header mirrors the site chart header (slot0 samples). */
import { useEffect, useRef, useState } from "react";
import { publicClient, EXPLORER } from "../../lib/nav/chain";
import { limited } from "../../lib/nav/rpc";
import { PIT, pitPoolAbi, type PitMarket } from "../../lib/nav/pit";
import type { PriceEntry } from "../../lib/nav/live";
import type { PitSide } from "../../lib/nav/pitPricer";
import { fmt } from "../../lib/format";

interface BookRow {
  strike: number;
  /** free / locked writer collateral in the CALL bucket, underlying units.
      B-06: null = that slot's read failed — render "—", NEVER a false zero. */
  callFree: number | null;
  callLocked: number | null;
  /** open interest for the CALL series at the selected expiry, contracts */
  callOi: number | null;
  /** free / locked writer collateral in the PUT bucket, USDG */
  putFree: number | null;
  putLocked: number | null;
  /** open interest for the PUT series at the selected expiry, contracts */
  putOi: number | null;
}

export function PitBook({
  market,
  symbol,
  strikes,
  strike,
  onStrike,
  side,
  expiry,
  live,
  feedEntry,
  refreshKey,
}: {
  market: PitMarket | null;
  symbol: string;
  strikes: number[];
  strike: number | null;
  onStrike: (k: number) => void;
  side: PitSide;
  expiry: Date | undefined;
  live: number | null;
  feedEntry: PriceEntry | null;
  refreshKey: number;
}) {
  const [rows, setRows] = useState<BookRow[] | null>(null);
  const seq = useRef(0);
  const expirySec = expiry ? Math.floor(expiry.getTime() / 1000) : 0;

  /* per-strike book — buckets (both sides) + series OI at the selected expiry.
     One multicall per poll; refreshes every 15s and after every fill. */
  useEffect(() => {
    if (!market || strikes.length === 0 || expirySec === 0) {
      setRows(null);
      return;
    }
    const my = ++seq.current;
    const pull = async () => {
      try {
        /* Exact contract-arg conversion — same rounding as the order path. */
        const ks = strikes.map((k) => BigInt(Math.round(k * 1e6)) * 10n ** 12n);
        const res = await limited(() => publicClient.multicall({
          contracts: ks.flatMap((k1e18) => [
            { address: market.pitPool, abi: pitPoolAbi, functionName: "buckets" as const, args: [true, k1e18] as const },
            { address: market.pitPool, abi: pitPoolAbi, functionName: "buckets" as const, args: [false, k1e18] as const },
            { address: market.pitPool, abi: pitPoolAbi, functionName: "series" as const, args: [true, k1e18, BigInt(expirySec)] as const },
            { address: market.pitPool, abi: pitPoolAbi, functionName: "series" as const, args: [false, k1e18, BigInt(expirySec)] as const },
          ]),
          allowFailure: true,
        }));
        if (seq.current !== my) return;
        const out: BookRow[] = strikes.map((k, i) => {
          const cb = res[i * 4];
          const pb = res[i * 4 + 1];
          const cs = res[i * 4 + 2];
          const ps = res[i * 4 + 3];
          const cBucket = cb.status === "success" ? (cb.result as readonly [bigint, bigint, bigint, bigint]) : null;
          const pBucket = pb.status === "success" ? (pb.result as readonly [bigint, bigint, bigint, bigint]) : null;
          const cSeries = cs.status === "success" ? (cs.result as readonly [bigint, bigint, bigint, bigint, boolean]) : null;
          const pSeries = ps.status === "success" ? (ps.result as readonly [bigint, bigint, bigint, bigint, boolean]) : null;
          return {
            strike: k,
            callFree: cBucket ? Number(cBucket[0]) / 1e18 : null,
            callLocked: cBucket ? Number(cBucket[1]) / 1e18 : null,
            callOi: cSeries ? Number(cSeries[1]) / 1e18 : null,
            putFree: pBucket ? Number(pBucket[0]) / 1e6 : null,
            putLocked: pBucket ? Number(pBucket[1]) / 1e6 : null,
            putOi: pSeries ? Number(pSeries[1]) / 1e18 : null,
          };
        });
        setRows(out);
      } catch {
        /* keep last book on transient RPC failure */
      }
    };
    void pull();
    const t = setInterval(() => void pull(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, strikes.join(","), expirySec, refreshKey]);

  /* nearest strike to the live price — the board's ATM marker */
  const atm =
    live !== null && strikes.length > 0
      ? strikes.reduce((a, b) => (Math.abs(b - live) < Math.abs(a - live) ? b : a))
      : null;

  const feedNote =
    live !== null ? (
      <>
        LAST READ <span className="text-up tabular-nums">{fmt.usd(live)}</span>
        {feedEntry?.status === "ok" && feedEntry.fee !== undefined
          ? ` · V3 ${(feedEntry.fee / 10000).toFixed(2)}% / ${feedEntry.quote}`
          : ""}
      </>
    ) : feedEntry?.status === "loading" || !feedEntry ? (
      "LOCATING POOL…"
    ) : feedEntry?.status === "error" ? (
      "PRICE READ FAILED — RETRYING"
    ) : (
      "NO POOL WITH LIQUIDITY ON-CHAIN"
    );

  return (
    <section className="panel flex flex-col min-h-0" aria-label="pit strike book">
      <div className="panel-title">
        <span>{symbol ? `${symbol} / USD` : "SELECT UNDERLYING"} · STRIKE BOOK</span>
        <span className="text-txt-dim normal-case tracking-normal">{feedNote}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11.5px]">
          <thead>
            <tr className="text-right">
              <th className="cell-label px-2 py-1 whitespace-nowrap">CALL FREE ({symbol || "—"})</th>
              <th className="cell-label px-2 py-1 whitespace-nowrap">CALL LOCKED</th>
              <th className="cell-label px-2 py-1 whitespace-nowrap">CALL OI</th>
              <th className="cell-label px-2 py-1 whitespace-nowrap !text-center">STRIKE</th>
              <th className="cell-label px-2 py-1 whitespace-nowrap">PUT OI</th>
              <th className="cell-label px-2 py-1 whitespace-nowrap">PUT LOCKED</th>
              <th className="cell-label px-2 py-1 whitespace-nowrap">PUT FREE (USDG)</th>
            </tr>
          </thead>
          <tbody>
            {rows !== null && rows.length > 0 ? (
              rows.map((r) => {
                const selected = strike === r.strike;
                return (
                  <tr
                    key={r.strike}
                    onClick={() => onStrike(r.strike)}
                    className={`cursor-pointer border-t border-rule text-right hover:bg-panel-2 ${selected ? "bg-panel-2" : ""}`}
                  >
                    <td className={`px-2 py-1 tabular-nums ${r.callFree !== null && r.callFree > 0 ? "text-up" : "text-txt-dim"}`}>
                      {r.callFree !== null ? fmt.num(r.callFree, 4) : "—"}
                    </td>
                    <td className="px-2 py-1 tabular-nums text-txt-dim">{r.callLocked !== null ? fmt.num(r.callLocked, 4) : "—"}</td>
                    <td className="px-2 py-1 tabular-nums text-txt">{r.callOi !== null ? fmt.num(r.callOi) : "—"}</td>
                    <td className={`px-2 py-1 text-center font-bold tabular-nums whitespace-nowrap ${selected ? (side === "PUT" ? "text-dn" : "text-up") : "text-amber-2"}`}>
                      {fmt.usd(r.strike)}
                      {atm === r.strike && <span className="text-cyan"> ◂ATM</span>}
                    </td>
                    <td className="px-2 py-1 tabular-nums text-txt">{r.putOi !== null ? fmt.num(r.putOi) : "—"}</td>
                    <td className="px-2 py-1 tabular-nums text-txt-dim">{r.putLocked !== null ? fmt.usdCompact(r.putLocked) : "—"}</td>
                    <td className={`px-2 py-1 tabular-nums ${r.putFree !== null && r.putFree > 0 ? "text-up" : "text-txt-dim"}`}>
                      {r.putFree !== null ? fmt.usdCompact(r.putFree) : "—"}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={7} className="px-2 py-6 text-center text-txt-dim">
                  {!market
                    ? "NO LIVE PIT MARKET SELECTED"
                    : strikes.length === 0
                      ? "AWAITING FIRST ON-CHAIN PRICE READ — THE GRID LOADS FROM THE POOL'S IMMUTABLE STRIKE SPACING"
                      : "READING BOOK FROM CHAIN…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-auto border-t border-rule p-2 text-[10px] leading-relaxed text-txt-dim">
        FREE = UNLOCKED WRITER COLLATERAL BUYS CAN DRAW ON · LOCKED = ESCROWED AGAINST OPEN INTEREST ·
        OI = CONTRACTS OUTSTANDING AT THE SELECTED EXPIRY{expiry ? ` (${expiry.toISOString().slice(0, 10)} 20:00 UTC)` : ""} ·
        CALL BUCKETS ESCROW {symbol || "THE UNDERLYING"} · PUT BUCKETS ESCROW USDG ·{" "}
        <a
          className="text-cyan hover:underline"
          href={`${EXPLORER}/address/${PIT.factory}`}
          target="_blank"
          rel="noreferrer"
        >
          SOURCE-VERIFIED CONTRACTS
        </a>
      </div>
    </section>
  );
}
