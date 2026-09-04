/**
 * Injected-wallet plumbing for the one-time Unlimited purchase.
 *
 * Everything here runs in the browser and none of it is trusted. The wallet's only job is to
 * broadcast an ERC-20 transfer and hand back a transaction hash; that hash is then posted to
 * `/api/payments/crypto/verify`, which reads the chain itself and decides. Nothing in this file
 * can activate a subscription, and nothing in this file is consulted by the server — so a
 * tampered wallet, a spoofed provider or a patched bundle can lie about the amount, the
 * recipient, the token or the chain and change no outcome whatsoever.
 *
 * The module is deliberately dependency-free and, apart from `connectAndPay`, pure: address
 * encoding, chain-id parsing, provider discovery and error classification are all functions over
 * plain values, which is what makes the wallet layer testable in Node with no browser and no
 * network. No wallet SDK is used, so no wallet is privileged: discovery is EIP-6963 first, with
 * a legacy `window.ethereum` fallback, and every provider found is spoken to over EIP-1193.
 *
 * There is no private key, seed phrase, mnemonic or signing key anywhere in this path. Relayn
 * never holds custody of anything: the payer's own wallet signs, and Relayn only ever reads.
 */
import { formatAssetAmount, normalizeTxHash, parseBaseUnits } from "./amount";

// ── EIP-1193 / EIP-6963 shapes ────────────────────────────────────────────────────────────
//
// Typed narrowly enough to be useful and loosely enough that any conforming wallet fits. The
// `is*` flags are vendor extensions, not standards; they are only used to *label* a legacy
// provider that predates EIP-6963, never to decide what a wallet is allowed to do.

export interface Eip1193RequestArgs {
  method: string;
  params?: readonly unknown[] | object;
}

export interface Eip1193Provider {
  request(args: Eip1193RequestArgs): Promise<unknown>;
  on?(event: string, listener: (...args: never[]) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): void;
  /** Legacy multi-wallet array, from before EIP-6963 existed. */
  providers?: readonly Eip1193Provider[];
  isMetaMask?: boolean;
  isRabby?: boolean;
  isOkxWallet?: boolean;
  isOKExWallet?: boolean;
  isCoinbaseWallet?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  isBraveWallet?: boolean;
  isPhantom?: boolean;
}

export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  /** Reverse-DNS identity, e.g. "io.metamask". The only wallet identifier worth keying on. */
  rdns: string;
}

export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

/** One entry in the wallet picker. */
export interface DiscoveredWallet {
  /** Stable React key and test handle: the rdns when the wallet announced one. */
  id: string;
  name: string;
  rdns: string | null;
  /** Data URI supplied by the wallet itself. Rendered, never fetched. */
  icon: string | null;
  provider: Eip1193Provider;
  source: "eip6963" | "legacy";
}

/** Minimal surface `discoverInjectedWallets` needs, so tests can pass a fake. */
export interface WalletWindow {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
  ethereum?: Eip1193Provider;
}

export const EIP6963_ANNOUNCE_EVENT = "eip6963:announceProvider";
export const EIP6963_REQUEST_EVENT = "eip6963:requestProvider";

/**
 * Display names for wallets we know by name, so the picker reads the way the user expects even
 * when a wallet announces an awkward `info.name`. An unknown rdns keeps its announced name —
 * the list is a nicety, not an allowlist, and a wallet missing from it works identically.
 */
const RDNS_LABELS: Record<string, string> = {
  "io.metamask": "MetaMask",
  "io.metamask.flask": "MetaMask Flask",
  "io.rabby": "Rabby",
  "com.okex.wallet": "OKX Wallet",
  "com.okx.wallet": "OKX Wallet",
  "com.coinbase.wallet": "Coinbase Wallet",
  "com.brave.wallet": "Brave Wallet",
  "com.trustwallet.app": "Trust Wallet",
};

