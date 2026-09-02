# 10 · NAV Credit — contracts (pre-deploy, line-by-line + adversarial economics)

> **Remediation status:** every finding below was remediated before deployment.
> The single Medium (M-01, weekend oracle staleness) was resolved by on-chain
> verification of the anchor feed cadence — the measured worst gap (52.1h weekend
> freeze) sits inside the 26h staleness gate design: oracle-gated actions (borrow,
> removeCollateral, liquidate) pause; deposit/withdraw/repay/addCollateral never
> pause. All L/I findings were fixed in the working tree prior to the deploy commit.


# AUDIT A — NAV Credit: `CreditPair.sol` / `CreditFactory.sol`

**Track:** Contracts, pre-deploy, line-by-line + adversarial economics
**Repo:** `navfun` @ `6b9769ae` (working tree; contracts not yet committed/deployed)
**Files in scope:**
- `contracts/src/credit/CreditPair.sol` (750 lines)
- `contracts/src/credit/CreditFactory.sol` (110 lines)

**Reference spec:** `internal/credit/SPEC.md` (v0.1, 2 Sep 2026)
**Trust assumptions (as instructed):** PitOracleV2 `anchorPrice` is live and trusted (1e18 USD price + `updatedAt`; Chainlink 24 h heartbeat push feed primary, Pyth fallback); AccumulatorV2 is a live trusted sink; USDG is a standard 6-decimal ERC-20 (no fee-on-transfer); collateral is a standard 18-decimal ERC-20 (no hooks, no rebasing).

**Date:** 2 September 2026

---

## 1. Executive summary

The contracts are, overall, a disciplined and faithful adaptation of Morpho Blue share
accounting and Aave v3 liquidation UX to an immutable isolated-pair design. Rounding
directions are correct at every conversion call-site I checked; the virtual-offset
regime, donation immunity, reentrancy posture, accrual/fee-mint math, liquidation
recompute bound, and the two core invariants (`totalSupplyAssets >= totalBorrowAssets`
and cash solvency) all verify. **No Critical or High severity issues were found.**

