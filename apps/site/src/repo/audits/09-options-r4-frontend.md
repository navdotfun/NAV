# NAV Protocol — Audit Round R4, Work Package B
## FLOOR Options Frontend (`floor/src`) — Application Security & Correctness Review

**Status:** Final · Internal security review, external-firm conventions
**Date:** 2026-09-02
**Reviewer:** Internal review desk — application security track (principal appsec/correctness reviewer)
**Basis of review:** repo `navfun` @ `be4854d1`; live contract `NavOptions` 0xd628eFeC572eE000D4Eb040E675744FEB35F2467 (immutable, Robinhood Chain 4663), verified read-only via `cast` against the official RPC.
**Mode:** REPORT ONLY — no files were modified.

---

## 1. Scope

Exhaustive line-by-line review of the FLOOR options frontend and the interfaces it consumes:

| File | Lines | Coverage |
|---|---|---|
| `floor/src/lib/options.ts` | 522 | every line |
| `floor/src/lib/fills.ts` | 110 | every line |
| `floor/src/lib/execute.ts` | 143 | every line |
| `floor/src/lib/venues.ts` | 208 | every line (no options-specific code path exists — see §3.9) |
| `floor/src/components/options/OptionsView.tsx` | 118 | every line |
| `floor/src/components/options/OptionsBoard.tsx` | 96 | every line |
| `floor/src/components/options/OptionTicket.tsx` | 259 | every line |
| `floor/src/components/options/WriterDesk.tsx` | 170 | every line |
| `floor/src/components/options/PositionsBlotter.tsx` | 96 | every line |
| `floor/src/lib/wallet.ts` | 581 | interfaces used by options (`walletClient`, `ensureChain`, `useWallet`, chain/account validation) |
| `floor/src/lib/chain.ts` | 232 | interfaces used (`publicClient`, `erc20Abi`, `TOKENS`, `NAV`, `robinhoodChain`) |
| `floor/src/lib/format.ts` | 41 | every line |
| `floor/src/lib/nav/rpc.ts` | 52 | every line |
| Reference: `contracts/src/options/NavOptions.sol` | 711 | every line (ABI/semantics ground truth) |
| Reference: `contracts/src/pit/PitOracleV2.sol` | errors + `quotePrice`/`snapshotSettlement` paths |
| Reference: `contracts/src/swap/NavSwapRouter.sol` | `RouteExecuted` event definition (l.201) |
| Reference: commit `f77ab839` | full diff of the O-ERR sweep / writer-capacity gate |

## 2. Methodology

1. **ABI fidelity diff** — every function, error and event declaration in `navOptionsAbi`, `oracleAbi`, `erc20Abi`, `routeExecutedEvent`, `navSwapRouterAbi` was compared token-by-token (name, type, ordering, mutability, tuple component order) against the Solidity sources.
2. **Live-chain verification (read-only)** — `cast call` against 0xd628…2467: `marketsLength()=4`, `vaultInfo(0,0)` = (15e18 shares, 0.015 NVDA assets, 0 escrowed, 0 premium, 0.015 free), `vaultInfo(0,1)` = (2e10, 19.902018 USDG, 0, 0, 19.902018), `nextPositionId()=2`, `previewOpen(0,true,0,0.1e18,3600)` decodes as (premium 4822, orig 43359, strike 216.79e18, expiry, notional 21.679099e6, escrow 1e17); `cast sig 'InsufficientFreeCapital()'` = `0xc7068bf0`, matching the live incident selector in the scope brief. `previewOpen` on market 1 (zero writer liquidity) **succeeds** — empirically confirming that the capacity gate must live in the UI, exactly as commit f77ab839 asserts.
3. **Decimal-path audit** — every 6-dec/18-dec conversion site enumerated and checked (see §3.2).
4. **Lifecycle & concurrency trace** — quote debounce/refresh/staleness, tx phases, every `useEffect` checked for interval leaks, unmount races and stale closures.
5. **Error-path enumeration** — every contract revert reachable through `open`/`settle`/`deposit`/`withdraw`/`harvestPremium`/`previewOpen` (including PitOracleV2 bubbles) traced to a user-visible surface.
6. No findings were fabricated; every claim below cites the exact code path.

