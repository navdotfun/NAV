/* OPTIONS — writer desk. Deposit stock (CALL side) or USDG (PUT side) to
   underwrite options and earn streamia. Premium harvest is principal-safe. */
import { useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { EXPLORER, TOKENS } from "../../lib/chain";
import { useWallet, requestConnect } from "../../lib/wallet";
import { fmt } from "../../lib/format";
import {
  NAV_OPTIONS, fetchWriterStats, writerDeposit, writerWithdraw, harvestPremium,
  type OptMarket, type OptExecPhase, type WriterStats,
} from "../../lib/options";

export function WriterDesk({ market, onChanged }: {
  market: OptMarket | null;
  onChanged: () => void;
}) {
  const w = useWallet();
  const [side, setSide] = useState<0 | 1>(0);
  const [mode, setMode] = useState<"DEPOSIT" | "WITHDRAW">("DEPOSIT");
  const [amount, setAmount] = useState("");
  /* R4 F-06: MAX exit — when set, act() submits the wallet's exact share
     balance instead of round-tripping through the asset conversion (which
     floors and strands dust). Cleared by any manual edit. */
  const [maxExit, setMaxExit] = useState(false);
  const [stats, setStats] = useState<WriterStats | null>(null);
  const [phase, setPhase] = useState<OptExecPhase>({ k: "idle" });
  /* B-04: synchronous double-submit guard. */
  const inFlight = useRef(false);
  /* R4 F-12: only blank stats when the IDENTITY (market/account) changes —
     a phase flip (tx confirmed) must refresh in place, not flash "—". */
  const prevClearKey = useRef<string | null>(null);

  /* B-11: keyed on market.id (not object identity) + its own deliberate 30s
     poll so pending premium updates; keep last-good on transport failure. */
  const marketId = market?.id;
  useEffect(() => {
    if (w.status !== "connected" || !w.account || marketId === undefined) {
      setStats(null); prevClearKey.current = null; return;
    }
    let dead = false;
    const clearKey = `${marketId}|${w.account.toLowerCase()}`;
    if (prevClearKey.current !== clearKey) {
      setStats(null); // selection/wallet changed — old stats no longer apply
      prevClearKey.current = clearKey;
    }
    const tick = async () => {
      try {
        const s = await fetchWriterStats(marketId, w.account!);
        if (!dead) setStats(s);
      } catch { /* transport failure — keep last-good, retry next tick */ }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { dead = true; clearInterval(id); };
  }, [w.status, w.account, marketId, phase.k]);

  if (!market) return null;
  const busy = phase.k === "approving" || phase.k === "sending";
  const assetSym = side === 0 ? market.symbol : "USDG";
  const assetDec = side === 0 ? 18 : 6;
  /* vault stats are null when the batched read failed — render “—”, never 0. */
  const vault = side === 0 ? market.callVault : market.putVault;
  const myShares = stats ? (side === 0 ? stats.callShares : stats.putShares) : null;
  /* R4 F-06: writer's share of vault assets — MUST mirror the contract's
     virtual-share offsets (VIRT_SHARES=1000, VIRT_ASSETS=1; NavOptions:312)
     or the display drifts from what withdraw actually pays. */
  const VIRT_SHARES = 1000n;
  const VIRT_ASSETS = 1n;
  const myAssets = vault !== null && myShares !== null
    ? (myShares * (vault.assets + VIRT_ASSETS)) / (vault.totalShares + VIRT_SHARES)
    : null;

  const act = async () => {
    if (!w.account || inFlight.current) return;
    if (mode === "WITHDRAW" && (vault === null || myShares === null)) return; // can't convert without a live read
    inFlight.current = true;
    setPhase({ k: "idle" });
    try {
      if (mode === "DEPOSIT") {
        await writerDeposit({
          marketId: market.id, side, amount: parseUnits(amount, assetDec),
          assetToken: side === 0 ? market.token : TOKENS.USDG.address,
          account: w.account, onPhase: setPhase,
        });
      } else if (maxExit) {
        /* R4 F-06: full exit — submit the exact share balance, zero dust. */
        await writerWithdraw({
          marketId: market.id, side, shares: myShares!,
          account: w.account, onPhase: setPhase,
        });
      } else {
        /* R4 F-06: assets→shares with the contract's virtual offsets, rounding
           UP so the withdrawal never under-delivers the requested amount;
           clamped to the wallet's balance. (Old floor-math under-withdrew and
           could compute 0 shares for small amounts.) */
        const amt = parseUnits(amount, assetDec);
        const denom = vault!.assets + VIRT_ASSETS;
        let shares = (amt * (vault!.totalShares + VIRT_SHARES) + denom - 1n) / denom;
        if (shares > myShares!) shares = myShares!;
        await writerWithdraw({
          marketId: market.id, side, shares,
          account: w.account, onPhase: setPhase,
        });
      }
      setAmount("");
      setMaxExit(false);
      onChanged();
    } finally { inFlight.current = false; }
  };

  const harvest = async () => {
    if (!w.account || inFlight.current) return;
    inFlight.current = true;
    setPhase({ k: "idle" });
    try {
      await harvestPremium(market.id, w.account, setPhase);
      onChanged();
    } finally { inFlight.current = false; }
  };

  return (
    <section className="panel flex flex-col" aria-label="writer desk">
      <div className="panel-title">
        <span>WRITER DESK · {market.symbol}</span>
        <span className="text-txt-dim normal-case tracking-normal">EARN STREAMIA</span>
      </div>
      <div className="p-2 flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-[2px]" role="tablist" aria-label="vault side">
          <button role="tab" aria-selected={side === 0}
            className={`py-1 text-[11px] font-bold border ${side === 0 ? "border-amber text-amber-2 bg-amber/10" : "border-rule-2 text-txt-dim hover:border-amber/60"}`}
            onClick={() => setSide(0)}>CALL VAULT ({market.symbol})</button>
          <button role="tab" aria-selected={side === 1}
            className={`py-1 text-[11px] font-bold border ${side === 1 ? "border-amber text-amber-2 bg-amber/10" : "border-rule-2 text-txt-dim hover:border-amber/60"}`}
            onClick={() => setSide(1)}>PUT VAULT (USDG)</button>
        </div>

        <div className="grid grid-cols-3 gap-1 text-[11px]">
          <Cell k="MY STAKE" v={myAssets !== null ? `${fmt.num(Number(formatUnits(myAssets, assetDec)))} ${assetSym}` : "—"} />
          <Cell k="VAULT FREE" v={vault !== null ? fmt.num(Number(formatUnits(vault.freeAssets, assetDec))) : "—"} />
          <Cell k="PENDING PREM" v={stats && stats.pending !== null ? fmt.usd(Number(stats.pending) / 1e6, 4) : "—"} hot />
        </div>

        <div className="grid grid-cols-2 gap-[2px]" role="tablist" aria-label="mode">
          {(["DEPOSIT", "WITHDRAW"] as const).map((mo) => (
            <button key={mo} role="tab" aria-selected={mode === mo}
              className={`py-1 text-[11px] font-bold border ${mode === mo ? "border-cyan text-cyan bg-cyan/10" : "border-rule-2 text-txt-dim hover:border-cyan/60"}`}
              onClick={() => setMode(mo)}>{mo}</button>
          ))}
        </div>

        <div className="flex gap-[2px]">
          <input className="term-input flex-1" inputMode="decimal" autoComplete="off"
            placeholder={`${assetSym} amount`} value={amount} aria-label="amount"
            onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d*$/.test(v)) { setAmount(v); setMaxExit(false); } }} />
          {mode === "WITHDRAW" && myShares !== null && myShares > 0n && myAssets !== null && (
            <button type="button" className="fkey !flex-none !px-2 text-[10.5px]" disabled={busy}
              onClick={() => { setAmount(formatUnits(myAssets, assetDec)); setMaxExit(true); }}>
              MAX
            </button>
          )}
          {w.status !== "connected" ? (
            <button className="btn-exec !flex-none !px-3" onClick={() => requestConnect()}>CONNECT</button>
          ) : (
            <button className="btn-exec !flex-none !px-3"
              disabled={!NAV_OPTIONS || busy || !amount || Number(amount) <= 0
                || (mode === "WITHDRAW" && (vault === null || myShares === null))}
              onClick={() => void act()}>
              {busy ? "…" : mode}
            </button>
          )}
        </div>

        {stats && stats.pending !== null && stats.pending > 0n && (
          <button className="fkey w-full text-center" disabled={busy} onClick={() => void harvest()}>
            HARVEST {fmt.usd(Number(stats.pending) / 1e6, 4)} PREMIUM
          </button>
        )}

        {phase.k === "error" && (
          <p className="text-[11px] text-dn" role="alert">
            ✕ {phase.message}
            {phase.hash && (
              <>{" "}· <a className="text-cyan hover:underline" href={`${EXPLORER}/tx/${phase.hash}`} target="_blank" rel="noopener noreferrer">TX</a></>
            )}
          </p>
        )}
        {phase.k === "done" && (
          <p className="text-[11px] text-up" role="status">
            ✓ DONE ·{" "}
            <a className="text-cyan hover:underline" href={`${EXPLORER}/tx/${phase.hash}`} target="_blank" rel="noopener noreferrer">TX</a>
          </p>
        )}

        <p className="text-[10px] leading-relaxed text-txt-dim">
          {side === 0
            ? `DEPOSIT ${market.symbol} · BACKS CALLS · EARNS USDG PREMIUM (HARVEST ANY TIME)`
            : "DEPOSIT USDG · BACKS PUTS · PREMIUM AUTO-COMPOUNDS INTO SHARES"} ·
          WITHDRAW LIMITED TO UNESCROWED CAPITAL · ONE-BLOCK COOLDOWN AFTER DEPOSIT
        </p>
      </div>
    </section>
  );
}

function Cell({ k, v, hot }: { k: string; v: string; hot?: boolean }) {
  return (
    <div className="border border-rule bg-panel-2 p-1.5">
      <div className="cell-label">{k}</div>
      <div className={`${hot ? "text-amber-2" : "text-txt"} tabular-nums text-[11.5px] mt-0.5`}>{v}</div>
    </div>
  );
}
