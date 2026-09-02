// Repository tab data manifest.
// Every source file below is a snapshot of the deployed/live code at the stated
// commit; audit markdown is the sanitized publication of the internal reports.
// Convention: no synthetic content — counts and line numbers are derived from
// the real files at build time where possible, and stamped otherwise.

import navToken from "./files/contracts/NAVToken.sol?raw";
import navVault from "./files/contracts/NAVVault.sol?raw";
import feeSplitter from "./files/contracts/FeeSplitter.sol?raw";
import accumulatorV2 from "./files/contracts/AccumulatorV2.sol?raw";
import navCrank from "./files/contracts/NavCrank.sol?raw";
import lpTimelock from "./files/contracts/LpTimelock.sol?raw";
import navSwapRouter from "./files/contracts/swap/NavSwapRouter.sol?raw";
import navOptions from "./files/contracts/options/NavOptions.sol?raw";
import pitPool from "./files/contracts/pit/PitPool.sol?raw";
import pitOracleV2 from "./files/contracts/pit/PitOracleV2.sol?raw";
import pitFactory from "./files/contracts/pit/PitFactory.sol?raw";
import pitTicket from "./files/contracts/pit/PitTicket.sol?raw";
import pitPricer from "./files/contracts/pit/PitPricer.sol?raw";
import foundryToml from "./files/contracts/foundry.toml.txt?raw";
import flOptions from "./files/floor/options.ts.txt?raw";
import flExecute from "./files/floor/execute.ts.txt?raw";
import flTx from "./files/floor/tx.ts.txt?raw";
import flPit from "./files/floor/pit.ts.txt?raw";
import flVenues from "./files/floor/venues.ts.txt?raw";
import flTicket from "./files/floor/OptionTicket.tsx.txt?raw";
import creditPair from "./files/contracts/credit/CreditPair.sol?raw";
import creditFactory from "./files/contracts/credit/CreditFactory.sol?raw";
import flCredit from "./files/floor/credit.ts.txt?raw";
import flCreditTicket from "./files/floor/CreditTicket.tsx.txt?raw";

import architectureMd from "./ARCHITECTURE.md?raw";
import auditIndexMd from "./audits/00-index.md?raw";
import auditCoreMd from "./audits/01-core-predeploy.md?raw";
import auditPitMd from "./audits/02-pit-derivatives.md?raw";
import auditV6Md from "./audits/03-campaign-v6.md?raw";
import auditCrankMd from "./audits/04-navcrank.md?raw";
import auditSwapMd from "./audits/05-stockswap.md?raw";
import auditOptionsMd from "./audits/06-options.md?raw";
import auditAppMd from "./audits/07-application.md?raw";
import auditR4ContractMd from "./audits/08-options-r4-contract.md?raw";
import auditR4FrontendMd from "./audits/09-options-r4-frontend.md?raw";
import auditCreditContractsMd from "./audits/10-credit-contracts.md?raw";
import auditCreditFrontendMd from "./audits/11-credit-frontend.md?raw";

export const REPO_META = {
  name: "nav-protocol",
  branch: "main",
  commit: "f48c2bbe",
  commits: 81,
  network: "Robinhood Chain · 4663",
  toolchain: "solc 0.8.36 · Foundry · optimizer 200",
  stamped: "02 Sep 2026",
} as const;

export type RepoFile = {
  path: string;
  lang: "solidity" | "typescript" | "toml";
  note: string;
  address?: string;
  src: string;
};

