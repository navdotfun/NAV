/* WORLD — deployment registry for the game-world contracts.
   Addresses are null until the contracts are live on Robinhood Chain
   (chain 4663) and Sourcify-verified; every view gates on them so the
   UI can never fabricate data for an undeployed contract. */
import type { Address } from "viem";

/** NavArena — Colosseum bouts. Deployed + Sourcify-verified before fill. */
export const ARENA_ADDRESS: Address | null = "0x51506936ae5A1146D1e3C6e804f25Fb58c492cb3";

/** NavIndexFactory — Kingdoms registry. */
export const INDEX_FACTORY: Address | null = "0x0c566a9ec97D57502d557FBD3F8AB0e6059cfeC3";

/** NavIndexZap — one-click USDG issue/redeem through NavSwapRouter. */
export const INDEX_ZAP: Address | null = "0xD98803f42f57B8ed5ECa41312eDE366197c1808E";
