/* The Yield Layer — writer-side vault panel. Routes idle collateral into the
   Uniswap v4 pyVaults (concentrated LP + hook fee-skim into the flywheel).
   Same hardened tx pipeline as every other write surface: simulate first,
   receipt-gated success, fail-closed on oracle problems (deposits only —
   withdrawals are never gated by price or pause, by contract design). */
import { useCallback, useEffect, useRef, useState } from "react";
import { publicClient, EXPLORER } from "../../lib/chain";
import { erc20WriteAbi } from "../../lib/pit";
import { YIELD_VAULTS, YIELD_UNDERLYINGS, yieldVaultAbi, type YieldVault } from "../../lib/yield";
import { useWallet, walletClient, requestConnect, ensureChain } from "../../lib/wallet";

interface VaultView {
  totalAssets: number;
  cap: number;
  paused: boolean;
  deployed: boolean;
  myShares: bigint;
  myValue: number;
  walletBal: number;
}

type Busy = null | "deposit" | "withdraw";

export function YieldPanel({ symbol }: { symbol: string }) {
  const w = useWallet();
  const [vault, setVault] = useState<YieldVault>(YIELD_VAULTS[0]);
  const [amount, setAmount] = useState("");
  const [view, setView] = useState<VaultView | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);
  const seq = useRef(0);

  const live = YIELD_UNDERLYINGS.has(symbol);

  const pull = useCallback(async () => {
    const my = ++seq.current;
    try {
      const base = [
        publicClient.readContract({ address: vault.address, abi: yieldVaultAbi, functionName: "totalAssets" }),
        publicClient.readContract({ address: vault.address, abi: yieldVaultAbi, functionName: "maxTotalAssets" }),
        publicClient.readContract({ address: vault.address, abi: yieldVaultAbi, functionName: "paused" }),
        publicClient.readContract({ address: vault.address, abi: yieldVaultAbi, functionName: "positionLiquidity" }),
        publicClient.readContract({ address: vault.address, abi: yieldVaultAbi, functionName: "totalSupply" }),
      ] as Promise<unknown>[];
      if (w.account) {
        base.push(
          publicClient.readContract({ address: vault.address, abi: yieldVaultAbi, functionName: "balanceOf", args: [w.account] }),
          publicClient.readContract({ address: vault.asset, abi: erc20WriteAbi, functionName: "balanceOf", args: [w.account] }),
        );
      }
      const res = await Promise.all(base);
      if (seq.current !== my) return;
      const d = 10 ** vault.assetDecimals;
      const total = res[0] as bigint;
      const supply = res[4] as bigint;
      const myShares = w.account ? (res[5] as bigint) : 0n;
      setView({
        totalAssets: Number(total) / d,
        cap: Number(res[1] as bigint) / d,
        paused: res[2] as boolean,
        deployed: (res[3] as bigint) > 0n,
        myShares,
        myValue: supply > 0n && myShares > 0n ? Number((myShares * total) / supply) / d : 0,
        walletBal: w.account ? Number(res[6] as bigint) / d : 0,
      });
    } catch {
      if (seq.current === my) setView(null);
    }
  }, [vault, w.account]);

  useEffect(() => {
    void pull();
    const t = setInterval(() => void pull(), 20_000);
    return () => clearInterval(t);
  }, [pull]);

  const run = useCallback(async (kind: Exclude<Busy, null>) => {
    if (!w.account) return;
    const wc = walletClient();
    if (!wc) return;
    if (w.status === "wrong-chain" && !(await ensureChain())) return;
    setBusy(kind);
    setNote(null);
    try {
      const requireSuccess = async (hash: `0x${string}`, what: string) => {
        const rcpt = await publicClient.waitForTransactionReceipt({ hash });
        if (rcpt.status !== "success") throw new Error(`${what} reverted on-chain — no state was changed (only gas was spent).`);
      };
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
      if (kind === "deposit") {
        const amt = Number.parseFloat(amount);
        if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter a deposit amount.");
        if (view && amt > view.walletBal) throw new Error(`Amount exceeds your wallet balance of ${view.walletBal.toLocaleString("en-US", { maximumFractionDigits: 4 })}.`);
        const wei = BigInt(Math.round(amt * 1e6)) * 10n ** BigInt(vault.assetDecimals - 6);
        const allowance = (await publicClient.readContract({
          address: vault.asset, abi: erc20WriteAbi, functionName: "allowance", args: [w.account, vault.address],
        })) as bigint;
        if (allowance < wei) {
          const h0 = await wc.writeContract({
            address: vault.asset, abi: erc20WriteAbi, functionName: "approve",
            args: [vault.address, wei], account: w.account, chain: wc.chain,
          });
          await requireSuccess(h0, "Approval");
        }
        /* Slippage guard: accept no fewer than 99% of the currently-quoted shares. */
        const quoted = (await publicClient.readContract({
          address: vault.address, abi: yieldVaultAbi, functionName: "previewDeposit", args: [wei],
        })) as bigint;
        if (quoted === 0n) throw new Error("Vault quoted zero shares — try again in a moment.");
        const minShares = (quoted * 99n) / 100n;
        const sim = await publicClient.simulateContract({
          address: vault.address, abi: yieldVaultAbi, functionName: "deposit",
          args: [wei, w.account, minShares, deadline], account: w.account,
        });
        const h = await wc.writeContract(sim.request);
        await requireSuccess(h, "Deposit");
        setNote({ tone: "ok", msg: `Deposited ${amount} ${vault.assetSymbol} into ${vault.key}.` });
      } else {
        if (!view || view.myShares === 0n) throw new Error(`No ${vault.key} shares to withdraw.`);
        /* Simulate first to learn the exact payout, then bound it at 99%. */
        const sim0 = await publicClient.simulateContract({
          address: vault.address, abi: yieldVaultAbi, functionName: "withdraw",
          args: [view.myShares, w.account, 0n, 0n, deadline], account: w.account,
        });
        const [outA, outC] = sim0.result as readonly [bigint, bigint];
        const sim = await publicClient.simulateContract({
          address: vault.address, abi: yieldVaultAbi, functionName: "withdraw",
          args: [view.myShares, w.account, (outA * 99n) / 100n, (outC * 99n) / 100n, deadline], account: w.account,
        });
        const h = await wc.writeContract(sim.request);
        await requireSuccess(h, "Withdraw");
        const a = Number(outA) / 10 ** vault.assetDecimals;
        const c = Number(outC) / 10 ** vault.counterDecimals;
        setNote({
          tone: "ok",
          msg: `Withdrew ~${a.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${vault.assetSymbol}` +
            (outC > 0n ? ` + ~${c.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${vault.counterSymbol}` : "") + ".",
        });
      }
      setAmount("");
      await pull();
    } catch (e) {
      const s = e instanceof Error ? e.message : String(e);
      setNote({
        tone: "err",
        msg: /user rejected|denied/i.test(s) ? "Signature rejected in wallet."
          : /VaultPaused/i.test(s) ? "Vault deposits are paused — withdrawals remain open."
          : /StaleRefPrice|PriceDeviation/i.test(s) ? "Oracle reference price is stale or deviates from the pool — deposits fail closed until the Chainlink/Pyth reference refreshes. Withdrawals are unaffected."
          : /CapExceeded|MaxTotalAssets/i.test(s) ? "Deposit would exceed the vault's current cap."
          : s.slice(0, 140),
      });
    } finally {
      setBusy(null);
    }
  }, [w.account, w.status, amount, vault, view, pull]);

  if (!live) return null;

  return (
    <section className="panel">
      <div className="panel-head flex-wrap">
        <span className="px-label">YIELD LAYER — IDLE COLLATERAL</span>
        <span className="num text-[12.5px] text-muted-dark">Uniswap v4 · hook-skimmed into the flywheel</span>
      </div>
      <div className="grid gap-3 p-4.5">
        <div className="grid grid-cols-2 gap-1.5">
          {YIELD_VAULTS.map((v) => (
            <button
              key={v.key}
              className={`btn py-2 text-[12.5px] ${vault.key === v.key ? "btn-primary" : ""}`}
              onClick={() => { setVault(v); setNote(null); setAmount(""); }}
            >
              {v.key} · {v.assetSymbol}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-[13px] text-muted-dark md:grid-cols-4">
          <div>
            <span className="block">Vault TVL</span>
            <b className="num text-paper">{view ? `${view.totalAssets.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${vault.assetSymbol}` : "—"}</b>
          </div>
          <div>
            <span className="block">Deposit cap</span>
            <b className="num text-paper">{view ? (view.cap === 0 ? "Uncapped" : view.cap.toLocaleString("en-US", { maximumFractionDigits: 0 })) : "—"}</b>
          </div>
          <div>
            <span className="block">Your value</span>
            <b className="num text-paper">{view ? `${view.myValue.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${vault.assetSymbol}` : "—"}</b>
          </div>
          <div>
            <span className="block">Wallet</span>
            <b className="num text-paper">{view ? view.walletBal.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}</b>
          </div>
        </div>

        {view?.paused && (
          <div className="status-plate">
            <span className="px-label text-gold">DEPOSITS PAUSED BY GUARDIAN</span>
            <span className="text-[12.5px] text-muted-dark">
              The guardian has paused new deposits and liquidity deployment. Withdrawals are never
              pausable — your exit is guaranteed by the contract.
            </span>
          </div>
        )}

        {w.status !== "connected" ? (
          <button
            className="btn w-full py-3 text-[14px]"
            title={w.status === "wrong-chain" ? "Your wallet is on another network — switch to Robinhood Chain (4663)" : undefined}
            onClick={() => { if (w.status === "wrong-chain") { void ensureChain(); } else { void requestConnect(); } }}
          >
            {w.status === "wrong-chain" ? "SWITCH TO ROBINHOOD CHAIN" : "CONNECT WALLET FOR YIELD"}
          </button>
        ) : (
          <>
            <div className="amt-row">
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="0.0"
                aria-label="Vault deposit amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <span className="asset">{vault.assetSymbol}</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                className="btn py-2.5 text-[13px]"
                disabled={busy !== null || view?.paused === true}
                onClick={() => void run("deposit")}
              >
                {busy === "deposit" ? "WORKING…" : view?.paused ? "DEPOSITS PAUSED" : "DEPOSIT"}
              </button>
              <button
                className="btn py-2.5 text-[13px]"
                disabled={busy !== null || !view || view.myShares === 0n}
                onClick={() => void run("withdraw")}
              >
                {busy === "withdraw" ? "WORKING…" : "WITHDRAW ALL"}
              </button>
            </div>
          </>
        )}

        {note && (
          <span className={`text-[12.5px] ${note.tone === "ok" ? "text-crt" : "text-red"}`}>{note.msg}</span>
        )}

        <span className="text-[11.5px] text-muted-dark">
          Deposits are priced off the Pit oracle&rsquo;s on-chain TWAP and <b className="text-paper">fail closed</b> when
          the oracle reference is stale; a 1% share-slippage guard and 15-minute deadline protect every
          transaction. Withdrawals can never be gated — by price, pause, or anything else — and pay
          out pro-rata {vault.assetSymbol}{view?.deployed ? ` (plus ${vault.counterSymbol} while liquidity is in range)` : ""}.
        </span>
        <span className="text-[11.5px] text-muted-dark">
          The NavPitHook skims 10% of LP fees earned by vault positions into the 80/15/5 FeeSplitter —
          outside LPs keep 100%. Contracts are{" "}
          <a className="underline" href={`${EXPLORER}/address/${vault.address}?tab=contract`} target="_blank" rel="noreferrer">
            verified on Blockscout
          </a>.
        </span>
      </div>
    </section>
  );
}
