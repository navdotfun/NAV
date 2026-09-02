/* NAV — nav.fun · verified Stock Token universe (live, on-chain).
   Source: Robinhood Chain Token List v5 (hood-tokenlist), every address re-verified
   against the chain via eth_call symbol()/decimals() on 2026-08-30.
   No demo data lives in this file — vault stats come from src/lib/protocol.ts (live reads),
   prices from src/lib/live.ts (Uniswap v3 slot0). */
import type { Address } from "viem";
import raw from "./stocktokens.json";

export interface StockToken {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
}

/** Verified Stock Tokens (equities + ETFs) on Robinhood Chain mainnet. */
export const STOCK_TOKENS: StockToken[] = raw as StockToken[];

/** Count of verified Stock Token contracts. Robinhood lists 190+ instruments in-app;
    this is the subset with published, on-chain-verified contract addresses. */
export const STOCK_TOKEN_COUNT = STOCK_TOKENS.length;

/* deterministic hash from string (pixel identicons) */
export function navHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
