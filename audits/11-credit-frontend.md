# 11 · NAV Credit — frontend (CREDIT tab trust surface)

> **Remediation status:** both High, all four Medium and all six Low findings,
> plus I-2/I-3/I-4/I-5/I-6, were fixed in commit `90f8526a` before the CREDIT tab
> shipped with live markets. I-1 (full-repay approval headroom of +0.5%) is
> accepted with rationale: the pair contract is immutable and can only pull USDG
> during a user-initiated repay, so residual allowance dust is inert.


# AUDIT B — NAV Credit Frontend

**Scope:** `floor/src/lib/credit.ts`, `floor/src/components/credit/{CreditView,CreditMarketsBoard,CreditPositionStrip,CreditTicket}.tsx`, with `chain.ts`, `wallet.ts`, `format.ts`, `nav/rpc.ts`, `App.tsx`, `FKeyBar.tsx` as usage context.
**Ground truth:** `contracts/src/credit/CreditPair.sol`, `contracts/src/credit/CreditFactory.sol`.
**Date:** 2026-09-02. Audit only; no files modified.

**Verdict up front:** the integration layer is fundamentally sound — the ABI matches the Solidity exactly (names, arg order, tuple shapes, including `repay(assets, borrower)` and shares-denominated `withdraw`), units (6-dec USDG / 18-dec collateral / 1e18 price / RAY rates) are handled correctly everywhere they are displayed, approvals are exact-amount, every write is simulated before signing, and failed reads render "—" rather than fabricated zeros. The XSS/link surface is clean. The real problems concentrate in **MAX-button semantics**: several MAX paths transact something different from what the input displays, or produce a transaction that is guaranteed (or knife-edge likely) to revert. Nothing found loses user funds outright — the simulate-before-send rail catches every revert pre-signature — but two High findings make signed transactions materially diverge from the displayed intent.

---

## HIGH

### H-1 · WITHDRAW MAX sends `type(uint256).max` even when the displayed max is liquidity-clamped — guaranteed revert whenever the user's balance exceeds un-lent cash, and displayed amount ≠ transacted amount

**Files:** `CreditTicket.tsx:56-58` (maxAvail), `CreditTicket.tsx:98-102` (setMax), `CreditTicket.tsx:113-123` (exec); `credit.ts:412-421`; contract `CreditPair.sol:474-491`.

`maxAvail` for WITHDRAW is `min(supplyBalance, mkt.cash)` (line 58) — correct, since `withdraw` reverts `InsufficientLiquidity` when redeemed assets exceed `availableLiquidity()`. Clicking MAX fills the input with that clamped value and sets `isMax = true`. But `exec` (line 116) ignores the clamped amount entirely and sends `withdraw(2^256-1)`, which the contract resolves to the user's **full share balance** (`CreditPair.sol:477`).

**Broken scenario:** user has 1,000 USDG supplied; pool cash is 400 USDG (utilization 60%). MAX displays 400.00. User clicks MAX → tx is `withdraw(uint256.max)` → contract computes assets ≈ 1,000 > 400 → `InsufficientLiquidity` revert at simulation. The MAX button is dead exactly in the situation its clamp was written for. Secondary integrity issue even when it succeeds: the input shows one number while the signed calldata means "everything" — the two only coincide when `supplyBalance ≤ cash`, and even then accrued interest means the actual amount exceeds the displayed one (user-favorable, but the display/`calldata` divergence is the anti-pattern). Note also the knife-edge when `supplyBalance ≈ cash`: cash is invariant under accrual (supply and borrow ledgers grow together, `CreditPair.sol:330,342-343`) while the user's balance keeps growing, so a full-balance withdraw quoted at the boundary can tip over `InsufficientLiquidity` at inclusion.

