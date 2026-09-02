/* PIT — writer (LP) desk. Terminal port of site WriterPanel.tsx: deposits
   collateral into the selected (side, strike) bucket — CALL buckets escrow the
   underlying, PUT buckets escrow USDG. Live bucket state (free / locked / your
   shares) is read straight from the pool. Writers earn every premium paid on
   their bucket. Logic is verbatim from the site; only presentation changed.

   This file also carries the oracle-heartbeat module (site lib/oracleHealth.ts)
   ported VERBATIM, because floor/src/lib/nav has no oracleHealth and the brief
   restricts writes to the five pit components. PitView imports
   `heartbeatCoverage` from here for the pit-wide coverage strip. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { parseUnits } from "viem";
import { publicClient, TOKENS } from "../../lib/nav/chain";
import { limited } from "../../lib/nav/rpc";
import { erc20WriteAbi, pitPoolAbi, PIT, type PitMarket } from "../../lib/nav/pit";
import { useWallet, walletClient, ensureChain } from "../../lib/nav/wallet";
import { requestConnect } from "../../lib/wallet";
import { fmt } from "../../lib/format";
import type { PitSide } from "../../lib/nav/pitPricer";

/* ================================================================
   Oracle heartbeat health — audit v3 guard #1 (finding P3-01, CRITICAL).

   PitOracle.snapshotSettlement only applies its settlement clamp when
   `lastValidTwap != 0` (`hasRef`). A market that has never been poked has
   `lastValidTwap == 0`, so settlement takes the RAW 30-minute TWAP with no
   band — and the written settlement price is immutable. On a thin Uniswap v3
   pool that is a cheap collateral-extraction vector against writers.

   `poke()` is permissionless and a single call arms the clamp forever, so this
   is an operational fix — but until the heartbeat exists on a given market,
   the UI must HARD-BLOCK writer deposits into that market. Buying is not
   blocked (a buyer's downside is capped at the premium they paid), but the
   staleness of the heartbeat is disclosed everywhere.

   Ported verbatim from site/src/lib/oracleHealth.ts.
   ================================================================ */

export const pitOracleHealthAbi = [
  {
    type: "function",
    name: "lastValidTwap",
    stateMutability: "view",
    inputs: [{ name: "underlying", type: "address" }],
    outputs: [{ name: "price", type: "uint256" }, { name: "updatedAt", type: "uint256" }],
  },
  {
    type: "function",
    name: "poke",
    stateMutability: "nonpayable",
    inputs: [{ name: "underlying", type: "address" }],
    outputs: [{ name: "stored", type: "uint256" }],
  },
] as const;

/** Heartbeat older than this widens the settlement clamp — disclose it (guard 4). */
export const HEARTBEAT_WARN_S = 24 * 60 * 60;

export type HeartbeatStatus =
  /** never poked — settlement clamp INERT. Writer deposits must be blocked. */
  | "cold"
  /** poked, but the last heartbeat is over 24h old — clamp band is widened. */
  | "stale"
  /** healthy heartbeat. */
  | "armed"
  | "loading"
  | "error";

export interface Heartbeat {
  status: HeartbeatStatus;
  /** last recorded reference price, 1e18 fp (0 when cold). */
  price: bigint | null;
  /** unix seconds of the last poke (0 when cold). */
  updatedAt: number | null;
  /** seconds since the last poke, null when cold/unknown. */
  ageS: number | null;
}

const COLD: Heartbeat = { status: "cold", price: 0n, updatedAt: 0, ageS: null };

function classify(price: bigint, updatedAt: bigint): Heartbeat {
  if (price === 0n || updatedAt === 0n) return COLD;
  const at = Number(updatedAt);
  const ageS = Math.max(0, Math.floor(Date.now() / 1000) - at);
  return { status: ageS > HEARTBEAT_WARN_S ? "stale" : "armed", price, updatedAt: at, ageS };
}

/** Read one market's oracle heartbeat. Refreshes every 60s so a poke landing
    while the page is open unlocks the deposit path without a reload. */
