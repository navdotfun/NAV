# NAV Options — Internal Security Review R4-A: `NavOptions.sol`

**Review type:** Internal security review (external-firm conventions)
**Round:** R4-A (contract track)
**Date:** 2 September 2026
**Target:** `contracts/src/options/NavOptions.sol` (711 lines, commit `be4854d1`)
**Deployment:** `0xd628eFeC572eE000D4Eb040E675744FEB35F2467` — Robinhood Chain (id 4663), **LIVE + IMMUTABLE** (no owner, no setters, no upgrade path)
**Status:** Report only. No files were modified. Because the contract cannot be changed, every finding closes with a concrete mitigation path: frontend gate, docs disclosure, monitoring, or accept-with-rationale.

---

## 1. Scope

| Item | Detail |
|---|---|
| In scope | `contracts/src/options/NavOptions.sol`, full 711 lines, line-by-line |
| Cross-referenced (read-only) | `contracts/src/pit/PitOracleV2.sol` (settlement/quote semantics), `contracts/test/options/*` (coverage mapping), `floor/src/lib/options.ts` (maxCost usage) |
| Live verification | Read-only `cast call` against `0xd628…2467` and its four markets/pools via `https://rpc.mainnet.chain.robinhood.com` (no transactions sent) |
| Out of scope | PitOracleV2 internals (separate track), Uniswap V3 pool implementation, USDG/tokenized-equity token contracts, Accumulator, floor app code review |

Focus areas per the R4 brief: premium/settlement math and X128 accumulator accounting; 6-dec USDG vs 18-dec underlying conversions and rounding direction; OI caps vs the ±2% band read; TWAP/spot manipulation surface; collateral/free-capital accounting across buy/exercise/expiry/withdraw; expiry boundaries; reentrancy/CEI; access control; zero-liquidity markets; griefing/DoS; fee routing; token-transfer assumptions.

## 2. Methodology

1. **Full manual read** of all 711 lines (every function, every arithmetic operation, every rounding mode).
2. **Arithmetic verification** of unit conversions (`STOCK_TO_USDG = 1e30`), X128 accumulator flows, escrow/payout bounds, and overflow reachability under `uint128` field limits.
3. **Adversarial modelling**: sandwich/JIT/wash-trade scenarios against the pool-derived rate and depth gates; share-inflation and donation attacks; reentrancy via token/oracle callbacks; settlement griefing.
4. **Live invariant checks** (read-only `cast`): market table, vault ledgers vs ERC-20 balances, OI, the single historical position, live rate/depth/preview quotes.
5. **Test-suite mapping**: `NavOptions.unit.t.sol` (64 tests), `NavOptions.fuzz.t.sol` (9), `NavOptions.invariant.t.sol` (6 invariants over a 7-action stateful handler), `NavOptions.fork.t.sol` (5), against the risk list.

## 3. System summary (as audited)

Covered, prepaid, European, oracle-settled options. Writers deposit stock (CALL vault, side 0) or USDG (PUT vault, side 1) into per-market share-accounted vaults (virtual shares 1000:1). Buyers pay a premium priced from the underlying Uniswap V3 pool's own fee-growth accumulators ("streamia") sampled through a 24-slot snapshot ring, clamped to [8, 300] bps/day, ×1.25 spread, plus a 20 bps origination fee. Maximum payout is fully escrowed at open (stock for calls, ceil(strike-value) USDG for puts). Settlement is permissionless, priced by PitOracleV2's expiry-anchored snapshot, with a 5 bps bounty (cap 25 USDG-equivalent) paid to the settler out of released escrow. There are **no privileged functions whatsoever** — access control review reduces to confirming that this is true (it is; verified §6.8).

## 4. Findings summary

