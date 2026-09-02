/* NAV — nav.fun · multi-wallet connection layer.

   Connectors, in priority order:
     1. EIP-6963 provider discovery (MetaMask, Phantom, Rabby, Trust, Coinbase,
        OKX, …) — desktop extensions AND wallet in-app browsers, which inject
        the same way. window.ethereum fallback for pre-6963 environments.
     2. Coinbase Wallet SDK (lazy-loaded) — QR / deep link into the Coinbase
        Wallet app from any mobile or desktop browser. No relay key needed.
     3. WalletConnect v2 (lazy-loaded, enabled when VITE_WC_PROJECT_ID is
        set) — QR / deep link into MetaMask, Trust, Rainbow, OKX, Zerion and
        every other WC-compatible mobile wallet.
     4. In-app-browser deep links (MOBILE_WALLET_LINKS) — reopen nav.fun
        inside a wallet's dapp browser when the mobile browser has no
        injected provider at all.

   Module-level store with subscribe/notify, viem WalletClient over the
   selected provider, silent session restore across reloads (including WC/CB
   SDK sessions), and chain enforcement for Robinhood Chain mainnet (4663).
   SDKs are dynamic imports — zero cost until the user picks them. */
import { createWalletClient, custom, type Address, type WalletClient } from "viem";
import { useSyncExternalStore } from "react";
import { robinhoodChain } from "./chain";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  removeListener?(event: string, cb: (...args: unknown[]) => void): void;
  disconnect?(): Promise<void>;
  session?: unknown; // WalletConnect session (when restored)
}

export type ConnectorKind = "injected" | "coinbase" | "walletconnect";

export interface WalletInfo {
  rdns: string;
  name: string;
  icon: string; // data: URI (EIP-6963) or inline SVG data URI for SDK connectors
  kind: ConnectorKind;
}

interface Discovered extends WalletInfo {
  provider?: Eip1193; // resolved provider
  getProvider?: () => Promise<Eip1193>; // lazy factory (SDK connectors)
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export interface WalletState {
  status: "disconnected" | "connecting" | "connected" | "wrong-chain";
  account: Address | null;
  chainId: number | null;
  /** rdns of the connected provider (or "injected" for the fallback). */
  connectedTo: string | null;
  /** Discovered wallets, for the picker. Updated as announcements arrive. */
  wallets: WalletInfo[];
}

const LS_KEY = "nav.wallet.rdns";
const WC_PROJECT_ID = ((import.meta.env.VITE_WC_PROJECT_ID as string | undefined) ?? "").trim();

let state: WalletState = { status: "disconnected", account: null, chainId: null, connectedTo: null, wallets: [] };
const subs = new Set<() => void>();
const discovered = new Map<string, Discovered>();
let active: Eip1193 | null = null;

function setState(next: Partial<WalletState>) {
  state = { ...state, ...next };
  subs.forEach((f) => f());
}

function publishWallets() {
  setState({ wallets: [...discovered.values()].map(({ rdns, name, icon, kind }) => ({ rdns, name, icon, kind })) });
}

/* ------------------------------------------------------- environment */

/** True on phone/tablet browsers — used to surface deep links in the picker. */
export function isMobileUA(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod|android/i.test(navigator.userAgent);
}

/** The page URL to reopen inside a wallet's in-app browser. */
function dapp(): { href: string; hostPath: string; origin: string } {
  const { href, host, pathname, hash, origin } = window.location;
  return { href, hostPath: `${host}${pathname}${hash}`, origin };
}

/** Deep links that reopen nav.fun inside a mobile wallet's dapp browser,
    where the wallet injects a provider and the normal flow works. Shown on
    mobile so the page can always be reopened inside a wallet's own browser.
    audit-v5 M-1: every interpolated URL component is percent-encoded —
    including MetaMask's host/path form — so a crafted `#` fragment cannot
    smuggle a foreign URL into a deep link. */
export function mobileWalletLinks(): { name: string; color: string; fg: string; href: string }[] {
  const u = dapp();
  const e = encodeURIComponent;
  // MetaMask's app link takes a bare host/path (no scheme). Encode each path
  // segment and drop any hash — the fragment is attacker-influenceable and
  // MetaMask does not need it to reopen the dapp.
  const mmPath = u.hostPath
    .split("#")[0]
    .split("/")
    .map((seg, i) => (i === 0 ? seg : e(seg)))
    .join("/");
  return [
    { name: "MetaMask", color: "#f6851b", fg: "#1c1917", href: `https://metamask.app.link/dapp/${mmPath}` },
    { name: "Phantom", color: "#ab9ff2", fg: "#1c1917", href: `https://phantom.app/ul/browse/${e(u.href)}?ref=${e(u.origin)}` },
    { name: "Coinbase Wallet", color: "#0052ff", fg: "#ffffff", href: `https://go.cb-w.com/dapp?cb_url=${e(u.href)}` },
    { name: "Trust Wallet", color: "#3375bb", fg: "#ffffff", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${e(u.href)}` },
    { name: "OKX Wallet", color: "#0f0f0f", fg: "#ffffff", href: `https://www.okx.com/download?deeplink=${e(`okx://wallet/dapp/url?dappUrl=${u.href}`)}` },
  ];
}

/* ------------------------------------------------- EIP-6963 discovery */

let pendingRestore: string | null = null;

/**
 * V6 FP-M01/FP-L05 hardening.
 *
 * EIP-6963 announcements are attacker-controllable: any script on the page can
 * dispatch one, and a malicious extension can announce a provider whose `name`
 * and `icon` clone MetaMask's exactly. The probe campaign confirmed two rows
 * both rendering as "METAMASK / INJECTED" with no way for the user to tell them
 * apart, so connecting to the forged row silently adopted the attacker's
 * address.
 *
 * The XSS sinks themselves are inert (React escapes text, and a `javascript:`
 * icon never executes as an <img> src), so the exposure is the DECISION
 * SURFACE, not code execution. These helpers therefore normalise what we are
 * willing to display, and `rdns` is surfaced in the UI as the distinguishing
 * identity — it is the only field that cannot be silently duplicated, because
 * the first announcer of a given rdns wins the map slot.
 */

/** Longest wallet name we will render. Prevents the 5,000-char layout break. */
const MAX_WALLET_NAME = 32;

/** rdns must look like a reverse-DNS identifier, not markup or a URL. */
const RDNS_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

function cleanWalletName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Strip control characters and collapse whitespace, then bound the length.
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > MAX_WALLET_NAME ? s.slice(0, MAX_WALLET_NAME - 1) + "\u2026" : s;
}

/**
 * Only allow icon URLs that cannot execute or phone home:
 * `data:image/*` and `https:`. Rejects `javascript:`, `vbscript:`, `blob:` and
 * bare/relative values. An unusable icon degrades to no icon, never to a sink.
 */
function cleanWalletIcon(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);/i.test(s)) return s;
  if (/^https:\/\//i.test(s)) return s;
  return "";
}

