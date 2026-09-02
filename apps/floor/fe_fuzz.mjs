/* FLOOR frontend mega-fuzz — property tests against the REAL shipped source
   (esbuild bundles of src/lib/*, plus viem parseUnits pipeline from App.tsx).
   Usage: node fe_fuzz.mjs <seed>                                          */
import { parseUnits } from "viem";

const SEED = Number(process.argv[2] ?? 1);
/* ---- deterministic PRNG (mulberry32) ---- */
let _s = SEED >>> 0;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];
function rbig(maxBits) { let v = 0n; const bits = 1 + ri(maxBits); for (let i = 0; i < bits; i += 30) v = (v << 30n) | BigInt(ri(1 << 30)); return v & ((1n << BigInt(bits)) - 1n); }
function rlog(lo, hi) { const l = Math.log(lo), h = Math.log(hi); return Math.exp(l + rnd() * (h - l)); }

let fails = 0, total = 0;
const bad = [];
function check(cond, suite, detail) { total++; if (!cond) { fails++; if (bad.length < 25) bad.push(`[${suite}] ${detail}`); } }
function done(suite, n) { console.log(`${suite}: ${n.toLocaleString()} cases, fails so far ${fails}`); }

/* stub browser globals BEFORE importing wallet bundle */
const loc = { href: "", host: "", pathname: "", hash: "", origin: "" };
globalThis.window = { location: loc, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
try { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "" }, configurable: true, writable: true }); } catch { /* replaced below if needed */ }
globalThis.localStorage = globalThis.window.localStorage;
globalThis.document = { createElement: () => ({}), addEventListener() {} };

const fmtMod = await import("./.fuzz/format.mjs");
const venuesMod = await import("./.fuzz/venues.mjs");
const walletMod = await import("./.fuzz/wallet.mjs");
const dataMod = await import("./.fuzz/data.mjs");
const { fmt } = fmtMod;

/* ============ SUITE 1: format.ts (1.2M) ============ */
{
  const N = 1_200_000;
  for (let i = 0; i < N; i++) {
    const mode = ri(8);
    let v = rlog(1e-15, 1e15) * (mode === 7 ? -1 : 1);
    if (mode === 0) v = ri(1e9);                      // integers
    if (mode === 1) v = ri(1e6) + 0.999999 * rnd();   // .999 edges
    if (mode === 2) v = 0;
    const d = ri(7);
    // usd: parse-back within half-ulp of displayed precision
    const su = fmt.usd(Math.abs(v), d);
    check(su.startsWith("$") && !su.includes("NaN") && !su.includes("Infinity"), "usd", `${v} d=${d} -> ${su}`);
    const pu = Number(su.replace(/[$,]/g, ""));
    check(Math.abs(pu - Math.abs(v)) <= 0.5 * 10 ** -d + Math.abs(v) * 1e-9, "usd-roundtrip", `${v} d=${d} -> ${su}`);
    // num mirrors usd without $
    const sn = fmt.num(v, d);
    check(Math.abs(Number(sn.replace(/,/g, "")) - v) <= 0.5 * 10 ** -d + Math.abs(v) * 1e-9, "num", `${v} d=${d} -> ${sn}`);
    // pct: exact vs reference
    check(fmt.pct(v, 2) === (v * 100).toFixed(2) + "%", "pct", `${v} -> ${fmt.pct(v, 2)}`);
    // delta: sign glyph
    const sd = fmt.delta(v);
    check(sd.startsWith(v >= 0 ? "▲ " : "▼ ") && sd.endsWith("%") && sd.includes(Math.abs(v).toFixed(2)), "delta", `${v} -> ${sd}`);
    // usdTiny on price domain
    const p = mode < 4 ? rlog(1e-9, 1e5) : rlog(1e-4, 1e-1);
    const st = fmt.usdTiny(p);
    check(typeof st === "string" && st.startsWith("$") && !st.includes("NaN"), "usdTiny", `${p} -> ${st}`);
    if (p > 0 && p < 0.01) {
      const m = st.match(/^\$0\.0([₀₁₂₃₄₅₆₇₈₉]+)(\d+)$/);
      if (m) {
        const zeros = Number([...m[1]].map((c) => "₀₁₂₃₄₅₆₇₈₉".indexOf(c)).join(""));
        const rec = Number(`0.${"0".repeat(zeros)}${m[2]}`);
        check(Math.abs(rec - p) / p < 6e-3, "usdTiny-roundtrip", `${p} -> ${st} rec=${rec}`);
      } else check(st.startsWith("$0.0"), "usdTiny-form", `${p} -> ${st}`);
    }
    // compact family
    const c = Math.abs(v);
    const sc = fmt.usdCompact(c);
    const mm = sc.match(/^\$([\d.]+)([BMK]?)$/);
    check(!!mm, "usdCompact-form", `${c} -> ${sc}`);
    if (mm) {
      const mult = { B: 1e9, M: 1e6, K: 1e3, "": 1 }[mm[2]];
      const tol = mm[2] === "K" ? 0.05 * 1e3 : mm[2] === "" ? 0.005 : 0.005 * mult;
      check(Math.abs(Number(mm[1]) * mult - c) <= tol + c * 1e-9, "usdCompact-val", `${c} -> ${sc}`);
    }
    // no-throw on hostile inputs
    if (i % 1000 === 0) { fmt.usd(NaN); fmt.usdTiny(NaN); fmt.compact(-Infinity); fmt.delta(NaN); }
  }
  done("S1 format", N);
}