## 3. Areas verified sound

**3.1 ABI fidelity — PASS.** All 15 functions in `navOptionsAbi` (options.ts:59–147) match `NavOptions.sol` exactly: `marketsLength`, `market`, `vaultInfo` (incl. `freeAssets uint256` as 5th output, sol l.500–508), `previewOpen` (6 outputs in contract order `premium,origination,strike,expiry,notional,escrow`, uint types exact, sol l.477–485), `open` (arg order `marketId,isCall,bucket,size,term,maxCostUsdg`, sol l.368), `settle`, `deposit`, `withdraw`, `harvestPremium`, `pendingPremium`, `sharesOf` (public 3-level mapping getter `(uint256,uint256,address)`), `position` (9 tuple components in exact struct order, sol l.170–180), `nextPositionId`, `dailyRateX18`, `bandDepthUsdg`, `oiNotional` (mapping getter → `uint128`). All 17 NavOptions custom errors (sol l.57–73) are present in `navOptionsErrors` (options.ts:34–57), plus the 4 PitOracleV2 errors reachable through `quotePrice` (`MarketUnknown`, `FeedDeviation`, `NoPrice`, `AnchorPending` — PitOracleV2.sol l.156–162). Oracle errors reachable only via `settle→snapshotSettlement` beyond that set (`AlreadySnapped`, `PythPushRejected`) are unreachable from NavOptions' call path (settle only snapshots when `settlementPrice==0`, atomically; Pyth push is a separate entrypoint) — no decoding gap. `fills.ts` `routeExecutedEvent` (l.16–32) matches `NavSwapRouter.sol` l.201–213 field-for-field including indexed flags.

**3.2 Decimals — PASS at every site.** Enumerated: strike `formatUnits(…,18)` (OptionTicket:196, PositionsBlotter:51,59); premium/origination/cost/notional `formatUnits(…,6)` (OptionTicket:186,198–202); USDG balance 6 (OptionTicket:183); CALL capacity 18 + symbol / PUT capacity 6 (OptionTicket:99–100); board CALL vault 18, PUT vault ÷1e6, bandDepth ÷1e6, OI ÷1e6, rate ÷1e18 with floor/cap constants 8e14/3e16 matching `FLOOR_RATE_X18`/`CAP_RATE_X18` (OptionsBoard:7–8,37–52,68–74); WriterDesk side-dependent `assetDec = side===0 ? 18 : 6` used consistently for parse and display (WriterDesk:47,64,70,109–110); position size 18 (PositionsBlotter:58). `parseUnits(ticket.size,18)` for stock qty (OptionsView:59, OptionTicket:78) and side-correct `parseUnits(amount, assetDec)` for writer flows. No mixed-decimal defect found.

**3.3 Quote lifecycle core — PASS.** 450 ms debounce + 15 s refresh (OptionsView:77–81); sequence counter kills out-of-order responses (OptionsView:57,67,71,73); B-07 param snapshot means OPEN submits exactly the priced params, with `paramsMatch` (incl. bigint `term` comparison, correct for primitives) disabling the button on any divergence (OptionTicket:77–82,103,108–112); STALE badge at 20 s (OptionTicket:66–73); hard 45 s staleness rejection in `openOption` (options.ts:378,473); `maxCostUsdg = cost + cost/200n` is computed identically at display (OptionTicket:202) and submission (options.ts:475) and is enforced on-chain by `CostTooHigh` (sol l.377) — the +0.5 % headroom is in the user's favor and displayed as "MAX COST ENFORCED".