| ID | Severity | Title | Mitigation path |
|---|---|---|---|
| M-01 | Medium | Measured premium rate inflatable by wash-trading through own in-range LP; ring-flush shortens the measurement window | Monitoring + frontend gate |
| M-02 | Medium | `settle()` reverts forever if the payout recipient is frozen/blocklisted by the token issuer — escrow and writer capital permanently locked | Docs disclosure + monitoring |
| L-01 | Low | JIT liquidity bypasses both the `minLiquidity` gate and the 20 % depth cap (spot reads) | Monitoring + accept |
| L-02 | Low | Premium sniping: deposit immediately before an `open`, withdraw next block; `SameBlock` guard only spans one block | Accept-with-rationale + docs |
| L-03 | Low | Snapshot ring goes stale after 48 h of inactivity → silent floor-rate (8 bps/day) pricing; no permissionless poke function; `settle`/`harvestPremium` never snap | Ops keeper (dust poke) + monitoring |
| I-01 | Info | Intrinsic-value branch (lines 697–708) is unreachable dead code given the bucket definitions | Accept |
| I-02 | Info | `settle()` calls the state-changing oracle before setting `p.settled` (CEI deviation, trusted callee, guarded) | Accept |
| I-03 | Info | Accumulator floor-rounding strands dust USDG in `premiumUsdg` forever | Accept |
| I-04 | Info | `withdraw` is all-or-nothing against free capital (reverts rather than partial-fills) | Frontend gate (already shipped, f77ab839) |
| I-05 | Info | `maxCostUsdg = 0` disables the cost guard; strike/expiry drift is never guarded | Frontend gate (already correct) + docs for integrators |
| I-06 | Info | `settleP == 0` would divide-by-zero in the CALL bounty cap (line 447); unreachable given PitOracleV2 guarantees — hard oracle coupling should be documented | Docs disclosure |

**Totals: 0 Critical · 0 High · 2 Medium · 3 Low · 6 Informational.**

---

## 5. Detailed findings

### M-01 — Premium rate inflatable via wash-trading through own in-range liquidity; ring-flush shortens the measurement window

**Location:** `NavOptions.sol:582–615` (`_dailyRate`, `_feeUsdgSinceRef`), `:552–578` (`_maybeSnap`, `_refSnap`), `:688–693` (rate → premium).

```solidity
// L608–614
d0 = pool.feeGrowthGlobal0X128() - ref.fg0;
d1 = pool.feeGrowthGlobal1X128() - ref.fg1;
...
feeUsdg = Math.mulDiv(d0 + Math.mulDiv(d1, s, STOCK_TO_USDG), liq, Q128);
// L591
return Math.mulDiv(feeUsdg, WAD * 86_400, vUsdg * dt);
```

**Analysis.** The rate design is notably resistant to *liquidity* manipulation: both `feeUsdg` (fee-growth delta × current `liq`) and the denominator `vUsdg` (`_bandValueUsdg(liq, …)`) are linear in current in-range liquidity, so adding or removing liquidity cancels out of the ratio — an attacker **cannot cheapen premiums below what history dictates**, and the 8 bps/day floor backstops it. Verified by inspection of both legs.

What remains manipulable is the numerator's fee-growth delta `d0/d1`, which only ever *increases*. An attacker who is the dominant in-range LP can wash-trade the pool: the fees they pay accrue mostly back to their own liquidity position, while `feeGrowthGlobalX128` rises. The measured rate then climbs toward the cap, and every subsequent buyer pays up to `CAP_RATE_X18` (300 bps/day) × 1.25 = **3.75 %/day** of notional instead of the organic rate (live rate measured today: 42.7 bps/day, so ~9× headroom). If the attacker is also the dominant option writer, they receive 96 % of the inflated premium (4 % protocol cut, L387–391).

The attack is amplified by **ring flushing**: `_maybeSnap` (L552–562) accepts a new snapshot every 20 minutes from *any* mutating call — including 1-wei `deposit`s. 24 slots × 20 min = 8 h to overwrite the whole ring, after which the oldest valid reference (`_refSnap`, picks max age in [4 h, 48 h]) is only ~4–8 h old instead of up to 48 h. A shorter `dt` means less wash volume is needed for the same rate (rate ∝ fees/dt).

**Impact / worst case.** Buyers systematically overpay premium, bounded at 3.75 %/day of notional × term (≤ 26.25 % of notional for the 7-day term, ×0.55/0.30 OTM factors). No writer/vault funds at risk; this is buyer-side value extraction. The inflated rate is *visible* in the quote the buyer confirms, and `maxCostUsdg` pins execution to the displayed quote — so the harm is "quote itself is inflated," not "execution deviates from quote."

**Exploitability.** Requires meaningful capital (dominant in-range LP position in the canonical pool), sustained wash volume over ≥4 h, and leaks the non-self LP share plus the pool's protocol-fee cut per wash trade. Economical only when third-party option flow is large relative to leaked fees. Medium likelihood at scale, bounded impact ⇒ **Medium**.

**PoC reasoning.** (1) Become ≥80 % of in-range liquidity in the NVDA/USDG pool. (2) Poke `deposit(0, 0, 1)` every 20 min for 8 h to flush the ring. (3) Wash-trade until `dailyRateX18(0)` ≥ 3e16 (verifiable via the public view). (4) All ATM 1-day quotes now price at 3.75 % of notional vs 0.53 % organic (~7× premium). Each step uses only public entry points; step 3's cost is `(1 − selfLPshare) × poolFee × washVolume`.

