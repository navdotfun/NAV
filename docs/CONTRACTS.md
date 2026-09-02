# NAV — Contract Architecture (v0.1)

Target chain: Robinhood Chain mainnet (Arbitrum Orbit L2). Solidity ^0.8.24, OpenZeppelin 5.x.

## Deployed addresses — Robinhood Chain mainnet (LIVE, verified)

Current stack deployed 30 Aug 2026 (audit-v4 wave). All contracts source-verified on Blockscout (exact match, solc 0.8.36).

| Contract | Address | Explorer |
|---|---|---|
| NAVToken — "Net Asset Value" ($NAV), 1B fixed | `0x3e7f2c3A81a1c8302eacE254928e0fBa5A3Bc447` | [verified source](https://robinhoodchain.blockscout.com/address/0x3e7f2c3A81a1c8302eacE254928e0fBa5A3Bc447?tab=contract) |
| **NAVVault v2** — 95 assets registered, audit-v4 hardened | `0xb8F008322671179E2C93dd8610be8d5D7876087b` | [verified source](https://robinhoodchain.blockscout.com/address/0xb8F008322671179E2C93dd8610be8d5D7876087b?tab=contract) |
| **AccumulatorV2 v3** — router-free, TWAP-floored, fee stream live | `0x3620Da2708734d1eE64D929cF9a05EAf9a7778a0` | [verified source](https://robinhoodchain.blockscout.com/address/0x3620Da2708734d1eE64D929cF9a05EAf9a7778a0?tab=contract) |
| FeeSplitter (80/15/5) | `0x6bCA8944F711A2299a20ecb02E7AE25d78f81Ca2` | [verified source](https://robinhoodchain.blockscout.com/address/0x6bCA8944F711A2299a20ecb02E7AE25d78f81Ca2?tab=contract) |

Retired (verified, zero funds, no longer wired): NAVVault v1 `0x800c71a019E76bd51bb6121a96d648e4148ba60B`, Accumulator v1 `0xBE661B2ea527E48A6d537DcC79828534EC0fa6DC`, AccumulatorV2 v2 `0x75Aa29b29370f51fA710A6Eb4E9ba0DC02F845d8`, PokeBounty `0xA06B7a5dE7396997ee157f8Ad80B4751E5F18D5C` — PitOracleV2 reads Chainlink/Pyth directly on-chain, so heartbeat bounties are obsolete.

Status: contracts live and wired (vault ↔ accumulator ↔ splitter); registry seeded with all 95 verified Stock Token / tokenized-ETF contracts. **TGE executed 31 Aug 2026** — see below.

### TGE — $NAV/WETH listing (LIVE, 31 Aug 2026)

100% of supply (1,000,000,000 NAV) + 5 ETH seeded full-range into a Uniswap v3 pool (1% fee tier, tickSpacing 200, ticks ±887200, token0 = WETH). Opening price 200,000,000 NAV/WETH (sqrtPriceX96 `1120455419495722798374638764549163`, tick 191147). The LP NFT was immediately locked in a 30-day timelock; nothing withheld — deployer retains only rounding dust.

| Item | Address / value | Explorer |
|---|---|---|
| NAV/WETH pool (Uniswap v3, 1%) | `0x24c0B949ca94E90f325CE7Fd8D6E8b6EE92De20E` | [pool](https://robinhoodchain.blockscout.com/address/0x24c0B949ca94E90f325CE7Fd8D6E8b6EE92De20E) |
| LpTimelock (30-day LP lock) | `0xA5782C0A38b5d2C9fec4A6F11d2c0a94A21D36c6` | [verified source](https://robinhoodchain.blockscout.com/address/0xA5782C0A38b5d2C9fec4A6F11d2c0a94A21D36c6?tab=contract) |
| LP position NFT | tokenId `921454` (NonfungiblePositionManager `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`) | [lock tx](https://robinhoodchain.blockscout.com/tx/0xf701440e3552148d0924d912843a591f073c40b054b2097b0147cd958f4e30fa) |
| Lock controller | deployer `0xa55e7Cc7cF79f2AECb5AA9D377a1ed59aA95998d` | — |
| Unlock time | `1790800516` (30 Sep 2026 20:35 UTC) — `extend`/`extendBy` forward-only, `release(to)` to any wallet after expiry, `collectFees(to)` any time (fees only) | — |

LpTimelock cannot decrease liquidity (no such function exists in the contract); Sourcify exact match [46958586](https://sourcify.dev/server/v2/contract/4663/0xA5782C0A38b5d2C9fec4A6F11d2c0a94A21D36c6). `NavLister.sol` (atomic list-and-lock helper) is in the repo for future listings but the live TGE executed via direct NPM calls + separate lock.

### The Pit — options layer (LIVE, verified)

22 further contracts deployed and source-verified 30 Aug 2026; the full Pit stack (factory, ticket, deployer and every pool) was redeployed and re-verified 31 Aug 2026 as part of the v6 security campaign to pick up the premium-dust fix (V6-01) before launch — the retired v2 stack held zero user funds: **`PitOracleV2`** `0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd` (Chainlink anchor + Pyth backup, no keepers or heartbeats), `PitFactory` `0x63859B6f3F6A717c35a872B55eaA0F2B6e7fDB77`, `PitTicket` `0xd51C868353c084DA4c7685d755E7BFb9D41CA7b4`, `PitPoolDeployer` `0x1600b2fe71F39216Eb3a7C04c626C9EdF75F3B7d`, plus 18 live `PitPool` markets (NVDA, SPCX, AMZN, GME, GOOGL, MU, QQQ, USO, SLV, META, AAPL, TSM, SPY, TSLA, MSFT, CRCL, PLTR, AMD — QQQ `0x0a4557b8167B4425922ef8F5CeB743E2fd9406A6`, META `0x54EEbB729491E324a7Bb7f92D7c6f6a5E8b48BDE` and AMD `0xc7168D52942d135C419A87244b91915a00fc53A5` replaced the feedless RDDT/COST/NFLX pools on 31 Aug 2026; an MSTR pool `0xe064720F11c96Ecd82b9139aC05f6ae2a0D0D0a7` is deployed but delisted while its AMM pool is dislocated from the Chainlink anchor). Full per-market table with strike steps, sigmas and explorer links: [THE-PIT.md](THE-PIT.md).

### NavCrank — permissionless fee pipeline (LIVE, verified)

Deployed 1 Sep 2026 after a four-round audit programme (3 independent audit passes, 1,050,000 fuzz cases, 190,800 stateful invariant sequences, Slither clean, 419-test regression). One public `crank()` call executes the entire fee pipeline in a single transaction: collect LP fees from the locked position → burn 100% of the NAV side → TWAP-guarded WETH→USDG swap → 80/15/5 split → up to 3 tokenized-asset buys via AccumulatorV2 → caller reward. Anyone can call it; a 30-minute cooldown and per-call caps bound extraction. Owner is the LpTimelock's former controller path — `renounceOwnership()` is disabled by design so the timelock can never be stranded.

| Item | Value | Explorer |
|---|---|---|
| **NavCrank** | `0x15F15c5513fb076ffaD48c80Ad65CC3EB009dD1e` | [Blockscout](https://robinhoodchain.blockscout.com/address/0x15F15c5513fb076ffaD48c80Ad65CC3EB009dD1e?tab=contract) · [Sourcify exact match](https://sourcify.dev/server/v2/contract/4663/0x15F15c5513fb076ffaD48c80Ad65CC3EB009dD1e) |
| Deploy tx | `0x66f777526db8979ff86b73c53441391a359f6d5741bb5776ef3b25a19c4fd116` | [tx](https://robinhoodchain.blockscout.com/tx/0x66f777526db8979ff86b73c53441391a359f6d5741bb5776ef3b25a19c4fd116) |
| LpTimelock controller handover | `transferController` + `acceptTimelock` (two-step) | [accept tx](https://robinhoodchain.blockscout.com/tx/0x1c076d92173749498f747c299c21f2360f6600f16e1f5f40e41a5167ece9eab3) |
| First public crank | 1.65M NAV burned, 740 USDG split | [tx](https://robinhoodchain.blockscout.com/tx/0x8d25baf2c703065db801cf25ea20181f3863efc10ccd59bd14a34f0baf29d541) |
| Params (live) | rotation 19 assets · minWethSwap 0.0005 · maxWethPerCrank 2 · minAccumulate 10 USDG · slippage 100 bps vs 30-min TWAP · cooldown 1800s | — |

**Keeper note (F-02, operational):** `eth_estimateGas` converges on the cheapest successful path — the no-buy path (~437k gas) — because `crank()` requires `gasleft() ≥ 600,000` before each buy leg. A transaction sent at the raw estimate will succeed but execute zero buys. **Callers should send `crank()` with a gas limit of 3,000,000** (unused gas is refunded). The nav.fun frontend does this automatically; fork-verified at gas caps 0.5M→0 buys, ≥1.1M→buys execute. **Mainnet proof:** crank tx [`0x7f83191a…dc5a92`](https://robinhoodchain.blockscout.com/tx/0x7f83191af89ab9cce4770bff3051453d7f69315149cea9ee82679b8b22dc5a92) (block 51357034, 762,595 gas) executed the buy leg — 78,576 NAV burned, 89.38 USDG split, and the full 663.6 USDG buy queue swapped into 2.0887 AAPL for the vault, 0.66 USDG keeper reward paid.

### The Yield Layer — Uniswap v4 (LIVE, verified)

Deployed 30 Aug 2026 (solc 0.8.26, via-IR). NVDA market first; the FeeSplitter's 80% stream now feeds AccumulatorV2.

| Contract | Address | Explorer |
|---|---|---|
| NavPitHook — fee-skim hook (vault positions only) | `0xf45510A5cA0ecBa81C8998983d7fF1366849E503` | [verified source](https://robinhoodchain.blockscout.com/address/0xf45510A5cA0ecBa81C8998983d7fF1366849E503?tab=contract) |
| YieldRouter — sole liquidity mover, slippage-bounded | `0x33091354fCF0F5AbF57F76A784eddBDF2fb2fFbB` | [verified source](https://robinhoodchain.blockscout.com/address/0x33091354fCF0F5AbF57F76A784eddBDF2fb2fFbB?tab=contract) |
| PitYieldVault pyNVDA (call side) | `0x0295816Aa36597d5DA429deB23cd8b91d80CEb13` | [verified source](https://robinhoodchain.blockscout.com/address/0x0295816Aa36597d5DA429deB23cd8b91d80CEb13?tab=contract) |
| PitYieldVault pyUSDG (put side) | `0x99C077cCB19D13Dc2c92CdA7804b9ABC1502dF34` | [verified source](https://robinhoodchain.blockscout.com/address/0x99C077cCB19D13Dc2c92CdA7804b9ABC1502dF34?tab=contract) |

Design, keeper economy and safety properties: [YIELD-LAYER.md](YIELD-LAYER.md).

## Modules

### 1. `NAVToken.sol`
- ERC-20 + ERC-4626 share token (the vault IS the token, one contract): `NAV is ERC4626("NAV", "NAV", baseAsset=USDC-denominated accounting)`.
- Alternative (chosen): custom multi-asset vault (ERC-4626 is single-asset) — `NAVVault` below holds the basket, `NAVToken` is its share token with mint/burn restricted to the vault.

### 2. `NAVVault.sol` (core)
- Holds 190+ Stock Token ERC-20s. Registry of eligible assets (add/remove via governance, timelocked).
- `totalNAV()` — Σ balance × oracle price (Chainlink/Rialto feeds; fallback TWAP from Uniswap pools).
- `redeemInKind(uint256 shares, address to)` — burns shares, loops registry, transfers pro-rata amount of each asset. Batched; skip-and-credit pattern for paused/frozen assets.
- `redeemToStable(uint256 shares, uint256 minOut)` — sells slice via aggregator route, pays USDC.
- Reentrancy-guarded, pausable (guardian), all privileged ops behind 48h timelock.

### 3. `FeeSplitter.sol`
- Receives the 2% swap fee (via the DEX fee stream).
- Splits 80/15/5 (vault-accumulation / ops / LP incentives). Splits immutable-after-timelock.

### 4. `Accumulator.sol`
- Permissionless `accumulate()` (keeper-incentivized, small caller reward).
- Swaps accrued fee balance into basket assets per current weight table (launch: equal-weight across registry; later: governance-set weights).
- Per-epoch slippage caps; splits large buys across epochs (anti-sandwich: uses TWAP bounds + private relay if available).

### 5. `WeightController.sol` (phase 3)
- Governance (token-weighted, quorum + timelock) sets accumulation weights, asset registry changes, fee params within hard bounds.

## Codebase (implemented — `contracts/`, Foundry)

### Floor — StockSwap best-execution router (LIVE, verified)

Deployed 1 Sep 2026 (solc 0.8.24). Powers execution on the [Floor terminal](https://nav.fun/floor/): every stock/ETF swap routes through the USDG waypoint across Uniswap V3, up. Slipstream and up. v2, and a fixed 20 bps interface fee is skimmed in USDG straight into AccumulatorV2 — the same permissionless crank then converts it into vault stock holdings. Non-custodial (zero balances between txs), no owner, no admin keys, no upgrade path; permissionless `sweep` pushes strays to the protocol.

| Contract | Address | Explorer |
|---|---|---|
| NavSwapRouter — multi-venue swap router, 20 bps → Accumulator | `0xc8156712C1A654db7dcb805D8B9De15683fdc680` | [verified source](https://robinhoodchain.blockscout.com/address/0xc8156712C1A654db7dcb805D8B9De15683fdc680?tab=contract) |

Verification: Sourcify **exact match** (creation + runtime), chain 4663. Audit trail: 11-seed fuzz campaign (~10.1M executions), 33M frontend fuzz cases, on-chain quote cross-verification, live UI execution proof both directions (buy tx [`0xd04693…b3b0e43`](https://robinhoodchain.blockscout.com/tx/0xd046936bfd9209043a3be83a4ce81dcf3ef2141d0c19f1a615d7d7772b3b0e43)) — see `docs/audit-stockswap-campaign.md`.

### Floor — NavOptions covered options venue (LIVE, verified)

Deployed 1 Sep 2026 (solc 0.8.24). European, fully-collateralised, USDG-prepaid options on tokenized stocks — the first non-custodial on-chain options venue for tokenized equities. Writers deposit stock (CALL side) or USDG (PUT side) into per-market vaults; buyers prepay premium + 20 bps origination in USDG. Premium is priced from **measured Uniswap V3 fee-growth** on the underlying's deepest pool (annualised realised fee rate × strike factor × 1.25, clamped 8–300 bps/day, min 2 bps of notional). 4% of premium + all origination flows to AccumulatorV2 → vault stock buys. Settlement is permissionless against a PitOracleV2 snapshot (5 bps settle bounty), cash-settled in the escrowed asset. Every position is 100% escrowed at open — insolvency is impossible by construction. Immutable, no owner, no admin keys, no keepers, no off-chain anything.

| Contract | Address | Explorer |
|---|---|---|
| NavOptions — covered options, 4 markets (NVDA · SPCX · RDDT · USO) | `0xd628eFeC572eE000D4Eb040E675744FEB35F2467` | [verified source](https://robinhoodchain.blockscout.com/address/0xd628eFeC572eE000D4Eb040E675744FEB35F2467?tab=contract) · [Sourcify exact match](https://sourcify.dev/server/v2/contract/4663/0xd628eFeC572eE000D4Eb040E675744FEB35F2467) |

Verification: Sourcify **exact match** (creation + runtime), chain 4663. Audit trail: 10-seed campaign — 9,000,000 fuzz cases, 2,400,000 stateful handler calls, 14,400,000 invariant assertions, 0 failures; 3 findings fixed pre-deploy (premium-dilution, cost-cap, same-block withdraw); 300 on-chain TS↔contract parity checks + 1M client-math fuzz; live mainnet smoke (open → settle) — see `docs/OPTIONS-SPEC.md` and the audit campaign report.

Parameters (immutable): strike buckets ATM / ±5% / ±10% (CALL above, PUT below), terms 1h / 1d / 3d / 7d (expiry ceiled to the hour), min notional 10 USDG, OI cap 20% of measured ±2% band depth per market, writer withdraw limited to unescrowed capital with a one-block cooldown. CALL premiums are harvestable USDG; PUT premiums auto-compound into the vault.

- `src/NAVToken.sol` — $NAV ERC-20 + ERC-2612 permit; mint/burn restricted to vault.
- `src/NAVVault.sol` — multi-asset vault. **Extensible registry**: `addAsset` / `addAssets` list new stocks & ETFs as they launch on Robinhood Chain (owner/timelock-gated), `setAssetActive` handles freezes/delists. `redeemInKind` burns shares and pays out a pro-rata slice of every active asset (0.5% fee stays in vault). If an **active** asset's transfer fails mid-redemption, that slice is credited for later `claimCredit`. **Inactive** assets are skipped with no credit — which is why the app hard-blocks redemption whenever any listed asset is flagged inactive. Pausable, reentrancy-guarded, one-time `genesisMint`.
- `src/FeeSplitter.sol` — permissionless `distribute()` splits fee revenue 80/15/5 (accumulation/ops/LP).
- `src/AccumulatorV2.sol` — permissionless keeper-rewarded `accumulate(asset)`: the caller controls only (asset, timing). No router, no caller calldata — it swaps USDG directly against each asset's canonical on-chain pool, floors output with the pool's own 30-minute TWAP, pays the keeper 0.10% of the amount actually swapped, and delivers output straight to the vault. Supersedes v1 (which shipped with an intentionally empty router whitelist and never held the fee stream).
- `src/pit/PitOracleV2.sol` — fully on-chain pricing: Chainlink feed as the primary anchor, Pyth as automatic backup, pool TWAP deviation-checked against both. No keepers, schedules or manual pokes anywhere in the pricing path. (`src/PokeBounty.sol` is retired: with pull-based oracle reads there are no heartbeats to incentivise.)
- `src/pit/PitPoolDeployer.sol` — holds the `PitPool` creation code behind a write-once factory pointer, keeping `PitFactory` under the EIP-170 size limit.
- `test/NAV.t.sol` — 12 tests, all passing (pro-rata + fee math, post-launch asset addition, batch listing, frozen-asset skip-and-credit, inactive skip, splitter 80/15/5, accumulator swap + access control, pause, genesis-once).
- `script/Deploy.s.sol` — full-stack deploy script (env: DEPLOYER_PK, FEE_TOKEN, OPS_WALLET, LP_WALLET).

## Mainnet verification policy (mandatory)

Every deployed contract MUST be source-verified on the Robinhood Chain explorer immediately after deployment, and the verified addresses added to the public docs + site.

1. Deploy with verification in one shot where supported:
   `forge script script/Deploy.s.sol --rpc-url $ROBINHOOD_RPC --broadcast --verify --verifier blockscout --verifier-url <explorer-api-url>`
   (Robinhood Chain explorer is Blockscout-based; fall back to `forge verify-contract <address> <Contract> --verifier blockscout --verifier-url <explorer-api-url>` per contract, with `--constructor-args` from the broadcast JSON.)
2. Confirm each contract shows a green “Verified” source tab: NAVVault, NAVToken, FeeSplitter, Accumulator.
3. Immediately update:
   - `docs/LITEPAPER.md` + this file with a **Deployed addresses** table (contract, address, explorer link, commit hash),
   - the site (`site/src/lib/data.ts` vault address stub + docs section links) and redeploy,
   - pin the exact git commit used for the deploy (tag `v1.0.0-mainnet`).
4. No fee-stream wiring or public announcement until all four contracts are verified.

## Security checklist before mainnet
- [ ] Full audit (vault math, redemption rounding, registry edge cases)
- [ ] Fuzzing on redeemInKind rounding (dust must favor vault)
- [ ] Oracle failure drills (stale feed → pause accumulation, redemptions stay live via last-good + haircut)
- [ ] Frozen-asset drill (issuer pauses a Stock Token → skip-and-credit works)
- [ ] Testnet dry run on Robinhood Chain testnet with 5-asset registry
