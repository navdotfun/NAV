/* NAV — nav.fun · protocol config + vault/market read hooks.
   All core contracts are DEPLOYED and source-verified on Robinhood Chain
   mainnet. TGE executed 31 Aug 2026 — $NAV/WETH pool live, LP timelocked
   (extended on-chain to 2 Dec 2026).
   The vault reads live and seeds from protocol fee flow. */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { erc20Abi, publicClient, sqrtPriceToPrice } from "./chain";

/** FP-L07: hard deadline on vault reads so a hanging RPC surfaces as an error
    instead of an indefinite "SYNCING…". Generous enough for a slow-but-alive
    node; short enough that a dead one is reported promptly. */
const VAULT_READ_TIMEOUT_MS = 20_000;

export interface ProtocolConfig {
  /** $NAV ERC-20 (share token) — deployed + verified. */
  tokenAddress: Address | null;
  /** NAVVault (multi-asset vault) — deployed + verified. */
  vaultAddress: Address | null;
  /** FeeSplitter — deployed + verified. */
  feeSplitterAddress: Address | null;
  /** Accumulator — deployed + verified. */
  accumulatorAddress: Address | null;
  /** NavCrank — one-tx permissionless fee pipeline (deployed 1 Sep 2026). */
  navCrankAddress: Address | null;
  /** Vanity burner used for deployment ("A55E7" ≈ ASSET). */
  deployer: Address;
  /** Uniswap NAV/WETH pool fee, basis points (1%) — accrues to the locked,
      protocol-owned LP position; NAVToken itself has no transfer tax. */
  swapFeeBps: number;
  /** Collected-fee split: vault accumulation / operations / LP incentives. */
  feeSplit: { vault: number; ops: number; lp: number };
  /** In-kind redemption exit fee, basis points (0.5%) — stays in the vault. */
  redeemFeeBps: number;
}

export const PROTOCOL: ProtocolConfig = {
  tokenAddress: "0x3e7f2c3A81a1c8302eacE254928e0fBa5A3Bc447",
  vaultAddress: "0xb8F008322671179E2C93dd8610be8d5D7876087b",
  feeSplitterAddress: "0x6bCA8944F711A2299a20ecb02E7AE25d78f81Ca2",
  accumulatorAddress: "0x3620Da2708734d1eE64D929cF9a05EAf9a7778a0",
  navCrankAddress: "0x15F15c5513fb076ffaD48c80Ad65CC3EB009dD1e",
  deployer: "0xa55e7Cc7cF79f2AECb5AA9D377a1ed59aA95998d",
  swapFeeBps: 100,
  feeSplit: { vault: 80, ops: 15, lp: 5 },
  redeemFeeBps: 50,
};

export const IS_PRELAUNCH = PROTOCOL.tokenAddress === null || PROTOCOL.vaultAddress === null;

/** TGE — executed 31 Aug 2026. $NAV/WETH Uniswap v3 pool (1% tier), 100% of
    supply seeded full-range, LP NFT locked in LpTimelock (forward-only). */
export const TGE = {
  poolAddress: "0x24c0B949ca94E90f325CE7Fd8D6E8b6EE92De20E" as Address,
  wethAddress: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  /** token0 = WETH, token1 = NAV — slot0 price is NAV-per-WETH raw. */
  navIsToken0: false,
  lpTokenId: 921454n,
  lpTimelock: "0xA5782C0A38b5d2C9fec4A6F11d2c0a94A21D36c6" as Address,
  lpUnlockTime: 1796204237, // 2 Dec 2026 09:37 UTC — extended 2 Sep 2026 (tx 0x4d3979cf…), forward-only
  executedAt: "31 AUG 2026",
} as const;

/** Single source of truth for launch-phase copy (M-06/M-10). TGE executed
    31 Aug 2026 — every badge/pill/footnote about launch state derives from here. */
export const LAUNCH = {
  tgePending: false,
  badge: "LIVE · TGE 31 AUG 2026",
  chartBadge: "LIVE — EPOCH 1 EXECUTED 31 AUG 2026",
  note: "$NAV is trading on Uniswap v3 (Robinhood Chain). 100% of supply seeded at TGE; LP locked until 2 Dec 2026. The vault seeds from live fee flow.",
} as const;

/** The Pit (options floor) — live on Robinhood Chain mainnet.
    Deployment registry, market table and ABIs live in lib/pit.ts. */
export const IS_PIT_LIVE = true;

const v3PoolSlot0Abi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint160" }, { type: "int24" }, { type: "uint16" },
      { type: "uint16" }, { type: "uint8" }, { type: "uint8" }, { type: "bool" },
    ],
  },
] as const;

export interface NavMarket {
  status: "loading" | "ok" | "error";
  /** $NAV price in ETH (WETH per NAV). */
  priceEth: number | null;
}

/** Live $NAV market price — slot0 of the TGE pool, read client-side over RPC
    (no indexer, no backend). Refreshes every 12s. */
