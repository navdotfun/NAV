# nav-protocol

Source of record for the NAV protocol as deployed on Robinhood Chain (chain id 4663). Everything in this tree is live code: contracts match the verified bytecode on Blockscout, and the application sources shown are the modules serving nav.fun/floor at the stated commit.

## Layout

```
contracts/          Foundry workspace — every deployed contract
  NAVToken.sol        fixed-supply ERC-20, burn-only after construction
  NAVVault.sol        95-asset registry, pro-rata in-kind redemption
  FeeSplitter.sol     80 / 15 / 5 conserving split
  AccumulatorV2.sol   TWAP + oracle-gated stock purchases
  NavCrank.sol        permissionless fee pipeline (collect → burn → split → buy)
  LpTimelock.sol      LP position custody under two-step ownership
  swap/               NavSwapRouter — dual-venue execution, quote-enforced
  options/            NavOptions — streamia-priced covered options
  pit/                dated options: pool, oracle v2, pricer, factory, ticket
  credit/             isolated USDG lending: CreditPair (Morpho-style shares,
                      Aave v3 kinked IRM, close-factor liquidations) + CreditFactory
floor/              terminal application modules (React 18 + viem)
  options.ts          options reads, quoting, error decoding
  execute.ts          swap execution path
  tx.ts               vault/crank transaction construction
  pit.ts              pit reads and ABIs
  venues.ts           venue selection and quoting
  OptionTicket.tsx    order entry with writer-capacity gating
  lib/credit.ts       credit reads, MAX-sentinel clamps, write rails
  credit/             CREDIT tab — markets board, six-action ticket, position strip
audits/             sanitized assessment reports, one per engagement
```

## Backend: design rules

1. Immutability. No proxies, no upgrade paths, no admin over user funds. What is deployed is final; changes ship as new contracts.
2. Solvency by construction. Every claim is backed by escrow the contract already holds: vault redemptions by registry balances, options by writer escrow, pit settlements by pooled collateral. No path mints an unbacked claim.
3. Permissionless liveness. Anything time-sensitive (cranks, pokes, settlement) is callable by anyone and bountied, so the system needs no privileged keeper.
4. Measured, not quoted, pricing. The options layer derives premium from observed pool fee growth; the pit prices from live pool state; the accumulator buys through TWAP with oracle deviation gates.
5. Explicit failure. Custom errors on every revert path; no silent truncation; conservation asserted in tests to the wei.

## Frontend: trust rules

1. Every rendered number originates from a contract read or a compile-time constant. Loading renders "…", failure renders "—". Synthetic values are prohibited.
2. Addresses come from the deployment manifest; hand-typing an address anywhere in the codebase is a review-blocking defect.
3. Reverts are decoded from typed error data against ABIs reconciled with verified source, then translated to actionable copy.
4. Reads are stale-while-revalidate with nullable fallbacks; the app degrades to "—" rather than guessing.

## Verification

Every address in the README table links to verified source on Blockscout. To reproduce builds: `forge build` with solc 0.8.36, optimizer 200 runs, then compare deployed bytecode. The audit index in this tab documents what was tested, what was found, and what was fixed, per engagement.