The one Medium finding is not a coding error but a load-bearing assumption: the entire
market-hours safety model ("liquidations paused off-hours, weekend gap priced into
LTV") hangs on the oracle's `updatedAt` *stopping* off-hours. If the Chainlink feed's
24 h heartbeat advances `updatedAt` while the underlying market is closed, the gate
silently evaporates and stale-price borrows and liquidations become possible over
weekend gaps. Because the pairs are immutable, this must be resolved with certainty
**before** deployment, not after.

| ID | Severity | Title |
|----|----------|-------|
| M-01 | Medium | Market-hours pause rests entirely on oracle `updatedAt` semantics; an off-hours heartbeat silently re-enables stale-price borrow / removeCollateral / liquidate over weekend gaps |
| L-01 | Low | Constructor permits `MAX_PRICE_AGE` (min 1 h) far below the feed heartbeat (24 h) → recurring intraday liveness DoS on liquidations, extending the bad-debt window |
| L-02 | Low | Bad-debt socialization is instantaneous and front-runnable; withdraw remains open while liquidations are stale-gated, so informed lenders exit and residual lenders absorb the loss |
| L-03 | Low | Unliquidatable dust-collateral positions: `_liquidateFull` reverts `RepayTooSmall` when collateral value rounds to 0 USDG; manufacturable via profitable partial-liquidation grinding, permanently stranding ≥ `MIN_DEBT` of phantom debt |
| L-04 | Low | Economic constants diverge from the approved spec (origination 30 bps vs 20 bps; reserve factor 20 % vs 15 %; CREATE vs CREATE2; price-age bounds vs spec table) — immutable once deployed |
| I-01 | Informational | `_u128` NatSpec says "saturating" but the function reverts; the genuinely saturating casts are the `zeroFloorSub` sites — comments swapped |
| I-02 | Informational | Bonus-priced full close can socialize bad debt while collateral value still exceeds debt (the "bonus zone") — inherent economics, should be disclosed |
| I-03 | Informational | `healthFactor`, `priceStatus`, `marketState` bubble oracle reverts — a dead/reverting feed breaks the views despite the "views must not revert off-hours" intent |
| I-04 | Informational | Factory performs no collateral sanity checks (decimals ≠ 18, `collateral == USDG`), binds one pair per collateral forever, and uses CREATE (spec said CREATE2) |
| I-05 | Informational | Benign ledger dust: phantom borrow assets with zero borrow shares; stranded donations unsweepable; cash-capped `skimReserves` under-burns shares, technically breaking share-price monotonicity by 1 rounding unit |

**Totals: 0 Critical · 0 High · 1 Medium · 4 Low · 5 Informational.**

---

## 2. Findings

### M-01 — Market-hours pause rests entirely on oracle `updatedAt` semantics; an off-hours heartbeat silently re-enables stale-price actions (Medium)

**Location:** `CreditPair.sol` L346–351 (`_freshPrice`), consumed at L508 (`removeCollateral`), L538 (`borrow`), L602 (`liquidate`); policy documented L55–59 and SPEC §4.

**Description.** The only staleness defense is:

```solidity
if (block.timestamp > updatedAt + MAX_PRICE_AGE) revert StalePrice();   // L350
```

The design intent (contract NatSpec L55–59, SPEC §4) is that equity anchors "go quiet
off-hours," so `updatedAt` ages past `MAX_PRICE_AGE` and borrow/removeCollateral/
liquidate pause until the market reopens. This is only true if PitOracleV2's
`updatedAt` **stops advancing** when the equity market is closed. The stated feed
behavior is a *Chainlink 24 h heartbeat push feed*. If the heartbeat fires during
closed hours — re-pushing Friday's close with a fresh timestamp, as heartbeats do
unless the feed is explicitly market-hours-gated — then `updatedAt` is always ≤ 24 h
old and the gate **never activates** for any `MAX_PRICE_AGE ≥ 24 h` (the spec's
proposed 75 h included).

**Exploit paths (both directions):**

1. *Stale-high borrow → walk-away bad debt.* Real market gaps down 20 % after Friday
   close (earnings, halt-reopen). Saturday, the heartbeat re-stamps Friday's price.
   Attacker deposits collateral, calls `borrow()` (L519) to max LTV against the
   stale-high price — `_freshPrice()` passes because `updatedAt` is hours old. Monday
   the anchor catches down; the position is instantly under water beyond the bonus
   band; the shortfall is socialized to lenders via `_liquidateFull` (L656–663). Same
   path drains via `removeCollateral` (L499) for existing borrowers.
2. *Stale-low wrongful liquidation.* Real market gaps up; the re-stamped Friday price
   makes healthy borrowers show HF < 1 at L610; liquidators seize collateral at the
   stale-low `px` (L620) — seizing **more** units per repaid USDG than fair — with
   the borrower's only defenses the always-open `repay`/`addCollateral`.

**Why Medium, not High:** the oracle is designated trusted and the live PitOracleV2
behavior may indeed freeze `updatedAt` off-hours (Chainlink US-equity feeds typically
only push in market hours); LTVs are specified to absorb multi-day gaps, bounding
loss severity. But the contract is immutable and the entire §4 policy is
unverifiable from this code alone — it is an external invariant with no on-chain
backstop.

**Recommendation.** Before deploy: (a) empirically verify, on Robinhood Chain, that
the feed's `updatedAt` does not advance between Friday close and Monday open (log a
full weekend); (b) if it does advance, the age gate cannot implement the pause —
either have PitOracleV2 expose a market-open flag / last-trade timestamp and gate on
that, or re-derive LTVs assuming **no** weekend pause and update SPEC §4 and all user
disclosures accordingly; (c) record the verification artifact in `internal/` since
this assumption can never be patched post-deploy.

---

### L-01 — `MAX_PRICE_AGE` floor (1 h) far below the 24 h feed heartbeat permits liveness-DoS configurations (Low)