**Mitigation path (immutable contract):**
- **Monitoring:** alert when `dailyRateX18(m)` exceeds a sanity threshold (e.g. > 150 bps/day) or jumps > 3× within 8 h; alert on high-frequency `Snapped` events from dust deposits (ring-flush signature).
- **Frontend gate:** display the live measured rate next to each quote and interstitially warn buyers when the rate is at/near cap ("premium is currently X× the 30-day median").
- **Docs disclosure:** state that premium pricing is pool-fee-derived and cap-bounded, and that the cap (not the measurement) is the trust anchor.

---

### M-02 — Frozen/blocklisted payout recipient permanently locks escrow and writer capital

**Location:** `NavOptions.sol:466–467` (settle interactions), `:432` (`p.settled` flag), `:461–463` (escrow release).

```solidity
// L466–467
if (payout > 0) IERC20(payoutAsset).safeTransfer(p.owner, payout);
if (bounty > 0) IERC20(payoutAsset).safeTransfer(msg.sender, bounty);
```

**Analysis.** `settle()` is the *only* path that releases a position's escrow back to the vault (`v.escrowed -= p.escrow`, L461). The payout push to `p.owner` is unconditional whenever the option finishes in the money. Both payout assets are issuer-controlled, regulated tokens: USDG is a regulated stablecoin and the underlyings are tokenized equities — both token classes carry freeze/blocklist/pause capability at the issuer level. If `p.owner` is frozen for the payout asset at settlement time, `safeTransfer` reverts, the whole `settle()` reverts (`p.settled` never persists), and **no alternative path exists**: no skip, no claim-later escrow, no owner override (the contract has none by design). The position's escrow stays counted in `v.escrowed` forever, so the corresponding slice of *writer* capital is permanently unwithdrawable (`withdraw` L313 checks against `assets − escrowed`). A global issuer pause of USDG or a stock token likewise halts all settles/withdrawals in that asset for the duration.

Out-of-the-money positions are unaffected (payout = 0 skips the owner transfer; only the settler bounty moves, and the settler can be any unfrozen address).

**Impact / worst case.** Permanent lock of writer capital equal to the ITM position's escrow (full `size` in stock for calls; up to `ceil(size × strike / 1e30)` USDG for puts). The buyer's payout is equally stranded, but the buyer is the frozen party; the writers are innocent third parties.

**Exploitability.** Not attacker-triggerable at will — requires an issuer compliance action against a specific buyer between open and settle. Low likelihood, high and irreversible impact ⇒ **Medium**.

**PoC reasoning.** Buyer opens a 7-day ITM-finishing put; issuer freezes the buyer's USDG address on day 3 (sanction/compliance event); at expiry every `settle(id)` call reverts inside USDG's transfer hook; `vaultInfo` shows `escrowed` permanently ≥ that escrow; writers' `withdraw` for that slice reverts `InsufficientFreeCapital` forever.

**Mitigation path (immutable contract):**
- **Docs disclosure:** state plainly that a buyer frozen by the USDG/stock issuer permanently strands that position's escrow, and that writers bear this issuer-action risk pro-rata.
- **Monitoring:** watch for `settle` transactions reverting with token-level errors on expired positions; alert ops. If the issuer supports unfreezing or address remediation, ops can pursue the off-chain path — the contract call becomes viable again the moment the freeze lifts (nothing in `NavOptions` itself is bricked; the revert is external and retryable).
- **Frontend gate (partial):** warn buyers opening from smart-contract wallets that payouts are push-only.

---

### L-01 — JIT liquidity bypasses the `minLiquidity` gate and the 20 % depth cap

**Location:** `NavOptions.sol:669–679`.

```solidity
q.liq = pool.liquidity();
if (q.liq < m.minLiquidity) revert DepthLow();
(q.sqrtP,,,,,,) = pool.slot0();
...
q.depth = _bandValueUsdg(m, q.liq, q.sqrtP, q.s);
if (uint256(oiNotional[marketId]) + out.notional > (q.depth * DEPTH_CAP_BPS) / BPS) revert DepthCapExceeded();
```

