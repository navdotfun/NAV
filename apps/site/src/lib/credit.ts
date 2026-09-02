/* NAV Credit — deployed constants for the marketing site.
   Addresses are the deployment manifest of record (Sourcify exact-match
   verified); parameters are immutable constructor values, restated here
   only for display. The app itself enumerates markets from the factory. */
import type { Address } from "viem";

export const CREDIT_FACTORY: Address = "0x9A9feC2B6b05F94D8c3861d0202C05Df4Dcfd4A7";

export type CreditMarket = {
  sym: string;
  name: string;
  pair: Address;
  ltv: number; // max LTV, %
  lt: number; // liquidation threshold, %
  bonus: number; // liquidation bonus, %
};

export const CREDIT_MARKETS: CreditMarket[] = [
  { sym: "NVDA", name: "NVIDIA", pair: "0x29b2958726D905034A60Aa471B44Ee6df93516B1", ltv: 60, lt: 70, bonus: 8 },
  { sym: "QQQ", name: "Invesco QQQ", pair: "0xF07c295FB066fB1ae7867dc1235cdee009e2cafc", ltv: 65, lt: 75, bonus: 6 },
  { sym: "AAPL", name: "Apple", pair: "0x4b78AeF24A62896a4f1381969EF4C9D28d2a567c", ltv: 55, lt: 65, bonus: 8 },
  { sym: "TSLA", name: "Tesla", pair: "0x82797A109A840fa975616499F440C080730E1c6a", ltv: 50, lt: 60, bonus: 10 },
];

/* Immutable fee parameters, as deployed. */
export const CREDIT_ORIGINATION_BPS = 30;
export const CREDIT_RESERVE_FACTOR_PCT = 20;
export const CREDIT_SKIM_BOUNTY_BPS = 5;

/* Verification campaign, as published in the audit reports. */
export const CREDIT_CAMPAIGN_CHECKS_M = 109.6;