**Fix:** only send the `uint256.max` sentinel when the full balance is actually withdrawable, e.g. `if (isMax && account.supplyBalance !== null && mkt.cash !== null && account.supplyBalance <= mkt.cash)`. Otherwise convert the clamped asset amount to shares via the existing partial path (line 119), rounding **down**, optionally with a small haircut (e.g. `cash - 1` unit) so the tx cannot straddle the boundary. Never let `isMax` change the semantics away from the displayed amount when the displayed amount was itself a clamp.

### H-2 · REPAY MAX with wallet balance < debt attempts a full close (`repay(uint256.max)`) that must revert on `transferFrom`

**Files:** `CreditTicket.tsx:77-80` (maxAvail), `CreditTicket.tsx:135-141` (exec), `credit.ts:454-469`; contract `CreditPair.sol:556-585`.

`maxAvail` for REPAY is `min(debt, usdgBalance)` — correct display. But `exec` computes `full = isMax || parsed >= debt` (line 138). When the user's USDG balance is below their debt, MAX fills the input with `usdgBalance` and sets `isMax = true`, so `full = true` even though a full repay is impossible. `creditRepay` then approves `debt + debt/200 + 1` (more than the user holds) and sends `repay(uint256.max, account)`; the contract sets `repaid = debt` (`CreditPair.sol:564-565`) and `safeTransferFrom` of `debt` fails on insufficient balance. The revert is a raw ERC20 error, not one of the curated `ERR_COPY` messages, so the user gets an opaque failure for the flagship "MAX pays down as much as possible" action.

**Broken scenario:** debt 500 USDG, wallet holds 300 USDG. MAX shows 300.00 → click → APPROVING for ~502.5 USDG (already alarming vs. the displayed 300) → SENDING → revert with a truncated raw message. Related knife-edge: balance exactly equals debt → full path approves `debt·1.005` (fine) but the pull of `debt + accrued-since-quote` can exceed the balance by dust.

**Fix:** `const full = (isMax || parsed >= debt) && account.usdgBalance !== null && account.usdgBalance >= debt + debt/200n + 1n;` — fall back to a partial repay of `parsed` when the balance cannot cover a full close (and see L-4 for the MIN_DEBT clamp a partial repay then needs). Only approve the headroom amount on the true full path.

---

## MEDIUM

### M-1 · BORROW MAX is not a valid borrow: unclamped by borrow cap, wrong fee treatment against pool cash, and zero safety margin on the LTV boundary

**Files:** `CreditTicket.tsx:72-76`, `credit.ts:269-280` (maxBorrow); contract `CreditPair.sol:526-551`.

Three independent defects, all of which make MAX BORROW produce a tx that simulation rejects:

1. **Cash clamp ignores the origination fee.** The contract's liquidity check is `debtAssets = assets + fee > availableLiquidity()` (`CreditPair.sol:529-533`) — the fee consumes pool cash too. The UI clamps the draw to `mkt.cash` (line 75), so whenever the position is liquidity-bound, `cash + ceil(cash·30/10000) > cash` → `InsufficientLiquidity` revert, always. Correct clamp: `floor(cash · 10000 / 10030)`.
2. **No borrow-cap clamp.** The contract reverts `BorrowCapExceeded` when `totalBorrowAssets + debtAssets > BORROW_CAP` (`CreditPair.sol:532`). The UI has both `mkt.borrowCap` and `mkt.borrowAssets` in hand and never applies `borrowCap − borrowAssets` (fee-adjusted) to the max. In a cap-bound market, MAX always reverts.
3. **LTV headroom is computed on the knife edge with round-to-nearest price.** `maxBorrow` reconstitutes the price via `Number(px)/1e18` (`credit.ts:231`, float precision loss) then `BigInt(Math.round(mkt.price * 1e6))` (`credit.ts:271`) — `Math.round` can round **up**, overstating capacity; and the result targets exactly 100% of LTV with no margin for (a) interest accruing between quote and inclusion (`debtOf` grows every second there is debt), (b) the contract's share round-trip (`_toBorrowSharesUp` → `_toBorrowAssetsUp`, `CreditPair.sol:535,543`, which rounds the new debt up by a few units), or (c) the on-chain oracle price at inclusion differing from the ≤15s-cached UI price. Any of these tips the exact-boundary borrow into `LtvExceeded`. (The fee inversion itself, `room·10000/10030` floor at line 279, is provably safe against the contract's `ceil` fee — verified.)