export function useNavMarket(): NavMarket {
  const [m, setM] = useState<NavMarket>({ status: "loading", priceEth: null });
  useEffect(() => {
    let stop = false;
    const read = async () => {
      try {
        const slot0 = await publicClient.readContract({
          address: TGE.poolAddress, abi: v3PoolSlot0Abi, functionName: "slot0",
        });
        const sqrtPriceX96 = slot0[0] as bigint;
        if (sqrtPriceX96 === 0n) throw new Error("pool uninitialised");
        const priceEth = sqrtPriceToPrice(sqrtPriceX96, TGE.navIsToken0, 18, 18);
        if (!stop) setM({ status: "ok", priceEth });
      } catch {
        if (!stop) setM((prev) => (prev.status === "ok" ? prev : { status: "error", priceEth: null }));
      }
    };
    void read();
    const t = setInterval(read, 12_000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  return m;
}

const navVaultAbi = [
  { type: "function", name: "allAssets", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "redeemFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  /* AUDIT v3 GUARD #2 (P3-05) — redeemInKind SKIPS inactive assets without
     crediting the holder, so redeeming while any listed asset is inactive
     permanently forfeits that slice. The flag must be read and the redeem
     path hard-blocked whenever any asset is inactive. */
  {
    type: "function",
    name: "assetInfo",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "listed", type: "bool" },
      { name: "active", type: "bool" },
      { name: "addedAt", type: "uint64" },
    ],
  },
] as const;

export interface VaultState {
  status: "prelaunch" | "loading" | "live" | "error";
  totalSupply: bigint | null;
  redeemFeeBps: number | null;
  /** Vault registry assets with on-chain balances (via multicall). */
  holdings: { address: Address; balance: bigint }[] | null;
  /** Listed-but-inactive assets. Non-empty ⇒ redemption MUST be blocked (P3-05).
      null while unknown (loading / read failure) — treat as unsafe, not safe. */
  inactiveAssets: Address[] | null;
}

/** Live vault reads (totalSupply, registry, balances, fee). Renders pre-launch until
    PROTOCOL.tokenAddress / vaultAddress are set. */
export function useVaultState(): VaultState {
  const [state, setState] = useState<VaultState>({
    status: IS_PRELAUNCH ? "prelaunch" : "loading",
    totalSupply: null,
    redeemFeeBps: null,
    holdings: null,
    inactiveAssets: null,
  });

  useEffect(() => {
    const token = PROTOCOL.tokenAddress;
    const vault = PROTOCOL.vaultAddress;
    if (!token || !vault) return; // pre-launch — nothing to read
    let stop = false;

    /* FP-L07: an RPC that accepts the connection and then never answers left
       this hook in "loading" forever, so the UI showed "SYNCING…" indefinitely
       with no escalation — indistinguishable to the user from a slow chain.
       A hang is a failure: bound every read and fail closed to "error", which
       renders "RPC ERROR — RETRY" and keeps inactiveAssets null so the redeem
       guard stays shut. */
    const withDeadline = <T,>(p: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`vault read timed out: ${label}`)), VAULT_READ_TIMEOUT_MS),
        ),
      ]);

    (async () => {
      try {
        const [totalSupply, assets, feeBps] = await withDeadline(Promise.all([
          publicClient.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
          publicClient.readContract({ address: vault, abi: navVaultAbi, functionName: "allAssets" }),
          publicClient.readContract({ address: vault, abi: navVaultAbi, functionName: "redeemFeeBps" }),
        ]), "supply/registry/fee");
        const [balances, infos] = await withDeadline(Promise.all([
          publicClient.multicall({
            contracts: assets.map((a) => ({
              address: a, abi: erc20Abi, functionName: "balanceOf" as const, args: [vault] as const,
            })),
            allowFailure: true,
          }),
          publicClient.multicall({
            contracts: assets.map((a) => ({
              address: vault, abi: navVaultAbi, functionName: "assetInfo" as const, args: [a] as const,
            })),
            allowFailure: true,
          }),
        ]), "balances/assetInfo");
        if (stop) return;
        /* Any read failure is treated as "unknown" — the asset is listed as
           inactive so the redeem guard fails closed rather than open. */
        const inactive: Address[] = [];
        infos.forEach((r, i) => {
          if (r.status !== "success") { inactive.push(assets[i]); return; }
          const [listed, active] = r.result as readonly [boolean, boolean, bigint];
          if (listed && !active) inactive.push(assets[i]);
        });
        setState({
          status: "live",
          totalSupply,
          redeemFeeBps: Number(feeBps),
          holdings: assets.map((a, i) => ({
            address: a,
            balance: balances[i].status === "success" ? (balances[i].result as bigint) : 0n,
          })),
          inactiveAssets: inactive,
        });
      } catch {
        if (!stop) setState((s) => ({ ...s, status: "error" }));
      }
    })();
    return () => { stop = true; };
  }, []);

  return state;
}
