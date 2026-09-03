# FLOOR — Frontend Audit R5 · Routing Refactor
**Scope:** `floor/src` after commit `a231cf91` → `55ef29a3` ("WORLD is F1 hub + default view")
**Changed files under line-by-line review:** `App.tsx`, `components/FKeyBar.tsx`, `components/MarketWatch.tsx`, `lib/format.ts`
**Method:** static line-by-line review of the diff (`git diff a231cf91..55ef29a3`), full-repo grep of every `fmt.*` consumer, every `setView`/theme/aria consumer, all keyboard listeners, all injection surfaces. No files were modified. 375 px / 1280 px behavior was reasoned from Tailwind classes (no live browser run — stated where this limits confidence).
**Auditor stance:** report-only; severities C/H/M/L/Info; each finding states its false-positive (FP) risk.

---

## 1. Diff-verified change inventory

| File | Verified change |
|---|---|
| `App.tsx` | New `VENUE_META` map (L33–38) + venue chrome bar with `← MAP` (L173–179). No logic changes to quote/poll loops. |
| `FKeyBar.tsx` | Visible tabs reduced to `TABS = ["WORLD","STATS"]` (L19, filter at L38); highlight/`aria-pressed` now `v === "WORLD" ? view !== "STATS" : view === v` (L40–41); `max-w-[220px]` added; full F1–F6 keydown map unchanged (L24–34). |
| `MarketWatch.tsx` | Wrapper `overflow-y-auto` → `overflow-auto` (L33); `whitespace-nowrap` on LAST cell (L56). |
| `lib/format.ts` | Non-finite → `"—"` and ≥1e15 → exponential guards added to `usd` (L5–6), `usdCompact` (L23–24), `compact` (L31–32), `num` (L39–40). `pct`/`delta`/`usdTiny` untouched. |

---

## 2. Findings

### R5-01 · M · F5/F3/F6 browser shortcuts hijacked by invisible deep-links
**File:** `components/FKeyBar.tsx:24–34` (claim), `:2–5` (comment).
Unmodified `F1–F6` are matched and `preventDefault()`ed globally. `F5` is the browser reload key, `F3` is find-next, `F6` is address-bar focus. A trader who presses **F5 to hard-refresh** is instead **silently teleported to THE BANK (CREDIT)** and the page never reloads. Before this refactor the `F5 CREDIT` tab was visible in the footer, so the behavior was at least advertised; the tabs are now hidden (L38), so the hijack is undiscoverable — the user has no visible explanation for why F5 "stopped working". The header comment *"browser shortcuts stay untouched"* (L23) is factually false for F1/F3/F5/F6.
**Trader-impact scenario:** user suspects stale data, presses F5 expecting a reload, lands on CREDIT, navigates back, and assumes the data was refreshed when it was not (prices poll on their own 10 s cadence, so real staleness impact is bounded — hence M, not H).
**Fix:** stop claiming `F5` (and ideally `F3`/`F6`) — e.g. `if (["F3","F5","F6"].includes(e.key) && !CLAIMED) return;` or remap CREDIT to a non-conflicting key; alternatively keep F5 claimed but make it trigger an explicit data refresh with a visible toast. Correct the comment either way. Per task instruction, the **F1 help override is accepted** and not counted against the verdict.
**FP risk:** low — the handler and `preventDefault` are unambiguous in code. Note the *handler itself is pre-existing* (B-25); this diff only removed its visible advertisement, which is what raises it to M.
**Input-typing conflict check (explicitly requested):** none found. F-keys produce no characters, the handler ignores all modified keys (L26), and order state is lifted into `App` (`App.tsx:50`), so an F-key press mid-typing navigates but loses no input. `MarketWatch`'s row-level Enter/Space handler (`MarketWatch.tsx:51`) is scoped to the focused row and does not collide.