**Fix:** clamp against all three constraints: `min( floor((capacity6·SAFETY − debt)·10000/10030), floor(cash·10000/10030), floor((borrowCap − borrowAssets)·10000/10030) )` with `Math.floor` for the price conversion and a small safety factor (e.g. 9990/10000) or an explicit few-seconds interest buffer on the LTV leg. Keep the exact contract check as the authority; the UI max must merely never exceed it.

### M-2 · REMOVE COLLAT treats a *failed* debt read as *zero* debt — MAX offers the entire collateral while debt may be outstanding

**File:** `CreditTicket.tsx:61-71`, specifically line 64: `if ((account.debt ?? 0n) === 0n) return account.collateral;`

The codebase's own stated invariant is "null = read failed — render '—', never a fabricated zero" (`credit.ts:123`). This line violates it: when the `debtOf` multicall entry fails (`fetchCreditAccount`, `credit.ts:259` → null) but `accounts` succeeded, `null ?? 0n` coalesces the failure into "no debt" and MAX becomes the **full collateral balance**. The intended null-guard on line 65 (`account.debt === null → return null`) is unreachable for this case because line 64 already returned.

**Broken scenario:** user has 10 tAAPL posted securing 800 USDG of debt; a transient RPC failure nulls `debt` for one 12-s poll window; user opens REMOVE COLLAT and sees MAX 10.0000 — the UI is asserting their entire collateral is free. On-chain the tx reverts `LtvExceeded` (funds safe), but the display is exactly the class of overstated-withdrawable figure this audit is meant to catch, and a user may pre-commit decisions to it.

**Fix:** reorder the guards: `if (account.debt === null) return null;` **before** the zero-debt shortcut, i.e. only `account.debt === 0n` may unlock full collateral.

### M-3 · REMOVE COLLAT MAX rounds the *required collateral* down (and the price to nearest) — the "conservative UI clamp" is actually the aggressive direction, and there is no accrual margin

**File:** `CreditTicket.tsx:66-70`; contract `CreditPair.sol:506-521, 435-443`.

`needed = (debt · 1e18 · 10000) / (priceE6 · ltvBps)` — the units are correct (verified against `_withinLtv`: needed = debt·1e12·1e18·1e4 / (price18·ltv) with price18 = priceE6·1e12), but the BigInt division **floors** `needed`, understating the collateral that must remain, and `priceE6 = Math.round(mkt.price * 1e6)` can round the price **up**, shrinking `needed` further. Both errors inflate `collateral − needed`, i.e. MAX overstates what is removable. On top of that, `debt` grows via accrual between the 12-s-old snapshot and inclusion, and the contract re-reads the oracle fresh — so a MAX removal is at-or-past the boundary and reverts `LtvExceeded` (or, if the on-chain price ticked up, succeeds while leaving the position exactly at 100% LTV, one price tick from liquidation-threshold territory).

**Fix:** round `needed` **up** (`(num + den − 1n)/den`), use `Math.floor` for the price (a lower price ⇒ more collateral required ⇒ safer), and apply a small buffer on `debt` (e.g. `debt + debt/2000n`) so MAX removal survives a few minutes of accrual. Comment at line 62 should only claim "conservative" once it is.

### M-4 · `isMax` and the amount survive a wallet-account switch; combined with a wrong null-guard, MAX WITHDRAW/REPAY execute full-position actions for the *new* account while displaying the old account's numbers

**Files:** `CreditTicket.tsx:39` (reset effect — deps are `[mode, mkt?.pair]` only), `CreditTicket.tsx:115` (guard), `CreditView.tsx:41-55`.

