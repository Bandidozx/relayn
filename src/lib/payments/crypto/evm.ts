/**
 * EVM + ERC-20 crypto payment adapter.
 *
 * Verification is a **direct JSON-RPC read**, not an explorer query. That ordering is
 * deliberate: an explorer is a third-party index with its own cache, rate limits and API key,
 * and treating its JSON as the source of truth would mean granting permanent access on the
 * word of a service that is not the chain. Everything this adapter concludes comes from
 * `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_blockNumber` and
 * `eth_getBlockByNumber`. The explorer URL in the configuration is a hyperlink for the payer
 * and nothing more — no code path reads a balance or a status from it.
 *
 * What is verified, and where each fact comes from:
 *
 *   - **the network** — `eth_chainId` from the node itself, compared with the configured
 *     chain, plus the transaction's own `chainId` field when it has one;
 *   - **existence and finality** — a non-null `blockNumber` plus `eth_blockNumber` for the
 *     confirmation count. A hash the node cannot find is reported as not-found, never as
 *     invalid, because those are different things;
 *   - **success** — `receipt.status === "0x1"`. A reverted transaction moved nothing, however
 *     convincing its hash looks;
 *   - **asset, recipient and amount** — the ERC-20 `Transfer` logs in the receipt, filtered to
 *     the configured token contract and the configured recipient, and summed. The `to` and
 *     `value` fields of the transaction itself are *not* used for token transfers, because for
 *     an ERC-20 they name the token contract and zero.
 *
 * Only the standard three-topic `Transfer(address indexed, address indexed, uint256)` form is
 * recognised. A token that emits its transfers unindexed will simply never verify here, which
 * is the correct failure direction for an allowlist of exactly one asset.
 */
import "server-only";
import { env } from "@/lib/env";
import { fromBaseUnits, microUsdToBaseUnits, toBaseUnits } from "@/lib/payments/crypto/amount";
import { UNLIMITED_PRICE_USD_LABEL, UNLIMITED_PRICE_USD_MICRO } from "@/lib/plans";
import {
  CryptoProviderError,
  type CryptoPaymentProvider,
  type ObservedTransaction,
  type PaymentInstructions,
} from "@/lib/payments/crypto/types";

/** `keccak256("Transfer(address,address,uint256)")`. Fixed for every ERC-20. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Per-call ceiling on a node round trip. A payer is waiting on this. */
const RPC_TIMEOUT_MS = 10_000;

export const ADAPTER_ID = "evm-erc20";

interface EvmNetwork {
  slug: string;
  label: string;
  chainId: number;
  defaultRpcUrl: string;
  explorerUrl: string;
  /**
   * Circle-issued native USDC, used as the token default. Present only where it has been
   * checked against Circle's own published address — an unverified default here would be a
   * silent misconfiguration that looks like "no payment ever arrives".
   */
  nativeUsdc?: string;
}

/**
 * Networks this adapter knows how to price and verify on. Adding a chain is one entry; the
 * verification code is chain-agnostic beyond the chain id.
 */
