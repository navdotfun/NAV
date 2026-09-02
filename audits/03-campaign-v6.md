# Security Campaign V6 — Pit Stack Redeploy

| | |
|---|---|
| Engagement type | Full-stack security campaign with mainnet redeployment |
| Trigger | Extended review of settlement accounting after V5 |
| Finding commit | `b7d1609d` (fix) · `40cdd3e5` (frontend hardening) · `68672860` (redeploy) |
| Verification | 22 of 22 deployed contracts exact-match verified on Blockscout |

## 1. Summary

Campaign V6 re-examined the entire Pit derivatives stack under randomized adversarial load and found one accounting defect, V6-01. The defect was fixed, the full stack was redeployed as v3, all 22 contracts in the deployment set were re-verified with exact-match bytecode on Blockscout, and the site and application were repointed in the same change set. The campaign closed with a 380-test regression suite green and all nine invariants holding.

## 2. V6-01 · Medium · Premium/collateral rounding drift

A 1-wei-per-accrual drift between the premium accumulator and the collateral ledger. Individually negligible, but the drift is monotone: under sustained accrual traffic it compounds in one direction rather than averaging out. Classified medium because the divergence is bounded per event and cannot be forced faster by an attacker, yet violates exact-conservation accounting that the solvency invariant depends on.

Resolution: accrual path now rounds against the pool consistently on both ledgers. Conservation is asserted to the wei in `CampaignV6Dust.t.sol`, and the probe harness (`CampaignV6Probes.t.sol`) replays 2.4 million randomized accrual/settlement interleavings without reproducing drift.

## 3. Campaign coverage

| Layer | Result |
|---|---|
| Randomized probes | 2,400,000 executions, zero accounting violations |
| Regression suite | 380 tests passing |
| Invariant harness | 9 of 9 invariants held (800 runs) |
| Deployment verification | 22 of 22 contracts exact-match on Blockscout |
| Frontend | Hardened against the same class: position scan fixed (M-2), FeeSplitter coverage added |

## 4. Disclosure note

The redeploy replaced contract addresses for the Pit stack. Address tables in the protocol documentation and the application were updated in the same commit series; the superseded addresses remain visible on-chain with their full history.
