# NAV Options — Technical Specification (v1.0)

**Codename:** `NavOptions` — covered, prepaid, oracle-settled options on tokenized equities
**Status:** SPEC FINAL — pre-implementation
**Chain:** Robinhood Chain mainnet (4663)
**Author:** NAV protocol engineering
**Date:** 2026-09-01

---

## 0. Design mandate

1. **Insolvency must be impossible by construction.** Every option's maximum payout is
   physically escrowed in the contract before the position exists. No margin, no
   liquidations, no keepers, no debt path. The engine can never owe more than it holds.
2. **Uniswap pools are the substrate.** Pool depth gates market availability; pool fee
   accumulators price the premium; the oracle's TWAP leg reads the pool. No IV oracle,
   no market makers, no order book.
3. **Fully decentralised.** No admin keys, no upgradability, no schedulers. All
   maintenance (fee snapshots, settlement) is permissionless and bounty-incentivised,
   following the live `crank()` / `accumulate()` pattern.
4. **Plugs in beside the live protocol.** Zero changes to deployed contracts. Consumes
   PitOracleV2 (read + permissionless snapshot), pays the live AccumulatorV2, uses the
   live stock/USDG pools read-only.
5. **No synthetic data.** All economic parameters below are calibrated from on-chain
   measurements taken 2026-09-01 (documented in §12).

## 1. Product definition

European cash-covered options, bought with USDG, settled at expiry against the
oracle settlement snapshot.

| Property | Value |
|---|---|
| Style | European (exercise only at expiry, auto via `settle()`) |
| Direction | CALL or PUT (buyer long only; the writer side is the vault) |
| Terms | 1 h, 1 d, 3 d, 7 d (expiry rounded UP to the next hour boundary) |
| Strikes | Buckets vs oracle quote at open: ATM (100%), OTM5 (±5%), OTM10 (±10%) |
| Premium currency | USDG, fully prepaid at open |
| Settlement | CALL pays in stock units; PUT pays in USDG — always from escrow |
| Transferability | Non-transferable in v1 |
| Early close | None in v1 (hold to expiry) |

**Markets at launch** (immutable constructor list — each with its canonical
stock/USDG Uniswap V3 pool and a minimum-liquidity gate):

| Market | Token | Pool fee tier |
|---|---|---|
| NVDA | 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC | 0.05% |
| SPCX | 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa | 0.05% |
| RDDT | 0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C | 1.00% |
| USO  | 0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344 | 0.30% |

All four are registered in PitOracleV2 with live Chainlink/Pyth anchors (verified
on-chain 2026-09-01). Token0/token1 ordering varies per pool (RDDT and SPCX sort
below USDG; NVDA and USO sort above) — the engine stores `usdgIsToken0` per market.

## 2. Actors

- **Buyer** — pays USDG premium + origination fee, receives position, collects payout
  after expiry via permissionless settlement.
- **Writer (vault depositor)** — deposits stock (CALL side) or USDG (PUT side) into
  the engine's internal per-market, per-side vault. Earns 96% of every premium.
  Withdraws any time up to free (unescrowed) capital.
- **Settler** — anyone; calls `settle(id)` after expiry for a bounty.
- **Snapshotter** — implicit; fee-growth snapshots are pushed by any state-changing
  interaction (no dedicated role needed).
