/* Shim — re-exports the Floor chain layer for the ported Pit/Vault libs,
   adding the two extras the port needs (USDC quote token, robinhoodChain re-export). */
import type { Address } from "viem";
import { TOKENS as FLOOR_TOKENS } from "../chain";
export {
  publicClient, sqrtPriceToPrice, erc20Abi, v3PoolAbi, v3FactoryAbi,
  V3_FEE_TIERS, UNISWAP, NAV, EXPLORER, robinhoodChain, shortAddr,
} from "../chain";
export const TOKENS = {
  ...FLOOR_TOKENS,
  USDC: { address: "0x80E0e24718DbfcAd49ecAA6f1E6c89A190586ca8" as Address, symbol: "USDC", decimals: 6 },
} as const;