The ticket resets `amount`/`isMax`/`phase` on mode or market change but **not** on `wallet.account` change. `CreditView` re-nulls and re-fetches the account snapshot when the wallet account changes (line 41-55), so within ~1 tick the `account` prop describes the new address — while the ticket still shows the old address's MAX amount with `isMax = true`. Executing WITHDRAW then sends `withdraw(uint256.max)` under the new account (full withdrawal of a position the displayed number never described); REPAY sends a full close of the new account's debt with an approval sized to the new account's `debt·1.005`. The guard at line 115, `account?.supplyShares !== null`, compounds this: when `account` is momentarily `null`, `account?.supplyShares` is `undefined`, and `undefined !== null` is `true` — the sentinel-max path is taken with **no** account data at all. Funds end up in the user's own (new) wallet, so this is not theft, but the signed transaction materially diverges from the displayed intent — the same integrity failure class as H-1.

**Fix:** add `wallet.account` to the reset effect deps (`useEffect(..., [mode, mkt?.pair, wallet.account])`), and fix the guard to `account != null && account.supplyShares !== null`.

---

## LOW

### L-1 · `loadCreditMarkets(force)` can return a pre-transaction in-flight snapshot — post-tx UI shows stale market state

**File:** `credit.ts:162-169`. Line 163 correctly bypasses the 15-s cache when `force`, but line 164 returns any existing in-flight promise unconditionally. `onTxDone` (`CreditView.tsx:58-64`) calling `refresh(true)` during a background poll receives data read *before* the tx confirmed; the board and ticket vitals (cash, caps, utilization) show pre-tx values until the next 12-s poll, while the separately-fetched account snapshot is fresh — inconsistent panels. **Fix:** when `force`, ignore/replace the in-flight promise (or chain a fresh read after it settles).

### L-2 · SUPPLY MAX: knife-edge at the supply cap, and a fallback that ignores the cap when the market read failed

**File:** `CreditTicket.tsx:50-55`; contract `CreditPair.sol:460`. Cap headroom `supplyCap − supplyAssets` is computed from pending-accrued `supplyAssets`, which keeps growing until inclusion — a cap-bound MAX deposit reverts `SupplyCapExceeded` by the accrued dust. And when `mkt.supplyAssets === null` (failed read), line 52 falls back to the full wallet balance as MAX, which may exceed the cap. Simulation catches both; still, MAX should never be a guaranteed/likely revert. **Fix:** haircut the cap leg by a small margin; return `null` (not the balance) when the cap headroom is unknown.

### L-3 · REMOVE COLLAT is offered while the anchor is stale — guaranteed `StalePrice` revert; inconsistent with BORROW's gating

**Files:** `CreditTicket.tsx:61-71` vs `credit.ts:270`; contract `CreditPair.sol:514-516`. `maxBorrow` correctly returns 0 when `!priceFresh`, effectively disabling BORROW. The REMOVE COLLAT max ignores `priceFresh`, so with debt outstanding and a stale anchor the user gets a live MAX, types an amount, and every removal reverts `StalePrice` (the friendly copy exists, but the action was knowably dead at render time). **Fix:** when `account.debt > 0 && mkt.priceFresh !== true`, return `0n` (mirroring BORROW) and surface the same STALE hint the ticket vitals already render.

### L-4 · No MIN_DEBT awareness: partial repays leaving < 10 USDG and MAX borrows below 10 USDG are offered and always revert `DebtTooSmall`

