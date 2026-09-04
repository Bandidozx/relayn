/**
 * Crypto payment service — the second (and only other) code path that may set
 * `Subscription.unlimited = true`.
 *
 * The trust model is the whole point of this file, so it is worth stating plainly: the *only*
 * thing that crosses the boundary from the browser is a 32-byte transaction hash. It is an
 * identifier, not evidence. Every fact the activation decision depends on — which chain, which
 * token contract, which recipient, how much, how many confirmations, whether the transaction
 * even succeeded — is read back from a JSON-RPC node inside `verifyTransaction`, and the amount
 * it is compared against comes from server configuration. There is deliberately no parameter,
 * anywhere in this module's public surface, into which a client could put an amount, a
 * recipient, a sender, a status, a network, an asset, a plan or another user's id.
 *
 * Double-spend defence is structural, in two layers that fail in the safe direction:
 *
 *  1. `Payment.txHash` is UNIQUE. Two accounts submitting the same hash race on the database
 *     constraint; the loser gets P2002 and is told the transaction is already used. This holds
 *     across processes and serverless instances, which no in-memory guard would.
 *  2. Activation is gated on `updateMany({ where: { id, status: "pending" } })` inside a
 *     transaction — the same gate the fiat rail uses. Only the caller that observes
 *     `count === 1` touches the subscription, so a payer double-clicking "Verify Payment"
 *     activates exactly once.
 *
 * The hash is claimed *before* the chain is read, not after. That ordering matters: reading
 * first and inserting afterwards leaves a window in which two requests both see a free hash and
 * both proceed to verify, and while the UNIQUE index would still stop the second insert, the
 * work would already have been done twice against the node. Claiming first also means a hash
 * that turns out to be someone else's cannot be probed repeatedly for free.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { badRequest, conflict } from "@/lib/api/http";
import {
  PLANS,
  UNLIMITED_PLAN_ID,
  UNLIMITED_PRICE_USD_LABEL,
  UNLIMITED_PRICE_USD_MICRO,
  UNLIMITED_TOKEN_ALLOCATION,
  type Plan,
} from "@/lib/plans";
import { normalizeTxHash } from "@/lib/payments/crypto/amount";
import { activeCrypto } from "@/lib/payments/crypto/registry";
import {
  CRYPTO_MESSAGES,
  cryptoMessageForReason,
  evaluateCryptoTransaction,
  isTerminalCryptoReason,
  type CryptoExpectation,
} from "@/lib/payments/crypto/rules";
import {
  CryptoProviderError,
  type CryptoPaymentProvider,
  type ObservedTransaction,
  type PaymentInstructions,
} from "@/lib/payments/crypto/types";
import { ensureSubscription } from "@/lib/usage/accounting";
import type { Payment } from "@/lib/db-types";

/**
 * Value of `Payment.provider` for every on-chain row.
 *
 * A rail identifier, not an adapter identifier: the adapter (`evm-erc20`) goes in `method`.
 * Keeping the rail in one column is what lets the subscription page ask for "the latest crypto
 * payment" and "the latest QRIS payment" separately, instead of showing a payer a receipt from
 * the wrong rail.
 */
export const CRYPTO_PROVIDER = "crypto";

/** Unit that `Payment.amount` is denominated in on crypto rows. */
const CRYPTO_CURRENCY = "USD_MICRO";

