/* The Pit — writer (LP) panel. Deposits collateral into the selected
   (side, strike) bucket: CALL buckets escrow the underlying, PUT buckets
   escrow USDG. Live bucket state (free / locked / your shares) is read
   straight from the pool. Writers earn every premium paid on their bucket. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { publicClient, TOKENS } from "../../lib/chain";
import { erc20WriteAbi, pitPoolAbi, type PitMarket } from "../../lib/pit";
import { useWallet, walletClient, requestConnect, ensureChain } from "../../lib/wallet";
import { fmt } from "../../lib/format";
import type { PitSide } from "../../lib/pitPricer";
import { useHeartbeat, heartbeatAgeLabel, clampBandBps } from "../../lib/oracleHealth";

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

export function WriterPanel({
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
  const strike1e18 = useMemo(
    () => (strike !== null ? BigInt(Math.round(strike * 1e6)) * 10n ** 12n : null),
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
        publicClient.readContract({ address: market.pitPool, abi: pitPoolAbi, functionName: "buckets", args: [isCall, strike1e18] }),
      ];
      if (w.account) {
        calls.push(
          publicClient.readContract({ address: market.pitPool, abi: pitPoolAbi, functionName: "lps", args: [isCall, strike1e18, w.account] }),
          publicClient.readContract({ address: collateral!, abi: erc20WriteAbi, functionName: "balanceOf", args: [w.account] }),
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
    } catch {
      if (seq.current === my) setView(null);
    }
  }, [market, strike1e18, isCall, collateral, decimals, w.account]);

  useEffect(() => {
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
        const wei = BigInt(Math.round(amt * 1e6)) * 10n ** BigInt(decimals - 6);
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
    <section className="panel">
      <div className="panel-head flex-wrap">
        <span className="px-label">WRITE — EARN PREMIUMS</span>
        <span className="num text-[12.5px] text-muted-dark">
          {side} {strike !== null ? fmt.usd(strike) : "—"} bucket · collateral {isCall ? symbol : "USDG"}
        </span>
      </div>
      <div className="grid gap-3 p-4.5">
        <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-[13px] text-muted-dark md:grid-cols-4">
          <div>
            <span className="block">Free</span>
            <b className="num text-paper">{view ? view.free.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}</b>
          </div>
          <div>
            <span className="block">Locked</span>
            <b className="num text-paper">{view ? view.locked.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}</b>
          </div>
          <div>
            <span className="block">Your position</span>
            <b className="num text-paper">{view ? view.myAssets.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}</b>
          </div>
          <div>
            <span className="block">Wallet</span>
            <b className="num text-paper">{view ? view.walletBal.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}</b>
          </div>
        </div>

        {w.status !== "connected" ? (
          <button
            className="btn w-full py-3 text-[14px]"
            title={w.status === "wrong-chain" ? "Your wallet is on another network — switch to Robinhood Chain (4663)" : undefined}
            onClick={() => { if (w.status === "wrong-chain") { void ensureChain(); } else { void requestConnect(); } }}
          >
            {w.status === "wrong-chain" ? "SWITCH TO ROBINHOOD CHAIN" : "CONNECT WALLET TO WRITE"}
          </button>
        ) : (
          <>
            <div className="amt-row">
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="0.0"
                aria-label="Collateral amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <span className="asset">{isCall ? symbol : "USDG"}</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <button
                className="btn py-2.5 text-[13px]"
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
              <button className="btn py-2.5 text-[13px]" disabled={busy !== null || !view || view.myShares === 0n} onClick={() => void run("withdraw")}>
                {busy === "withdraw" ? "WORKING…" : "WITHDRAW ALL"}
              </button>
              <button className="btn py-2.5 text-[13px]" disabled={busy !== null || !view || view.myShares === 0n} onClick={() => void run("claim")}>
                {busy === "claim" ? "WORKING…" : "CLAIM PREMIUMS"}
              </button>
            </div>
          </>
        )}

        {note && (
          <span className={`text-[12.5px] ${note.tone === "ok" ? "text-crt" : "text-red"}`}>{note.msg}</span>
        )}

        {market && oracleCold && (
          <div className="status-plate">
            <span className="px-label text-red">MARKET NOT READY — ORACLE REFERENCE NOT INITIALISED</span>
            <span className="text-[12.5px] text-muted-dark">
              This market has never recorded a reference price, so the settlement-price clamp is
              inactive and a settlement could print far from fair value. Writing collateral here is
              blocked until the reference is live. Buying is unaffected — a buyer&rsquo;s risk is the
              premium. Withdrawals and premium claims stay open.
            </span>
          </div>
        )}

        {market && oracleStale && (
          <div className="status-plate">
            <span className="px-label text-gold">STALE REFERENCE — WIDENED SETTLEMENT BAND</span>
            <span className="text-[12.5px] text-muted-dark">
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
          <div className="status-plate">
            <span className="px-label text-gold">ORACLE STATUS UNAVAILABLE — DEPOSITS PAUSED</span>
            <span className="text-[12.5px] text-muted-dark">
              The oracle reference could not be read, so deposits are paused as a precaution. This
              usually clears within a minute; withdrawals and claims are unaffected.
            </span>
          </div>
        )}

        {market && hb.status === "armed" && (
          <span className="text-[11.5px] text-muted-dark">
            Oracle reference live · Chainlink/Pyth anchored · updated {heartbeatAgeLabel(hb.ageS)} · settlement clamped
            to ±{(clampBandBps(1500, hb.ageS) / 100).toFixed(0)}%.
          </span>
        )}

        <span className="text-[11.5px] text-muted-dark">
          <b className="text-paper">Exit valuation:</b> withdrawals value locked collateral at par,
          so an early exit does not absorb its share of pending in-the-money losses — those land on
          the writers who remain. Check the bucket&rsquo;s locked balance before depositing.
        </span>
        <span className="text-[11.5px] text-muted-dark">
          CALL buckets escrow {symbol}; PUT buckets escrow USDG. Writers earn 100% of net premiums on
          their bucket pro-rata. Withdrawals draw free collateral only; buckets freeze 30 minutes
          before an expiry they have open interest at.
        </span>
      </div>
    </section>
  );
}
