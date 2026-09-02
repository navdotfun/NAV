# Audit Index

Assessments are internal, adversarial, and conducted before every deployment; findings are published sanitized (methodology, findings classes, resolutions and coverage; exploit constructions withheld). All contracts are immutable once deployed, so findings after deployment inform periphery mitigations and future versions rather than in-place patches.

| # | Report | Scope | Headline coverage | Open findings |
|---|---|---|---|---|
| 01 | Core pre-deployment | Token, Vault, Splitter, Accumulator | Slither + unit/fuzz + gas at 190-asset scale | 0 |
| 02 | Pit derivatives | Pool, Oracle, Pricer, Factory, Ticket | 92-test campaign, 12,800-call invariants, 16 attack scenarios | 0 |
| 03 | Campaign V6 | Full Pit stack redeploy | 2.4M probes, 380-test regression, 22/22 verified | 0 |
| 04 | NavCrank | Buyback/rotation engine | 3 passes, 1.05M fuzz, 190,800 adversarial sequences | 0 |
| 05 | StockSwap | Router + execution path | 10.1M contract + 33M frontend executions | 0 |
| 06 | NavOptions | Options engine | 9M fuzz, 14.4M invariant assertions, C-1 caught pre-deploy | 0 |
| 07 | FLOOR application | Frontend trust surface | R2 42.3M checks, R3, O-ERR sweep | 0 |
| 08 | NavOptions — review R4-A | Options engine (live, immutable) | Line-by-line re-read, live `cast` invariant checks, adversarial pricing models | 0 · disclosures published |
| 09 | Options frontend — review R4-B | Ticket · blotter · writer desk · RPC | Full stack re-audit; 16 findings fixed at `46f1a2f2`, QA-verified | 0 |
| 10 | NAV Credit — contracts | CreditPair · CreditFactory (isolated lending) | Line-by-line + adversarial economics, Aave/Morpho parity review, on-chain oracle-cadence verification, 100k-run fuzz + 800×300 invariant campaign | 0 |
| 11 | NAV Credit — frontend | CREDIT tab · lib/credit.ts · ticket · position strip | ABI/unit/rounding verification against the Solidity; 18 findings fixed at `90f8526a` | 0 |
| 12 | Arena + Index — verification campaign | NavArena · NavIndexFactory · NavIndexToken · NavIndexZap | ~137.2M checks: dual differential bigint harnesses (69.5M arena + 64.8M index), 1.2M fuzz, 480k invariant calls; two independent pre-deploy audits, all findings fixed and re-verified | 0 |

Severity classification used throughout: Critical (direct loss of user funds), High (conditional loss or fund lockup), Medium (accounting divergence, manipulation margin, degraded protection), Low (griefing, hygiene), Informational (documented behaviour).

To report a vulnerability, see the disclosure policy on the Contracts page. Do not open public issues for suspected vulnerabilities.