export const EVM_NETWORKS: Record<string, EvmNetwork> = {
  base: {
    slug: "base",
    label: "Base",
    chainId: 8453,
    defaultRpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    nativeUsdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  "base-sepolia": {
    slug: "base-sepolia",
    label: "Base Sepolia",
    chainId: 84532,
    defaultRpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
    // Deliberately absent: the testnet token must be named explicitly by the operator.
  },
};

export interface EvmConfig {
  network: EvmNetwork;
  rpcUrl: string;
  /** Lowercased ERC-20 contract address of the accepted asset. */
  tokenAddress: string;
  assetSymbol: string;
  assetDecimals: number;
  /** Lowercased receiving address. */
  recipient: string;
  /** Minimum acceptable amount in base units, as a decimal string. */
  requiredBaseUnits: string;
  /** The same amount in whole units, as configured. */
  amountDisplay: string;
  minConfirmations: number;
  maxAgeMs: number;
  explorerUrl: string | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Builds a configuration from the environment, or returns null when the deployment has not
 * been set up for crypto payments. Null is not an error: it is what lets the dashboard say
 * "payments are not enabled" instead of throwing on a page render.
 *
 * It is also how a **price disagreement** is handled. `CRYPTO_PAYMENT_AMOUNT` gates the chain and
 * `UNLIMITED_PRICE_USD_MICRO` advertises to the payer; nothing in the type system ties them
 * together, so raising one and forgetting the other would sell access at one price while
 * accepting another — silently, and in the direction that loses money. When they disagree the
 * whole rail goes dark instead. An operator sees "payments are not enabled", which is a visible
 * problem, rather than a working checkout at the old price, which is an invisible one.
 */
export function evmConfigFromEnv(): EvmConfig | null {
  const c = env.payments.crypto;
  const network = EVM_NETWORKS[c.network.trim().toLowerCase()];
  if (!network) return null;
  if (!ADDRESS.test(c.address)) return null;

  const token = c.tokenAddress.trim() || network.nativeUsdc || "";
  if (!ADDRESS.test(token)) return null;

  let requiredBaseUnits: string;
  try {
    requiredBaseUnits = toBaseUnits(c.amount, c.assetDecimals);
    // Both sides converted to the same integer unit before comparison — never a float, and
    // never a comparison of the decimal strings, which would make "0.5" and "0.50" differ.
    if (requiredBaseUnits !== microUsdToBaseUnits(UNLIMITED_PRICE_USD_MICRO, c.assetDecimals)) {
      return null;
    }
  } catch {
    // A malformed price must not be silently rounded into a live payment gate.
    return null;
  }

  return {
    network,
    rpcUrl: c.rpcUrl.trim() || network.defaultRpcUrl,
    tokenAddress: token.toLowerCase(),
    assetSymbol: c.asset.trim() || "USDC",
    assetDecimals: c.assetDecimals,
    recipient: c.address.toLowerCase(),
    requiredBaseUnits,
    amountDisplay: c.amount.trim(),
    minConfirmations: Math.max(0, c.minConfirmations),
    maxAgeMs: Math.max(0, c.maxAgeHours) * 60 * 60 * 1000,
    explorerUrl: (c.explorerUrl.trim() || network.explorerUrl).replace(/\/$/, "") || null,
  };
}

// ── JSON-RPC plumbing ──────────────────────────────────────────────────────────────────────

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
}

interface RpcTransaction {
  blockNumber?: string | null;
  chainId?: string | null;
  from?: string;
  to?: string | null;
  value?: string;
}

interface RpcReceipt {
  status?: string;
  blockNumber?: string | null;
  logs?: RpcLog[];
}

let nextRpcId = 1;

/**
 * One JSON-RPC call.
 *
 * Every failure mode — transport, HTTP status, JSON-RPC error object — becomes a
 * `CryptoProviderError`, which the service treats as "could not check right now" rather than
 * "this payment is invalid". The node's own error text is attached as `cause` for the server
 * log and never reaches a response body.
 */
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    throw new CryptoProviderError(`RPC transport failure on ${method}.`, ADAPTER_ID, error);
  }

  if (!response.ok) {
    throw new CryptoProviderError(`RPC returned HTTP ${response.status} for ${method}.`, ADAPTER_ID);
  }

  let payload: { result?: T; error?: { message?: string } };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    throw new CryptoProviderError(`RPC returned non-JSON for ${method}.`, ADAPTER_ID, error);
  }

  if (payload.error) {
    throw new CryptoProviderError(
      `RPC error on ${method}: ${payload.error.message ?? "unknown"}`,
      ADAPTER_ID,
    );
  }
  return payload.result as T;
}

/** `"0x1a"` → `26n`. Returns 0n for null/undefined/malformed rather than throwing. */
function hexToBigInt(value: string | null | undefined): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value) || value === "0x") return 0n;
  return BigInt(value);
}

/** A 32-byte address topic → a lowercase `0x…40` address. */
function topicToAddress(topic: string | undefined): string | null {
  if (typeof topic !== "string" || topic.length !== 66) return null;
  return `0x${topic.slice(26).toLowerCase()}`;
}

// ── The adapter ────────────────────────────────────────────────────────────────────────────