**3.4 Writer-capacity gate (commit f77ab839) — correct in units, sides, and comparison.** `noCapacity = quote.escrow > freeCap` (OptionTicket:93–95) mirrors the contract check `qt.escrow > v.assets - v.escrowed` (sol l.380) with strict inequality and `freeAssets` sourced from `vaultInfo`'s own `assets-escrowed` (sol l.507). Units are side-correct: CALL escrow is stock-wei (`escrow = size`, sol l.701) vs. `callVault.freeAssets` (stock-wei); PUT escrow is USDG 6-dec (sol l.706) vs. `putVault.freeAssets` (USDG 6-dec). It covers **both** puts and calls, and **partial capacity** (exact bigint comparison, distinct zero-capacity vs. size-exceeds messaging, OptionTicket:210–217). The `EmptyVault` case is subsumed (`totalShares==0 ⇒ assets==0 ⇒ freeCap==0n`). Fail-open on a failed vault read is deliberate, documented, and backstopped by pre-send simulation with full error decoding. Residual weaknesses are data staleness under concurrency (F-05) — the gate itself is sound.

**3.5 Tx construction — PASS with noted exceptions.** Approvals are **exact-amount, never infinite** (`approve(NAV_OPTIONS, maxCost)` in USDG 6-dec, options.ts:390–393; same rail in execute.ts:93–96); allowance short-circuit at options.ts:388; simulate-before-send on every write (options.ts:453, execute.ts:121) so reverting txs never reach the wallet; gas comes from the simulated request; receipts awaited with bounded timeouts and `status` checked (options.ts:459–460); the USDG balance poll re-keys on `phase.k` so balances refresh after confirmation (OptionTicket:64); `onFilled`/`onChanged`/`onSettled` bump `refreshKey` re-running market and position polls (OptionsView:99). Revert decoding is complete versus the contract's full error list (§3.1) and `ERR_COPY` (options.ts:403–425) covers **all 21** declared error names — no name can fall through to the generic branch; unknown names and raw selectors still surface (`friendly()`, options.ts:427–441), so the O-ERR class ("blank signature reached users") is closed.

**3.6 React hooks hygiene — PASS with noted exceptions.** All five polling effects (markets, quote, positions, balance, writer stats) clear their intervals; `dead` flags guard setState after cleanup in markets/positions/balance/stats effects; `useSyncExternalStore` wallet state is tear-free; synchronous double-submit `useRef` guards on the ticket (OptionTicket:47,103) and writer desk (WriterDesk:24,57,83). Exceptions: F-07 (blotter), F-11 (stale `booted` closure), F-13 (quote-loop unmount, benign).

**3.7 No synthetic data — PASS except F-01.** The A-03 null-discipline (failed read ⇒ `null` ⇒ "—", never zero) is correctly implemented for vaults, bandDepth, dailyRate, OI (options.ts:162–164,257–271; OptionsBoard:36–52; WriterDesk:48–54) and writer stats (options.ts:354–357). No placeholder or estimated numbers exist anywhere in the options path — every displayed figure originates from `previewOpen`/`vaultInfo`/`position`/`dailyRateX18`/`bandDepthUsdg`/`sharesOf`/`pendingPremium`/`quotePrice`. The single violation of the discipline is the oracle price sentinel (F-01).

**3.8 bigint→number displays — PASS.** All `Number(bigint)`/`Number(formatUnits(...))` conversions are display-only and within double-precision safe ranges for realistic magnitudes (prices ~1e2·1e18 → relative error ~1e-16; USDG figures exact below 9e9 USDG). No conversion feeds a transaction parameter — all tx amounts stay bigint end-to-end (`parseUnits` → contract args).

**3.9 venues.ts / execute.ts / fills.ts.** `venues.ts` contains **no options code path** (it is the swap quote engine); reviewed for shared-rail correctness: transport-vs-revert discrimination (`isRevert`, QuoteTransportError) is sound and prevents fabricated empty books. `execute.ts` swap rails are consistent with the options rails and additionally order `ensureChain` **before** approval (execute.ts:82 vs. F-04). `fills.ts`: event ABI exact (§3.1), deploy-block lower bound, per-block timestamp fallback to 0 with the documented block-number render path — sound.

