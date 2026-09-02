/* VAULT — THE CRANK desk. One permissionless tx runs the whole fee engine:
   collect LP fees → burn 100% of the NAV side → TWAP-guarded WETH→USDG →
   80/15/5 split → up to 3 rotating stock buys → keeper reward to the caller.
   All reads are chain logs + views — no backend, no indexer. */
import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { EXPLORER } from "../../lib/chain";
import { PROTOCOL, TGE } from "../../lib/nav/protocol";
import { fmt } from "../../lib/format";
import { useWallet, requestConnect, ensureChain } from "../../lib/wallet";
import {
  readCrankState, readNavCrankState, readCrankFeed, sendCrank,
  ROUTED_ASSETS, type CrankState, type NavCrankState, type CrankEvent,
  type CrankLeader, type TxPhase,
} from "../../lib/nav/tx";

const POLL_MS = 15_000;
const FEED_POLL_MS = 45_000;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function agoLabel(ts: number, now: number): string {
  const s = Math.max(0, now - ts);
  if (s < 60) return `${s}S`;
  if (s < 3600) return `${Math.floor(s / 60)}M`;
  if (s < 86400) return `${Math.floor(s / 3600)}H`;
  return `${Math.floor(s / 86400)}D`;
}

function cd(secs: number): string {
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* B-14: the 1s countdown/ago tickers are isolated in these leaf components so
   only their own text node re-renders every second — not the whole desk. */
function CountdownLabel({ readyAt }: { readyAt: number | null }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  if (readyAt === null) return <>…</>;
  const left = Math.max(0, readyAt - now);
  return left === 0 ? <span className="text-up">READY</span> : <span className="text-txt-dim">T-{cd(left)}</span>;
}

function AgoLabel({ ts }: { ts: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{agoLabel(ts, now)}</>;
}

function PhaseLine({ phase }: { phase: TxPhase }) {
  if (phase.step === "idle") return null;
  if (phase.step === "error") return <div className="pt-1 text-[11px] text-dn">{phase.message}</div>;
  if (phase.step === "done") {
    return (
      <div className="pt-1 text-[11px] text-up">
        CRANKED · <a className="text-cyan hover:underline" href={`${EXPLORER}/tx/${phase.hash}`} target="_blank" rel="noopener noreferrer">VIEW TX ↗</a>
      </div>
    );
  }
  return <div className="pt-1 text-[11px] text-amber-2">{phase.hash ? "CONFIRMING ON-CHAIN…" : "CONFIRM IN WALLET…"}<span className="blink">▮</span></div>;
}

export function CrankDesk() {
  const wallet = useWallet();
  const connected = wallet.status === "connected";
  const wrongChain = wallet.status === "wrong-chain";
  const [pot, setPot] = useState<CrankState | null>(null);
  const [crank, setCrank] = useState<NavCrankState | null>(null);
  const [feed, setFeed] = useState<CrankEvent[] | null>(null);
  const [leaders, setLeaders] = useState<CrankLeader[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [phase, setPhase] = useState<TxPhase>({ step: "idle" });
  /* B-14: `ready` flips at most twice per crank cycle — the 1s check bails out
     of re-render via React's same-value state bail-out. */
  const [ready, setReady] = useState(false);
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
    return () => { alive.current = false; clearInterval(t1); clearInterval(t2); };
  }, []);

  useEffect(() => {
    if (!crank) { setReady(false); return; }
    const readyAt = Number(crank.readyAt);
    const check = () => setReady(Math.floor(Date.now() / 1000) >= readyAt);
    check();
    const t = setInterval(check, 1000);
    return () => clearInterval(t);
  }, [crank]);

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

  const busy = phase.step === "pending";

  const stat = (v: string | null) => v ?? (readFailed ? "RETRYING…" : "…");

  return (
    <>
      <section className="panel" aria-label="the crank">
        <div className="panel-title">
          <span>THE CRANK · FEE ENGINE</span>
          <span className="text-up normal-case tracking-normal">● PERMISSIONLESS</span>
        </div>

        {/* pending pot */}
        <div className="grid grid-cols-2 gap-px bg-rule">
          <div className="bg-panel px-2.5 py-2">
            <div className="cell-label">LP FEES · WETH</div>
            <div className="text-[14px] text-txt tabular-nums">{stat(lpWeth !== null ? fmt.num(lpWeth, 5) : null)}</div>
          </div>
          <div className="bg-panel px-2.5 py-2">
            <div className="cell-label">LP FEES · NAV <span title="Burned in full by the next crank">🔥</span></div>
            <div className="text-[14px] text-txt tabular-nums">{stat(lpNav !== null ? fmt.compact(lpNav) : null)}</div>
          </div>
          <div className="bg-panel px-2.5 py-2">
            <div className="cell-label">SPLITTER · USDG</div>
            <div className="text-[14px] text-txt tabular-nums">{stat(splitterUsdg !== null ? fmt.usd(splitterUsdg) : null)}</div>
          </div>
          <div className="bg-panel px-2.5 py-2">
            <div className="cell-label">BUY QUEUE · USDG</div>
            <div className="text-[14px] text-txt tabular-nums">{stat(accUsdg !== null ? fmt.usd(accUsdg) : null)}</div>
          </div>
        </div>

        {/* the handle */}
        <div className="px-2.5 py-2 border-t border-rule">
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <span className="cell-label">COLLECT → BURN → SWAP → SPLIT → BUY → REWARD</span>
            <span className="text-[11px] tabular-nums" aria-live="polite">
              <CountdownLabel readyAt={crank ? Number(crank.readyAt) : null} />
            </span>
          </div>
          <button type="button" className="btn-exec w-full"
            disabled={busy || (connected && !wrongChain && (!ready || crank === null))}
            title={wrongChain ? "Switch to Robinhood Chain (4663)"
              : !connected ? "Connect a wallet to crank"
              : !ready ? "30-minute cooldown between cranks"
              : "NavCrank.crank() — pinned 3M gas so every buy leg executes"}
            onClick={() => {
              if (wrongChain) { void ensureChain(); return; }
              if (!connected) { requestConnect(); return; }
              void sendCrank((p) => { setPhase(p); if (p.step === "done") void refresh(); });
            }}>
            {wrongChain ? "SWITCH TO ROBINHOOD CHAIN"
              : connected ? (ready ? "⟳ CRANK THE ENGINE" : <>COOLDOWN <CountdownLabel readyAt={crank ? Number(crank.readyAt) : null} /></>)
              : "CONNECT WALLET TO CRANK"}
          </button>
          <PhaseLine phase={phase} />
          <div className="mt-1.5 text-[10px] leading-relaxed text-txt-dim">
            ROTATES ≤3 BUYS / ≤1,000 USDG EACH ACROSS {ROUTED_ASSETS.length} ASSETS · 30-MIN TWAP GUARD ·
            PINNED 3,000,000 GAS (UNUSED REFUNDED) · LP PRINCIPAL STAYS IN{" "}
            <a className="text-cyan hover:underline" href={`${EXPLORER}/address/${TGE.lpTimelock}`} target="_blank" rel="noopener noreferrer">THE TIMELOCK</a> ·{" "}
            <a className="text-cyan hover:underline" href={`${EXPLORER}/address/${PROTOCOL.navCrankAddress ?? ""}?tab=contract`} target="_blank" rel="noopener noreferrer">VERIFIED SOURCE ↗</a>
          </div>
        </div>
      </section>

      {/* recent cranks */}
      <section className="panel" aria-label="recent cranks">
        <div className="panel-title">
          <span>RECENT CRANKS</span>
          <span className="text-txt-dim normal-case tracking-normal">CHAIN LOGS · NO INDEXER</span>
        </div>
        {feed === null ? (
          <div className="px-2.5 py-2 text-[11px] text-txt-dim">READING EVENT LOGS…</div>
        ) : feed.length === 0 ? (
          <div className="px-2.5 py-2 text-[11px] text-txt-dim">NO CRANKS IN THE LAST ~9 DAYS.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-amber-dim">
                  <th className="font-normal px-2.5 py-1 tracking-wider">WHEN</th>
                  <th className="font-normal px-2 py-1 tracking-wider">CALLER</th>
                  <th className="font-normal px-2 py-1 tracking-wider text-right">NAV 🔥</th>
                  <th className="font-normal px-2 py-1 tracking-wider text-right">USDG OUT</th>
                  <th className="font-normal px-2 py-1 tracking-wider text-right">BUYS</th>
                  <th className="font-normal px-2.5 py-1 tracking-wider text-right">REWARD</th>
                </tr>
              </thead>
              <tbody>
                {feed.slice(0, 8).map((e) => (
                  <tr key={e.txHash} className="border-t border-rule hover:bg-panel-2">
                    <td className="px-2.5 py-1 whitespace-nowrap">
                      <a className="text-cyan hover:underline tabular-nums" href={`${EXPLORER}/tx/${e.txHash}`} target="_blank" rel="noopener noreferrer">
                        <AgoLabel ts={e.timestamp} />
                      </a>
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-txt tabular-nums">{short(e.caller)}</td>
                    <td className="px-2 py-1 text-right text-txt tabular-nums">{fmt.compact(Number(formatUnits(e.navBurned, 18)))}</td>
                    <td className="px-2 py-1 text-right text-txt tabular-nums">{fmt.usd(Number(formatUnits(e.usdgOut, 6)))}</td>
                    <td className="px-2 py-1 text-right text-txt tabular-nums">{e.bought > 0 ? <span className="text-up">{e.bought} ⬆</span> : "0"}</td>
                    <td className="px-2.5 py-1 text-right text-txt tabular-nums">{fmt.usd(Number(formatUnits(e.reward, 6)))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* leaderboard */}
      <section className="panel" aria-label="top crankers">
        <div className="panel-title">
          <span>TOP CRANKERS · ~9D</span>
          <span className="text-txt-dim normal-case tracking-normal">REWARDS IN USDG</span>
        </div>
        {leaders === null ? (
          <div className="px-2.5 py-2 text-[11px] text-txt-dim">READING EVENT LOGS…</div>
        ) : leaders.length === 0 ? (
          <div className="px-2.5 py-2 text-[11px] text-txt-dim">NOBODY HAS CRANKED YET — THE HANDLE IS FREE.</div>
        ) : (
          <ol className="px-2.5 py-1.5">
            {leaders.slice(0, 5).map((l, i) => (
              <li key={l.caller} className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
                <span className="min-w-0 flex items-center gap-1.5">
                  <span className="text-amber-dim tabular-nums w-4">{i + 1}.</span>
                  <span className="text-txt truncate tabular-nums">{short(l.caller)}</span>
                </span>
                <span className="whitespace-nowrap text-txt-dim tabular-nums">
                  {l.cranks}× · 🔥{fmt.compact(Number(formatUnits(l.navBurned, 18)))} · {fmt.usd(Number(formatUnits(l.reward, 6)))}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
