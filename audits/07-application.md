# Assessment — FLOOR Application (Frontend)

| | |
|---|---|
| Engagement type | Recurring application review; three completed rounds plus targeted sweeps |
| Scope | `floor/` — React 18 terminal application: data layer, transaction construction, error decoding, wallet integration |
| Round commits | R2 `9c09f1c5` · R3 `0783441f` · wallet M-11 `9d06c5e7` · error-decoding sweep `f77ab839` |

## 1. Approach

The application is reviewed as part of the trust surface, not an afterthought: a UI that mis-renders chain state or mis-constructs calldata can lose user funds with perfectly sound contracts. Each round combines static review of every read and write path with high-volume randomized checks against recorded chain state, and closes with live verification against mainnet.

## 2. Round summary

| Round | Focus | Volume | Outcome |
|---|---|---|---|
| R2 | Data-layer correctness: every displayed number traced to a contract read or compile-time constant | 42.3M checks | Pass; placeholder and synthetic-value rendering prohibited by convention (loading "…", error "—") |
| R3 | Resilience: stale-while-revalidate data layer, nullable reads, RPC failover through same-origin relay, render isolation, keyboard shortcuts | Full-surface re-audit | Shipped `0783441f` |
| M-11 | Mobile in-app wallet connect dead-end | Targeted | Fixed `9d06c5e7` |
| O-ERR | Error-decoding sweep after a field report of an undecodable revert | All five transaction modules | Findings below, fixed `f77ab839` |

## 3. O-ERR sweep findings

A user-reported revert ("reverted with no signature") exposed a systemic gap: ABIs used for transaction construction omitted custom error definitions, so no revert from those contracts could be decoded into a readable message.

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| O-ERR-1 | High (UX-safety) | Options ABI carried zero of the contract's 17 custom errors; four oracle errors that bubble through pricing were also absent | All 21 errors added; decoder rewritten around typed revert data with per-error trader guidance |
| O-ERR-2 | Medium | Error translator matched on message strings, referencing two error names that do not exist in the deployed contract | Replaced with typed decoding; string matching removed |
| O-ERR-3 | Medium | No writer-capacity awareness at order entry: quotes rendered for sizes that could never clear, failing only at execution | Per-side free capital read (`vaultInfo`) shown in the ticket; order button gates on capacity before signature |
| O-ERR-4 | Low | Pit ABI missing 3 of 21 errors; swap router, vault redeem, accumulator, splitter and crank ABIs missing all error entries | Every ABI reconciled against verified source; message maps extended |

## 4. Standing conventions

Numbers render only from live contract reads or compile-time constants. Loading state is "…", error state is "—"; fabricated or estimated values are prohibited. Addresses are imported from the deployment manifest, never hand-typed. Every round's findings become permanent conventions checked in subsequent rounds.
