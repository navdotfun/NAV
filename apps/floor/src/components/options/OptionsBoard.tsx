/* OPTIONS — market board. Live per-market pool depth, measured streamia rate,
   open interest and writer-vault capacity, all read from the contract. */
import { formatUnits } from "viem";
import { fmt } from "../../lib/format";
import { OPT_RATE_CAP, OPT_RATE_FLOOR, type OptMarket } from "../../lib/options";

/* R4 F-16: single source of truth — clamp constants live in lib/options. */
const CAP_RATE = OPT_RATE_CAP;
const FLOOR_RATE = OPT_RATE_FLOOR;

export function OptionsBoard({ markets, selected, onSelect, booted }: {
  markets: OptMarket[];
  selected: number;
  onSelect: (id: number) => void;
  booted: boolean;
}) {
  const m = markets.find((x) => x.id === selected) ?? null;

  return (
    <section className="panel flex flex-col min-h-0" aria-label="options markets">
      <div className="panel-title">
        <span>MARKET BOARD · POOL-PRICED STREAMIA</span>
        <span className="text-txt-dim normal-case tracking-normal">RATE = LIVE UNISWAP FEES</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left">
              {["SYM", "ORACLE", "BAND DEPTH ±2%", "RATE/DAY", "OI", "OI CAP", "CALL FREE", "PUT FREE"].map((h) => (
                <th key={h} className="cell-label px-2 py-1 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {markets.map((mk) => {
              /* A-03/nullable ripple: a failed read is "—", NEVER a zero. */
              const rate = mk.dailyRateX18 !== null ? Number(mk.dailyRateX18) / 1e18 : null;
              const eff = rate !== null ? (rate === 0 ? FLOOR_RATE : Math.min(Math.max(rate, FLOOR_RATE), CAP_RATE)) : null;
              const depth = mk.bandDepthUsdg !== null ? Number(mk.bandDepthUsdg) / 1e6 : null;
              const cap = depth !== null ? depth * 0.2 : null;
              const oi = mk.oiNotional !== null ? Number(mk.oiNotional) / 1e6 : null;
              return (
                <tr key={mk.id} onClick={() => onSelect(mk.id)}
                  className={`cursor-pointer border-t border-rule hover:bg-panel-2 ${mk.id === selected ? "bg-panel-2" : ""}`}>
                  <td className={`px-2 py-1 font-bold ${mk.id === selected ? "text-amber-2" : "text-txt"}`}>{mk.symbol}</td>
                  {/* R4 F-01: oracle read failed → “—”, never a fake $0.00 */}
                  <td className="px-2 py-1 tabular-nums text-txt">{mk.price !== null ? fmt.usd(mk.price) : "—"}</td>
                  <td className="px-2 py-1 tabular-nums text-txt">{depth !== null ? fmt.usdCompact(depth) : "—"}</td>
                  {/* R4 M-01: flag when the measured rate is clamped at the cap —
                      quoted premia stop tracking volatility above this point. */}
                  <td className="px-2 py-1 tabular-nums text-amber-2">{eff !== null ? `${(eff * 10_000).toFixed(1)} BPS${rate === 0 ? " (FLOOR)" : rate !== null && rate >= CAP_RATE ? " (CAP)" : ""}` : "—"}</td>
                  <td className="px-2 py-1 tabular-nums text-txt">{oi !== null ? fmt.usdCompact(oi) : "—"}</td>
                  <td className="px-2 py-1 tabular-nums text-txt-dim">{cap !== null ? fmt.usdCompact(cap) : "—"}</td>
                  <td className="px-2 py-1 tabular-nums text-up">{mk.callVault ? `${fmt.num(Number(formatUnits(mk.callVault.freeAssets, 18)), 4)} ${mk.symbol}` : "—"}</td>
                  <td className="px-2 py-1 tabular-nums text-up">{mk.putVault ? fmt.usdCompact(Number(mk.putVault.freeAssets) / 1e6) : "—"}</td>
                </tr>
              );
            })}
            {markets.length === 0 && (
              <tr><td colSpan={8} className="px-2 py-6 text-center text-txt-dim">
                {booted ? "OPTIONS CONTRACT NOT YET DEPLOYED" : "LOADING MARKETS…"}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {m && (
        <div className="mt-auto border-t border-rule-2 p-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-[11.5px]">
          <Stat k={`${m.symbol} CALL VAULT`}
            v={m.callVault ? `${fmt.num(Number(formatUnits(m.callVault.assets, 18)))} ${m.symbol}` : "—"}
            sub={m.callVault ? `ESCROWED ${fmt.num(Number(formatUnits(m.callVault.escrowed, 18)))}` : "READ FAILED — RETRYING"} />
          <Stat k={`${m.symbol} PUT VAULT`}
            v={m.putVault ? fmt.usd(Number(m.putVault.assets) / 1e6) : "—"}
            sub={m.putVault ? `ESCROWED ${fmt.usd(Number(m.putVault.escrowed) / 1e6)}` : "READ FAILED — RETRYING"} />
          <Stat k="UNCLAIMED CALL PREMIUM"
            v={m.callVault ? fmt.usd(Number(m.callVault.premiumUsdg) / 1e6) : "—"}
            sub="HARVESTABLE BY WRITERS" />
          <Stat k="PRICING SOURCE" v="UNISWAP V3 FEEGROWTH" sub={`POOL ${m.pool.slice(0, 10)}…`} />
        </div>
      )}

      <div className="border-t border-rule p-2 text-[10px] leading-relaxed text-txt-dim">
        PREMIUM = MEASURED POOL FEE RATE × TERM × STRIKE FACTOR × 1.25, FLOOR 8 / CAP 300 BPS-DAY, MIN 2 BPS OF NOTIONAL ·
        DEPTH GATE: OI ≤ 20% OF ±2% BAND VALUE · WRITES 100% COLLATERALISED · INSOLVENCY IMPOSSIBLE BY CONSTRUCTION
      </div>
    </section>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="border border-rule bg-panel-2 p-1.5">
      <div className="cell-label">{k}</div>
      <div className="text-amber-2 tabular-nums text-[12.5px] mt-0.5">{v}</div>
      {sub && <div className="text-txt-dim text-[10px] mt-0.5">{sub}</div>}
    </div>
  );
}
