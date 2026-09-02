# StockSwap — Architecture (P1)

> Status: **DRAFT — contract written, unit + mainnet-fork tested. NOT deployed.**
> Audit programme required before any mainnet deployment.

## What it is

StockSwap is nav.fun's flagship trading venue for tokenized stocks and ETFs on
Robinhood Chain — a best-execution **router/aggregator**, not an AMM. It routes
each order across every live on-chain venue, executes on the best one, and skims
a fixed **20 bps interface fee in USDG straight into the NAV Accumulator**, where
the existing permissionless crank converts it into vault stock holdings.

100% of StockSwap fees feed the NAV vault. No new token. No emissions. No
changes to any live contract.

## Contract: `NavSwapRouter.sol` (`contracts/src/swap/`)

Non-custodial, immutable, ownerless execution contract.

### Route model

Every route passes through USDG (all stock liquidity on Robinhood Chain is
USDG-paired). A swap is at most two single-hop legs:

```
tokenIn ──(legIn: venue)──> USDG ──[20 bps fee → Accumulator]──(legOut: venue)──> tokenOut
```

- `tokenIn == USDG` → legIn skipped (venue = NONE)
- `tokenOut == USDG` → legOut skipped
- stock → stock = two legs, fee at the USDG waypoint
- Fee charged exactly once, always in USDG, always to AccumulatorV2

### Venues (P1)

| ID | Venue | Router used | Pool key (`Leg.param`) |
|----|-------|-------------|------------------------|
| 1 | Uniswap V3 | SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2` | fee tier (500/3000/10000) |
| 2 | up. Slipstream (CL) | `0xC062b870E813fcA720f1e002c234369Ab3aB9415` | tickSpacing |
| 3 | up. v2 (Velodrome v2) | `0xf5198743240fAC98db71868F34c70139b1eb0474` (factory `0xFA5429AEBa338BEa2BFcc1b9a889862Ee395bc28`) | stable flag (0/1) |

All three venue ABIs are **fork-test verified against the live mainnet
contracts** (see `test/swap/NavSwapRouter.fork.t.sol`). Liquidity reality today:
Uniswap V3 carries virtually all stock liquidity; up. stock pools are dust
(≤ ~$31 total across NVDA/TSLA/GOOGL/MSFT/PLTR Slipstream pools) but are quoted
live and picked up automatically as they deepen. Deepstate (order-book DEX,
NVDA/USDG) is a P2/P3 adapter candidate.

### Quoting vs execution

- **Quotes are off-chain** (client `eth_call` to QuoterV2 / up. quoter / v2
  `getAmountsOut`), rendered in the routing-theatre UI.
- **Execution is on-chain** with `minAmountOut` + `deadline` enforced by the
  router; per-leg internal minOut is 0 because the total is checked at the end.
- `RouteExecuted` event records quoteId, venues, amounts, and fee — the
  permanent on-chain execution record. `altVenue`/`altQuote` fields are
  client-reported context (indicative, not consensus-verified) and documented
  as such.

### Security properties

- **Zero custody** — tokens enter and leave in one tx; balance-delta
  measurement; no retained balances (fuzz-verified).
- **No owner, no admin, no upgrade path, no pause switch** — all parameters
  immutable at deploy. FEE_BPS is a compile-time constant (20).
- **Exact transient approvals** — venue router approved for exactly the leg
  amount, revoked to 0 after (test-verified).
- **ReentrancyGuard** on all entrypoints; malicious-token reentrancy test.
- **MinOut mandatory** (`minAmountOut > 0` required) — no unprotected swaps.
- **Leg/venue validation** — legs must match the USDG-side of the trade in all
  four quadrants (tested).
- **Permissionless `sweep`** — stranded USDG → Accumulator, any other token →
  NAV Vault. Stuck funds become protocol property; nothing is recoverable by
  any privileged party (there is none).
- **Permit2 one-signature flow** — canonical Permit2
  (`0x000000000022D473030F116dDEE9F6B43aC78BA3`), fork-tested with a real
  signed PermitTransferFrom.

### Explicitly out of scope for the contract

- On-chain quoting / venue comparison (gas-prohibitive; off-chain by design)
- Split routing across venues (P2)
- Limit orders / DCA (P3 — separate permissionless-keeper contract)
- Native ETH legs (UI wraps to WETH; WETH routes via WETH/USDG pools)

## Test status (as of this commit)

| Suite | Tests | Result |
|-------|-------|--------|
| `test/swap/NavSwapRouter.t.sol` (unit: validation, fee math, approvals, reentrancy, sweep, fuzz) | 22 (incl. 2 fuzz × 256) | ✅ all pass |
| `test/swap/NavSwapRouter.fork.t.sol` (mainnet fork: UniV3 in/out/stock-stock, Slipstream, v2, Permit2, minOut) | 7 | ✅ all pass |
| Full repo regression | 436 | ✅ all pass |

## Pre-deployment gate (NOT yet satisfied)

1. Multi-round audit programme (target: 10 rounds, campaign-profile fuzz/invariant runs in the millions, per protocol standard)
2. Invariant suite (no-residue, fee-exactness, venue-isolation) under `campaign` profile
3. Frontend audit (quote integrity, slippage handling, approval scoping)
4. Deploy → Sourcify/Blockscout verification → docs + changelog update

## Placement

Own subdomain + brand (user decision, 2026-09-01), cross-linked with nav.fun.
Fee: 20 bps (user decision). P1 scope approved.
