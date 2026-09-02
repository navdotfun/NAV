/* CREDIT — action ticket. Supply / withdraw USDG, post / remove collateral,
   borrow / repay. Exact-amount approvals, simulate-before-send, every phase
   surfaced with the broadcast hash so a timeout is never a dead end. */
import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { EXPLORER } from "../../lib/chain";
import { useWallet, requestConnect } from "../../lib/wallet";
import { fmt } from "../../lib/format";
import {
  creditSupply, creditWithdraw, creditAddCollateral, creditRemoveCollateral,
  creditBorrow, creditRepay, maxBorrow, ORIGINATION_BPS, MIN_DEBT,
  type CreditAccount, type CreditExecPhase, type CreditMarket,
} from "../../lib/credit";

/* Truncating formatter (audit I-5): the MAX label must never display more
   than the true max — round-to-nearest could show a value that then trips
   the over-max guard when typed back in. */
function truncUnits(v: bigint, decimals: number, dp: number): string {
  const s = formatUnits(v, decimals);
  const i = s.indexOf(".");
  return i < 0 ? s : s.slice(0, i + dp + 1).replace(/\.$/, "");
}

const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;

type Mode = "SUPPLY" | "WITHDRAW" | "ADD COLLAT" | "REMOVE COLLAT" | "BORROW" | "REPAY";
const MODES: Mode[] = ["SUPPLY", "WITHDRAW", "ADD COLLAT", "REMOVE COLLAT", "BORROW", "REPAY"];

const MODE_HELP: Record<Mode, string> = {
  "SUPPLY": "lend USDG to this market — earns the supply APR, withdrawable while un-lent liquidity remains",
  "WITHDRAW": "redeem supplied USDG plus accrued interest",
  "ADD COLLAT": "post stock as collateral — enables borrowing against it",
  "REMOVE COLLAT": "reclaim collateral not securing debt (needs a fresh oracle price)",
  "BORROW": "draw USDG against your collateral · 30 bps origination fee funds the NAV vault",
  "REPAY": "pay down USDG debt — MAX closes the position in full",
};