**Files:** `CreditTicket.tsx:77-80, 135-141`, `credit.ts:269-280`; contract `CreditPair.sol:544, 570-571`. A partial repay with `debt − amount < MIN_DEBT` reverts (`CreditPair.sol:571`); the UI neither clamps nor warns — a user repaying "debt − 5" gets a revert with copy explaining a rule the input could have enforced. Symmetrically, `maxBorrow` can return a value whose resulting debt is below `MIN_DEBT` (small collateral, first borrow), a guaranteed revert. **Fix:** in REPAY, snap amounts in the `(debt − MIN_DEBT, debt)` range to full close (with balance check per H-2) or block with inline copy; in BORROW, return `0n` when the achievable debt < `MIN_DEBT`.

### L-5 · Cross-market race in `onTxDone` and free market-switching mid-transaction

**Files:** `CreditView.tsx:58-64`, `CreditTicket.tsx:39`, `CreditMarketsBoard.tsx:52-56`. `onTxDone` captures `selected` at bind time; if the user clicks another market row while `refresh(true)` + `fetchCreditAccount` are in flight (rows are never disabled during a tx), the late `setAccount(a)` writes the **old** market's position under the **new** market's view — wrong debt/collateral/HF for up to 12 s until the poll corrects it. Separately, switching markets mid-tx resets `phase` to idle (`CreditTicket.tsx:39`), silently discarding tracking of a still-pending transaction (it lands regardless, with no UI trace). **Fix:** guard the `onTxDone` write with a current-selection check (ref compare) and either disable market rows while `busy` or keep the phase banner keyed to the tx rather than the pane.

### L-6 · Health factor, collateral USD, and headroom render from a possibly-stale anchor with no stale marker in the position strip

**Files:** `CreditPositionStrip.tsx:27-41, 56-88`; contract `CreditPair.sol:423-432` (HF intentionally uses the ungated anchor). Correctness of direction is intact — HF < 1 always renders red (`hfTone` at line 39-41; a stale-price HF ≥ 1 is also the operative on-chain value since liquidation itself requires a fresh anchor) — but the strip shows HF/`$`-collateral/headroom with no indication the anchor may be >26 h old, while the board row and ticket vitals do carry a STALE badge. Off-hours, a user reads a Friday-close HF as live. **Fix:** reuse the STALE badge next to the HF readout and the collateral USD sub-line when `mkt.priceFresh === false`.

---

## INFO

### I-1 · Residual allowance after full repay
`credit.ts:461`: full repay approves `debt·1.005 + 1` but the contract pulls only `debt` at inclusion — ~0.5% of debt remains approved to the pair. The spender is an immutable, ownerless, verified contract, so risk is minimal; a follow-up `approve(0)` or approving exactly `debt` and retrying on dust-failure would be cleaner. Consistent with the "exact-amount approval" doctrine only approximately.

### I-2 · `ensureChain` prompts unconditionally and runs twice per approval flow
`wallet.ts:537-541` issues `wallet_switchEthereumChain` without first checking `state.chainId`; `creditSupply`/`creditAddCollateral`/`creditRepay` call it (`credit.ts:403,429,460`) and `drive` calls it again (`credit.ts:373`). Most wallets no-op silently when already on-chain, but strict providers may double-prompt. Check `state.chainId === robinhoodChain.id` first and drop the duplicate call.

### I-3 · Pair registry and metadata are cached forever; half-failed metadata silently hides a market
`credit.ts:154, 173-177`: `pairListCache` never refreshes — a newly listed factory pair is invisible until a full page reload. `credit.ts:193-207`: if any of the six immutable-meta reads fails, the pair is dropped from `known` with no error surface and no retry until reload (unseen-filter only re-attempts pairs never cached). Acceptable trade-offs; worth a periodic (e.g. per-hour) list re-read and a retry path for failed meta.

### I-4 · ERC20 reverts decode to poor copy
`chain.ts:65-72` defines no error entries for the ERC20 ABI; a USDG `transferFrom`/`approve` string revert surfaces via `friendly()` as `contract rejected: Error` or a 90-char raw slice (`credit.ts:347,355`). Matters most in the H-2 path. Add copy for the common `Error(string)`/insufficient-balance shapes.

