/* ARENA (Colosseum) — stock-vs-stock outperformance bouts on NavArena.
   Stake USDG on a side before entry closes; prices snap through
   PitOracleV2's anchor-verified rails at lock and settle; winners split
   the losing pot (2% fee, 10% of it to the settling caller). Voided
   bouts refund everyone in full. All reads live from chain. */
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import type { Address } from "viem";
import type { FloorView } from "../../App";
import { useWallet } from "../../lib/wallet";
import {
  ARENA_ADDRESS, fetchBouts, fetchMyStakes, previewPayout, symbolOf,
  stakeBout, lockBout, settleBout, voidBoutTx, claimBout, createBout, arenaRevertName,
  MIN_STAKE, FEE_BPS_ARENA, BPS,
  type Bout, type MyStake, type ArenaPhase,
} from "../../lib/arena";
import { EXPLORER } from "../../lib/chain";
import registry from "../../lib/stocktokens.json";

const REG = registry as { symbol: string; address: string }[];

function fmtUsdg(v: bigint): string {
  return Number(formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtPerf(p: bigint | null): string {
  if (p === null) return "—";
  const pct = (Number(p) / 1e18 - 1) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}
function countdown(to: number, now: number): string {
  const s = to - now;
  if (s <= 0) return "DUE";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}D ${h}H`;
  if (h > 0) return `${h}H ${m}M`;
  return `${m}M ${Math.floor(s % 60)}S`;
}

function phaseLabel(p: ArenaPhase | null): string | null {
  if (!p) return null;
  if (p.k === "approving") return "APPROVING USDG…";
  if (p.k === "sending") return "AWAITING SIGNATURE…";
  if (p.k === "confirming") return "CONFIRMING…";
  return null;
}

export function ArenaView({ setView }: { setView: (v: FloorView) => void }) {
  const wallet = useWallet();
  const [bouts, setBouts] = useState<Bout[] | null>(null); // null = loading
  const [mine, setMine] = useState<MyStake[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<string | null>(null); // action key
  const [phase, setPhase] = useState<ArenaPhase | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [stakeAmt, setStakeAmt] = useState("");
  const [selected, setSelected] = useState<bigint | null>(null);
  // create form
  const [creating, setCreating] = useState(false);
  const [cA, setCA] = useState("NVDA");
  const [cB, setCB] = useState("TSLA");
  const [cEntryH, setCEntryH] = useState("24");
  const [cWindowD, setCWindowD] = useState("7");

  const walletRef = useRef<string | null>(null);
  useEffect(() => { walletRef.current = wallet.account; }, [wallet.account]);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    if (!ARENA_ADDRESS) return;
    try {
      const bs = await fetchBouts();
      setBouts(bs);
      const acct = walletRef.current;
      if (acct) setMine(await fetchMyStakes(acct as Address, bs));
      else setMine([]);
    } catch { /* transport failure — keep last-good */ }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh, wallet.account]);

  /* ---------- gates ---------- */

  /* Sealed mode: NavArena is not yet deployed. The full venue renders so
     anyone can walk the Colosseum — real interface, zero simulated data —
     but every write is disarmed until the contract is live and verified. */
  const sealed = !ARENA_ADDRESS;

  /* ---------- actions ---------- */

  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (sealed) return;
    setBusy(key); setErr(null); setPhase(null);
    try { await fn(); await refresh(); }
    catch (e) {
      const name = arenaRevertName(e);
      setErr(name ?? (e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : "transaction failed"));
    }
    finally { setBusy(null); setPhase(null); }
  };

  const acct = wallet.account as Address | null;
  const sel = bouts?.find((b) => b.id === selected) ?? null;
  const selMine = mine.find((m) => m.boutId === selected) ?? null;

  const doStake = (sideA: boolean) => {
    if (!acct || !sel) return;
    const amt = parseUnits(stakeAmt || "0", 6);
    if (amt < MIN_STAKE) { setErr("MIN STAKE 1 USDG"); return; }
    void run(`stake${sideA ? "A" : "B"}`, () => stakeBout(acct, sel.id, sideA, amt, setPhase));
  };

  const doCreate = () => {
    if (!acct || sealed) return;
    const a = REG.find((t) => t.symbol === cA)?.address as Address | undefined;
    const b = REG.find((t) => t.symbol === cB)?.address as Address | undefined;
    if (!a || !b || a === b) { setErr("PICK TWO DIFFERENT LISTED STOCKS"); return; }
    const entryClose = now + Math.max(1, Number(cEntryH)) * 3600;
    const settleTime = entryClose + Math.max(1, Number(cWindowD)) * 86400;
    void run("create", () => createBout(acct, a, b, entryClose, settleTime, setPhase));
  };

  /* ---------- render ---------- */

  const board = sealed ? [] : bouts;
  const open = board?.filter((b) => b.state === "Open") ?? [];
  const locked = board?.filter((b) => b.state === "Locked") ?? [];
  const done = board?.filter((b) => b.state === "Settled" || b.state === "Voided") ?? [];

  const Row = ({ b }: { b: Bout }) => {
    const m = mine.find((x) => x.boutId === b.id);
    const isSel = selected === b.id;
    return (
      <button type="button" onClick={() => setSelected(isSel ? null : b.id)}
        className={`w-full text-left px-2 py-1.5 border-b border-rule hover:bg-panel-2 ${isSel ? "bg-panel-2" : ""}`}>
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-amber-2 w-8">#{b.id.toString()}</span>
          <span className="text-txt flex-1">{b.symA} <span className="text-txt-dim">VS</span> {b.symB}</span>
          {b.state === "Locked" && (
            <span className="text-[11px]">
              <span className={b.perfA !== null && b.perfB !== null && b.perfA >= b.perfB ? "text-up" : "text-txt-dim"}>{fmtPerf(b.perfA)}</span>
              <span className="text-txt-dim"> / </span>
              <span className={b.perfA !== null && b.perfB !== null && b.perfB > b.perfA ? "text-up" : "text-txt-dim"}>{fmtPerf(b.perfB)}</span>
            </span>
          )}
          <span className="text-txt-dim text-[11px]">{fmtUsdg(b.potA + b.potB)} POT</span>
          {b.state === "Open" && <span className="text-cyan text-[11px]">ENTRY {countdown(b.entryClose - 1800, now)}</span>}
          {b.state === "Locked" && <span className="text-amber text-[11px]">SETTLES {countdown(b.settleTime, now)}</span>}
          {b.state === "Settled" && <span className="text-up text-[11px]">{b.winner === 1 ? b.symA : b.symB} WON</span>}
          {b.state === "Voided" && <span className="text-dn text-[11px]">VOID — REFUNDS OPEN</span>}
          {m && (m.a > 0n || m.b > 0n) && <span className="text-amber-2 text-[10px]">MY {fmtUsdg(m.a + m.b)}</span>}
        </div>
      </button>
    );
  };

  return (
    <main className={`flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-[2px] p-[2px] lg:overflow-hidden ${sealed ? "lg:grid-rows-[auto_minmax(0,1fr)]" : ""}`}>
      {sealed && (
        <div className="lg:col-span-12 panel px-3 py-1.5 text-[11px] flex items-center gap-3 border-amber">
          <span className="text-amber-2">GATES SEALED</span>
          <span className="text-txt-dim">
            NavArena IS NOT YET DEPLOYED — YOU ARE WALKING THE COLOSSEUM BEFORE OPENING DAY. NO BOUTS EXIST,
            NOTHING IS SIMULATED, AND ALL ACTIONS ARE DISARMED UNTIL THE CONTRACT IS LIVE AND SOURCIFY-VERIFIED.
          </span>
        </div>
      )}
      {/* bout board */}
      <div className="lg:col-span-7 flex flex-col gap-[2px] min-h-0">
        <div className="panel flex items-center gap-3 px-3 py-1.5">
          <span className="panel-title !p-0">THE COLOSSEUM</span>
          <span className="text-txt-dim text-[10px]">STOCK VS STOCK · WINNERS SPLIT THE LOSING POT · {(Number(FEE_BPS_ARENA) / Number(BPS) * 100).toFixed(0)}% FEE BUYS NAV</span>
          <button type="button" className="fkey ml-auto px-3 py-1 text-[11px]" onClick={() => setView("WORLD")}>← MAP</button>
          <button type="button" className="fkey px-3 py-1 text-[11px]" onClick={() => setCreating((c) => !c)}>
            {creating ? "CLOSE" : "+ NEW BOUT"}
          </button>
        </div>

        {creating && (
          <div className="panel p-3 text-[12px] flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="cell-label">CHAMPION A</span>
              <select className="term-input w-28" value={cA} onChange={(e) => setCA(e.target.value)}>
                {REG.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="cell-label">CHAMPION B</span>
              <select className="term-input w-28" value={cB} onChange={(e) => setCB(e.target.value)}>
                {REG.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="cell-label">ENTRY OPEN (H)</span>
              <input className="term-input w-24" value={cEntryH} onChange={(e) => setCEntryH(e.target.value.replace(/[^0-9]/g, ""))} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="cell-label">WINDOW (DAYS)</span>
              <input className="term-input w-24" value={cWindowD} onChange={(e) => setCWindowD(e.target.value.replace(/[^0-9]/g, ""))} />
            </label>
            <button type="button" className="btn-exec px-4 py-1.5" disabled={!acct || busy !== null || sealed} onClick={doCreate}>
              {sealed ? "SEALED" : busy === "create" ? phaseLabel(phase) ?? "…" : "OPEN BOUT"}
            </button>
            <span className="text-txt-dim text-[10px] basis-full">
              ANYONE MAY OPEN A BOUT. ENTRY 1H–7D · WINDOW 1H–30D · STAKING CLOSES 30 MIN BEFORE ENTRY CLOSE.
            </span>
          </div>
        )}

        <div className="panel flex-1 min-h-0 overflow-y-auto">
          <div className="panel-title">OPEN FOR ENTRY ({open.length})</div>
          {board === null ? <div className="px-3 py-2 text-txt-dim text-[11px]">READING CHAIN…</div>
            : open.length === 0 ? <div className="px-3 py-2 text-txt-dim text-[11px]">{sealed ? "NO BOUTS — THE GATES OPEN WITH DEPLOYMENT." : "NO OPEN BOUTS — OPEN ONE."}</div>
            : open.map((b) => <Row key={b.id.toString()} b={b} />)}
          <div className="panel-title">IN THE PIT ({locked.length})</div>
          {locked.length === 0 ? <div className="px-3 py-2 text-txt-dim text-[11px]">NONE LOCKED.</div>
            : locked.map((b) => <Row key={b.id.toString()} b={b} />)}
          <div className="panel-title">HISTORY ({done.length})</div>
          {done.length === 0 ? <div className="px-3 py-2 text-txt-dim text-[11px]">NO SETTLED BOUTS YET.</div>
            : done.map((b) => <Row key={b.id.toString()} b={b} />)}
        </div>
      </div>

      {/* ticket */}
      <div className="lg:col-span-5 flex flex-col gap-[2px] min-h-0 lg:overflow-y-auto">
        <div className="panel relative overflow-hidden" style={{ minHeight: 120 }}>
          <img src="./world/colosseum.png" alt="" aria-hidden
            className="absolute inset-0 w-full h-full object-cover opacity-25" style={{ imageRendering: "pixelated" }} draggable={false} />
          <div className="relative p-3">
            <div className="panel-title !border-0 !p-0">BOUT TICKET</div>
            {!sel ? (
              <p className="text-txt-dim text-[11px] mt-1">{sealed ? "THE SAND IS RAKED, THE STANDS ARE EMPTY. WHEN NavArena GOES LIVE, EVERY BOUT ON THE BOARD IS A REAL ON-CHAIN CONTEST — PICK ONE HERE TO STAKE, CRANK OR CLAIM." : "SELECT A BOUT FROM THE BOARD."}</p>
            ) : (
              <div className="text-[12px] mt-1 space-y-1">
                <div className="text-amber-2 text-[14px]">#{sel.id.toString()} · {sel.symA} VS {sel.symB}</div>
                <div className="text-txt-dim text-[10px]">
                  ENTRY CLOSES {new Date(sel.entryClose * 1000).toUTCString().replace(" GMT", "Z")} ·
                  SETTLES {new Date(sel.settleTime * 1000).toUTCString().replace(" GMT", "Z")}
                </div>
                <div className="flex gap-4">
                  <span>POT {sel.symA}: <span className="text-txt">{fmtUsdg(sel.potA)}</span></span>
                  <span>POT {sel.symB}: <span className="text-txt">{fmtUsdg(sel.potB)}</span></span>
                </div>
                {sel.state === "Locked" && (
                  <div className="flex gap-4">
                    <span>{sel.symA} {fmtPerf(sel.perfA)}</span>
                    <span>{sel.symB} {fmtPerf(sel.perfB)}</span>
                  </div>
                )}
                {sel.state === "Settled" && sel.winner !== 0 && (
                  <div className="text-up">WINNER: {sel.winner === 1 ? sel.symA : sel.symB}</div>
                )}
                {selMine && (selMine.a > 0n || selMine.b > 0n) && (
                  <div className="text-amber-2">
                    MY STAKE — {sel.symA}: {fmtUsdg(selMine.a)} · {sel.symB}: {fmtUsdg(selMine.b)}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {sel && (
          <div className="panel p-3 text-[12px] space-y-2">
            {/* stake (Open only, before buffer) */}
            {sel.state === "Open" && now < sel.entryClose - 1800 && (
              <>
                <div className="cell-label">STAKE USDG (MIN 1)</div>
                <div className="flex gap-2">
                  <input className="term-input flex-1" placeholder="0.00" value={stakeAmt}
                    onChange={(e) => setStakeAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
                  <button type="button" className="btn-exec px-3 py-1" disabled={!acct || busy !== null} onClick={() => doStake(true)}>
                    {busy === "stakeA" ? phaseLabel(phase) ?? "…" : `BACK ${sel.symA}`}
                  </button>
                  <button type="button" className="btn-exec px-3 py-1" disabled={!acct || busy !== null} onClick={() => doStake(false)}>
                    {busy === "stakeB" ? phaseLabel(phase) ?? "…" : `BACK ${sel.symB}`}
                  </button>
                </div>
                {stakeAmt && (() => {
                  try {
                    const amt = parseUnits(stakeAmt, 6);
                    return (
                      <div className="text-txt-dim text-[10px]">
                        IF {sel.symA} WINS: BACKING A PAYS ≈ {fmtUsdg(previewPayout(amt, sel.potA + amt, sel.potB))} ·
                        IF {sel.symB} WINS: BACKING B PAYS ≈ {fmtUsdg(previewPayout(amt, sel.potB + amt, sel.potA))} (AT CURRENT POTS)
                      </div>
                    );
                  } catch { return null; }
                })()}
                <div className="text-txt-dim text-[10px]">STAKES ARE FINAL — NO UNSTAKE. ONE-SIDED BOUTS VOID AND REFUND.</div>
              </>
            )}
            {sel.state === "Open" && now >= sel.entryClose - 1800 && now < sel.entryClose && (
              <div className="text-txt-dim text-[11px]">STAKING CLOSED (30-MIN BUFFER). LOCK OPENS AT ENTRY CLOSE.</div>
            )}

            {/* crank actions — permissionless */}
            <div className="flex flex-wrap gap-2">
              {sel.state === "Open" && now >= sel.entryClose && (
                <button type="button" className="fkey px-3 py-1" disabled={!acct || busy !== null}
                  onClick={() => acct && void run("lock", () => lockBout(acct, sel.id, setPhase))}>
                  {busy === "lock" ? phaseLabel(phase) ?? "…" : "LOCK (SNAP START PRICES)"}
                </button>
              )}
              {sel.state === "Locked" && now >= sel.settleTime && (
                <button type="button" className="fkey px-3 py-1" disabled={!acct || busy !== null}
                  onClick={() => acct && void run("settle", () => settleBout(acct, sel.id, setPhase))}>
                  {busy === "settle" ? phaseLabel(phase) ?? "…" : "SETTLE (EARN 10% OF FEE)"}
                </button>
              )}
              {((sel.state === "Open" && now > sel.entryClose + 86400) || (sel.state === "Locked" && now > sel.settleTime + 86400)) && (
                <button type="button" className="fkey px-3 py-1" disabled={!acct || busy !== null}
                  onClick={() => acct && void run("void", () => voidBoutTx(acct, sel.id, setPhase))}>
                  {busy === "void" ? phaseLabel(phase) ?? "…" : "VOID (OVERDUE)"}
                </button>
              )}
              {(sel.state === "Settled" || sel.state === "Voided") && selMine && (selMine.a > 0n || selMine.b > 0n) && (
                <button type="button" className="btn-exec px-3 py-1" disabled={!acct || busy !== null}
                  onClick={() => acct && void run("claim", () => claimBout(acct, sel.id, setPhase))}>
                  {busy === "claim" ? phaseLabel(phase) ?? "…" : "CLAIM"}
                </button>
              )}
            </div>

            {err && <div className="text-dn text-[11px]">ERR: {err}</div>}
            {!acct && <div className="text-txt-dim text-[10px]">CONNECT A WALLET TO ACT.</div>}
            {ARENA_ADDRESS && (
              <a className="text-cyan text-[10px] no-underline" href={`${EXPLORER}/address/${ARENA_ADDRESS}`} target="_blank" rel="noopener noreferrer">
                CONTRACT ON EXPLORER ↗
              </a>
            )}
          </div>
        )}

        <div className="panel p-3 text-[10px] text-txt-dim space-y-1">
          <div className="panel-title !p-0 !border-0">HOUSE RULES</div>
          <p>PERFORMANCE = SETTLE PRICE / START PRICE, BOTH SNAPPED BY PitOracleV2'S ANCHOR-VERIFIED RAILS (CHAINLINK BRACKET OR PYTH SETTLEMENT WINDOW — NEVER A BARE TWAP).</p>
          <p>LOCK MUST LAND WITHIN 24H OF ENTRY CLOSE; SETTLE WITHIN 24H OF SETTLE TIME; OTHERWISE THE BOUT VOIDS AND EVERY STAKE IS REFUNDED IN FULL.</p>
          <p>DRAWS VOID. ONE-SIDED BOUTS VOID. ORACLE CONFIG CHANGES MID-BOUT VOID. 2% OF THE LOSING POT IS THE ONLY FEE — 90% BUYS NAV VIA THE ACCUMULATOR, 10% PAYS THE SETTLER.</p>
        </div>
      </div>
    </main>
  );
}
