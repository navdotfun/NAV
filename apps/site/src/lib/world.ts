/* World expansion — Kingdoms (index factory) + Colosseum (arena).
   Addresses are null until the contracts are deployed and Sourcify-verified;
   the homepage renders a "deploying" state for null entries. */

export const WORLD = {
  arena: "0x51506936ae5A1146D1e3C6e804f25Fb58c492cb3" as `0x${string}` | null,
  indexFactory: "0x0c566a9ec97D57502d557FBD3F8AB0e6059cfeC3" as `0x${string}` | null,
  indexZap: "0xD98803f42f57B8ed5ECa41312eDE366197c1808E" as `0x${string}` | null,
};

/** Bytecode-fixed economics shown on the homepage. */
export const ARENA_FEE_PCT = 2; // % of losing pot
export const ARENA_BOUNTY_PCT = 10; // % of fee to settler
export const INDEX_MAX_MINT_FEE_BPS = 100;
export const INDEX_MAX_STREAM_FEE_BPS = 200;
export const INDEX_VAULT_SHARE_PCT = 10; // % of every mint/redeem fee left unminted → per-share backing accretion
export const INDEX_MAX_COMPONENTS = 10;
