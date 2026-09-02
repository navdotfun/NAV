# Security Assessment — NavCrank

| | |
|---|---|
| Engagement type | Three independent internal review passes: A (economic attack surface), B (Solidity correctness), C (integration) |
| Scope | `NavCrank.sol` — permissionless buyback, burn, split and accumulation pipeline |
| Fix commit | `c2b72914` · fourth-round fuzz hardening `9420c079` |
| Closing status | All findings fixed or formally accepted. Clear to deploy. |

## 1. Summary

NavCrank is the only contract in the system that moves fee value: it collects NAV/WETH pool fees, burns NAV, routes WETH through the splitter and triggers stock accumulation, callable by anyone after a cooldown. Because it is permissionless and touches a live AMM, the economic pass focused on sandwich extraction, griefing and cooldown abuse. Eleven findings were raised across the three passes; all were fixed or accepted with documented reasoning. Re-verification after fixes ran the full 419-test suite green.

## 2. Fix log

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| B/M-01 | Medium | `renounceOwnership` could strand the timelock forever | Overridden to revert (`RenounceDisabled`); ownership exits only via two-step transfer |
| A-01 | Medium | Unbounded per-crank WETH swap: sandwich margin erodes as backlog grows (break-even ≈ 4.3 WETH) | `maxWethPerCrank`, default 2 WETH, hard cap 20. Every swap stays roughly 10× inside the sandwich-unprofitable region; backlogs drain across successive cranks |
| A-02 | Medium | 3-buy reward ceiling versus whole-pipeline gas | Operational action at go-live: keeper reward raised 10 → 25 bps (cap 50); A-01/A-03 remove the backlog mechanism itself |
| A-03 | Medium | WETH leg reverting the entire crank in volatile markets | Swap leg decoupled via guarded self-call; a floor-tripped swap skips while burns, splits and buys proceed. A caught failure does not count as work |
| A-04, B/L-01 | Low | Callback budget checked per-call, not cumulatively | Budget now depletes across invocations |
| A-05 | Low | Cursor consumed skipped candidates; try/catch gas-griefable | Peek-scan cursor advances only past slots actually tried; 600k `gasleft()` floor before each accumulate; `MAX_BUY_ATTEMPTS` 6 → 4 |
| A-06 | Low | 1-wei NAV donation armed the 30-minute cooldown | Dust below `MIN_NAV_WORK` (1 NAV) burns but no longer counts as work |
| B/L-02 | Low | Unbounded rotation length | `MAX_ROTATION = 64` enforced in `_setRotation` |
| B/L-03 | Low | Owner could park the fee stream via `minWethSwap = ∞` plus rescue | Hard parameter bounds: `minWethSwap ≤ 1 WETH`, `minAccumulate ≤ 1000 USDG`, `maxWethPerCrank ∈ [minWethSwap, 20 WETH]` |
| B/L-04 | Low | TWAP floor is fee-blind; a 1% fee tier would brick swaps | Deploy-checklist assertions moved into the fork suite: pool fee tier = 500, canonical factory pool, observation cardinality ≥ 200; large-backlog stress test added |
| F-01 | Informational | USDG-only donations do not count as "work", so a crank with nothing else pending reverts and the donation waits on the router | Correct as designed. Counting donations as work would let a 1-wei donor arm the cooldown (A-06 generalized). A test proves the next real crank sweeps 100% of the waiting donation to that keeper |

## 3. Fuzz and invariant coverage

Fourth-round hardening added a property fuzz suite and stateful invariant harness: 1,050,000 fuzz executions and 190,800 adversarial call sequences with zero failures (cumulative 1.24M randomized cases across rounds). Properties include: no value extraction by call-ordering, cooldown cannot be armed without real work, keeper reward bounded, and pipeline conservation from pool fees to splitter outputs.

Sandwich and TWAP-manipulation margins were re-quantified after fixes: at the capped swap size, sandwiching remains at least 10× unprofitable, and TWAP displacement roughly 1000×. The margin is a property of the code (size cap), not of current volumes.
