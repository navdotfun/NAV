# Security Policy

## Scope

All contracts in `contracts/src/` as deployed at the addresses listed in the [README](README.md). Every deployed contract is immutable; findings therefore inform disclosure, mitigations at the periphery, and future deployments rather than in-place patches.

## Reporting a vulnerability

- Open a **private security advisory** on this repository (GitHub → Security → Report a vulnerability), or
- Contact the team through the channels listed at https://nav.fun.

Please include: affected contract and function, a reproduction path (fork test or transaction trace preferred), and your assessment of impact. We aim to acknowledge reports within 48 hours.

Please do **not** open public issues for suspected vulnerabilities, and do not exploit findings against live funds beyond the minimum needed to demonstrate impact on a fork.

## Publication policy

Audit material in `audits/` is sanitized for publication: methodology, scope, findings classes, resolutions and coverage metrics are included; step-by-step exploit constructions and proof-of-concept code for any economically sensitive path are withheld by design.

## Out of scope

- Third-party infrastructure (Robinhood Chain nodes, Blockscout, Uniswap v3 core, token issuers)
- Frontend-only issues with no fund-safety impact (report these as regular issues)
- Findings requiring privileged keys that do not exist (the contracts have no owner over user funds)