### R5-02 · M · `aria-pressed` toggle semantics broken on the WORLD tab; view changes are unannounced
**File:** `components/FKeyBar.tsx:40–41`; `App.tsx:173–179`.
`aria-pressed={v === "WORLD" ? view !== "STATS" : view === v}` announces **"F1 WORLD, pressed"** for all seven non-STATS views. A screen-reader user sitting in THE BAZAAR (SWAP) is told the WORLD toggle is active; the only textual counter-signal is the venue bar's `<span className="panel-title">` (`App.tsx:175`), which is not a heading, not an `aria-live` region, and receives no focus — so entering a venue via the map produces **no announcement at all**. Also, `aria-pressed` implies a toggle whose next activation un-presses it; here clicking pressed WORLD navigates and it stays pressed. (The old code had the inverse bug — highlight without `aria-pressed` for ARENA/INDEX — so this is a changed, not new, inconsistency.)
**Fix:** treat the footer as navigation: `aria-current="page"` on the active destination (WORLD counting as ancestor is fine with `aria-current="true"`), or a proper `role="tablist"`/`aria-selected`. Make the venue name an `<h1>`/`<h2>`, and on view change either move focus to the venue bar or announce via a polite live region.
**FP risk:** low for the semantics; the "lit WORLD while inside a venue" *visual* is arguably intentional wayfinding ("you are somewhere on the world map") and is not counted as misleading, since the venue bar names the actual location.

### R5-03 · L · Magnitude guard in `usdCompact`/`compact` is sign-asymmetric — fails the stated `|v| ≥ 1e15` contract
**File:** `lib/format.ts:24, 32` vs `:6, 40`.
`usd`/`num` use `Math.abs(v) >= 1e15`; `usdCompact`/`compact` use `v >= 1e15`. Consequences for negatives: `usdCompact(-2e15)` → `"$-2000000000000000.00"` (falls through every branch to `toFixed(2)`) — the exact unbounded-width string the guard exists to prevent — and negatives in `1e3..1e15` are never compacted (`usdCompact(-5e6)` → `"$-5000000.00"`).
**Failure scenario:** a signed value (PnL, net flow) formatted with `usdCompact` blows out the `MarketWatch`/`OptionsBoard`-style fixed columns.
**Fix:** mirror the `usd` pattern: guard on `Math.abs(v)` and compact on the absolute value with the sign re-applied.
**FP risk:** **high today** — I verified every current call site (`MarketWatch.tsx:59`, `TickerTape.tsx:19`, `OptionsBoard.tsx:49,53,54,56`, `CreditTicket.tsx:273`, `CreditMarketsBoard.tsx:12`, `AnalyticsView` axis callbacks, `PitBook.tsx:171,173`, `TapePanel.tsx:35`, `CrankDesk` supply/burn figures) passes non-negative chain-derived magnitudes (depths, caps, OI, supplies). This is a latent library defect, not a live rendering bug.

### R5-04 · L · `pct()` and `delta()` were left out of the new guard policy — `"NaN%"` still reachable
**File:** `lib/format.ts:43–48`.
The refactor's stated invariant ("non-finite → —") was applied to 4 of 6 formatters. `fmt.pct(NaN)` → `"NaN%"`, `fmt.delta(NaN)` → `"▼ NaN%"` (note: `delta` also mis-signs NaN as ▼ since `NaN >= 0` is false).
**Fix:** add the same `Number.isFinite` guard.
**FP risk:** high — grep shows `fmt.pct`'s only caller is `PitTicket.tsx:297` with the compile-time constant `PIT_MIN_PREMIUM_PCT`, and `fmt.delta` has **zero callers** (dead code — consider removing). Reported for policy consistency, not live impact.

### R5-05 · L · Focus is dropped to `<body>` on every map↔venue transition
**Files:** `App.tsx:177` (`← MAP`), `WorldView.tsx:105–130, 134–146` (hotspots/list), `ArenaView.tsx:180`, `KingdomsView.tsx:186`.
Clicking `← MAP` (or a map hotspot) unmounts the button that owns focus; focus resets to `document.body`, forcing keyboard users to re-tab from the top through TopBar/TickerTape every navigation. Under the old always-visible tab bar, the activated tab persisted across the transition and retained focus — this is a genuine **regression introduced by the tab removal**.
**Fix:** after `setView`, move focus to the new view's first heading/venue bar (e.g. `ref` + `tabIndex={-1}` + `.focus()`), pairing naturally with the R5-02 fix.
**FP risk:** low (structural certainty; verified `rg focus\(\)` finds no focus management anywhere in `src`).