**Location:** `CreditPair.sol` L222 (`require(p.maxPriceAge >= 1 hours && p.maxPriceAge <= 7 days)`).

If a pair is deployed with `MAX_PRICE_AGE` below the feed's worst-case push interval
(24 h heartbeat when price stays inside the deviation band), then during any
low-volatility stretch of an **open** market the anchor's age exceeds the gate and
`borrow`, `removeCollateral` and — critically — `liquidate` all revert `StalePrice`
(L350). Liquidations being blocked while the real price moves extends the bad-debt
window; borrowers are simultaneously unable to de-risk via `removeCollateral`
(though `repay`/`addCollateral` remain open, which is the correct mitigation).
Because parameters are immutable, a mis-set pair is broken forever and (per
Factory `pairFor`, L83/106) blocks that collateral's slot permanently.

**Recommendation.** In the deploy script, assert `maxPriceAge > feed heartbeat +
margin` (or, if M-01 verification shows updatedAt freezes off-hours, `maxPriceAge ≥
75 h` per spec). Consider raising the constructor floor to the heartbeat; the 1 h
floor protects nothing this feed can deliver.

---

### L-02 — Instant bad-debt socialization is front-runnable; withdraw stays open while liquidations pause (Low)

**Location:** `CreditPair.sol` L656–663 (socialization: `totalSupplyAssets -= badDebtAssets`), L467–484 (`withdraw`, ungated), L450–463 (`deposit`, ungated).

Bad debt is socialized by instantly writing down `totalSupplyAssets`, which marks
down every supply share in the same block (Morpho Blue behavior). Two consequences:

1. *Mempool race:* a lender watching for a `liquidate` that will hit the
   `_liquidateFull` bad-debt branch can front-run with `withdraw` and exit at the
   pre-writedown share price; the loss concentrates on slower/passive lenders. With
   an 18-decimal collateral and public oracle, the insolvency of a position is fully
   predictable off-chain.
2. *Stale-window run:* while `liquidate` is gated on freshness but `withdraw` is not
   (by design, L57–58), a known off-chain price collapse triggers a withdrawal run
   during the pause. Whoever exits before liquidations resume escapes the eventual
   socialization entirely; utilization spikes to 100 % and trapped lenders eat the
   loss. `deposit` being open symmetrically lets an uninformed depositor buy into a
   market with certain-but-unbooked bad debt.

This is inherent to instant-socialization designs and partially disclosed (SPEC §6);
isolation correctly contains it per pair. Flagged because the *liquidation-pause*
variant is specific to this protocol's market-hours policy and is worse than
Morpho's baseline, and the RISK STRIP / docs should say so explicitly.

**Recommendation.** Disclose the exit-race dynamics in the frontend risk strip and
docs ("lenders remaining during a paused-market gap absorb socialized losses"). No
code change is required for v1; if desired later, loss-tranching or withdrawal
throttling are the standard (heavier) mitigations — likely not worth the complexity
at these caps.

---

### L-03 — Dust-collateral positions become permanently unliquidatable; manufacturable by profitable partial-liquidation grinding (Low)

**Location:** `CreditPair.sol` L645–646 (`repaid == 0 → revert RepayTooSmall`), L623 (full-path trigger `seized >= a.collateral`), L675–679 (partial path `MIN_DEBT` gate).

In `_liquidateFull`:

```solidity
repaid = seized.mulDiv(px, 1e18).mulDiv(BPS, BPS + LIQ_BONUS_BPS) / USDG_TO_WAD;  // L645
if (repaid == 0) revert RepayTooSmall();                                          // L646
```

