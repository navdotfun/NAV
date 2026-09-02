/* CREDIT — your position on the selected market: supplied, collateral,
   debt, borrow headroom and a health-factor meter. Chain reads only;
   null (failed read / not connected) renders "—", never a fake zero. */
import { formatUnits } from "viem";
import { fmt } from "../../lib/format";
import { maxBorrow, type CreditAccount, type CreditMarket } from "../../lib/credit";

/* The contract returns uint256.max for a debtless position. Any HF at or
   above this threshold (half of uint256.max) is rendered as ∞ — real HFs
   live many orders of magnitude below it. */
const MAX_HF = 2n ** 255n;

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-3 py-2 min-w-[120px]">
      <div className="cell-label">{label}</div>
      <div className="text-txt text-[14px] mt-0.5">{value}</div>
      {sub && <div className="text-txt-dim text-[10.5px]">{sub}</div>}
    </div>
  );
}

export function CreditPositionStrip({ mkt, account, connected }: {
  mkt: CreditMarket | null;
  account: CreditAccount | null;
  connected: boolean;
}) {
  const a = connected ? account : null;

  const collateralUnits = a?.collateral ?? null;
  const collateralUsd = collateralUnits !== null && mkt?.price != null
    ? Number(formatUnits(collateralUnits, 18)) * mkt.price : null;
  const debt = a?.debt ?? null;
  const hf = a?.healthFactor ?? null;
  const headroom = mkt && collateralUnits !== null && debt !== null
    ? maxBorrow(mkt, collateralUnits, debt) : null;

  /* HF meter: 1.0 = liquidation. Scale 1.0–2.0 across the bar. */
  const hfNum = hf === null ? null : hf >= MAX_HF ? Infinity : Number(formatUnits(hf, 18));
  const hfText = hfNum === null ? "—" : hfNum === Infinity ? "∞" : hfNum.toFixed(3);
  const hfPct = hfNum === null ? 0 : hfNum === Infinity ? 100 : Math.max(0, Math.min(100, (hfNum - 1) * 100));
  const hfTone = hfNum === null ? "text-txt-dim"
    : hfNum === Infinity || hfNum >= 1.5 ? "text-up"
    : hfNum >= 1.1 ? "text-amber-2" : "text-dn";

  return (
    <section className="panel">
      <div className="panel-title">
        <span>YOUR POSITION{mkt ? ` · ${mkt.symbol}/USDG` : ""}</span>
        {mkt && mkt.priceFresh === false && (
          <span className="text-dn normal-case tracking-normal">
            STALE FEED — usd values &amp; hf reflect the last anchor; borrows paused
          </span>
        )}
        {!connected && <span className="text-txt-dim normal-case tracking-normal">connect a wallet to view</span>}
      </div>
      <div className="flex flex-wrap divide-x divide-rule">
        <Cell
          label="SUPPLIED"
          value={a?.supplyBalance != null ? fmt.usd(Number(formatUnits(a.supplyBalance, 6))) : "—"}
          sub="USDG earning interest"
        />
        <Cell
          label="COLLATERAL"
          value={collateralUnits !== null && mkt
            ? `${fmt.num(Number(formatUnits(collateralUnits, 18)), 4)} ${mkt.symbol}` : "—"}
          sub={collateralUsd !== null
            ? `${fmt.usd(collateralUsd)}${mkt?.priceFresh === false ? " · STALE" : ""}` : undefined}
        />
        <Cell
          label="DEBT"
          value={debt !== null ? fmt.usd(Number(formatUnits(debt, 6))) : "—"}
          sub="USDG owed (live)"
        />
        <Cell
          label="BORROW HEADROOM"
          value={headroom !== null ? fmt.usd(Number(formatUnits(headroom, 6))) : "—"}
          sub={mkt ? `at ${(mkt.ltvBps / 100).toFixed(0)}% max LTV` : undefined}
        />
        <div className="px-3 py-2 flex-1 min-w-[190px]">
          <div className="cell-label flex justify-between">
            <span>HEALTH FACTOR</span>
            <span className={hfTone}>{hfText}</span>
          </div>
          <div className="mt-2 h-[7px] bg-panel-2 border border-rule relative" role="meter"
            aria-label="health factor" aria-valuenow={hfNum === Infinity ? 999 : hfNum ?? 0}
            aria-valuemin={1} aria-valuemax={2}>
            <div
              className={`h-full ${hfNum !== null && hfNum < 1.1 ? "bg-dn" : "bg-up"}`}
              style={{ width: `${hfPct}%` }}
            />
          </div>
          <div className="flex justify-between text-[9.5px] text-txt-dim mt-0.5">
            <span>1.00 · LIQUIDATION</span>
            <span>≥ 2.00</span>
          </div>
        </div>
      </div>
    </section>
  );
}