### R5-06 · L · F1–F6 remain live behind the modal wallet dialog
**Files:** `components/FKeyBar.tsx:32` (window-level listener) + `components/WalletPicker.tsx:24–27, 33+` (`role="dialog" aria-modal="true"`).
With the wallet picker open, F-keys still switch the view underneath the modal (no key trapping, no `stopPropagation`). `aria-modal="true"` promises the rest of the page is inert; it isn't. A user who opens the picker on SWAP, taps F4 accidentally, then connects, lands in VAULT confused.
**Fix:** in `FKeyBar`'s handler, bail if a modal is open (shared state or `document.querySelector('[aria-modal="true"]')`).
**FP risk:** low; impact minor (navigation only, no funds/tx path).

### R5-07 · L · Sticky header cosmetics inside the new `overflow-auto` wrapper
**File:** `components/MarketWatch.tsx:33–41`.
`<thead className="sticky top-0 bg-panel">` inside a `border-collapse` table: with collapsed borders the `th` `border-b` is painted on the shared grid, not the cell, so on scroll the header's bottom rule visually detaches / a 1 px seam lets row content show under the header edge. Also `position: sticky` on `<thead>` requires Chromium ≥ 91 / Safari ≥ 16-ish table-sticky support.
**Fix:** `border-separate` + `border-spacing-0`, or move sticky+border to the `th`s with `box-shadow` instead of `border-b`.
**FP risk:** **high** — modern evergreen browsers stick `<thead>` correctly and the seam is a 1 px cosmetic; flagged because the `overflow-auto` wrapper in this diff is what makes the header actually stick (and thus makes the artifact visible) for the first time.

### R5-08 · L · MarketWatch flash-timer edge: a highlight can freeze if listings re-render inside the 950 ms window
**File:** `components/MarketWatch.tsx:13–25`.
The effect returns a cleanup (clearing the un-flash timeout) **only** when `next.size > 0`. Sequence: price change at t=0 sets flashes + 950 ms timer; a new `listings` identity arrives at t<950 ms with **no** price changes → previous cleanup clears the timer, no new timer is scheduled, `flashes` stays lit until the next price change.
**Fix:** always schedule/clear symmetrically (`return () => clearTimeout(id)` unconditionally, or clear stale flashes when `next.size === 0`).
**FP risk:** **high** — `listings` identity only changes on the 10 s poll (`App.tsx:88–93`), so back-to-back updates within 950 ms essentially require the boot→first-tick race, at which point `prev` is empty and no flash exists. Pre-existing (not in this diff); recorded from the regression sweep.

### R5-09 · Info · SWAP is the silent `else` of the view ternary
`App.tsx:180`: any future `FloorView` member that isn't wired into the chain falls through to the SWAP terminal instead of failing loudly. Fix: exhaustive `switch` with `never` assertion. (Verified all 8 current members are handled.)

### R5-10 · Info · `VENUE_META` duplicates `WorldView.SPOTS` labels/descs
`App.tsx:33–38` vs `WorldView.tsx:25–32`. Strings match exactly today (verified char-for-char); two sources of truth invite drift (map says "MAGE TOWER", bar says something else). Fix: export one table.

### R5-11 · Info · "Deep-links" is a misnomer — no URL/history integration
View state is memory-only: F-keys/map don't push history, browser Back exits the app (default view resets to WORLD on reload). Pre-existing; the FKeyBar comment (L4) oversells it. Consider `history.pushState`/hash sync — it would also fix Back-button behavior after the tab removal made in-app navigation the *only* way around.

### R5-12 · Info · DERIVS renders double chrome; venue-bar desc duplicates the product-rail blurb
`App.tsx:173–179` ("MAGE TOWER · OPTIONS — CALLS & PUTS") stacks directly above `DerivsView.tsx:33–48`'s product rail with its own blurb — ~60 px of header before content at 375 px. Cosmetic; consider suppressing the desc span for DERIVS.

### R5-13 · Info · Minor formatter cosmetics in the new exponential path
`fmt.usd(-2e15)` → `"$-2.00e+15"` (sign after `$`; conventional is `-$2.00e+15`); `fmt.usd(1e15)` boundary renders exponential where `999,999,999,999,999.99` renders grouped — abrupt but truthful. No action required.

