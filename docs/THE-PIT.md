# The Pit — NAV's Options Trading Floor

> **Status: LIVE on Robinhood Chain mainnet.** All 22 Pit contracts are deployed and source-verified on Blockscout — 18 PitPool markets, PitFactory, PitOracleV2, PitTicket, PitPoolDeployer (addresses below). This document is the engineering spec and public explainer.

## What it is

**The Pit** is NAV's on-chain options trading floor for tokenized stocks on Robinhood Chain, powered by the **Open Outcry Engine (OOE)** — a regenerative options market maker designed and built by the NAV team.

Two sides of the floor:

- **Traders** buy calls and puts on tokenized stocks. Every position is minted to the buyer's wallet as a **Pit Ticket** — a tradeable ERC-721 recording side, strike, expiry, and size. Maximum loss is the premium paid. There are **no liquidations, ever** — a ticket either expires worthless or is exercised in the money.
- **Liquidity providers** deposit into **strike books**: call books escrow the underlying stock token, put books escrow **USDG**. LPs collect option premiums plus a share of settlement fees on the strikes they choose to sell.

## Why "regenerative"

Every premium paid in The Pit carries a protocol fee that routes through the existing NAV `FeeSplitter` (80 / 15 / 5). **80% of every options fee market-buys tokenized stocks into the NAV vault** — the same one-way valve that backs $NAV today. Options volume becomes $NAV backing, exactly like spot volume. The Pit never touches vault assets; it only feeds them.

## Mechanics

### Strike books
Each underlying (e.g. NVDA-token) gets a `PitPool`. LPs deposit into discrete strike buckets:

- **Call book** — escrow the underlying stock token (1 token per contract) at strikes you choose. If a call expires ITM, the buyer is paid the intrinsic fraction `(settle − strike) ÷ settle` per contract **in the underlying token** from your bucket; you keep the premium either way.
- **Put book** — escrow **USDG** (full strike value per contract) at strikes you choose. If a put expires ITM, the buyer is paid `(strike − settle) × qty` **in USDG** from your bucket; you keep the premium either way.

Because calls lock a full underlying token and puts lock the full strike value, max payout ≤ locked collateral at **any** settlement price — solvency by construction.

Deposits sold against an open ticket are locked until that ticket's expiry. Unsold liquidity withdraws freely.

### Pricing
Premiums are quoted on-chain from a **manipulation-resistant TWAP** of the underlying pool plus a per-market, governance-bounded volatility parameter: `premium = intrinsic + time value(TWAP, σ, T)`. Single-block price pushes cannot move the TWAP window; quotes revert if spot diverges from TWAP beyond a safety band.

### Settlement
European-style, **cash-settled** — there is no physical delivery at strike and nothing to exercise manually. After expiry, the settlement price is fixed from the oracle TWAP and each series is reconciled; ITM tickets are paid their intrinsic value straight from the strike book (calls in the underlying token, puts in USDG) and the remaining collateral unlocks back to LPs. Anyone can trigger settlement for a keeper fee after a grace window. A settlement fee (protocol share) routes to the FeeSplitter.

### Quick Ticket
The one-input mode: pick a ticker, a direction, and a time horizon — the engine matches the nearest funded strike and quotes the premium. Options UX without the options vocabulary.

## $NAV utility

- **Fee rebates** — staking $NAV reduces the trader-side settlement fee.
- **Backing** — 80% of all Pit protocol fees buy stocks into the NAV vault.
- **Collateral (later phase)** — $NAV as premium payment asset at a rebate.

## Architecture

| Contract | Role |
| --- | --- |
| `PitFactory` | Deploys and registers a `PitPool` per underlying; enforces canonical stock-token registry (same registry discipline as NAVVault). |
| `PitPool` | Strike books, LP accounting, premium quoting, locking, settlement per underlying. |
| `PitTicket` | ERC-721 positions (side, strike, expiry, qty, premium paid). Transferable; tradable on any NFT marketplace. |
| `PitOracleV2` | Chainlink-anchored price reads with automatic Pyth backup; pool TWAP deviation-checked against the anchor. Fully pull-based — no heartbeats or keepers. |
| Fee routing | Existing `FeeSplitter` (80 / 15 / 5) — no new trust assumptions. |

**Trust profile (same as NAV core):** no proxies, no upgradeable code, fixed fee bounds, no admin path to LP funds or ticket payouts, all parameters timelock-bound at launch.

## Security programme

The internal campaign is **complete** — the Pit's contracts passed the full NAV security programme:

1. **Unit tests** over every function and revert path — pricer, oracle, pool lifecycle, factory (82 tests).
2. **Fuzz testing** — every economic property verified across 4,096 randomized runs each: solvency at any settlement price, LP loss bounded by locked collateral, payouts never above intrinsic value, premiums never below intrinsic at sale, no profitable deposit/withdraw round-trip, premium time-decay monotonicity.
3. **Invariant / stateful testing** — 8 protocol invariants (per-bucket solvency, asset conservation, fee exactness, ticket↔collateral bijection, settlement totality) held through 12,800 randomized multi-actor calls including price shocks, time jumps, and direct token donations.
4. **Attack-vector suites** — 16 adversarial scenarios defended: share-inflation, TWAP manipulation at settlement, stale-oracle games, freeze-window front-running, ERC-721 reentrancy callbacks, balance poisoning, double-settlement, OI-cap bypass.
5. **Static analysis** (Slither) — every in-scope finding triaged; zero actionable.
6. Three defects were found by the campaign and fixed before any deployment — including a settlement-oracle liveness flaw that could have stranded collateral. Finding them is the point of the campaign.
7. **Third-party audit** before unrestricted mainnet exposure, alongside the core protocol audit.

## Deployed addresses — Robinhood Chain mainnet (LIVE, verified)

Pit stack redeployed 31 Aug 2026 (v6 security campaign — premium-dust fix V6-01 baked into every pool; the retired v2 stack held zero user funds). All contracts source-verified on Blockscout (solc 0.8.36).

### Infrastructure