export function createEvmProvider(config: EvmConfig): CryptoPaymentProvider {
  const instructions: PaymentInstructions = {
    network: config.network.slug,
    networkLabel: config.network.label,
    chainId: config.network.chainId,
    asset: config.assetSymbol,
    assetAddress: config.tokenAddress,
    assetDecimals: config.assetDecimals,
    address: config.recipient,
    amount: config.amountDisplay,
    amountBaseUnits: config.requiredBaseUnits,
    priceUsd: UNLIMITED_PRICE_USD_LABEL,
    minConfirmations: config.minConfirmations,
    explorerUrl: config.explorerUrl,
  };

  return {
    id: ADAPTER_ID,
    label: `${config.network.label} · ${config.assetSymbol}`,
    credentialEnvVars: [
      "CRYPTO_PAYMENT_NETWORK",
      "CRYPTO_PAYMENT_ASSET",
      "CRYPTO_PAYMENT_ADDRESS",
      "CRYPTO_PAYMENT_AMOUNT",
    ],
    isConfigured: () => true,
    getPaymentInstructions: () => instructions,
    normalizePayment: (baseUnits) => fromBaseUnits(baseUnits, config.assetDecimals),

    async verifyTransaction(txHash: string): Promise<ObservedTransaction> {
      const chainId = Number(hexToBigInt(await rpc<string>(config.rpcUrl, "eth_chainId", [])));

      const empty: ObservedTransaction = {
        txHash,
        found: false,
        chainId,
        txChainId: null,
        mined: false,
        succeeded: null,
        blockNumber: null,
        confirmations: 0,
        minedAt: null,
        receivedBaseUnits: "0",
        sender: null,
        assetMovedElsewhere: false,
        otherAssetReceived: false,
      };

      // A node serving a different chain cannot be reasoned about at all, so stop before
      // interpreting anything it returns.
      if (chainId !== config.network.chainId) return empty;

      const tx = await rpc<RpcTransaction | null>(config.rpcUrl, "eth_getTransactionByHash", [
        txHash,
      ]);
      if (!tx) return empty;

      const txChainId = tx.chainId ? Number(hexToBigInt(tx.chainId)) : null;
      const base = { ...empty, found: true, txChainId };

      // Still in the mempool: no block, no receipt, nothing to verify yet.
      if (!tx.blockNumber) return base;

      const receipt = await rpc<RpcReceipt | null>(config.rpcUrl, "eth_getTransactionReceipt", [
        txHash,
      ]);
      if (!receipt) return base;

      const blockNumber = hexToBigInt(tx.blockNumber);
      const head = hexToBigInt(await rpc<string>(config.rpcUrl, "eth_blockNumber", []));
      const confirmations = head >= blockNumber ? Number(head - blockNumber) + 1 : 0;
      const succeeded = receipt.status === "0x1";

      let minedAt: Date | null = null;
      try {
        const block = await rpc<{ timestamp?: string } | null>(
          config.rpcUrl,
          "eth_getBlockByNumber",
          [tx.blockNumber, false],
        );
        const seconds = hexToBigInt(block?.timestamp);
        if (seconds > 0n) minedAt = new Date(Number(seconds) * 1000);
      } catch {
        // The age check is a hardening measure, not a gate: if the block header cannot be read
        // the transaction is evaluated without it rather than failed on a transport hiccup.
      }

      const scan = scanTransferLogs(receipt.logs ?? [], config);

      // A plain native-coin send to the receiving address: not the configured asset, but money
      // did arrive, and the payer deserves the more specific message.
      const nativeToUs =
        (tx.to ?? "").toLowerCase() === config.recipient && hexToBigInt(tx.value) > 0n;

      return {
        ...base,
        mined: true,
        succeeded,
        blockNumber: blockNumber.toString(),
        confirmations,
        minedAt,
        receivedBaseUnits: scan.received.toString(),
        sender: scan.sender ?? (tx.from ? tx.from.toLowerCase() : null),
        assetMovedElsewhere: scan.assetMovedElsewhere,
        otherAssetReceived: scan.otherAssetReceived || nativeToUs,
      };
    },
  };
}

/**
 * Sums the configured asset's transfers into the configured recipient, and records what else
 * was seen so the rules layer can tell "wrong address" from "wrong token" apart.
 */
function scanTransferLogs(logs: RpcLog[], config: EvmConfig) {
  let received = 0n;
  let sender: string | null = null;
  let assetMovedElsewhere = false;
  let otherAssetReceived = false;

  for (const log of logs) {
    const topics = log.topics ?? [];
    if ((topics[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    const to = topicToAddress(topics[2]);
    if (to === null) continue;

    const isOurToken = (log.address ?? "").toLowerCase() === config.tokenAddress;
    const isOurAddress = to === config.recipient;

    if (isOurToken && isOurAddress) {
      received += hexToBigInt(log.data);
      sender ??= topicToAddress(topics[1]);
    } else if (isOurToken) {
      assetMovedElsewhere = true;
    } else if (isOurAddress) {
      otherAssetReceived = true;
    }
  }

  return { received, sender, assetMovedElsewhere, otherAssetReceived };
}

/** The adapter this deployment verifies with, or null when it is not configured. */
export function evmProviderFromEnv(): CryptoPaymentProvider | null {
  const config = evmConfigFromEnv();
  return config ? createEvmProvider(config) : null;
}

/** The expectation the rules layer compares an observation against. Configuration only. */
export function evmExpectation(config: EvmConfig) {
  return {
    chainId: config.network.chainId,
    recipient: config.recipient,
    requiredBaseUnits: config.requiredBaseUnits,
    minConfirmations: config.minConfirmations,
    maxAgeMs: config.maxAgeMs,
  };
}