**3.10 Copy-vs-contract constants — PASS.** "20 BPS" origination = `ORIGINATION_BPS`; "5 BPS BOUNTY" = `SETTLE_BOUNTY_BPS`; "minimum trade is 10 USDG" = `MIN_NOTIONAL_USDG`; "20 % of pool depth" = `DEPTH_CAP_BPS`; board footer formula (×1.25, floor 8/cap 300 bps-day, min 2 bps) = `MULT_NUM/DEN`, `FLOOR/CAP_RATE_X18`, `MIN_ABS_PREM_BPS`; "one-block cooldown" = `SameBlock` guard; bucket labels ±5/±10 % = sol l.682; terms {1h,1d,3d,7d} = sol l.661. Expiries rendered in UTC and labeled as such.

---

## 4. Findings table

| ID | Severity | Title | Location |
|---|---|---|---|
| F-01 | **Medium** | Failed-oracle price sentinel `0` rendered as a real $0.00 and drives ITM/OTM classification | options.ts:158,266,282-284 · OptionsBoard.tsx:46 · OptionTicket.tsx:138 · PositionsBlotter.tsx:50-52 |
| F-02 | **Medium** | `previewOpen` revert reasons silently swallowed — quote failures show "—" with no cause despite full decode copy existing | OptionsView.tsx:68-71 · options.ts:288-297 |
| F-03 | **Medium** | Positions blotter 500-id scan window silently hides older positions — unsettled positions can become invisible | options.ts:307-314 |
| F-04 | Low | Chain enforcement runs **after** the approval write in options flows (swap flow does it first) | options.ts:476-477, 498-499, 443-451 vs. execute.ts:82 |
| F-05 | Low | Capacity gate & board act on data up to ~45 s stale; post-fill `refresh()` is defeated by the 15 s market cache | options.ts:220-231 · OptionsView.tsx:32-48,99 · OptionTicket.tsx:93-95 |
| F-06 | Low | WriterDesk withdraw asset→share conversion ignores virtual-share offsets and uses stale vault ratio; no full-exit path | WriterDesk.tsx:69-73 vs. NavOptions.sol:312 |
| F-07 | Low | Settle button lacks the synchronous double-submit ref guard used everywhere else (B-04) | PositionsBlotter.tsx:19-29,70 |
| F-08 | Low | Receipt-timeout error discards the tx hash — a slow-but-successful `open` invites a duplicate submission | options.ts:459-462,478-480 · OptionTicket.tsx:233-235 |
| F-09 | Informational | `fetchWriterStats` returns fabricated zeros on the `NAV_OPTIONS == null` path, contradicting its own null convention | options.ts:355,360 |
| F-10 | Informational | `ERR_COPY` for `InsufficientFreeCapital`/`SameBlock` is buyer-framed but also shown to withdrawing writers | options.ts:404,414 vs. NavOptions.sol:309,313 |
| F-11 | Informational | Stale `booted` closure keeps the 2 s fast-retry alive after boot; orphan retry timer can fire once post-cleanup | OptionsView.tsx:32-48 |
| F-12 | Informational | WriterDesk stats reset to "—" on every tx phase transition; `myAssets` display ignores virtual-share offsets | WriterDesk.tsx:29-42,52-54 |
| F-13 | Informational | Quote loop has no unmount guard (benign no-op setState in React 18) | OptionsView.tsx:51-81 |
| F-14 | Informational | `limited()` retries decoded reverts as if transient, delaying error surfacing ~1.2 s | nav/rpc.ts:41-52 |
| F-15 | Informational | "POSITION #n" comes from the **simulated** return value, which can differ from the mined id under concurrency | options.ts:461-462 · OptionTicket.tsx:238 |

Totals: **0 Critical · 0 High · 3 Medium · 5 Low · 7 Informational.**

---

## 5. Detailed findings

### F-01 · Medium — Failed-oracle price `0` rendered as $0.00 and used for ITM/OTM logic

`OptMarket.price` documents its own sentinel (options.ts:158):

```ts
price: number;          // oracle quote, USD (0 = oracle read failed — render “—”)
```

The sentinel is set at options.ts:266 (`price: 0`) and only overwritten on a successful `quotePrice` multicall (options.ts:282–284). But **no consumer honors it**:

- `OptionsBoard.tsx:46` — `<td …>{fmt.usd(mk.price)}</td>` renders **"$0.00"** as a live oracle price.
- `OptionTicket.tsx:138` — the underlying selector shows `{mk.symbol} — {fmt.usd(mk.price)}` → "NVDA — $0.00".
- `PositionsBlotter.tsx:50–52` —