| Contract | Address | Explorer |
|---|---|---|
| PitOracleV2 — Chainlink anchor + Pyth backup, divergence guards | `0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd` | [verified source](https://robinhoodchain.blockscout.com/address/0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd?tab=contract) |
| PitFactory — pool registry, pause, params | `0x63859B6f3F6A717c35a872B55eaA0F2B6e7fDB77` | [verified source](https://robinhoodchain.blockscout.com/address/0x63859B6f3F6A717c35a872B55eaA0F2B6e7fDB77?tab=contract) |
| PitTicket — ERC-721 positions, on-chain SVG | `0xd51C868353c084DA4c7685d755E7BFb9D41CA7b4` | [verified source](https://robinhoodchain.blockscout.com/address/0xd51C868353c084DA4c7685d755E7BFb9D41CA7b4?tab=contract) |
| PitPoolDeployer — pool creation code (EIP-170 headroom) | `0x1600b2fe71F39216Eb3a7C04c626C9EdF75F3B7d` | [verified source](https://robinhoodchain.blockscout.com/address/0x1600b2fe71F39216Eb3a7C04c626C9EdF75F3B7d?tab=contract) |

### Markets — 18 live PitPools

Strike spacing ≈2.5% of spot at configuration, snapped to 1/2/5 steps; σ (annualized, immutable per pool) set per asset class. Quote asset USDG. Markets are permissionless to extend: `createPool` accepts any vault-listed asset once its oracle market is configured — the 18 below are the launch set, not a cap.

| Underlying | PitPool | Strike step | σ | Explorer |
|---|---|---|---|---|
| NVDA | `0x8d7B83931e60e6a8364335C9aa62003Cf7Ae53Cf` | $5 | 50% | [verified source](https://robinhoodchain.blockscout.com/address/0x8d7B83931e60e6a8364335C9aa62003Cf7Ae53Cf?tab=contract) |
| SPCX | `0x1a446B069AaCeC3873F9d0F6EF7f334248e15cBe` | $2 | 90% | [verified source](https://robinhoodchain.blockscout.com/address/0x1a446B069AaCeC3873F9d0F6EF7f334248e15cBe?tab=contract) |
| AMZN | `0xd041577c8d473423Db9004677C44bCdfEc9D79aF` | $5 | 35% | [verified source](https://robinhoodchain.blockscout.com/address/0xd041577c8d473423Db9004677C44bCdfEc9D79aF?tab=contract) |
| GME | `0x009F1EE1bC5C0cec9f754FC98FD66C91b1fDA422` | $0.2 | 100% | [verified source](https://robinhoodchain.blockscout.com/address/0x009F1EE1bC5C0cec9f754FC98FD66C91b1fDA422?tab=contract) |
| GOOGL | `0x16A0eBE405897B626BE3cB9881C9F6Cf9b3AD853` | $5 | 32% | [verified source](https://robinhoodchain.blockscout.com/address/0x16A0eBE405897B626BE3cB9881C9F6Cf9b3AD853?tab=contract) |
| MU | `0x906D8334c6b59cBa02DB40d714e967b7921464d4` | $20 | 60% | [verified source](https://robinhoodchain.blockscout.com/address/0x906D8334c6b59cBa02DB40d714e967b7921464d4?tab=contract) |
| QQQ | `0x0a4557b8167B4425922ef8F5CeB743E2fd9406A6` | $20 | 25% | [verified source](https://robinhoodchain.blockscout.com/address/0x0a4557b8167B4425922ef8F5CeB743E2fd9406A6?tab=contract) |
| USO | `0xdA7f45f33D9eca6C633F91662e08626fe720b270` | $2 | 40% | [verified source](https://robinhoodchain.blockscout.com/address/0xdA7f45f33D9eca6C633F91662e08626fe720b270?tab=contract) |
| SLV | `0xF6E2524E33840c93823500569D2Dc9200DEC4cd5` | $1 | 30% | [verified source](https://robinhoodchain.blockscout.com/address/0xF6E2524E33840c93823500569D2Dc9200DEC4cd5?tab=contract) |
| META | `0x54EEbB729491E324a7Bb7f92D7c6f6a5E8b48BDE` | $10 | 40% | [verified source](https://robinhoodchain.blockscout.com/address/0x54EEbB729491E324a7Bb7f92D7c6f6a5E8b48BDE?tab=contract) |
| AAPL | `0x305192fa78dc0ceAf9470CEd0f4472263C006D76` | $5 | 30% | [verified source](https://robinhoodchain.blockscout.com/address/0x305192fa78dc0ceAf9470CEd0f4472263C006D76?tab=contract) |
| TSM | `0xA13C3af9b992e88d796a630932D050a9520eB1D2` | $10 | 40% | [verified source](https://robinhoodchain.blockscout.com/address/0xA13C3af9b992e88d796a630932D050a9520eB1D2?tab=contract) |
| SPY | `0xc8eE90783dBEfE504C7029Ce90A9B54dd6a7F5a6` | $10 | 25% | [verified source](https://robinhoodchain.blockscout.com/address/0xc8eE90783dBEfE504C7029Ce90A9B54dd6a7F5a6?tab=contract) |
| TSLA | `0xE3322015C8F19E194a08457bb97D3FB5d264cf1E` | $5 | 60% | [verified source](https://robinhoodchain.blockscout.com/address/0xE3322015C8F19E194a08457bb97D3FB5d264cf1E?tab=contract) |
| MSFT | `0x4796a05dD57c13C31753B284DbDB64c616fcb18c` | $10 | 30% | [verified source](https://robinhoodchain.blockscout.com/address/0x4796a05dD57c13C31753B284DbDB64c616fcb18c?tab=contract) |
| CRCL | `0x75CAf294de88963DE7B94b222860ccbbEc80E9B3` | $2 | 90% | [verified source](https://robinhoodchain.blockscout.com/address/0x75CAf294de88963DE7B94b222860ccbbEc80E9B3?tab=contract) |
| PLTR | `0x9E4433c10Df0c8761B0922FB74b673b0F18291F5` | $2 | 70% | [verified source](https://robinhoodchain.blockscout.com/address/0x9E4433c10Df0c8761B0922FB74b673b0F18291F5?tab=contract) |
| AMD | `0xc7168D52942d135C419A87244b91915a00fc53A5` | $10 | 50% | [verified source](https://robinhoodchain.blockscout.com/address/0xc7168D52942d135C419A87244b91915a00fc53A5?tab=contract) |

Fee routing on every premium: existing FeeSplitter — 80% market-buys stock tokens into the NAV vault, 15% ops, 5% LP incentives.

**Delisted markets (31 Aug 2026).** The original RDDT (`0x3a689a778C38b6C6161DC69cF5Cc8442a1bC6561`), COST (`0x82b71a458A5c50ff0F5e81328b89A5D65E68464e`) and NFLX (`0x6ab01d5ee8426D7B580A090a9c5C1FFCb65fEaD3`) pools were deployed before it was established that **no Chainlink Data Feed exists on Robinhood Chain for those tickers** (verified by enumerating every contract created by the Chainlink deployer). An MSTR pool (`0xe064720F11c96Ecd82b9139aC05f6ae2a0D0D0a7`) was configured as a replacement but its underlying AMM pool is dislocated ~89% above the Chainlink anchor, so the oracle fail-closes quoting on it — it stays delisted until arbitrage normalises the pool. All four contracts remain deployed, verified and solvent with zero open interest; they are simply not offered in the interface. QQQ, META and AMD replaced them with full Chainlink + Pyth + TWAP oracle coverage.

*The Pit is an original NAV design in the emerging category of regenerative options market makers on Robinhood Chain.*
