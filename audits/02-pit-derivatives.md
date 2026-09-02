# Security Assessment — Pit Derivatives Layer

| | |
|---|---|
| Engagement type | Internal security review with adversarial test campaign |
| Scope | `PitPool.sol`, `PitOracle.sol` / `PitOracleV2.sol`, `PitPricer.sol`, `PitFactory.sol`, `PitTicket.sol`, `PitPoolDeployer.sol` |
| Methods | Line-by-line review, 92-test campaign (unit, attack, stateful fuzz at 4,096 runs, invariants at 256 runs × depth 50 = 12,800 randomized calls), Slither, economic-property verification |
| Fix commit | `9b6b99ce` |

## 1. Summary

The Pit is a cash-settled dated-option venue: buyers purchase calls and puts against pooled writer liquidity, priced from live Uniswap v3 state and settled against an on-chain TWAP oracle. The engagement combined manual review with a 92-test campaign including 16 named attack scenarios. Three defects were identified and fixed before deployment; each fix carries a permanent regression test. No issues remained open at deployment.

## 2. Findings

### P-1 · Medium · Premium accumulator precision loss

The premium-per-share accumulator was scaled by 1e18. With a 6-decimal quote token and an 18-decimal share supply, integer division truncated approximately 0.39% of LP premiums at realistic pool sizes. Value was permanently locked in the pool, not stealable.

Resolution: accumulator rescaled to 1e24 (`ACC_SCALE`). Property test asserts premium distribution error is bounded by 1 wei per accrual event at any share supply in the fuzz domain.

### P-2 · Medium · Settlement clamp freshness cliff

The manipulation clamp compared the settlement TWAP against the last keeper poke, but only when that poke was under 24 hours old (`POKE_FRESHNESS`). Two failure modes followed: a stale poke silently disabled the clamp exactly when protection mattered most, and a keeper could time a poke to influence which reference the clamp used.

Resolution: clamp reference decays continuously with poke age instead of switching off at a threshold. Verified by decay-schedule tests in `PitOracle.t.sol` and the `test_attack_stale_poke_settlement_manipulation` scenario, plus invariant I4 across 12,800 randomized calls including 10-day time jumps.

### P-3 · Low · Frozen-market settlement dependency

Settlement of a frozen market assumed a recent poke. Resolution: frozen markets settle against the last recorded observation at any heartbeat age; scenario `test_frozen_market_settles_with_old_poke` locks the behaviour in.

## 3. Attack scenarios exercised (16)

Oracle manipulation at settlement boundaries, stale-poke settlement manipulation, free-option extraction via same-block sequences, share-supply DoS, donation griefing, multiplier boundary abuse, expiry-boundary races, and settlement-clamp bypass attempts. All scenarios end in the intended revert or in economically neutral outcomes; none extract value from writers or the protocol.

## 4. Invariants (9, held over 12,800 randomized calls)

Solvency (pool balance covers all live claims plus accrued premiums), share-supply conservation, premium-accounting conservation, monotonic accumulator, settlement-price boundedness within clamp envelope, no-negative-positions, ticket-supply parity, oracle-observation monotonicity, and fee conservation. Zero violations.

## 5. Post-deployment note

This layer was subsequently redeployed once (v3) as part of Campaign V6 after a 1-wei-per-accrual rounding drift was found in extended review; see the Campaign V6 report in this index. The V2 findings and regression suite carried forward unchanged.