export function useHeartbeat(underlying: Address | null): Heartbeat {
  const [hb, setHb] = useState<Heartbeat>({ status: "loading", price: null, updatedAt: null, ageS: null });

  useEffect(() => {
    if (!underlying) {
      setHb({ status: "loading", price: null, updatedAt: null, ageS: null });
      return;
    }
    let stop = false;
    const pull = async () => {
      try {
        const [price, updatedAt] = await limited(() => publicClient.readContract({
          address: PIT.oracle,
          abi: pitOracleHealthAbi,
          functionName: "lastValidTwap",
          args: [underlying],
        }));
        if (!stop) setHb(classify(price, updatedAt));
      } catch {
        if (!stop) setHb({ status: "error", price: null, updatedAt: null, ageS: null });
      }
    };
    void pull();
    const id = setInterval(() => void pull(), 60_000);
    return () => { stop = true; clearInterval(id); };
  }, [underlying]);

  return hb;
}

/** Batch heartbeat read across markets — used for the Pit-wide coverage banner. */
export async function heartbeatCoverage(underlyings: Address[]): Promise<{
  armed: number;
  stale: number;
  cold: number;
  total: number;
}> {
  const res = await publicClient.multicall({
    contracts: underlyings.map((u) => ({
      address: PIT.oracle,
      abi: pitOracleHealthAbi,
      functionName: "lastValidTwap" as const,
      args: [u] as const,
    })),
    allowFailure: true,
  });
  let armed = 0, stale = 0, cold = 0;
  for (const r of res) {
    if (r.status !== "success") { cold++; continue; }
    const [price, updatedAt] = r.result as readonly [bigint, bigint];
    const c = classify(price, updatedAt);
    if (c.status === "armed") armed++;
    else if (c.status === "stale") stale++;
    else cold++;
  }
  return { armed, stale, cold, total: underlyings.length };
}

export function heartbeatAgeLabel(ageS: number | null): string {
  if (ageS === null) return "never";
  if (ageS < 90) return `${ageS}s ago`;
  if (ageS < 5400) return `${Math.round(ageS / 60)}m ago`;
  if (ageS < 172_800) return `${Math.round(ageS / 3600)}h ago`;
  return `${Math.round(ageS / 86_400)}d ago`;
}

/** Clamp band the oracle will allow at settlement given heartbeat age.
    Mirrors PitOracle._clampWithDecay: the base band widens by one band per
    elapsed decay period, capped at 7x. Purely informational (guard 4). */
export function clampBandBps(baseBps: number, ageS: number | null): number {
  if (ageS === null) return 0; // cold — NO clamp at all
  const periods = 1 + Math.floor(ageS / HEARTBEAT_WARN_S);
  return baseBps * Math.min(periods, 7);
}

/* ================================================================
   Writer desk — verbatim WriterPanel.tsx logic, terminal chrome.
   ================================================================ */

const USDG = TOKENS.USDG.address as Address;

interface BucketView {
  free: number;
  locked: number;
  totalShares: bigint;
  myShares: bigint;
  myAssets: number;
  walletBal: number;
}

type Busy = null | "deposit" | "withdraw" | "claim";

