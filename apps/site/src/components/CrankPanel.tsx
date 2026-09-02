/* NAV — THE CRANK. One permissionless transaction runs the entire fee engine:
   collect LP fees → burn 100% of the NAV side → TWAP-guarded WETH→USDG swap →
   80/15/5 split → up to 3 rotating stock buys into the vault → keeper reward
   to whoever pulled the handle. Everything below is pure chain reads — the
   feed and leaderboard come straight from Cranked event logs, no backend. */
import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { EXPLORER } from "../lib/chain";
import { PROTOCOL, TGE } from "../lib/protocol";
import { fmt } from "../lib/format";
import { useWallet, requestConnect, ensureChain } from "../lib/wallet";
import {
  readCrankState, readNavCrankState, readCrankFeed, sendCrank,
  ROUTED_ASSETS, type CrankState, type NavCrankState, type CrankEvent,
  type CrankLeader, type TxPhase,
} from "../lib/tx";
import { Led } from "./Motion";
import { Identicon } from "./Identicon";
import { TxStatusLine } from "./TxStatusLine";

const POLL_MS = 15_000;
const FEED_POLL_MS = 45_000;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function agoLabel(ts: number, now: number): string {
  const s = Math.max(0, now - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function cd(secs: number): string {
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function CrankPanel() {
  const wallet = useWallet();
  const connected = wallet.status === "connected";
  const wrongChain = wallet.status === "wrong-chain";
  const [pot, setPot] = useState<CrankState | null>(null);
  const [crank, setCrank] = useState<NavCrankState | null>(null);
  const [feed, setFeed] = useState<CrankEvent[] | null>(null);
  const [leaders, setLeaders] = useState<CrankLeader[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [phase, setPhase] = useState<TxPhase>({ step: "idle" });
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const readState = async () => {
      try {
        const [p, c] = await Promise.all([readCrankState(), readNavCrankState()]);
        if (alive.current) { setPot(p); setCrank(c); setReadFailed(false); }
      } catch { if (alive.current) setReadFailed(true); }
    };
    const readFeed = async () => {
      try {
        const { events, leaders: l } = await readCrankFeed();
        if (alive.current) { setFeed(events); setLeaders(l); }
      } catch { /* keep last feed */ }
    };
    void readState(); void readFeed();
    const t1 = setInterval(readState, POLL_MS);
    const t2 = setInterval(readFeed, FEED_POLL_MS);
    const t3 = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => { alive.current = false; clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  }, []);

  const refresh = async () => {
    try {
      const [p, c, f] = await Promise.all([readCrankState(), readNavCrankState(), readCrankFeed()]);
      setPot(p); setCrank(c); setFeed(f.events); setLeaders(f.leaders);
    } catch { /* next poll */ }
  };

  const lpWeth = pot ? Number(formatUnits(pot.lpFeesWeth, 18)) : null;
  const lpNav = pot ? Number(formatUnits(pot.lpFeesNav, 18)) : null;
  const splitterUsdg = pot ? Number(formatUnits(pot.splitterUsdg, 6)) : null;
  const accUsdg = pot ? Number(formatUnits(pot.accumulatorUsdg, 6)) : null;

  const readyIn = crank ? Math.max(0, Number(crank.readyAt) - now) : null;
  const ready = readyIn !== null && readyIn === 0;
  const busy = phase.step === "pending";

  const stat = (v: string | null) =>
    v ?? (readFailed ? <span title="RPC read failed — retrying">retrying…</span> : "…");

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="px-label">THE CRANK · ONE TX RUNS THE WHOLE FEE ENGINE</span>
        <span className="px-label text-crt"><Led />PERMISSIONLESS</span>
      </div>
      <div className="p-4.5">
        <p className="mb-3.5 text-[13px] text-muted-dark">
          Anyone can pull the handle. One transaction{" "}
          <b className="text-paper">collects the locked LP fees, burns 100% of the NAV side,
          swaps the WETH to USDG (TWAP-guarded), splits 80/15/5 and buys stocks into the vault</b>{" "}
          — and pays the caller every keeper reward it earns along the way. On a 30-minute
          cooldown; parameters owner-bounded on-chain.
        </p>

        {/* pending pot */}
        <div className="grid grid-cols-2 gap-1.5 mb-2.5 sm:grid-cols-4">
          <div className="border border-dashed border-ink-3 px-3 py-2.5">
            <div className="px-label text-muted-dark">LP FEES · WETH</div>
            <b className="num text-sm font-medium">{stat(lpWeth !== null ? fmt.num(lpWeth, 4) : null)}</b>
          </div>
          <div className="border border-dashed border-ink-3 px-3 py-2.5">
            <div className="px-label text-muted-dark">LP FEES · NAV <span title="Burned in full by the next crank">🔥</span></div>
            <b className="num text-sm font-medium">{stat(lpNav !== null ? fmt.compact(lpNav) : null)}</b>
          </div>
          <div className="border border-dashed border-ink-3 px-3 py-2.5">
            <div className="px-label text-muted-dark">SPLITTER · USDG</div>
            <b className="num text-sm font-medium">{stat(splitterUsdg !== null ? fmt.usd(splitterUsdg) : null)}</b>
          </div>
          <div className="border border-dashed border-ink-3 px-3 py-2.5">
            <div className="px-label text-muted-dark">BUY QUEUE · USDG</div>
            <b className="num text-sm font-medium">{stat(accUsdg !== null ? fmt.usd(accUsdg) : null)}</b>
          </div>
        </div>

        {/* the handle */}
        <div className="border border-dashed border-ink-3 px-3.5 py-3 mb-2.5">
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <span className="px-label text-muted-dark">
              COLLECT → BURN → SWAP → SPLIT → BUY → REWARD
            </span>
            <span className="num text-[12px] text-muted-dark" aria-live="polite">
              {readyIn === null ? "…" : ready ? <span className="text-crt">READY</span> : `reopens in ${cd(readyIn)}`}
            </span>
          </div>
          <button
            className="btn btn-primary w-full py-3 text-[14px]"
            disabled={busy || (connected && (!ready || crank === null))}
            title={wrongChain ? "Your wallet is on another network — switch to Robinhood Chain (4663)"
              : !connected ? "Connect a wallet to crank"
              : !ready ? "30-minute cooldown between cranks"
              : "NavCrank.crank() — sent with a pinned 3M gas limit so every buy leg executes"}
            onClick={() => {
              if (wrongChain) { void ensureChain(); return; }
              if (!connected) { requestConnect(); return; }
              void sendCrank((p) => { setPhase(p); if (p.step === "done") void refresh(); });
            }}
          >
            {wrongChain ? "SWITCH TO ROBINHOOD CHAIN"
              : connected ? (ready ? "⟳ CRANK THE ENGINE" : `COOLDOWN ${readyIn !== null ? cd(readyIn) : "…"}`)
              : "CONNECT WALLET TO CRANK"}
          </button>
          <TxStatusLine phase={phase} />
          <div className="mt-2 text-[12px] text-muted-dark">
            Rotates buys across {ROUTED_ASSETS.length} routed assets (round-robin cursor, ≤3 buys
            / ≤1,000 USDG each per crank, 30-min TWAP price guard). Sent with a fixed 3,000,000 gas
            limit — gas estimators size for the no-buy path and would skip the buys; unused gas is
            refunded. Contract:{" "}
            <a className="underline decoration-dotted hover:text-crt" href={`${EXPLORER}/address/${PROTOCOL.navCrankAddress ?? ""}?tab=contract`} target="_blank" rel="noopener noreferrer">
              verified source
            </a>. LP principal stays locked in{" "}
            <a className="underline decoration-dotted hover:text-crt" href={`${EXPLORER}/address/${TGE.lpTimelock}`} target="_blank" rel="noopener noreferrer">
              the timelock
            </a> — the crank can only touch fees.
          </div>
        </div>

        {/* recent cranks — straight from chain logs */}
        <div className="border border-dashed border-ink-3 px-3.5 py-3 mb-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="px-label text-muted-dark">RECENT CRANKS</span>
            <span className="text-[12px] text-muted-dark">read from chain logs · no indexer</span>
          </div>
          {feed === null ? (
            <div className="mt-2 text-[12.5px] text-muted-dark">reading event logs…</div>
          ) : feed.length === 0 ? (
            <div className="mt-2 text-[12.5px] text-muted-dark">No cranks in the last ~9 days.</div>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-muted-dark">
                    <th className="px-label font-normal pb-1 pr-3">WHEN</th>
                    <th className="px-label font-normal pb-1 pr-3">CALLER</th>
                    <th className="px-label font-normal pb-1 pr-3 text-right">NAV BURNED</th>
                    <th className="px-label font-normal pb-1 pr-3 text-right">USDG OUT</th>
                    <th className="px-label font-normal pb-1 pr-3 text-right">BUYS</th>
                    <th className="px-label font-normal pb-1 text-right">REWARD</th>
                  </tr>
                </thead>
                <tbody>
                  {feed.slice(0, 8).map((e) => (
                    <tr key={e.txHash} className="border-t border-dashed border-ink-3">
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        <a className="underline decoration-dotted hover:text-crt" href={`${EXPLORER}/tx/${e.txHash}`} target="_blank" rel="noopener noreferrer">
                          {agoLabel(e.timestamp, now)}
                        </a>
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <Identicon t={e.caller} />
                          <span className="num">{short(e.caller)}</span>
                        </span>
                      </td>
                      <td className="num py-1.5 pr-3 text-right">🔥 {fmt.compact(Number(formatUnits(e.navBurned, 18)))}</td>
                      <td className="num py-1.5 pr-3 text-right">{fmt.usd(Number(formatUnits(e.usdgOut, 6)))}</td>
                      <td className="num py-1.5 pr-3 text-right">{e.bought > 0 ? `${e.bought} ⬆` : "0"}</td>
                      <td className="num py-1.5 text-right">{fmt.usd(Number(formatUnits(e.reward, 6)))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* leaderboard */}
        <div className="border border-dashed border-ink-3 px-3.5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="px-label text-muted-dark">TOP CRANKERS · LAST ~9 DAYS</span>
            <span className="text-[12px] text-muted-dark">rewards paid in USDG, on-chain</span>
          </div>
          {leaders === null ? (
            <div className="mt-2 text-[12.5px] text-muted-dark">reading event logs…</div>
          ) : leaders.length === 0 ? (
            <div className="mt-2 text-[12.5px] text-muted-dark">Nobody has cranked yet — the handle is free.</div>
          ) : (
            <ol className="mt-2 space-y-1">
              {leaders.slice(0, 5).map((l, i) => (
                <li key={l.caller} className="flex items-center justify-between gap-3 text-[12.5px]">
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    <span className="num text-muted-dark w-4">{i + 1}.</span>
                    <Identicon t={l.caller} />
                    <span className="num truncate">{short(l.caller)}</span>
                  </span>
                  <span className="num whitespace-nowrap text-muted-dark">
                    {l.cranks} crank{l.cranks === 1 ? "" : "s"} · 🔥 {fmt.compact(Number(formatUnits(l.navBurned, 18)))} NAV
                    · {fmt.usd(Number(formatUnits(l.reward, 6)))} earned
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
