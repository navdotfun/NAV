# The Yield Layer

**Status: LIVE on Robinhood Chain mainnet.** Idle Pit collateral put to work as Uniswap v4 liquidity — with instant recall, a fee skim that feeds the vault, and a fully on-chain keeper economy. No schedulers, no trusted operators, no off-chain processes.

## Why a yield layer

The Pit is fully collateralized by design: every call is backed by escrowed stock tokens, every put by escrowed USDG. Full collateralization is what makes the Pit safe — but it also means capital sits idle between expiries. The yield layer resolves that without touching the Pit's safety model: writers can opt in to route idle collateral into concentrated Uniswap v4 liquidity bands, earning swap fees on top of option premiums. The design is adapted to European settlement and the NAV fee flywheel.

Participation is strictly opt-in and writer-mediated. The Pit's own escrow never moves — you withdraw free collateral from a strike bucket yourself and deposit it into a yield vault, and you can pull it back at any time.

## Architecture

Three contracts, one hook-gated pool per market side:

- **PitYieldVault** — a per-asset vault issuing ERC-20 shares. One vault holds a stock token (call-side collateral), a second holds USDG (put-side collateral). Deposits price shares off PitOracleV2's pull-based on-chain reads (Chainlink anchor, Pyth backup) — there is **no trusted price poster**. If the oracle reverts or its sources are stale, deposits pause automatically (withdrawals never pause and never depend on a price).
- **YieldRouter** — the only contract allowed to move vault funds into the pool. It holds the Uniswap v4 unlock entrypoint, enforces pay-max / receive-min slippage bounds and deadlines on every liquidity operation, and tracks each vault's position under its own salt.
- **NavPitHook** — a Uniswap v4 hook on the pool that skims a configurable share of LP fees (default 10%, hard-capped at 30%) from **registered vault positions only** — third-party LPs in the same pool are never skimmed — and forwards the skim to the FeeSplitter. The same 80/15/5 split applies: the yield layer is a third fee engine for the vault, after swaps and option premiums.

Recall is instant and privileged: the vault can yank its entire band out of the pool in one transaction at any time — including while paused — so collateral is always reachable when settlement needs it.

## The keeper economy — everything on-chain

The protocol deliberately has **no scheduled jobs and no operator-run bots it depends on**. Every maintenance action is permissionless and paid for on-chain, so independent keepers compete to do it:

| Action | Contract | Incentive |
| --- | --- | --- |
| Fee accumulation (USDG → stock tokens → vault) | AccumulatorV2 | 0.10% of the amount actually swapped |
| Expired-ticket settlement | PitPool | 0.25% keeper fee after a 2-hour holder grace window |
| Fee distribution (80/15/5) | FeeSplitter | Permissionless `distribute()` |

**Pricing needs no keepers at all.** PitOracleV2 anchors every read to the market's Chainlink feed, falls back to Pyth automatically, and deviation-checks the pool TWAP against both — there are no heartbeats, pokes or schedules in the pricing path. 

**AccumulatorV2** replaces the original Accumulator with a design where the caller controls nothing but timing: no router, no caller calldata, no caller-set slippage. It swaps USDG directly against the canonical on-chain pool for each registry asset, derives its slippage floor from the pool's own 30-minute TWAP, pays the keeper reward on the amount **actually** swapped, and sends every output token straight to the vault.

## Safety properties

- **Withdrawals are price-free.** Vault shares redeem pro-rata in kind. No oracle, no pause, and no admin can gate an exit.
- **Deposit guards fail closed.** A stale oracle source or excessive pool-price deviation blocks deposits, never withdrawals.
- **Skim cannot touch outsiders.** The hook only skims positions registered by the router; ordinary LPs keep 100% of their fees.
- **Bounded admin.** Fee share hard-capped at 30%; keeper rewards capped in the contract; recall works while paused; vault deposit caps limit blast radius.
- **The Pit is untouched.** The yield layer is periphery. PitPool, PitOracleV2 and the settlement path are immutable and unchanged.

## Contract addresses (Robinhood Chain, chain id 4663)

| Contract | Address |
| --- | --- |
| NavPitHook | [`0xf45510A5cA0ecBa81C8998983d7fF1366849E503`](https://robinhoodchain.blockscout.com/address/0xf45510A5cA0ecBa81C8998983d7fF1366849E503) |
| YieldRouter | [`0x33091354fCF0F5AbF57F76A784eddBDF2fb2fFbB`](https://robinhoodchain.blockscout.com/address/0x33091354fCF0F5AbF57F76A784eddBDF2fb2fFbB) |
| PitYieldVault — NVDA (call side) | [`0x0295816Aa36597d5DA429deB23cd8b91d80CEb13`](https://robinhoodchain.blockscout.com/address/0x0295816Aa36597d5DA429deB23cd8b91d80CEb13) |
| PitYieldVault — USDG (put side) | [`0x99C077cCB19D13Dc2c92CdA7804b9ABC1502dF34`](https://robinhoodchain.blockscout.com/address/0x99C077cCB19D13Dc2c92CdA7804b9ABC1502dF34) |
| PitOracleV2 — Chainlink anchor + Pyth backup | [`0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd`](https://robinhoodchain.blockscout.com/address/0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd) |
| AccumulatorV2 | [`0x3620Da2708734d1eE64D929cF9a05EAf9a7778a0`](https://robinhoodchain.blockscout.com/address/0x3620Da2708734d1eE64D929cF9a05EAf9a7778a0) |

All contracts are verified on [Blockscout](https://robinhoodchain.blockscout.com). Rollout starts with the NVDA market; additional per-market vaults are deployed by governance as liquidity warrants.
