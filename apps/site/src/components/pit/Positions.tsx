/* The Pit — open tickets for the connected wallet. Marks are live on-chain
   quotePremium reads for the same series (the resale/replacement value of the
   position under the current oracle TWAP); expired tickets show settlement
   value and a SETTLE action when in the money. */
import { useCallback, useEffect, useRef, useState } from "react";
import { publicClient } from "../../lib/chain";
import { fetchPositions, pitPoolAbi, quotePremiumOnChain, type PitPosition } from "../../lib/pit";
import { ensureChain, useWallet, walletClient } from "../../lib/wallet";
import { fmt } from "../../lib/format";

interface Row extends PitPosition {
  mark: number | null; // live series re-quote, USDG
  payout: number | null; // settled intrinsic, USDG (expired only)
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function expShort(sec: number): string {
  const d = new Date(sec * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]}`;
}

/* Contract constant PitPool.KEEPER_DELAY. After this window any keeper may
   settle a holder's ticket and take keeperFeeBps out of the payout — audit v3
   guard #10 requires this be disclosed with a countdown. */
const KEEPER_DELAY_S = 2 * 60 * 60;
const KEEPER_FEE_BPS = 25; // factory.keeperFeeBps(), currently 0.25% (max 1%)

function keeperCountdown(expirySec: number): { openS: number; open: boolean } {
  const openAt = expirySec + KEEPER_DELAY_S;
  const openS = openAt - Math.floor(Date.now() / 1000);
  return { openS, open: openS <= 0 };
}

function shortDur(s: number): string {
  if (s <= 0) return "now";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function Positions({ refreshKey }: { refreshKey: number }) {
  const w = useWallet();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [settling, setSettling] = useState<bigint | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);

  const pull = useCallback(async () => {
    if (w.status !== "connected" || !w.account) {
      setRows(null);
      return;
    }
    const my = ++seq.current;
    try {
      const ps = await fetchPositions(w.account);
      const out: Row[] = await Promise.all(
        ps.map(async (p) => {
          if (p.expiry * 1000 > Date.now()) {
            // Exact on-chain values — never re-derive contract args from floats (L-07).
            const q = await quotePremiumOnChain(p.pool, p.isCall, p.strike1e18, p.expiry, p.qty1e18);
            return { ...p, mark: q ? Number(q.premium) / 1e6 : null, payout: null };
          }
          const intrinsic = p.settlePrice !== null
            ? Math.max(p.isCall ? p.settlePrice - p.strike : p.strike - p.settlePrice, 0) * p.qty
            : null;
          /* AUDIT v3 GUARD #7 (P3-04) — the contract caps every claim at the
             series' remaining owedPayout reserve. Display the TRUE claimable
             (min of intrinsic and reserve), never the theoretical intrinsic.
             owedPayoutColl is in collateral units: USDG 6-dec for puts,
             underlying 18-dec for calls (valued at the settle price). */
          let payout = intrinsic;
          if (intrinsic !== null && p.owedPayoutColl !== null && p.settlePrice !== null) {
            const reserveUsd = p.isCall
              ? (Number(p.owedPayoutColl) / 1e18) * p.settlePrice
              : Number(p.owedPayoutColl) / 1e6;
            payout = Math.min(intrinsic, reserveUsd);
          }
          return { ...p, mark: null, payout };
        }),
      );
      if (seq.current === my) {
        setRows(out);
        setErr(null); // clear stale read errors on a successful poll (L-06)
      }
    } catch {
      if (seq.current === my) setErr("Position read failed — retrying on next refresh.");
    }
  }, [w.status, w.account]);

  useEffect(() => {
    void pull();
    const t = setInterval(() => void pull(), 20_000);
    return () => clearInterval(t);
  }, [pull, refreshKey]);

  const settle = useCallback(async (p: Row) => {
    const wc = walletClient();
    if (!wc || !w.account) return;
    // audit-v5 L-1: same wrong-chain gate as every other tx path.
    if (w.status === "wrong-chain") {
      const ok = await ensureChain();
      if (!ok) return;
    }
    setSettling(p.ticketId);
    setErr(null);
    try {
      // Simulate → send → receipt-status gate, same pipeline as buys (M-01).
      const requireSuccess = async (hash: `0x${string}`, what: string) => {
        const rcpt = await publicClient.waitForTransactionReceipt({ hash });
        if (rcpt.status !== "success") throw new Error(`${what} reverted on-chain.`);
      };
      if (!p.settled) {
        const sim0 = await publicClient.simulateContract({
          address: p.pool, abi: pitPoolAbi, functionName: "settle",
          args: [BigInt(p.expiry)], account: w.account,
        });
        const h0 = await wc.writeContract(sim0.request);
        await requireSuccess(h0, "Series settlement");
      }
      const sim = await publicClient.simulateContract({
        address: p.pool, abi: pitPoolAbi, functionName: "settleTicket",
        args: [p.ticketId], account: w.account,
      });
      const h = await wc.writeContract(sim.request);
      await requireSuccess(h, "Ticket settlement");
      await pull();
    } catch (e) {
      const s = e instanceof Error ? e.message : String(e);
      setErr(
        /user rejected|denied/i.test(s) ? "Signature rejected in wallet."
          : /KeeperTooEarly/i.test(s) ? "Only the ticket holder can settle in the first 2 hours after expiry — keeper settlement opens after that."
          : /NotSettled/i.test(s) ? "Series not settled yet — settle the series first."
          : `Settlement failed: ${s.slice(0, 120)}`,
      );
    } finally {
      setSettling(null);
    }
  }, [w.account, w.status, pull]);

  if (w.status !== "connected") {
    return (
      <section className="panel">
        <div className="panel-head">
          <span className="px-label">YOUR TICKETS · LIVE P&L</span>
        </div>
        <div className="p-4.5 text-[13px] text-muted-dark">
          Connect a wallet to track your open tickets — premium paid, live mark, unrealized P&L and
          settlement, straight from the chain.
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="px-label">YOUR TICKETS · LIVE P&L</span>
        <span className="num text-[12.5px] text-muted-dark">
          {rows === null ? "reading…" : `${rows.length} on-chain`}
        </span>
      </div>
      {err && <div className="px-4.5 pt-3 text-[12.5px] text-red">{err}</div>}
      {rows !== null && rows.length === 0 ? (
        <div className="p-4.5 text-[13px] text-muted-dark">
          No tickets held by this wallet. Filled orders mint a Pit Ticket NFT that appears here.
        </div>
      ) : rows !== null ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-muted-dark">
                <th className="px-4.5 py-2.5 font-normal">TICKET</th>
                <th className="px-3 py-2.5 font-normal">SERIES</th>
                <th className="px-3 py-2.5 text-right font-normal">QTY</th>
                <th className="px-3 py-2.5 text-right font-normal">PAID</th>
                <th className="px-3 py-2.5 text-right font-normal">MARK / PAYOUT</th>
                <th className="px-3 py-2.5 text-right font-normal">P&L</th>
                <th className="px-4.5 py-2.5 text-right font-normal">STATUS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const now = p.mark ?? p.payout;
                const pnl = now !== null ? now - p.premiumPaid : null;
                const expired = p.expiry * 1000 < Date.now();
                /* GUARD #6 (P3-04): payout basis shifted by a corporate action. */
                const basisShifted =
                  p.liveMultiplier !== null && p.liveMultiplier !== p.writeMultiplier;
                /* GUARD #10: keeper may take a cut once the delay elapses. */
                const keeper = keeperCountdown(p.expiry);
                return (
                  <tr key={p.ticketId.toString()} className="border-t border-ink-3">
                    <td className="num px-4.5 py-2.5">#{p.ticketId.toString()}</td>
                    <td className="px-3 py-2.5">
                      <span className={p.isCall ? "text-crt" : "text-red"}>
                        {p.symbol} {p.isCall ? "CALL" : "PUT"}
                      </span>{" "}
                      <span className="num text-muted-dark">
                        K {fmt.usd(p.strike)} · {expShort(p.expiry)}
                      </span>
                    </td>
                    <td className="num px-3 py-2.5 text-right">{p.qty}</td>
                    <td className="num px-3 py-2.5 text-right">{fmt.usd(p.premiumPaid)}</td>
                    <td className="num px-3 py-2.5 text-right">{now !== null ? fmt.usd(now) : "—"}</td>
                    <td className={`num px-3 py-2.5 text-right ${pnl === null ? "" : pnl >= 0 ? "text-crt" : "text-red"}`}>
                      {pnl !== null ? `${pnl >= 0 ? "+" : ""}${fmt.usd(pnl)}` : "—"}
                    </td>
                    <td className="px-4.5 py-2.5 text-right">
                      {basisShifted && (
                        <span
                          className="px-label mb-1 block text-gold"
                          title="A corporate action changed this underlying's multiplier after your ticket was written. The payout basis has shifted and settlement is first-come-first-served — settle now."
                        >
                          BASIS SHIFTED — SETTLE NOW
                        </span>
                      )}
                      {expired && !keeper.open && (
                        <span
                          className="px-label mb-1 block text-muted-dark"
                          title={`After ${shortDur(KEEPER_DELAY_S)} post-expiry any keeper may settle this ticket and take ${(KEEPER_FEE_BPS / 100).toFixed(2)}% of the payout. Settle within the window to keep the full amount.`}
                        >
                          KEEP FULL PAYOUT · {shortDur(keeper.openS)}
                        </span>
                      )}
                      {expired && keeper.open && p.payout !== null && p.payout > 0 && (
                        <span
                          className="px-label mb-1 block text-gold"
                          title={`Keeper window is open — a keeper may settle and take ${(KEEPER_FEE_BPS / 100).toFixed(2)}% of the payout.`}
                        >
                          KEEPER FEE APPLIES · −{fmt.usd((p.payout * KEEPER_FEE_BPS) / 10_000)}
                        </span>
                      )}
                      {!expired ? (
                        <span className="px-label text-muted-dark">OPEN</span>
                      ) : p.payout !== null && p.payout > 0 ? (
                        <button
                          className="btn !px-3 !py-1 text-[12px]"
                          disabled={settling === p.ticketId}
                          onClick={() => void settle(p)}
                        >
                          {settling === p.ticketId ? "SETTLING…" : `SETTLE ${fmt.usd(p.payout)}`}
                        </button>
                      ) : p.settled ? (
                        <span className="px-label text-muted-dark">EXPIRED WORTHLESS</span>
                      ) : (
                        <button
                          className="btn !px-3 !py-1 text-[12px]"
                          disabled={settling === p.ticketId}
                          onClick={() => void settle(p)}
                        >
                          {settling === p.ticketId ? "SETTLING…" : "SETTLE SERIES"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
