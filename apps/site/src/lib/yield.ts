/* The Yield Layer — PitYieldVault client config + ABI.
   Mainnet deployment 30 Aug 2026, all contracts Blockscout-verified.
   NVDA market first: pyNVDA escrows call-side stock, pyUSDG put-side cash. */
import type { Address } from "viem";

export const YIELD_VAULTS = [
  {
    key: "pyNVDA",
    name: "pyNVDA — call-side NVDA vault",
    address: "0x0295816Aa36597d5DA429deB23cd8b91d80CEb13" as Address,
    /* deposit asset */
    asset: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address,
    assetSymbol: "NVDA",
    assetDecimals: 18,
    counterSymbol: "USDG",
    counterDecimals: 6,
  },
  {
    key: "pyUSDG",
    name: "pyUSDG — put-side USDG vault",
    address: "0x99C077cCB19D13Dc2c92CdA7804b9ABC1502dF34" as Address,
    asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
    assetSymbol: "USDG",
    assetDecimals: 6,
    counterSymbol: "NVDA",
    counterDecimals: 18,
  },
] as const;

export type YieldVault = (typeof YIELD_VAULTS)[number];

/* Vaults exist per-market; only NVDA is live in the first release. */
export const YIELD_UNDERLYINGS = new Set<string>(["NVDA"]);

export const yieldVaultAbi = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [
    { name: "assets", type: "uint256" }, { name: "receiver", type: "address" },
    { name: "minShares", type: "uint256" }, { name: "deadline", type: "uint256" },
  ], outputs: [{ name: "shares", type: "uint256" }] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [
    { name: "shares", type: "uint256" }, { name: "receiver", type: "address" },
    { name: "minAssetOut", type: "uint256" }, { name: "minCounterOut", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ], outputs: [{ name: "assetOut", type: "uint256" }, { name: "counterOut", type: "uint256" }] },
  { type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "previewDeposit", stateMutability: "view", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ name: "shares", type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxTotalAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "positionLiquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
] as const;