/**
 * Names a pre-EIP-6963 provider from its vendor flags.
 *
 * Order is load-bearing. Rabby, OKX and several others set `isMetaMask = true` so that dapps
 * which only ever checked that one flag keep working, so testing MetaMask first would label
 * every one of them "MetaMask". The specific vendors are therefore checked before the generic
 * flag, and an unrecognised provider gets a neutral label rather than a guess.
 */
export function legacyWalletName(provider: Eip1193Provider): string {
  if (provider.isRabby) return "Rabby";
  if (provider.isOkxWallet || provider.isOKExWallet) return "OKX Wallet";
  if (provider.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider.isBraveWallet) return "Brave Wallet";
  if (provider.isTrust || provider.isTrustWallet) return "Trust Wallet";
  if (provider.isPhantom) return "Phantom";
  if (provider.isMetaMask) return "MetaMask";
  return "Injected wallet";
}

/**
 * Every legacy provider `window.ethereum` exposes.
 *
 * When several extensions are installed they fight over that one property, and the loser
 * traditionally hides in `window.ethereum.providers`. Picking `providers[0]` — or, worse,
 * `window.ethereum` alone — is how a payer ends up paying from a wallet they did not choose, so
 * all of them are surfaced and the choice is the user's.
 */
export function legacyInjectedWallets(win: WalletWindow): DiscoveredWallet[] {
  const root = win.ethereum;
  if (!root) return [];
  const candidates = Array.isArray(root.providers) && root.providers.length > 0
    ? [...root.providers]
    : [root];
  const seen = new Set<Eip1193Provider>();
  const wallets: DiscoveredWallet[] = [];
  candidates.forEach((provider, index) => {
    if (!provider || typeof provider.request !== "function" || seen.has(provider)) return;
    seen.add(provider);
    const name = legacyWalletName(provider);
    wallets.push({
      id: `legacy:${name}:${index}`,
      name,
      rdns: null,
      icon: null,
      provider,
      source: "legacy",
    });
  });
  return wallets;
}

function isProviderDetail(value: unknown): value is Eip6963ProviderDetail {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as { info?: unknown; provider?: unknown };
  const info = detail.info as { rdns?: unknown; name?: unknown } | undefined;
  const provider = detail.provider as { request?: unknown } | undefined;
  return (
    typeof info?.rdns === "string" &&
    info.rdns.length > 0 &&
    typeof info.name === "string" &&
    typeof provider?.request === "function"
  );
}

/**
 * EIP-6963 discovery, with the legacy provider as a fallback rather than an addition.
 *
 * Announcements are collected first: a wallet that implements the standard identifies itself by
 * rdns, which is unambiguous. Only if nothing announces do we look at `window.ethereum` — mixing
 * the two would list a modern wallet twice under two different names.
 *
 * `timeoutMs` exists because the standard permits an asynchronous announcement. In practice
 * every extension answers on the same tick, so the wait is short; tests pass 0 and announce
 * synchronously.
 */
export async function discoverInjectedWallets(
  win: WalletWindow,
  options: { timeoutMs?: number } = {},
): Promise<DiscoveredWallet[]> {
  const byRdns = new Map<string, DiscoveredWallet>();

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isProviderDetail(detail)) return;
    const { info, provider } = detail;
    // First announcement for an rdns wins; wallets re-announce on every request event.
    if (byRdns.has(info.rdns)) return;
    byRdns.set(info.rdns, {
      id: info.rdns,
      name: RDNS_LABELS[info.rdns] ?? info.name,
      rdns: info.rdns,
      icon: typeof info.icon === "string" ? info.icon : null,
      provider,
      source: "eip6963",
    });
  };

  win.addEventListener(EIP6963_ANNOUNCE_EVENT, onAnnounce);
  try {
    win.dispatchEvent(makeEvent(EIP6963_REQUEST_EVENT));
    const timeoutMs = options.timeoutMs ?? 300;
    if (timeoutMs > 0) await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  } finally {
    win.removeEventListener(EIP6963_ANNOUNCE_EVENT, onAnnounce);
  }

  const announced = [...byRdns.values()];
  return announced.length > 0 ? announced : legacyInjectedWallets(win);
}

