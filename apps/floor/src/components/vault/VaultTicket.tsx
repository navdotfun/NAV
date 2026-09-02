/* VAULT — buy / redeem ticket. Logic 1:1 with the audited site Dashboard:
   quoteBuyEth / quoteBuyUsdg (min-out enforced on-chain), redeemInKind
   preview mirroring the verified contract math, and the P3-05 hard block
   whenever any registry asset is inactive. */
import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { STOCK_TOKENS, type StockToken } from "../../lib/nav/data";
import { PROTOCOL, type VaultState, type NavMarket } from "../../lib/nav/protocol";
import { getPriceEntry, usePriceFeed, useBlockNumber } from "../../lib/nav/live";
import {
  quoteBuyEth, quoteBuyUsdg, sendBuy, sendRedeem, SLIPPAGE_BPS,
  type PayAsset, type TxPhase,
} from "../../lib/nav/tx";
import { erc20Abi, publicClient, EXPLORER } from "../../lib/chain";
import { useWallet, requestConnect, ensureChain } from "../../lib/wallet";
import { fmt } from "../../lib/format";

function parseNav(s: string): bigint | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^\d*\.?\d*$/.test(t) || t === ".") return null;
  try {
    const v = parseUnits(t, 18);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

function fmtQty(amount: bigint, decimals: number): string {
  const n = Number(formatUnits(amount, decimals));
  if (n === 0) return "0";
  if (n < 0.000001) return "< 0.000001";
  if (n < 1) return n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Live $NAV balance of the connected wallet (refreshes with each block). */
function useNavBalance(account: Address | null): bigint | null {
  const [bal, setBal] = useState<bigint | null>(null);
  const block = useBlockNumber();
  const lastAcct = useRef<Address | null>(null);
  useEffect(() => {
    let stop = false;
    /* account switch — the previous wallet's balance must never leak through */
    if (account !== lastAcct.current) { lastAcct.current = account; setBal(null); }
    if (!account || !PROTOCOL.tokenAddress) { setBal(null); return; }
    publicClient
      .readContract({ address: PROTOCOL.tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [account] })
      .then((b) => { if (!stop) setBal(b as bigint); })
      .catch(() => { /* keep last-good balance — next block re-reads */ });
    return () => { stop = true; };
  }, [account, block]);
  return bal;
}

function PhaseLine({ phase }: { phase: TxPhase }) {
  if (phase.step === "idle") return null;
  if (phase.step === "error") return <div className="px-2.5 pb-2 text-[11px] text-dn">{phase.message}</div>;
  if (phase.step === "done") {
    return (
      <div className="px-2.5 pb-2 text-[11px] text-up">
        EXECUTED · <a className="text-cyan hover:underline" href={`${EXPLORER}/tx/${phase.hash}`} target="_blank" rel="noopener noreferrer">VIEW TX ↗</a>
      </div>
    );
  }
  return (
    <div className="px-2.5 pb-2 text-[11px] text-amber-2">
      {phase.step === "approving"
        ? phase.hash ? "APPROVAL CONFIRMING…" : "APPROVE IN WALLET…"
        : phase.hash ? "CONFIRMING ON-CHAIN…" : "CONFIRM IN WALLET…"}<span className="blink">▮</span>
    </div>
  );
}

interface Row { token: StockToken; amount: bigint; usd: number | null }

export function VaultTicket({ vault, navMkt, ethUsd }: {
  vault: VaultState;
  navMkt: NavMarket;
  ethUsd: number | null;
}) {
  const wallet = useWallet();
  const connected = wallet.status === "connected";
  const wrongChain = wallet.status === "wrong-chain";
  const [tab, setTab] = useState<"buy" | "redeem">("buy");
  const [payAsset, setPayAsset] = useState<PayAsset>("USDG");
  const [buyAmt, setBuyAmt] = useState("");
  const [rdAmt, setRdAmt] = useState("");
  const [buyPhase, setBuyPhase] = useState<TxPhase>({ step: "idle" });
  const [rdPhase, setRdPhase] = useState<TxPhase>({ step: "idle" });

  const quote = useMemo(
    () => (payAsset === "ETH" ? quoteBuyEth(buyAmt, navMkt.priceEth) : quoteBuyUsdg(buyAmt, navMkt.priceEth, ethUsd)),
    [payAsset, buyAmt, navMkt.priceEth, ethUsd],
  );
  const buyBusy = buyPhase.step === "approving" || buyPhase.step === "pending";
  const rdBusy = rdPhase.step === "approving" || rdPhase.step === "pending";
  /* B-04: synchronous in-flight latches — React state updates are async, so a
     fast double-click could dispatch two wallet flows before `buyBusy` flips. */
  const buyingRef = useRef(false);
  const redeemingRef = useRef(false);

  /* ------------------------- redeem preview (contract math, verbatim) */
  const navBal = useNavBalance(connected ? wallet.account : null);
  const block = useBlockNumber();
  const rdShares = parseNav(rdAmt);

  const byAddr = useMemo(() => {
    const m = new Map<string, StockToken>();
    STOCK_TOKENS.forEach((t) => m.set(t.address.toLowerCase(), t));
    return m;
  }, []);
  const inactiveSet = useMemo(
    () => new Set((vault.inactiveAssets ?? []).map((a) => a.toLowerCase())),
    [vault.inactiveAssets],
  );
  const heldTokens = useMemo(
    () =>
      (vault.holdings ?? [])
        .filter((h) => h.balance !== null && h.balance > 0n)
        .map((h) => byAddr.get(h.address.toLowerCase()))
        .filter((t): t is StockToken => !!t),
    [vault.holdings, byAddr],
  );
  /* A-04 ripple: any unknown balance makes the redeem preview unprovable —
     fail closed (no preview, no redeem) until every balanceOf read lands. */
  const balancesUnknown = (vault.holdings ?? []).some((h) => h.balance === null);
  const priceTick = usePriceFeed(heldTokens);

  const live = vault.status === "live" && vault.totalSupply !== null && vault.redeemFeeBps !== null && vault.holdings !== null;
  const supply = vault.totalSupply ?? 0n;

  const { rows, forfeited, totalUsd, pricedCount } = useMemo(() => {
    const rows: Row[] = [];
    const forfeited: Row[] = [];
    let totalUsd = 0;
    let pricedCount = 0;
    if (!live || !rdShares || supply === 0n) return { rows, forfeited, totalUsd, pricedCount };
    const effective = rdShares - (rdShares * BigInt(vault.redeemFeeBps!)) / 10_000n;
    for (const h of vault.holdings!) {
      if (h.balance === null || h.balance === 0n) continue; // null unreachable (balancesUnknown blocks preview) — type-safe belt
      const token = byAddr.get(h.address.toLowerCase());
      if (!token) continue;
      const amount = (h.balance * effective) / supply;
      const p = getPriceEntry(token.address);
      const usd = p?.status === "ok" && p.price !== undefined
        ? Number(formatUnits(amount, token.decimals)) * p.price
        : null;
      const row: Row = { token, amount, usd };
      if (inactiveSet.has(h.address.toLowerCase())) {
        forfeited.push(row);
      } else if (amount > 0n) {
        rows.push(row);
        if (usd !== null) { totalUsd += usd; pricedCount++; }
      }
    }
    rows.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
    return { rows, forfeited, totalUsd, pricedCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, rdShares, supply, vault.holdings, vault.redeemFeeBps, byAddr, inactiveSet, priceTick]);

  const exceedsBal = navBal !== null && rdShares !== null && rdShares > navBal;
  const exceedsSupply = live && rdShares !== null && rdShares > supply;
  const vaultUnseeded = live && !balancesUnknown && heldTokens.length === 0;
  /* A-11: the buy quote is anchored to the pool price — refuse to dispatch a
     swap against a price older than 60s (5 missed 12s polls). `block` ticking
     below keeps this re-evaluated without a dedicated timer. */
  const priceStale = navMkt.updatedAt === null || Date.now() - navMkt.updatedAt > 60_000;
  /* AUDIT v3 GUARD #2 (P3-05) — hard-block, never warn. */
  const redeemBlocked = vault.inactiveAssets !== null && vault.inactiveAssets.length > 0;

  return (
    <section className="panel" aria-label="buy or redeem nav">
      <div className="panel-title">
        <span>$NAV · TICKET</span>
        <span className="text-txt-dim normal-case tracking-normal">SIMULATED BEFORE SIGNING</span>
      </div>

      {/* tabs */}
      <div className="grid grid-cols-2 gap-px bg-rule border-b border-rule">
        {(["buy", "redeem"] as const).map((t) => (
          <button key={t} type="button"
            className={`px-2 py-1.5 text-[11px] font-semibold tracking-wider ${tab === t ? "bg-panel-2 text-amber-2" : "bg-panel text-txt-dim hover:text-txt"}`}
            onClick={() => setTab(t)}>
            {t === "buy" ? "BUY $NAV" : "REDEEM IN-KIND"}
          </button>
        ))}
      </div>

      {tab === "buy" ? (
        <div className="px-2.5 py-2">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="cell-label">PAY WITH</span>
            <div className="flex gap-1">
              {(["USDG", "ETH"] as const).map((a) => (
                <button key={a} type="button"
                  className={`px-2 py-0.5 text-[10.5px] border ${payAsset === a ? "border-amber text-amber-2" : "border-rule text-txt-dim hover:text-txt"}`}
                  onClick={() => { setPayAsset(a); setBuyPhase({ step: "idle" }); }}>
                  {a}
                </button>
              ))}
            </div>
          </div>
          <input type="text" inputMode="decimal" placeholder="0.00" aria-label="Amount you pay"
            className="term-input w-full mb-1.5" value={buyAmt}
            onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setBuyAmt(e.target.value); }} />
          <div className="grid gap-0.5 text-[11px] mb-2">
            <div className="flex justify-between gap-2"><span className="text-txt-dim">RECEIVE (EST)</span><span className="text-amber-2 tabular-nums">{quote ? `${fmt.num(quote.navOut, 2)} $NAV` : "—"}</span></div>
            <div className="flex justify-between gap-2"><span className="text-txt-dim">ROUTE</span><span className="text-txt tabular-nums">{payAsset === "ETH" ? "ETH → $NAV" : "USDG → WETH → $NAV"} · UNI V3</span></div>
            <div className="flex justify-between gap-2"><span className="text-txt-dim">POOL FEE</span><span className="text-txt tabular-nums">{payAsset === "ETH" ? "1%" : "1% + 0.05%"} → LOCKED LP</span></div>
            <div className="flex justify-between gap-2"><span className="text-txt-dim">MIN OUT ({(Number(SLIPPAGE_BPS) / 100).toFixed(1)}%)</span><span className="text-txt tabular-nums">{quote ? `${fmt.num(Number(quote.minOut) / 1e18, 2)} $NAV` : "—"}</span></div>
          </div>
          {connected && !wrongChain && priceStale && buyAmt !== "" && (
            <div className="mb-1.5 text-[11px] text-dn">PRICE STALE (&gt;60S) — REFRESHING BEFORE ORDERS DISPATCH</div>
          )}
          <button type="button" className="btn-exec w-full"
            disabled={buyBusy || (connected && !wrongChain && (!quote || navMkt.status !== "ok" || priceStale))}
            title={wrongChain ? "Switch to Robinhood Chain (4663)" : !connected ? "Connect a wallet" : !quote ? "Enter an amount" : priceStale ? "Pool price stale — waiting for a fresh read" : "Min-out enforced on-chain"}
            onClick={() => {
              if (wrongChain) { void ensureChain(); return; }
              if (!connected) { requestConnect(); return; }
              if (!quote || priceStale || buyingRef.current) return;
              buyingRef.current = true;
              void Promise.resolve(sendBuy(payAsset, quote.amountIn, quote.minOut, setBuyPhase))
                .finally(() => { buyingRef.current = false; });
            }}>
            {wrongChain ? "SWITCH TO ROBINHOOD CHAIN" : !connected ? "CONNECT WALLET" : buyBusy ? "BUYING…" : "BUY $NAV"}
          </button>
          <div className="pt-1"><PhaseLine phase={buyPhase} /></div>
        </div>
      ) : (
        <div className="px-2.5 py-2">
          <div className="flex items-baseline justify-between gap-2 mb-1">
            <span className="cell-label">BURN $NAV</span>
            {connected && navBal !== null && (
              <button type="button" className="text-[10.5px] text-cyan hover:underline"
                onClick={() => setRdAmt(formatUnits(navBal, 18))} title="Use full balance">
                BAL {fmt.num(Number(formatUnits(navBal, 18)), 2)} · MAX
              </button>
            )}
          </div>
          <input type="text" inputMode="decimal" placeholder="0.00" aria-label="NAV amount to burn"
            className="term-input w-full mb-1.5" value={rdAmt}
            onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setRdAmt(e.target.value); }} />

          {/* preview — identical math to verified redeemInKind */}
          <div className="max-h-[180px] overflow-y-auto border border-rule px-2 py-1.5 mb-1.5">
            {!live ? (
              <div className="text-[11px] text-txt-dim">{vault.status === "loading" ? "READING CHAIN…" : "VAULT UNAVAILABLE"}</div>
            ) : balancesUnknown ? (
              <div className="text-[11px] text-txt-dim">SOME BALANCE READS FAILED — RETRYING. PREVIEW WITHHELD RATHER THAN SHOWN WRONG.</div>
            ) : !rdShares ? (
              <div className="text-[11px] text-txt-dim">
                <span className="text-amber-dim block pb-0.5">VAULT LIVE · {vault.holdings!.length} ASSETS REGISTERED{vaultUnseeded ? " · SEEDING FROM FEE FLOW" : ""}</span>
                ENTER $NAV TO PREVIEW THE EXACT PER-ASSET PAYOUT — CONTRACT MATH, LIVE BALANCES.
              </div>
            ) : exceedsSupply ? (
              <div className="text-[11px] text-dn">AMOUNT EXCEEDS TOTAL SUPPLY ({fmt.num(Number(formatUnits(supply, 18)), 2)} $NAV EXIST)</div>
            ) : vaultUnseeded ? (
              <div className="text-[11px] text-txt-dim">
                <span className="text-amber-dim block pb-0.5">PROVABLE PREVIEW — VAULT UNSEEDED</span>
                THE VAULT HOLDS 0 OF ALL {vault.holdings!.length} REGISTERED ASSETS — BURNING NOW RETURNS NOTHING. HOLDINGS ACCRUE EVERY EPOCH.
              </div>
            ) : (
              <>
                {rows.map((r) => (
                  <div key={r.token.address} className="flex items-center justify-between gap-2 border-b border-rule py-1 last:border-b-0">
                    <span className="text-[11px] text-txt">{r.token.symbol}</span>
                    <span className="text-[11px] text-txt tabular-nums">
                      {fmtQty(r.amount, r.token.decimals)}
                      <span className="text-txt-dim">{r.usd !== null ? ` · ≈${fmt.usd(r.usd)}` : ""}</span>
                    </span>
                  </div>
                ))}
                {forfeited.map((r) => (
                  <div key={r.token.address} className="flex items-center justify-between gap-2 border-b border-rule py-1 last:border-b-0">
                    <span className="text-[11px] text-dn">{r.token.symbol}</span>
                    <span className="text-[11px] text-dn tabular-nums" title="Asset inactive — the contract skips it WITHOUT credit">
                      {fmtQty(r.amount, r.token.decimals)} FORFEITED
                    </span>
                  </div>
                ))}
                <div className="flex justify-between gap-2 pt-1 text-[11px]">
                  <span className="text-txt-dim">TOTAL ({rows.length} ASSETS)</span>
                  <span className="text-amber-2 tabular-nums">
                    ≈ {fmt.usd(totalUsd)}{pricedCount < rows.length ? ` · ${pricedCount}/${rows.length} PRICED` : ""}
                  </span>
                </div>
              </>
            )}
          </div>

          {exceedsBal && rdShares !== null && !exceedsSupply && (
            <div className="mb-1.5 text-[11px] text-dn">EXCEEDS YOUR BALANCE OF {fmt.num(Number(formatUnits(navBal!, 18)), 4)} $NAV</div>
          )}

          <div className="grid gap-0.5 text-[11px] mb-2">
            <div className="flex justify-between gap-2"><span className="text-txt-dim">EXIT FEE</span><span className="text-txt tabular-nums">0.5% · PAID BACK INTO THE VAULT</span></div>
            <div className="flex justify-between gap-2">
              <span className="text-txt-dim">REGISTRY</span>
              <span className={redeemBlocked ? "text-dn" : "text-txt"}>
                {vault.inactiveAssets === null ? "CHECKING…" : redeemBlocked ? `${vault.inactiveAssets.length} ASSET${vault.inactiveAssets.length === 1 ? "" : "S"} INACTIVE` : "ALL ASSETS ACTIVE"}
              </span>
            </div>
          </div>

          {redeemBlocked && (
            <div className="border border-dn px-2 py-1.5 mb-2 text-[11px]">
              <span className="text-dn block font-semibold">REDEMPTION LOCKED — ASSET INACTIVE</span>
              <span className="text-txt-dim">
                REDEEMING NOW WOULD BURN YOUR $NAV AND PERMANENTLY FORFEIT THE INACTIVE SLICE WITH NO CREDIT.
                REOPENS AUTOMATICALLY WHEN ALL ASSETS ARE ACTIVE.
              </span>
            </div>
          )}

          <button type="button" className="btn-exec w-full"
            disabled={rdBusy || redeemBlocked || vault.inactiveAssets === null || balancesUnknown || (connected && !wrongChain && rdShares === null)}
            title={redeemBlocked ? "Redemption locked — a vault asset is inactive"
              : vault.inactiveAssets === null ? "Checking asset registry…"
              : balancesUnknown ? "Balance reads incomplete — retrying"
              : wrongChain ? "Switch to Robinhood Chain (4663)"
              : !connected ? "Connect a wallet"
              : rdShares === null ? "Enter a $NAV amount"
              : "redeemInKindGuarded · fee pinned at 0.5%"}
            onClick={() => {
              if (wrongChain) { void ensureChain(); return; }
              if (!connected) { requestConnect(); return; }
              if (rdShares === null || redeemBlocked || balancesUnknown || redeemingRef.current) return;
              redeemingRef.current = true;
              void Promise.resolve(sendRedeem(rdShares, setRdPhase))
                .finally(() => { redeemingRef.current = false; });
            }}>
            {wrongChain ? "SWITCH TO ROBINHOOD CHAIN" : !connected ? "CONNECT WALLET" : rdBusy ? "REDEEMING…" : "REDEEM IN-KIND"}
          </button>
          <div className="pt-1"><PhaseLine phase={rdPhase} /></div>
          {live && rdShares !== null && !exceedsSupply && (
            <div className="mt-1 text-[10px] leading-relaxed text-txt-dim">
              AMOUNTᵢ = ⌊BALᵢ × (SHARES − {(vault.redeemFeeBps! / 100).toFixed(2)}% FEE) ÷ SUPPLY⌋ ·
              BLOCK {block !== null ? block.toString() : "…"} ·{" "}
              <a className="text-cyan hover:underline" href={`${EXPLORER}/address/${PROTOCOL.vaultAddress}?tab=contract`} target="_blank" rel="noopener noreferrer">
                VERIFIED SOURCE ↗
              </a>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