**Analysis.** Both gates read the pool's *instantaneous* in-range liquidity and spot `sqrtPriceX96`. An actor can mint a wide in-range V3 position, pass both gates in the same block (opening arbitrarily large OI relative to *organic* depth), then burn the position. Note the important asymmetry with M-01: while liquidity cancels out of the *rate*, it does **not** cancel out of the *depth cap* — depth is linear in `liq` with no offsetting term. The valuation price for the stock leg is the oracle quote `s` (L631), and the oracle (`quotePrice`) is TWAP + Chainlink/Pyth-banded, so price-axis manipulation of the depth number is tightly bounded; the liquidity axis is unbounded.

**Impact / worst case.** The 20 % OI/depth policy limit is advisory-only against a motivated actor. Solvency is *never* at risk — every payout is 100 % escrowed at open and settlement prices come from PitOracleV2 (Chainlink-round-at-expiry primary), not from the pool, so oversized OI cannot be cashed out via pool manipulation. The residual harm is that writers' aggregate exposure can exceed the calibrated relationship to real market depth, degrading their hedging assumptions. Binding constraint in practice is writer free capital (live: cap ≈ $550k vs ~$3 of call-side capital — the cap is currently ~5 orders of magnitude from binding).

**Mitigation path:** **Accept-with-rationale** (solvency is escrow-enforced; the cap is a soft risk rail) + **monitoring**: track `oiNotional(m)` against a time-averaged, indexer-computed band depth and alert on divergence; flag single-block liquidity spikes in market pools coinciding with `Opened` events.

---

### L-02 — Premium sniping: deposit immediately before an `open`, withdraw one block later

**Location:** `NavOptions.sol:158–159, 282, 309` (SameBlock guard), `:388–394` (premium credit).

```solidity
// L309
if (block.number <= _lastDepositBlock[marketId][side][msg.sender]) revert SameBlock();
// L391 (CALL)  — credited pro-rata to shares existing at open time
accPremiumPerShareX128[marketId] += ((qt.premium - protocolCut) << 128) / v.totalShares;
// L393 (PUT)   — folded into assets, i.e. into the instantaneous share price
v.assets = _u128(uint256(v.assets) + (qt.premium - protocolCut));
```

**Analysis.** The accumulator correctly prevents *retroactive* premium theft (a depositor after the open earns nothing — the C-1 fix; re-verified line-by-line, and covered by `test_premium_lateDepositorEarnsNothing`). It cannot prevent *prospective* capture: a depositor whose deposit lands in the same block as (but before) a large `open` holds shares at credit time and receives the pro-rata premium (CALL via acc, PUT via share-price bump), then exits at `block.number + 1`. The `SameBlock` guard imposes exactly one block of capital risk (during which the capital may become escrowed by another open, forcing a longer stay).

**Impact / worst case.** Dilution of a single open's premium away from incumbent writers, proportional to the sniper's instantaneous share. No principal at risk for anyone; premium magnitudes are small (≤ 3.75 %/day of notional). Robinhood Chain runs a centralized sequencer without a public mempool, so classic front-running requires off-chain signal (e.g. observing UI-driven quote patterns), further reducing likelihood ⇒ **Low**.

**Mitigation path:** **Accept-with-rationale** (documented residual of block-granularity share accounting; a time-lock on withdrawals was evidently traded off for writer UX) + **docs disclosure** in writer-facing docs + **monitoring** for the deposit→open→withdraw pattern within ≤2 blocks to confirm the assumption holds on this sequencer.

---

### L-03 — Stale snapshot ring silently reprices premium at the floor; no permissionless snap; `settle`/`harvestPremium` never snap

**Location:** `NavOptions.sol:107–110` (window constants), `:552–562` (`_maybeSnap` — called from `deposit` L273, `withdraw` L307, `open` L374 only), `:565–578` (`_refSnap`), `:688–689` (floor fallback).

```solidity
// L688–689
q.rate = _dailyRate(marketId, m, q.s, q.liq, q.sqrtP);
if (q.rate < FLOOR_RATE_X18) q.rate = FLOOR_RATE_X18;
```

**Analysis.** If no `deposit`/`withdraw`/`open` occurs for 48 h on a market, every ring entry ages out of `[SNAP_MIN_AGE, SNAP_MAX_AGE]`, `_refSnap` returns `ok = false`, `_dailyRate` returns 0, and pricing falls to the 8 bps/day floor **silently** — the first buyer after a quiet weekend prices a potentially volatile underlying at the minimum, underpaying writers by up to 37.5× vs cap. This is the *live steady state* for markets m1–m3 (zero writer capital ⇒ no organic traffic) and a realistic weekend state for m0. There is no dedicated permissionless `snap()`/`poke()` function; the cheapest maintenance call is a 1-wei `deposit`. `settle()` and `harvestPremium()` mutate state but do not snap — a market with only settlement traffic still goes stale.

