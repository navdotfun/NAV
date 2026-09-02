# NAV Credit

**Isolated lending markets for tokenized stocks — live on Robinhood Chain.**

The Floor's **CREDIT** tab (F4) is a money market built for one job: lend USDG against the same tokenized stocks that trade on the Floor, with every basis point of protocol revenue routed into the $NAV vault flywheel. It fuses **Morpho Blue's minimal share accounting** with **Aave v3's risk framework** — kinked interest rates, close-factor liquidations, bad-debt socialization — rebuilt from first principles for Robinhood Chain's oracle cadence.

Every market is **ownerless and immutable from the deploy block**. No admin keys. No upgrades. No parameter changes. No pause guardian. What was deployed is what runs, forever.

## Live markets

| Market | Max LTV | Liq. threshold | Liq. bonus | Contract |
| --- | --- | --- | --- | --- |
| NVDA / USDG | 60% | 70% | 8% | `0x29b2958726D905034A60Aa471B44Ee6df93516B1` |
| QQQ / USDG | 65% | 75% | 6% | `0xF07c295FB066fB1ae7867dc1235cdee009e2cafc` |
| AAPL / USDG | 55% | 65% | 8% | `0x4b78AeF24A62896a4f1381969EF4C9D28d2a567c` |
| TSLA / USDG | 50% | 60% | 10% | `0x82797A109A840fa975616499F440C080730E1c6a` |

All four pairs are deployed by, and enumerated from, the on-chain **CreditFactory** (`0x9A9feC2B6b05F94D8c3861d0202C05Df4Dcfd4A7`) — the app reads the market list from the chain, not from a config file. Every contract is source-verified (Sourcify exact-match) on [Blockscout](https://robinhoodchain.blockscout.com/address/0x9A9feC2B6b05F94D8c3861d0202C05Df4Dcfd4A7?tab=contract).

Parameters are conservative by design and scale with each market's real on-chain liquidity depth — deeper books carry higher LTVs.

## How a market works

**Lenders** deposit USDG and receive interest-bearing shares (Morpho Blue's virtual-offset share math, hardened against inflation attacks). Interest accrues linearly per second; un-lent liquidity is withdrawable at any time — withdrawals never pause.

**Borrowers** post the market's stock token as collateral and draw USDG against it up to the max LTV. Debt is tracked in shares so interest compounds correctly for every borrower without loops or checkpoints.

**Rates** follow Aave v3's kinked model: base 0%, a gentle slope to the 80% utilization kink, then a steep slope (72% APR at full utilization) that pulls utilization back — liquidity is always priced, never rationed.

**Prices** come from PitOracleV2 — the same Chainlink-anchored oracle the derivatives desk uses. Borrow, collateral withdrawal, and liquidation are oracle-gated: if the anchor is older than 26 hours (weekends, feed outage), those actions pause. Deposits, repays, and withdrawals never gate.

**Liquidations** follow Aave's close-factor regime: positions near the threshold can be half-closed; deeply underwater positions (health factor below 0.95) can be fully closed. Liquidators earn the market's bonus on seized collateral. If collateral crashes past the bonus — including across a weekend price gap — the uncovered remainder is socialized pro-rata across that market's lenders, exactly as in Aave/Morpho. A 10 USDG minimum debt keeps dust positions liquidatable.

## Every draw feeds the vault

Credit is the protocol's third revenue stream, behind swap fees and options premiums:

- **30 bps origination** on every borrow transfers to the Accumulator in USDG at draw time.
- **20% of all interest** accrues to a protocol reserve inside each pair; anyone can sweep it to the Accumulator for a 5 bps bounty — the same permissionless keeper economics as the rest of the protocol.

The Accumulator converts flow into $NAV vault buys. No treasury, no multisig, no discretion — the pipe is the policy.

## Isolation, by construction

Each market is a standalone contract holding only its own collateral and its own USDG. A failure, bad debt event, or oracle issue in one market cannot touch any other market, the vault, the options desk, or the swap router. There is no shared pool, no cross-margin, no contagion path.

## Risk, stated plainly

- Supplying USDG is **not principal-protected** — lenders underwrite liquidation shortfall risk in their market.
- Stock feeds freeze on weekends. Oracle-gated actions pause after 26 hours; lenders who remain deposited through a paused-market price gap absorb any socialized loss when liquidations resume.
- Tokenized stocks are not equities. Nothing here is investment advice.

## Verification

The contracts shipped after a **~109.6M-check verification campaign**: a 102.9M-check differential big-integer harness mirroring every state transition, 2.8M fuzz executions, 3.84M invariant assertions, 56 unit tests, and the full Slither detector suite — findings and methodology are published in the [Repository](/docs/repository) tab (audits 10 and 11).