### I-5 · Cosmetic rounding in labels
`CreditTicket.tsx:94-95`: the origination-fee note floors (`parsed·30/10000`) while the contract ceils (`CreditPair.sol:529`) — displayed fee can be 1 micro-USDG under actual. `CreditTicket.tsx:173`: the MAX label formats through `fmt.num(…, 2)`, which rounds to nearest — the label can display slightly *more* than the true max (typing the displayed value then trips `overMax`). Display-only; `setMax` itself uses the exact `formatUnits` string, which round-trips losslessly through `parseUnits`.

### I-6 · Minor robustness notes
(a) `CreditView.tsx:45-53`: the 12-s account poll has no sequence guard; a slow tick (the `limited()` retry ladder can exceed 12 s) resolving after a newer one regresses the display for one cycle. (b) `CreditPositionStrip.tsx:8`: the no-debt sentinel threshold is `2^255` while the contract returns `type(uint256).max` (`CreditPair.sol:428`) — the `hf >= MAX_HF` comparison is correct for the sentinel, and real HF values cannot plausibly reach 2^255 (would require ~1e64 USD of collateral), so behavior is right; align the comment with the actual sentinel. (c) `rayToApr` (`credit.ts:283-286`) and the board's utilization math (`CreditMarketsBoard.tsx:49`) truncate at 1e-9 of RAY — ≤1e-7 % display error, negligible, and all `Number()` conversions in the credit path stay well under 2^53.

---

## Verified sound (checked, no finding)

- **ABI ↔ Solidity:** every function name, argument order, mutability, and return shape in `creditPairAbi`/`creditFactoryAbi` (`credit.ts:48-96`) matches `CreditPair.sol`/`CreditFactory.sol` exactly, including `withdraw(shares)` (shares, not assets), `repay(assets, borrower)` argument order, the 9-field `marketState` tuple, the 3-field `priceStatus`, and the `accounts` struct getter (uint128×3). All 14 contract custom errors plus the oracle's `MarketUnknown` are declared for viem decoding.
- **Units:** USDG 6-dec, collateral 18-dec, price 1e18, rates RAY — every `formatUnits`/`parseUnits` call site uses the right decimals; `isUsdg` mode switching (`CreditTicket.tsx:42-44`) is correct; the LTV/needed-collateral algebra was re-derived against `_withinLtv` and matches (modulo the M-3 rounding direction).
- **BigInt hygiene:** multiplication precedes division at every derived-math site (`credit.ts:271-279`, `CreditTicket.tsx:69,95,119`); all subtractions are comparison-guarded against negative wrap; no `Number()` on a value that can exceed 2^53 feeds a transaction.
- **Approval flow:** exact-amount approvals only (never infinite), allowance pre-checked, approve simulated, receipt awaited and status-checked before the main tx (`credit.ts:290-314`).
- **Tx rails:** simulate-before-send on every write, receipt status checked, tx hash attached to every phase including errors so a timeout is never a dead end (`credit.ts:362-395`, `CreditTicket.tsx:202-216`).
- **HF display safety:** a position with HF < 1 is always rendered red with the numeric value; no code path shows HF < 1 as safe (`CreditPositionStrip.tsx:36-41,80`).
- **XSS/links:** no `dangerouslySetInnerHTML`; all dynamic text React-escaped; the only interpolated URL is the explorer tx link built from a wallet-returned `Hex` with `rel="noopener noreferrer"` + `target="_blank"` (`CreditTicket.tsx:211-212`); logo paths derive from the bundled registry or an address prefix; wallet-layer 6963 hardening (name/icon/rdns sanitization) is solid.
- **Null handling of oracle-view failures:** all reads go through `allowFailure: true` multicalls; a reverting `healthFactor`/`priceStatus` yields `null` → "—", never zero (`credit.ts:216-235, 240-264`) — with the single M-2 exception noted above.
- **Repay-full sentinel & fee inversion:** `repay(uint256.max)` + `debt·1.005+1` approval matches the contract's full-close semantics; `maxBorrow`'s `room·10000/10030` floor was proven never to exceed `room` after the contract's ceil'd fee.

