# Security Assessment — NavOptions

| | |
|---|---|
| Engagement type | Two-pass internal review: A (economic attack surface), B (Solidity correctness), plus fuzz/invariant campaign |
| Scope | `NavOptions.sol` — European covered options, streamia-priced from measured Uniswap v3 fee growth, 100% collateralized writer vaults |
| Deployment | `0xd628eFeC572eE000D4Eb040E675744FEB35F2467`, deployed after all fixes (`7608896a`) |

## 1. Summary

NavOptions prices option premium from observed pool fee income (a streaming-premium model) rather than quoted volatility, caps open interest at 20% of the pool's ±2% band value, and escrows writer capital 1:1 against every open position. The economic pass enumerated nine attack families; the correctness pass covered arithmetic, reentrancy, access control, state machine, share accounting, the snapshot ring and the external-call surface.

One critical, one medium and one low finding were identified and fixed before deployment. The critical finding is documented in full below because it illustrates why volume testing alone is insufficient: it passed all 58 pre-existing unit tests and 9 fuzz properties, and became visible only under a multi-writer sequence.

## 2. Fix log

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| C-1 | Critical | CALL-premium dilution theft via deposit-then-withdraw. A writer depositing after premium accrual but before harvest could dilute earlier writers' pending premium and exit with the difference. Reached only when a second writer arrives after accrual, which no single-writer test could expose | Fixed. X128 reward-per-share accounting with `harvestPremium` and a `pendingPremium` view; the attack sequence is now a permanent regression test |
| M-1 | Medium | No buyer slippage guard on `open()`: quote drift between preview and execution could fill at a worse price than shown | Fixed. `maxCostUsdg` parameter; exceeding it reverts `CostTooHigh()` |
| L-1 | Low | Same-block deposit→withdraw sandwich around accrual events | Fixed. `SameBlock()` guard |
| I-1..I-4 | Informational | Dead intrinsic branches; duplicate-market tolerance; non-transferable positions; settle-price-zero semantics | Documented and accepted |

## 3. Attack families examined without findings

Premium-rate manipulation via pool wash-trading (bounded by the fee the attacker pays: raising the measured rate costs more than the premium gained), snapshot-ring poisoning (not exploitable; ring entries are monotone pool state), oracle manipulation at open and settle (inherits the oracle layer's clamp and band protections), escrow liveness (an oracle outage delays settlement but cannot unlock escrow early), settle-bounty economics, and writer-capital lockup fairness.

## 4. Campaign coverage

| Layer | Volume | Result |
|---|---|---|
| Property fuzz | 9,000,000 executions across 9 fuzz suites | Zero failures |
| Stateful handler | 2,400,000 randomized calls | Zero failures |
| Invariant assertions | 14,400,000 across 6 invariants (solvency, escrow conservation, premium conservation, share parity, OI cap, snapshot monotonicity) | Zero violations |
| Unit suite | 64 unit tests, 5 fork tests against live pool state | Passing |

## 5. Residual risk

Writer capacity is a market condition, not a code property: `open()` reverts with `InsufficientFreeCapital` when a side vault lacks free collateral. The application surfaces per-side free capital ahead of order entry. Premium quality depends on the underlying pool's fee activity; a quiet pool prices low, which is the intended behaviour of the model rather than a defect.