/** `CustomEvent` in a browser; a structurally identical object where it does not exist. */
function makeEvent(type: string): Event {
  if (typeof CustomEvent === "function") return new CustomEvent(type);
  return { type } as Event;
}

/**
 * The real `window` as a `WalletWindow`, or null when there is none.
 *
 * One cast, in one place. `window.ethereum` is injected by an extension and so has no ambient
 * type; keeping the assertion here means the component never has to write one, and the null
 * result is what makes "no compatible wallet detected" reachable during server rendering.
 */
export function browserWalletWindow(): WalletWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as WalletWindow);
}

// ── Chain identity ────────────────────────────────────────────────────────────────────────

/** Thrown for input this module refuses to encode or interpret. Never shown to a payer. */
export class WalletEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletEncodeError";
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS.test(value);
}

/** `8453` → `"0x2105"`. EIP-155 chain ids travel as minimal hex quantities, not decimals. */
export function toHexQuantity(value: number | bigint): string {
  const big = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (big < 0n) throw new WalletEncodeError(`Not a quantity: ${value}`);
  return `0x${big.toString(16)}`;
}

/**
 * Reads a chain id out of whatever a wallet returned.
 *
 * `eth_chainId` is specified as a hex quantity, but wallets have historically returned decimal
 * strings and plain numbers. Returning null for anything unrecognised keeps the caller honest:
 * an unreadable chain id must block payment, not be treated as "probably right".
 */
export function parseChainId(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw === "bigint") return raw > 0n ? Number(raw) : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const value = /^0x[0-9a-fA-F]+$/.test(trimmed)
    ? Number.parseInt(trimmed, 16)
    : /^\d+$/.test(trimmed)
      ? Number.parseInt(trimmed, 10)
      : Number.NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * `wallet_addEthereumChain` parameters for the chains this rail supports.
 *
 * Public RPC endpoints on purpose: the operator's own `CRYPTO_PAYMENT_RPC_URL` may carry an API
 * key and is server-only, so it is never handed to a wallet. A chain absent from this map can
 * still be switched to if the wallet already knows it — we simply cannot offer to add it.
 */
export const KNOWN_EVM_CHAINS: Record<number, {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
}> = {
  8453: {
    chainId: "0x2105",
    chainName: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.base.org"],
    blockExplorerUrls: ["https://basescan.org"],
  },
  84532: {
    chainId: "0x14a34",
    chainName: "Base Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia.base.org"],
    blockExplorerUrls: ["https://sepolia.basescan.org"],
  },
};

// ── ERC-20 calldata ───────────────────────────────────────────────────────────────────────
//
// Hand-rolled rather than pulled from an ABI library: two functions with fixed 32-byte
// arguments is less code than the dependency, and it keeps the exact bytes that reach the
// wallet visible in one place — which is the part a reviewer needs to check.

/** `transfer(address,uint256)` */
export const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
/** `balanceOf(address)` */
export const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";

const UINT256_MAX = (1n << 256n) - 1n;

function word(hex: string): string {
  const bare = hex.toLowerCase().replace(/^0x/, "");
  if (bare.length > 64) throw new WalletEncodeError("ABI word overflow");
  return bare.padStart(64, "0");
}

/**
 * `USDC.transfer(recipient, amountBaseUnits)` calldata.
 *
 * The amount arrives as a base-unit decimal *string* from the server's payment instructions and
 * is parsed with BigInt. No `Number` touches it at any point, so `0.10 USDC` is the integer
 * 100000 rather than 100000.00000000001 — which would be rejected by the encoder here instead
 * of quietly becoming a wrong transfer.
 */