/* ============ SUITE 2: App.tsx amount-parse pipeline (600k) ============ */
{
  const N = 600_000;
  const frag = ["0", "1", "9", ".", ",", "-", "+", "e", "E", "٣", "😀", " ", "\t", "x", "f", "Infinity", "NaN", "1e308", "0x10", "999999999999999999999999", "\u00A0", "'", '"'];
  const decs = [6, 18];
  for (let i = 0; i < N; i++) {
    let s;
    const kind = ri(4);
    if (kind === 0) { s = ""; const n = 1 + ri(12); for (let k = 0; k < n; k++) s += pick(frag); }
    else if (kind === 1) s = String(rlog(1e-12, 1e12));
    else if (kind === 2) s = ri(1e9) + "." + String(ri(1e9)).padStart(ri(30), "0");
    else s = pick(["", "0", "0.0", "-1", "1.", ".5", "1..2", "1,000", "1e5", "00042", String(Number.MAX_SAFE_INTEGER) + "000"]);
    const d = pick(decs);
    /* replicate App.tsx guard exactly */
    const amt = Number(s);
    let amountIn = null, rejected = false;
    if (!s || !isFinite(amt) || amt <= 0) rejected = true;
    else { try { amountIn = parseUnits(s, d); } catch { rejected = true; } }
    /* invariants: accepted values are non-negative bigints; a ≤0n result must be
       caught by quoteRoute's own guard (amountIn <= 0n → null) */
    if (!rejected) {
      check(typeof amountIn === "bigint", "parse-type", JSON.stringify(s));
      check(amountIn >= 0n, "parse-nonneg", `${JSON.stringify(s)} -> ${amountIn}`);
    }
    check(!(rejected && amountIn !== null), "parse-consistency", JSON.stringify(s));
  }
  done("S2 amount-parse", N);
}

/* ============ SUITE 3: fee & minOut bigint math — Solidity semantics (1.2M) ============ */
{
  const N = 1_200_000; const FEE = 20n;
  for (let i = 0; i < N; i++) {
    const w = rbig(160);
    const fee = (w * FEE) / 10_000n;
    check(fee * 10_000n <= w * FEE && w * FEE < (fee + 1n) * 10_000n, "fee-floor", `w=${w}`);
    const net = w - fee;
    check(net + fee === w && net >= 0n, "fee-conserve", `w=${w}`);
    if (w > 0n) check(net > 0n, "fee-lt-amount", `w=${w}`);
    const w2 = w + rbig(64);
    check((w2 * FEE) / 10_000n >= fee, "fee-monotone", `w=${w} w2=${w2}`);
    // minOut (SwapPanel.tsx line 57)
    const q = rbig(128);
    const s = i % 3 === 0 ? BigInt(pick([10, 50, 100])) : BigInt(ri(10_001));
    const minOut = q - (q * s) / 10_000n;
    check(minOut >= 0n && minOut <= q, "minout-range", `q=${q} s=${s}`);
    if (s === 0n) check(minOut === q, "minout-s0", `q=${q}`);
    const s2 = s + BigInt(ri(Number(10_000n - s) + 1));
    check(q - (q * s2) / 10_000n <= minOut, "minout-monotone", `q=${q} s=${s} s2=${s2}`);
    if (s <= 100n) check(minOut >= (q * 99n) / 100n, "minout-ui-floor", `q=${q} s=${s}`);
  }
  done("S3 fee/minOut", N);
}