function announce(detail: { info: { rdns: string; name: string; icon: string }; provider: Eip1193 }) {
  if (!detail?.info?.rdns || !detail.provider) return;
  const rdns = typeof detail.info.rdns === "string" ? detail.info.rdns.trim() : "";
  // Reject malformed rdns outright — a wallet that cannot identify itself
  // properly is not offered as a connection choice (FP-M01).
  if (!RDNS_RE.test(rdns) || rdns.length > 100) return;
  // First announcer of an rdns wins; a later clone cannot displace it.
  if (discovered.has(rdns)) return;
  const name = cleanWalletName(detail.info.name);
  if (!name) return;
  discovered.set(rdns, {
    rdns,
    name,
    icon: cleanWalletIcon(detail.info.icon),
    kind: "injected",
    provider: detail.provider,
  });
  publishWallets();
  // Reactive session restore for late announcers (M-11).
  if (pendingRestore === rdns && !active) {
    pendingRestore = null;
    void restore(rdns);
  }
}

/* ---------------------------------------------------- SDK connectors */

const svgIcon = (body: string) =>
  "data:image/svg+xml;base64," + btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`);

const CB_ICON = svgIcon(
  '<rect width="24" height="24" rx="5" fill="#0052ff"/><path fill="#fff" d="M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm-2.3 6.1c0-.5.4-.9.9-.9h2.8c.5 0 .9.4.9.9v2.8c0 .5-.4.9-.9.9h-2.8a.9.9 0 0 1-.9-.9v-2.8Z"/>',
);
const WC_ICON = svgIcon(
  '<rect width="24" height="24" rx="5" fill="#3396ff"/><path fill="#fff" d="M7.4 10c2.54-2.49 6.66-2.49 9.2 0l.3.3c.13.12.13.32 0 .45l-1.04 1.02a.16.16 0 0 1-.23 0l-.42-.41a4.57 4.57 0 0 0-6.42 0l-.45.44a.16.16 0 0 1-.23 0L7.07 10.78a.32.32 0 0 1 0-.45l.33-.32Zm11.36 2.12.93.9c.12.13.12.33 0 .46l-4.2 4.11a.33.33 0 0 1-.46 0l-2.97-2.91a.08.08 0 0 0-.12 0l-2.97 2.91a.33.33 0 0 1-.46 0l-4.2-4.11a.32.32 0 0 1 0-.46l.93-.9a.33.33 0 0 1 .46 0l2.98 2.91c.03.04.08.04.11 0l2.98-2.91a.33.33 0 0 1 .46 0l2.98 2.91c.03.04.08.04.11 0l2.98-2.91a.33.33 0 0 1 .46 0Z"/>',
);

let cbProvider: Eip1193 | null = null;
async function coinbaseProvider(): Promise<Eip1193> {
  if (cbProvider) return cbProvider;
  const { createCoinbaseWalletSDK } = await import("@coinbase/wallet-sdk");
  const sdk = createCoinbaseWalletSDK({
    appName: "NAV — nav.fun",
    appLogoUrl: "https://nav.fun/favicon.svg",
    appChainIds: [robinhoodChain.id],
    preference: { options: "eoaOnly" }, // EOA app/extension flow — supports custom chains
  });
  cbProvider = sdk.getProvider() as unknown as Eip1193;
  return cbProvider;
}

let wcProvider: Eip1193 | null = null;
async function walletconnectProvider(): Promise<Eip1193> {
  if (wcProvider) return wcProvider;
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  wcProvider = (await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    chains: [1], // required set: mainnet only, so every wallet can pair
    optionalChains: [robinhoodChain.id],
    rpcMap: {
      [robinhoodChain.id]: robinhoodChain.rpcUrls.default.http[0],
      1: "https://ethereum-rpc.publicnode.com",
    },
    showQrModal: true,
    metadata: {
      name: "NAV — nav.fun",
      description: "Tokenized-stock ETF vault + weekly options pit on Robinhood Chain",
      url: "https://nav.fun",
      icons: ["https://nav.fun/favicon.svg"],
    },
  })) as unknown as Eip1193;
  return wcProvider;
}

function registerSdkConnectors() {
  if (!discovered.has("coinbaseWalletSDK")) {
    discovered.set("coinbaseWalletSDK", {
      rdns: "coinbaseWalletSDK",
      name: "Coinbase Wallet",
      icon: CB_ICON,
      kind: "coinbase",
      getProvider: coinbaseProvider,
    });
  }
  if (WC_PROJECT_ID && !discovered.has("walletConnect")) {
    discovered.set("walletConnect", {
      rdns: "walletConnect",
      name: "WalletConnect",
      icon: WC_ICON,
      kind: "walletconnect",
      getProvider: walletconnectProvider,
    });
  }
}

/* ------------------------------------------------------------ bootstrap */

let bootstrapped = false;
function bootstrap() {
  if (bootstrapped || typeof window === "undefined") return;
  bootstrapped = true;
  window.addEventListener("eip6963:announceProvider", ((e: CustomEvent) => announce(e.detail)) as EventListener);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  registerSdkConnectors();
  publishWallets();
  // Fallback entry for legacy single-injected environments (wallet in-app
  // browsers that predate EIP-6963 announce plain window.ethereum only).
  setTimeout(() => {
    const injectedCount = [...discovered.values()].filter((d) => d.kind === "injected").length;
    if (injectedCount === 0 && window.ethereum) {
      discovered.set("injected", {
        rdns: "injected",
        name: "Injected wallet",
        icon: svgIcon('<rect width="24" height="24" rx="4" fill="#2b2b2b"/><path d="M6 12h12M12 6v12" stroke="#e8e6dc" stroke-width="2"/>'),
        kind: "injected",
        provider: window.ethereum,
      });
      publishWallets();
      if (pendingRestore === "injected" && !active) {
        pendingRestore = null;
        void restore("injected");
      }
    }
  }, 400);
  // Silent session restore. Reactive: restore as soon as the saved wallet
  // announces itself (slow-injecting extensions), with a timeout fallback.
  const saved = localStorage.getItem(LS_KEY);
  if (saved) {
    pendingRestore = saved;
    setTimeout(() => void restore(saved), 600);
  }
}

async function restore(rdns: string) {
  const d = discovered.get(rdns) ?? (rdns === "injected" && window.ethereum ? discovered.get("injected") : undefined);
  if (!d) return;
  try {
    let provider = d.provider;
    if (!provider && d.getProvider) {
      // SDK connectors: resolve silently. WalletConnect only restores when a
      // relay session already exists — never opens the QR modal on page load.
      provider = await d.getProvider();
      if (d.kind === "walletconnect" && !provider.session) return;
      d.provider = provider;
    }
    if (!provider) return;
    const accs = (await withTimeout(provider.request({ method: "eth_accounts" }))) as unknown;
    const acc = asAddress(Array.isArray(accs) ? accs[0] : undefined);
    if (!acc) return;
    const cid = asChainId(await withTimeout(provider.request({ method: "eth_chainId" })));
    if (cid === null) return;
    adopt(d, acc, cid);
  } catch {
    /* stale session — stay disconnected */
  }
}

/* --------------------------------------------------- connect / listen */

/**
 * V6 FP-L01: provider responses were adopted without validation, so a hostile
 * or buggy provider could hand back a non-address "account" and a `NaN` chain
 * id, both of which were displayed as a live connected session. These guards
 * make an invalid response a failed connect instead of a fake one.
 */
function asAddress(raw: unknown): Address | null {
  return typeof raw === "string" && /^0x[0-9a-fA-F]{40}$/.test(raw) ? (raw as Address) : null;
}

const okChainId = (n: number) => Number.isFinite(n) && Number.isInteger(n) && n > 0 && n <= 0xffffffff;

/**
 * Accepts hex ('0x1235'), decimal ('4663'), number and bigint chain ids;
 * rejects NaN, negatives and out-of-range values.
 *
 * A bare numeric string is genuinely ambiguous — EIP-1193 mandates the `0x`
 * prefix, so anything without one is a spec-violating provider and could mean
 * either base. We read it as decimal (the case the probe campaign actually
 * observed), but if the decimal reading is not our chain while the hex reading
 * IS, we prefer hex. That way neither flavour of non-compliant provider gets
 * shown a false "wrong chain" warning.
 */
function asChainId(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "bigint") n = Number(raw);
  else if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "") return null;
    if (s.toLowerCase().startsWith("0x")) {
      n = Number.parseInt(s, 16);
    } else {
      const dec = Number.parseInt(s, 10);
      const hex = Number.parseInt(s, 16);
      n = okChainId(dec) && dec !== robinhoodChain.id && okChainId(hex) && hex === robinhoodChain.id ? hex : dec;
    }
  } else return null;
  return okChainId(n) ? n : null;
}

/**
 * FP-L04: a provider that never resolves `eth_requestAccounts` left the connect
 * button stuck on "CONNECTING" forever. Bound every provider round-trip.
 */
const PROVIDER_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms = PROVIDER_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("provider timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function adopt(d: Discovered, account: Address, chainId: number) {
  if (active?.removeListener) {
    active.removeListener("accountsChanged", onAccounts);
    active.removeListener("chainChanged", onChain);
    active.removeListener("disconnect", onProviderDisconnect);
  }
  active = d.provider!;
  active.on?.("accountsChanged", onAccounts);
  active.on?.("chainChanged", onChain);
  active.on?.("disconnect", onProviderDisconnect);
  pendingRestore = null;
  localStorage.setItem(LS_KEY, d.rdns);
  setState({
    account,
    chainId,
    connectedTo: d.rdns,
    status: chainId === robinhoodChain.id ? "connected" : "wrong-chain",
  });
}

function onAccounts(...args: unknown[]) {
  // FP-L02: this previously indexed args[0] as an array unconditionally, so a
  // provider emitting `accountsChanged(undefined)` threw a TypeError out of
  // the handler and into the provider's emit loop. Treat any payload that is
  // not a valid address list as a disconnect.
  const raw = args[0];
  const a = asAddress(Array.isArray(raw) ? raw[0] : undefined);
  if (!a) disconnectWallet();
  else setState({ account: a, status: state.chainId === robinhoodChain.id ? "connected" : "wrong-chain" });
}

function onChain(...args: unknown[]) {
  // FP-L03: chainChanged was parsed as hex unconditionally. Providers that emit
  // a decimal string ('4663') or a number were mis-parsed — parseInt('4663',16)
  // is 18019 — flipping a correctly-chained wallet into a "wrong chain" warning.
  // asChainId handles hex, decimal, number and bigint, and rejects garbage.
  const id = asChainId(args[0]);
  if (id === null) return; // unparseable: keep the last known good chain
  setState({ chainId: id, status: state.account ? (id === robinhoodChain.id ? "connected" : "wrong-chain") : state.status });
}

function onProviderDisconnect() {
  // EIP-1193 disconnect event: provider can no longer serve requests.
  if (active) disconnectWallet();
}

/** Connect to a specific discovered wallet (rdns from state.wallets).
    Without an rdns: single injected wallet connects directly, otherwise the
    picker opens (it always has options — SDK connectors and deep links). */
export async function connectWallet(rdns?: string): Promise<void> {
  bootstrap();
  if (!rdns) {
    requestConnect();
    return;
  }
  const pick = discovered.get(rdns);
  if (!pick) return;
  // Snapshot so a failed/rejected attempt restores the previous session
  // instead of leaving a live provider behind a "disconnected" UI (H-02).
  const prev = { state: { ...state }, active };
  setState({ status: "connecting" });
  try {
    if (!pick.provider && pick.getProvider) pick.provider = await withTimeout(pick.getProvider());
    if (!pick.provider) throw new Error("no provider");
    const accs = (await withTimeout(pick.provider.request({ method: "eth_requestAccounts" }))) as unknown;
    // FP-L01: only a well-formed 20-byte address counts as connected.
    const acc = asAddress(Array.isArray(accs) ? accs[0] : undefined);
    if (!acc) throw new Error("no accounts");
    const cid = asChainId(await withTimeout(pick.provider.request({ method: "eth_chainId" })));
    if (cid === null) throw new Error("bad chain id");
    adopt(pick, acc, cid);
  } catch {
    if (prev.active && prev.state.account) {
      // Was connected before the attempt — restore that session untouched.
      active = prev.active;
      setState({ status: prev.state.status, account: prev.state.account, chainId: prev.state.chainId, connectedTo: prev.state.connectedTo });
    } else {
      // Was not connected — make the failure a FULL reset so no provider
      // survives behind the disconnected UI.
      active = null;
      setState({ status: "disconnected", account: null, chainId: null, connectedTo: null });
    }
  }
}

/** Shared connect entrypoint for CTA buttons (M-03/M-04):
    exactly one injected wallet -> connects it directly;
    anything else -> opens the picker, which always has options (injected
    wallets, Coinbase Wallet, WalletConnect when configured, and mobile
    deep links). */
export function requestConnect(): "connecting" | "picker" {
  bootstrap();
  const injected = [...discovered.values()].filter((d) => d.kind === "injected");
  if (injected.length === 1 && discovered.size === 1) {
    void connectWallet(injected[0].rdns);
    return "connecting";
  }
  window.dispatchEvent(new Event("nav:open-wallet-picker"));
  return "picker";
}

/** Hard disconnect: forget the session, revoke permissions where supported. */
export function disconnectWallet(): void {
  const p = active;
  const rdns = state.connectedTo;
  localStorage.removeItem(LS_KEY);
  if (p?.removeListener) {
    p.removeListener("accountsChanged", onAccounts);
    p.removeListener("chainChanged", onChain);
    p.removeListener("disconnect", onProviderDisconnect);
  }
  active = null;
  setState({ status: "disconnected", account: null, chainId: null, connectedTo: null });
  const d = rdns ? discovered.get(rdns) : undefined;
  if (d && d.kind !== "injected") {
    // SDK sessions: end the relay/app session for real; drop the cached
    // provider so the next connect starts clean.
    void p?.disconnect?.().catch(() => undefined);
    d.provider = undefined;
    if (d.kind === "walletconnect") wcProvider = null;
    if (d.kind === "coinbase") cbProvider = null;
  } else {
    // Best-effort permission revoke (MetaMask + compatible); ignore failures.
    void p?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => undefined);
  }
}

/** Prompt the wallet onto Robinhood Chain, adding it if unknown. */
export async function ensureChain(): Promise<boolean> {
  if (!active) return false;
  const hex = `0x${robinhoodChain.id.toString(16)}`;
  try {
    await active.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    return true;
  } catch (e) {
    // Only offer to ADD the chain when the wallet reports it as unknown
    // (EIP-3085 error 4902). A user rejection must not re-prompt (M-09).
    const code = (e as { code?: number })?.code;
    if (code !== 4902) return false;
    try {
      await active.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex,
          chainName: "Robinhood Chain",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [robinhoodChain.rpcUrls.default.http[0]],
          blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
        }],
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function walletClient(): WalletClient | null {
  if (!active || !state.account) return null;
  return createWalletClient({ chain: robinhoodChain, transport: custom(active) });
}

export function useWallet(): WalletState {
  bootstrap();
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
    () => state,
  );
}