If a position's entire collateral is worth < ~1.1e-6 USD (rounds to 0 USDG units),
the full-close path always reverts. The partial path is equally unreachable: any
nonzero repay computes `seized ≥ a.collateral` (L620/623) and routes to the
reverting full path. The position is frozen — its `borrowShares` can never be
burned except by voluntary `repay` — so its debt (≥ `MIN_DEBT` = 10 USDG, L156)
persists in `totalBorrowAssets` forever, accruing interest at every `accrue()`
(L317) that inflates `totalSupplyAssets` and `totalBorrowAssets` equally. That
interest is *unbackable*: lender claims grow with no cash ever arriving, so the
final ~`debt + accrued` USDG of supply-share claims can never be redeemed
(`availableLiquidity`, L439–443, is permanently reduced). Socialization never
happens because `_liquidateFull` is the only writedown path.

**Exploit path (deliberate, profitable grief).** Take any position that has gone
under water (HF < 0.95, so full close is allowed, L613). Instead of one full close,
a griefer runs a sequence of partial liquidations (each collects the full
`LIQ_BONUS_BPS`, so the grind is *profit-positive*), each sized so the remainder
stays ≥ `MIN_DEBT` (L678), extracting collateral until the borrower is left with
exactly 10 USDG debt and near-zero collateral units. Endgame: 10 USDG + perpetual
interest stranded per victim position, borne by the last withdrawing lenders, with
`BadDebtSocialized` never emitted.

**Severity:** Low — loss is bounded (~`MIN_DEBT` + interest per position), requires
an already-insolvent position, and the residue grows slowly. But it violates the
spec invariant "bad debt is socialized exactly" and pollutes the ledger forever in
an immutable contract.

**Recommendation.** In `_liquidateFull`, replace the L646 revert with: if
`repaid == 0`, set `seized = a.collateral`, `repaid = 0`, and socialize the entire
`debt` (skip the `safeTransferFrom` of 0 / send the dust collateral to the caller as
the incentive). I.e., allow a zero-repay full close when the collateral is
valueless — this is exactly Morpho's bad-debt realization. Additionally consider a
floor in `_liquidatePartial`: require remaining *collateral value* ≥ some multiple
of `MIN_DEBT`'s liquidation dust, or simply require partial closes to leave
`remainingCollateralValue ≥ remainingDebt·(1+bonus)/threshold`-independent dust
floor. The first fix alone is sufficient.

---

### L-04 — Deployed economics silently diverge from the approved specification (Low)

**Location:** `CreditPair.sol` L150 (`ORIGINATION_BPS = 30`), L152 (`RESERVE_FACTOR_BPS = 2000`), L222 (price-age bounds), `CreditFactory.sol` L85–104 (plain `new`, i.e. CREATE).

| Parameter | SPEC.md | Code |
|---|---|---|
| Origination fee | 20 bps (§1, §3.2) | **30 bps** (L150) |
| Reserve factor | 15 % (§1) | **20 %** (L152) |
| Fresh-price window | 30 min fresh / 75 h dead (§4 table) | constructor bounds 1 h–7 d; actual value deploy-time (L222) |
| Pair deployment | CREATE2 (§3, deterministic addresses) | CREATE (Factory L85) |

For a protocol whose selling point is "immutable, published, verified," shipping
constants 50 %/33 % higher than the document under review is a process failure even
if intentional: they cannot be corrected post-deploy, and users/docs will be wrong.
`SKIM_BOUNTY_BPS = 5` (L154) matches. Not exploitable; classified Low rather than
Informational because the values are economic and permanent.

**Recommendation.** Reconcile before deploy: either update SPEC/docs/litepaper to
30 bps / 20 % explicitly, or change the constants. If deterministic addresses
matter to the frontend or docs pipeline, use CREATE2 with `salt =
keccak256(collateral)` (also makes redeploy-after-selfdestruct arguments moot).

---

### I-01 — Misleading "saturating" comment on `_u128` (Informational)

**Location:** `CreditPair.sol` L173–177.

`/// @dev Saturating uint128 cast guard` — the function is a **checked** cast that
reverts (`require(x <= type(uint128).max, "U128")`), not saturating. The genuinely
saturating operations are the `zeroFloorSub`-style raw `uint128(...)` casts at
L572–574, L653–655, L657–661, L683–685 (all safe: operands are bounded by an
existing `uint128` state variable before the cast). Fix the comment; auditors and
integrators reading "saturating" will reason incorrectly about overflow behavior.

