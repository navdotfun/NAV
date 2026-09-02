/* NAV — nav.fun · live transaction layer: buy $NAV (Uniswap v3), redeem (vault),
   and the public fee cranks (FeeSplitter.distribute / AccumulatorV2.accumulate).

   Discipline — every write follows the same three steps, no exceptions:
     1. ensureChain()            — wallet must be on Robinhood Chain (4663)
     2. publicClient.simulateContract — surfaces any revert BEFORE signing
     3. walletClient.writeContract(request) → waitForTransactionReceipt

   No amount leaves the user's wallet without an on-chain-derived minimum-out
   (SLIPPAGE_BPS below spot) or, for redemptions, a hard fee pin at the current
   on-chain redeemFeeBps. */
import { encodePacked, parseUnits, type Address, type Hash } from "viem";
import { PROTOCOL, TGE } from "./protocol";
import { publicClient, TOKENS, UNISWAP } from "./chain";
import { ensureChain, walletClient } from "./wallet";
import { limited } from "./rpc";

/* ------------------------------------------------------------------ consts */

/** Slippage floor applied to spot quotes, bps (1.5%). */
export const SLIPPAGE_BPS = 150n;
/** NAV/WETH pool fee tier (1%). */
const NAV_POOL_FEE = 10_000;
/** WETH/USDG pool fee tier used for the stable leg (0.05%) — deepest on chain. */
const USDG_WETH_FEE = 500;
/** Vault exit fee pin — reverts if governance raised the fee before inclusion. */
const REDEEM_FEE_PIN_BPS = 50;

export const NPM_ADDRESS = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3" as Address;
const UINT128_MAX = (1n << 128n) - 1n;

/** Assets with accumulate() routes enabled on-chain (owner-gated setRoute; probed
    and verified against AccumulatorV2 storage 31 Aug 2026). */
