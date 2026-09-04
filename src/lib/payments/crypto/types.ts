/**
 * Crypto payment provider contract.
 *
 * A deliberately *separate* seam from `src/lib/payments/types.ts`. The fiat contract is built
 * around a provider that pushes a signed callback at us; there is nobody to push a callback
 * here — the chain has no idea Relayn exists. So the shapes differ in the one way that
 * matters: `verifyTransaction` is a **pull**, initiated by us, against a node we chose.
 *
 * Three rules are in the signatures rather than left to convention:
 *
 *  1. `verifyTransaction` takes a transaction hash and *nothing else*. There is no parameter
 *     for an amount, a recipient, a sender, a network, an asset, a status, or a user id, so
 *     there is no code path by which any of those can arrive from a request body. Everything
 *     in `ObservedTransaction` is what the node said.
 *  2. It returns an observation, not a verdict. Deciding whether an observation is *good
 *     enough* belongs to `crypto-rules.ts`, which is pure and therefore testable against
 *     every rejection case without a node.
 *  3. `getPaymentInstructions()` returns only public values. There is no field for a private
 *     key because Relayn never has one: it reads the chain and never spends.
 */
import "server-only";

/** What the payer needs in order to pay. Every field is safe to render in a browser. */
export interface PaymentInstructions {
  /** Chain slug, e.g. "base". */
  network: string;
  /** Human label for the chain, e.g. "Base". */
  networkLabel: string;
  /** EIP-155 chain id the transaction must belong to. */
  chainId: number;
  /** Asset symbol, e.g. "USDC". */
  asset: string;
  /** ERC-20 contract address of the asset. Public information. */
  assetAddress: string;
  assetDecimals: number;
  /** Public receiving address. Relayn holds no key for it. */
  address: string;
  /** Exact minimum, in whole units, as a decimal string: "0.10". */
  amount: string;
  /** The same minimum in the asset's smallest unit, as a decimal string: "100000". */
  amountBaseUnits: string;
  /** What the payment is priced at, for display alongside the crypto amount. */
  priceUsd: string;
  minConfirmations: number;
  /** Read-only explorer root, for a "view transaction" link. Null when not configured. */
  explorerUrl: string | null;
}

/**
 * A transaction as the node described it. Nothing here is client-supplied, and nothing here
 * is a judgement — `found: false` is an observation too.
 */
export interface ObservedTransaction {
  /** Normalised (lowercase) hash that was looked up. */
  txHash: string;
  /** False when the node has never heard of this hash. */
  found: boolean;
  /** Chain the node itself is serving, so a misconfigured RPC URL is detectable. */
  chainId: number;
  /** The transaction's own chain id when the node reports one (typed transactions). */
  txChainId: number | null;
  /** True once the transaction is in a block. False means "still in the mempool". */
  mined: boolean;
  /** False when the transaction was mined but reverted. Null while unmined. */
  succeeded: boolean | null;
  blockNumber: string | null;
  /** Blocks on top of the transaction's own, inclusive. 0 while unmined. */
  confirmations: number;
  /** Block timestamp in ms, when it could be read. */
  minedAt: Date | null;
  /**
   * Total amount of the configured asset that reached the configured recipient in this
   * transaction, in base units. "0" when nothing did. Summed across logs, because one
   * transaction may contain several transfers.
   */
  receivedBaseUnits: string;
  /** Payer address from the matching transfer event, lowercased. Null when there was none. */
  sender: string | null;
  /** True when the configured asset moved in this transaction but *not* to our address. */
  assetMovedElsewhere: boolean;
  /** True when something other than the configured asset reached our address. */
  otherAssetReceived: boolean;
}

export interface CryptoPaymentProvider {
  /** Registry id of the adapter family, e.g. "evm-erc20". Not the chain. */
  readonly id: string;
  readonly label: string;
  /** Env vars an operator must set. Names only — values never leave this process. */
  readonly credentialEnvVars: readonly string[];
  isConfigured(): boolean;
  /** Public payment details. Throws only when the deployment is misconfigured. */
  getPaymentInstructions(): PaymentInstructions;
  /**
   * Reads one transaction from the chain. Throws `CryptoProviderError` when the node could
   * not be reached — which is distinct from "the node says this hash does not exist", and is
   * handled differently: an unreachable node must never mark a payment permanently failed.
   */
  verifyTransaction(txHash: string): Promise<ObservedTransaction>;
  /**
   * Formats a base-unit amount as whole units of the asset, for display and audit metadata.
   * Exact string arithmetic; no floating point anywhere in the path.
   */
  normalizePayment(baseUnits: string): string;
}

export class CryptoProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CryptoProviderError";
  }
}