```tsx
const itm = mk
  ? p.isCall ? mk.price > Number(formatUnits(p.strike, 18)) : mk.price < Number(formatUnits(p.strike, 18))
  : false;
```

With `mk.price === 0`, **every PUT is flagged "ITM"** (0 < strike always) and every CALL "OTM".

**Reachability / PoC reasoning:** `quotePrice` reverts on `FeedDeviation`, `NoPrice`, `AnchorPending` (PitOracleV2.sol l.248, 506–532) — the deviation gate is a live, expected condition (the scope brief documents a live oracle-gate incident class), and any transport failure of that specific multicall also yields `status !== "success"`. This is precisely the fabricated-zero class the A-03 remediation eliminated for vaults, surviving in the price path.

**Impact:** Misleading market data on a live-money terminal: a holder of an expired OTM put sees "EXPIRED · ITM" and may settle expecting a payout; the board and ticket advertise a $0.00 underlying. No direct fund loss (settlement price is on-chain), but materially wrong decision-support data.

**Recommendation:** Change `price` to `number | null` (null = read failed), render "—" in board/ticket, and compute `itm` only when `mk.price !== null` (render "?" or omit the tag otherwise). This matches the discipline already applied to every other field in the same struct.

### F-02 · Medium — Quote-path reverts are silently swallowed

`fetchOptQuote` (options.ts:288–297) calls `previewOpen`, which enforces the full gate set — `ZeroAmount`, `BadTerm`, `BadBucket`, `DepthLow`, `NotionalTooSmall`, `DepthCapExceeded`, plus oracle `FeedDeviation`/`NoPrice`/`AnchorPending`/`MarketUnknown` (NavOptions.sol l.655–695). The quote loop discards the reason entirely (OptionsView.tsx:68–71):

```ts
} catch {
  /* B-02: keep the last-good quote for identical params; only a quote for
     DIFFERENT params must be blanked. */
  if (seq === quoteSeq.current && lastQuoteKey.current !== key) { setQuote(null); setQuotedAt(null); }
}
```

The ticket then shows "—" rows and a disabled OPEN button with no explanation (OptionTicket.tsx:196–202, 222). The rich `ERR_COPY` table exists (options.ts:403–425) but is only wired into the **write** path via `friendly()`.

**PoC reasoning (live-verified):** size 0.04 NVDA ≈ 8.7 USDG notional < `MIN_NOTIONAL_USDG` → `previewOpen` reverts `NotionalTooSmall` → user stares at "—" with a disabled button and no hint that increasing size by ~15 % fixes it. During a `FeedDeviation` window the entire ticket goes blank with no cause shown, indistinguishable from a transport failure. This directly contradicts requirement (6) — no silent failures — for the most-travelled code path in the view (fires every keystroke + every 15 s).

**Impact:** Users cannot distinguish "oracle paused", "trade too small", "depth cap hit" and "RPC down"; support burden and abandoned trades on a live venue.

**Recommendation:** In `runQuote`, pass the caught error through `friendly()` (export it from options.ts, or a `quoteError(e): string` wrapper) and store `quoteErr: string | null`; render it in the ticket's quote panel in place of the dashes. Distinguish transport failures (retain last-good, show STALE) from decoded reverts (show reason) using the existing `isRevert()` helper from `nav/rpc.ts`.

### F-03 · Medium — 500-id blotter window silently hides older positions

`fetchMyPositions` (options.ts:307–314):

```ts
const hi = next - 1n;
...
const lo = hi > BigInt(window) ? hi - BigInt(window) + 1n : 1n;   // window = 500
```

Only ids in `[nextPositionId-500, nextPositionId-1]` are ever scanned. Cached settled/own entries are also only consulted inside that loop range (options.ts:322–327), so once `nextPositionId` advances 500 past a user's position id, the position — **including open, unsettled, in-the-money positions** — disappears from "MY POSITIONS" with no truncation indicator.