export function CreditTicket({ mkt, account, onDone }: {
  mkt: CreditMarket | null;
  account: CreditAccount | null;
  onDone: () => void;
}) {
  const wallet = useWallet();
  const [mode, setMode] = useState<Mode>("SUPPLY");
  const [amount, setAmount] = useState("");
  const [isMax, setIsMax] = useState(false);
  const [phase, setPhase] = useState<CreditExecPhase>({ k: "idle" });

  /* switching market, mode or WALLET ACCOUNT resets the input and any stale
     phase — a surviving isMax after an account switch would execute a
     full-position action the display never described (audit M-4) */
  useEffect(() => { setAmount(""); setIsMax(false); setPhase({ k: "idle" }); }, [mode, mkt?.pair, wallet.account]);

  const busy = phase.k === "approving" || phase.k === "sending";
  const isUsdg = mode !== "ADD COLLAT" && mode !== "REMOVE COLLAT";
  const decimals = isUsdg ? 6 : 18;
  const unit = isUsdg ? "USDG" : (mkt?.symbol ?? "");

  /* the MAX the input can take for the current mode (null = unknown) */
  const maxAvail: bigint | null = useMemo(() => {
    if (!mkt || !account) return null;
    switch (mode) {
      case "SUPPLY": {
        /* cap headroom unknown ⇒ max unknown — never fall back to the raw
           balance (audit L-2); haircut the cap leg so accrual between quote
           and inclusion cannot tip a cap-bound deposit over the cap */
        if (account.usdgBalance === null || mkt.supplyAssets === null) return null;
        let room = mkt.supplyCap > mkt.supplyAssets ? mkt.supplyCap - mkt.supplyAssets : 0n;
        const margin = mkt.supplyAssets / 1_000_000n + 1n;
        room = room > margin ? room - margin : 0n;
        return account.usdgBalance < room ? account.usdgBalance : room;
      }
      case "WITHDRAW": {
        if (account.supplyBalance === null || mkt.cash === null) return null;
        return account.supplyBalance < mkt.cash ? account.supplyBalance : mkt.cash;
      }
      case "ADD COLLAT": return account.stockBalance;
      case "REMOVE COLLAT": {
        /* conservative UI clamp — the contract enforces the exact LTV check.
           Guard order matters: a FAILED debt read must yield unknown, never
           "no debt" (audit M-2); only a true zero unlocks full collateral. */
        if (account.collateral === null || account.debt === null) return null;
        if (account.debt === 0n) return account.collateral;
        /* debt outstanding + stale anchor ⇒ removal is knowably dead (audit L-3) */
        if (mkt.priceFresh !== true) return 0n;
        if (mkt.price === null) return null;
        /* floor the price and round the required collateral UP, with a small
           debt buffer for accrual — the clamp must be conservative (audit M-3) */
        const priceE6 = BigInt(Math.floor(mkt.price * 1e6));
        if (priceE6 === 0n) return 0n;
        const debtBuf = account.debt + account.debt / 2_000n + 1n;
        const needed = ceilDiv(debtBuf * 10n ** 18n * 10_000n, priceE6 * BigInt(mkt.ltvBps));
        return account.collateral > needed ? account.collateral - needed : 0n;
      }
      case "BORROW": {
        /* maxBorrow clamps every contract constraint: LTV (floored price +
           margin), fee-adjusted cash, borrow-cap headroom, MIN_DEBT (audit M-1/L-4) */
        if (account.collateral === null || account.debt === null) return null;
        return maxBorrow(mkt, account.collateral, account.debt);
      }
      case "REPAY": {
        if (account.debt === null || account.usdgBalance === null) return null;
        if (account.debt === 0n) return 0n;
        /* full close needs debt + 0.5% accrual headroom in the wallet; when it
           can't cover that, the best partial must leave ≥ MIN_DEBT behind
           (audit H-2 / L-4) */
        const headroom = account.debt + account.debt / 200n + 1n;
        if (account.usdgBalance >= headroom) return account.debt;
        const partialCeiling = account.debt > MIN_DEBT ? account.debt - MIN_DEBT : 0n;
        return account.usdgBalance < partialCeiling ? account.usdgBalance : partialCeiling;
      }
    }
  }, [mode, mkt, account]);

  const parsed: bigint | null = useMemo(() => {
    if (!amount) return null;
    try {
      const v = parseUnits(amount, decimals);
      return v > 0n ? v : null;
    } catch { return null; }
  }, [amount, decimals]);

  const overMax = parsed !== null && maxAvail !== null && parsed > maxAvail;

  /* partial repay may not leave a remainder below the contract's 10 USDG
     dust floor (audit L-4) — block with copy instead of a guaranteed revert */
  const repayGap = mode === "REPAY" && parsed !== null && account?.debt != null && account.debt > 0n
    && parsed < account.debt && account.debt - parsed < MIN_DEBT
    && !(account.usdgBalance !== null && account.usdgBalance >= account.debt + account.debt / 200n + 1n && (isMax || parsed >= account.debt));

  const originationNote = mode === "BORROW" && parsed !== null
    ? `fee ${fmt.usd(Number(formatUnits((parsed * ORIGINATION_BPS) / 10_000n, 6)))} → NAV accumulator`
    : null;

  const setMax = () => {
    if (maxAvail === null) return;
    setAmount(formatUnits(maxAvail, decimals));
    setIsMax(true);
  };

  const exec = async () => {
    if (!mkt || !wallet.account || parsed === null || busy) return;
    const acct = wallet.account;
    setPhase({ k: "idle" });
    let ok = false;
    switch (mode) {
      case "SUPPLY":
        ok = await creditSupply({ mkt, amount: parsed, account: acct, onPhase: setPhase });
        break;
      case "WITHDRAW": {
        /* convert asset amount → shares. The uint256.max sentinel (full share
           balance) is sent ONLY when the full balance is genuinely withdrawable
           — i.e. it fits in pool cash with an accrual margin. When the display
           was liquidity-clamped, transact exactly the displayed amount via the
           partial path: calldata must never diverge from the display (audit H-1/M-4). */
        if (!account || account.supplyShares === null || account.supplyBalance === null || account.supplyBalance === 0n) return;
        const wMargin = account.supplyBalance / 1_000_000n + 1n;
        const fullFits = mkt.cash !== null && account.supplyBalance + wMargin <= mkt.cash;
        if (isMax && fullFits) {
          ok = await creditWithdraw({ mkt, shares: 2n ** 256n - 1n, account: acct, onPhase: setPhase });
        } else {
          let shares = (parsed * account.supplyShares) / account.supplyBalance;
          if (shares > account.supplyShares) shares = account.supplyShares;
          if (shares === 0n) return;
          ok = await creditWithdraw({ mkt, shares, account: acct, onPhase: setPhase });
        }
        break;
      }
      case "ADD COLLAT":
        ok = await creditAddCollateral({ mkt, amount: parsed, account: acct, onPhase: setPhase });
        break;
      case "REMOVE COLLAT":
        ok = await creditRemoveCollateral({ mkt, amount: parsed, account: acct, onPhase: setPhase });
        break;
      case "BORROW":
        ok = await creditBorrow({ mkt, amount: parsed, account: acct, onPhase: setPhase });
        break;
      case "REPAY": {
        /* the full-close path (uint256.max + headroom approval) is taken only
           when the wallet can actually cover debt + accrual headroom — never
           on intent alone (audit H-2) */
        if (!account || account.debt === null || account.usdgBalance === null) return;
        const debt = account.debt;
        const headroom = debt + debt / 200n + 1n;
        const canFull = account.usdgBalance >= headroom;
        const full = (isMax || parsed >= debt) && canFull;
        if (!full && parsed < debt && debt - parsed < MIN_DEBT) return; // dead zone, also blocked in UI
        ok = await creditRepay({ mkt, amount: full ? parsed : (parsed > debt ? debt : parsed), full, debt, account: acct, onPhase: setPhase });
        break;
      }
    }
    if (ok) { setAmount(""); setIsMax(false); onDone(); }
  };

  const disabled = !mkt || wallet.status !== "connected" || parsed === null || overMax || repayGap || busy;

  return (
    <section className="panel flex flex-col">
      <div className="panel-title">
        <span>CREDIT TICKET{mkt ? ` · ${mkt.symbol}/USDG` : ""}</span>
      </div>

      {/* mode grid */}
      <div className="grid grid-cols-3 gap-[2px] p-[2px]">
        {MODES.map((m) => (
          <button key={m} type="button"
            className={`fkey !px-1 text-center ${mode === m ? "!border-amber !text-amber-2" : ""}`}
            aria-pressed={mode === m} disabled={busy}
            onClick={() => setMode(m)}>
            {m}
          </button>
        ))}
      </div>
      <p className="px-3 py-1.5 text-[10.5px] text-txt-dim leading-snug">{MODE_HELP[mode]}</p>

      {/* amount */}
      <div className="px-3 pb-2">
        <div className="cell-label flex justify-between mb-1">
          <span>AMOUNT · {unit}</span>
          <button type="button" className="text-cyan cursor-pointer disabled:text-txt-dim"
            onClick={setMax} disabled={maxAvail === null || busy}>
            MAX {maxAvail !== null ? truncUnits(maxAvail, decimals, isUsdg ? 2 : 4) : "—"}
          </button>
        </div>
        <input
          className="term-input" inputMode="decimal" placeholder="0.00"
          value={amount} disabled={busy}
          onChange={(e) => {
            const v = e.target.value;
            if (/^\d*\.?\d*$/.test(v)) { setAmount(v); setIsMax(false); }
          }}
        />
        {overMax && <p className="text-dn text-[10.5px] mt-1">exceeds available — MAX is {truncUnits(maxAvail!, decimals, isUsdg ? 2 : 4)}</p>}
        {repayGap && <p className="text-dn text-[10.5px] mt-1">remainder would fall below the 10 USDG minimum debt — repay in full or leave ≥ 10 USDG</p>}
        {originationNote && <p className="text-txt-dim text-[10.5px] mt-1">{originationNote}</p>}
      </div>

      {/* exec */}
      <div className="px-3 pb-3">
        {wallet.status !== "connected" ? (
          <button type="button" className="btn-exec" onClick={() => requestConnect()}>
            CONNECT WALLET
          </button>
        ) : (
          <button type="button" className="btn-exec" disabled={disabled} onClick={() => void exec()}>
            {busy ? (phase.k === "approving" ? "APPROVING…" : "SENDING…") : mode}
          </button>
        )}
      </div>

      {/* phase */}
      {phase.k !== "idle" && (
        <div className="mx-3 mb-3 border border-rule px-2 py-1.5 text-[11px] leading-relaxed">
          {phase.k === "approving" && <span className="text-amber-2">approving token…</span>}
          {phase.k === "sending" && <span className="text-amber-2">awaiting confirmation…</span>}
          {phase.k === "done" && <span className="text-up">confirmed ✓</span>}
          {phase.k === "error" && <span className="text-dn">{phase.message}</span>}
          {"hash" in phase && phase.hash && (
            <>
              {" · "}
              <a className="text-cyan underline" href={`${EXPLORER}/tx/${phase.hash}`}
                target="_blank" rel="noopener noreferrer">tx ↗</a>
            </>
          )}
        </div>
      )}

      {/* market vitals */}
      {mkt && (
        <div className="border-t border-rule px-3 py-2 text-[10.5px] text-txt-dim space-y-0.5">
          <div className="flex justify-between"><span>max LTV / liq threshold</span><span className="text-txt">{(mkt.ltvBps / 100).toFixed(0)}% / {(mkt.liqThresholdBps / 100).toFixed(0)}%</span></div>
          <div className="flex justify-between"><span>liquidation bonus</span><span className="text-txt">{(mkt.liqBonusBps / 100).toFixed(0)}%</span></div>
          <div className="flex justify-between"><span>supply cap / borrow cap</span><span className="text-txt">{fmt.usdCompact(Number(formatUnits(mkt.supplyCap, 6)))} / {fmt.usdCompact(Number(formatUnits(mkt.borrowCap, 6)))}</span></div>
          <div className="flex justify-between"><span>min debt</span><span className="text-txt">$10 USDG</span></div>
          <div className="flex justify-between"><span>oracle</span><span className="text-txt">PitOracleV2 · Chainlink anchor{mkt.priceFresh === false ? " · STALE" : ""}</span></div>
        </div>
      )}
    </section>
  );
}