Note the first `open` after staleness *itself* snaps (L374) but prices *before* any usable reference can exist (a fresh snap is 0 s old, below `SNAP_MIN_AGE`), so the first ~4 h of post-idle opens are all floor-priced. Verified behaviour in `test_snap_staleRingGivesZeroRate`.

**Impact.** Writer premium under-collection (no solvency impact; escrow model unaffected). Buyers get cheap options after idle periods — mildly adverse selection against writers.

**Mitigation path:** **Ops keeper**: schedule a dust `deposit(marketId, 0, 1)` (or any 1-wei side) roughly every 12 h per active market to keep a 4–48 h reference alive; cost is negligible. **Monitoring:** alert when `dailyRateX18(m) == 0` while the market has non-zero writer capital. **Docs disclosure** for writers: floor-rate pricing applies after ≥48 h of protocol inactivity. (Live check 2 Sep 2026: m0 rate = 42.7 bps/day — ring currently healthy.)

---

### I-01 — Intrinsic-value branch is unreachable (dead code)

**Location:** `NavOptions.sol:682–683, 697–708`.

```solidity
uint256 mult = bucket == 0 ? 100 : (bucket == 1 ? (isCall ? 105 : 95) : (isCall ? 110 : 90));
out.strike = _u128((q.s * mult) / 100);
...
if (isCall) { if (q.s > out.strike) { q.intrinsic = ... } ... }
```

For calls, `mult ∈ {100,105,110}` ⇒ `strike = floor(s·mult/100) ≥ s` always (at `mult=100`, exactly `s`), so `q.s > out.strike` is never true; symmetrically for puts (`mult ∈ {100,95,90}` ⇒ `strike ≤ s`). `q.intrinsic` is always 0 and `out.premium += q.intrinsic` (L708) is a no-op. Harmless defensive coding; would matter only if bucket definitions ever crossed the money — impossible in this immutable deployment. **Accept.** (Also removes any concern about intrinsic double-charging: verified none is possible.)

### I-02 — CEI deviation in `settle()`: external oracle call before `p.settled = true`

**Location:** `NavOptions.sol:429–432`. `ORACLE.snapshotSettlement` (state-changing external call) executes before the `settled` flag is written. Reentrancy into `settle` would sail past the `p.settled` check — but all mutating entry points carry `nonReentrant` (OZ `ReentrancyGuard`), and `ORACLE` is the immutable, first-party PitOracleV2 with no attacker-controllable callback. Non-exploitable as deployed; the pattern is worth flagging for future forks. **Accept.**

### I-03 — Accumulator floor-rounding strands dust in `premiumUsdg`

**Location:** `NavOptions.sol:390–391, 356`. The reserve is credited with the full `premium − protocolCut` while the per-share accumulator floors (`(x << 128) / totalShares`), so `premiumUsdg ≥ Σ pendings` always holds (harvest underflow impossible — this direction was checked and is correct), at the cost of ≤ 1 wei-per-share-quantum of USDG per open being permanently unclaimable. At 6-dec USDG and realistic share counts this is sub-cent over the protocol's life. **Accept.**

### I-04 — All-or-nothing withdraw vs free capital

**Location:** `NavOptions.sol:312–313`. A writer whose proportional `amountOut` exceeds `assets − escrowed` gets a full revert (`InsufficientFreeCapital`) instead of a partial fill; they must compute a smaller share amount themselves. This is exactly the failure that reached a live user pre-R4 (revert `0xc7068bf0`). **Frontend gate already shipped** (commit `f77ab839`: full custom-error decoding + writer-capacity gate). Confirm the gate also clamps the *shares* input to the withdrawable maximum, not just decodes the error. No contract-side risk.

### I-05 — `maxCostUsdg = 0` disables the cost guard; strike/expiry drift never guarded

**Location:** `NavOptions.sol:368, 377, 683, 685`. The premium+origination guard is optional (0 = off) and never covers strike or expiry, which float with the oracle price and block timestamp between preview and inclusion. The floor app always passes `quote + 0.5 %` (`floor/src/lib/options.ts:475–477`), so the shipped path is safe; strike drift is inherent to "ATM/±5/±10 % at execution" product semantics (strike and notional scale together with `s`, and the cost guard indirectly bounds notional drift). **Docs disclosure** for direct integrators: always pass a tight `maxCostUsdg`; never 0.

