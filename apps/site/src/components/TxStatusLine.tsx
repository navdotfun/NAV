/* NAV — one-line transaction status: wallet prompt → confirming → done/error.
   Shared by the trade panel and the fee-crank panel. */
import { EXPLORER } from "../lib/chain";
import type { TxPhase } from "../lib/tx";

export function TxStatusLine({ phase }: { phase: TxPhase }) {
  if (phase.step === "idle") return null;
  if (phase.step === "error") return <div className="mt-2 text-[12.5px] text-red-crt">{phase.message}</div>;
  if (phase.step === "done") {
    return (
      <div className="mt-2 text-[12.5px] text-crt">
        Executed ·{" "}
        <a className="underline decoration-dotted" href={`${EXPLORER}/tx/${phase.hash}`} target="_blank" rel="noopener noreferrer">
          view tx ↗
        </a>
      </div>
    );
  }
  return (
    <div className="mt-2 text-[12.5px] text-gold">
      {phase.step === "approving"
        ? phase.hash ? "Approval confirming on-chain…" : "Approve in wallet…"
        : phase.hash ? "Confirming on-chain…" : "Confirm in wallet…"}
    </div>
  );
}