### R5-14 · Info · F2–F5 shortcuts are now advertised nowhere in the product
Grep confirms no remaining "F2…F5" copy anywhere in `floor/src` (only the homepage was remapped, per commit `55ef29a3`). Keyboard traders can only learn the venue keys by accident. Consider a `kbd` chip in the venue bar ("F3" next to MAGE TOWER) — it would also mitigate R5-01's surprise factor.

---

## 3. Regression sweep — verified-safe (checked, no finding)

**XSS / injection surfaces.** `rg dangerouslySetInnerHTML|innerHTML|eval\(|document.write` → zero hits in `src`. All chain-derived strings (token symbols/names, tx hashes) render as JSX text (auto-escaped). Every `href` is built from the `EXPLORER` constant + chain data with `rel="noopener noreferrer"` (`SwapPanel.tsx:212,222` use only `noreferrer`, which implies `noopener` — fine). `WorldView` map image is a local static asset. **Clean.**

**Every `fmt.*` consumer (full grep, 60+ call sites).** All `usd/num/usdCompact/compact/usdTiny` call sites in `MarketWatch`, `TickerTape`, `TapePanel`, `SwapPanel`, `RoutingTheatre`, `FairPriceShield`, `MyFills`, `options/*`, `vault/*`, `credit/*`, `pit/*`, `analytics/*` benefit strictly from the new guards ("—" instead of "$NaN", bounded exponential instead of 30-char strings). No consumer string-matches formatter output or depends on the old `"$NaN"`/full-width behavior. `MarketWatch.tsx:57` `l.price < 1 ? 4 : 2` with `NaN` price picks `d=2` then hits the guard → "—". Chart axis callbacks (`AnalyticsView.tsx:222+`, `HoldingsBoard.tsx:87`) pass finite Chart.js ticks. **No regression.**

**NaN/Infinity outside `fmt`.** `FairPriceShield.tsx:21,25,30` guards `sharesOut > 0` / `refPrice > 0` before dividing; `RoutingTheatre.tsx:18` guards `top > 0`; `CreditPositionStrip.tsx:40` explicitly handles `Infinity` HF as "∞"; `MarketWatch.tsx:60` `(l.fee / 10_000).toFixed(2)` is correct Uniswap fee-tier math (500 → "0.05%", 3000 → "0.30%") on a finite chain constant. **Clean.**

**Routing/state assumptions of the tab change.** Grep of `setView`/`FloorView` shows exactly four consumers: `FKeyBar`, `WorldView`, `ArenaView:180`, `KingdomsView:186` — all receive `setView` and all render an escape route (venue bar `← MAP` for SWAP/DERIVS/VAULT/CREDIT; internal `← MAP` for ARENA/INDEX; visible tabs for WORLD/STATS). No component reads the visible tab set, queries the DOM, or stores view state elsewhere (`rg querySelector|getElementById` → only `main.tsx` root). Theme classes `.theme-credit/.theme-arena/.theme-kingdom` (`App.tsx:170`) map 1:1 to the three CSS blocks in `index.css:127–182`; the venue bar renders inside the themed root so its `.fkey` inherits venue theming (intended). `WorldView.SPOTS` covers all six venues incl. sealed-gate `live` flags. **No orphaned view, no dead path.**

**Stale closures / races.** `FKeyBar`'s effect deps `[setView]` — a stable React state setter; no stale capture. `App`'s quote loop `quoteSeq` + `lastQuoteKey` (L119–139) correctly drops out-of-order responses and never shows a quote for different params (B-02 preserved); polls read via `listingsRef` (B-08 preserved). Boot retry backoff caps at 15 s with `dead` flag. All intervals/timeouts are cleaned up. **Clean.**

**Unbounded renders.** `listings` is bounded by on-chain discovery (≤ 95 tokens, dust-filtered at `data.ts:87`); `MarketWatch` renders one `<tr>` per listing with stable keys; `prev.current` map grows only per symbol (bounded). Flash `setTimeout` batches, no per-row timers. **Clean.**