### I-06 — Hard coupling to PitOracleV2's non-zero settlement guarantee (`settleP = 0` ⇒ div-by-zero)

**Location:** `NavOptions.sol:447` — `Math.mulDiv(BOUNTY_CAP_USDG, STOCK_TO_USDG, settleP)` reverts on `settleP == 0` (CALL path); a hypothetical zero settlement would also mispay puts at full strike (L451–452). Verified against `PitOracleV2.sol:283–319`: a snapshot is stored only when non-zero (0 is the "unset" sentinel, L136), sources are Chainlink-round-at-expiry → pushed Pyth-at-expiry → clamped pool TWAP after `TWAP_FALLBACK_DELAY`, and the function reverts rather than storing zero. So the path is unreachable **as long as this exact oracle is at the immutable `ORACLE` address** — which it is. Settlement liveness inherits the oracle's fallback chain, so escrow cannot be stranded by mere anchor unavailability (the TWAP fallback eventually unlocks it). **Docs disclosure:** record the dependency "NavOptions solvency-of-settlement assumes PitOracleV2 never returns 0 and eventually settles every expiry" in the risk register.

---

## 6. Areas verified sound (explicit, with evidence)

These areas were examined line-by-line and adversarially; no issues found.

**6.1 Decimal conversions & rounding direction (spec: "buyer pays ceil, vault credits floor").** Every 18-dec↔6-dec conversion routes through `STOCK_TO_USDG = 1e30` with explicit rounding: notional ceil (L673), base premium ceil (L691), spread ceil (L693), abs-min ceil (L694), origination ceil (L709), PUT escrow ceil (L706) — all buyer-pays-more / vault-holds-more. Settlement payouts floor (L442, L452), protocol premium cut floors in the writer's favour (L387), withdrawal `amountOut` floors (L312), deposit shares floor (L276). Direction is uniformly vault-favouring. PUT solvency bound: `payout = ⌊size·(K−P)/1e30⌋ ≤ ⌊size·K/1e30⌋ ≤ ⌈size·K/1e30⌉ = escrow` — the L453 clamp is indeed unreachable belt-and-braces; same for calls (`payout = ⌊size·(P−K)/P⌋ < size = escrow`).

**6.2 X128 premium accumulator.** MasterChef-style accounting is correct: harvest computed on pre-change shares (deposit L280 before L286; withdraw L314 before L317), debt checkpoint reset with post-change shares (L287, L318, L334), reserve credited full while acc floors ⇒ `premiumUsdg ≥ Σ pendings` invariant holds ⇒ `_harvestPremium`'s L356 subtraction cannot underflow. Dilution theft (prior C-1) confirmed fixed and covered by `test_premium_lateDepositorEarnsNothing`. Overflow: `premium < 2^128` structurally (≤ ~26 % of a `uint128` notional), so `<< 128` cannot wrap; `held × acc` sits far below 2^256 for any reachable share/premium magnitudes (worked bound: shares ~1e21, acc increments ~3.4e23 per USDG-per-token-premium ⇒ product ~1e45).

**6.3 Collateral / free-capital accounting across the lifecycle.** `escrowed ≤ assets` is maintained by construction: open checks escrow against free capital pre-effect (L380) then adds to both `escrowed` and (puts) `assets`; withdraw checks `amountOut ≤ assets − escrowed` (L313); settle decrements `escrowed` by exactly `p.escrow` and `assets` by `payout + bounty ≤ p.escrow` (proof: `bounty ≤ released = escrow − payout`), so neither underflows (L461–462). OI increments/decrements are symmetric on the stored `notional` with a `settled` flag preventing double-decrement. **Live verification (2 Sep 2026, read-only cast):** m0 CALL vault `assets = 1.5e16` NVDA-wei == contract NVDA balance exactly; m0 PUT vault `assets = 19.902018` USDG == contract USDG balance exactly (all `premiumUsdg` = 0); `escrowed = 0` and `oiNotional = 0` on all four markets with the single historical position (id 1, an expired put) marked `settled = true`. Ledger–balance identity holds on chain to the wei.

**6.4 Donation / share-inflation resistance.** Accounting is internal-ledger-based (`v.assets`), never `balanceOf`-based, so direct token donations cannot distort share price; virtual shares/assets (1000:1, L113–114, L276, L312) blunt first-depositor rounding attacks. Fuzz tests (`testFuzz_depositWithdraw_noFreeAssets`, `testFuzz_shares_twoWriters`) confirm no value extraction via share grinding.