### I-02 — Bad debt can be socialized while collateral value still exceeds debt (Informational)

**Location:** `CreditPair.sol` L620, L623, L643–648.

When `debt < collateralValue < debt·(1 + LIQ_BONUS_BPS/BPS)` and HF < 0.95, a
max-repay liquidation computes `seized ≥ a.collateral` (L623) and takes the full
path: the liquidator receives *all* collateral, `repaid = collValue/(1+bonus) <
debt` (L645), and the gap — up to `bonus/(1+bonus)` ≈ 7.4 % of debt at an 8 % bonus
— is socialized to lenders (L656–663) even though the position was technically
solvent. This is standard Aave/Morpho economics (the bonus is senior to lender
principal) and the constructor's `threshold·(1+bonus) ≤ 100 %` check (L219) keeps
the healthy region clear of it, but the disclosure docs should state that bad debt
can occur *without* the price crossing 1:1 coverage.

### I-03 — View functions bubble oracle reverts (Informational)

**Location:** `CreditPair.sol` L419–425 (`healthFactor`), L354–361 (`priceStatus`), L726–749 (`marketState`).

The NatSpec at L417 says "views must not revert off-hours," and indeed staleness
does not revert them — but an oracle that *reverts* (e.g. PitOracleV2
`MarketUnknown` after a hypothetical migration, or a feed-level revert) makes all
three views revert, since `anchorPrice` is called without try/catch. Off-chain
`debtOf`/`supplyBalanceOf` remain usable. Frontend should wrap these in try/catch
multicall (per the R4 null-safe-price rule); optionally the contract could
try/catch and return `fresh=false, price=0`. Low impact: views only.

### I-04 — Factory: no collateral sanity checks; permanent one-pair-per-collateral binding; CREATE not CREATE2 (Informational)

**Location:** `CreditFactory.sol` L69–109, L83, L106.

`deployPair` accepts any `collateral` (deployer-gated): no check that it is not
`USDG` itself, no `decimals() == 18` probe — `CreditPair` hard-codes the 18-dec
assumption (L144, L423, L434, L620), so a 6-dec collateral would be mispriced by
1e12×. The oracle probe (Pair L243) is the only implicit filter. Also,
`pairFor[collateral]` is set forever (L83/106): a mis-parameterized pair (see L-01,
L-04) permanently blocks relisting that collateral through this factory/registry.
All acceptable under the trusted-deployer model, but the deploy script should
assert `IERC20Metadata(collateral).decimals() == 18` and `collateral != USDG`, and
the team should accept the relisting constraint consciously (a v2 factory would
require frontend/docs changes).

### I-05 — Benign ledger dust (documented for completeness) (Informational)

**Location:** `CreditPair.sol` L553–574 (repay), L695–719 (skim), L701–707.

1. *Phantom borrow residue:* when the last borrower fully repays, per-account debt
   `ceil` (L554) vs the global ledger can leave `totalBorrowAssets` of a few units
   with `totalBorrowShares == 0` (or, symmetrically, the zeroFloorSub at L572–574
   strands 1 unit of surplus cash for lenders). Magnitude ≤ a few 1e-6 USDG;
   identical to Morpho Blue. Not exploitable.
2. *Stranded donations:* all accounting is internal (`utilizationRay` L294–300,
   `availableLiquidity` L439–443 correctly ignore `balanceOf`), so directly
   transferred USDG/collateral is locked forever. Correct anti-donation design;
   just note there is deliberately no sweep.
3. *Cash-capped skim under-burns shares:* in the `assets > cash` branch (L703–707),
   `shares = _toSupplySharesDown(assets)` rounds **down**, so the reserve burns
   marginally fewer shares than the cash it takes; remaining lenders' share price
   drops by ≤ 1 rounding unit per skim, technically violating the spec's
   "share price monotonic non-decreasing absent bad debt" invariant (SPEC §8.2).
   Fix if desired: round up and clamp to `shares` (`Math.Rounding.Ceil`, then
   `min(sharesUp, shares)`). Dust-level; the counterparty is the protocol reserve
   itself.

