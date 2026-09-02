# NAV Arena + Index — Verification Campaign (final)

**Scope:** NavArena.sol · NavIndexToken.sol · NavIndexFactory.sol · NavIndexZap.sol
**Source:** frozen working tree at internal commit `8fced93b` (all audit fixes applied)
**Date:** 2026-09-02 · **Result: PASS — 0 violations across ~137.2M executed checks**

Executed after four independent internal review tracks (Arena A economic / Arena B
correctness / Index A economic / Index B correctness) and two fix-verification
passes, both of which returned **DEPLOY-READY: YES**.

## Campaign layers

| Layer | Volume | Result |
| --- | --- | --- |
| Differential bigint harness — Arena (exact mirror of settle/claim payout math: fee/bounty carve-out, pro-rata floor division, void/draw/one-sided refund paths; conservation, dust bound < winners+1, winner-never-loses, loser-zero, monotonicity, double-claim idempotence checked every sweep) | **69,546,509 checks** (3.2M sweeps, seeds 1337 + 777001) | 0 violations |
| Differential bigint harness — Index (stateful walks: issue ceil-math with pro-rata top-up, redeem floor payouts, skip-redeem forfeiture, streaming accrual, 90/10 fee minting; supply accounting, per-leg solvency, backing-per-share accretion, no-negative-state, no-free-value checked every op) | **64,788,561 checks** (160k walks, seeds 1337 + 777001) | 0 violations |
| Foundry fuzz — 12 properties × 100,000 runs (campaign profile, max rejects 20M) | **1,200,000 executions** | all pass |
| Foundry invariants — 7 invariant properties, 800 runs × 300-call depth per suite | **480,000 randomized calls / ~1.68M assertions** | all pass (0 arena reverts; 3,372 index reverts all expected-guard) |
| Unit + regression suites (incl. audit PoCs inverted to regressions) | Arena 69 · Index 76 · repo 733 passing | all pass |

**Total executed checks: ~137.2M.**

## Foundry campaign detail

Arena (`ARENA_EXIT=0`, 1,821s): `testFuzz_create_windowBounds`,
`testFuzz_settle_draw_voids`, `testFuzz_settlement_conservation`,
`testFuzz_stake_accounting`, `testFuzz_void_refunds_exact` — each 100,000 runs;
`NavArenaInvariantTest` 800×300 (conservation, solvency, state machine, fees-only-grow).

Index (`INDEX_EXIT=0`, 828s): `testFuzz_zap_neverRetainsBalances`,
`testFuzz_factory_realityGate`, `testFuzz_issue_arithmetic`,
`testFuzz_redeem_arithmetic`, `testFuzz_roundTrip_neverProfits`,
`testFuzz_streaming_bounded`, `testFuzz_supplyAccounting` — each 100,000 runs;
`NavIndexInvariantTest` 800×300 (full-redemption solvency, backing covers user
supply, config frozen).

## Fixed findings verified under campaign load

- **Arena F-1/F-2** (settle conservation; void zero-fee) — regression + 100k-run fuzz + differential conservation on every sweep.
- **Arena N-1** (Chainlink-bracket-first anchor verification) — PoC-4/5/6 regressions; fail-closed refund confirmed.
- **Index M-01** (bounded zap quote widening, exact minOut) — zap sweep invariant, 100k runs.
- **Index M-02** (`_skippedBalance` bounded 50k staticcall, memory-safe) — opcode-level review + 7 probes + skip-forfeiture differential checks.

## Residual risk (documented, accepted)

PitOracleV2 owner can repoint feeds; Arena pins config hashes and verifies
consumed prints against the pinned source (CL-bracket-first), converting any
tamper into refunds — except the documented no-fresh-bracket window. Standing
recommendation: timelock or renounce PitOracleV2 ownership.

Harness sources ship in the repository at `contracts/campaign/diff_arena.py` and
`contracts/campaign/diff_index.py`; logs preserved with seeds for exact replay.
