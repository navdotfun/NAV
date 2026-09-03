# NAV Arena — The Colosseum

**Stock-vs-stock performance bouts, settled by oracle-verified prints — live on Robinhood Chain.**

The Floor's **WORLD** map (F1) leads to **The Colosseum** — the arena where tokenized stocks fight. A bout is a simple, brutal question: *over this exact window, which stock performs better?* NVDA vs TSLA over seven days. AAPL vs QQQ over a weekend. Anyone can create a bout, anyone can stake either side in USDG, and the losing pot pays the winning side pro-rata.

The arena is **ownerless and immutable from the deploy block**. No admin keys, no pause switch, no fee dial. Every constant is burned into the bytecode.

## Bout lifecycle

**1 — Create.** Anyone calls `createBout(tokenA, tokenB, entryClose, windowEnd)` for two registered Floor stocks. The entry period must run 1 hour – 7 days; the performance window 1 hour – 30 days. At creation the arena **pins a hash of each stock's oracle market config** — if either config ever changes mid-bout, the bout refuses to settle and refunds everyone.

**2 — Stake.** Until 30 minutes before entry close (`STAKE_BUFFER`), anyone stakes USDG on side A or side B. Minimum stake 1 USDG. Stakes are final — no exits, no re-sides. Both sides visible on-chain the whole time.

**3 — Lock.** After entry closes, a permissionless `lock` snapshots both start prices through PitOracleV2's anchor-verified settlement path and re-checks the pinned configs. A bout that can't lock cleanly voids into full refunds.

**4 — Settle.** After the window ends, a permissionless `settle` snapshots both end prices, computes each side's relative performance (end ÷ start, in WAD), and declares the winner. The **losing pot pays a 2% fee** (`FEE_BPS = 200`); the remaining 98% is distributed to winning stakers pro-rata on top of their own stake back. Of the fee, **10% pays the settler** (`BOUNTY_SHARE_BPS = 1000`) as a keeper bounty and 90% routes to the Accumulator — $NAV buy pressure. A dead-even tie voids into refunds.

**5 — Claim.** Winners (or everyone, in a voided bout) pull their payout with `claim`. Claims never expire.

## Oracle integrity — the void-not-cheat design

Prices come from **PitOracleV2**, the same anchor-verified oracle the derivatives desk settles on. The arena consumes a snapshot **only if it can independently verify it against the pinned source**, in strict priority:

1. **Chainlink bracket first.** If the pinned feed shows a fresh bracketing round for the timestamp (within 30 minutes — `MAX_START_ANCHOR_AGE`), that print is authoritative: the snapshot must equal it to the wei, and nothing can override it.
2. **Pyth benchmark fallback.** Only when no fresh Chainlink bracket exists does the arena accept a Pyth settlement print — again, exact-equality checked.
3. **Anything else voids.** Config hash changed, prices disagree, anchors stale, snapshot missing past the 24-hour resolution window (`RESOLUTION_WINDOW`) — the bout voids and **every staker on both sides is refunded in full, with zero fee taken**.

The design principle is *void, don't cheat*: any ambiguity about a price resolves to refunds, never to a winner picked from a questionable print. If a bout cannot settle within 24 hours of its window ending, anyone can void it permissionlessly and reclaim stakes.

## Constants (bytecode-fixed)

| Constant | Value |
| --- | --- |
| Fee on losing pot | 2.00% (200 bps) |
| Settler bounty | 10% of fee |
| Minimum stake | 1 USDG |
| Entry period | 1 hour – 7 days |
| Performance window | 1 hour – 30 days |
| Stake cutoff before entry close | 30 minutes |
| Resolution window before void | 24 hours |
| Chainlink anchor freshness | 30 minutes |

## Trust surface

- **No admin keys** — nothing upgradeable, pausable, or parameterizable after deploy.
- **Pinned oracle configs** — a mid-bout `setMarket` on the oracle converts the bout to refunds instead of a poisoned settlement.
- **Exact-print verification** — every consumed price must match what the pinned Chainlink feed (first) or Pyth benchmark (fallback) actually printed.
- **Residual trust, stated honestly:** when *no fresh Chainlink bracket exists* (feed dead, or genuinely off-hours beyond 30 minutes), the oracle owner could force a void or a poisoned Pyth print on in-flight bouts. Timelocking or renouncing PitOracleV2 ownership removes this residual entirely; until then, bouts on Chainlink-covered stocks during covered hours carry no such exposure.
- **Reentrancy-guarded; USDG via SafeERC20; conservation-checked payouts** — the sum of all claims plus fee equals the sum of all stakes, provably, in every settled and voided path.

## Contracts

| Contract | Address |
| --- | --- |
| NavArena | `0x51506936ae5A1146D1e3C6e804f25Fb58c492cb3` · [verified source](https://robinhoodchain.blockscout.com/address/0x51506936ae5A1146D1e3C6e804f25Fb58c492cb3?tab=contract) |

Audited under the same regime as the rest of the protocol: two independent internal review tracks (economic attack surface; Solidity correctness) plus a fix-verification pass, and a ~137M-check verification campaign (differential bigint harness + 100k-run fuzz + 800×300 invariants). Reports ship in the repository.
