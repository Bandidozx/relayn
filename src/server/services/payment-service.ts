/**
 * Payment service — the *only* code path in this codebase that may set
 * `Subscription.unlimited = true`.
 *
 * Three entry points, with deliberately asymmetric trust:
 *
 *  - `startUnlimitedCheckout(userId)` takes no amount and no plan from anywhere but this
 *    module. `userId` comes from the verified session, never from a body.
 *  - `getPaymentForUser(userId, orderId)` is owner-scoped by query, not by post-hoc check, so
 *    another account's order id reads as "not found".
 *  - `applyVerifiedPayment(...)` is reached only after the provider adapter has authenticated
 *    the callback bytes. It re-checks everything the adapter cannot know about — which order,
 *    whose order, what amount — and gates the grant on a conditional UPDATE.
 *
 * Idempotency is structural rather than advisory. The activation write is
 * `updateMany({ where: { id, status: "pending" } })`; only the caller that observes
 * `count === 1` touches the subscription. A provider retrying the same callback three times
 * (TriPay retries at 2-minute intervals) therefore activates exactly once, and so does a
 * callback racing the reconcile poll. This works identically on SQLite and PostgreSQL because
 * it relies on row-level locking in a single statement, not on isolation level.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { recordAudit } from "@/lib/audit";
import { badRequest, conflict, notFound } from "@/lib/api/http";
import {
  PLANS,
  UNLIMITED_PLAN_ID,
  UNLIMITED_PRICE_IDR,
  UNLIMITED_TOKEN_ALLOCATION,
} from "@/lib/plans";
import { activePaymentProvider } from "@/lib/payments/registry";
import { evaluateCallback, type PaymentSnapshot } from "@/lib/payments/rules";
import { PaymentProviderError, type CallbackEvent } from "@/lib/payments/types";
import { qrisToPathOrNull, type QrPath } from "@/lib/payments/qr";
import { ensureSubscription } from "@/lib/usage/accounting";
import type { Payment } from "@/lib/db-types";

/** How long a pending order is reused before a fresh one is created. */
const ORDER_REUSE_WINDOW_MS = 20 * 60 * 1000;

/** Minimum gap between server-to-server status reads for the same order. */
const RECONCILE_INTERVAL_MS = 5_000;

const reconcileFloor = new Map<string, number>();

