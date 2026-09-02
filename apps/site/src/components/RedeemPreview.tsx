import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import type { Address } from "viem";
import { STOCK_TOKENS, type StockToken } from "../lib/data";
import { PROTOCOL, type VaultState } from "../lib/protocol";
import { erc20Abi, publicClient, EXPLORER } from "../lib/chain";
import { useWallet } from "../lib/wallet";
import { getPriceEntry, usePriceFeed, useBlockNumber } from "../lib/live";
import { Identicon } from "./Identicon";
import { fmt } from "../lib/format";

/* ------------------------------------------------------------------ */
/* Provable in-kind redemption preview.                                */
/*                                                                     */
/* Mirrors NAVVault.redeemInKind exactly (verified source, line-for-   */
/* line):                                                              */
/*   effectiveShares = shares - (shares * redeemFeeBps) / 10_000       */
/*   amount_i        = floor(bal_i * effectiveShares / supplyBefore)   */
/* over ACTIVE assets with bal_i > 0. Inactive assets are SKIPPED      */
/* WITHOUT CREDIT by the contract (audit P3-05), so they are shown     */
/* here as forfeited — and the redeem button is hard-blocked upstream. */
/* Every input (balances, supply, fee) is read live from the chain;    */
/* nothing is hardcoded.                                               */
/* ------------------------------------------------------------------ */

/** Live $NAV balance of the connected wallet (refreshes with each block). */
export function useNavBalance(account: Address | null): bigint | null {
  const [bal, setBal] = useState<bigint | null>(null);
  const block = useBlockNumber();
  useEffect(() => {
    let stop = false;
    if (!account || !PROTOCOL.tokenAddress) {
      setBal(null);
      return;
    }
    publicClient
      .readContract({ address: PROTOCOL.tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [account] })
      .then((b) => { if (!stop) setBal(b as bigint); })
      .catch(() => { if (!stop) setBal(null); });
    return () => { stop = true; };
  }, [account, block]);
  return bal;
}