export function encodeErc20Transfer(recipient: string, amountBaseUnits: string): string {
  if (!isAddress(recipient)) {
    throw new WalletEncodeError(`Not an address: ${JSON.stringify(recipient)}`);
  }
  const amount = parseBaseUnits(amountBaseUnits);
  if (amount <= 0n) throw new WalletEncodeError(`Amount must be positive: ${amountBaseUnits}`);
  if (amount > UINT256_MAX) throw new WalletEncodeError("Amount exceeds uint256");
  return `${ERC20_TRANSFER_SELECTOR}${word(recipient)}${word(amount.toString(16))}`;
}

export function encodeErc20BalanceOf(owner: string): string {
  if (!isAddress(owner)) throw new WalletEncodeError(`Not an address: ${JSON.stringify(owner)}`);
  return `${ERC20_BALANCE_OF_SELECTOR}${word(owner)}`;
}

/** Decodes a single `uint256` return value. `"0x"` — an empty return — reads as zero. */
export function decodeUint256(raw: unknown): bigint {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw)) {
    throw new WalletEncodeError(`Not a hex return value: ${JSON.stringify(raw)}`);
  }
  const bare = raw.slice(2);
  return bare === "" ? 0n : BigInt(`0x${bare}`);
}

// ── The transaction ───────────────────────────────────────────────────────────────────────

/**
 * The subset of the server's `PaymentInstructions` the wallet layer reads.
 *
 * Declared structurally rather than imported so this module pulls in nothing server-only, and so
 * the fields are enumerated where they are used: chain, token, recipient and amount all come
 * from the server on every page load. There is no client-side default for any of them — a
 * missing field is an error, not a fallback.
 */
export interface WalletPaymentTarget {
  chainId: number;
  networkLabel: string;
  asset: string;
  assetAddress: string;
  assetDecimals: number;
  address: string;
  amountBaseUnits: string;
}

/** An `eth_sendTransaction` parameter object. */
export interface TransferTransaction {
  from: string;
  to: string;
  data: string;
  value: string;
}

/**
 * Builds the ERC-20 transfer.
 *
 * `to` is the **token contract** and `value` is hard-wired to `"0x0"`: this is a contract call,
 * never a native ETH transfer. Sending ETH to the receiving address would be unverifiable by the
 * backend — it matches `Transfer` events on the configured USDC contract — so the one mistake
 * that would produce an unrecoverable payment is made unrepresentable here.
 */
export function buildTransferTransaction(
  from: string,
  target: WalletPaymentTarget,
): TransferTransaction {
  if (!isAddress(from)) throw new WalletEncodeError(`Not an address: ${JSON.stringify(from)}`);
  if (!isAddress(target.assetAddress)) {
    throw new WalletEncodeError("Configured asset address is not an address");
  }
  return {
    from,
    to: target.assetAddress,
    data: encodeErc20Transfer(target.address, target.amountBaseUnits),
    value: "0x0",
  };
}

// ── Display helpers ───────────────────────────────────────────────────────────────────────

/** `0x9578031Bedb9cc7CE2d605Dbce2aecf2e63A4C88` → `0x9578...4C88`. Case is preserved. */
export function shortenAddress(address: string, lead = 4, tail = 4): string {
  if (!isAddress(address)) return address;
  return `${address.slice(0, 2 + lead)}...${address.slice(-tail)}`;
}

/** Wallet balance for display, e.g. `"12.40"`. Exact string arithmetic, as everywhere else. */
export function formatWalletBalance(baseUnits: bigint | string, decimals: number): string {
  const raw = typeof baseUnits === "bigint" ? baseUnits.toString() : baseUnits;
  return formatAssetAmount(raw, decimals, 2);
}

/** True when the connected wallet can cover the price. Not a security check — a UX one. */
export function hasSufficientBalance(balance: bigint, requiredBaseUnits: string): boolean {
  return balance >= parseBaseUnits(requiredBaseUnits);
}

