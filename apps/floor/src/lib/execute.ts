/* Execution — builds SwapParams from the live RouteQuote and drives the
   approve → simulate → swap flow through NavSwapRouter.

   Safety rails (mirror the audited contract's own invariants):
   - exact approval only (amountIn, never unlimited);
   - simulateContract before every send — a route that would revert never
     reaches the wallet;
   - minAmountOut derived from the ON-SCREEN quote and the selected
     slippage — what you see is what is enforced on-chain;
   - deadline 10 minutes;
   - stale quotes (>45 s) are refused. */
import type { Address, Hex } from "viem";
import { FLOOR_ROUTER, TOKENS, erc20Abi, publicClient, robinhoodChain } from "./chain";
import type { RouteQuote } from "./venues";
import { walletClient, ensureChain } from "./wallet";

export const navSwapRouterAbi = [
  /* custom errors — required so viem can decode simulation reverts by name */
  { type: "error", name: "DeadlineExpired", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "IdenticalTokens", inputs: [] },
  { type: "error", name: "MinOutNotSet", inputs: [] },
  { type: "error", name: "LegVenueMismatch", inputs: [] },
  { type: "error", name: "UnknownVenue", inputs: [] },
  { type: "error", name: "InsufficientOutput", inputs: [{ name: "amountOut", type: "uint256" }, { name: "minAmountOut", type: "uint256" }] },
  {
    type: "function", name: "swapExactIn", stateMutability: "nonpayable",
    inputs: [{
      name: "p", type: "tuple", components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "minAmountOut", type: "uint256" },
        { name: "legIn", type: "tuple", components: [{ name: "venue", type: "uint8" }, { name: "param", type: "int24" }] },
        { name: "legOut", type: "tuple", components: [{ name: "venue", type: "uint8" }, { name: "param", type: "int24" }] },
        { name: "recipient", type: "address" },
        { name: "deadline", type: "uint256" },
        { name: "quoteId", type: "bytes32" },
        { name: "altVenue", type: "uint8" },
        { name: "altQuote", type: "uint256" },
      ],
    }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export type ExecPhase =
  | { k: "idle" }
  | { k: "approving"; hash?: Hex }
  | { k: "swapping"; hash?: Hex }
  | { k: "filled"; hash: Hex; amountOut: bigint }
  | { k: "error"; message: string };

const QUOTE_MAX_AGE_MS = 45_000;

function rndQuoteId(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
}

/** Second-best venue across both legs, for the RouteExecuted transparency event. */
function altOf(q: RouteQuote): { altVenue: number; altQuote: bigint } {
  const book = q.legOut ?? q.legIn;
  const second = book?.quotes?.[1];
  return second ? { altVenue: second.venue, altQuote: second.amountOut } : { altVenue: 0, altQuote: 0n };
}

export async function executeSwap(opts: {
  quote: RouteQuote;
  account: Address;
  slippageBps: number;
  onPhase: (p: ExecPhase) => void;
}): Promise<void> {
  const { quote, account, slippageBps, onPhase } = opts;
  try {
    if (!FLOOR_ROUTER) throw new Error("router not configured");
    if (Date.now() - quote.quotedAt > QUOTE_MAX_AGE_MS) throw new Error("quote stale — repriced, try again");
    const wc = walletClient();
    if (!wc) throw new Error("wallet not connected");
    if (!(await ensureChain())) throw new Error("switch wallet to Robinhood Chain");

    const minAmountOut = quote.amountOut - (quote.amountOut * BigInt(slippageBps)) / 10_000n;
    if (minAmountOut <= 0n) throw new Error("quote too small");

    // ---- exact allowance ----
    const allowance = (await publicClient.readContract({
      address: quote.tokenIn, abi: erc20Abi, functionName: "allowance", args: [account, FLOOR_ROUTER],
    })) as bigint;
    if (allowance < quote.amountIn) {
      onPhase({ k: "approving" });
      const { request } = await publicClient.simulateContract({
        address: quote.tokenIn, abi: erc20Abi, functionName: "approve",
        args: [FLOOR_ROUTER, quote.amountIn], account, chain: robinhoodChain,
      });
      const hash = await wc.writeContract(request);
      onPhase({ k: "approving", hash });
      const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rc.status !== "success") throw new Error("approval reverted");
    }

    // ---- swap: simulate, then send ----
    onPhase({ k: "swapping" });
    const p = {
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      amountIn: quote.amountIn,
      minAmountOut,
      legIn: quote.legIn?.best
        ? { venue: quote.legIn.best.venue, param: quote.legIn.best.param }
        : { venue: 0, param: 0 },
      legOut: quote.legOut?.best
        ? { venue: quote.legOut.best.venue, param: quote.legOut.best.param }
        : { venue: 0, param: 0 },
      recipient: account,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      quoteId: rndQuoteId(),
      ...(() => { const a = altOf(quote); return { altVenue: a.altVenue, altQuote: a.altQuote }; })(),
    } as const;
    const { request, result } = await publicClient.simulateContract({
      address: FLOOR_ROUTER, abi: navSwapRouterAbi, functionName: "swapExactIn",
      args: [p], account, chain: robinhoodChain,
    });
    const hash = await wc.writeContract(request);
    onPhase({ k: "swapping", hash });
    const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success") throw new Error("swap reverted on-chain");
    onPhase({ k: "filled", hash, amountOut: result as bigint });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const message = /user rejected|denied/i.test(raw) ? "rejected in wallet"
      : /InsufficientOutput/i.test(raw) ? "price moved beyond slippage — requote"
      : /DeadlineExpired/i.test(raw) ? "deadline expired — try again"
      : /insufficient funds/i.test(raw) ? "insufficient ETH for gas"
      : /stale/.test(raw) ? raw
      : raw.split("\n")[0].slice(0, 90);
    onPhase({ k: "error", message });
  }
}

/** USDG needed for gas-side sanity display (unused for now, kept for parity). */
export const USDG = TOKENS.USDG.address;
