/**
 * Crypto payment decision logic — pure, synchronous, unit-tested.
 *
 * Every rule the payment gate enforces lives here, taking an observation of the chain and an
 * expectation derived from server configuration, and returning a verdict. Nothing in this file
 * touches Prisma, the network, or a Request, which is what makes the whole rejection matrix
 * assertable in a unit test rather than only against a live chain.
 *
 * The three actions are not interchangeable, and the distinction is a correctness property:
 *
 *   - `reject` is **terminal**. The transaction can never become valid — wrong address, wrong
 *     asset, reverted, short amount. The row is marked failed and the hash stays claimed.
 *   - `wait` is **retryable**. The transaction may yet become valid: it is still in the
 *     mempool, or short of confirmations, or the node simply has not seen it. Crucially, a
 *     node that has never heard of a hash returns `wait`, never `reject` — a lagging or
 *     load-balanced RPC endpoint must not be able to permanently burn a real payment.
 *   - `activate` grants permanent unlimited access, and is reached only after every other
 *     branch has been ruled out.
 *
 * `message` is what the payer sees; `reason` is the stable machine string that lands in the
 * audit log and in `Payment.failureReason`. Neither carries an RPC URL, a node response, or
 * any other internal detail.
 */
import { parseBaseUnits } from "@/lib/payments/crypto/amount";
import type { ObservedTransaction } from "@/lib/payments/crypto/types";

export type CryptoAction = "activate" | "wait" | "reject";

/** Payer-facing strings. Fixed vocabulary: nothing is interpolated into them. */
export const CRYPTO_MESSAGES = {
  unverifiable: "Transaction could not be verified.",
  wrongNetwork: "Transaction is on the wrong network.",
  wrongRecipient: "Payment was sent to the wrong address.",
  wrongAsset: "Payment was not made in the expected asset.",
  insufficient: "Payment amount is insufficient.",
  alreadyUsed: "This transaction has already been used.",
  notConfirmed: "Transaction is not confirmed yet.",
  tooOld: "Transaction is older than the accepted payment window.",
  confirmed: "Payment confirmed.",
} as const;

export interface CryptoDecision {
  action: CryptoAction;
  /** Stable, safe to persist and to log. Never a node response or a URL. */
  reason: string;
  /** Exactly one of `CRYPTO_MESSAGES`. Safe to show a payer. */
  message: string;
}

/** What the server demands, all of it read from configuration, none of it from a request. */
export interface CryptoExpectation {
  chainId: number;
  /** Lowercased receiving address. */
  recipient: string;
  /** Minimum acceptable amount in the asset's base units, as a decimal string. */
  requiredBaseUnits: string;
  minConfirmations: number;
  /** Oldest transaction still claimable, in ms. 0 disables the check. */
  maxAgeMs: number;
}

export function evaluateCryptoTransaction(input: {
  observed: ObservedTransaction;
  expected: CryptoExpectation;
  now?: Date;
}): CryptoDecision {
  const { observed, expected } = input;
  const now = input.now ?? new Date();

  // The node is not serving the chain we were configured for. This is an operator error, not a
  // payer error, so the payer gets the generic string while the audit log gets the real reason.
  if (observed.chainId !== expected.chainId) {
    return reject("rpc_chain_mismatch", CRYPTO_MESSAGES.unverifiable);
  }

  // Retryable on purpose. A hash the node has not indexed yet is indistinguishable from a hash
  // that does not exist, and treating the two the same way in the *safe* direction costs the
  // payer a retry while the alternative would cost them the payment.
  if (!observed.found) {
    return wait("not_found", CRYPTO_MESSAGES.unverifiable);
  }

  if (observed.txChainId !== null && observed.txChainId !== expected.chainId) {
    return reject("wrong_network", CRYPTO_MESSAGES.wrongNetwork);
  }

  if (!observed.mined) {
    return wait("unmined", CRYPTO_MESSAGES.notConfirmed);
  }

  if (observed.succeeded === false) {
    // A reverted transfer moved nothing. Terminal: re-reading it will never say otherwise.
    return reject("reverted", CRYPTO_MESSAGES.unverifiable);
  }

  if (observed.confirmations < expected.minConfirmations) {
    return wait("unconfirmed", CRYPTO_MESSAGES.notConfirmed);
  }

  const received = parseBaseUnits(observed.receivedBaseUnits);
  if (received === 0n) {
    // Nothing of the configured asset reached the configured address. Which of the two went
    // wrong decides the message, because the payer's next action differs.
    if (observed.otherAssetReceived) {
      return reject("wrong_asset", CRYPTO_MESSAGES.wrongAsset);
    }
    return reject("wrong_recipient", CRYPTO_MESSAGES.wrongRecipient);
  }

  if (received < parseBaseUnits(expected.requiredBaseUnits)) {
    return reject("insufficient_amount", CRYPTO_MESSAGES.insufficient);
  }

  // Last, so a payer who made a genuine mistake gets the specific message first. An otherwise
  // perfect but stale transfer is what this catches: without it, any historical transfer to the
  // receiving address is claimable by whoever finds it in the explorer.
  if (expected.maxAgeMs > 0 && observed.minedAt !== null) {
    if (now.getTime() - observed.minedAt.getTime() > expected.maxAgeMs) {
      return reject("too_old", CRYPTO_MESSAGES.tooOld);
    }
  }

  return { action: "activate", reason: "paid", message: CRYPTO_MESSAGES.confirmed };
}

function reject(reason: string, message: string): CryptoDecision {
  return { action: "reject", reason, message };
}

function wait(reason: string, message: string): CryptoDecision {
  return { action: "wait", reason, message };
}

/**
 * The payer-facing string for a reason that was persisted earlier.
 *
 * A terminal row is never re-verified — `too_old` will not become fresh, a revert will not
 * un-revert — so when a payer resubmits a hash we already refused, the message has to be
 * reconstructed from the stored `failureReason` rather than from a new chain read. Anything
 * unrecognised falls back to the generic string, so a reason added later can never leak as a
 * raw machine token into the UI.
 */
export function cryptoMessageForReason(reason: string | null | undefined): string {
  switch (reason) {
    case "wrong_network":
      return CRYPTO_MESSAGES.wrongNetwork;
    case "wrong_recipient":
      return CRYPTO_MESSAGES.wrongRecipient;
    case "wrong_asset":
      return CRYPTO_MESSAGES.wrongAsset;
    case "insufficient_amount":
      return CRYPTO_MESSAGES.insufficient;
    case "too_old":
      return CRYPTO_MESSAGES.tooOld;
    case "unmined":
    case "unconfirmed":
      return CRYPTO_MESSAGES.notConfirmed;
    case "tx_claimed_by_other":
      return CRYPTO_MESSAGES.alreadyUsed;
    default:
      return CRYPTO_MESSAGES.unverifiable;
  }
}

/** True when a reason can never resolve on a retry, and the row should be marked failed. */
export function isTerminalCryptoReason(reason: string): boolean {
  return (
    reason === "wrong_network" ||
    reason === "reverted" ||
    reason === "wrong_asset" ||
    reason === "wrong_recipient" ||
    reason === "insufficient_amount" ||
    reason === "too_old" ||
    reason === "rpc_chain_mismatch"
  );
}