/** `RLY-<base36 ms>-<8 hex>`: sortable, unguessable, and short enough for `merchant_ref`. */
function newOrderId(): string {
  return `RLY-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/** What the browser is allowed to know about a payment. No provider internals. */
export interface PaymentView {
  orderId: string;
  status: string;
  plan: string;
  planName: string;
  amountIdr: number;
  paidAmountIdr: number | null;
  method: string;
  /** Raw EMVCo payload, for a client that would rather render its own QR. */
  qrString: string | null;
  /** Server-rendered QR geometry — see `src/lib/payments/qr.ts`. */
  qr: QrPath | null;
  checkoutUrl: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  /** True once the subscription has actually been flipped to unlimited. */
  applied: boolean;
  createdAt: string;
}

export function toPaymentView(payment: Payment): PaymentView {
  return {
    orderId: payment.orderId,
    status: payment.status,
    plan: payment.plan,
    planName: PLANS[UNLIMITED_PLAN_ID].name,
    amountIdr: payment.amount,
    paidAmountIdr: payment.paidAmount ?? null,
    method: payment.method,
    qrString: payment.qrString ?? null,
    qr: qrisToPathOrNull(payment.qrString),
    checkoutUrl: payment.checkoutUrl ?? null,
    expiresAt: payment.expiresAt?.toISOString() ?? null,
    paidAt: payment.paidAt?.toISOString() ?? null,
    applied: payment.appliedAt !== null,
    createdAt: payment.createdAt.toISOString(),
  };
}

/**
 * Starts (or resumes) the one-time unlimited purchase.
 *
 * `amount` and `plan` are read from the plan catalogue, never from the caller. The signature
 * has no place to put a client-supplied amount, which is the point.
 */
export async function startUnlimitedCheckout(
  userId: string,
  actor: { email: string; name: string },
  request: Request,
): Promise<PaymentView> {
  const subscription = await ensureSubscription(userId);
  if (subscription.unlimited) {
    throw conflict("This account already has permanent unlimited access.");
  }

  const provider = activePaymentProvider();
  if (!provider.isConfigured()) {
    throw badRequest(
      `Payments are not enabled on this deployment. The operator must set ${provider.credentialEnvVars.join(", ")}.`,
    );
  }

  // Resume rather than pile up orders: a payer who reloads the page twice should see the same
  // QR, and the provider should not accumulate abandoned transactions.
  const reusable = await prisma.payment.findFirst({
    where: {
      userId,
      provider: provider.id,
      status: "pending",
      amount: UNLIMITED_PRICE_IDR,
      qrString: { not: null },
      createdAt: { gte: new Date(Date.now() - ORDER_REUSE_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (reusable && (!reusable.expiresAt || reusable.expiresAt.getTime() > Date.now())) {
    return toPaymentView(reusable);
  }

  const orderId = newOrderId();
  const created = await prisma.payment.create({
    data: {
      userId,
      orderId,
      provider: provider.id,
      plan: UNLIMITED_PLAN_ID,
      // Server-decided. The single source is `UNLIMITED_PRICE_IDR`.
      amount: UNLIMITED_PRICE_IDR,
      method: env.payments.tripay.method || "QRIS",
      status: "pending",
    },
  });

  let charge;
  try {
    charge = await provider.createCharge({
      orderId,
      amountIdr: UNLIMITED_PRICE_IDR,
      itemName: `Relayn ${PLANS[UNLIMITED_PLAN_ID].name} — one-time`,
      customerName: actor.name || "Relayn user",
      customerEmail: actor.email,
      returnUrl: `${env.appUrl}/subscription?order=${encodeURIComponent(orderId)}`,
    });
  } catch (error) {
    // The row stays pending with no reference; it simply never becomes payable. Recording the
    // reason keeps the failure visible in support without exposing it to the payer.
    await prisma.payment.update({
      where: { id: created.id },
      data: {
        status: "failed",
        failureReason: error instanceof PaymentProviderError ? "provider_create_failed" : "create_failed",
      },
    });
    throw error instanceof PaymentProviderError
      ? badRequest(error.message)
      : badRequest("Could not start the payment. Try again in a moment.");
  }

  if (charge.amountIdr !== UNLIMITED_PRICE_IDR) {
    // The provider quoted a different order amount than we asked for. Refuse before showing
    // the payer a QR we would later reject at callback time.
    await prisma.payment.update({
      where: { id: created.id },
      data: { status: "failed", failureReason: "provider_amount_mismatch" },
    });
    throw badRequest("The payment provider quoted a different amount. Nothing was charged.");
  }

  const payment = await prisma.payment.update({
    where: { id: created.id },
    data: {
      reference: charge.reference,
      method: charge.method,
      qrString: charge.qrString,
      checkoutUrl: charge.checkoutUrl,
      expiresAt: charge.expiresAt,
    },
  });

  await recordAudit({
    action: "payment.created",
    userId,
    actorEmail: actor.email,
    targetType: "payment",
    targetId: payment.orderId,
    metadata: {
      provider: provider.id,
      amountIdr: payment.amount,
      plan: payment.plan,
      reference: payment.reference,
    },
    request,
  });

  return toPaymentView(payment);
}

/**
 * Owner-scoped read with a reconcile fallback.
 *
 * The fallback exists because a missed callback would otherwise leave a payer who has actually
 * paid staring at a pending QR forever. It reads status from the provider server-to-server and
 * funnels any `paid` result through the *same* `applyVerifiedPayment` gate as a callback — so
 * polling cannot activate on weaker evidence than a signed callback would need.
 */
export async function getPaymentForUser(
  userId: string,
  orderId: string,
  options: { reconcile?: boolean } = {},
): Promise<PaymentView> {
  // Scoped in the query: a foreign order id is indistinguishable from a missing one.
  let payment = await prisma.payment.findFirst({ where: { orderId, userId } });
  if (!payment) throw notFound("Payment not found.");

  if (options.reconcile !== false && payment.status === "pending" && payment.reference) {
    const floor = reconcileFloor.get(payment.orderId) ?? 0;
    if (Date.now() >= floor) {
      reconcileFloor.set(payment.orderId, Date.now() + RECONCILE_INTERVAL_MS);
      const provider = activePaymentProvider();
      const remote = await provider.fetchStatus(payment.reference).catch(() => null);
      if (remote && remote.status !== "pending") {
        await applyVerifiedPayment({
          providerId: provider.id,
          event: {
            orderId: payment.orderId,
            reference: remote.reference,
            status: remote.status,
            amountIdr: remote.amountIdr,
            grossAmountIdr: remote.amountIdr,
            paidAt: remote.paidAt,
            method: payment.method,
          },
          source: "reconcile",
        });
        payment = (await prisma.payment.findFirst({ where: { orderId, userId } })) ?? payment;
      }
    }
  }

  return toPaymentView(payment);
}

/**
 * The most recent **fiat** order for this user, for the subscription page. Never reconciles.
 *
 * Filtered to `currency: "IDR"` because `PaymentView` is a rupiah view — it reports `amountIdr`
 * and a QRIS payload. An on-chain row is denominated in micro-USD and has no QR, so surfacing
 * one here would render a crypto payment as a QRIS receipt showing "Rp 100.000". The crypto rail
 * has its own reader, `latestCryptoPaymentForUser`.
 */
export async function latestPaymentForUser(userId: string): Promise<PaymentView | null> {
  const payment = await prisma.payment.findFirst({
    where: { userId, currency: "IDR" },
    orderBy: { createdAt: "desc" },
  });
  return payment ? toPaymentView(payment) : null;
}

export interface ApplyResult {
  /** False only when the callback contradicted our records. */
  accepted: boolean;
  action: "activate" | "mark_failed" | "ignore" | "reject";
  reason: string;
  /** True when *this* call is the one that granted access. */
  activated: boolean;
}

/**
 * Acts on an authenticated callback (or an equivalent server-to-server status read).
 *
 * Assumes the caller has already verified provider authenticity. Everything else — which
 * order, whose order, which reference, what amount, which status — is re-derived from our own
 * row here, so a valid signature over a payload naming someone else's order still grants
 * nothing.
 */
export async function applyVerifiedPayment(input: {
  providerId: string;
  event: CallbackEvent;
  source: "callback" | "reconcile";
  request?: Request;
}): Promise<ApplyResult> {
  const { providerId, event, source, request } = input;

  const payment = await prisma.payment.findUnique({ where: { orderId: event.orderId } });
  const snapshot: PaymentSnapshot | null = payment
    ? {
        orderId: payment.orderId,
        provider: payment.provider,
        reference: payment.reference,
        amount: payment.amount,
        status: payment.status,
      }
    : null;

  const decision = evaluateCallback({ payment: snapshot, event, providerId });

  if (decision.action === "reject") {
    await recordAudit({
      action: "payment.rejected",
      userId: payment?.userId ?? null,
      targetType: "payment",
      targetId: event.orderId.slice(0, 120),
      // Provider-attested figures only. The raw body is never persisted or logged.
      metadata: {
        reason: decision.reason,
        source,
        provider: providerId,
        reportedStatus: event.status,
        reportedAmountIdr: event.amountIdr,
        expectedAmountIdr: payment?.amount ?? null,
      },
      request,
    });
    if (payment && payment.status === "pending") {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { failureReason: decision.reason },
      });
    }
    return { accepted: false, action: "reject", reason: decision.reason, activated: false };
  }

  if (decision.action === "ignore") {
    return { accepted: true, action: "ignore", reason: decision.reason, activated: false };
  }

  // Narrowed by `evaluateCallback`: only a found, pending, provider-matching row reaches here.
  if (!payment) {
    return { accepted: true, action: "ignore", reason: "row_vanished", activated: false };
  }

  if (decision.action === "mark_failed") {
    const marked = await prisma.payment.updateMany({
      where: { id: payment.id, status: "pending" },
      data: {
        status: event.status,
        failureReason: decision.reason,
        paidAmount: event.grossAmountIdr,
      },
    });
    if (marked.count === 1) {
      await recordAudit({
        action: "payment.failed",
        userId: payment.userId,
        targetType: "payment",
        targetId: payment.orderId,
        metadata: { reason: decision.reason, source, provider: providerId },
        request,
      });
    }
    return { accepted: true, action: "mark_failed", reason: decision.reason, activated: false };
  }

  // ---- activate ----------------------------------------------------------------------
  const paidAt = event.paidAt ?? new Date();

  const activated = await prisma.$transaction(async (tx) => {
    // The gate. `status: "pending"` in the WHERE clause is what makes a replayed callback a
    // no-op: the second caller sees count 0 and returns without touching the subscription.
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: "pending" },
      data: {
        status: "paid",
        paidAmount: event.grossAmountIdr,
        paidAt,
        reference: event.reference,
        method: event.method ?? payment.method,
        failureReason: null,
      },
    });
    if (claimed.count !== 1) return false;

    await tx.subscription.upsert({
      where: { userId: payment.userId },
      update: {
        plan: UNLIMITED_PLAN_ID,
        status: "active",
        unlimited: true,
        tokenAllocation: UNLIMITED_TOKEN_ALLOCATION,
        // Permanent by construction: no expiry date exists to lapse.
        planExpiresAt: null,
      },
      create: {
        userId: payment.userId,
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

    await tx.payment.update({
      where: { id: payment.id },
      data: { appliedAt: new Date() },
    });

    return true;
  });

  if (!activated) {
    return { accepted: true, action: "ignore", reason: "already_applied", activated: false };
  }

  await recordAudit({
    action: "payment.verified",
    userId: payment.userId,
    targetType: "payment",
    targetId: payment.orderId,
    metadata: {
      source,
      provider: providerId,
      amountIdr: event.amountIdr,
      grossAmountIdr: event.grossAmountIdr,
      reference: event.reference,
    },
    request,
  });
  await recordAudit({
    action: "payment.activated",
    userId: payment.userId,
    targetType: "subscription",
    targetId: payment.userId,
    metadata: { plan: UNLIMITED_PLAN_ID, permanent: true, orderId: payment.orderId },
    request,
  });

  return { accepted: true, action: "activate", reason: decision.reason, activated: true };
}

/** Test-only: the reconcile throttle is process-local state. */
export function __resetReconcileThrottle(): void {
  reconcileFloor.clear();
}