**6.5 Reentrancy & CEI.** Every mutating entry point is `nonReentrant`. `deposit`, `withdraw`, `open`, `settle` all complete state effects before token transfers (deposit L282–287 before L290; withdraw L316–320 before L323; open L385–408 before L411; settle L432/L461–463 before L466). Sole deviation is the trusted-oracle call in `settle` (I-02). No balance-dependent logic exists for read-only-reentrancy to poison.

**6.6 Fee routing.** Buyer pays `premium + origination` (L411); Accumulator receives `origination + protocolCut` (L412); writers receive `premium − protocolCut` (CALL: reserve L390; PUT: assets L393). USDG conservation per open: in `p+o`, out `o+c`, retained `p−c`. Exact — no leak, no double-count; matches spec §8 constants (20 bps origination, 4 % of premium). Confirmed by unit test `test_open_callHappyPath` and live-verified balances (§6.3).

**6.7 Expiry boundary conditions.** `expiry = ceil_hour(now + term)` (L685) ⇒ strictly future, hour-aligned, in `(now+term−1s, now+term+1h]`; `settle` gates on `block.timestamp < p.expiry` (L426) so settlement is possible from the expiry second onward; the settlement price is anchored *at* the expiry timestamp by PitOracleV2 regardless of settle timing (verified in oracle source L283–319 and by `testFuzz_settle_timingIndifference`) — late settlement confers no price optionality to any party. Multiple positions sharing an expiry share one immutable snapshot.

**6.8 Access control.** There are no privileged functions, no owner, no setters, no upgrade hooks; the market table is constructor-only (L137–138) with input validation (zero-addresses, decimals 6/18, ≤16 markets, non-zero minLiquidity). All entry points are permissionless by design; the only per-caller restrictions (`SameBlock`, share ownership) were reviewed under L-02. Nothing to escalate.

**6.9 Zero-liquidity markets (m1–m3 live state).** With zero writer capital: `deposit` works; `open` fails closed with `InsufficientFreeCapital` (escrow > 0 = free) before `EmptyVault` (L380 precedes L385) — matching the live NVDA revert history; `previewOpen` on m1 succeeds live (pool liquidity above its gate) which is *correct but foot-gunny for UIs* — the quote does not imply openability; the f77ab839 writer-capacity gate addresses this. Views degrade gracefully (`bandDepthUsdg` → value of pool liquidity irrespective of vault; `dailyRateX18` → 0 on empty/stale ring). No division-by-zero: the acc division by `totalShares` (L391) is dominated by the `EmptyVault` guard.

**6.10 Band math.** `_bandValueUsdg` (L618–632) matches Uniswap's `getAmount0Delta`/`getAmount1Delta` closed forms over `[P, 1.02P]` / `[P/1.02, P]` (`BAND_NUM/DEN = √1.02 · 1e9`); orientation swap (L630) is correct for both token orderings (unit-tested both ways via NVDA/SPCX fixtures); `liq << 96` cannot overflow inside OZ 512-bit `mulDiv`; both legs floor ⇒ depth understated ⇒ the 20 % cap is conservative in the honest case. Live sanity: `bandDepthUsdg(0) ≈ $2.75 M` against pool liquidity `9.48e18`, spot tick 222534 ≈ oracle $216.79 — internally consistent.

**6.11 Fee-growth wrap handling.** The `unchecked` subtraction of fee-growth accumulators (L606–610) is deliberate and correct — Uniswap accumulators wrap by design and the delta survives a wrap. `testFuzz_rate_neverReverts` covers arbitrary deltas including near-wrap values, with the floor/cap clamp absorbing garbage magnitudes.

## 7. Invariants verified

| # | Invariant | Method | Result |
|---|---|---|---|
| 1 | `escrowed ≤ assets` per side-vault | Manual proof over all 4 mutation sites + `invariant_assetsCoverEscrow` | Holds |
| 2 | `payout + bounty ≤ escrow` per settlement | Algebraic proof (§6.3) + `testFuzz_call/putLifecycle_conservation` | Holds |
| 3 | Internal ledger == token balances | Live cast (m0–m3, both assets, exact match) + `invariant_ledgerMatchesBalances` | Holds on mainnet |
| 4 | `premiumUsdg ≥ Σ pendingPremium` | Rounding-direction proof (§6.2) | Holds |
| 5 | OI = Σ active position notionals | `invariant_oiMatches` + live (0 == 0, 1 settled position) | Holds |
| 6 | No double settlement | `settled` flag ordering + `invariant_settleOnce` | Holds |
| 7 | Premium never < absMin, never > cap·1.25·term | `testFuzz_open_premiumBounds`, `testFuzz_rate_neverReverts` | Holds |
| 8 | Settlement price independent of settle timing/caller | Oracle source review + `testFuzz_settle_timingIndifference` | Holds |
| 9 | Settlement never depends on `quotePrice` liveness | Code path review + `test_settle_worksWhenQuoteRevertsLiveness` | Holds |
| 10 | Preview/open bit-parity | Shared `_quote` + `test_previewOpen_matchesOpen` + live preview | Holds |