export function PitWriter({
  market, symbol, side, strike,
}: {
  market: PitMarket | null;
  symbol: string;
  side: PitSide;
  strike: number | null;
}) {
  const w = useWallet();
  const [amount, setAmount] = useState("");
  const [view, setView] = useState<BucketView | null>(null);
  /** B-05: true when the latest refresh failed — figures shown are last-good. */
  const [viewStale, setViewStale] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);
  const seq = useRef(0);

  /* AUDIT v3 GUARD #1 (P3-01, CRITICAL) — the oracle settlement clamp is inert
     until a market has been poked at least once. Depositing writer collateral
     into a cold market exposes it to an unclamped settlement price, so the
     deposit path is HARD-BLOCKED (not merely warned) while status is cold. */
  const hb = useHeartbeat(market?.underlying ?? null);
  const oracleCold = hb.status === "cold";
  const oracleStale = hb.status === "stale";
  /* Fail CLOSED: an unreadable heartbeat blocks deposits exactly like a cold one
     — never let an RPC hiccup open an unguarded deposit path. */
  const oracleUnverified = hb.status === "loading" || hb.status === "error";
  const depositBlocked = oracleCold || oracleUnverified;

  const isCall = side === "CALL";
  const collateral = market ? (isCall ? market.underlying : USDG) : null;
  const decimals = isCall ? 18 : 6;
  /* B-27: strike → 1e18 via parseUnits on the decimal string (6dp is the
     pit's strike grid; matches the previous scaling exactly, minus float error). */
  const strike1e18 = useMemo(
    () => (strike !== null ? parseUnits(strike.toFixed(6), 18) : null),
    [strike],
  );

  const pull = useCallback(async () => {
    if (!market || strike1e18 === null) {
      setView(null);
      return;
    }
    const my = ++seq.current;
    try {
      const calls: Promise<unknown>[] = [
        limited(() => publicClient.readContract({ address: market.pitPool, abi: pitPoolAbi, functionName: "buckets", args: [isCall, strike1e18] })),
      ];
      const account = w.account;
      if (account) {
        calls.push(
          limited(() => publicClient.readContract({ address: market.pitPool, abi: pitPoolAbi, functionName: "lps", args: [isCall, strike1e18, account] })),
          limited(() => publicClient.readContract({ address: collateral!, abi: erc20WriteAbi, functionName: "balanceOf", args: [account] })),
        );
      }
      const res = await Promise.all(calls);
      if (seq.current !== my) return;
      const b = res[0] as readonly [bigint, bigint, bigint, bigint];
      const lp = w.account ? (res[1] as readonly [bigint, bigint]) : null;
      const bal = w.account ? (res[2] as bigint) : 0n;
      const free = Number(b[0]) / 10 ** decimals;
      const locked = Number(b[1]) / 10 ** decimals;
      const totalShares = b[2];
      const myShares = lp ? lp[0] : 0n;
      const VIRT = 1000n;
      const assets = b[0] + b[1];
      const myAssets = totalShares + VIRT > 0n && myShares > 0n
        ? Number((myShares * (assets + 1n)) / (totalShares + VIRT)) / 10 ** decimals
        : 0;
      setView({ free, locked, totalShares, myShares, myAssets, walletBal: Number(bal) / 10 ** decimals });
      setViewStale(false);
    } catch {
      /* B-05: keep the last-good figures and flag them stale — a transient RPC
         failure must never erase the writer's live collateral numbers. */
      if (seq.current === my) setViewStale(true);
    }
  }, [market, strike1e18, isCall, collateral, decimals, w.account]);

  useEffect(() => {
    /* selection or wallet changed — the old bucket's figures no longer apply. */
    setView(null);
    setViewStale(false);
    void pull();
    const t = setInterval(() => void pull(), 20_000);
    return () => clearInterval(t);
  }, [pull]);

  const run = useCallback(async (kind: Exclude<Busy, null>) => {
    if (!market || strike1e18 === null || !w.account) return;
    const wc = walletClient();
    if (!wc) return;
    if (w.status === "wrong-chain" && !(await ensureChain())) return;
    setBusy(kind);
    setNote(null);
    try {
      // Every write below follows the hardened buy pipeline: simulate first
      // (predictable reverts cost no gas), then send, then gate success on
      // receipt.status — a reverted tx must NEVER show a green note (H-01).
      const requireSuccess = async (hash: `0x${string}`, what: string) => {
        const rcpt = await publicClient.waitForTransactionReceipt({ hash });
        if (rcpt.status !== "success") throw new Error(`${what} reverted on-chain — no state was changed (only gas was spent).`);
      };
      if (kind === "deposit") {
        const amt = Number.parseFloat(amount);
        if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter a collateral amount.");
        /* B-27: decimal-string → wei via parseUnits (no binary-float rounding). */
        const wei = parseUnits(amount.trim(), decimals);
        if (view && amt > view.walletBal) throw new Error(`Amount exceeds your wallet balance of ${view.walletBal.toLocaleString("en-US", { maximumFractionDigits: 4 })}.`);
        const allowance = (await publicClient.readContract({
          address: collateral!, abi: erc20WriteAbi, functionName: "allowance", args: [w.account, market.pitPool],
        })) as bigint;
        if (allowance < wei) {
          const h0 = await wc.writeContract({
            address: collateral!, abi: erc20WriteAbi, functionName: "approve",
            args: [market.pitPool, wei], account: w.account, chain: wc.chain,
          });
          await requireSuccess(h0, "Approval");
        }
        const sim = await publicClient.simulateContract({
          address: market.pitPool, abi: pitPoolAbi, functionName: "deposit",
          args: [isCall, strike1e18, wei], account: w.account,
        });
        const h = await wc.writeContract(sim.request);
        await requireSuccess(h, "Deposit");
        setNote({ tone: "ok", msg: `Deposited ${amount} ${isCall ? symbol : "USDG"} into the ${side} ${fmt.usd(strike ?? 0)} bucket.` });
      } else if (kind === "withdraw") {
        if (!view || view.myShares === 0n) throw new Error("No shares in this bucket.");
        const sim = await publicClient.simulateContract({
          address: market.pitPool, abi: pitPoolAbi, functionName: "withdraw",
          args: [isCall, strike1e18, view.myShares], account: w.account,
        });
        const h = await wc.writeContract(sim.request);
        await requireSuccess(h, "Withdraw");
        setNote({ tone: "ok", msg: "Withdrew all free collateral for your shares." });
      } else {
        const sim = await publicClient.simulateContract({
          address: market.pitPool, abi: pitPoolAbi, functionName: "claimPremiums",
          args: [isCall, strike1e18], account: w.account,
        });
        const h = await wc.writeContract(sim.request);
        await requireSuccess(h, "Claim");
        setNote({ tone: "ok", msg: "Premiums claimed to your wallet in USDG." });
      }
      setAmount("");
      await pull();
    } catch (e) {
      const s = e instanceof Error ? e.message : String(e);
      setNote({
        tone: "err",
        msg: /user rejected|denied/i.test(s) ? "Signature rejected in wallet."
          : /FreezeWindow|Frozen/i.test(s) ? "Bucket frozen near expiry with open interest — withdraw after settlement."
          : /InsufficientLiquidity/i.test(s) ? "Amount exceeds your free (unlocked) collateral."
          : /NothingToClaim/i.test(s) ? "No premiums accrued to claim on this bucket."
          : s.slice(0, 140),
      });
    } finally {
      setBusy(null);
    }
  }, [market, strike1e18, w.account, w.status, amount, decimals, collateral, isCall, side, strike, symbol, view, pull]);

  if (!market) return null;

  return (
    <section className="panel flex flex-col" aria-label="writer desk">
      <div className="panel-title">
        <span>WRITE · EARN PREMIUMS</span>
        <span className="text-txt-dim normal-case tracking-normal tabular-nums">
          {side} {strike !== null ? fmt.usd(strike) : "—"} BUCKET · COLL {isCall ? symbol : "USDG"}
        </span>
      </div>
      <div className="p-2 flex flex-col gap-2">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-[11px]">
          <Cell k="FREE" v={view ? view.free.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"} />
          <Cell k="LOCKED" v={view ? view.locked.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"} />
          <Cell k="YOUR POSITION" v={view ? view.myAssets.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"} hot />
          <Cell k="WALLET" v={view ? view.walletBal.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"} />
        </div>
        {viewStale && view && (
          <p className="text-[10px] tracking-[0.14em] text-dn" role="status">STALE — RETRYING (figures are last-good)</p>
        )}

        {w.status !== "connected" ? (
          <button
            className="btn-exec"
            title={w.status === "wrong-chain" ? "Your wallet is on another network — switch to Robinhood Chain (4663)" : undefined}
            onClick={() => { if (w.status === "wrong-chain") { void ensureChain(); } else { requestConnect(); } }}
          >
            {w.status === "wrong-chain" ? "SWITCH TO ROBINHOOD CHAIN" : "CONNECT WALLET TO WRITE"}
          </button>
        ) : (
          <>
            <div className="flex gap-[2px] items-stretch">
              <input
                className="term-input flex-1"
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="0.0"
                aria-label="Collateral amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <span className="cell-label border border-rule-2 px-2 flex items-center flex-none">{isCall ? symbol : "USDG"}</span>
            </div>
            <div className="grid grid-cols-3 gap-[2px]">
              <button
                className="fkey text-center !px-1"
                disabled={busy !== null || depositBlocked}
                title={
                  oracleCold
                    ? "Oracle reference not initialised on this market — deposits are blocked"
                    : oracleUnverified
                      ? "Verifying the oracle reference — deposits stay locked until it is confirmed"
                      : undefined
                }
                onClick={() => void run("deposit")}
              >
                {busy === "deposit" ? "WORKING…" : oracleCold ? "DEPOSITS LOCKED" : oracleUnverified ? "VERIFYING ORACLE…" : "DEPOSIT"}
              </button>
              <button className="fkey text-center !px-1" disabled={busy !== null || !view || view.myShares === 0n} onClick={() => void run("withdraw")}>
                {busy === "withdraw" ? "WORKING…" : "WITHDRAW ALL"}
              </button>
              <button className="fkey text-center !px-1" disabled={busy !== null || !view || view.myShares === 0n} onClick={() => void run("claim")}>
                {busy === "claim" ? "WORKING…" : "CLAIM PREMIUMS"}
              </button>
            </div>
          </>
        )}

        {note && (
          <p className={`text-[11px] ${note.tone === "ok" ? "text-up" : "text-dn"}`} role={note.tone === "err" ? "alert" : "status"}>
            {note.tone === "ok" ? "✓ " : "✕ "}{note.msg}
          </p>
        )}

        {market && oracleCold && (
          <div className="border border-dn/60 bg-panel-2 p-2 flex flex-col gap-1">
            <span className="text-[11px] font-bold tracking-[0.12em] text-dn">MARKET NOT READY — ORACLE REFERENCE NOT INITIALISED</span>
            <span className="text-[10.5px] leading-relaxed text-txt-dim">
              This market has never recorded a reference price, so the settlement-price clamp is
              inactive and a settlement could print far from fair value. Writing collateral here is
              blocked until the reference is live. Buying is unaffected — a buyer&rsquo;s risk is the
              premium. Withdrawals and premium claims stay open.
            </span>
          </div>
        )}

        {market && oracleStale && (
          <div className="border border-amber/60 bg-panel-2 p-2 flex flex-col gap-1">
            <span className="text-[11px] font-bold tracking-[0.12em] text-amber-2">STALE REFERENCE — WIDENED SETTLEMENT BAND</span>
            <span className="text-[10.5px] leading-relaxed text-txt-dim">
              Last reference price {heartbeatAgeLabel(hb.ageS)}. The settlement clamp widens with
              reference age — it currently permits up to{" "}
              {(clampBandBps(1500, hb.ageS) / 100).toFixed(0)}% movement versus the last recorded
              price. Deposits are allowed but you are accepting a wider settlement band. If the
              underlying pool is halted, settlement will use the last recorded reference price,
              which may be stale.
            </span>
          </div>
        )}

        {market && hb.status === "error" && (
          <div className="border border-amber/60 bg-panel-2 p-2 flex flex-col gap-1">
            <span className="text-[11px] font-bold tracking-[0.12em] text-amber-2">ORACLE STATUS UNAVAILABLE — DEPOSITS PAUSED</span>
            <span className="text-[10.5px] leading-relaxed text-txt-dim">
              The oracle reference could not be read, so deposits are paused as a precaution. This
              usually clears within a minute; withdrawals and claims are unaffected.
            </span>
          </div>
        )}

        {market && hb.status === "armed" && (
          <p className="text-[10px] leading-relaxed text-txt-dim">
            ORACLE REFERENCE LIVE · CHAINLINK/PYTH ANCHORED · UPDATED {heartbeatAgeLabel(hb.ageS).toUpperCase()} · SETTLEMENT CLAMPED
            TO ±{(clampBandBps(1500, hb.ageS) / 100).toFixed(0)}%
          </p>
        )}

        <p className="text-[10px] leading-relaxed text-txt-dim">
          <b className="text-txt">EXIT VALUATION:</b> withdrawals value locked collateral at par,
          so an early exit does not absorb its share of pending in-the-money losses — those land on
          the writers who remain. Check the bucket&rsquo;s locked balance before depositing.
        </p>
        <p className="text-[10px] leading-relaxed text-txt-dim">
          CALL BUCKETS ESCROW {symbol} · PUT BUCKETS ESCROW USDG · WRITERS EARN 100% OF NET PREMIUMS
          ON THEIR BUCKET PRO-RATA · WITHDRAWALS DRAW FREE COLLATERAL ONLY · BUCKETS FREEZE 30 MIN
          BEFORE AN EXPIRY THEY HAVE OPEN INTEREST AT
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