- **Protocol** — receives origination fee + 4% of premium, both pushed directly to
  the live AccumulatorV2 (same artery as the Floor router's 20 bps).

## 3. Contract topology

ONE new immutable contract: `src/options/NavOptions.sol`. No proxy, no owner, no
pausability, no parameter setters. All addresses and parameters are `immutable` or
`constant`. Interfaces consumed (all live, none modified):

```
PitOracleV2   quotePrice(address) → uint256 1e18        (open-time pricing, deviation-banded)
              snapshotSettlement(address,uint64) → uint256 (permissionless settle price)
              settlementPrice(address,uint64) → uint256   (idempotent read)
IUniswapV3Pool liquidity(), slot0(), feeGrowthGlobal{0,1}X128()  (read-only)
IERC20        USDG (6 dec), stock tokens (18 dec) — safeTransfer/TransferFrom
AccumulatorV2 plain USDG transfers (router pattern, line-for-line)
```

## 4. Vault (writer) accounting

Internal share-based vaults; one per (market, side). No ERC-20 share token in v1
(positions queried via views; keeps surface minimal).

```
struct Side {
  uint128 totalShares;     // internal shares
  uint128 assets;          // total native asset (stock for CALL side, USDG for PUT side), incl. escrowed
  uint128 escrowed;        // committed against open positions; escrowed ≤ assets
  uint128 premiumUsdg;     // CALL side only: accrued USDG premiums (PUT side folds premium into assets)
}
```

- `deposit(marketId, side, amount)` → shares minted `amount × totalShares / assets`
  (floor). **Inflation-attack hardening:** OZ-style virtual offset — share math uses
  `totalShares + 1e3` and `assets + 1`, so the first-depositor donation attack is
  economically dead (verified by dedicated test).
- `withdraw(marketId, side, shares)` → pro-rata native asset **and** (CALL side)
  pro-rata `premiumUsdg`, floored, limited to free assets (`assets − escrowed`).
  If the pro-rata native amount exceeds free assets → revert (writer waits for
  settlements; never blocks longer than the longest open term, 7 days).
- All rounding favours the vault (mint floors shares, withdraw floors assets).

## 5. Open — the buyer path

`open(marketId, isCall, bucket, size, term) → id` (nonReentrant, CEI):

1. **Oracle price** `S = quotePrice(token)` — reverts on TWAP-vs-anchor deviation
   (this is the manipulation gate: a bent pool cannot produce a quote).
2. **Depth gates** (all atomic in the same tx):
   - `pool.liquidity() ≥ MIN_LIQ[m]` (per-market immutable, calibrated §12)
   - Band depth: USDG value of in-range liquidity across ±2% of spot,
     `D = bandValueUsdg(L, sqrtP)`; require `oiNotional[m] + notional ≤ 20% × D`
   - Free capital: CALL `size ≤ freeAssets(CALL)`; PUT `ceil(size×K) ≤ freeAssets(PUT)`
3. **Strike** `K = bucket × S` (ATM 100%, CALL OTM 105/110%, PUT OTM 95/90%),
   recorded absolute. **Expiry** `= ceil((now + term) / 1h) × 1h` (shared snapshots).
4. **Premium** (§6): `prem = max(base × MULT × bucketFactor, floor) + intrinsic`,
   ceil-rounded in USDG. `notional = size × S` (USDG, 6 dec, ceil).
5. **Transfers in:** buyer pays `prem + origination` USDG.
   `origination = 20 bps × notional` → **immediately** to AccumulatorV2.
   `4% × prem` → immediately to AccumulatorV2.
   `96% × prem` → PUT side: `assets += …`; CALL side: `premiumUsdg += …`.
6. **Escrow:** CALL: `escrowed += size` (stock). PUT: `escrowed += ceil(size×K)` (USDG).
7. Position stored; `Opened` event with full economics.

## 6. Premium formula (pool-fee streamia)

The premium is what the escrowed capital would have earned as in-range Uniswap
liquidity over the term, times a spread multiplier — measured, not modelled.

**Fee-growth snapshots.** Ring buffer of 24 per market `{ts, fgUsdgX128}` where
`fgUsdgX128 = fg0 + fg1 × S / 1e30` normalised so both sides are USDG (6 dec) per
unit L, X128 (ordering flag applied per market). A snapshot is pushed by ANY
state-changing call if the newest is ≥ 20 min old — organic traffic maintains the
buffer; no keeper.

**Rate.** Quoting selects the oldest snapshot aged between 4 h and 48 h:
```
ΔfeePerL   = fgNowUsdgX128 − fgRefUsdgX128            (monotone, X128)
vPerL      = bandValueUsdgPerL(sqrtP)                  (USDG value of 1 unit L in ±2% band)
dailyRate  = (ΔfeePerL / 2^128) / vPerL × 86400/Δt     (1e18 fixed)
```
If no snapshot in the window (cold start / dormant market) → `dailyRate = 0` and
the **floor** rate prices the option alone. Manipulation economics: inflating
`ΔfeePerL` requires paying real swap fees into the pool for hours — cost equals the
inflation, and the CAP bounds any residual effect.

**Quote.**
```
base       = notional × min(max(dailyRate, FLOOR 8bps/d), CAP 300bps/d) × termDays
prem       = base × 1.25 × bucketFactor           bucketFactor: ATM 1.00 / OTM5 0.55 / OTM10 0.30
prem      += intrinsic                            CALL: max(0,S−K)×size/1e18 ; PUT: max(0,K−S)×size/1e18
```
1-hour term uses `termDays = 1/24` with an absolute minimum of 2 bps of notional.
All divisions ceil against the buyer. `previewOpen(...)` view returns the exact
quote the UI displays — bit-parity tested against the TS frontend implementation.

## 7. Settle — permissionless, bounty-cranked

`settle(id)` (nonReentrant), callable by ANYONE once `now ≥ expiry`:

1. `P = oracle.settlementPrice(token, expiry)`; if unset, call
   `oracle.snapshotSettlement(token, expiry)` (permissionless; resolves the price
   AT the expiry timestamp from Chainlink round bracketing / pushed Pyth — the
   caller cannot influence it; see PitOracleV2 §settlement).
2. Payout from escrow, capped by escrow (cap provably never binds except by 0-dust):
   - CALL: `payoutStock = size × max(0, P−K) / P` (floor) → buyer receives stock
     (instantly sellable on Floor via the live router).
   - PUT: `payoutUsdg = size × max(0, K−P) / 1e18` (floor, 6 dec) → buyer receives USDG.
3. Remainder of escrow released back to the side's free assets.
4. **Bounty** to `msg.sender` from the released remainder:
   `min(5 bps × escrowReleased, 25 USDG-equivalent)` (stock side converted at P).
   If remainder < bounty, bounty = remainder (never touches other positions' escrow).
5. Position marked settled (idempotent; double-settle reverts).

There is deliberately **no** price-risk window: the settlement price is anchored to
the expiry timestamp by the oracle regardless of when `settle()` lands.

## 8. Fee flows (protocol revenue)

| Stream | Rate | Destination |
|---|---|---|
| Origination | 20 bps of notional at open | AccumulatorV2 (immediate USDG transfer) |
| Premium cut | 4% of charged premium (= 20% of the 0.25 spread) | AccumulatorV2 |
| Writer yield | 96% of charged premium | vault side (assets / premiumUsdg) |
| Settle bounty | ≤ 5 bps of released escrow, cap 25 USDG-eq | settler (paid by writer side) |

Conservation invariant: every USDG entering `open()` is exactly partitioned into
{Accumulator, writer credit}; every escrow unit released at settle is exactly
partitioned into {buyer payout, bounty, writer free assets}. No residue.

## 9. Security invariants (machine-checked)

- **I1 Coverage:** ∀ open position: CALL escrow `= size ≥ size×(P−K)/P` ∀P; PUT escrow
  `= ceil(size×K) ≥ size×(K−P)` ∀P≥0. Max payout ≤ escrow at every price.
- **I2 Escrow ledger:** Σ position escrows = `side.escrowed ≤ side.assets`; engine
  token balance ≥ Σ sides' (assets + premiumUsdg) per token, always.
- **I3 Writer safety:** share redemption value is non-decreasing under third-party
  actions except settlement payouts, which draw only from that position's escrow.
- **I4 Pricing floor:** premium ≥ max(floor, intrinsic + term minimum) > 0 in all states.
- **I5 Gates:** open() reverts when liquidity gate, band-depth cap, deviation band,
  or free-capital check fails — no bypass path.
- **I6 Settlement:** only post-expiry, exactly once, price = oracle snapshot at the
  expiry timestamp; unsettleable positions cannot exist (oracle has TWAP fallback).
- **I7 Immutability:** no admin, no upgrade, no selfdestruct, no delegatecall; only
  external calls: 4 tokens, oracle, pools (view), Accumulator (transfer).
- **I8 Conservation:** exact USDG/stock partition per §8, fuzz-checked to the wei.
- **I9 Rounding:** buyer pays ceil, vault credits floor ⇒ dust accumulates to the
  vault, never against it.
- **I10 Liveness:** withdraw of free assets always succeeds; free assets fully
  unlock within ≤ 7 days (longest term) of last open.

## 10. Threat model & mitigations

| Threat | Mitigation |
|---|---|
| Pool price manipulation at open | quotePrice = 30-min TWAP banded vs Chainlink/Pyth anchor (reverts on deviation) |
| Fee-growth inflation (wash trading) to raise premiums | attacker pays real fees ≈ the inflation; CAP 300bps/day bounds it; hurts buyers not solvency |
| Fee-growth starvation (quiet market → cheap options) | FLOOR 8 bps/day + intrinsic always charged; OTM factors calibrated conservative |
| Settlement timing games | price fixed AT expiry by oracle bracketing — settle timing is economically irrelevant |
| First-depositor share inflation | virtual offset (1e3 shares / 1 asset) + dedicated test |
| Donation attacks on assets | share math uses internal `assets`, not `balanceOf` |
| Reentrancy | nonReentrant on all mutating fns; strict CEI; tokens are known-standard |
| Griefing via dust positions | MIN_NOTIONAL 10 USDG per open |
| Oracle dead (both anchors) | open() reverts (quotePrice reverts); settle falls back per oracle logic; funds never strandable — settle always eventually callable |
| Writer bank-run vs escrow | withdrawals bounded by free assets (I10); escrow never withdrawable |

## 11. What v1 deliberately does NOT do (v2 roadmap)

- **No LP deployment of idle vault capital.** In v2, uncommitted vault capital can be
  deployed as single-sided ranges via NPM for extra yield; v1 keeps capital idle in
  the engine because range re-arming after price crossings requires swaps — an
  attack surface we refuse to bundle into the first audit. Writer yield in v1 is
  pure premium flow (§12 economics still attractive).
- No early close / secondary transfer; no American exercise; no cross-margin.
- No per-position NFT (PitTicket untouched).

## 12. Calibration — measured on-chain 2026-09-01

- NVDA/USDG 0.05% pool `0xd4EB…14a3`: in-range L ≈ 8.8e18, USDG-side band depth
  ≈ $2.7 M; fee-accumulator delta over a clean 684 s window = $38.15 (USDG side)
  + $42.8 (NVDA side) ⇒ **≈ $10.2 K/day LP fees, ~68% fee APR, ~$20 M/day volume**.
- Implied ATM quotes at measured rate (dailyRate ≈ 19 bps/d, before floor/cap):
  1d ≈ 0.24%, 3d ≈ 0.71%, 7d ≈ 1.66% of notional (×1.25, ATM factor 1.0).
- Depth caps at launch (20% of ±2% band): NVDA ≈ $540 K OI; SPCX ≈ $106 K;
  RDDT ≈ $101 K; USO ≈ $74 K. MIN_LIQ per market set to half the 2026-09-01
  measured in-range liquidity (markets must stay at least half as deep as today).
- Revenue at cap utilisation (NVDA alone): ≈ $430/d origination (5-day OI turnover)
  + ≈ $100/d premium cut ⇒ **≈ $500+/day** to the Accumulator, before growth.

## 13. Test & audit programme (acceptance criteria)

1. **Unit:** every function, every revert path (~70 tests).
2. **Fuzz:** per-function fuzz (bounds: sizes 1 wei…1e24, prices 1e12…1e26, all
   buckets/terms/markets), ≥ 256 runs each locally, campaign below.
3. **Invariant:** handler-based stateful suite asserting I1–I10 after every op
   (open/settle/deposit/withdraw/snapshot/warp), depth ≥ 15, multi-seed campaign:
   **10 seeds, ≥ 1 M runs cumulative minimum** (target parity with router campaign).
4. **Fork:** real-pool reads (NVDA/SPCX/RDDT/USO), real oracle quotes, full
   open→warp→settle cycle against forked mainnet state.
5. **Adversarial:** inflation attack, donation, fee-growth manipulation replay,
   settlement race, dust griefing, term/bucket boundary abuse.
6. **Audits:** two independent structured audits (A: economic attack surface,
   B: Solidity correctness) + consolidated report, before any deployment.
7. **Frontend:** quote parity fuzz (TS vs contract `previewOpen`, ≥ 1 M cases),
   full UI fuzz, Playwright live QA, then real-money mainnet smoke (open a 1 h
   NVDA option with the burner, settle it after expiry, verify every fee leg).
8. **Deployment:** only after 1–7 pass with zero failures; Sourcify exact-match
   verification; docs + changelog same day.

## 14. Frontend (Floor terminal)

New `OPTIONS` view (function key slot next to SWAP): market picker (gated list with
live depth readouts), CALL/PUT toggle, bucket/term selectors, size input, live quote
panel (premium breakdown: base/spread/intrinsic/origination — mirrors `previewOpen`
exactly), positions blotter with countdown + settle button (bounty shown), writer
panel (deposit/withdraw both sides, share value, premium accrual, free vs escrowed).
Bloomberg-terminal aesthetic, amber-on-black, IBM Plex Mono — unchanged.