**PoC reasoning:** `nextPositionId` is currently 2 (live read), so not yet triggered — but the contract is immutable and the frontend is the only surfaced settle affordance. At any sustained activity (500 opens can be a single busy day, and opens are permissionless and cheap), a 7-day option opened before a busy stretch vanishes before its own expiry. Settlement being permissionless-with-bounty mitigates eventual payout (a settler bot pays the owner), but no such bot is in scope, and the user loses all visibility of a paid-for position.

**Impact:** Silent loss of position visibility → missed settlement (funds sit in the contract, though claimable by anyone triggering settle later), user cannot audit their own book. On a "no indexer, no backend" terminal, the blotter is the book of record.

**Recommendation:** Persist per-account owned ids (localStorage keyed by account+contract) as they are discovered or opened, and always multicall those ids regardless of window; and/or one `eth_getLogs` for `Opened(buyer=account)` from the deploy block (the pattern already proven in `fills.ts`) to seed the id set; at minimum render "SHOWING LAST 500 POSITIONS" when `lo > 1n`.

### F-04 · Low — Approval write happens before chain enforcement in options flows

`openOption` → `ensureAllowance` (wallet **write**) → `drive` → `ensureChain` (options.ts:476–477, 443–451). Same ordering in `writerDeposit` (options.ts:498–499). The swap rail does it correctly: `executeSwap` calls `ensureChain()` before touching allowance (execute.ts:82).

**PoC reasoning:** wallet parked on Ethereum mainnet (the documented WalletConnect/Phantom default, wallet.ts:461–466) with `status === "wrong-chain"`; the ticket button is not gated on chain status. `simulateContract` runs against the fixed Robinhood RPC and passes; `wc.writeContract(request)` then fails viem's chain assertion (or the wallet rejects), producing a raw `ChainMismatchError` message truncated to 90 chars by `friendly()` (options.ts:440) instead of the automatic switch prompt the user would have received 500 ms later from `drive`. No wrong-chain transaction can actually be sent (viem asserts `request.chain`), so impact is UX/error-quality, not fund safety.

**Recommendation:** Hoist `if (!(await ensureChain())) throw new Error("switch wallet to Robinhood Chain")` to the top of `openOption` and `writerDeposit` (before `ensureAllowance`), mirroring `executeSwap`.

### F-05 · Low — Capacity gate and board run on data up to ~45 s stale; post-fill refresh defeated by cache

`loadOptMarkets` serves a 15 s snapshot (options.ts:220–231, `OPT_MKT_TTL_MS = 15_000`) under a 30 s poll (OptionsView.tsx:45), so `freeAssets` feeding the f77ab839 gate (OptionTicket.tsx:93–95) can be up to ~45 s old. Consequences:

- **False block:** a writer deposit that just freed capacity leaves the OPEN button hard-disabled ("NO WRITER CAPACITY") for up to 45 s with no override — the gate is a hard `disabled`, not a warning.
- **False pass under concurrency:** a competing buyer consumes capacity after the read; the order then fails at `simulateContract` with the decoded `InsufficientFreeCapital` copy — acceptable (chain remains authoritative; nothing reaches the wallet), but note this means the gate **cannot** fully prevent the O-ERR incident class under concurrent quotes, only the steady-state case.
- **Post-fill staleness:** `onFilled → refresh()` bumps `refreshKey`, but the remounted effect calls `loadOptMarkets()` which returns the **cached** array if <15 s old (options.ts:225) — so after a successful open, the board's escrow/free-capacity and the ticket's capacity row provably do not update for up to 15 s.

**Recommendation:** add `loadOptMarkets({ force?: boolean })` (bypass cache) used by the `refreshKey` path; optionally re-read `vaultInfo` for the selected market/side alongside each 15 s quote refresh so gate data ages like the quote; consider making a stale false-block soft (warning + allow simulate) since simulation + decoded errors already backstop.

### F-06 · Low — Writer withdraw share conversion: no virtual-share offsets, stale ratio, no full-exit path

WriterDesk.tsx:69–73:

