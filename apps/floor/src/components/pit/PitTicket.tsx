/* PIT — order ticket. Terminal port of site PositionBuilder.tsx +
   TradeAction.tsx with an asset picker over the 18 live PIT_MARKETS.
   The indicative breakdown mirrors the on-chain PitPricer; the live order
   path is a named transaction state machine (idle → simulate → approve →
   buy → confirmed), never one anonymous spinner. Every send is preceded by
   an eth_call simulation that decodes the pool's custom errors, receipts
   are checked for on-chain success, and writer-side depth gates the button
   — a buy that must revert is never sent. Logic verbatim from the site;
   only presentation changed. */
import { useCallback, useEffect, useRef, useState } from "react";
import { BaseError, ContractFunctionRevertedError, type Address } from "viem";
import { publicClient, TOKENS, EXPLORER } from "../../lib/nav/chain";
import {
  PIT,
  erc20WriteAbi,
  pitPoolAbi,
  PIT_MARKET_COUNT,
  quotePremiumOnChain,
  seriesDepth,
  type PitMarket,
  type SeriesDepth,
} from "../../lib/nav/pit";
import { ensureChain, useWallet, walletClient } from "../../lib/nav/wallet";
import { requestConnect } from "../../lib/wallet";
import type { StockToken } from "../../lib/nav/data";
import { getPriceEntry, usePriceFeed } from "../../lib/nav/live";
import {
  intrinsic,
  isWeekendUtc,
  PIT_FEE_BPS,
  PIT_MIN_PREMIUM_PCT,
  breakeven,
  PIT_SIGMA_DEFAULT,
  timeValue,
  yearsTo,
  type PitSide,
} from "../../lib/nav/pitPricer";
import { fmt } from "../../lib/format";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function expiryLabel(d: Date): string {
  const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return `${DAYS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} · 20:00 UTC`;
}

const USDG = TOKENS.USDG.address as Address;
/* keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

type Phase =
  | { k: "idle" }
  | { k: "sig"; step: string; n: number; of: number }
  | { k: "pending"; step: string; n: number; of: number; hash: string }
  | { k: "done"; ticketId: bigint | null; premium: bigint; hash: string }
  | { k: "error"; msg: string; hash?: string };

const ERR_COPY: Record<string, string> = {
  InsufficientLiquidity: "No free writer collateral at this strike. Pick another strike or deposit on the writer side.",
  SlippageExceeded: "Quote moved beyond the 2% bound. Re-quote and retry.",
  OiCapExceeded: "This series is at its open-interest cap.",
  FrozenWindow: "Too close to expiry — this series is in its settlement freeze.",
  MultiplierChanged: "Corporate action mid-series — this series is closed to new buys.",
  Paused: "The Pit is paused by the factory guardian.",
  BadQty: "Quantity below the pool minimum.",
  BadStrike: "Strike is off-grid for this pool.",
  BadExpiry: "Expiry is not a valid weekly series.",
  NonStandardToken: "Token transfer anomaly — buy aborted by the pool.",
};

function decodeErr(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      const name = r.data?.errorName ?? r.signature ?? "";
      if (name && ERR_COPY[name]) return ERR_COPY[name];
      if (name) return `Pool rejected the order: ${name}`;
    }
    if (/user rejected|denied/i.test(e.message)) return "Signature rejected in wallet.";
    if (/insufficient funds/i.test(e.message)) return "Not enough ETH for gas on Robinhood Chain.";
    const s = e.shortMessage || e.message;
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  }
  const s = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied/i.test(s)) return "Signature rejected in wallet.";
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/* ---------------------------------------------------------------- ticket */