export const ROUTED_ASSETS: { symbol: string; address: Address }[] = [
  { symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" },
  { symbol: "AMZN", address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54" },
  { symbol: "COST", address: "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2" },
  { symbol: "CRCL", address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5" },
  { symbol: "GME", address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E" },
  { symbol: "GOOGL", address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3" },
  { symbol: "MSFT", address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74" },
  { symbol: "MU", address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD" },
  { symbol: "NFLX", address: "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8" },
  { symbol: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
  { symbol: "PLTR", address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A" },
  { symbol: "QQQ", address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68" },
  { symbol: "RDDT", address: "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C" },
  { symbol: "SLV", address: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f" },
  { symbol: "SPCX", address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa" },
  { symbol: "SPY", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" },
  { symbol: "TSLA", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" },
  { symbol: "TSM", address: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA" },
  { symbol: "USO", address: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344" },
];

/* ------------------------------------------------------------------- ABIs */

const swapRouterAbi = [
  {
    type: "function", name: "exactInputSingle", stateMutability: "payable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function", name: "exactInput", stateMutability: "payable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "path", type: "bytes" }, { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const erc20WriteAbi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const vaultRedeemAbi = [
  /* custom errors — required so viem can decode simulation reverts by name */
  { type: "error", name: "ZeroShares", inputs: [] },
  { type: "error", name: "AllAssetsInactive", inputs: [] },
  { type: "error", name: "NothingRedeemed", inputs: [] },
  { type: "error", name: "FeeAboveMax", inputs: [{ name: "feeBps", type: "uint16" }, { name: "maxFeeBps", type: "uint16" }] },
  { type: "error", name: "InsufficientOutput", inputs: [{ name: "asset", type: "address" }, { name: "paid", type: "uint256" }, { name: "minOut", type: "uint256" }] },
  { type: "error", name: "LengthMismatch", inputs: [] },
  {
    type: "function", name: "redeemInKindGuarded", stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" }, { name: "to", type: "address" },
      { name: "maxFeeBps", type: "uint16" },
      { name: "minOutAssets", type: "address[]" }, { name: "minOutAmounts", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

const splitterAbi = [
  { type: "error", name: "BadSplit", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "function", name: "distribute", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

const accumulatorAbi = [
  /* custom errors — required so viem can decode simulation reverts by name */
  { type: "error", name: "RouteNotEnabled", inputs: [] },
  { type: "error", name: "AssetNotInRegistry", inputs: [] },
  { type: "error", name: "IntervalNotElapsed", inputs: [] },
  { type: "error", name: "NothingToAccumulate", inputs: [] },
  { type: "error", name: "TwapZero", inputs: [] },
  { type: "error", name: "NoOutput", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "InsufficientOutput", inputs: [{ name: "out", type: "uint256" }, { name: "minOut", type: "uint256" }] },
  { type: "error", name: "PoolNotCanonical", inputs: [] },
  { type: "error", name: "PoolTooThin", inputs: [{ name: "liquidity", type: "uint128" }, { name: "required", type: "uint128" }] },
  { type: "error", name: "PoolObservationsTooShort", inputs: [{ name: "cardinality", type: "uint16" }, { name: "required", type: "uint16" }] },
  { type: "error", name: "OracleDeviation", inputs: [{ name: "poolPrice", type: "uint256" }, { name: "oraclePrice", type: "uint256" }, { name: "maxBps", type: "uint16" }] },
  { type: "function", name: "accumulate", stateMutability: "nonpayable", inputs: [{ name: "asset", type: "address" }], outputs: [{ name: "out", type: "uint256" }] },
  { type: "function", name: "lastRunAt", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const npmCollectAbi = [
  {
    type: "function", name: "collect", stateMutability: "payable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "tokenId", type: "uint256" }, { name: "recipient", type: "address" },
        { name: "amount0Max", type: "uint128" }, { name: "amount1Max", type: "uint128" },
      ],
    }],
    outputs: [{ name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" }],
  },
] as const;

/* -------------------------------------------------------------- quoting */

export type PayAsset = "ETH" | "USDG";

/** Spot quote for an ETH buy. Pure function of live inputs — no RPC.
    Pays the 1% NAV pool fee; minOut floors execution at SLIPPAGE_BPS below spot. */
export function quoteBuyEth(
  amount: string, navPriceEth: number | null,
): { navOut: number; minOut: bigint; amountIn: bigint } | null {
  if (navPriceEth === null || navPriceEth <= 0) return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  let amountIn: bigint;
  try {
    amountIn = parseUnits(amount, 18);
  } catch {
    return null;
  }
  const navOut = (n / navPriceEth) * (1 - NAV_POOL_FEE / 1_000_000);
  const est = parseUnits(navOut.toFixed(18), 18);
  const minOut = (est * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  return { navOut, minOut, amountIn };
}

/** USDG variant — needs the live ETH/USD price for the stable leg. */
export function quoteBuyUsdg(
  amount: string, navPriceEth: number | null, ethUsd: number | null,
): { navOut: number; minOut: bigint; amountIn: bigint } | null {
  if (navPriceEth === null || navPriceEth <= 0 || ethUsd === null || ethUsd <= 0) return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  let amountIn: bigint;
  try {
    amountIn = parseUnits(amount, TOKENS.USDG.decimals);
  } catch {
    return null;
  }
  const ethLeg = (n / ethUsd) * (1 - USDG_WETH_FEE / 1_000_000);
  const navOut = (ethLeg / navPriceEth) * (1 - NAV_POOL_FEE / 1_000_000);
  const est = parseUnits(navOut.toFixed(18), 18);
  const minOut = (est * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  return { navOut, minOut, amountIn };
}

/* --------------------------------------------------------------- writes */

export type TxPhase =
  | { step: "idle" }
  | { step: "approving"; hash?: Hash }
  | { step: "pending"; hash?: Hash }
  | { step: "done"; hash: Hash }
  | { step: "error"; message: string };

function friendlyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const line = raw.split("\n")[0] ?? raw;
  if (/user rejected|denied|rejected the request/i.test(raw)) return "Rejected in wallet.";
  if (/TooSoon/i.test(raw)) return "Crank cooldown hasn't elapsed — the timer shows when it reopens.";
  if (/NothingToCrank/i.test(raw)) return "Nothing to crank yet — fees haven't accrued past the minimums.";
  if (/insufficient funds/i.test(raw)) return "Insufficient balance for amount + gas.";
  if (/Too little received|amountOutMinimum|slippage/i.test(raw)) return "Price moved beyond the 1.5% slippage floor — try again.";
  if (/IntervalNotElapsed/i.test(raw)) return "This asset's 5-minute crank cooldown hasn't elapsed.";
  if (/NothingToAccumulate/i.test(raw)) return "Accumulator balance is zero — run DISTRIBUTE first or wait for fees.";
  if (/RouteNotEnabled/i.test(raw)) return "No buy-route enabled for this asset.";
  if (/FeeAboveMax/i.test(raw)) return "Vault fee changed on-chain — redemption pinned at 0.5% refused to execute.";
  if (/NothingRedeemed/i.test(raw)) return "Redemption produced zero output — amount too small.";
  if (/InsufficientOutput/i.test(raw)) return "Output below your minimum — price moved, requote and retry.";
  if (/PoolTooThin|PoolObservationsTooShort|OracleDeviation|PoolNotCanonical|TwapZero/i.test(raw)) return "Accumulator safety gate rejected the route — pool state outside safe bounds right now.";
  if (/AssetNotInRegistry/i.test(raw)) return "Asset is not in the vault registry.";
  return line.length > 140 ? line.slice(0, 140) + "…" : line;
}

async function requireWallet(): Promise<{ account: Address } | { error: string }> {
  const ok = await ensureChain();
  if (!ok) return { error: "Wrong network — switch to Robinhood Chain (4663)." };
  const wc = walletClient();
  const [account] = wc ? await wc.getAddresses() : [undefined];
  if (!wc || !account) return { error: "Connect a wallet first." };
  return { account };
}

/** Buy $NAV with native ETH (router wraps via msg.value) or USDG (approve + 2-hop path). */
export async function sendBuy(
  pay: PayAsset, amountIn: bigint, minOut: bigint,
  onPhase: (p: TxPhase) => void,
): Promise<void> {
  const w = await requireWallet();
  if ("error" in w) return onPhase({ step: "error", message: w.error });
  const wc = walletClient()!;
  const nav = PROTOCOL.tokenAddress!;
  try {
    if (pay === "USDG") {
      const allowance = await publicClient.readContract({
        address: TOKENS.USDG.address, abi: erc20WriteAbi, functionName: "allowance",
        args: [w.account, UNISWAP.swapRouter02],
      });
      if (allowance < amountIn) {
        onPhase({ step: "approving" });
        const { request } = await publicClient.simulateContract({
          address: TOKENS.USDG.address, abi: erc20WriteAbi, functionName: "approve",
          args: [UNISWAP.swapRouter02, amountIn], account: w.account,
        });
        const hash = await wc.writeContract(request);
        onPhase({ step: "approving", hash });
        const arc = await publicClient.waitForTransactionReceipt({ hash });
        if (arc.status !== "success") throw new Error("Approval reverted on-chain.");
      }
      onPhase({ step: "pending" });
      const path = encodePacked(
        ["address", "uint24", "address", "uint24", "address"],
        [TOKENS.USDG.address, USDG_WETH_FEE, TGE.wethAddress, NAV_POOL_FEE, nav],
      );
      const { request } = await publicClient.simulateContract({
        address: UNISWAP.swapRouter02, abi: swapRouterAbi, functionName: "exactInput",
        args: [{ path, recipient: w.account, amountIn, amountOutMinimum: minOut }],
        account: w.account,
      });
      const hash = await wc.writeContract(request);
      onPhase({ step: "pending", hash });
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
      onPhase({ step: "done", hash });
    } else {
      onPhase({ step: "pending" });
      const { request } = await publicClient.simulateContract({
        address: UNISWAP.swapRouter02, abi: swapRouterAbi, functionName: "exactInputSingle",
        args: [{
          tokenIn: TGE.wethAddress, tokenOut: nav, fee: NAV_POOL_FEE,
          recipient: w.account, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
        }],
        account: w.account, value: amountIn,
      });
      const hash = await wc.writeContract(request);
      onPhase({ step: "pending", hash });
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
      onPhase({ step: "done", hash });
    }
  } catch (e) {
    onPhase({ step: "error", message: friendlyError(e) });
  }
}

/** Redeem $NAV in kind — fee pinned at the audited 0.5% (reverts if raised). */
export async function sendRedeem(shares: bigint, onPhase: (p: TxPhase) => void): Promise<void> {
  const w = await requireWallet();
  if ("error" in w) return onPhase({ step: "error", message: w.error });
  const wc = walletClient()!;
  try {
    onPhase({ step: "pending" });
    const { request } = await publicClient.simulateContract({
      address: PROTOCOL.vaultAddress!, abi: vaultRedeemAbi, functionName: "redeemInKindGuarded",
      args: [shares, w.account, REDEEM_FEE_PIN_BPS, [], []], account: w.account,
    });
    const hash = await wc.writeContract(request);
    onPhase({ step: "pending", hash });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
    onPhase({ step: "done", hash });
  } catch (e) {
    onPhase({ step: "error", message: friendlyError(e) });
  }
}

/** Crank: FeeSplitter.distribute() — permissionless. */
export async function sendDistribute(onPhase: (p: TxPhase) => void): Promise<void> {
  const w = await requireWallet();
  if ("error" in w) return onPhase({ step: "error", message: w.error });
  const wc = walletClient()!;
  try {
    onPhase({ step: "pending" });
    const { request } = await publicClient.simulateContract({
      address: PROTOCOL.feeSplitterAddress!, abi: splitterAbi, functionName: "distribute",
      account: w.account,
    });
    const hash = await wc.writeContract(request);
    onPhase({ step: "pending", hash });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
    onPhase({ step: "done", hash });
  } catch (e) {
    onPhase({ step: "error", message: friendlyError(e) });
  }
}

/** Crank: AccumulatorV2.accumulate(asset) — permissionless, pays 0.10% keeper reward. */
export async function sendAccumulate(asset: Address, onPhase: (p: TxPhase) => void): Promise<void> {
  const w = await requireWallet();
  if ("error" in w) return onPhase({ step: "error", message: w.error });
  const wc = walletClient()!;
  try {
    onPhase({ step: "pending" });
    const { request } = await publicClient.simulateContract({
      address: PROTOCOL.accumulatorAddress!, abi: accumulatorAbi, functionName: "accumulate",
      args: [asset], account: w.account,
    });
    const hash = await wc.writeContract(request);
    onPhase({ step: "pending", hash });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
    onPhase({ step: "done", hash });
  } catch (e) {
    onPhase({ step: "error", message: friendlyError(e) });
  }
}

/* ---------------------------------------------------------------- reads */

export interface CrankState {
  /** Uncollected LP fees inside the locked position (WETH, NAV) — read via
      eth_call collect() simulated from the timelock (controller-only to move). */
  lpFeesWeth: bigint;
  lpFeesNav: bigint;
  /** USDG sitting in the FeeSplitter, ready for distribute(). */
  splitterUsdg: bigint;
  /** USDG sitting in the Accumulator, ready for accumulate(). */
  accumulatorUsdg: bigint;
}

/** One multiread of the whole crank pipeline. Throws on RPC failure — caller
    keeps the previous state and retries on its own cadence. */
export async function readCrankState(): Promise<CrankState> {
  const [collectSim, splitterUsdg, accumulatorUsdg] = await Promise.all([
    limited(() => publicClient.simulateContract({
      address: NPM_ADDRESS, abi: npmCollectAbi, functionName: "collect",
      args: [{ tokenId: TGE.lpTokenId, recipient: TGE.lpTimelock, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX }],
      account: TGE.lpTimelock,
    })),
    limited(() => publicClient.readContract({
      address: TOKENS.USDG.address, abi: erc20WriteAbi, functionName: "balanceOf",
      args: [PROTOCOL.feeSplitterAddress!],
    })),
    limited(() => publicClient.readContract({
      address: TOKENS.USDG.address, abi: erc20WriteAbi, functionName: "balanceOf",
      args: [PROTOCOL.accumulatorAddress!],
    })),
  ]);
  // pool token0 = WETH, token1 = NAV (TGE.navIsToken0 === false)
  const [amount0, amount1] = collectSim.result as readonly [bigint, bigint];
  return { lpFeesWeth: amount0, lpFeesNav: amount1, splitterUsdg, accumulatorUsdg };
}

/* ------------------------------------------------------- NavCrank (1-tx) */

/** NavCrank — the whole fee pipeline in one permissionless transaction:
    collect LP fees → burn 100% of the NAV side → TWAP-guarded WETH→USDG →
    80/15/5 split → up to 3 rotating stock buys → keeper reward to caller. */
export const NAVCRANK_DEPLOY_BLOCK = 51335020n;

/** F-02 (fork-verified): eth_estimateGas converges on the cheapest successful
    path — the NO-BUY path (~437k) — because crank() requires gasleft() ≥ 600k
    before each buy leg. A tx sent at the raw estimate succeeds but buys
    nothing. We therefore pin an explicit 3M gas limit; unused gas refunds. */
export const CRANK_GAS_LIMIT = 3_000_000n;

const navCrankAbi = [
  { type: "function", name: "crank", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "lastCrankAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "crankCooldown", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cursor", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  /* Field names verified against src/NavCrank.sol (A-22); the old local
     aliases decoded correctly (types/order identical) but diverged from the
     verified source. rotationList() removed — not on-chain (A-21). */
  {
    type: "event", name: "Cranked", inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "wethCollected", type: "uint256", indexed: false },
      { name: "navBurned", type: "uint256", indexed: false },
      { name: "usdgToSplitter", type: "uint256", indexed: false },
      { name: "assetsBought", type: "uint8", indexed: false },
      { name: "rewardPaid", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "TooSoon", inputs: [{ name: "readyAt", type: "uint256" }] },
  { type: "error", name: "NothingToCrank", inputs: [] },
  { type: "error", name: "TwapZero", inputs: [] },
  { type: "error", name: "NoOutput", inputs: [] },
  { type: "error", name: "BadCallback", inputs: [] },
  { type: "error", name: "WethNotInPool", inputs: [] },
  { type: "error", name: "EmptyRotation", inputs: [] },
  { type: "error", name: "BadRotationAsset", inputs: [{ name: "asset", type: "address" }] },
] as const;

/** Send NavCrank.crank() — simulate first, then sign with the pinned 3M gas
    limit (NEVER the estimator's number; see CRANK_GAS_LIMIT note). */
export async function sendCrank(onPhase: (p: TxPhase) => void): Promise<void> {
  const w = await requireWallet();
  if ("error" in w) return onPhase({ step: "error", message: w.error });
  const wc = walletClient()!;
  try {
    onPhase({ step: "pending" });
    const { request } = await publicClient.simulateContract({
      address: PROTOCOL.navCrankAddress!, abi: navCrankAbi, functionName: "crank",
      account: w.account,
    });
    const hash = await wc.writeContract({ ...request, gas: CRANK_GAS_LIMIT });
    onPhase({ step: "pending", hash });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
    onPhase({ step: "done", hash });
  } catch (e) {
    onPhase({ step: "error", message: friendlyError(e) });
  }
}

export interface NavCrankState {
  /** Unix seconds after which crank() may run again (0 = never cranked). */
  readyAt: bigint;
  cooldown: bigint;
}

export async function readNavCrankState(): Promise<NavCrankState> {
  const [lastCrankAt, cooldown] = await Promise.all([
    limited(() => publicClient.readContract({ address: PROTOCOL.navCrankAddress!, abi: navCrankAbi, functionName: "lastCrankAt" })),
    limited(() => publicClient.readContract({ address: PROTOCOL.navCrankAddress!, abi: navCrankAbi, functionName: "crankCooldown" })),
  ]);
  return { readyAt: lastCrankAt === 0n ? 0n : lastCrankAt + cooldown, cooldown };
}

export interface CrankEvent {
  caller: Address;
  wethIn: bigint;
  navBurned: bigint;
  usdgOut: bigint;
  bought: number;
  reward: bigint;
  blockNumber: bigint;
  timestamp: number; // unix seconds
  txHash: Hash;
}

export interface CrankLeader { caller: Address; cranks: number; navBurned: bigint; reward: bigint }

const FEED_CHUNK = 1_000_000n;   // ~28h of blocks per eth_getLogs call
const FEED_MAX_CHUNKS = 8;       // ≈9 days lookback cap

/* Incremental feed cursor (B-10/A-16). The full backscan runs once per app
   load; every later call scans ONLY [lastScanned+1, tip] — normally a single
   tiny getLogs. Events and block timestamps are immutable, so both caches
   are append-only and never invalidated. On any RPC failure the cursor is
   not advanced and the caller keeps the previous result. */
let feedEvents: CrankEvent[] = [];
let feedLastScanned: bigint | null = null;
const feedSeenTx = new Set<string>();
const blockStamp = new Map<bigint, number>();

async function fetchCrankedLogs(fromBlock: bigint, toBlock: bigint) {
  const ranges: { lo: bigint; hi: bigint }[] = [];
  let hi = toBlock;
  for (let i = 0; i < FEED_MAX_CHUNKS && hi >= fromBlock; i++) {
    const lo = hi - FEED_CHUNK + 1n > fromBlock ? hi - FEED_CHUNK + 1n : fromBlock;
    ranges.push({ lo, hi });
    hi = lo - 1n;
  }
  // chunks fire in parallel but stay inside the shared 4-lane limiter (A-16)
  const chunks = await Promise.all(ranges.map((r) =>
    limited(() => publicClient.getContractEvents({
      address: PROTOCOL.navCrankAddress!, abi: navCrankAbi, eventName: "Cranked",
      fromBlock: r.lo, toBlock: r.hi,
    })),
  ));
  return chunks.flat();
}

/** Read the public crank history straight from chain logs — newest first —
    plus a per-wallet leaderboard over the scanned window. No indexer, no
    backend: eth_getLogs in bounded chunks walking back from the tip. */
export async function readCrankFeed(): Promise<{ events: CrankEvent[]; leaders: CrankLeader[] }> {
  const latest = await limited(() => publicClient.getBlockNumber({ cacheTime: 0 }));
  const floor = latest - FEED_CHUNK * BigInt(FEED_MAX_CHUNKS) + 1n;
  const from = feedLastScanned === null
    ? (floor > NAVCRANK_DEPLOY_BLOCK ? floor : NAVCRANK_DEPLOY_BLOCK)
    : feedLastScanned + 1n;
  if (from <= latest) {
    const logs = await fetchCrankedLogs(from, latest);
    // one timestamp fetch per unique NEW block (cranks are ≤48/day — tiny)
    const newBlocks = [...new Set(logs.map((l) => l.blockNumber))].filter((bn) => !blockStamp.has(bn));
    await Promise.all(newBlocks.map((bn) =>
      limited(async () => {
        const b = await publicClient.getBlock({ blockNumber: bn });
        blockStamp.set(bn, Number(b.timestamp));
      }),
    ));
    const fresh: CrankEvent[] = logs
      .filter((l) => !feedSeenTx.has(l.transactionHash))
      .map((l) => ({
        caller: l.args.caller!, wethIn: l.args.wethCollected!, navBurned: l.args.navBurned!,
        usdgOut: l.args.usdgToSplitter!, bought: Number(l.args.assetsBought!), reward: l.args.rewardPaid!,
        blockNumber: l.blockNumber, timestamp: blockStamp.get(l.blockNumber) ?? 0, txHash: l.transactionHash,
      }));
    fresh.forEach((e) => feedSeenTx.add(e.txHash));
    feedEvents = [...fresh, ...feedEvents]
      .sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));
    feedLastScanned = latest;
  }
  const byCaller = new Map<Address, CrankLeader>();
  for (const e of feedEvents) {
    const k = e.caller.toLowerCase() as Address;
    const cur = byCaller.get(k) ?? { caller: e.caller, cranks: 0, navBurned: 0n, reward: 0n };
    cur.cranks += 1; cur.navBurned += e.navBurned; cur.reward += e.reward;
    byCaller.set(k, cur);
  }
  const leaders = [...byCaller.values()].sort((a, b) =>
    b.cranks - a.cranks || (b.navBurned > a.navBurned ? 1 : b.navBurned < a.navBurned ? -1 : 0));
  return { events: feedEvents, leaders };
}
