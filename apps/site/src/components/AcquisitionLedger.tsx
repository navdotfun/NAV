/* NAV — acquisition ledger: every vault fill, straight from chain logs.
   Pure display component — receives fully-computed rows, renders links to the
   explorer. Shows the newest fills first, capped for layout sanity. */
import { EXPLORER } from "../lib/chain";
import { fmt } from "../lib/format";

export interface LedgerRow {
  key: string;
  symbol: string;
  qty: number;
  /** Live-price valuation; null while the price is still resolving. */
  usd: number | null;
  direction: "in" | "out";
  /** Pre-formatted UTC stamp, e.g. "31 AUG 22:41". */
  when: string;
  tx: string;
}

const MAX_ROWS = 12;

export function AcquisitionLedger({ rows }: { rows: LedgerRow[] }) {
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <div className="mt-4 border-t border-ink-3 pt-3.5">
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <span className="px-label">ACQUISITION LEDGER</span>
        <span className="text-[12px] text-muted-dark">
          reconstructed from on-chain transfer logs · no indexer
        </span>
      </div>
      {shown.length === 0 ? (
        <div className="py-2 text-[13px] text-muted-dark">
          No fills printed yet — the next accumulation epoch writes the first row.
        </div>
      ) : (
        <ul className="grid gap-1">
          {shown.map((r) => (
            <li key={r.key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-[rgba(143,163,184,0.08)] py-1.5 text-[13px] last:border-b-0">
              <span className="num text-muted-dark">{r.when} UTC</span>
              <span className="num font-medium">
                <b className={r.direction === "in" ? "text-crt" : "text-red-crt"}>
                  {r.direction === "in" ? "+" : "−"}{fmt.num(r.qty, 4)} {r.symbol}
                </b>
                {r.usd !== null && <span className="text-muted-dark"> · ~{fmt.usd(r.usd, 0)}</span>}
              </span>
              <a
                className="num text-muted-dark underline decoration-dotted hover:text-crt"
                href={`${EXPLORER}/tx/${r.tx}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                tx ↗
              </a>
            </li>
          ))}
        </ul>
      )}
      {rows.length > MAX_ROWS && (
        <div className="pt-2 text-[12px] text-muted-dark">
          Showing the last {MAX_ROWS} of {rows.length} fills — full history on the explorer.
        </div>
      )}
    </div>
  );
}