export function PitTicket({
  tokens,
  token,
  onToken,
  symbol,
  side,
  onSide,
  strikes,
  strike,
  onStrike,
  expiries,
  expiryIdx,
  onExpiry,
  qty,
  onQty,
  livePrice,
  premiumPerUnit,
  sigma = PIT_SIGMA_DEFAULT,
  market,
  onFilled,
}: {
  /** the 18 live PIT_MARKETS underlyings (resolved StockTokens) */
  tokens: StockToken[];
  token: StockToken | null;
  onToken: (t: StockToken) => void;
  symbol: string;
  side: PitSide;
  onSide: (s: PitSide) => void;
  strikes: number[];
  strike: number | null;
  onStrike: (k: number) => void;
  expiries: Date[];
  expiryIdx: number;
  onExpiry: (i: number) => void;
  qty: string;
  onQty: (v: string) => void;
  livePrice: number | null;
  premiumPerUnit: number | null;
  /** annualized volatility used in the indicative breakdown (per-market when live) */
  sigma?: number;
  market: PitMarket | null;
  onFilled: () => void;
}) {
  /* live prices for the picker labels — same lazy Uniswap v3 reads as the site */
  usePriceFeed(tokens);

  const expiry = expiries[Math.min(expiryIdx, expiries.length - 1)];
  const weekend = isWeekendUtc();
  const T = expiry ? yearsTo(expiry) : 0;
  const intr = livePrice !== null && strike !== null ? intrinsic(side, livePrice, strike) : null;
  const tv = livePrice !== null ? timeValue(livePrice, T, sigma) : null;
  /* the 0.5%-of-P floor binds when it exceeds intrinsic + time value */
  const floored =
    livePrice !== null && intr !== null && tv !== null
      ? PIT_MIN_PREMIUM_PCT * livePrice > intr + tv
      : false;
  const qtyNum = Number.parseFloat(qty);

  return (
    <section className="panel flex flex-col" aria-label="pit order ticket">
      <div className="panel-title">
        <span>THE PIT · ORDER TICKET</span>
        <span className="text-txt-dim normal-case tracking-normal">EUROPEAN · WEEKLY · PREPAID</span>
      </div>
      <div className="p-2 flex flex-col gap-2">
        {/* side tabs */}
        <div className="grid grid-cols-2 gap-[2px]" role="radiogroup" aria-label="Option side">
          <button
            role="radio"
            aria-checked={side === "CALL"}
            className={`py-1.5 text-[12px] font-bold tracking-[0.18em] border ${side === "CALL" ? "bg-up/15 border-up text-up" : "border-rule-2 text-txt-dim hover:border-up/50"}`}
            onClick={() => onSide("CALL")}
          >
            CALL
          </button>
          <button
            role="radio"
            aria-checked={side === "PUT"}
            className={`py-1.5 text-[12px] font-bold tracking-[0.18em] border ${side === "PUT" ? "bg-dn/15 border-dn text-dn" : "border-rule-2 text-txt-dim hover:border-dn/50"}`}
            onClick={() => onSide("PUT")}
          >
            PUT
          </button>
        </div>

        {/* underlying — the 18 live pit markets */}
        <div>
          <label className="cell-label" htmlFor="pit-sym">Underlying · {PIT_MARKET_COUNT} live markets</label>
          <select
            id="pit-sym"
            className="term-input mt-0.5"
            value={token?.address ?? ""}
            onChange={(e) => {
              const t = tokens.find((x) => x.address === e.target.value);
              if (t) onToken(t);
            }}
          >
            {tokens.map((t) => {
              const p = getPriceEntry(t.address);
              return (
                <option key={t.address} value={t.address}>
                  {t.symbol}{p?.status === "ok" && p.price !== undefined ? ` — ${fmt.usd(p.price)}` : ""}
                </option>
              );
            })}
          </select>
        </div>

        {/* strike grid */}
        <div>
          <span className="cell-label">Strike — on-chain grid around live price</span>
          {strikes.length === 0 ? (
            <div className="border border-dashed border-rule-2 px-2 py-2 mt-0.5 text-[11px] text-txt-dim">
              AWAITING FIRST LIVE PRICE READ TO LOAD THE STRIKE GRID.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-[2px] mt-0.5" role="radiogroup" aria-label="Strike">
              {strikes.map((k) => (
                <button
                  key={k}
                  role="radio"
                  aria-checked={strike === k}
                  className={`py-1 text-[11px] font-bold tabular-nums border ${strike === k
                    ? side === "PUT" ? "border-dn text-dn bg-dn/10" : "border-up text-up bg-up/10"
                    : "border-rule-2 text-txt-dim hover:border-amber/60"}`}
                  onClick={() => onStrike(k)}
                >
                  {fmt.usd(k)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* expiry */}
        <div>
          <span className="cell-label">Expiry — weekly, Mondays 20:00 UTC</span>
          <div className="grid grid-cols-2 gap-[2px] mt-0.5" role="radiogroup" aria-label="Expiry">
            {expiries.map((d, i) => (
              <button
                key={d.getTime()}
                role="radio"
                aria-checked={expiryIdx === i}
                className={`py-1 px-0.5 text-[10px] font-bold tabular-nums border ${expiryIdx === i
                  ? side === "PUT" ? "border-dn text-dn bg-dn/10" : "border-up text-up bg-up/10"
                  : "border-rule-2 text-txt-dim hover:border-amber/60"}`}
                onClick={() => onExpiry(i)}
              >
                {expiryLabel(d)}
              </button>
            ))}
          </div>
        </div>

        {/* qty */}
        <div>
          <label className="cell-label" htmlFor="pit-qty">
            Quantity — contracts of 1 {symbol || "token"} each
          </label>
          <div className="flex gap-[2px] items-stretch mt-0.5">
            <input
              id="pit-qty"
              className="term-input flex-1"
              type="number"
              min="0"
              step="any"
              placeholder="1"
              inputMode="decimal"
              autoComplete="off"
              value={qty}
              onChange={(e) => onQty(e.target.value)}
            />
            <span className="cell-label border border-rule-2 px-2 flex items-center flex-none">× {symbol || "—"}</span>
          </div>
        </div>

        {/* quote total — the one number the buyer signs for */}
        <div className="border border-rule bg-panel-2 p-2 flex items-baseline justify-between gap-2">
          <span className="text-amber-2 text-[16px] font-bold tabular-nums">
            {premiumPerUnit !== null && Number.isFinite(qtyNum) && qtyNum > 0
              ? fmt.usd(premiumPerUnit * qtyNum)
              : "—"}
          </span>
          <span className="cell-label tabular-nums">
            {premiumPerUnit !== null && strike !== null
              ? `BREAKEVEN ${fmt.usd(breakeven(side, strike, premiumPerUnit))}`
              : "TOTAL PREMIUM"}
          </span>
        </div>

        {/* quote breakdown — every figure from live P + inputs */}
        <details className="border border-rule bg-panel-2 p-2 text-[11px]">
          <summary className="cell-label cursor-pointer select-none">DERIVATION +</summary>
          <div className="mt-1.5 flex flex-col gap-1 text-txt-dim">
            <div className="flex justify-between gap-2">
              <span>Intrinsic ({side === "CALL" ? "max(P−K,0)" : "max(K−P,0)"})</span>
              <b className="tabular-nums font-medium text-txt">{intr !== null ? fmt.usd(intr) : "—"}</b>
            </div>
            <div className="flex justify-between gap-2">
              <span>
                Time value (σ {Math.round(sigma * 100)}%{weekend ? " · weekend floor ×1.5" : ""})
              </span>
              <b className="tabular-nums font-medium text-txt">{tv !== null ? fmt.usd(tv) : "—"}</b>
            </div>
            {floored && (
              <div className="flex justify-between gap-2">
                <span>Minimum premium floor ({fmt.pct(PIT_MIN_PREMIUM_PCT, 1)} of P)</span>
                <b className="tabular-nums font-medium text-txt">applied</b>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <span>Premium / contract</span>
              <b className="tabular-nums font-medium text-txt">{premiumPerUnit !== null ? fmt.usd(premiumPerUnit) : "—"}</b>
            </div>
            <div className="flex justify-between gap-2">
              <span>Protocol fee (of premium, to FeeSplitter)</span>
              <b className="tabular-nums font-medium text-txt">{(PIT_FEE_BPS / 100).toFixed(0)}% · 80/15/5</b>
            </div>
          </div>
        </details>

        <TradeAction
          market={market}
          symbol={symbol}
          side={side}
          strike={strike}
          expiry={expiry}
          qty={qtyNum}
          onFilled={onFilled}
        />
      </div>
    </section>
  );
}

/* ---------------------------------------------------- live trade action */

function TradeAction({
  market,
  symbol,
  side,
  strike,
  expiry,
  qty,
  onFilled,
}: {
  market: PitMarket | null;
  symbol: string;
  side: PitSide;
  strike: number | null;
  expiry: Date | undefined;
  qty: number;
  onFilled: () => void;
}) {
  const w = useWallet();
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [quote, setQuote] = useState<{ premium: bigint; price: bigint } | null>(null);
  const [depth, setDepth] = useState<SeriesDepth | null>(null);
  const [quoteState, setQuoteState] = useState<"idle" | "loading" | "err">("idle");
  const seq = useRef(0);

  /* GUARD #14: PitPool.MIN_QTY = 0.01 contracts — validate client-side. */
  const qtyOk = Number.isFinite(qty) && qty >= 0.01;
  const ready = market !== null && strike !== null && expiry !== undefined && qtyOk;
  const strike1e18 = ready ? BigInt(Math.round(strike! * 1e6)) * 10n ** 12n : 0n;
  const qty1e18 = qtyOk ? BigInt(Math.round(qty * 1e6)) * 10n ** 12n : 0n;
  const expirySec = expiry ? Math.floor(expiry.getTime() / 1000) : 0;

  /* on-chain quote + writer depth — refresh on input change + every 12s */
  useEffect(() => {
    if (!ready) {
      setQuote(null);
      setDepth(null);
      setQuoteState("idle");
      return;
    }
    const my = ++seq.current;
    const pull = async () => {
      setQuoteState("loading");
      const [q, d] = await Promise.all([
        quotePremiumOnChain(market!.pitPool, side === "CALL", strike1e18, expirySec, qty1e18),
        seriesDepth(market!, side === "CALL", strike1e18),
      ]);
      if (seq.current !== my) return;
      setDepth(d);
      if (q) {
        setQuote(q);
        setQuoteState("idle");
      } else {
        setQuote(null);
        setQuoteState("err");
      }
    };
    void pull();
    const timer = setInterval(pull, 12_000);
    return () => clearInterval(timer);
  }, [ready, market, side, strike1e18, expirySec, qty1e18]);

  const noDepth = depth !== null && depth.maxQty1e18 < qty1e18;
  const maxQtyFloat = depth !== null ? Number(depth.maxQty1e18) / 1e18 : null;

  const buy = useCallback(async () => {
    if (!ready || !quote || !w.account) return;
    const wc = walletClient();
    if (!wc) return;
    if (w.status === "wrong-chain") {
      const ok = await ensureChain();
      if (!ok) return;
    }
    // 2% slippage buffer, rounded UP so a 1-wei premium still gets headroom (L-03)
    const maxPremium = (quote.premium * 102n + 99n) / 100n;
    try {
      // step 0 — USDG balance guard
      const bal = (await publicClient.readContract({
        address: USDG, abi: erc20WriteAbi, functionName: "balanceOf", args: [w.account],
      })) as bigint;
      if (bal < quote.premium) {
        setPhase({ k: "error", msg: `Insufficient USDG: balance ${fmt.usd(Number(bal) / 1e6)}, premium ${fmt.usd(Number(quote.premium) / 1e6)}.` });
        return;
      }

      // step 1 — allowance
      const allowance = (await publicClient.readContract({
        address: USDG, abi: erc20WriteAbi, functionName: "allowance", args: [w.account, market!.pitPool],
      })) as bigint;
      const needsApprove = allowance < maxPremium;
      const of = needsApprove ? 2 : 1;

      if (needsApprove) {
        setPhase({ k: "sig", step: "APPROVE USDG", n: 1, of });
        const h = await wc.writeContract({
          address: USDG, abi: erc20WriteAbi, functionName: "approve",
          args: [market!.pitPool, maxPremium], account: w.account, chain: wc.chain,
        });
        setPhase({ k: "pending", step: "APPROVE USDG", n: 1, of, hash: h });
        const r = await publicClient.waitForTransactionReceipt({ hash: h });
        if (r.status !== "success") {
          setPhase({ k: "error", msg: "USDG approval reverted on-chain.", hash: h });
          return;
        }
      }

      // step 2 — SIMULATE the exact buy before asking for a signature.
      setPhase({ k: "sig", step: `CHECKING BUY ${side}`, n: of, of });
      try {
        await publicClient.simulateContract({
          address: market!.pitPool, abi: pitPoolAbi, functionName: "buy",
          args: [side === "CALL", strike1e18, BigInt(expirySec), qty1e18, maxPremium],
          account: w.account,
        });
      } catch (simErr) {
        setPhase({ k: "error", msg: decodeErr(simErr) });
        return;
      }

      // step 3 — send for real
      setPhase({ k: "sig", step: `BUY ${side}`, n: of, of });
      const h2 = await wc.writeContract({
        address: market!.pitPool, abi: pitPoolAbi, functionName: "buy",
        args: [side === "CALL", strike1e18, BigInt(expirySec), qty1e18, maxPremium],
        account: w.account, chain: wc.chain,
      });
      setPhase({ k: "pending", step: `BUY ${side}`, n: of, of, hash: h2 });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash: h2 });

      // step 4 — honest receipt check. A reverted tx NEVER reports a fill.
      if (rcpt.status !== "success") {
        setPhase({ k: "error", msg: "Buy reverted on-chain. No premium was taken (only gas). Re-quote and retry.", hash: h2 });
        return;
      }

      // step 5 — ticket id strictly from the Pit Ticket NFT's mint log.
      let ticketId: bigint | null = null;
      for (const log of rcpt.logs) {
        if (
          log.address.toLowerCase() === PIT.ticket.toLowerCase() &&
          log.topics[0] === TRANSFER_TOPIC &&
          log.topics.length === 4 &&
          log.topics[1] === `0x${"0".repeat(64)}` &&
          // mint must be TO the buyer — ignore unrelated mints in the same tx (L-01)
          log.topics[2]?.toLowerCase() === `0x${w.account.slice(2).toLowerCase().padStart(64, "0")}`
        ) {
          ticketId = BigInt(log.topics[3]!);
          break;
        }
      }
      if (ticketId === null) {
        setPhase({ k: "error", msg: "Transaction succeeded but no ticket mint was found in the logs — check Blockscout.", hash: h2 });
        return;
      }
      setPhase({ k: "done", ticketId, premium: quote.premium, hash: h2 });
      onFilled();
    } catch (e) {
      setPhase({ k: "error", msg: decodeErr(e) });
    }
  }, [ready, quote, w.account, w.status, market, side, strike1e18, expirySec, qty1e18, onFilled]);

  /* ---- render states ---- */

  if (market === null) {
    return (
      <div className="border border-rule bg-panel-2 p-2 flex flex-col gap-1">
        <span className="cell-label">NO PIT MARKET FOR {symbol || "THIS ASSET"}</span>
        <span className="text-[10.5px] leading-relaxed text-txt-dim">
          {PIT_MARKET_COUNT} markets are live. New markets are added as their Uniswap v3 pools mature.
        </span>
      </div>
    );
  }

  const premUsd = quote ? Number(quote.premium) / 1e6 : null;
  const busy = phase.k === "sig" || phase.k === "pending";

  /* AUDIT v3 GUARD #9 — PitPool.FREEZE_WINDOW (1h): buys revert inside the final
     hour before expiry. Disable pre-emptively with a countdown instead of letting
     the tx revert with FrozenWindow. */
  const FREEZE_WINDOW_S = 3600;
  const nowS = Math.floor(Date.now() / 1000);
  const freezeInS = expirySec > 0 ? expirySec - FREEZE_WINDOW_S - nowS : Infinity;
  const inFreeze = expirySec > 0 && freezeInS <= 0 && nowS < expirySec;
  const freezeSoon = expirySec > 0 && freezeInS > 0 && freezeInS <= 6 * 3600;

  /* the action button adapts to wallet state — quote + depth stay visible */
  const button =
    w.status === "wrong-chain" ? (
      <button className="btn-exec !bg-transparent !border-amber !text-amber-2" onClick={() => void ensureChain()}>
        SWITCH TO ROBINHOOD CHAIN
      </button>
    ) : w.status !== "connected" ? (
      <button className="btn-exec" onClick={() => requestConnect()}>
        {w.status === "connecting" ? "AWAITING WALLET…" : "CONNECT WALLET TO TRADE"}
      </button>
    ) : (
      <button
        className="btn-exec"
        disabled={!ready || !quote || busy || noDepth || inFreeze}
        onClick={() => void buy()}
      >
        {busy ? "WORKING…" : inFreeze ? "SERIES FROZEN — SETTLEMENT WINDOW" : `BUY ${symbol} ${side}${premUsd !== null ? ` — ${fmt.usd(premUsd)}` : ""}`}
      </button>
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-[11px] text-txt-dim">
        <span className="cell-label">ON-CHAIN QUOTE (ORACLE TWAP)</span>
        <b className="tabular-nums text-[13px] font-semibold text-amber-2">
          {premUsd !== null ? fmt.usd(premUsd) : quoteState === "err" ? "unavailable" : "…"}
        </b>
      </div>
      <div className="flex items-baseline justify-between text-[11px] text-txt-dim">
        <span className="cell-label">WRITER DEPTH AT STRIKE</span>
        <b className={`tabular-nums text-[11.5px] ${noDepth ? "text-dn" : "text-txt"}`}>
          {maxQtyFloat === null ? "…" : `${fmt.num(Math.floor(maxQtyFloat * 100) / 100)} contracts`}
        </b>
      </div>

      {inFreeze && (
        <div className="border border-amber/60 bg-panel-2 p-2 flex flex-col gap-1">
          <span className="text-[11px] font-bold tracking-[0.12em] text-amber-2">SETTLEMENT FREEZE — FINAL HOUR BEFORE EXPIRY</span>
          <span className="text-[10.5px] leading-relaxed text-txt-dim">
            New buys and writer withdrawals are locked during the last hour of a series while the
            settlement price forms. Pick a later expiry, or wait for settlement.
          </span>
        </div>
      )}
      {!inFreeze && freezeSoon && (
        <span className="text-[10px] text-amber-2">
          Series freezes in {Math.floor(freezeInS / 3600)}h {Math.floor((freezeInS % 3600) / 60)}m —
          buys and writer withdrawals lock 1h before expiry.
        </span>
      )}

      {noDepth && (
        <div className="border border-amber/60 bg-panel-2 p-2 flex flex-col gap-1">
          <span className="text-[11px] font-bold tracking-[0.12em] text-amber-2">NO WRITER LIQUIDITY AT THIS STRIKE</span>
          <span className="text-[10.5px] leading-relaxed text-txt-dim">
            {maxQtyFloat !== null && maxQtyFloat > 0
              ? `Only ${fmt.num(Math.floor(maxQtyFloat * 100) / 100)} contracts are collateralized right now — lower the quantity, or`
              : "Nobody has deposited writer collateral in this bucket yet —"}{" "}
            deposit in the WRITE panel to earn premiums, or pick another strike.
          </span>
        </div>
      )}

      {phase.k === "sig" && (
        <div className="border border-amber/60 bg-panel-2 p-2 flex flex-col gap-1">
          <span className="text-[11px] font-bold tracking-[0.12em] text-amber-2">STEP {phase.n}/{phase.of} — {phase.step}</span>
          <span className="text-[10.5px] text-txt-dim">
            {phase.step.startsWith("CHECKING") ? "Simulating against the chain…" : "Confirm the signature in your wallet."}
          </span>
        </div>
      )}
      {phase.k === "pending" && (
        <div className="border border-up/60 bg-panel-2 p-2 flex flex-col gap-1">
          <span className="text-[11px] font-bold tracking-[0.12em] text-up">STEP {phase.n}/{phase.of} — {phase.step} · PENDING</span>
          <a
            className="text-[10.5px] text-cyan hover:underline"
            href={`${EXPLORER}/tx/${phase.hash}`}
            target="_blank"
            rel="noreferrer"
          >
            VIEW TRANSACTION ON BLOCKSCOUT
          </a>
        </div>
      )}
      {phase.k === "done" && (
        <div className="border border-up/60 bg-panel-2 p-2 flex flex-col gap-1" role="status">
          <span className="text-[11px] font-bold tracking-[0.12em] text-up">✓ FILLED — TICKET #{phase.ticketId!.toString()}</span>
          <span className="text-[10.5px] leading-relaxed text-txt-dim">
            Premium paid {fmt.usd(Number(phase.premium) / 1e6)}. The ticket NFT is in your wallet — track it under MY TICKETS.
          </span>
        </div>
      )}
      {phase.k === "error" && (
        <div className="border border-dn/60 bg-panel-2 p-2 flex flex-col gap-1" role="alert">
          <span className="text-[11px] font-bold tracking-[0.12em] text-dn">✕ ORDER REJECTED</span>
          <span className="text-[10.5px] leading-relaxed text-txt-dim">{phase.msg}</span>
          {phase.hash && (
            <a
              className="text-[10.5px] text-cyan hover:underline"
              href={`${EXPLORER}/tx/${phase.hash}`}
              target="_blank"
              rel="noreferrer"
            >
              VIEW TRANSACTION ON BLOCKSCOUT
            </a>
          )}
        </div>
      )}

      {button}
      <p className="text-[10px] leading-relaxed text-txt-dim text-center">
        SIMULATED BEFORE SIGNING · MAX PREMIUM BOUND QUOTE + 2% · YOUR MAXIMUM LOSS IS THE PREMIUM
      </p>
      <p className="text-[10px] leading-relaxed text-txt-dim text-center">
        MIN SIZE 0.01 CONTRACTS · PREMIUM FLOOR 0.50% OF NOTIONAL · WEEKEND EXPIRIES PRICE TIME VALUE
        AT 1.5× · QUOTES ARE FIRM ONLY AGAINST CURRENT WRITER DEPTH
      </p>
    </div>
  );
}
