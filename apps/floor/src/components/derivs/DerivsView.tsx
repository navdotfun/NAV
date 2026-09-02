/* DERIVS — the single derivatives floor. One page, two live products:
   OPTIONS — dated European calls/puts on tokenized stocks, cash-settled
   in USDG by NavOptions (fully collateralized at open, insolvency-impossible).
   THE PIT — perpetual-style fixed-strike option books written peer-to-peer
   against verified PitPool vaults. Both are pure chain reads; the rail
   below only switches which audited desk is mounted. */
import { useState } from "react";
import { OptionsView } from "../options/OptionsView";
import { PitView } from "../pit/PitView";

type Product = "OPTIONS" | "PIT";

const PRODUCTS: { id: Product; label: string; blurb: string }[] = [
  {
    id: "OPTIONS",
    label: "OPTIONS",
    blurb: "DATED CALLS/PUTS · CASH-SETTLED USDG · FULLY COLLATERALIZED",
  },
  {
    id: "PIT",
    label: "THE PIT",
    blurb: "STRIKE BOOKS · WRITE OR TAKE · P2P COLLATERAL VAULTS",
  },
];

export function DerivsView() {
  const [product, setProduct] = useState<Product>("OPTIONS");
  const active = PRODUCTS.find((p) => p.id === product)!;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* product rail — one page, two desks */}
      <div className="mx-[2px] mt-[2px] panel flex items-stretch flex-wrap">
        <div className="flex">
          {PRODUCTS.map((p) => (
            <button key={p.id} type="button"
              className={`px-3 py-1.5 text-[11px] font-semibold tracking-wider border-r border-rule ${
                product === p.id ? "bg-panel-2 text-amber-2" : "text-txt-dim hover:text-txt"
              }`}
              aria-pressed={product === p.id}
              onClick={() => setProduct(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex-1 flex items-center px-2.5 py-1 min-w-[200px]">
          <span className="cell-label !pb-0">{active.blurb}</span>
        </div>
      </div>
      {product === "OPTIONS" ? <OptionsView /> : <PitView />}
    </div>
  );
}
