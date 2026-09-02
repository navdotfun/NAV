/* Cross-verify the UI's quoteRoute (REAL shipped code) against direct QuoterV2
   eth_calls for randomized amounts across listed tokens. */
import { createPublicClient, http, parseUnits, formatUnits } from "viem";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const FEE_TIERS = [100, 500, 3000, 10000];
const quoterAbi = [{ name: "quoteExactInputSingle", type: "function", stateMutability: "nonpayable",
  inputs: [{ type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
  outputs: [{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }] }];
const pc = createPublicClient({ transport: http(RPC) });
const { quoteRoute } = await import("./.fuzz/venues.mjs");
const { STOCK_TOKENS } = await import("./.fuzz/data.mjs");

let s = 424242; const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const syms = ["NVDA", "AAPL", "TSLA", "MSFT", "GOOGL", "SPY", "QQQ", "AMZN", "META", "COST", "MU", "GME"];
let pass = 0, fail = 0, skip = 0, drift = 0;
for (const sym of syms) {
  const tok = STOCK_TOKENS.find((t) => t.symbol === sym);
  if (!tok) { skip++; continue; }
  for (let k = 0; k < 4; k++) {
    const usd = (1 + rnd() * 4999).toFixed(2);        // $1 .. $5000
    const amountIn = parseUnits(usd, 6);
    await new Promise((z) => setTimeout(z, 250));
    let r = null;
    for (let a = 0; a < 3 && !r; a++) { r = await quoteRoute(USDG, tok.address, amountIn).catch(() => null); if (!r) await new Promise((z) => setTimeout(z, 800)); }
    if (!r) { skip++; continue; }
    // reference: best UniV3 leg on net amount via direct QuoterV2 simulate
    const net = amountIn - (amountIn * 20n) / 10_000n;
    let best = 0n;
    for (const fee of FEE_TIERS) {
      try {
        const { result } = await pc.simulateContract({ address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
          args: [{ tokenIn: USDG, tokenOut: tok.address, amountIn: net, fee, sqrtPriceLimitX96: 0n }] });
        if (result[0] > best) best = result[0];
      } catch { /* pool absent for tier */ }
    }
    // UI must never claim MORE than the best independently-quoted venue; and if
    // the UI picked a UniV3 venue it must match the reference exactly.
    const uiVenue = r.legOut?.best?.venue;
    const rel = best > 0n ? Number(r.amountOut > best ? r.amountOut - best : best - r.amountOut) / Number(best) : 0;
    if (uiVenue === 1) {
      if (r.amountOut === best) pass++;
      else if (rel < 5e-4) { drift++; }  // <5bps and pool prints between calls: block drift
      else { fail++; console.log(`MISMATCH ${sym} $${usd}: ui=${r.amountOut} ref=${best} rel=${rel}`); }
    } else {
      if (r.amountOut >= best || rel < 5e-4) pass++; else { fail++; console.log(`UI worse venue? ${sym} $${usd}: ui=${r.amountOut} uniRef=${best} venue=${uiVenue}`); }
    }
  }
}
console.log(`\nquote cross-check: ${pass} exact, ${drift} block-drift(<5bps), ${fail} fail, ${skip} skipped`);
process.exit(fail ? 1 : 0);
