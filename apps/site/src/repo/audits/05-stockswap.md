# Assessment — StockSwap Router and Execution Path

| | |
|---|---|
| Engagement type | Contract review plus full-stack execution campaign |
| Scope | `NavSwapRouter.sol`; application execution path (`execute.ts`, venue selection, quote pipeline) |
| Campaign commits | `cab91ac0` (campaign), `0c1e4ac9` (deployment and live QA) |

## 1. Summary

The router executes stock purchases and sales across two venues with on-chain quote enforcement. Because the contract is small and the risk concentrates at the boundary between quoted and executed prices, the campaign weighted volume testing over manual review: 10.1 million randomized contract executions and 33 million frontend fuzz cases were run against the quote/execution pair, cross-checking that every executed amount respects the quoted minimum.

No solvency or fund-safety findings were raised. One accessibility defect was identified and fixed.

## 2. Coverage

| Layer | Volume | Result |
|---|---|---|
| Contract execution fuzz | 10,100,000 randomized executions | Zero quote violations, zero stuck-fund states |
| Frontend input fuzz | 33,000,000 cases across amount parsers, decimal handling, venue selection | Zero crashes, zero mis-priced submissions |
| Quote cross-check | Independent re-derivation of each quote against pool state | Exact match |
| Invariants | 3 stateful invariants (balance conservation, allowance hygiene, no-residue on router) | Held |
| Accessibility | axe-core sweep of the swap surface | 0 violations after fix |
| Live verification | Both directions executed on mainnet post-deploy with receipts in the changelog | Confirmed |

## 3. Findings

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| A11Y-1 | Low (accessibility) | Amber-dim text on black failed WCAG contrast on secondary labels | Contrast raised; axe-core re-run reports 0 violations |

## 4. Notes

Deadline and minimum-output parameters are enforced in the contract (`DeadlineExpired`, `InsufficientOutput`), not merely in the interface. The router holds no balances between transactions; the no-residue invariant is asserted after every fuzz sequence.