**375 px / 1280 px layout (class-level analysis, no live render).** Footer: 2 tabs (`min-w-[90px] max-w-[220px]`) + copyright (`min-w-[220px]`) with `flex-wrap` wraps cleanly to two rows at 375 px — strictly better than the old 6-tab wrap. Venue bar: desc is `hidden sm:inline`, `← MAP` is `ml-auto` — fits at 375 px. `MarketWatch`: `whitespace-nowrap` + `overflow-auto` correctly trades mid-number price wrapping (old bug) for horizontal scroll on pathological widths; at realistic prices ("$1,234.56") no scrollbar appears at 375 px. At 1280 px (`lg` grid, 3/5/4 cols) nothing in the diff affects column math. New `max-w-[220px]` on tabs prevents two lonely tabs from stretching absurdly at 1280 px. **No regression found**, with the honest caveat that this was not pixel-verified in a browser.

**Trader-misleading behavior changes.** No price, fee, quote, slippage, or route computation was touched. Formatter changes are strictly protective: "—" replaces `"$NaN"`, exponential replaces 23-digit strings — both previously *more* misleading. VENUE_META strings match the map exactly. The STALE quote badge (B-22) and FairPriceShield logic are untouched. **The only mislead-adjacent items are R5-01 (F5 "refresh" that doesn't refresh) and R5-02 (SR users told they're on WORLD).**

---

## 4. Summary table

| ID | Sev | File:Line | Title | FP risk |
|---|---|---|---|---|
| R5-01 | **M** | FKeyBar.tsx:24–34 | F5 (reload) / F3 / F6 hijacked by now-invisible deep-links; comment falsely claims browser shortcuts untouched | Low |
| R5-02 | **M** | FKeyBar.tsx:40–41, App.tsx:173–179 | `aria-pressed` toggle misuse — WORLD "pressed" on all non-STATS views; view changes unannounced to AT | Low |
| R5-03 | L | format.ts:24, 32 | `usdCompact`/`compact` guard is `v >= 1e15`, not `|v|` — negative extremes render unbounded width | **High** (no negative callers today) |
| R5-04 | L | format.ts:43–48 | `pct`/`delta` excluded from new NaN guards; `delta` is dead code | **High** (only constant caller) |
| R5-05 | L | App.tsx:177, WorldView.tsx:105–146 | Focus dropped to `<body>` on every map↔venue transition (regression vs persistent tabs) | Low |
| R5-06 | L | FKeyBar.tsx:32 + WalletPicker.tsx:24–33 | F-keys navigate behind the `aria-modal` wallet dialog | Low |
| R5-07 | L | MarketWatch.tsx:33–41 | Sticky `thead` + `border-collapse` border seam in the new scroll wrapper | **High** (cosmetic, modern browsers) |
| R5-08 | L | MarketWatch.tsx:13–25 | Flash highlight can freeze if listings re-render < 950 ms with no changes | **High** (10 s poll cadence) |
| R5-09 | Info | App.tsx:180 | SWAP is silent `else` — no exhaustiveness check | — |
| R5-10 | Info | App.tsx:33–38 / WorldView.tsx:25–32 | VENUE_META duplicates SPOTS copy — drift risk | — |
| R5-11 | Info | FKeyBar.tsx:4, App-wide | No URL/history sync; "deep-links" misnomer; Back exits app | — |
| R5-12 | Info | App.tsx:173 + DerivsView.tsx:33 | Double header chrome on DERIVS at 375 px | — |
| R5-13 | Info | format.ts:6 | `"$-2.00e+15"` sign placement; 1e15 boundary abruptness | — |
| R5-14 | Info | repo-wide | F2–F5 shortcuts advertised nowhere in-product | — |

**Counts:** 0 Critical · 0 High · 2 Medium · 6 Low · 6 Info.

---

## 5. Verdict

# ✅ SHIP

No Critical/High findings; no XSS, no fund-path, price, fee, or quote behavior changed; the format.ts guards are a strict safety improvement at every one of the 60+ audited call sites; routing has no dead ends and no component depends on the removed tabs. The two Mediums are real but confined to keyboard/AT ergonomics: **R5-01 (release the F5 claim)** and **R5-02 (replace `aria-pressed` with `aria-current` + announce view changes)** are small, isolated patches strongly recommended for the next release train, together with the two-line sign fix of R5-03 before any signed value ever reaches `usdCompact`/`compact`.

*Audit R5 · 2026-09-03 · static review at commit `55ef29a3`; no live-browser pixel verification performed.*