---

## 3. Areas verified sound (no findings — checked, not skipped)

These are the areas the engagement specifically asked about where the code is
correct. Each was checked line-by-line, several with algebraic proofs.

1. **Rounding directions (all conversion sites).** Deposit mints shares down
   (L253–255/454); withdraw pays assets down (L257–259/474); borrow mints debt
   shares up (L261–265/528); per-user debt reads up (L271–275, L368–373); repay
   burns shares down — i.e. against the payer (L562); liquidation seize double-floors
   against the liquidator (L620); full-close repay recompute floors against the
   protocol's counterparty and is capped at `debt` (L645–647). Every direction
   matches the "protocol never loses a wei" rule. No exploitable
   round-trip (e.g. deposit-then-withdraw or repay-then-borrow loops strictly lose
   dust to the pool).

2. **First-depositor / inflation and donation attacks.** Virtual offsets
   +1000 shares/+1 asset on both ledgers (L146–147) make the classic inflation
   attack lose ≥ ~99.9 % of the attacker's donation, and donations are entirely
   inert anyway because utilization, liquidity and share pricing use internal
   accounting, never `balanceOf` (L297–299, L439–443). Empty-market first deposit
   mints `assets × 1000` shares; `shares == 0` dust deposits revert (L455).

3. **Accrual and reserve-fee mint (Morpho-exact).** Linear interest
   `borrow·rate·dt/(YEAR·RAY)` floors (L317); `lastAccrue` is advanced *before* the
   zero-borrow early-return (L310–313), so idle periods never accrue retroactively.
   Fee shares are priced against the pre-fee ledger
   (`newTotalSupply − feeAmount + VIRT_ASSETS`, L329–331) — bit-for-bit Morpho's
   `feeShares = fee.toSharesDown(totalSupplyAssets − fee, totalSupplyShares)` — so
   the reserve cannot dilute itself and lenders receive exactly
   `interest − feeAmount` of value. View ledgers (L384–414) replicate the same math.
   No overflow: `rate·elapsed ≤ 1e28·~1e9 ≪ 2^256`; all state fits behind `_u128`
   checks at economically unreachable magnitudes given the caps.

4. **Invariant `totalSupplyAssets ≥ totalBorrowAssets` (S ≥ B).** Holds on every
   path: deposits raise S only; borrow requires `debtAssets ≤ S − B` (L526);
   accrual adds `interest` to both (L335–336); repay lowers B only; full
   liquidation lowers B by `debt` and S by `badDebt ≤ debt` (L648, L653–661), so
   `S' − B' = (S − B) + (debt − badDebt) ≥ S − B ≥ 0`. Therefore
   `utilizationRay ≤ RAY` and `availableLiquidity` never underflows.

5. **Cash solvency: `USDG.balanceOf(pair) ≥ totalSupplyAssets − totalBorrowAssets`.**
   Verified per path: deposit (+a/+a), withdraw (−a/−a, gated by accounting cash
   L476), borrow (balance −(assets+fee) = −debtAssets; accounting cash −debtAssets,
   L532/541–542 — the origination fee is fronted from pool cash and owed back as
   borrower debt, so routing is exact), repay (balance +repaid ≥ accounting-cash
   increase, zeroFloorSub L572–574 only creates surplus), liquidation (balance
   +repaid; `S−B` changes by `debt − badDebt = repaid` exactly — **bad-debt
   socialization is exact to the unit**, L643–663), skim (−assets/−assets,
   L710–717). Donations only add balance. The spec §8 invariant holds under every
   code path, including the last withdrawer (assets ≤ S always, from the virtual
   offset algebra) and total-wipeout states (S = 0 forces B = 0 by §3.4).