export const FILE_GROUPS: { dir: string; files: RepoFile[] }[] = [
  {
    dir: "contracts/src",
    files: [
      { path: "NAVToken.sol", lang: "solidity", note: "fixed-supply ERC-20", address: "0x3e7f2c3A81a1c8302eacE254928e0fBa5A3Bc447", src: navToken },
      { path: "NAVVault.sol", lang: "solidity", note: "95-asset registry, in-kind redemption", address: "0xb8F008322671179E2C93dd8610be8d5D7876087b", src: navVault },
      { path: "FeeSplitter.sol", lang: "solidity", note: "80/15/5 conserving split", address: "0x6bCA8944F711A2299a20ecb02E7AE25d78f81Ca2", src: feeSplitter },
      { path: "AccumulatorV2.sol", lang: "solidity", note: "TWAP + oracle-gated buys", address: "0x3620Da2708734d1eE64D929cF9a05EAf9a7778a0", src: accumulatorV2 },
      { path: "NavCrank.sol", lang: "solidity", note: "permissionless fee pipeline", address: "0x15F15c5513fb076ffaD48c80Ad65CC3EB009dD1e", src: navCrank },
      { path: "LpTimelock.sol", lang: "solidity", note: "LP custody, two-step ownership", address: "0xA5782C0A38b5d2C9fec4A6F11d2c0a94A21D36c6", src: lpTimelock },
      { path: "swap/NavSwapRouter.sol", lang: "solidity", note: "dual-venue router, quote-enforced", address: "0xc8156712C1A654db7dcb805D8B9De15683fdc680", src: navSwapRouter },
      { path: "options/NavOptions.sol", lang: "solidity", note: "streamia-priced covered options", address: "0xd628eFeC572eE000D4Eb040E675744FEB35F2467", src: navOptions },
      { path: "pit/PitPool.sol", lang: "solidity", note: "dated options pool", src: pitPool },
      { path: "pit/PitOracleV2.sol", lang: "solidity", note: "TWAP oracle, decay clamp", address: "0x975F6D7E95bb7508A93fa68d510581CC0736Ffdd", src: pitOracleV2 },
      { path: "pit/PitPricer.sol", lang: "solidity", note: "premium curve", src: pitPricer },
      { path: "pit/PitFactory.sol", lang: "solidity", note: "market deployment", address: "0x63859B6f3F6A717c35a872B55eaA0F2B6e7fDB77", src: pitFactory },
      { path: "pit/PitTicket.sol", lang: "solidity", note: "position ledger", address: "0xd51C868353c084DA4c7685d755E7BFb9D41CA7b4", src: pitTicket },
      { path: "credit/CreditPair.sol", lang: "solidity", note: "isolated USDG lending pair (NVDA 0x29b2…56B1 · QQQ 0xF07c…cafc · AAPL 0x4b78…567c · TSLA 0x8279…1c6a)", address: "0x29b2958726D905034A60Aa471B44Ee6df93516B1", src: creditPair },
      { path: "credit/CreditFactory.sol", lang: "solidity", note: "pair deployment, param registry", address: "0x9A9feC2B6b05F94D8c3861d0202C05Df4Dcfd4A7", src: creditFactory },
      { path: "foundry.toml", lang: "toml", note: "build configuration", src: foundryToml },
    ],
  },
  {
    dir: "floor/src",
    files: [
      { path: "lib/options.ts", lang: "typescript", note: "options reads, quoting, error decoding", src: flOptions },
      { path: "lib/execute.ts", lang: "typescript", note: "swap execution path", src: flExecute },
      { path: "lib/nav/tx.ts", lang: "typescript", note: "vault/crank transaction construction", src: flTx },
      { path: "lib/nav/pit.ts", lang: "typescript", note: "pit reads and ABIs", src: flPit },
      { path: "lib/venues.ts", lang: "typescript", note: "venue selection and quoting", src: flVenues },
      { path: "components/options/OptionTicket.tsx", lang: "typescript", note: "order entry, capacity gating", src: flTicket },
      { path: "lib/credit.ts", lang: "typescript", note: "credit reads, max clamps, write rails", src: flCredit },
      { path: "components/credit/CreditTicket.tsx", lang: "typescript", note: "lend/borrow ticket, MAX semantics", src: flCreditTicket },
    ],
  },
];

export const ARCHITECTURE_MD = architectureMd;

export type AuditReport = { id: string; title: string; scope: string; md: string };
export const AUDITS: AuditReport[] = [
  { id: "index", title: "Audit index & severity model", scope: "All engagements", md: auditIndexMd },
  { id: "core", title: "01 · Core pre-deployment", scope: "Token · Vault · Splitter · Accumulator", md: auditCoreMd },
  { id: "pit", title: "02 · Pit derivatives", scope: "Pool · Oracle · Pricer · Factory · Ticket", md: auditPitMd },
  { id: "v6", title: "03 · Security campaign V6", scope: "Full Pit stack redeploy", md: auditV6Md },
  { id: "crank", title: "04 · NavCrank", scope: "Fee pipeline, three passes", md: auditCrankMd },
  { id: "swap", title: "05 · StockSwap", scope: "Router + execution path", md: auditSwapMd },
  { id: "options", title: "06 · NavOptions", scope: "Options engine", md: auditOptionsMd },
  { id: "app", title: "07 · FLOOR application", scope: "Frontend trust surface", md: auditAppMd },
  { id: "opt-r4a", title: "08 · NavOptions — review R4-A", scope: "Options engine, line-by-line + live checks", md: auditR4ContractMd },
  { id: "opt-r4b", title: "09 · Options frontend — review R4-B", scope: "Order ticket · blotter · writer desk · RPC layer", md: auditR4FrontendMd },
  { id: "credit-a", title: "10 · NAV Credit — contracts", scope: "CreditPair · CreditFactory · oracle cadence", md: auditCreditContractsMd },
  { id: "credit-b", title: "11 · NAV Credit — frontend", scope: "CREDIT tab · credit.ts · ticket · position strip", md: auditCreditFrontendMd },
];

