/* The Pit — live trade action. Contextual connect + a named transaction
   state machine (idle → simulate → approve → buy → confirmed), never one
   anonymous spinner. Every send is preceded by an eth_call simulation that
   decodes the pool's custom errors, receipts are checked for on-chain
   success, and writer-side depth gates the button — a buy that must revert
   is never sent. */
import { useCallback, useEffect, useRef, useState } from "react";
import { BaseError, ContractFunctionRevertedError, type Address } from "viem";
import { publicClient, TOKENS } from "../../lib/chain";
import {
  PIT,
  erc20WriteAbi,
  pitPoolAbi,
  PIT_MARKET_COUNT,
  quotePremiumOnChain,
  seriesDepth,
  type PitMarket,
  type SeriesDepth,
} from "../../lib/pit";
import { connectWallet, ensureChain, useWallet, walletClient } from "../../lib/wallet";
import { fmt } from "../../lib/format";
import type { PitSide } from "../../lib/pitPricer";

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

export function TradeAction({
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
      <div className="status-plate">
        <span className="px-label text-muted-dark">NO PIT MARKET FOR {symbol || "THIS ASSET"}</span>
        <span className="text-[12.5px] text-muted-dark">
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
      <button className="btn w-full py-3.5 text-[15px] !border-gold !text-gold" onClick={() => void ensureChain()}>
        SWITCH TO ROBINHOOD CHAIN
      </button>
    ) : w.status !== "connected" ? (
      <button className="btn btn-primary w-full py-3.5 text-[15px]" onClick={() => void connectWallet()}>
        {w.status === "connecting" ? "AWAITING WALLET…" : "CONNECT WALLET TO TRADE"}
      </button>
    ) : (
      <button
        className={`btn w-full py-3.5 text-[15px] ${side === "PUT" ? "btn-put" : "btn-primary"}`}
        disabled={!ready || !quote || busy || noDepth || inFreeze}
        onClick={() => void buy()}
      >
        {busy ? "WORKING…" : inFreeze ? "SERIES FROZEN — SETTLEMENT WINDOW" : `BUY ${symbol} ${side}${premUsd !== null ? ` — ${fmt.usd(premUsd)}` : ""}`}
      </button>
    );

  return (
    <div className="grid gap-2.5">
      <div className="flex items-baseline justify-between text-[13px] text-muted-dark">
        <span>On-chain quote (oracle TWAP)</span>
        <b className="num text-[15px] font-semibold text-paper">
          {premUsd !== null ? fmt.usd(premUsd) : quoteState === "err" ? "unavailable" : "…"}
        </b>
      </div>
      <div className="flex items-baseline justify-between text-[13px] text-muted-dark">
        <span>Writer depth at strike</span>
        <b className={`num text-[13px] ${noDepth ? "text-red" : "text-paper"}`}>
          {maxQtyFloat === null ? "…" : `${fmt.num(Math.floor(maxQtyFloat * 100) / 100)} contracts`}
        </b>
      </div>

      {inFreeze && (
        <div className="status-plate">
          <span className="px-label text-gold">SETTLEMENT FREEZE — FINAL HOUR BEFORE EXPIRY</span>
          <span className="text-[12.5px] text-muted-dark">
            New buys and writer withdrawals are locked during the last hour of a series while the
            settlement price forms. Pick a later expiry, or wait for settlement.
          </span>
        </div>
      )}
      {!inFreeze && freezeSoon && (
        <span className="text-[11.5px] text-gold">
          Series freezes in {Math.floor(freezeInS / 3600)}h {Math.floor((freezeInS % 3600) / 60)}m —
          buys and writer withdrawals lock 1h before expiry.
        </span>
      )}

      {noDepth && (
        <div className="status-plate">
          <span className="px-label text-gold">NO WRITER LIQUIDITY AT THIS STRIKE</span>
          <span className="text-[12.5px] text-muted-dark">
            {maxQtyFloat !== null && maxQtyFloat > 0
              ? `Only ${fmt.num(Math.floor(maxQtyFloat * 100) / 100)} contracts are collateralized right now — lower the quantity, or`
              : "Nobody has deposited writer collateral in this bucket yet —"}{" "}
            deposit in the WRITE panel to earn premiums, or pick another strike.
          </span>
        </div>
      )}

      {phase.k === "sig" && (
        <div className="status-plate">
          <span className="px-label text-gold">STEP {phase.n}/{phase.of} — {phase.step}</span>
          <span className="text-[12.5px] text-muted-dark">
            {phase.step.startsWith("CHECKING") ? "Simulating against the chain…" : "Confirm the signature in your wallet."}
          </span>
        </div>
      )}
      {phase.k === "pending" && (
        <div className="status-plate">
          <span className="px-label text-crt">STEP {phase.n}/{phase.of} — {phase.step} · PENDING</span>
          <a
            className="text-[12.5px] text-muted-dark underline decoration-dotted underline-offset-2"
            href={`https://robinhoodchain.blockscout.com/tx/${phase.hash}`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction on Blockscout
          </a>
        </div>
      )}
      {phase.k === "done" && (
        <div className="status-plate">
          <span className="px-label text-crt">FILLED — TICKET #{phase.ticketId!.toString()}</span>
          <span className="text-[12.5px] text-muted-dark">
            Premium paid {fmt.usd(Number(phase.premium) / 1e6)}. The ticket NFT is in your wallet — track it under YOUR TICKETS below.
          </span>
        </div>
      )}
      {phase.k === "error" && (
        <div className="status-plate">
          <span className="px-label text-red">ORDER REJECTED</span>
          <span className="text-[12.5px] text-muted-dark">{phase.msg}</span>
          {phase.hash && (
            <a
              className="text-[12.5px] text-muted-dark underline decoration-dotted underline-offset-2"
              href={`https://robinhoodchain.blockscout.com/tx/${phase.hash}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction on Blockscout
            </a>
          )}
        </div>
      )}

      {button}
      <span className="text-center text-[11.5px] text-muted-dark">
        Simulated before signing · max premium bound quote + 2% · your maximum loss is the premium.
      </span>
      <span className="text-center text-[11.5px] text-muted-dark">
        Min size 0.01 contracts · premium floor 0.50% of notional · weekend expiries price time value
        at 1.5× · quotes are firm only against current writer depth.
      </span>
    </div>
  );
}
