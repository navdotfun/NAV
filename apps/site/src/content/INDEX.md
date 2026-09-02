# NAV Index — The Kingdoms

**Permissionless on-chain stock indexes, founded by anyone, backed 1:1 by tokenized stocks — live on Robinhood Chain.**

The Floor's **WORLD** map (F6) opens onto **The Kingdoms** — the index realm. Anyone can *found a kingdom*: an ERC-20 index token fully collateralized by a basket of 2–10 tokenized stocks held inside the index contract itself. No custodian, no rebalancing committee, no NAV oracle needed to hold or redeem — every index share is redeemable in kind, block by block, for its exact pro-rata slice of the underlying stocks.

Every index is **ownerless and immutable from the deploy block**. The founder picks the components, the weights, and the fees at creation — and can never change them. What was founded is what runs, forever.

## How a kingdom works

**Founding.** Call `createIndex` on the **NavIndexFactory** with 2–10 component stock tokens (each must be a live, registered Floor listing), integer weights per 1e18 index shares, a name, and a symbol. The factory deploys a dedicated **NavIndexToken** and registers it in the on-chain kingdom roll — the app enumerates indexes from the chain, not from a config file.

**Issuance (in kind).** `issue(shares)` pulls each component in exact weight-proportion from the minter and mints index shares 1:1 against the deposited basket. No pricing, no oracle, no slippage — issuance is pure token arithmetic.

**Redemption (in kind).** `redeem(shares)` burns the shares and pushes back every component pro-rata. Redemption is the load-bearing guarantee: it can never be paused and never depends on an oracle or router.

**Fail-closed and fail-open exits.** The plain 2-argument redeem is strict — if any component transfer fails, the whole exit reverts (fail-closed). A 3-argument `redeem(shares, receiver, skipBroken)` lets a holder **skip a broken component** and forfeit only that leg (its value is emitted on-chain via `ComponentSkipped`), guaranteeing that one frozen or self-destructed stock token can never imprison the other nine. The skipped balance is read through a bounded 50k-gas staticcall so even a malicious component contract cannot block the exit path.

**Zap issuance (one-click).** The **NavIndexZap** wraps issuance and redemption in USDG: it quotes each leg through the NavSwapRouter's live venues, buys the exact basket, issues the shares, and refunds every unspent wei of USDG in the same transaction. Zap quotes are minOut-exact — the transaction reverts rather than accepting a worse basket than quoted.

## Founder economics — hard-capped forever

| Fee | Cap | Where it goes |
| --- | --- | --- |
| Mint fee | ≤ 1.00% (100 bps) | 90% founder · 10% never minted — accretes to every holder |
| Redeem fee | ≤ 1.00% (100 bps) | 90% founder · 10% never minted — accretes to every holder |
| Stream fee | ≤ 2.00%/yr (200 bps) | founder, accrued linearly per second |

Fees are set once at founding, are capped in the bytecode (`MAX_MINT_FEE_BPS = 100`, `MAX_REDEEM_FEE_BPS = 100`, `MAX_STREAM_FEE_BPS = 200`), and are charged in index shares — never by touching the underlying basket. The unminted 10% of every mint/redeem fee is a built-in buyback-and-burn: backing per share only ever rises. And every USDG that zaps in or out of a kingdom swaps through the NavSwapRouter's live venues — 20 bps of interface fee per leg straight into the $NAV flywheel.

## What an index can hold

Components must be tokenized stocks registered on the Floor's on-chain listing registry — the same USDG-quoted tokens that trade in the Bazaar, price through PitOracleV2, and collateralize the Bank. Weights are free integers: equal-weight, price-weight, conviction-weight — the founder decides at birth.

## Trust surface

- **No admin keys** — factory and every index are ownerless; nothing is upgradeable, pausable, or re-parameterizable.
- **No oracle in the redemption path** — in-kind exits are pure ERC-20 arithmetic. The oracle (PitOracleV2) is consulted only for display valuations and zap quoting.
- **Reentrancy-guarded, checks-effects-interactions throughout; component transfers use SafeERC20.**
- **Verified source** — factory, zap, and every founded index verify on Blockscout/Sourcify from the deploy block.

## Contracts

| Contract | Address |
| --- | --- |
| NavIndexFactory | `0x0c566a9ec97D57502d557FBD3F8AB0e6059cfeC3` · [verified source](https://robinhoodchain.blockscout.com/address/0x0c566a9ec97D57502d557FBD3F8AB0e6059cfeC3?tab=contract) |
| NavIndexZap | `0xD98803f42f57B8ed5ECa41312eDE366197c1808E` · [verified source](https://robinhoodchain.blockscout.com/address/0xD98803f42f57B8ed5ECa41312eDE366197c1808E?tab=contract) |
| NAV Blue Chips (BLUE) — first founded kingdom | `0xA8b1425656550f1172D1323DC4d174E076D72Bea` · [verified source](https://robinhoodchain.blockscout.com/address/0xA8b1425656550f1172D1323DC4d174E076D72Bea?tab=contract) |

Audited under the same regime as the rest of the protocol: two independent internal review tracks (economic attack surface; Solidity correctness) plus a fix-verification pass, and a ~137M-check verification campaign (differential bigint harness + 100k-run fuzz + 800×300 invariants). Reports ship in the repository.
