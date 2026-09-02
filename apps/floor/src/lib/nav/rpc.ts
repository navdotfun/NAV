/* NAV — shared RPC politeness layer.

   The chain's RPC edge resets bursty parallel requests from browsers
   (verified: 60 concurrent getBlock → 60 × net::ERR_FAILED, while serial
   requests always succeed). Every log-scan / block-stamp read in the app
   goes through this single module-wide 4-lane limiter with backoff retry,
   so no view can stampede the RPC — including several views mounted at
   once, since the queue is shared across all importers. */

import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, AbiDecodingZeroDataError } from "viem";

/** True when the failure is a decoded on-chain revert / empty-return —
    i.e. the contract answered and said no (no pool, burned id, guard).
    False for transport-level failures (HTTP, CORS, timeout), which are
    retryable and must never be conflated with an on-chain "no". */
export function isRevert(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  return (
    e.walk(
      (x) =>
        x instanceof ContractFunctionRevertedError ||
        x instanceof ContractFunctionZeroDataError ||
        x instanceof AbiDecodingZeroDataError,
    ) !== null
  );
}

let inflight = 0;
const waiters: (() => void)[] = [];

const acquire = () =>
  new Promise<void>((res) => {
    if (inflight < 4) { inflight += 1; res(); }
    else waiters.push(() => { inflight += 1; res(); });
  });

const release = () => { inflight -= 1; waiters.shift()?.(); };

/** Run `fn` under the shared 4-wide concurrency gate, retrying transient
    failures with linear backoff (400ms, 800ms) before giving up. */
export async function limited<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  await acquire();
  try {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        /* R4 F-14: a decoded on-chain revert is deterministic — retrying
           cannot change the answer, it only burns limiter lanes and delays
           the real error reaching the UI. Fail fast; retry transport only. */
        if (isRevert(e)) throw e;
        if (i >= tries - 1) throw e;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
  } finally { release(); }
}