// ── Payer-facing copy ─────────────────────────────────────────────────────────────────────
//
// Fixed strings, deliberately incurious about the underlying failure. A wallet or an RPC node
// will happily hand back a stack trace, a node hostname or an internal JSON-RPC code; none of
// that reaches the page.

export const WALLET_MESSAGES = {
  cancelled: "Payment cancelled.",
  unavailable: "No compatible wallet detected.",
  verifyFailed: "Payment could not be verified.",
  /** Anything the wallet refused for a reason of its own. */
  failed: "The wallet could not complete this transaction.",
} as const;

export function wrongNetworkMessage(networkLabel: string): string {
  return `Please switch to ${networkLabel}.`;
}

export function insufficientBalanceMessage(asset: string): string {
  return `Insufficient ${asset} balance.`;
}

export type WalletErrorKind =
  | "cancelled"
  | "insufficient"
  | "wrong_network"
  | "chain_not_added"
  | "unavailable"
  | "failed";

/** Pulls a numeric provider error code out of the several shapes wallets use. */
function errorCode(error: unknown): number | null {
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const record = node as { code?: unknown; data?: unknown; cause?: unknown };
    if (typeof record.code === "number") return record.code;
    if (typeof record.code === "string" && /^-?\d+$/.test(record.code)) {
      return Number.parseInt(record.code, 10);
    }
    // MetaMask nests the provider error under `data.originalError`; others use `cause`.
    const data = record.data as { originalError?: unknown } | undefined;
    node = data?.originalError ?? record.cause ?? null;
  }
  return null;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; data?: { message?: unknown } };
    if (typeof record.message === "string") return record.message;
    if (typeof record.data?.message === "string") return record.data.message;
  }
  return "";
}

/**
 * Maps a wallet or RPC failure onto one of the fixed payer-facing strings.
 *
 * Codes are checked before text because they are specified (EIP-1193 §5: 4001 rejected, 4100
 * unauthorised, 4900/4901 disconnected; EIP-3085: 4902 unknown chain) while messages are not —
 * but both are consulted, since some wallets send `-32603` with the real reason only in prose.
 */
export function classifyWalletError(
  error: unknown,
  context: { networkLabel: string; asset: string },
): { kind: WalletErrorKind; message: string } {
  const code = errorCode(error);
  const text = errorText(error).toLowerCase();

  if (code === 4001 || /user rejected|user denied|rejected the request|action cancell?ed/.test(text)) {
    return { kind: "cancelled", message: WALLET_MESSAGES.cancelled };
  }
  if (/insufficient funds|insufficient balance|transfer amount exceeds balance|exceeds balance/.test(text)) {
    return { kind: "insufficient", message: insufficientBalanceMessage(context.asset) };
  }
  if (code === 4902 || /unrecognized chain|unrecognised chain|chain .*not added|try adding the chain/.test(text)) {
    return { kind: "chain_not_added", message: wrongNetworkMessage(context.networkLabel) };
  }
  if (code === 4900 || code === 4901 || code === 4100) {
    return { kind: "unavailable", message: WALLET_MESSAGES.unavailable };
  }
  if (/wrong network|chain mismatch|chain id/.test(text)) {
    return { kind: "wrong_network", message: wrongNetworkMessage(context.networkLabel) };
  }
  return { kind: "failed", message: WALLET_MESSAGES.failed };
}

// ── EIP-1193 operations ───────────────────────────────────────────────────────────────────
//
// Five thin wrappers. Each one validates what came back rather than trusting the shape, because
// a provider is an extension in the page — the least trustworthy thing in this file.

/** Prompts for accounts and returns the first, lowercased. Throws if the wallet returns none. */
export async function requestAccounts(provider: Eip1193Provider): Promise<string> {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const first = Array.isArray(accounts) ? accounts[0] : null;
  if (!isAddress(first)) throw new WalletEncodeError("Wallet returned no usable account");
  return first.toLowerCase();
}