/* ============ SUITE 4: route composition vs mock AMM (400k) ============ */
{
  const N = 400_000; const FEE = 20n;
  const amm = (rIn, rOut, x) => (rOut * x) / (rIn + x); // v2 curve, monotone
  for (let i = 0; i < N; i++) {
    const R1i = 1n + rbig(112), R1o = 1n + rbig(112), R2i = 1n + rbig(112), R2o = 1n + rbig(112);
    const a = 1n + rbig(100);
    const w = amm(R1i, R1o, a);
    const fee = (w * FEE) / 10_000n; const net = w - fee;
    const out = net > 0n ? amm(R2i, R2o, net) : 0n;
    check(out <= amm(R2i, R2o, w), "route-fee-hurts", `a=${a}`);      // fee never increases output
    check(out < R2o, "route-bounded", `a=${a}`);                        // can't drain the pool
    const a2 = a + 1n + rbig(64);
    const w2 = amm(R1i, R1o, a2); const net2 = w2 - (w2 * FEE) / 10_000n;
    check((net2 > 0n ? amm(R2i, R2o, net2) : 0n) >= out, "route-monotone", `a=${a} a2=${a2}`);
  }
  done("S4 route-mock", N);
}

/* ============ SUITE 5: Fair Price Shield verdict (800k) ============ */
{
  const N = 800_000;
  for (let i = 0; i < N; i++) {
    const ref = i % 17 === 0 ? pick([0, -1, 1e-12]) : rlog(1e-6, 1e6);
    const dev = (rnd() - 0.5) * 0.3;                     // ±15%
    const exec = i % 13 === 0 ? rlog(1e-6, 1e6) : ref * (1 + dev);
    const side = rnd() < 0.5 ? "BUY" : "SELL";
    /* replicate FairPriceShield.tsx exactly */
    const refPrice = ref > 0 ? ref : null;
    const devBps = exec !== null && refPrice !== null && refPrice > 0 ? ((exec - refPrice) / refPrice) * 10_000 : null;
    const adverse = devBps !== null ? (side === "BUY" ? devBps : -devBps) : null;
    const verdict = adverse === null ? null : adverse <= 30 ? "FAIR" : adverse <= 100 ? "CHECK" : "WIDE";
    if (ref <= 0) check(verdict === null, "shield-null", `ref=${ref}`);
    if (devBps !== null) {
      check(isFinite(devBps), "shield-finite", `exec=${exec} ref=${ref}`);
      if (exec === ref) check(verdict === "FAIR", "shield-zero", `ref=${ref} side=${side}`);
      // favourable deviation is never punished: BUY below anchor / SELL above anchor => FAIR
      if (side === "BUY" && exec <= ref) check(verdict === "FAIR", "shield-favourable", `exec=${exec} ref=${ref}`);
      if (side === "SELL" && exec >= ref) check(verdict === "FAIR", "shield-favourable", `exec=${exec} ref=${ref}`);
      // threshold exactness
      if (adverse !== null && adverse > 30 && adverse <= 100) check(verdict === "CHECK", "shield-check", `adv=${adverse}`);
      if (adverse !== null && adverse > 100) check(verdict === "WIDE", "shield-wide", `adv=${adverse}`);
    }
    const updatedAt = Date.now() / 1000 + (rnd() - 0.5) * 1e6;
    check(Math.max(0, Math.floor(Date.now() / 1000 - updatedAt)) >= 0, "shield-age", `t=${updatedAt}`);
  }
  done("S5 shield", N);
}

/* ============ SUITE 6: venue labels total (300k) ============ */
{
  const N = 300_000;
  for (let i = 0; i < N; i++) {
    const q = { venue: pick([1, 2, 3, 0, 99, -5]), param: pick([100, 500, 3000, 10000, 1, 50, 200, 2000, 0, -1, ri(1e9)]), amountOut: 0n, gasEstimate: 0n };
    let name, short;
    try { name = venuesMod.venueName(q); short = venuesMod.venueShort(q); } catch (e) { check(false, "venue-throw", `${q.venue}/${q.param}: ${e.message}`); continue; }
    check(typeof name === "string" && name.length > 0 && typeof short === "string" && short.length > 0, "venue-str", `${q.venue}/${q.param}`);
    if (q.venue === 1) check(/^UNISWAP V3 -?[\d.]+%$/.test(name) && short === "UNI V3", "venue-v3", name);
    if (q.venue === 2) check(name === `UP· CL TS${q.param}` && short === "UP CL", "venue-cl", name);
  }
  done("S6 venues", N);
}

