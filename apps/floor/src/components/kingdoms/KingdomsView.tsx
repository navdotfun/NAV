/* KINGDOMS (Index Factory) — permissionless stock-basket kingdoms on
   NavIndexFactory. Found a kingdom (create an index), swear fealty by
   issuing shares (direct basket pulls or one-tx USDG zap), and dissolve
   holdings via redeem/zap-out. Every number reads live from chain —
   nothing simulated, nothing cached beyond the 15s refresh. */
import { useCallback, useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import type { Address } from "viem";
import type { FloorView } from "../../App";
import { useWallet } from "../../lib/wallet";
import {
  INDEX_FACTORY, INDEX_ZAP,
  fetchKingdoms, fetchShareBalance, quoteZapIssue, quoteZapRedeem,
  issueShares, redeemShares, zapIssueShares, zapRedeemShares, foundKingdom,
  kingdomRevertName,
  MIN_COMPONENTS, MAX_COMPONENTS, MAX_MINT_FEE_BPS, MAX_REDEEM_FEE_BPS, MAX_STREAM_FEE_BPS,
  type Kingdom, type KingdomPhase, type ZapIssueQuote, type ZapRedeemQuote,
} from "../../lib/kingdoms";
import { EXPLORER } from "../../lib/chain";
import registry from "../../lib/stocktokens.json";

const REG = registry as { symbol: string; name: string; address: string; decimals: number }[];

function fmtShares(v: bigint): string {
  return Number(formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function fmtUsdg(v: bigint): string {
  return Number(formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtBps(v: bigint): string {
  return `${(Number(v) / 100).toFixed(2)}%`;
}
function phaseLabel(p: KingdomPhase | null): string | null {
  if (!p) return null;
  if (p.k === "approving") return "APPROVING…";
  if (p.k === "sending") return "SIGNING…";
  if (p.k === "confirming") return "CONFIRMING…";
  return "DONE";
}

interface FoundRow { token: string; units: string }

export function KingdomsView({ setView }: { setView: (v: FloorView) => void }) {
  const wallet = useWallet();
  const [kingdoms, setKingdoms] = useState<Kingdom[]>([]);
  const [selected, setSelected] = useState<Address | null>(null);
  const [myShares, setMyShares] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [phase, setPhase] = useState<KingdomPhase | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /* issue / redeem inputs (18-dec share amounts) */
  const [issueAmt, setIssueAmt] = useState("");
  const [redeemAmt, setRedeemAmt] = useState("");
  const [zapMode, setZapMode] = useState(true);
  const [zapInQuote, setZapInQuote] = useState<ZapIssueQuote | null>(null);
  const [zapOutQuote, setZapOutQuote] = useState<ZapRedeemQuote | null>(null);
  const [quoting, setQuoting] = useState(false);

  /* found-a-kingdom form */
  const [showFound, setShowFound] = useState(false);
  const [fName, setFName] = useState("");
  const [fSymbol, setFSymbol] = useState("");
  const [fRows, setFRows] = useState<FoundRow[]>([
    { token: "", units: "" }, { token: "", units: "" },
  ]);
  const [fMintFee, setFMintFee] = useState("50");
  const [fRedeemFee, setFRedeemFee] = useState("50");
  const [fStreamFee, setFStreamFee] = useState("100");

  const refresh = useCallback(async () => {
    if (!INDEX_FACTORY) { setLoading(false); return; }
    try {
      const ks = await fetchKingdoms();
      setKingdoms(ks);
      setSelected((cur) => cur ?? (ks.length > 0 ? ks[0].address : null));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const kingdom = kingdoms.find((k) => k.address === selected) ?? null;

  useEffect(() => {
    setMyShares(null); setZapInQuote(null); setZapOutQuote(null);
    if (!kingdom || !wallet.account) return;
    void fetchShareBalance(kingdom.address, wallet.account).then(setMyShares).catch(() => setMyShares(null));
  }, [kingdom?.address, wallet.account]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- gate ---------- */

  /* Sealed mode: NavIndexFactory is not yet deployed. The full realm renders
     so anyone can walk the Kingdoms — real interface, zero simulated data —
     but every write is disarmed until the contracts are live and verified. */
  const sealed = !INDEX_FACTORY;

  /* ---------- actions ---------- */

  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (sealed) return;
    setBusy(key); setErr(null); setPhase(null);
    try { await fn(); await refresh(); if (kingdom && wallet.account) setMyShares(await fetchShareBalance(kingdom.address, wallet.account)); }
    catch (e) {
      const name = kingdomRevertName(e);
      setErr(name ? `REVERT: ${name}` : e instanceof Error ? e.message.slice(0, 160) : "TX FAILED");
    } finally { setBusy(null); setPhase(null); }
  };

  const parseShares = (s: string): bigint | null => {
    try { const v = parseUnits(s as `${number}`, 18); return v > 0n ? v : null; } catch { return null; }
  };

  const quoteIn = async () => {
    const amt = parseShares(issueAmt);
    if (!kingdom || !amt) return;
    setQuoting(true); setErr(null); setZapInQuote(null);
    try { setZapInQuote(await quoteZapIssue(kingdom, amt)); }
    catch { setErr("QUOTE FAILED — RPC OR ROUTING ERROR"); }
    finally { setQuoting(false); }
  };
  const quoteOut = async () => {
    const amt = parseShares(redeemAmt);
    if (!kingdom || !amt) return;
    setQuoting(true); setErr(null); setZapOutQuote(null);
    try { setZapOutQuote(await quoteZapRedeem(kingdom, amt)); }
    catch { setErr("QUOTE FAILED — RPC OR ROUTING ERROR"); }
    finally { setQuoting(false); }
  };

  const submitFound = () => {
    const rows = fRows.filter((r) => r.token && r.units);
    if (rows.length < MIN_COMPONENTS) { setErr(`AT LEAST ${MIN_COMPONENTS} COMPONENTS`); return; }
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.token.toLowerCase())) { setErr("DUPLICATE COMPONENT"); return; }
      seen.add(r.token.toLowerCase());
    }
    let units: bigint[];
    try { units = rows.map((r) => parseUnits(r.units as `${number}`, 18)); }
    catch { setErr("BAD UNITS"); return; }
    if (units.some((u) => u <= 0n)) { setErr("UNITS MUST BE > 0"); return; }
    const mint = BigInt(Math.round(Number(fMintFee)));
    const redeem = BigInt(Math.round(Number(fRedeemFee)));
    const stream = BigInt(Math.round(Number(fStreamFee)));
    if (mint > MAX_MINT_FEE_BPS || redeem > MAX_REDEEM_FEE_BPS || stream > MAX_STREAM_FEE_BPS) {
      setErr(`FEE CAPS: MINT ${MAX_MINT_FEE_BPS} / REDEEM ${MAX_REDEEM_FEE_BPS} / STREAM ${MAX_STREAM_FEE_BPS} BPS`); return;
    }
    if (!fName.trim() || !fSymbol.trim()) { setErr("NAME AND SYMBOL REQUIRED"); return; }
    void run("found", async () => {
      await foundKingdom(wallet.account!, {
        name: fName.trim(), symbol: fSymbol.trim().toUpperCase(),
        components: rows.map((r) => r.token as Address),
        unitsPerShare: units,
        mintFeeBps: mint, redeemFeeBps: redeem, streamFeeBps: stream,
      }, setPhase);
      setShowFound(false); setFName(""); setFSymbol("");
      setFRows([{ token: "", units: "" }, { token: "", units: "" }]);
    });
  };

  const connected = !!wallet.account;

  /* ---------- render ---------- */

  return (
    <main className="flex-1 min-h-0 flex flex-col p-[2px] gap-[2px] overflow-y-auto">
      {sealed && (
        <div className="panel px-3 py-1.5 text-[11px] flex items-center gap-3 border-amber">
          <span className="text-amber-2">DRAWBRIDGE RAISED</span>
          <span className="text-txt-dim">
            NavIndexFactory IS NOT YET DEPLOYED — YOU ARE WALKING THE KINGDOMS BEFORE THE REALM OPENS. NO KINGDOMS EXIST,
            NOTHING IS SIMULATED, AND ALL ACTIONS ARE DISARMED UNTIL THE CONTRACTS ARE LIVE AND SOURCIFY-VERIFIED.
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-[2px]">
      {/* left: kingdom roll */}
      <section className="panel md:w-[340px] md:min-w-[340px] flex flex-col min-h-[200px]">
        <div className="panel-title flex items-center">
          THE KINGDOMS
          <button type="button" className="fkey ml-auto px-3 py-1 text-[11px]" onClick={() => setView("WORLD")}>← MAP</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="p-3 text-txt-dim text-[12px]">READING THE REALM…</div>}
          {!loading && kingdoms.length === 0 && (
            <div className="p-3 text-txt-dim text-[12px]">
              {sealed ? "NO KINGDOMS — THE REALM OPENS WITH DEPLOYMENT." : "NO KINGDOMS FOUNDED YET. BE THE FIRST — RAISE YOUR BANNER BELOW."}
            </div>
          )}
          {kingdoms.map((k) => (
            <button key={k.address} type="button" onClick={() => setSelected(k.address)}
              className={`w-full text-left px-3 py-2 border-b border-rule hover:bg-[#141210] ${selected === k.address ? "bg-[#141210]" : ""}`}>
              <div className="flex justify-between text-[13px]">
                <span className="text-txt">{k.symbol}</span>
                <span className="text-txt-dim">{k.components.length} ASSETS</span>
              </div>
              <div className="flex justify-between text-[11px] text-txt-dim">
                <span>{k.name.toUpperCase()}</span>
                <span>{fmtShares(k.totalSupply)} SHARES</span>
              </div>
            </button>
          ))}
        </div>
        <div className="border-t border-rule p-2">
          <button type="button" className="btn-exec w-full py-2 text-[12px]"
            onClick={() => setShowFound((s) => !s)}>
            {showFound ? "CLOSE THE CHARTER" : "⚑ FOUND A KINGDOM"}
          </button>
        </div>
      </section>

      {/* right: detail / charter */}
      <section className="panel flex-1 flex flex-col min-h-[300px]">
        {showFound ? (
          <>
            <div className="panel-title">ROYAL CHARTER — FOUND A KINGDOM</div>
            <div className="p-3 grid gap-2 max-w-xl">
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 text-[11px] text-txt-dim">NAME
                  <input className="term-input" value={fName} onChange={(e) => setFName(e.target.value)} placeholder="NAV BLUE" />
                </label>
                <label className="grid gap-1 text-[11px] text-txt-dim">SYMBOL
                  <input className="term-input" value={fSymbol} onChange={(e) => setFSymbol(e.target.value)} placeholder="BLUE" />
                </label>
              </div>
              <div className="text-[11px] text-txt-dim mt-1">COMPONENTS ({MIN_COMPONENTS}–{MAX_COMPONENTS}) — UNITS PER SHARE</div>
              {fRows.map((row, i) => (
                <div key={i} className="grid grid-cols-[1fr_120px_32px] gap-2">
                  <select className="term-input" value={row.token}
                    onChange={(e) => setFRows((rs) => rs.map((r, j) => j === i ? { ...r, token: e.target.value } : r))}>
                    <option value="">— TOKEN —</option>
                    {REG.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
                  </select>
                  <input className="term-input" placeholder="0.10" value={row.units}
                    onChange={(e) => setFRows((rs) => rs.map((r, j) => j === i ? { ...r, units: e.target.value } : r))} />
                  <button type="button" className="fkey" disabled={fRows.length <= MIN_COMPONENTS}
                    onClick={() => setFRows((rs) => rs.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button type="button" className="fkey px-3 py-1 text-[11px] w-fit" disabled={fRows.length >= MAX_COMPONENTS}
                onClick={() => setFRows((rs) => [...rs, { token: "", units: "" }])}>+ ADD COMPONENT</button>
              <div className="grid grid-cols-3 gap-2">
                <label className="grid gap-1 text-[11px] text-txt-dim">MINT FEE (BPS ≤ {`${MAX_MINT_FEE_BPS}`})
                  <input className="term-input" value={fMintFee} onChange={(e) => setFMintFee(e.target.value)} />
                </label>
                <label className="grid gap-1 text-[11px] text-txt-dim">REDEEM FEE (BPS ≤ {`${MAX_REDEEM_FEE_BPS}`})
                  <input className="term-input" value={fRedeemFee} onChange={(e) => setFRedeemFee(e.target.value)} />
                </label>
                <label className="grid gap-1 text-[11px] text-txt-dim">STREAM FEE (BPS/YR ≤ {`${MAX_STREAM_FEE_BPS}`})
                  <input className="term-input" value={fStreamFee} onChange={(e) => setFStreamFee(e.target.value)} />
                </label>
              </div>
              <p className="text-[11px] text-txt-dim">
                90% OF ALL FEES FLOW TO YOU, THE FOUNDER; 10% TO THE NAV VAULT.
                COMPOSITION IS IMMUTABLE ONCE CHARTERED.
              </p>
              {sealed ? (
                <button type="button" className="btn-exec py-2" disabled>SEALED</button>
              ) : connected ? (
                <button type="button" className="btn-exec py-2" disabled={busy !== null} onClick={submitFound}>
                  {busy === "found" ? phaseLabel(phase) ?? "…" : "SIGN THE CHARTER"}
                </button>
              ) : <div className="text-[12px] text-txt-dim">CONNECT A WALLET (F10) TO FOUND A KINGDOM.</div>}
            </div>
          </>
        ) : !kingdom ? (
          <div className="flex-1 relative flex items-center justify-center text-txt-dim text-[12px] overflow-hidden">
            <img src="./world/kingdom.png" alt="The Kingdoms — pixel-art castle"
              className="absolute inset-0 w-full h-full object-cover opacity-25" style={{ imageRendering: "pixelated" }} draggable={false} />
            <span className="relative px-4 text-center max-w-md">
              {loading ? "READING THE REALM…"
                : sealed ? "THE THRONE ROOM AWAITS ITS FIRST FOUNDER. WHEN NavIndexFactory GOES LIVE, ANYONE MAY CHARTER A KINGDOM — AN IMMUTABLE ON-CHAIN STOCK INDEX — AND EARN 90% OF ITS FEES."
                : "SELECT A KINGDOM"}
            </span>
          </div>
        ) : (
          <>
            <div className="panel-title flex items-center gap-2">
              {kingdom.symbol} — {kingdom.name.toUpperCase()}
              <a className="ml-auto text-[11px] text-txt-dim underline" target="_blank" rel="noreferrer"
                href={`${EXPLORER}/address/${kingdom.address}`}>CONTRACT ↗</a>
            </div>
            <div className="p-3 grid gap-3 overflow-y-auto">
              {/* treasury table */}
              <div>
                <div className="cell-label mb-1">ROYAL TREASURY — UNITS PER SHARE</div>
                <table className="w-full text-[12px]">
                  <tbody>
                    {kingdom.components.map((c) => (
                      <tr key={c.address} className="border-b border-rule">
                        <td className="py-1 text-txt">{c.symbol}</td>
                        <td className="py-1 text-right text-txt-dim">{Number(formatUnits(c.unitsPerShare, c.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                <div><div className="cell-label">SUPPLY</div><div className="text-txt">{fmtShares(kingdom.totalSupply)}</div></div>
                <div><div className="cell-label">MINT FEE</div><div className="text-txt">{fmtBps(kingdom.mintFeeBps)}</div></div>
                <div><div className="cell-label">REDEEM FEE</div><div className="text-txt">{fmtBps(kingdom.redeemFeeBps)}</div></div>
                <div><div className="cell-label">STREAM FEE</div><div className="text-txt">{fmtBps(kingdom.streamFeeBps)}/YR</div></div>
              </div>
              {connected && (
                <div className="text-[12px]">
                  <span className="cell-label mr-2">MY SHARES</span>
                  <span className="text-amber">{myShares === null ? "…" : fmtShares(myShares)}</span>
                </div>
              )}

              {/* issue / redeem */}
              <div className="grid md:grid-cols-2 gap-2">
                <div className="border border-rule p-2 grid gap-2">
                  <div className="cell-label">SWEAR FEALTY — ISSUE SHARES</div>
                  <input className="term-input" placeholder="SHARES E.G. 1.0" value={issueAmt}
                    onChange={(e) => { setIssueAmt(e.target.value); setZapInQuote(null); }} />
                  <label className="flex items-center gap-2 text-[11px] text-txt-dim">
                    <input type="checkbox" checked={zapMode} onChange={(e) => { setZapMode(e.target.checked); setZapInQuote(null); setZapOutQuote(null); }} />
                    ZAP — PAY IN USDG, ONE TX {INDEX_ZAP ? "" : "(ZAP NOT DEPLOYED)"}
                  </label>
                  {zapMode && INDEX_ZAP ? (
                    <>
                      <button type="button" className="fkey py-1 text-[11px]" disabled={quoting || !parseShares(issueAmt)} onClick={() => void quoteIn()}>
                        {quoting ? "QUOTING…" : "QUOTE COST"}
                      </button>
                      {zapInQuote && zapInQuote.unroutable.length === 0 && (
                        <div className="text-[11px] text-txt-dim">MAX COST <span className="text-amber">{fmtUsdg(zapInQuote.totalUsdg)} USDG</span> — LEFTOVERS REFUNDED</div>
                      )}
                      {zapInQuote && zapInQuote.unroutable.length > 0 && (
                        <div className="text-[11px] text-dn">UNROUTABLE LEGS — USE DIRECT ISSUE</div>
                      )}
                      {connected ? (
                        <button type="button" className="btn-exec py-2" disabled={busy !== null || !zapInQuote || zapInQuote.unroutable.length > 0}
                          onClick={() => { const amt = parseShares(issueAmt); if (amt && zapInQuote) void run("zapin", () => zapIssueShares(wallet.account!, kingdom, amt, zapInQuote, setPhase)); }}>
                          {busy === "zapin" ? phaseLabel(phase) ?? "…" : "ZAP IN"}
                        </button>
                      ) : <div className="text-[11px] text-txt-dim">CONNECT (F10) TO ISSUE.</div>}
                    </>
                  ) : (
                    connected ? (
                      <button type="button" className="btn-exec py-2" disabled={busy !== null || !parseShares(issueAmt)}
                        onClick={() => { const amt = parseShares(issueAmt); if (amt) void run("issue", () => issueShares(wallet.account!, kingdom, amt, setPhase)); }}>
                        {busy === "issue" ? phaseLabel(phase) ?? "…" : "ISSUE (DIRECT BASKET)"}
                      </button>
                    ) : <div className="text-[11px] text-txt-dim">CONNECT (F10) TO ISSUE.</div>
                  )}
                </div>

                <div className="border border-rule p-2 grid gap-2">
                  <div className="cell-label">DISSOLVE — REDEEM SHARES</div>
                  <input className="term-input" placeholder="SHARES E.G. 1.0" value={redeemAmt}
                    onChange={(e) => { setRedeemAmt(e.target.value); setZapOutQuote(null); }} />
                  {zapMode && INDEX_ZAP ? (
                    <>
                      <button type="button" className="fkey py-1 text-[11px]" disabled={quoting || !parseShares(redeemAmt)} onClick={() => void quoteOut()}>
                        {quoting ? "QUOTING…" : "QUOTE PROCEEDS"}
                      </button>
                      {zapOutQuote && zapOutQuote.unroutable.length === 0 && (
                        <div className="text-[11px] text-txt-dim">EXPECTED <span className="text-amber">{fmtUsdg(zapOutQuote.expectedUsdg)} USDG</span> (MIN −1%)</div>
                      )}
                      {zapOutQuote && zapOutQuote.unroutable.length > 0 && (
                        <div className="text-[11px] text-dn">UNROUTABLE LEGS — USE DIRECT REDEEM</div>
                      )}
                      {connected ? (
                        <button type="button" className="btn-exec py-2" disabled={busy !== null || !zapOutQuote || zapOutQuote.unroutable.length > 0}
                          onClick={() => { const amt = parseShares(redeemAmt); if (amt && zapOutQuote) void run("zapout", () => zapRedeemShares(wallet.account!, kingdom, amt, zapOutQuote, 100n, setPhase)); }}>
                          {busy === "zapout" ? phaseLabel(phase) ?? "…" : "ZAP OUT"}
                        </button>
                      ) : <div className="text-[11px] text-txt-dim">CONNECT (F10) TO REDEEM.</div>}
                    </>
                  ) : (
                    connected ? (
                      <button type="button" className="btn-exec py-2" disabled={busy !== null || !parseShares(redeemAmt)}
                        onClick={() => { const amt = parseShares(redeemAmt); if (amt) void run("redeem", () => redeemShares(wallet.account!, kingdom, amt, setPhase)); }}>
                        {busy === "redeem" ? phaseLabel(phase) ?? "…" : "REDEEM (FULL BASKET)"}
                      </button>
                    ) : <div className="text-[11px] text-txt-dim">CONNECT (F10) TO REDEEM.</div>
                  )}
                </div>
              </div>

              {err && <div className="text-dn text-[12px]">{err}</div>}

              <div className="border border-rule p-2 text-[11px] text-txt-dim leading-relaxed">
                <div className="cell-label mb-1">LAWS OF THE REALM</div>
                ISSUE PULLS THE EXACT BASKET FROM YOUR WALLET (OR ZAP ROUTES USDG
                THROUGH ON-CHAIN POOLS IN ONE ATOMIC TX — SHORTFALLS REVERT).
                REDEEM DELIVERS YOUR PRO-RATA SHARE OF EVERY COMPONENT. FEES:
                MINT {fmtBps(kingdom.mintFeeBps)} · REDEEM {fmtBps(kingdom.redeemFeeBps)} ·
                STREAM {fmtBps(kingdom.streamFeeBps)}/YR — 90% TO THE FOUNDER,
                10% TO THE NAV VAULT. COMPOSITION IS IMMUTABLE. NO ORACLE, NO
                ADMIN, NO PAUSE — PURE ERC-20 VAULT MATH.
              </div>
            </div>
          </>
        )}
      </section>
      </div>
    </main>
  );
}