function parseNav(s: string): bigint | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^\d*\.?\d*$/.test(t) || t === ".") return null;
  try {
    const v = parseUnits(t, 18);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** Format a token amount for the receive list: enough precision to be real,
    never scientific notation. */
function fmtQty(amount: bigint, decimals: number): string {
  const n = Number(formatUnits(amount, decimals));
  if (n === 0) return "0";
  if (n < 0.000001) return "< 0.000001";
  if (n < 1) return n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

interface Row {
  token: StockToken;
  amount: bigint;
  usd: number | null;
}

export function RedeemPreview({
  vault,
  amt,
  onMax,
}: {
  vault: VaultState;
  amt: string;
  onMax: (v: string) => void;
}) {
  const wallet = useWallet();
  const navBal = useNavBalance(wallet.status === "connected" ? wallet.account : null);
  const block = useBlockNumber();

  const shares = parseNav(amt);

  const byAddr = useMemo(() => {
    const m = new Map<string, StockToken>();
    STOCK_TOKENS.forEach((t) => m.set(t.address.toLowerCase(), t));
    return m;
  }, []);

  const inactiveSet = useMemo(
    () => new Set((vault.inactiveAssets ?? []).map((a) => a.toLowerCase())),
    [vault.inactiveAssets],
  );

  /* Price every asset the vault actually holds, so the preview can value it. */
  const heldTokens = useMemo(
    () =>
      (vault.holdings ?? [])
        .filter((h) => h.balance > 0n)
        .map((h) => byAddr.get(h.address.toLowerCase()))
        .filter((t): t is StockToken => !!t),
    [vault.holdings, byAddr],
  );
  const priceTick = usePriceFeed(heldTokens);

  const live = vault.status === "live" && vault.totalSupply !== null && vault.redeemFeeBps !== null && vault.holdings !== null;
  const supply = vault.totalSupply ?? 0n;

  const { rows, forfeited, totalUsd, pricedCount } = useMemo(() => {
    const rows: Row[] = [];
    const forfeited: Row[] = [];
    let totalUsd = 0;
    let pricedCount = 0;
    if (!live || !shares || supply === 0n) return { rows, forfeited, totalUsd, pricedCount };
    const effective = shares - (shares * BigInt(vault.redeemFeeBps!)) / 10_000n;
    for (const h of vault.holdings!) {
      if (h.balance === 0n) continue;
      const token = byAddr.get(h.address.toLowerCase());
      if (!token) continue;
      const amount = (h.balance * effective) / supply;
      const p = getPriceEntry(token.address);
      const usd =
        p?.status === "ok" && p.price !== undefined
          ? Number(formatUnits(amount, token.decimals)) * p.price
          : null;
      const row: Row = { token, amount, usd };
      if (inactiveSet.has(h.address.toLowerCase())) {
        forfeited.push(row);
      } else if (amount > 0n) {
        rows.push(row);
        if (usd !== null) {
          totalUsd += usd;
          pricedCount++;
        }
      }
    }
    rows.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
    return { rows, forfeited, totalUsd, pricedCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, shares, supply, vault.holdings, vault.redeemFeeBps, byAddr, inactiveSet, priceTick]);

  const exceedsBal = navBal !== null && shares !== null && shares > navBal;
  const exceedsSupply = live && shares !== null && shares > supply;
  const vaultUnseeded = live && heldTokens.length === 0;

  return (
    <div className="mb-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="field-label">You receive — your slice of every vault holding</span>
        {wallet.status === "connected" && navBal !== null && (
          <button
            type="button"
            className="px-label text-crt hover:text-paper"
            onClick={() => onMax(formatUnits(navBal, 18))}
            title="Use your full $NAV balance"
          >
            BAL {fmt.num(Number(formatUnits(navBal, 18)), 2)} · MAX
          </button>
        )}
      </div>

      <div className="max-h-[196px] overflow-auto dark-scroll border border-dashed border-ink-3 px-3.5 py-3">
        {!live ? (
          <div className="text-[13px] text-muted-dark">
            <span className="px-label text-gold block pb-1">{vault.status === "loading" ? "READING CHAIN…" : "PRE-LAUNCH"}</span>
            Burning $NAV pays out a pro-rata slice of every Stock Token the vault holds, direct to your wallet.
          </div>
        ) : !shares ? (
          <div className="text-[13px] text-muted-dark">
            <span className="px-label text-gold block pb-1">
              {`VAULT LIVE · ${vault.holdings!.length} ASSETS REGISTERED${vaultUnseeded ? " · SEEDING FROM FEE FLOW" : ""}`}
            </span>
            Enter a $NAV amount to preview the exact per-asset payout, computed live from on-chain balances with the
            contract&rsquo;s own math.
          </div>
        ) : exceedsSupply ? (
          <div className="text-[13px] text-red">
            <span className="px-label text-red block pb-1">AMOUNT EXCEEDS TOTAL SUPPLY</span>
            {fmt.num(Number(formatUnits(supply, 18)), 2)} $NAV exist. Enter a smaller amount.
          </div>
        ) : vaultUnseeded ? (
          <div className="text-[13px] text-muted-dark">
            <span className="px-label text-gold block pb-1">PROVABLE PREVIEW — VAULT UNSEEDED</span>
            The vault currently holds <b className="text-paper">0</b> of all {vault.holdings!.length} registered assets
            (verifiable on-chain), so burning {fmt.num(Number(formatUnits(shares, 18)), 2)} $NAV today would return{" "}
            <b className="text-paper">nothing</b>. Holdings accrue on every accumulation epoch — this preview fills in as they land.
          </div>
        ) : (
          <>
            {rows.map((r) => (
              <div key={r.token.address} className="flex items-center justify-between gap-3 border-b border-ink-4 py-1.5 last:border-b-0">
                <span className="tk min-w-0">
                  <Identicon t={r.token.symbol} />
                  <span className="tk-sym">{r.token.symbol}</span>
                </span>
                <span className="num text-[13px] text-paper text-right">
                  {fmtQty(r.amount, r.token.decimals)}
                  <span className="text-muted-dark">{r.usd !== null ? ` · ≈ ${fmt.usd(r.usd)}` : ""}</span>
                </span>
              </div>
            ))}
            {forfeited.map((r) => (
              <div key={r.token.address} className="flex items-center justify-between gap-3 border-b border-ink-4 py-1.5 last:border-b-0">
                <span className="tk min-w-0">
                  <Identicon t={r.token.symbol} />
                  <span className="tk-sym text-red">{r.token.symbol}</span>
                </span>
                <span className="num text-[13px] text-red text-right" title="Asset inactive — the contract skips it WITHOUT credit">
                  {fmtQty(r.amount, r.token.decimals)} FORFEITED
                </span>
              </div>
            ))}
            <div className="flex justify-between gap-3 pt-2 text-[13px]">
              <span className="text-muted-dark">Total ({rows.length} assets)</span>
              <b className="num font-medium text-gold">
                ≈ {fmt.usd(totalUsd)}
                {pricedCount < rows.length ? ` · ${pricedCount}/${rows.length} priced` : ""}
              </b>
            </div>
          </>
        )}
      </div>

      {exceedsBal && shares !== null && !exceedsSupply && (
        <div className="mt-1.5 text-[12.5px] text-red">
          Exceeds your balance of {fmt.num(Number(formatUnits(navBal!, 18)), 4)} $NAV.
        </div>
      )}

      {live && shares !== null && !exceedsSupply && (
        <div className="mt-1.5 text-[11.5px] leading-relaxed text-muted-dark">
          <span className="px-label text-crt">PROVABLE</span>{" "}
          amountᵢ = ⌊balᵢ × (shares − {(vault.redeemFeeBps! / 100).toFixed(2)}% fee) ÷ supply⌋ · supply{" "}
          {fmt.compact(Number(formatUnits(supply, 18)))} $NAV · balances read at block{" "}
          {block !== null ? block.toString() : "…"} · identical math to{" "}
          <a
            href={`${EXPLORER}/address/${PROTOCOL.vaultAddress}?tab=contract`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-crt"
          >
            verified redeemInKind source
          </a>
          .
        </div>
      )}
    </div>
  );
}
