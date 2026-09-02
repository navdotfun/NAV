# NAV — Contract Architecture

Chain: Robinhood Chain mainnet (Arbitrum Orbit L2, chain id 4663). Solidity 0.8.24–0.8.36, OpenZeppelin 5.x, Foundry toolchain.

Source code, engineering specifications and the full audit index are published in the official repository at [github.com/navdotfun/NAV](https://github.com/navdotfun/NAV) — deployed contract sources, application modules, per-engagement audit reports and coverage summaries.

## Design principles

- **No upgradability, no proxies.** Every contract is immutable at deploy; what is verified on the explorer is what runs forever.
- **No operators.** All maintenance — fee distribution, accumulation, settlement — is permissionless and bounty-incentivised. The protocol has no schedulers, no off-chain processes and no bots it depends on.
- **Solvency by construction.** Escrow precedes exposure across every product: payouts can never exceed collateral already held.
- **One-way vault.** The vault has no sell function and no admin path to assets; value leaves only through burn-gated pro-rata redemption.
- **Verified everywhere.** Every deployed contract is source-verified on Blockscout (and Sourcify where noted) before it is wired into the system or announced.

## Core protocol — deployed addresses (LIVE, verified)

| Contract | Address | Explorer |
|---|---|---|
| NAVToken — "Net Asset Value" ($NAV), 1B fixed supply | `0x3e7f2c3A81a1c8302eacE254928e0fBa5A3Bc447` | [verified source](https://robinhoodchain.blockscout.com/address/0x3e7f2c3A81a1c8302eacE254928e0fBa5A3Bc447?tab=contract) |
| NAVVault — multi-asset vault, 95 assets registered | `0xb8F008322671179E2C93dd8610be8d5D7876087b` | [verified source](https://robinhoodchain.blockscout.com/address/0xb8F008322671179E2C93dd8610be8d5D7876087b?tab=contract) |
| AccumulatorV2 — router-free, TWAP-floored accumulation | `0x3620Da2708734d1eE64D929cF9a05EAf9a7778a0` | [verified source](https://robinhoodchain.blockscout.com/address/0x3620Da2708734d1eE64D929cF9a05EAf9a7778a0?tab=contract) |
| FeeSplitter — 80 / 15 / 5 fee routing | `0x6bCA8944F711A2299a20ecb02E7AE25d78f81Ca2` | [verified source](https://robinhoodchain.blockscout.com/address/0x6bCA8944F711A2299a20ecb02E7AE25d78f81Ca2?tab=contract) |

The stack is fully wired (vault ↔ accumulator ↔ splitter) and the registry is seeded with all 95 verified Stock Token and tokenized-ETF contracts. Superseded early deployments remain verified on-chain with zero funds and are catalogued in the repository for provenance.

### Token genesis — $NAV/WETH listing (LIVE)

100% of supply (1,000,000,000 NAV) was seeded full-range into a Uniswap v3 pool against 5 ETH; nothing was withheld. The LP position was locked in a timelock at listing.

| Item | Address / value | Explorer |
|---|---|---|
| NAV/WETH pool (Uniswap v3, 1%) | `0x24c0B949ca94E90f325CE7Fd8D6E8b6EE92De20E` | [pool](https://robinhoodchain.blockscout.com/address/0x24c0B949ca94E90f325CE7Fd8D6E8b6EE92De20E) |
| LpTimelock — LP lock, forward-extendable only | `0xA5782C0A38b5d2C9fec4A6F11d2c0a94A21D36c6` | [verified source](https://robinhoodchain.blockscout.com/address/0xA5782C0A38b5d2C9fec4A6F11d2c0a94A21D36c6?tab=contract) · [Sourcify](https://sourcify.dev/server/v2/contract/4663/0xA5782C0A38b5d2C9fec4A6F11d2c0a94A21D36c6) |
| LP position NFT | tokenId `921454` (NPM `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`) | [lock tx](https://robinhoodchain.blockscout.com/tx/0xf701440e3552148d0924d912843a591f073c40b054b2097b0147cd958f4e30fa) |

The timelock exposes no function that can decrease liquidity; the lock can only be extended forward, and fee collection is separated from principal.

## The fee engine

### `FeeSplitter.sol`

Receives protocol fee revenue from every product. Permissionless `distribute()` splits 80 / 15 / 5 — vault accumulation / operations / LP incentives. The split is fixed; there is no admin path to redirect the accumulation share.

### `AccumulatorV2.sol`

Permissionless, keeper-rewarded `accumulate(asset)`. The caller controls only the asset and the timing — there is no router, no caller calldata and no caller-set slippage. The contract swaps USDG directly against each asset's canonical registered pool, floors output with the pool's own 30-minute TWAP, pays the keeper 0.10% of the amount actually swapped, and delivers 100% of output straight to the vault. The Accumulator can neither hold nor divert inventory.

### `NavCrank.sol` — one-transaction fee pipeline (LIVE)

A single public `crank()` executes the entire pipeline atomically: collect LP fees from the locked position → burn 100% of the NAV side → TWAP-guarded WETH→USDG swap → 80/15/5 split → rotating vault buys via AccumulatorV2 → caller reward. A 30-minute cooldown and hard per-call caps bound extraction; ownership renunciation is disabled by design so the timelock controller path can never be stranded.

| Item | Value | Explorer |
|---|---|---|
| NavCrank | `0x15F15c5513fb076ffaD48c80Ad65CC3EB009dD1e` | [verified source](https://robinhoodchain.blockscout.com/address/0x15F15c5513fb076ffaD48c80Ad65CC3EB009dD1e?tab=contract) · [Sourcify](https://sourcify.dev/server/v2/contract/4663/0x15F15c5513fb076ffaD48c80Ad65CC3EB009dD1e) |
| Live parameters | rotation 19 assets · max 2 WETH per crank · slippage 100 bps vs 30-min TWAP · cooldown 1800 s | — |

**Keeper integration note:** `crank()` requires a healthy gas margin before each buy leg, so a transaction sent at the raw `eth_estimateGas` value will succeed but execute zero buys. Integrators should submit `crank()` with a 3,000,000 gas limit (unused gas is refunded); the nav.fun frontend does this automatically.

## The vault

### `NAVVault.sol`

- Multi-asset vault holding the Stock Token basket; $NAV is its share token (mint/burn restricted to the vault).
- **Extensible registry** — `addAsset` / `addAssets` list new stocks and ETFs as Robinhood launches them (timelock-gated); `setAssetActive` handles issuer freezes and delistings.
- `redeemInKind(shares)` burns shares and pays a pro-rata slice of every active asset in one batched transaction (0.5% fee stays in the vault). If an active asset's transfer fails mid-redemption, that slice is credited for later `claimCredit`; inactive assets block redemption at the interface until resolved.
- `totalNAV()` — Σ balance × oracle price, Chainlink-anchored with on-chain TWAP fallback.
- Reentrancy-guarded, pausable (guardian), privileged operations timelocked, one-time genesis mint.

### `NAVToken.sol`

ERC-20 + ERC-2612 permit. Fixed supply; mint/burn restricted to the vault.

## Execution layer — the Floor

### `NavSwapRouter.sol` — best-execution stock router (LIVE)

Powers spot execution on the [Floor terminal](https://nav.fun/floor/). Every stock/ETF swap routes through the USDG waypoint across Uniswap V3 and additional registered venues; a fixed 20 bps interface fee is skimmed in USDG directly into AccumulatorV2, where the permissionless crank converts it into vault holdings. Non-custodial — zero balances between transactions, no owner, no admin keys, no upgrade path; permissionless `sweep` pushes strays to the protocol.

| Contract | Address | Explorer |
|---|---|---|
| NavSwapRouter — multi-venue router, 20 bps → Accumulator | `0xc8156712C1A654db7dcb805D8B9De15683fdc680` | [verified source](https://robinhoodchain.blockscout.com/address/0xc8156712C1A654db7dcb805D8B9De15683fdc680?tab=contract) · [Sourcify](https://sourcify.dev/server/v2/contract/4663/0xc8156712C1A654db7dcb805D8B9De15683fdc680) |

### `NavOptions.sol` — covered options venue (LIVE)

European, fully-collateralised, USDG-prepaid options on tokenized stocks. Writers deposit stock (call side) or USDG (put side) into per-market vaults; buyers prepay premium plus a 20 bps origination fee. Premiums are priced from measured Uniswap V3 fee growth on the underlying's deepest pool — a realised-volatility proxy, with hard floors and caps. Settlement is permissionless against a PitOracleV2 snapshot and cash-settled from escrow. Every position is 100% escrowed at open: insolvency is impossible by construction. Immutable — no owner, no admin keys, no keepers.

| Contract | Address | Explorer |
|---|---|---|
| NavOptions — 4 markets (NVDA · SPCX · RDDT · USO) | `0xd628eFeC572eE000D4Eb040E675744FEB35F2467` | [verified source](https://robinhoodchain.blockscout.com/address/0xd628eFeC572eE000D4Eb040E675744FEB35F2467?tab=contract) · [Sourcify](https://sourcify.dev/server/v2/contract/4663/0xd628eFeC572eE000D4Eb040E675744FEB35F2467) |

Immutable parameters: strike buckets ATM / ±5% / ±10%; terms 1h / 1d / 3d / 7d (expiry ceiled to the hour); minimum notional 10 USDG; per-market open-interest caps derived from measured pool depth; writer withdrawals limited to unescrowed capital with a one-block cooldown.

**Known behaviours and disclosures (internal review R4-A, Sep 2026).** The contract is immutable, so these are properties to understand, not bugs to patch. (1) **Pricing bounds** — the pool-measured premium rate is clamped between 8 and 300 bps/day; on quiet pools quotes sit at the floor and on turbulent pools at the cap, so extreme realised volatility can be under-priced at the cap. The app tags capped markets and warns before you trade them. (2) **Underlying freezes** — if a tokenized-equity issuer freezes transfers, call-side escrow stays locked in the contract until transfers resume; buyers of stock-settled calls and writers alike bear this issuer-action risk. (3) **Slippage guard** — `openOption` takes a `maxCostUsdg` bound; integrators must never pass `0` (which disables the check). The FLOOR app always sends a bounded value from the live preview. (4) **Dust accrual** — per-share premium accounting can leave sub-cent remainders in a vault; there is no keeper to sweep them and the amounts are economically irrelevant. (5) **Anyone can settle** — settlement after expiry is permissionless and pays a 5 bps bounty; positions do not depend on any operator being online.

## Derivatives layer — The Pit

22 contracts — factory, oracle, ticket, deployer and 18 live per-market pools. Peer-to-peer strike books with ERC-721 positions, Chainlink-anchored oracle with automatic Pyth backup, and settlement fees routed through the same FeeSplitter. Full architecture, market table and parameters: see the **Derivatives** page.

| Contract | Address | Explorer |
|---|---|---|
| PitOracleV2 — Chainlink anchor + Pyth backup | `0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd` | [verified source](https://robinhoodchain.blockscout.com/address/0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd?tab=contract) |
| PitFactory — pool registry and parameters | `0x63859B6f3F6A717c35a872B55eaA0F2B6e7fDB77` | [verified source](https://robinhoodchain.blockscout.com/address/0x63859B6f3F6A717c35a872B55eaA0F2B6e7fDB77?tab=contract) |
| PitTicket — ERC-721 positions, on-chain SVG | `0xd51C868353c084DA4c7685d755E7BFb9D41CA7b4` | [verified source](https://robinhoodchain.blockscout.com/address/0xd51C868353c084DA4c7685d755E7BFb9D41CA7b4?tab=contract) |
| PitPoolDeployer — pool creation code | `0x1600b2fe71F39216Eb3a7C04c626C9EdF75F3B7d` | [verified source](https://robinhoodchain.blockscout.com/address/0x1600b2fe71F39216Eb3a7C04c626C9EdF75F3B7d?tab=contract) |

## Credit layer — isolated lending (LIVE)

The **CREDIT** tab on the Floor is a set of isolated USDG lending markets against tokenized stocks — Morpho Blue's minimal share accounting fused with Aave v3's risk framework (kinked IRM, close-factor liquidations, bad-debt socialization). Every pair is ownerless and immutable from the deploy block: no admin keys, no upgrades, no parameter changes, ever.

### `CreditPair.sol`

One collateral, one debt asset (USDG), fully isolated balance sheet per market. Supply/borrow positions use Morpho-style shares with virtual offsets; interest follows an Aave-style kinked curve (0% base, 8% to the 80% kink, +72% above). A 30 bps origination fee on every draw transfers straight to the Accumulator, and a 20% reserve factor on interest accrues to a protocol reserve that anyone can `skim()` to the Accumulator for a 5 bps bounty. Prices read the same PitOracleV2 anchor as The Pit; `borrow`, `removeCollateral` and `liquidate` revert whenever the anchor is older than 26 hours (stock feeds freeze on weekends — verified round-by-round on-chain), while `deposit`, `withdraw`, `repay` and `addCollateral` never pause.

### `CreditFactory.sol`

Ownerless one-shot deployer: stamps each pair's immutable parameters, rejects non-18-decimal or USDG collateral, and maintains the on-chain market registry the frontend enumerates. Deploying a market is permissionless in code but meaningless without oracle coverage — pairs probe the oracle in their constructor and refuse unknown markets.

| Contract | Address | Explorer |
|---|---|---|
| CreditFactory — registry + deployer | `0x9A9feC2B6b05F94D8c3861d0202C05Df4Dcfd4A7` | [verified source](https://robinhoodchain.blockscout.com/address/0x9A9feC2B6b05F94D8c3861d0202C05Df4Dcfd4A7?tab=contract) |
| CreditPair NVDA/USDG — LTV 60% · LT 70% · bonus 8% | `0x29b2958726D905034A60Aa471B44Ee6df93516B1` | [verified source](https://robinhoodchain.blockscout.com/address/0x29b2958726D905034A60Aa471B44Ee6df93516B1?tab=contract) |
| CreditPair QQQ/USDG — LTV 65% · LT 75% · bonus 6% | `0xF07c295FB066fB1ae7867dc1235cdee009e2cafc` | [verified source](https://robinhoodchain.blockscout.com/address/0xF07c295FB066fB1ae7867dc1235cdee009e2cafc?tab=contract) |
| CreditPair AAPL/USDG — LTV 55% · LT 65% · bonus 8% | `0x4b78AeF24A62896a4f1381969EF4C9D28d2a567c` | [verified source](https://robinhoodchain.blockscout.com/address/0x4b78AeF24A62896a4f1381969EF4C9D28d2a567c?tab=contract) |
| CreditPair TSLA/USDG — LTV 50% · LT 60% · bonus 10% | `0x82797A109A840fa975616499F440C080730E1c6a` | [verified source](https://robinhoodchain.blockscout.com/address/0x82797A109A840fa975616499F440C080730E1c6a?tab=contract) |

Borrow caps are sized to measured on-chain liquidity — at deploy, each market's borrow cap was stamped at ≤ 10% of the USDG output a liquidator receives selling collateral into the live pool within a ±2% price band (QuoterV2-measured), with supply caps at 2×. Caps are immutable; deeper liquidity is served by deploying successor markets, never by editing live ones.

**Lender risk disclosure:** liquidation shortfalls socialize pro-rata across that market's lenders. Lenders who remain deposited through a paused-market weekend gap absorb any socialized loss when liquidations resume. Supplying is not principal-protected.

## Yield layer — Uniswap v4 (LIVE)

Idle Pit collateral deployed as hook-gated Uniswap v4 liquidity with instant recall. Design and safety properties: see the **Yield Layer** page.

| Contract | Address | Explorer |
|---|---|---|
| NavPitHook — fee-skim hook (vault positions only) | `0xf45510A5cA0ecBa81C8998983d7fF1366849E503` | [verified source](https://robinhoodchain.blockscout.com/address/0xf45510A5cA0ecBa81C8998983d7fF1366849E503?tab=contract) |
| YieldRouter — sole liquidity mover, slippage-bounded | `0x33091354fCF0F5AbF57F76A784eddBDF2fb2fFbB` | [verified source](https://robinhoodchain.blockscout.com/address/0x33091354fCF0F5AbF57F76A784eddBDF2fb2fFbB?tab=contract) |
| PitYieldVault pyNVDA (call side) | `0x0295816Aa36597d5DA429deB23cd8b91d80CEb13` | [verified source](https://robinhoodchain.blockscout.com/address/0x0295816Aa36597d5DA429deB23cd8b91d80CEb13?tab=contract) |
| PitYieldVault pyUSDG (put side) | `0x99C077cCB19D13Dc2c92CdA7804b9ABC1502dF34` | [verified source](https://robinhoodchain.blockscout.com/address/0x99C077cCB19D13Dc2c92CdA7804b9ABC1502dF34?tab=contract) |

## The Colosseum — NavArena (LIVE)

Stock-vs-stock performance bouts settled by PitOracleV2's anchor-verified rails. Winners split the losing pot; 2% of the losing pot is the only fee — 90% buys NAV via the Accumulator, 10% pays the settler.

| Contract | Address | Explorer |
|---|---|---|
| NavArena — bout escrow + settlement | `0x51506936ae5A1146D1e3C6e804f25Fb58c492cb3` | [verified source](https://robinhoodchain.blockscout.com/address/0x51506936ae5A1146D1e3C6e804f25Fb58c492cb3?tab=contract) |

## The Kingdoms — NavIndex (LIVE)

Permissionless on-chain index tokens over tokenized stocks. Creators earn 90% of mint/redeem fees; 10% is never minted, accreting per-share backing for every holder.

| Contract | Address | Explorer |
|---|---|---|
| NavIndexFactory — permissionless index deployer | `0x0c566a9ec97D57502d557FBD3F8AB0e6059cfeC3` | [verified source](https://robinhoodchain.blockscout.com/address/0x0c566a9ec97D57502d557FBD3F8AB0e6059cfeC3?tab=contract) |
| NavIndexZap — one-click USDG issue/redeem | `0xD98803f42f57B8ed5ECa41312eDE366197c1808E` | [verified source](https://robinhoodchain.blockscout.com/address/0xD98803f42f57B8ed5ECa41312eDE366197c1808E?tab=contract) |
| NAV Blue Chips (BLUE) — first founded kingdom | `0xA8b1425656550f1172D1323DC4d174E076D72Bea` | [verified source](https://robinhoodchain.blockscout.com/address/0xA8b1425656550f1172D1323DC4d174E076D72Bea?tab=contract) |

## Security & verification

- **Verification policy:** every deployed contract is source-verified on the Robinhood Chain explorer immediately after deployment, and its address is added to these docs before any wiring or announcement.
- **Audit programme:** each product ships only after a multi-pass internal campaign — line-by-line review, unit and mainnet-fork suites, multi-seed fuzzing, stateful invariant testing, adversarial attack suites and static analysis — with every finding fixed or formally accepted on the record.
- **Published findings:** sanitized audit reports and coverage statistics are published at [github.com/navdotfun/NAV](https://github.com/navdotfun/NAV); exploit constructions for economically sensitive paths are withheld by design. Suspected vulnerabilities should be reported privately through the channels at nav.fun, never as public issues.
