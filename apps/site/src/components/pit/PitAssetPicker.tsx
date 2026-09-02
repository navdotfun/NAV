/* The Pit — searchable underlying picker over the verified Stock Token registry.
   Prices are the same lazy live Uniswap v3 reads used by the Vault Terminal. */
import { useMemo, useState } from "react";
import { Identicon } from "../Identicon";
import { STOCK_TOKENS, STOCK_TOKEN_COUNT, type StockToken } from "../../lib/data";
import { useInView, useTokenPrice } from "../../lib/live";
import { fmt } from "../../lib/format";

function PickRow({ token, active, onPick }: { token: StockToken; active: boolean; onPick: (t: StockToken) => void }) {
  const { ref, inView } = useInView<HTMLButtonElement>();
  const p = useTokenPrice(token, inView);
  const noPool = p?.status === "none" || p?.status === "error";
  return (
    <button
      ref={ref}
      type="button"
      className={`pit-pick ${active ? "active" : ""}`}
      onClick={() => onPick(token)}
      disabled={noPool}
      title={noPool ? "No Uniswap v3 pool with liquidity found on-chain" : `${token.symbol} — ${token.name}`}
    >
      <span className="tk min-w-0">
        <Identicon t={token.symbol} />
        <span className="tk-sym">{token.symbol}</span>
        <span className="tk-name truncate">{token.name}</span>
      </span>
      <span className="num text-[13.5px] flex-none">
        {p?.status === "ok" && p.price !== undefined ? (
          <span className={active ? "text-crt" : "text-paper"}>{fmt.usd(p.price)}</span>
        ) : p?.status === "loading" ? (
          <span className="text-muted-dark">…</span>
        ) : p?.status === "none" ? (
          <span className="text-muted-dark">no pool</span>
        ) : p?.status === "error" ? (
          <span className="text-muted-dark">retrying…</span>
        ) : (
          <span className="text-muted-dark">·</span>
        )}
      </span>
    </button>
  );
}

export function PitAssetPicker({ selected, onPick }: { selected: StockToken | null; onPick: (t: StockToken) => void }) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    return STOCK_TOKENS.filter((x) => !q || x.symbol.toUpperCase().includes(q) || x.name.toUpperCase().includes(q));
  }, [query]);

  return (
    <section className="panel">
      <div className="panel-head flex-wrap">
        <span className="px-label">UNDERLYING · {STOCK_TOKEN_COUNT} REGISTRY TOKENS</span>
        <input
          className="search-box"
          type="search"
          placeholder="FILTER: NVDA…"
          aria-label="Filter underlyings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="pit-pick-scroll dark-scroll" role="listbox" aria-label="Underlying stock token">
        {rows.length === 0 ? (
          <div className="px-4 py-7 text-center text-[13.5px] text-muted-dark">
            No tokens match “{query.trim().toUpperCase()}”.
          </div>
        ) : (
          rows.map((t) => (
            <PickRow key={t.address} token={t} active={selected?.address === t.address} onPick={onPick} />
          ))
        )}
      </div>
      <div className="pit-pick-note border-t border-ink-3 px-4 py-3 text-[12.5px] text-muted-dark">
        Prices read live from each token's deepest Uniswap v3 pool. Tokens without an
        on-chain pool cannot be quoted.
      </div>
    </section>
  );
}
