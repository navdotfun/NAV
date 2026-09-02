# NAV Protocol — Full Mainnet Platform Test Report

**Date:** 30–31 Aug 2026 · **Network:** Robinhood Chain (4663) · **RPC:** rpc.mainnet.chain.robinhood.com
**Scope:** every deployed contract, all 18 Pit markets, the v4 yield layer, and the live site at nav.fun (desktop + mobile).
**Method:** direct `cast` reads/static-calls against mainnet + Playwright functional pass on the production site. No state-changing transactions sent (token seeding still on hold per instruction).

---

## 1. Verdict

| Layer | Result |
|---|---|
| Wiring & ownership (9 contracts) | **PASS — all correct** |
| PitOracleV2 — 18/18 markets quoting | **PASS** (3 markets TWAP-only, see F-1) |
| Pit pools — 18/18 registered & quoting CALL/PUT | **PASS** |
| Vault / accumulator / splitter statics | **PASS — fail-safe behaviour confirmed** |
| v4 yield layer (hook, router, pyNVDA, pyUSDG) | **PASS — fail-closed as designed (unseeded)** |
| Live site functional pass | **PASS after 2 fixes** (F-2, F-3 — found, fixed, shipped) |

## 2. Wiring & ownership — all PASS

- FeeSplitter → accumulator = AccumulatorV2 v3; feeToken = USDG; split **80.00 / 15.00 / 5.00** (vault/treasury/keeper); splitter balance 0.
- NAVVault v2: **95 registry assets**; NAV totalSupply 1e27 (pre-TGE).
- PitFactory v2: poolCount **18**, feeSink = FeeSplitter, pitFee **2.00%**, keeperFee **0.25%**, not paused.
- AccumulatorV2: maxSwapPerCall 1e9, keeperReward 0.10%.
- PitPoolDeployer.factory and PitTicket.factory both point at PitFactory v2 (ticket is factory-gated by design).

## 3. PitOracleV2 — 18/18 markets quote

`quotePrice` and `spotTwap` agree for all 18 markets (sample, USD): NVDA 218.44 · SPY 778.27 · TSLA 350.69 · MSFT 514.24 · AAPL 321.57 · MU 930.54 · COST 962.91 · GME 19.11 · NFLX 83.87 · CRCL 89.37 … (full 18/18 pass).

**Finding F-1 (operational, pre-launch): RDDT, COST, NFLX run TWAP-only.**
These three have no Chainlink feed on Robinhood Chain (feed=0x0) and the chain's Pyth store is completely virgin — `getPriceUnsafe` reverts for **every** id (even BTC/ETH). Consequences:

- Quoting works (TWAP stands alone when no anchor exists) but the deviation guard is inert for these 3 until a Pyth update is pushed.
- The UI correctly blocks writer deposits there (cold markets, fail-closed).
- Settlement paths: permissionless `pushPythSettlement` (settler brings Hermes bytes) or the 24 h TWAP doomsday fallback — nothing strands.
- **Priming attempt failed from this environment:** Pyth's Hermes API returns 401 from datacenter IPs (tried sandbox, cloud browser, benchmarks endpoint; mirrors don't resolve). **Recommendation:** push one Hermes update per market from a residential connection or with a Hermes API key before launch; that arms the deviation guard chain-wide.

## 4. Pit pools — 18/18 quoting

`poolFor` registry matches the site config for all 18 markets. ATM CALL/PUT premiums quote for all 18 (1 contract, next weekly expiry). Samples: NVDA $6.66/$3.22 · MU $26.90/$16.46 · SPY $14.00/$5.73. Buy statics revert `InsufficientLiquidity` (no writer depth yet — correct pre-launch), `lpDeposit` reverts unfunded, `snapshotSettlement` pre-expiry reverts `NotExpired`, settlementPrice = 0. NVDA pool refs (oracle/factory/ticket) all correct; sigma 50.00%; buckets empty.

## 5. Vault, accumulator, splitter statics

- `redeemableBalance(NVDA)` = 0 (vault unfunded pre-TGE — expected).
- `accumulate(NVDA)` static → `NothingToAccumulate` ✓ · `distribute()` → no-op ✓.
- PitTicket nextId 1, name "Pit Ticket".

## 6. v4 yield layer — fail-closed confirmed

- NavPitHook.feeSplitter = FeeSplitter, feeShare 10.00%; YieldRouter.isVault true for both vaults.
- pyNVDA & pyUSDG: totalAssets = totalSupply = 0, not paused, **maxTotalAssets = 0 → deposits blocked (fail-closed cap, as designed until seeding)**, minFirstDeposit 1 NVDA / 1 USDG, keeper = guardian = deployer, previewDeposit sane (≈0.99997e18 shares per 1e18).

## 7. Live-site functional pass (production, nav.fun)

Desktop 1430px + mobile 375px, fresh contexts, console captured:

| Check | Result |
|---|---|
| Home: title, live ticker ($ prices streaming from chain via browser RPC), powered-by (Chainlink/Pyth/Robinhood) | PASS |
| Vault Terminal `#/app`: 95 assets, redeem preview | PASS |
| The Pit `#/pit`: 95-token registry list, market switch (TSLA), strike grid, premium/P&L panels, CALL/PUT | PASS |
| Yield `#/yield`: vault panels render (fail-closed states) | PASS |
| Docs ×4 (`contracts`, `the-pit`, `yield-layer`, `litepaper`) | PASS |
| Mobile 375px horizontal overflow | none |
| Console errors (all pages, two passes) | **0** |

**Finding F-2 (CRITICAL, launch-blocking — fixed & shipped): UI expiry grid was off the contract grid.**
The UI generated *Friday* 20:00 UTC expiries; the deployed `PitPool.EXPIRY_ANCHOR = 4 days + 20 hours` lands on **Monday** 20:00 UTC (the source comment miscounted the epoch weekday — the epoch began on a Thursday). Since `buy()` reverts `BadExpiry` off-grid, **every buy through the UI would have failed**. Fix: `nextExpiries()` now derives timestamps from the contract's own modular arithmetic — verified UI grid == on-chain `nextExpiryAfter(now)` == 1788206400 (Mon 31 Aug 2026 20:00 UTC); weekday label now computed, all Friday copy corrected to Monday (Home, Pit, PositionBuilder), and the PitPool.sol comment fixed in the repo (source-only; bytecode was always self-consistent). Docs pages contained no Friday references.

**Finding F-3 (HIGH, misleading UX — fixed & shipped): status banner read "0/18 ORACLES ARMED · 3 COLD" all weekend.**
The banner treated any anchor older than 24 h as unarmed, but Chainlink equity feeds idle from Friday close, and the oracle never disarms on staleness — it widens the settlement clamp per 24 h period (capped 7×). The banner now reports **"15/18 ORACLES LIVE · 3 COLD · 15 WIDENED CLAMP"** with explanatory tooltips; red is reserved for genuinely cold markets. Per-market writer gating was already correct and is unchanged.

**Deployment:** new bundle `index-RERD6iW3.js` built, QA'd locally (fresh-context Playwright), pushed via FTP, and re-verified on production: Monday expiries render, banner truthful, 0 console errors. Committed as `a246920` with CHANGELOG entry.

## 8. Pre-launch checklist (open items)

1. **Prime Pyth** for RDDT/COST/NFLX (and ideally all 18) from a residential IP or with a Hermes API key — arms the deviation guard.
2. Token seeding / TGE.
3. First Monday expiry on the live grid: **Mon 31 Aug 2026, 20:00 UTC**.
