/* CREDIT — isolated USDG lending against tokenized stock collateral.
   The Aave-of-stocks desk: supply, borrow, manage collateral, repay.
   All reads live from chain, all writes simulated before signing.
   Accent flips to green (theme-credit on the app root). */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "../../lib/wallet";
import {
  loadCreditMarkets, fetchCreditAccount, CREDIT_FACTORY,
  type CreditMarket, type CreditAccount,
} from "../../lib/credit";
import { CreditMarketsBoard } from "./CreditMarketsBoard";
import { CreditPositionStrip } from "./CreditPositionStrip";
import { CreditTicket } from "./CreditTicket";

export function CreditView() {
  const wallet = useWallet();
  const [markets, setMarkets] = useState<CreditMarket[] | null>(null); // null = loading
  const [selected, setSelected] = useState<string | null>(null);       // pair address
  const [account, setAccount] = useState<CreditAccount | null>(null);

  const marketsRef = useRef<CreditMarket[] | null>(null);
  useEffect(() => { marketsRef.current = markets; }, [markets]);
  /* live refs so async completions can verify the world they were started in
     still exists before writing state (audit L-5 / I-6) */
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const walletRef = useRef<string | null>(null);
  useEffect(() => { walletRef.current = wallet.account; }, [wallet.account]);

  /* market sweep — 12s poll, transient failures keep last-good */
  const refresh = useCallback(async (force = false) => {
    try {
      const ms = await loadCreditMarkets(force);
      setMarkets(ms);
      setSelected((s) => s ?? ms[0]?.pair ?? null);
    } catch { /* keep last-good markets */ }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 12_000);
    return () => clearInterval(id);
  }, [refresh]);

  /* account snapshot for the selected market — 12s poll, cleared on switch */
  const mkt = markets?.find((m) => m.pair === selected) ?? null;
  useEffect(() => {
    setAccount(null);
    if (!mkt || !wallet.account) return;
    let dead = false;
    let seq = 0; // a slow older response must never overwrite a newer one (audit I-6)
    const tick = async () => {
      const mySeq = ++seq;
      try {
        const a = await fetchCreditAccount(mkt, wallet.account!);
        if (!dead && mySeq === seq) setAccount(a);
      } catch { /* transient — keep last-good, retry next tick */ }
    };
    void tick();
    const id = setInterval(tick, 12_000);
    return () => { dead = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mkt?.pair, wallet.account]);

  /* post-tx: force-refresh both the sweep and the account snapshot */
  const onTxDone = useCallback(async () => {
    const pair = selected;
    const acct = wallet.account;
    await refresh(true);
    const m = marketsRef.current?.find((x) => x.pair === pair) ?? null;
    if (m && acct) {
      try {
        const a = await fetchCreditAccount(m, acct);
        /* drop the write if the user switched market or wallet mid-flight —
           a stale snapshot must never land on the new selection (audit L-5) */
        if (selectedRef.current === pair && walletRef.current === acct) setAccount(a);
      } catch { /* next poll */ }
    }
  }, [refresh, selected, wallet.account]);

  if (!CREDIT_FACTORY) {
    return (
      <main className="flex-1 grid place-items-center p-[2px]">
        <div className="panel px-10 py-8 text-center">
          <div className="panel-title justify-center !border-b-0">CREDIT</div>
          <p className="text-txt-dim mt-2">markets not yet deployed — check back shortly</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-[2px] p-[2px] min-h-0 lg:overflow-hidden">
      <div className="lg:col-span-8 flex flex-col gap-[2px] min-h-0 lg:overflow-y-auto">
        <CreditMarketsBoard
          markets={markets}
          selected={selected}
          onSelect={setSelected}
        />
        <CreditPositionStrip mkt={mkt} account={account} connected={wallet.status === "connected"} />
        {/* L-02 / I-02 disclosure: socialized bad debt is a lender risk by design. */}
        <div className="panel px-3 py-2 text-[11px] leading-relaxed text-txt-dim">
          RISK · isolated markets, immutable parameters, no admin. if a borrower’s collateral
          crashes past the liquidation bonus — including across a weekend price gap while the
          stock feed is frozen — the uncovered remainder is socialized pro-rata across lenders
          in that market (aave/morpho bad-debt regime). oracle-gated actions pause when the
          anchor is older than 26h; deposits, repays and withdrawals never pause. lenders who
          remain deposited through a paused-market gap absorb any socialized loss when
          liquidations resume. not investment advice.
        </div>
      </div>
      <div className="lg:col-span-4 min-h-0 flex flex-col gap-[2px] lg:overflow-y-auto">
        <CreditTicket mkt={mkt} account={account} onDone={onTxDone} />
      </div>
    </main>
  );
}
