# NAV — Litepaper

> **Mainnet status:** the core protocol is live on Robinhood Chain. All contracts are deployed and source-verified — $NAV token `0x3e7f2c3A81a1c8302eacE254928e0fBa5A3Bc447`, vault `0xb8F008322671179E2C93dd8610be8d5D7876087b`, accumulator `0x3620Da2708734d1eE64D929cF9a05EAf9a7778a0`, fee splitter `0x6bCA8944F711A2299a20ecb02E7AE25d78f81Ca2` ([explorer](https://robinhoodchain.blockscout.com/address/0x3e7f2c3A81a1c8302eacE254928e0fBa5A3Bc447?tab=contract)). Vault registry: 95 verified Stock Tokens and tokenized ETFs.

**nav.fun · $NAV · Robinhood Chain**

> Hold one token. Own the whole market.

## 1. What NAV is

NAV is a single tradeable token whose treasury continuously buys **the tokenized stocks and ETFs issued on Robinhood Chain** and locks them in an on-chain vault. The registry holds 95 verified Stock Tokens — from AAPL to SPY — and expands as new listings are verified. Each $NAV token is a pro-rata claim on the entire vault. Your token's floor value is, literally, its **Net Asset Value**.

- **Accumulate:** every trade of $NAV pays a protocol fee. Fees are swapped into vault-eligible Stock Tokens on a continuous, permissionless schedule.
- **Appreciate:** vault holdings grow with every trade; NAV-per-token can only increase from accumulation — no fee outflows, no team allocation from the vault.
- **Redeem in kind:** burn $NAV at any time and receive your exact slice of every stock in the vault, delivered directly to your wallet. No counterparty, no cash step — the ETF industry's "in-kind redemption," on-chain.

## 2. Why Robinhood Chain

Robinhood Chain (an Arbitrum Orbit L2, mainnet July 2026) issues tokenized equities and ETFs as standard ERC-20 "Stock Tokens" — self-custodiable and tradable 24/7 on Uniswap and other on-chain venues. It is the first chain where "buy the whole market" is composable in a single contract call. (Stock Tokens are tokenized debt instruments issued by Robinhood Assets (Jersey) Ltd; they track price but carry no shareholder rights, and are unavailable to persons in restricted jurisdictions — see §7.)

## 3. Mechanics

### 3.1 The Vault

A multi-asset vault holds the full basket. $NAV is the vault's share token.

```
trader fees ──► FeeSplitter ──► Accumulator ──► swaps into the registry basket ──► Vault
                                                                                    ▲
                                                               $NAV supply = claims ┘
```

### 3.2 NAV-per-token

`NAV/token = Σ (vault holdings × oracle price) / $NAV supply`

Computed on-chain and rendered live in the app. Because fees only ever add assets, accumulation is monotonic.

### 3.3 In-kind redemption

`redeem(shares)` burns $NAV and transfers `shares/totalSupply` of **each** vault position to the redeemer, gas-batched in a single transaction. An optional cash path routes through on-chain liquidity and settles in stablecoins (market slippage applies).

### 3.4 Buy pressure loop

Redemption sets a hard NAV floor: if $NAV trades below NAV-per-token, arbitrageurs buy, burn, and pocket the difference — mechanically closing the discount, exactly like ETF arbitrage.

### 3.5 The accumulation rotation

How the vault buys, in exact contract terms:

1. **Fee capture.** Every $NAV swap pays the protocol fee in the pool's quote asset. Fees pool in the FeeSplitter until anyone calls `distribute()` (permissionless) — 80% moves to the Accumulator.
2. **Keeper-driven buying.** `AccumulatorV2.accumulate(asset)` is **permissionless with a 0.10% keeper bounty** (capped at 50 USDG): the caller picks only the asset and the timing — the venue, spend amount and slippage floor are all computed on-chain from the pool's 30-minute TWAP, so a keeper can neither route the trade nor supply its own price. The moment accrued fees make the bounty worth more than gas, keepers compete to execute. High volume means buys every few minutes; low volume means a slower cadence. No operator schedules anything — the bounty is the clock.
3. **Rotation across the registry.** Keepers cycle through the asset registry in round-robin order weighted by shortfall: assets furthest below target weight quote the best effective bounty, so the rotation self-balances the basket toward equal weight (a later phase hands target weights to governance). Every swap is constrained on-chain: the venue is the asset's registered pool, the asset must be listed and active in the registry, the slippage floor is derived from the on-chain TWAP, and 100% of output transfers straight to the vault — the Accumulator cannot hold or divert inventory.
4. **Registry growth.** When Robinhood lists a new stock or ETF, governance registers it (`addAsset` / `addAssets`) and it joins the rotation immediately; frozen or delisted underlyings are paused (`setAssetActive`) and skipped by both accumulation and redemption until reactivated.
5. **One-way valve.** The vault has no sell function. Assets leave only via burn-gated pro-rata redemption, and the 0.5% exit fee stays in the vault — every redemption raises NAV-per-token for everyone remaining. Redemption gas is benchmarked at scale: a full-registry in-kind redemption measures well under a third of the block gas limit, with headroom to several hundred assets.

**Day-one honesty:** the vault holds what it has bought. Coverage of the registry deepens continuously with fee volume; $NAV is always a claim on the vault's actual, on-chain-auditable basket — never a promise of positions it does not hold.

### 3.6 Credit — lending against the same stocks

The Floor's **CREDIT** tab is an isolated-market money market for tokenized stocks — Aave's risk framework on Morpho Blue's minimal accounting, rebuilt for Robinhood Chain and wired into the same fee engine:

1. **Isolated pairs.** Each market is one collateral (NVDA, QQQ, AAPL or TSLA) against USDG. Markets share nothing: a crash in one collateral cannot touch lenders in another. Every pair is ownerless and parameter-frozen the block it deploys — no admin keys, no upgrades, no pause switch.
2. **Aave-exact risk math.** Per-asset LTV / liquidation threshold / bonus, kinked utilization interest rates, 50%/100% close-factor liquidations and bad-debt socialization follow the Aave v3 / Morpho Blue playbook line-for-line, with conservative parameters sized to measured on-chain liquidity (borrow caps ≤ 10% of each pool's ±2% band depth).
3. **Oracle honesty.** Prices come from the same PitOracleV2 anchor that settles The Pit. Borrowing and liquidation pause automatically whenever the stock feed is older than 26 hours (verified on-chain: the feed trades 24/5 and freezes weekends) — deposits, repays and withdrawals never pause.
4. **Every borrow feeds the vault.** A 30 bps origination fee on each draw transfers to the Accumulator in USDG, and 20% of all interest accrues to a protocol reserve that anyone can sweep to the Accumulator for a 5 bps bounty — the same permissionless keeper economics as everything else. Credit is a third revenue stream behind $NAV: swap fees, options premiums, now lending flow.

## 4. Fee model

| Flow | Fee | Destination |
|---|---|---|
| DEX swap (buy/sell $NAV) | 2% | 80% vault accumulation · 15% operations · 5% LP incentives |
| In-kind redemption | 0.5% | stays in vault (accrues to remaining holders) |
| Cash redemption | 1% | stays in vault |
| Credit borrow origination | 0.30% | Accumulator → vault buys |
| Credit interest reserve | 20% of interest | Accumulator → vault buys (permissionless skim, 5 bps bounty) |

No transfer tax on plain wallet-to-wallet transfers. No team allocation from fees to the vault — operations are funded transparently from the ops split.

## 5. Token

- Ticker: **$NAV** · Chain: Robinhood Chain (Arbitrum Orbit)
- Supply: fixed at TGE; new supply is mintable only against equal-value asset deposits, never dilutive.

## 6. Roadmap

1. **Genesis** — token + vault deployed, fee engine live, first accumulation epochs, live dashboard at nav.fun. *Complete.*
2. **Full basket** — deepening coverage of all vault-eligible Stock Tokens; accumulation weights from equal-weight toward governed weights.
3. **Governance** — holder votes on accumulation weights, new listings, fee splits.
4. **Composability** — $NAV as collateral; LP vaults; auto-compounding wrappers.

## 7. Risks & disclosures

- **Regulatory:** Stock Tokens are unavailable to persons in the US, UK, Canada and Switzerland. A fee-funded pass-through of securities exposure may constitute a collective investment scheme in several jurisdictions; access controls, structure and domicile are matters of ongoing legal review. Nothing here is an offer to persons in restricted jurisdictions.
- **Issuer risk:** Stock Tokens are debt claims on Robinhood Assets (Jersey) Ltd — not equity. Vault value depends on the issuer honouring redemption.
- **Smart-contract risk:** the protocol has completed an extensive internal security programme (see the public audit index); smart-contract risk can be reduced, never eliminated.
- **Oracle & liquidity risk:** thin on-chain liquidity in some Stock Tokens can distort accumulation prices and cash redemptions.
- **Credit lender risk:** credit markets socialize any liquidation shortfall pro-rata across that market's lenders (Aave/Morpho bad-debt regime). Stock feeds freeze on weekends; oracle-gated actions pause after 26 h, and lenders who remain deposited through a paused-market price gap absorb any socialized loss when liquidations resume. Supplying USDG is not principal-protected.
- Nothing in this document is investment advice.

---

*© 2026 NAV. nav.fun · @navdotfun*