export async function readChainId(provider: Eip1193Provider): Promise<number | null> {
  return parseChainId(await provider.request({ method: "eth_chainId" }));
}

/**
 * Asks the wallet to move to the required chain, offering to add it when unknown.
 *
 * Only ever called from a click. There is no automatic switch on mount and no switch attempt
 * bundled into the payment call: a page that reaches into a wallet and changes its network
 * without being asked is indistinguishable from a hostile one.
 */
export async function switchToChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  const hex = toHexQuantity(chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (error) {
    const known = KNOWN_EVM_CHAINS[chainId];
    const kind = classifyWalletError(error, { networkLabel: "", asset: "" }).kind;
    if (kind !== "chain_not_added" || !known) throw error;
    // The wallet has never heard of this chain. Adding it is still a prompt the user answers.
    await provider.request({ method: "wallet_addEthereumChain", params: [known] });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  }
}

/** ERC-20 `balanceOf`, read through the wallet's own RPC connection. */
export async function readTokenBalance(
  provider: Eip1193Provider,
  args: { token: string; owner: string },
): Promise<bigint> {
  const result = await provider.request({
    method: "eth_call",
    params: [{ to: args.token, data: encodeErc20BalanceOf(args.owner) }, "latest"],
  });
  return decodeUint256(result);
}

/**
 * Broadcasts the transfer and returns the hash.
 *
 * The return value is validated with the same `normalizeTxHash` the server uses, so a wallet that
 * answers with `true`, an object or a truncated string fails here rather than sending garbage to
 * the verify endpoint.
 */
export async function sendTransfer(
  provider: Eip1193Provider,
  transaction: TransferTransaction,
): Promise<string> {
  const result = await provider.request({
    method: "eth_sendTransaction",
    params: [transaction],
  });
  const hash = normalizeTxHash(result);
  if (!hash) throw new WalletEncodeError("Wallet returned no transaction hash");
  return hash;
}

/** What the wallet half of the payment produced. Never "paid" — that verdict is the server's. */
export interface PayOutcome {
  status: "submitted" | "wrong_network" | "cancelled" | "insufficient" | "failed";
  /** The hash the wallet reported, once there is one. */
  txHash: string | null;
  /** Payer-facing copy for a failure; null on success. */
  message: string | null;
}

/**
 * The whole wallet-side payment: check the chain, build the transfer, send it, hand the hash over.
 *
 * Extracted from the component so the sequence can be tested against a scripted EIP-1193 provider
 * with no browser — including the two cases that matter most, that a wrong chain sends nothing at
 * all, and that a rejected prompt reaches `submit` with nothing.
 *
 * The chain is re-read immediately before sending, because a payer can switch network in the
 * extension between connecting and clicking. `submit` is the only way anything leaves the page,
 * it receives one string, and `status: "submitted"` means exactly that — broadcast, not verified,
 * not paid, not activated.
 */
export async function payWithWallet(args: {
  provider: Eip1193Provider;
  account: string;
  target: WalletPaymentTarget;
  submit: (txHash: string) => Promise<void>;
}): Promise<PayOutcome> {
  const { provider, account, target, submit } = args;
  const context = { networkLabel: target.networkLabel, asset: target.asset };
  try {
    const live = await readChainId(provider);
    if (live !== target.chainId) {
      return {
        status: "wrong_network",
        txHash: null,
        message: wrongNetworkMessage(target.networkLabel),
      };
    }
    const hash = await sendTransfer(provider, buildTransferTransaction(account, target));
    await submit(hash);
    return { status: "submitted", txHash: hash, message: null };
  } catch (failure) {
    const { kind, message } = classifyWalletError(failure, context);
    const status: PayOutcome["status"] =
      kind === "cancelled" ? "cancelled" : kind === "insufficient" ? "insufficient" : "failed";
    return { status, txHash: null, message };
  }
}









