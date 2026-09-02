import { STOCK_TOKENS, type StockToken } from "../lib/data";
import { useTokenPrice } from "../lib/live";
import { fmt } from "../lib/format";

/* Liquid, well-known tickers first so the tape shows real prices fast. */
const TAPE_SYMBOLS = [
  "NVDA", "AAPL", "TSLA", "MSFT", "AMZN", "GOOGL", "META", "SPY", "QQQ", "COIN",
  "PLTR", "AMD", "MSTR", "GME", "SPCX", "INTC", "MU", "ORCL", "CRCL", "RKLB",
  "TSM", "IONQ", "SNDK", "USAR",
];
const PICKS: StockToken[] = TAPE_SYMBOLS
  .map((s) => STOCK_TOKENS.find((t) => t.symbol === s))
  .filter((t): t is StockToken => Boolean(t));

function TapeItem({ token }: { token: StockToken }) {
  const p = useTokenPrice(token);
  return (
    <span className="tape-item">
      <span className="t">{token.symbol}</span>
      <span className="num">
        {p?.status === "ok" && p.price !== undefined ? fmt.usd(p.price) : p?.status === "loading" || !p ? "…" : "—"}
      </span>
    </span>
  );
}

/** Scrolling pixel ticker tape — live Uniswap v3 prices from Robinhood Chain. */
export function Tape() {
  const group = (ariaHidden: boolean) => (
    <div className="tape-group" aria-hidden={ariaHidden}>
      {PICKS.map((x) => (
        <TapeItem key={x.symbol + (ariaHidden ? "b" : "a")} token={x} />
      ))}
    </div>
  );
  return (
    <>
      {/* Screen-reader alternative — the marquee itself is aria-hidden (L-10) */}
      <span className="sr-only">Live token price ticker: prices stream from Uniswap v3 on Robinhood Chain.</span>
      <div className="tape" aria-hidden="true">
        <div className="tape-track">
          {group(false)}
          {group(true)}
        </div>
      </div>
    </>
  );
}