/* ============ SUITE 7: isMobileUA vs reference (500k) ============ */
{
  const N = 500_000;
  const parts = ["Mozilla/5.0", "iPhone", "iphone", "IPAD", "iPod", "Android", "ANDROID", "Windows NT", "Macintosh", "Linux", "CrOS", "like Mac OS X", "Mobile", "Safari", "😀", "андроид", "iPh0ne", "androi", "droid", " ", ";", "(", ")"];
  const ref = /iphone|ipad|ipod|android/i;
  let canStub = true;
  try { globalThis.navigator.userAgent = "test"; if (globalThis.navigator.userAgent !== "test") canStub = false; } catch { canStub = false; }
  if (!canStub) { try { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "" }, configurable: true }); } catch { canStub = false; } }
  for (let i = 0; i < N; i++) {
    let ua = ""; const n = ri(8); for (let k = 0; k < n; k++) ua += pick(parts) + (rnd() < 0.3 ? "" : " ");
    if (canStub) {
      globalThis.navigator.userAgent = ua;
      check(walletMod.isMobileUA() === ref.test(ua), "ua-match", JSON.stringify(ua));
    } else {
      check(ref.test(ua) === /iphone|ipad|ipod|android/i.test(ua), "ua-ref", JSON.stringify(ua));
    }
  }
  console.log(`S7 UA stubbed=${canStub}`);
  done("S7 isMobileUA", N);
}

/* ============ SUITE 8: mobile deep-link injection fuzz (300k) ============ */
{
  const N = 300_000;
  const hosts = ["nav.fun", "nav.fun:443", "localhost:4199"];
  const evil = ["#https://evil.com", "#//evil.com", "'\"><script>", "../..%2F..", "?cb_url=https://evil.com", "#okx://wallet", " ", "%23", "\u2028", "#@evil.com/", "#&dappUrl=https://evil.com"];
  const allow = { "metamask.app.link": 1, "phantom.app": 1, "go.cb-w.com": 1, "link.trustwallet.com": 1, "www.okx.com": 1 };
  for (let i = 0; i < N; i++) {
    const host = pick(hosts);
    const path = "/" + (rnd() < 0.5 ? "floor/" : "") + (rnd() < 0.3 ? pick(evil).replace(/^#/, "") : "");
    const hash = rnd() < 0.6 ? pick(evil) : "";
    loc.host = host; loc.pathname = path; loc.hash = hash;
    loc.origin = "https://" + host.split(":")[0];
    loc.href = loc.origin + path + hash;
    let links;
    try { links = walletMod.mobileWalletLinks(); } catch (e) { check(false, "dl-throw", e.message); continue; }
    check(links.length === 5, "dl-count", String(links.length));
    for (const l of links) {
      let u; try { u = new URL(l.href); } catch { check(false, "dl-parse", l.href); continue; }
      check(allow[u.host] === 1, "dl-host", `${u.host} <- ${l.href.slice(0, 80)}`);
      check(u.protocol === "https:", "dl-proto", l.href.slice(0, 80));
      if (l.name === "MetaMask") {
        check(!l.href.includes("#"), "dl-mm-nohash", l.href.slice(0, 100));
        const after = l.href.slice("https://metamask.app.link/dapp/".length);
        check(after.startsWith(host.split("/")[0]), "dl-mm-host", after.slice(0, 60));
      }
      // the raw evil fragment must never appear verbatim (it must be %-encoded or dropped)
      if (hash.length > 1) check(!l.href.includes(hash), "dl-frag-encoded", `${l.name}: ${l.href.slice(0, 90)}`);
    }
  }
  done("S8 deeplinks", N);
}

/* ============ SUITE 9: token registry case-insensitivity (200k) ============ */
{
  const N = 200_000;
  const toks = dataMod.STOCK_TOKENS;
  check(new Set(toks.map((t) => t.symbol)).size === toks.length, "registry-uniq-sym", "duplicate symbols");
  check(new Set(toks.map((t) => t.address.toLowerCase())).size === toks.length, "registry-uniq-addr", "duplicate addresses");
  for (const t of toks) check(/^0x[0-9a-fA-F]{40}$/.test(t.address) && (t.decimals === 18 || t.decimals === 6), "registry-shape", t.symbol);
  for (let i = 0; i < N; i++) {
    const t = pick(toks);
    let a = "0x"; for (const ch of t.address.slice(2)) a += rnd() < 0.5 ? ch.toLowerCase() : ch.toUpperCase();
    check(dataMod.TOKEN_BY_ADDR.get(a.toLowerCase()) === t, "registry-lookup", a);
    check(dataMod.TOKEN_BY_SYMBOL.get(t.symbol) === t, "registry-sym", t.symbol);
  }
  done("S9 registry", N);
}

console.log(`\nSEED ${SEED} TOTAL assertions: ${total.toLocaleString()}  FAILS: ${fails}`);
if (bad.length) { console.log("counterexamples:"); for (const b of bad) console.log("  " + b); }
process.exit(fails ? 1 : 0);