// Test inventory. Counts are `grep -c "function test"` / `function invariant_`
// on the real suites at commit f77ab839 — regenerate when suites change.
export type TestSuite = { file: string; kind: string; tests: number };
export const TEST_GROUPS: { module: string; suites: TestSuite[] }[] = [
  {
    module: "core",
    suites: [
      { file: "NAV.t.sol", kind: "unit", tests: 12 },
      { file: "NAVFuzz.t.sol", kind: "fuzz", tests: 5 },
      { file: "AccumulatorV2.t.sol", kind: "unit", tests: 39 },
      { file: "PokeBounty.t.sol", kind: "unit", tests: 21 },
      { file: "ForkAccumulateV2.t.sol", kind: "fork", tests: 2 },
      { file: "ListNavEth.fork.t.sol", kind: "fork", tests: 14 },
      { file: "AuditV4FeePipeline.t.sol", kind: "audit regression", tests: 3 },
      { file: "fixesA/ (2 suites)", kind: "audit regression", tests: 34 },
      { file: "fixesB/ (5 suites)", kind: "audit regression", tests: 49 },
    ],
  },
  {
    module: "crank",
    suites: [
      { file: "NavCrank.t.sol", kind: "unit", tests: 27 },
      { file: "NavCrank.adversarial.t.sol", kind: "adversarial fuzz", tests: 6 },
      { file: "NavCrank.fork.t.sol", kind: "fork", tests: 5 },
    ],
  },
  {
    module: "options",
    suites: [
      { file: "options/NavOptions.unit.t.sol", kind: "unit", tests: 64 },
      { file: "options/NavOptions.fuzz.t.sol", kind: "fuzz", tests: 9 },
      { file: "options/NavOptions.invariant.t.sol", kind: "invariant", tests: 6 },
      { file: "options/NavOptions.fork.t.sol", kind: "fork", tests: 5 },
    ],
  },
  {
    module: "pit",
    suites: [
      { file: "pit/PitPool.t.sol", kind: "unit", tests: 33 },
      { file: "pit/PitOracle.t.sol", kind: "unit", tests: 21 },
      { file: "pit/PitOracleV2.t.sol", kind: "unit", tests: 30 },
      { file: "pit/PitOracleV2Fork.t.sol", kind: "fork", tests: 1 },
      { file: "pit/PitPricer.t.sol", kind: "unit", tests: 12 },
      { file: "pit/PitAttacks.t.sol", kind: "attack scenarios", tests: 16 },
      { file: "pit/PitSettlementAuditPoC.t.sol", kind: "audit regression", tests: 18 },
      { file: "pit/PitStateFuzz.t.sol", kind: "stateful fuzz", tests: 9 },
      { file: "pit/PitInvariants.t.sol", kind: "invariant", tests: 9 },
      { file: "pit/AuditV4* (4 suites)", kind: "audit regression", tests: 41 },
      { file: "pit/CampaignV6* (2 suites)", kind: "campaign", tests: 9 },
    ],
  },
  {
    module: "swap",
    suites: [
      { file: "swap/NavSwapRouter.t.sol", kind: "unit", tests: 22 },
      { file: "swap/NavSwapRouter.fork.t.sol", kind: "fork", tests: 7 },
      { file: "swap/NavSwapRouter.invariants.t.sol", kind: "invariant", tests: 3 },
    ],
  },
  {
    module: "credit",
    suites: [
      { file: "credit/CreditPair.unit.t.sol", kind: "unit", tests: 56 },
      { file: "credit/CreditPair.fuzz.t.sol", kind: "fuzz", tests: 10 },
      { file: "credit/CreditPair.invariant.t.sol", kind: "invariant", tests: 8 },
    ],
  },
];

export const TEST_TOTALS = {
  functions: 631,
  invariants: 26,
  files: 44,
} as const;

export const CAMPAIGN_VOLUMES: { label: string; value: string; source: string }[] = [
  { label: "options fuzz executions", value: "9.0M", source: "NavOptions campaign" },
  { label: "options invariant assertions", value: "14.4M", source: "NavOptions campaign" },
  { label: "pit randomized probes", value: "2.4M", source: "Campaign V6" },
  { label: "crank fuzz executions", value: "1.05M", source: "NavCrank round 4" },
  { label: "crank adversarial sequences", value: "190,800", source: "NavCrank round 4" },
  { label: "swap contract executions", value: "10.1M", source: "StockSwap campaign" },
  { label: "swap frontend fuzz cases", value: "33M", source: "StockSwap campaign" },
  { label: "floor data-layer checks", value: "42.3M", source: "Application R2" },
  { label: "credit differential-harness checks", value: "102.9M", source: "NAV Credit campaign" },
  { label: "credit fuzz executions", value: "2.8M", source: "NAV Credit campaign" },
  { label: "credit invariant assertions", value: "3.84M", source: "NAV Credit campaign" },
];