## 8. Test-coverage assessment

**Covered well** (64 unit + 9 fuzz + 6 stateful invariants + 5 fork tests): constructor validation; share math including virtual-share dust bounds and two-writer fairness; the full accumulator lifecycle including the C-1 dilution regression; both token orderings; all gate reverts (term/bucket/notional/depth/free-capital/oracle-deviation/max-cost); settlement OTM/ITM both sides, both bounty caps, expiry anchoring, quote-revert liveness; rate measurement incl. stock-leg conversion, clamps, stale ring, oldest-in-window selection; conservation fuzzing over arbitrary settle prices; ledger==balance invariant under a randomized 7-action handler.

**Gaps (risks not exercised by any test):**
1. **M-01 adversarial scenario** — no test wash-trades through self-owned LP or flushes the ring via dust deposits to shorten `dt`; only the *clamp* is tested, not the manipulation economics.
2. **M-02** — no test with a reverting/blocklisting payout token on `settle` (mock tokens have no freeze), so the stuck-escrow behaviour is unproven in CI.
3. **L-01** — no JIT test mutating pool liquidity between gate-check and open, or across open/settle.
4. **L-02** — no test of the deposit-before-open premium capture (only *late* depositor is tested); the one-block exit window is untested.
5. **Ring wrap-around** — no test pushes >24 snapshots to exercise ring overwrite arithmetic (`(head+1) % 24` at the boundary).
6. **Multi-market stateful fuzzing** — the invariant handler only drives market 0; cross-market ledger separation is structural but unfuzzed (the balance invariant would catch bleed if market 1 were driven).
7. **`harvestPremium` same-block-as-deposit** — allowed by design (no `SameBlock` on harvest), never asserted.
8. **Fork settlement** — the fork test cannot exercise real `snapshotSettlement` (noted in-file); live settlement was instead verified retrospectively here (position 1 settled correctly on mainnet).
9. **`maxCostUsdg = 0` semantics** — the disable path is exercised implicitly everywhere but never asserted as intentional.

Recommendation to the lead: add tests 1–5 to the campaign even though the contract is frozen — they pin the *documented* residual behaviour and guard the next deployment.

## 9. Conclusion

`NavOptions.sol` is a tightly-scoped, well-engineered contract. The core solvency claim — every payout physically escrowed at open, with uniformly vault-favouring rounding — is correct, proven algebraically here, enforced by the test campaign, and confirmed against live mainnet state (internal ledgers match token balances to the wei; the one historical settlement executed correctly). No Critical or High severity issues were found. The residual risk concentrates in (a) the economically-bounded manipulability of the pool-fee-derived premium *rate* (M-01), and (b) an irreversible escrow-lock contingent on issuer freeze actions against a buyer (M-02) — both manageable with the monitoring, frontend, and disclosure measures specified per finding, which are the only levers available for an immutable deployment.

---

*Read-only review. Evidence: manual line-by-line review of commit `be4854d1`; read-only `cast` calls against `0xd628eFeC572eE000D4Eb040E675744FEB35F2467`, its four market pools, USDG, and NVDA on chain 4663 on 2 Sep 2026; cross-reads of `PitOracleV2.sol` and `floor/src/lib/options.ts` for interface-boundary claims.*

---

## Remediation status (post-review)

`NavOptions.sol` is live and immutable — contract findings close via application gates and documentation disclosures, not code changes. All frontend-side mitigations recommended by this report ship in repo commit `46f1a2f2`: the pricing-cap condition is surfaced in the order ticket and market board (rate-cap tag + capped-market warning), zero-writer-capacity opens are gated client-side, and integrators are directed never to pass `maxCostUsdg = 0`. Residual behaviours (frozen-underlying escrow risk, writer exposure to issuer actions, floor-rate quoting on quiet pools) are disclosed in the protocol documentation.