6. **Liquidation close-factor / MIN_DEBT interplay — no dead zone.** For any
   `debt > FULL_CLOSE_DEBT (20e6)`, the 50 % close leaves
   `≥ ceil(debt/2) > MIN_DEBT (10e6)` (L613–616, L678); any `debt ≤ 20e6` is fully
   closable. Dust-debt griefing via tiny borrows is blocked by the post-mint
   `newDebt ≥ MIN_DEBT` check (L536–537), and partial repays cannot leave
   `< MIN_DEBT` (L563–564). The HF-threshold direction (`hf < 0.95e18` → 100 %)
   matches Aave v3 (L613).

7. **Full-close recompute never exceeds the liquidator's bid.** Proven: with
   `r = min(repayAssets, maxRepay)`, the trigger `a.collateral ≤ seized(r)` and the
   floor chain give `repaid_full = ⌊⌊coll·px/1e18⌋·BPS/(BPS+bonus)⌋/1e12 ≤ r`.
   The liquidator can never be pulled for more USDG than requested (L629), and the
   defensive `repaid > debt` clamp (L647) is unreachable but harmless. Seizure in
   the partial path is strictly `< a.collateral` (L623/681) — no underflow.

8. **Griefing robustness (repay / liquidation front-running).** All flows clamp
   rather than revert on state races: `repay(type(uint256).max)` and
   `assets ≥ debt` adapt to front-run partial repays (L557–559); `liquidate`
   clamps `repayAssets` to the recomputed `maxRepay` (L616), so a front-run dust
   repay or competing liquidation only reduces the amount, never bricks the tx
   (a fully-closed position correctly reverts `NotLiquidatable`, L600). Third-party
   repay is a pure gift. Self-liquidation and borrower==lender confer no advantage:
   the bonus in self-liquidation comes from the caller's own collateral, and the
   bad-debt escape is available to any liquidator identically.

9. **Oracle gating placement.** The gated set (borrow L538, removeCollateral L508,
   liquidate L602) is exactly the state-expanding/price-consuming set; the open set
   (deposit, withdraw, repay, addCollateral, accrue, skim) reads no price and can
   only *improve* or neutrally move solvency — with the systemic caveats in
   M-01/L-01/L-02. `_freshPrice` rejects zero price (L349) and its `>` boundary
   agrees with `priceStatus`'s `<=` (L360).

10. **Reentrancy / CEI.** `nonReentrant` on every external state-mutating function;
    all token transfers occur after state writes (deposit L461, withdraw L482,
    borrow L541–542, repay L576, liquidate L629–630, skim L716–717); tokens are
    hook-free by assumption and the only other external calls are the trusted
    view-only oracle. No cross-function reentrancy surface found.

11. **uint128 / uint64 handling.** All increments pass through the checked `_u128`
    (L174–177) or Solidity 0.8 checked `uint128` arithmetic; the four raw
    saturating casts are bounded by prior `uint128` state (see I-01). `lastAccrue`
    as `uint64` is safe for ~584 B years. Share magnitudes stay ~10 orders below
    2^128 at the specified caps, including post-wipeout remint scenarios.

12. **Caps and constructor validation.** Supply cap checked post-accrual (L453),
    borrow cap includes the origination fee (L523–525); no mint/burn path bypasses
    either (interest may organically exceed caps — standard and intended). The
    parameter lattice (L214–224) — `0 < LTV < threshold < 100 %`,
    `threshold·(1+bonus) ≤ 100 %`, bonus ≤ 20 %, kink ∈ (0, RAY), rate ceiling
    10× RAY, `borrowCap ≤ supplyCap` — is complete for the stated model. The IRM
    (L285–291) matches the Aave v3 shape at, below and above the kink with no
    division-by-zero (kink > 0, `RAY − kink > 0` enforced).

13. **Factory access control and registry.** `deployPair` is strictly
    deployer-gated (L82), duplicate listings revert (L83), listing power confers no
    authority over deployed pairs (no admin surface exists in `CreditPair` — zero
    owner-only functions, zero mutable parameters). Registry views are
    gas-unbounded only by deployer-controlled N.

