# Security Assessment — NAV Core Protocol

| | |
|---|---|
| Engagement type | Internal security review, pre-deployment |
| Review date | 30 August 2026 |
| Scope | `NAVToken.sol`, `NAVVault.sol`, `FeeSplitter.sol`, `Accumulator.sol` |
| Compiler | solc 0.8.36, optimizer 200 runs |
| Dependencies | OpenZeppelin Contracts 5.x |
| Methods | Manual line-by-line review, Slither static analysis, Foundry unit and fuzz testing, gas profiling at registry scale |
| Deployment gate | Pass required before mainnet deployment. Passed. |

## 1. Summary

Four contracts totalling approximately 540 source lines were reviewed prior to the initial mainnet deployment on Robinhood Chain (chain id 4663). The review found no critical or high severity issues. Two low/informational items identified by static analysis were fixed before deployment; four medium-classified analyzer results were investigated, reproduced where possible, and formally accepted with the mitigations documented in section 3.

Test results at the reviewed commit: 12 of 12 unit tests passing, 4 of 4 fuzz properties passing at 256 runs each, and a full in-kind redemption across a 190-asset registry measured at 7,798,069 gas, roughly 24% of the chain's 32M block gas limit.

## 2. Verified properties

- Redemption pro-rata bound. For any redemption size, payout equals floor(pro-rata × 0.995). The vault cannot over-pay and total supply strictly decreases by the amount burned. Fuzzed.
- No fee evasion by splitting. Total payout across any sequence of partial redemptions remains below the feeless entitlement by at least 0.25%. Fuzzed.
- Fee ceiling. The redemption fee cannot be set above the hard 2% cap. Fuzzed.
- Split conservation. The 80/15/5 fee split conserves every wei for arbitrary amounts. Fuzzed.
- Frozen-asset isolation. A transfer-reverting registry asset is skipped and credited; it cannot brick the redemption loop.
- Fixed supply. No mint path exists after construction.

## 3. Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| S-1 | Low | Missing zero-address checks in `FeeSplitter` constructor and `setAccumulator` | Fixed. Reverts on zero address. |
| S-2 | Informational | Uninitialized local `touched` | Fixed. Explicit initialization. |
| S-3 | Medium (theoretical) | `reentrancy-no-eth` flagged in `redeemInKind`: credit written after transfers | Accepted. `nonReentrant` on both `redeemInKind` and `claimCredit`; the share burn precedes all transfers, so the state that governs solvency follows effects-before-interactions. Registry assets are standard ERC-20s without transfer hooks. |
| S-4 | Medium (theoretical) | `reentrancy-balance` in `Accumulator.accumulate`: balance measured around router call | Accepted. Before/after balance delta is the standard aggregator-integration pattern; `nonReentrant` applies, the router must be whitelisted by the owner, and a `minOut` floor is enforced. |
| S-5 | Informational | Strict `== 0` equality checks | Accepted. Benign skip-empty guards. |
| S-6 | Medium (gas) | External calls in loop within `redeemInKind` | Measured rather than assumed: 7.8M gas at 190 assets, with headroom to roughly 700 assets before pagination is required. Frozen-asset try/catch prevents a single asset from blocking the loop. |

## 4. Residual risk

Disclosed at publication: registry assets are issuer-backed tokenized stocks; their transferability and peg are external dependencies outside this codebase. The vault's frozen-asset handling limits the blast radius of any single asset failure to that asset's pro-rata slice, which is credited rather than lost.