---

## Summary table

| ID | Severity | Location | Finding |
|----|----------|----------|---------|
| H-1 | High | CreditTicket.tsx:56-58,113-123 | WITHDRAW MAX sends `uint256.max` despite liquidity-clamped display → guaranteed revert when balance > cash; display ≠ calldata |
| H-2 | High | CreditTicket.tsx:135-141 · credit.ts:454-469 | REPAY MAX with balance < debt attempts full close → transferFrom revert; oversized approval shown to user |
| M-1 | Medium | CreditTicket.tsx:72-76 · credit.ts:269-280 | BORROW MAX: fee not deducted from cash clamp, borrow cap ignored, round-to-nearest price + zero accrual margin on LTV boundary |
| M-2 | Medium | CreditTicket.tsx:64 | REMOVE COLLAT: failed debt read coalesced to zero debt → MAX offers full collateral against outstanding debt |
| M-3 | Medium | CreditTicket.tsx:66-70 | REMOVE COLLAT: required-collateral floors + price rounds up + no accrual margin → MAX reverts `LtvExceeded` / lands at 100% LTV |
| M-4 | Medium | CreditTicket.tsx:39,115 | `isMax`/amount survive wallet-account switch; broken null-guard → full withdraw/repay executed for the new account with old display |
| L-1 | Low | credit.ts:162-169 | `force` refresh returns stale in-flight snapshot → inconsistent post-tx panels |
| L-2 | Low | CreditTicket.tsx:50-55 | SUPPLY MAX knife-edge at cap; falls back to full balance when cap headroom unknown |
| L-3 | Low | CreditTicket.tsx:61-71 | REMOVE COLLAT offered under stale anchor → guaranteed `StalePrice` revert (BORROW gates correctly) |
| L-4 | Low | CreditTicket.tsx:77-80,135-141 | No MIN_DEBT clamp: partial repays leaving <10 USDG and sub-10-USDG max borrows always revert `DebtTooSmall` |
| L-5 | Low | CreditView.tsx:58-64 · CreditMarketsBoard.tsx:52-56 | `onTxDone` cross-market stale account write; market switching allowed mid-tx; phase banner discarded on switch |
| L-6 | Low | CreditPositionStrip.tsx:27-88 | HF / collateral USD / headroom shown from possibly-stale anchor with no STALE marker in the strip |
| I-1 | Info | credit.ts:461 | ~0.5% residual allowance after full repay |
| I-2 | Info | wallet.ts:537-541 · credit.ts:373,403 | Unconditional chain-switch prompt, invoked twice per approval flow |
| I-3 | Info | credit.ts:154,173-207 | Pair list/meta cached forever; half-failed meta silently hides a market |
| I-4 | Info | chain.ts:65-72 · credit.ts:347,355 | ERC20 string reverts decode to poor copy (relevant to H-2 path) |
| I-5 | Info | CreditTicket.tsx:94-95,173 | Fee note floors vs contract ceil; MAX label 2-dp rounding can display above true max |
| I-6 | Info | CreditView.tsx:45-53 · CreditPositionStrip.tsx:8 · credit.ts:283-286 | No seq guard on account poll; HF sentinel comment mismatch (behavior correct); ≤1e-7 % APR truncation |

**Counts:** Critical 0 · High 2 · Medium 4 · Low 6 · Info 6 — **18 findings.**

No fund-loss vector was identified: every broken path fails closed at `simulateContract` before a signature is requested, and the contract remains the authority on all limits. The dominant theme — MAX semantics diverging from the displayed clamp (H-1, H-2, M-1, M-4) — should be fixed as one coherent pass: *the transaction built must always be the amount the input displays, with the sentinel forms reserved for the cases where the full position is genuinely transactable.*
