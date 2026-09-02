# NAV — Litepaper (v0.1 draft)

> **Mainnet status (30 Aug 2026):** all four contracts are deployed and source-verified on Robinhood Chain — $NAV token `0x3e7f2c3A81a1c8302eacE254928e0fBa5A3Bc447`, vault `0xb8F008322671179E2C93dd8610be8d5D7876087b`, accumulator `0x3620Da2708734d1eE64D929cF9a05EAf9a7778a0`, fee splitter `0x6bCA8944F711A2299a20ecb02E7AE25d78f81Ca2` ([explorer](https://robinhoodchain.blockscout.com/address/0x3e7f2c3A81a1c8302eacE254928e0fBa5A3Bc447?tab=contract)). Registry: 95 assets.


**nav.fun · $NAV · Robinhood Chain**

> Hold one token. Own the whole market.

## 1. What NAV is

NAV is a single tradeable token whose treasury continuously buys **every tokenized stock and ETF on Robinhood Chain** — 190+ Stock Tokens, from AAPL to SPY — and locks them in an on-chain vault. Each $NAV token is a pro-rata claim on the entire vault. Your token's floor value is, literally, its **Net Asset Value**.

- **Accumulate:** every trade of $NAV pays a protocol fee. Fees are swapped into all vault-eligible Stock Tokens on a continuous schedule.
- **Appreciate:** vault holdings grow with every trade; NAV-per-token can only increase from accumulation (no fee outflows, no team skim on the vault).
- **Redeem in kind:** burn $NAV at any time and receive your exact slice of every stock in the vault, delivered directly to your wallet. No counterparty, no cash step — the ETF industry's "in-kind redemption," on-chain.

## 2. Why Robinhood Chain

Robinhood Chain (Arbitrum Orbit L2, mainnet July 2026) issues 190+ tokenized equities and ETFs as standard ERC-20 "Stock Tokens", self-custodiable and tradable 24/7 on Uniswap, Rialto and other venues. This is the first chain where "buy the whole market" is composable in a single contract call. (Stock Tokens are tokenized debt instruments issued by Robinhood Assets (Jersey) Ltd; they track price but carry no shareholder rights, and are unavailable to persons in restricted jurisdictions — see §7.)

## 3. Mechanics

### 3.1 The Vault
An ERC-4626-style vault holds the full basket. $NAV is the vault's share token.

```
trader fees ──► FeeSplitter ──► Accumulator ──► swaps into 190+ Stock Tokens ──► Vault
                                                                                   ▲
                                                              $NAV supply = claims ┘
```

### 3.2 NAV-per-token
`NAV/token = Σ (vault holdings × oracle price) / $NAV supply`
Published on-chain per block; the app renders it live. Because fees only ever add assets, accumulation is monotonic.

### 3.3 In-kind redemption
`redeem(shares)` burns $NAV and transfers `shares/totalSupply` of **each** vault position to the redeemer. Gas-batched via a single multicall. Optional "cash-out" path routes through a DEX aggregator and pays out in USDC (small slippage applies).

### 3.4 Buy pressure loop
Redemption sets a hard NAV floor: if $NAV trades below NAV-per-token, arbitrageurs buy, burn, and pocket the difference — mechanically closing the discount, exactly like ETF arbitrage.

### 3.5 The 190-token accumulation rotation
How the vault actually buys, in exact contract terms:

1. **Fee capture.** Every $NAV swap pays the 2% protocol fee in the pool's quote asset. Fees pool in the FeeSplitter until anyone calls `distribute()` (permissionless) — 80% moves to the Accumulator.
2. **Keeper-driven buying.** `Accumulator.accumulate(router, asset, amountIn, minOut, route)` is **permissionless with a 0.10% keeper bounty**: the moment accrued fees make the bounty worth more than gas, keeper bots race to execute. High volume → buys every few minutes; low volume → slower. No admin schedules anything — the bounty is the clock.
3. **Rotation across the registry.** Keepers cycle through the asset registry (~190 Stock Tokens at launch) in round-robin order weighted by shortfall: assets furthest below their target weight quote the best effective bounty, so the rotation self-balances the basket toward equal-weight (phase 3 hands target weights to governance via the WeightController). Every swap is constrained on-chain: router must be whitelisted, asset must be listed + active in the registry, `minOut` slippage floor enforced, and 100% of output transfers straight to the vault — the Accumulator cannot hold or divert inventory.
4. **Registry growth.** When Robinhood lists a new stock or ETF, governance calls `addAsset` (batch: `addAssets`) and it joins the rotation immediately; frozen or delisted underlyings are paused with `setAssetActive(asset,false)` and skipped by both accumulation and redemption until reactivated.
5. **One-way valve.** The vault has no sell function. Assets leave only via burn-gated pro-rata redemption, and the 0.5% exit fee stays in the vault — so every redemption raises NAV-per-token for everyone remaining. Gas is proven at scale: a full 190-asset in-kind redemption measures 7.8M gas (~24% of the block limit), with headroom to ~700 assets.

**Day-one honesty:** the vault holds what it has bought. Coverage of the full registry deepens continuously with fee volume; $NAV is always a claim on the vault's actual, on-chain-auditable basket — never a promise of positions it doesn't hold.

## 4. Fee model (draft — final at TGE)

| Flow | Fee | Destination |
|---|---|---|
| DEX swap (buy/sell $NAV) | 2% | 80% vault accumulation · 15% operations · 5% LP incentives |
| In-kind redemption | 0.5% | stays in vault (accrues to remaining holders) |
| Cash redemption | 1% | stays in vault |

No transfer tax on plain wallet-to-wallet transfers. No team allocation from fees to the vault — operations funded transparently from the ops split.

## 5. Token

- Ticker: **$NAV** · Chain: Robinhood Chain (Arbitrum Orbit)
- Supply: fixed at TGE; new supply only mintable against equal-value asset deposits (ERC-4626 `deposit`), never dilutive.

## 6. Roadmap

1. **Genesis** — token + vault deploy, fee engine live, first accumulation epoch, dashboard live at nav.fun.
2. **Full basket** — coverage of all vault-eligible Stock Tokens, automated weekly rebalance of accumulation weights (equal-weight → float-weight vote).
3. **Governance** — holder votes on accumulation weights, new listings, fee splits.
4. **Composability** — $NAV as collateral; LP vaults; auto-compounding wrappers.

## 7. Risks & disclosures (read this)

- **Regulatory:** Stock Tokens are unavailable to persons in the US, UK, Canada and Switzerland. A fee-funded pass-through of securities exposure may constitute a collective investment scheme in several jurisdictions; operating or promoting it without authorisation can be a criminal offence (e.g. UK FSMA s.19). Structure, domicile and access controls require professional legal advice **before** launch.
- **Issuer risk:** Stock Tokens are debt claims on Robinhood Assets (Jersey) Ltd — not equity. Vault value depends on the issuer honouring redemption.
- **Smart-contract risk:** vault, accumulator and fee contracts require audit before mainnet.
- **Oracle & liquidity risk:** thin on-chain liquidity in some Stock Tokens can distort accumulation prices and cash redemptions.
- Nothing in this document is investment advice.

---
*Draft for internal iteration. © 2026 NAV. nav.fun · @navdotfun*