```ts
/* withdraw interprets the input as an asset amount converted to shares (floor) */
const amt = parseUnits(amount, assetDec);
const shares = vault!.assets > 0n ? (amt * vault!.totalShares) / vault!.assets : 0n;
await writerWithdraw({ …, shares: shares > myShares! ? myShares! : shares, … });
```

The contract computes `amountOut = shares * (assets + 1) / (totalShares + 1000)` (NavOptions.sol l.312, `VIRT_SHARES=1e3`, `VIRT_ASSETS=1`). The UI inverse omits both offsets and floors, and `vault` comes from the (up to ~45 s stale, F-05) markets snapshot — the PUT-side ratio moves whenever premium folds into `assets` (sol l.393) or a settlement pays out (sol l.462).

**Impact (funds-safe, correctness-only):** the executed withdrawal differs slightly from the typed amount; typing one's full stake floors the share count and strands dust shares, so a **complete exit is impossible through the UI**; `vault.assets === 0n` with the virtual offset can compute `0n` shares → contract reverts `ZeroAmount` (decoded). Clamping to `myShares` and the contract's own `shares > held` check prevent any over-withdrawal.

**Recommendation:** add a MAX affordance that submits `myShares` directly (exact full exit, no conversion); use `(amt * (totalShares + 1000n) + assets) / (assets + 1n)`-style rounding-up inverse for typed amounts; convert from a fresh `vaultInfo` read at click time rather than the cached snapshot.

### F-07 · Low — Settle path lacks the B-04 synchronous double-submit guard

PositionsBlotter.tsx:22–29 relies solely on `busyId` **state** (`disabled={busyId !== null}`, l.70). State updates are asynchronous; two clicks landing before the next render both observe `busyId === null` and dispatch two `settlePosition` calls → two wallet prompts; if both are signed, the second reverts `AlreadySettled` on-chain, costing gas. OptionTicket (l.47,103) and WriterDesk (l.24,57) both carry the synchronous `inFlight` `useRef` for exactly this reason; the blotter was missed.

**Recommendation:** add the same `const inFlight = useRef(false)` guard around `settle()`.

### F-08 · Low — Receipt-timeout error path drops the tx hash

`drive` (options.ts:459–462): `waitForTransactionReceipt({ hash, timeout: 180_000 })` throws on timeout; the catch in `openOption` (options.ts:478–480) replaces the phase — which was `{k:"sending", hash}` — with `{k:"error", message}` carrying **no hash**, and OptionTicket renders only the message (l.233–235). A congested-but-eventually-mined `open` therefore shows a bare error; the natural user response is to resubmit, opening a **second position and paying a second premium** (the first tx is valid and will mine; `maxCostUsdg` does not dedupe). Same pattern for deposits.

**Recommendation:** extend the error phase to `{k:"error", message, hash?}`; on timeout render "tx still pending — check explorer before retrying" with the explorer link; optionally re-check `getTransactionReceipt` before allowing resubmit.

### F-09 · Informational — Fabricated zeros on the disabled-deploy path of `fetchWriterStats`

options.ts:359–360 returns `{ callShares: 0n, putShares: 0n, pending: 0n }` when `NAV_OPTIONS` is null, while the type's own doc (l.355) mandates `null = read failed — render "—", never a fabricated zero balance`. Dead code today (`NAV_OPTIONS` is a non-null constant, l.16) but a latent violation of the project's anti-synthetic-data rule if the gate is ever reused. Return nulls instead.

### F-10 · Informational — Buyer-framed error copy shown to writers

`ERR_COPY.InsufficientFreeCapital` = "no free writer capacity on this side — reduce size or deposit on the WRITE tab" (options.ts:404). The same error is raised by `withdraw` when a writer's redemption exceeds unescrowed capital (NavOptions.sol l.313); a withdrawing writer is told to "deposit on the WRITE tab", which is wrong guidance for their situation ("your capital is escrowed by open options — wait for expiry/settlement" is correct). Consider context-sensitive copy per driving function in `friendly()`/`drive`.

### F-11 · Informational — Stale `booted` closure in the markets poll