---

## 4. Remediation priority before deploy

1. **M-01** — verify PitOracleV2/feed off-hours `updatedAt` behavior on-chain over a
   real weekend; adjust design or LTVs if the pause is not real. *Blocking.*
2. **L-03** — allow zero-repay full close (socialize valueless-collateral debt)
   instead of reverting. Small, safe diff; removes the only path that permanently
   corrupts the ledger. *Strongly recommended pre-deploy (immutable).*
3. **L-01 / L-04** — deploy-script assertions (`maxPriceAge` vs heartbeat, collateral
   decimals, `collateral != USDG`) and spec/constant reconciliation.
4. **L-02 / I-02** — disclosure text in RISK STRIP + docs.
5. **I-01 / I-03 / I-05** — comment fix, view try/catch guidance for frontend,
   optional skim rounding tweak.

---

*Audit A performed line-by-line on the working tree at repo stamp `6b9769ae`. No
tests were executed as part of this review (none exist yet for the credit module);
the §8.2 invariant suite in SPEC.md should encode invariants 4, 5 and the L-03
liveness property (`every position with debt > 0 is either repayable to zero or
liquidatable`) before deployment.*

---

## 5. Verification campaign (post-remediation, 2026-09-02)

Executed against the frozen source at deploy commit. Every failure class was
root-caused and either fixed or pinned as documented behaviour before deploy.

| Layer | Volume | Result |
| --- | --- | --- |
| Differential bigint harness (exact off-chain mirror of CreditPair share math, rate model, borrow/liquidity gates, UI clamps; 9 invariants after every op; 260-op stateful walks; frontend-clamp differential; accrual conservation) | **102,917,515 checks** (13,500 sweeps, seeds 1337 + 777001) | 0 violations |
| Foundry fuzz — 10 properties × 100,000 runs (3 passes; final pass pinned to the finding seed `0xae1faa9d…`) | **2,805,935 executions** | all pass |
| Foundry invariants — 8 invariants, 800 runs × 300-call depth × 2 campaigns | **3,840,000 assertions** (480,000 randomized calls) | all pass |
| Unit suite | 56 tests × 2 campaign passes | all pass |
| Slither static analysis — full 102-detector suite over the 12-contract build | 61 results triaged | 0 actionable (naming, deliberate tuple destructuring, cosmetic shadowing, intentional zero-defaults, timestamp FPs) |

**Total executed checks: ~109.6M.**

Campaign findings (both surfaced by the 100k-run fuzz tier, neither a contract change):

- **C-F1 (test bound, fixed).** The liquidation bonus bound allowed +1 rounding
  unit; the full-close path chains three floor divisions, so the true worst-case
  slack is 2 USDG units (2e-6 USDG). Direction is the documented Aave
  `debtAmountNeeded` floor — the liquidator never overpays. Bound corrected with
  derivation comment; reproduced and cleared at 100k runs on the finding seed.
- **C-F2 (by-design, pinned).** A liquidation ask leaving a dust remainder
  `0 < debt − repaid < MIN_DEBT` reverts `DebtTooSmall` (Morpho dust guard).
  Liquidation is never blocked — a full-close ask always succeeds in the same
  state. Now pinned by `test_liquidate_dustWindowReverts` and steered in the fuzz
  property so success paths stay fully explored.

**Deployment (Robinhood Chain 4663, all Sourcify `exact_match`):**
CreditFactory `0x9A9feC2B6b05F94D8c3861d0202C05Df4Dcfd4A7` · NVDA pair
`0x29b2958726D905034A60Aa471B44Ee6df93516B1` · QQQ pair
`0xF07c295FB066fB1ae7867dc1235cdee009e2cafc` · AAPL pair
`0x4b78AeF24A62896a4f1381969EF4C9D28d2a567c` · TSLA pair
`0x82797A109A840fa975616499F440C080730E1c6a`.