/** `RLY-CRY-<base36 ms>-<8 hex>`. Distinguishable from a fiat order id at a glance. */
function newCryptoOrderId(): string {
  return `RLY-CRY-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * What the browser is allowed to know about an on-chain payment.
 *
 * Everything here is either the payer's own submitted hash, a figure read from the chain about
 * their own transaction, or public configuration. No RPC URL, no node response, no internal
 * error text: `failureReason` is one of the fixed machine strings from the rules layer.
 */
export interface CryptoPaymentView {
  orderId: string;
  /** "pending" | "paid" | "failed" */
  status: string;
  plan: string;
  planName: string;
  network: string | null;
  asset: string | null;
  txHash: string | null;
  /** Observed amount in whole units, e.g. "0.1". Null until a transfer has been seen. */
  amount: string | null;
  /** Amount that was required at verification time, whole units. */
  amountRequired: string | null;
  priceUsd: string;
  confirmations: number | null;
  blockNumber: string | null;
  sender: string | null;
  /** Public explorer link for the payer's own hash. Never a source of truth. */
  explorerTxUrl: string | null;
  verifiedAt: string | null;
  /** True once the subscription has actually been flipped to unlimited. */
  applied: boolean;
  /** Stable machine reason, safe to persist and to display. */
  failureReason: string | null;
  createdAt: string;
}

export function toCryptoView(payment: Payment, decimals?: number): CryptoPaymentView {
  const active = activeCrypto();
  const assetDecimals = decimals ?? active?.config.assetDecimals ?? 6;
  const explorer = active?.config.explorerUrl ?? null;
  return {
    orderId: payment.orderId,
    status: payment.status,
    plan: payment.plan,
    planName: PLANS[UNLIMITED_PLAN_ID].name,
    network: payment.network ?? null,
    asset: payment.asset ?? null,
    txHash: payment.txHash ?? null,
    amount: displayAmount(payment.amountRaw, assetDecimals),
    amountRequired: displayAmount(payment.amountRequired, assetDecimals),
    priceUsd: UNLIMITED_PRICE_USD_LABEL,
    confirmations: payment.confirmations ?? null,
    blockNumber: payment.blockNumber ?? null,
    sender: payment.sender ?? null,
    explorerTxUrl: explorer && payment.txHash ? `${explorer}/tx/${payment.txHash}` : null,
    verifiedAt: payment.verifiedAt?.toISOString() ?? null,
    applied: payment.appliedAt !== null,
    failureReason: payment.failureReason ?? null,
    createdAt: payment.createdAt.toISOString(),
  };
}

/**
 * Base units → whole units for display, tolerating a malformed stored value.
 *
 * A row written by an older adapter, or by hand during support, must not be able to throw while
 * rendering a page. Unreadable becomes null, which the UI shows as "—".
 */
function displayAmount(raw: string | null | undefined, decimals: number): string | null {
  if (!raw) return null;
  const active = activeCrypto();
  try {
    if (active && active.config.assetDecimals === decimals) return active.provider.normalizePayment(raw);
    if (!/^\d+$/.test(raw)) return null;
    const scale = 10n ** BigInt(decimals);
    const value = BigInt(raw);
    const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
    return fraction === "" ? (value / scale).toString() : `${value / scale}.${fraction}`;
  } catch {
    return null;
  }
}

/** The most recent on-chain order for this user. Scoped by query, never by post-hoc check. */
export async function latestCryptoPaymentForUser(userId: string): Promise<CryptoPaymentView | null> {
  const payment = await prisma.payment.findFirst({
    where: { userId, provider: CRYPTO_PROVIDER },
    orderBy: { createdAt: "desc" },
  });
  return payment ? toCryptoView(payment) : null;
}

export interface CryptoOffer {
  plan: Plan;
  priceUsd: string;
  priceUsdMicro: number;
  /** False when the deployment has no `CRYPTO_PAYMENT_*` configuration. */
  available: boolean;
  /** Public payment details. Null when unavailable. Contains no key of any kind. */
  instructions: PaymentInstructions | null;
  /** Named so an operator reading the dashboard knows what is missing. Names, never values. */
  missingEnvVars: readonly string[];
  latestPayment: CryptoPaymentView | null;
}

export async function getCryptoOffer(userId: string): Promise<CryptoOffer> {
  const active = activeCrypto();
  const latestPayment = await latestCryptoPaymentForUser(userId);
  return {
    plan: PLANS[UNLIMITED_PLAN_ID],
    priceUsd: UNLIMITED_PRICE_USD_LABEL,
    priceUsdMicro: UNLIMITED_PRICE_USD_MICRO,
    available: active !== null,
    instructions: active ? active.provider.getPaymentInstructions() : null,
    missingEnvVars: active
      ? []
      : ["CRYPTO_PAYMENT_NETWORK", "CRYPTO_PAYMENT_ASSET", "CRYPTO_PAYMENT_ADDRESS", "CRYPTO_PAYMENT_AMOUNT"],
    latestPayment,
  };
}

/** Outcome vocabulary the UI switches on. Deliberately smaller than the reason vocabulary. */
export type CryptoSubmitStatus = "confirmed" | "pending" | "rejected" | "already_used";

export interface CryptoSubmitResult {
  status: CryptoSubmitStatus;
  /** Exactly one of `CRYPTO_MESSAGES`. Safe to show a payer. */
  message: string;
  /** True only when *this* call granted access. */
  activated: boolean;
  payment: CryptoPaymentView | null;
}

/** True for a unique-constraint violation, checked structurally so no Prisma internals leak in. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Columns derived from a chain observation.
 *
 * Written on every outcome, not just on success: a payer who sent the right token to the wrong
 * address should be able to see, in support, exactly what the node reported.
 */
function observedColumns(observed: ObservedTransaction, expectation: CryptoExpectation) {
  return {
    sender: observed.sender,
    amountRaw: observed.receivedBaseUnits,
    amountRequired: expectation.requiredBaseUnits,
    confirmations: observed.confirmations,
    blockNumber: observed.blockNumber,
  };
}

/**
 * Verifies a pasted transaction hash and, if everything checks out, grants permanent unlimited
 * access.
 *
 * `userId` comes from the verified session at the route boundary. `rawTxHash` is the only value
 * that originates in the request body, and it is normalised and then used solely as a lookup key
 * against the chain. `deps` exists for unit tests — no route passes it, and it cannot be reached
 * from an HTTP request.
 */
export async function submitTransactionHash(input: {
  userId: string;
  rawTxHash: unknown;
  actorEmail?: string;
  request?: Request;
  deps?: { provider: CryptoPaymentProvider; expectation: CryptoExpectation };
  now?: Date;
}): Promise<CryptoSubmitResult> {
  const { userId, rawTxHash, actorEmail, request } = input;
  const now = input.now ?? new Date();

  const active = input.deps ?? activeCrypto();
  if (!active) {
    throw badRequest(
      "Crypto payments are not enabled on this deployment. The operator must set " +
        "CRYPTO_PAYMENT_NETWORK, CRYPTO_PAYMENT_ASSET, CRYPTO_PAYMENT_ADDRESS, CRYPTO_PAYMENT_AMOUNT.",
    );
  }
  const { provider, expectation } = active;

  // Lowercased here, which is what makes the UNIQUE index a real defence: `0xAB…` and `0xab…`
  // are one transaction, and a case-sensitive index would store both.
  const txHash = normalizeTxHash(rawTxHash);
  if (!txHash) {
    return { status: "rejected", message: CRYPTO_MESSAGES.unverifiable, activated: false, payment: null };
  }

  // A paid account must not be able to spend a second hash on access it already has.
  const subscription = await ensureSubscription(userId);
  if (subscription.unlimited) {
    throw conflict("This account already has permanent unlimited access.");
  }

  const claim = await claimTxHash({ userId, txHash, provider, expectation, request });
  if (claim.kind === "result") return claim.result;
  const payment = claim.payment;

  let observed: ObservedTransaction;
  try {
    observed = await provider.verifyTransaction(txHash);
  } catch (error) {
    // The node could not be reached, or answered with an error. That is emphatically not
    // evidence against the payment: the row stays pending and claimed, so the payer can retry
    // the same hash once the outage passes. No audit row is written because none of the audit
    // actions means "we could not look" — `payment.rejected` would misrepresent an outage as a
    // refusal. The reason is recorded on the row and the detail goes to the server log only.
    console.error(
      "[relayn] crypto verification unavailable:",
      error instanceof CryptoProviderError ? `${error.providerId}: ${error.message}` : error,
    );
    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { failureReason: "provider_unavailable" },
    });
    return {
      status: "pending",
      message: CRYPTO_MESSAGES.unverifiable,
      activated: false,
      payment: toCryptoView(updated, provider.getPaymentInstructions().assetDecimals),
    };
  }

  const decision = evaluateCryptoTransaction({ observed, expected: expectation, now });
  const columns = observedColumns(observed, expectation);
  const decimals = provider.getPaymentInstructions().assetDecimals;

  if (decision.action === "wait") {
    // Still claimed, still pending, still retryable with the same hash.
    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { ...columns, failureReason: decision.reason },
    });
    return {
      status: "pending",
      message: decision.message,
      activated: false,
      payment: toCryptoView(updated, decimals),
    };
  }

  if (decision.action === "reject") {
    // Conditional so a rejection cannot overwrite a row another request has already settled.
    // `isTerminalCryptoReason` decides whether the row is closed: a terminal reason can never
    // resolve on a retry, so the hash stays claimed and the row is marked failed.
    const terminal = isTerminalCryptoReason(decision.reason);
    await prisma.payment.updateMany({
      where: { id: payment.id, status: "pending" },
      data: {
        ...columns,
        status: terminal ? "failed" : "pending",
        failureReason: decision.reason,
      },
    });
    await recordAudit({
      action: "payment.rejected",
      userId,
      actorEmail,
      targetType: "payment",
      targetId: payment.orderId,
      // Chain-attested figures and configuration only. No RPC URL, no node response body.
      metadata: {
        reason: decision.reason,
        provider: CRYPTO_PROVIDER,
        adapter: provider.id,
        txHash,
        network: expectation.chainId,
        observedBaseUnits: observed.receivedBaseUnits,
        requiredBaseUnits: expectation.requiredBaseUnits,
        confirmations: observed.confirmations,
      },
      request,
    });
    const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
    return {
      status: "rejected",
      message: decision.message,
      activated: false,
      payment: updated ? toCryptoView(updated, decimals) : null,
    };
  }

  // ---- activate ------------------------------------------------------------------------
  const verifiedAt = new Date();

  const activated = await prisma.$transaction(async (tx) => {
    // The gate, identical in shape to the fiat rail's. Two concurrent verifications of the same
    // row — a double-clicked button, a retried request — both reach here; exactly one sees
    // count 1 and only that one touches the subscription.
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: "pending" },
      data: {
        ...columns,
        status: "paid",
        // Micro-USD, matching `amount`. The on-chain figure lives in `amountRaw`.
        paidAmount: UNLIMITED_PRICE_USD_MICRO,
        paidAt: observed.minedAt ?? verifiedAt,
        verifiedAt,
        failureReason: null,
      },
    });
    if (claimed.count !== 1) return false;

    await tx.subscription.upsert({
      where: { userId },
      update: {
        plan: UNLIMITED_PLAN_ID,
        status: "active",
        unlimited: true,
        tokenAllocation: UNLIMITED_TOKEN_ALLOCATION,
        // Permanent by construction: there is no expiry date left to lapse.
        planExpiresAt: null,
      },
      create: {
        userId,
        plan: UNLIMITED_PLAN_ID,
        status: "active",
        unlimited: true,
        tokenAllocation: UNLIMITED_TOKEN_ALLOCATION,
        tokensUsed: 0,
        planExpiresAt: null,
        // Carried only because the column is non-null. Never read for an unlimited account.
        renewalDate: new Date(),
      },
    });

    await tx.payment.update({ where: { id: payment.id }, data: { appliedAt: verifiedAt } });
    return true;
  });

  const settled = await prisma.payment.findUnique({ where: { id: payment.id } });
  const view = settled ? toCryptoView(settled, decimals) : null;

  if (!activated) {
    // Another request applied this row first. The payer's account is unlimited either way, so
    // this is reported as confirmed — just not as *this* call's activation.
    return { status: "confirmed", message: CRYPTO_MESSAGES.confirmed, activated: false, payment: view };
  }

  await recordAudit({
    action: "payment.verified",
    userId,
    actorEmail,
    targetType: "payment",
    targetId: payment.orderId,
    metadata: {
      provider: CRYPTO_PROVIDER,
      adapter: provider.id,
      network: payment.network,
      asset: payment.asset,
      txHash,
      blockNumber: observed.blockNumber,
      confirmations: observed.confirmations,
      sender: observed.sender,
      recipient: expectation.recipient,
      receivedBaseUnits: observed.receivedBaseUnits,
      requiredBaseUnits: expectation.requiredBaseUnits,
      priceUsdMicro: UNLIMITED_PRICE_USD_MICRO,
    },
    request,
  });
  await recordAudit({
    action: "payment.activated",
    userId,
    actorEmail,
    targetType: "subscription",
    targetId: userId,
    metadata: { plan: UNLIMITED_PLAN_ID, permanent: true, orderId: payment.orderId, txHash },
    request,
  });

  return { status: "confirmed", message: CRYPTO_MESSAGES.confirmed, activated: true, payment: view };
}

type Claim =
  /** A pending row owned by this user. Safe to verify against the chain. */
  | { kind: "row"; payment: Payment }
  /** The hash is spoken for, or already settled. Return this to the caller unchanged. */
  | { kind: "result"; result: CryptoSubmitResult };

/**
 * Takes ownership of a transaction hash, or explains why it cannot be taken.
 *
 * This is where "one hash activates at most one account" is actually enforced. The insert is
 * attempted unconditionally and the UNIQUE violation is the *expected* concurrent outcome, not
 * an error path bolted on afterwards — two simultaneous submissions of the same hash both reach
 * `create`, the database serialises them, and the loser re-reads the winner's row and is told the
 * transaction is already used.
 */
async function claimTxHash(input: {
  userId: string;
  txHash: string;
  provider: CryptoPaymentProvider;
  expectation: CryptoExpectation;
  request?: Request;
}): Promise<Claim> {
  const { userId, txHash, provider, expectation, request } = input;
  const instructions = provider.getPaymentInstructions();

  const existing = await prisma.payment.findUnique({ where: { txHash } });
  if (existing) return resolveExisting({ existing, userId, txHash, instructions, request });

  try {
    const created = await prisma.payment.create({
      data: {
        userId,
        orderId: newCryptoOrderId(),
        provider: CRYPTO_PROVIDER,
        method: provider.id,
        plan: UNLIMITED_PLAN_ID,
        // Server-decided, from the plan catalogue. Nothing here came from a request.
        amount: UNLIMITED_PRICE_USD_MICRO,
        currency: CRYPTO_CURRENCY,
        status: "pending",
        network: instructions.network,
        asset: instructions.asset,
        txHash,
        recipient: expectation.recipient,
        amountRequired: expectation.requiredBaseUnits,
      },
    });
    await recordAudit({
      action: "payment.created",
      userId,
      targetType: "payment",
      targetId: created.orderId,
      metadata: {
        provider: CRYPTO_PROVIDER,
        adapter: provider.id,
        network: instructions.network,
        asset: instructions.asset,
        txHash,
        requiredBaseUnits: expectation.requiredBaseUnits,
        priceUsdMicro: UNLIMITED_PRICE_USD_MICRO,
      },
      request,
    });
    return { kind: "row", payment: created };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost the race on the UNIQUE index. Whoever won owns the hash now.
    const winner = await prisma.payment.findUnique({ where: { txHash } });
    if (!winner) {
      return {
        kind: "result",
        result: {
          status: "rejected",
          message: CRYPTO_MESSAGES.unverifiable,
          activated: false,
          payment: null,
        },
      };
    }
    return resolveExisting({ existing: winner, userId, txHash, instructions, request });
  }
}

/**
 * Decides what an already-existing row for this hash means for *this* caller.
 *
 * The foreign-owner branch is the anti-double-spend rule the user specified: user A cannot use a
 * hash claimed by user B, and the response says nothing about who B is or what state their row is
 * in. It is deliberately the same answer whether B's row is pending, paid or failed — otherwise
 * the endpoint would leak which hashes are under verification by someone else.
 */
async function resolveExisting(input: {
  existing: Payment;
  userId: string;
  txHash: string;
  instructions: PaymentInstructions;
  request?: Request;
}): Promise<Claim> {
  const { existing, userId, txHash, instructions, request } = input;

  if (existing.userId !== userId) {
    await recordAudit({
      action: "payment.rejected",
      userId,
      targetType: "payment",
      targetId: txHash,
      // Note what is absent: the owning user id. The audit row records the attempt, not a
      // cross-reference an operator could mistake for a link between the two accounts.
      metadata: { reason: "tx_claimed_by_other", provider: CRYPTO_PROVIDER, txHash },
      request,
    });
    return {
      kind: "result",
      result: {
        status: "already_used",
        message: CRYPTO_MESSAGES.alreadyUsed,
        activated: false,
        payment: null,
      },
    };
  }

  const view = toCryptoView(existing, instructions.assetDecimals);

  // Own row, already settled one way or the other.
  if (existing.status === "paid") {
    return {
      kind: "result",
      result: {
        status: "confirmed",
        message: CRYPTO_MESSAGES.confirmed,
        activated: false,
        payment: view,
      },
    };
  }
  if (existing.status !== "pending") {
    // Terminal. Re-reading the chain would return the same verdict, so the stored reason is
    // translated back into its payer-facing string rather than a new RPC round trip being spent.
    return {
      kind: "result",
      result: {
        status: "rejected",
        message: cryptoMessageForReason(existing.failureReason),
        activated: false,
        payment: view,
      },
    };
  }

  // Own pending row: this is a retry. Verify it again.
  return { kind: "row", payment: existing };
}