OptionsView.tsx:32–48: the effect deps are `[refreshKey]` (eslint-disabled), so the `tick` closure captures `booted` at mount (false). After boot succeeds, a later transport failure still evaluates `!booted` as true and schedules the 2 s fast retry intended only for the pre-boot phase; consecutive failures chain retries alongside the 30 s interval (mild RPC churn, and only the last timer id is cleared on cleanup — an orphan can fire one post-cleanup `tick`, whose setState is `dead`-guarded so no state corruption). Use a `bootedRef` or include `booted` in deps.

### F-12 · Informational — WriterDesk stats flash and approximate stake display

WriterDesk.tsx:29–42: the stats effect keys on `phase.k` and unconditionally `setStats(null)` on every re-run, so each phase transition (idle→approving→sending→done) blanks MY STAKE / PENDING PREM to "—" mid-transaction. Only clear on market/account change. Also `myAssets = myShares * assets / totalShares` (l.52–54) omits the contract's virtual offsets — display-only and self-documented ("contract computes exactly"), noted for completeness; the same figure drives no transaction.

### F-13 · Informational — Quote loop unmount

OptionsView.tsx:51–81: `runQuote`'s async continuation has no `dead` flag; a response resolving after unmount calls `setQuote`/`setQuoting` on an unmounted component. In React 18 this is a silent no-op (no leak — the interval and timeout are cleared), so purely a hygiene note for consistency with the other four effects.

### F-14 · Informational — `limited()` retries deterministic reverts

nav/rpc.ts:41–52 retries **every** failure up to 3× with backoff, including decoded contract reverts, which are deterministic — e.g. a `vaultInfo(id, side)` `UnknownMarket` would burn ~1.2 s in futile retries before surfacing. The module already exports `isRevert()` for exactly this discrimination (used by venues.ts); apply it inside `limited` to fail fast on reverts.

### F-15 · Informational — Displayed position id comes from simulation, not the receipt

`drive` returns the **simulated** result (options.ts:453–462); for `open` this is `nextPositionId` at simulation time, rendered as "✓ FILLED · POSITION #n" (OptionTicket.tsx:238). If any other open mines between simulation and inclusion, the true id is higher and the banner is wrong (the blotter subsequently shows correct ids from `position()` reads, and `settle`'s displayed `payout` has the same simulation-vs-execution caveat). Decode the `Opened`/`Settled` event from the confirmed receipt (`parseEventLogs`) for exact figures — the events exist in the contract (sol l.195–215) but are absent from `navOptionsAbi`.

---

## 6. Concluding remarks

The options frontend is well above typical dapp quality: exact ABI parity with the immutable contract (independently re-verified against the live deployment), disciplined 6/18-decimal handling with zero conversion defects found, exact-amount approvals, simulate-before-send everywhere, complete custom-error decode coverage (all 21 reachable error names mapped to actionable copy), and a writer-capacity gate whose units, sides, and comparison exactly mirror `open()`'s escrow check — closing the live `InsufficientFreeCapital` (0xc7068bf0) incident class for the steady-state case, with concurrency races correctly backstopped by decoded simulation failures. The material residual risks are presentation-layer truth failures, all fixable in the frontend without touching the immutable contract: the $0.00/false-ITM oracle sentinel (F-01), silent quote-gate reverts (F-02), and the 500-id blotter horizon (F-03).

*Report generated by the R4-B audit workstream. No repository files were modified. No external firm is represented.*

---

## Remediation status (post-review)

All findings in this report were remediated in repo commit `46f1a2f2` and verified by a clean type-check, production build, and live desktop/mobile QA pass: null-safe oracle pricing end-to-end (F-01), event-log-seeded position discovery with an explicit truncation notice (F-03), pre-approval chain checks (F-04), forced market refresh (F-05), virtual-share writer accounting with an exact-shares MAX exit (F-06), settle double-submit guard (F-07), transaction-hash-bearing error states with explorer links (F-08), null-safe writer stats (F-09), friendlier timeout/withdraw errors (F-10), boot double-load fix (F-11), writer-stats flash fix (F-12), quote sequencing guard (F-13), no-retry-on-revert RPC policy (F-14), receipt-parsed open/settle results (F-15), and shared rate-cap constants with capped-market warnings (F-16/M-01).
