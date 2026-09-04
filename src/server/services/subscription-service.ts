/**
 * Subscription + plan changes.
 *
 * Two kinds of plan exist here and they are reached in completely different ways:
 *
 *  - `free`/`pro`/`business` are self-serve and switch immediately (no recurring processor is
 *    integrated; `Subscription.externalRef` is the seam for one). `enterprise` is arranged by
 *    hand.
 *  - `unlimited` is a one-time purchase and is **not reachable from this module at all**. It is
 *    absent from `SELF_SERVE_PLAN_ORDER`, so `changePlanSchema` rejects it before any service
 *    code runs, and `changePlan` refuses it again below. The only write paths are
 *    `applyVerifiedPayment` (behind a signature-verified provider callback) and
 *    `submitTransactionHash` (behind a chain-verified transfer).
 *
 * Two purchase rails are surfaced, and the page picks one: `cryptoOffer` when the deployment has
 * `CRYPTO_PAYMENT_*` set, `unlimitedOffer` (QRIS) otherwise. Both are computed because whether a
 * rail is configured is a server fact the page should not have to re-derive, and each reads its
 * own most recent payment row so a receipt from one rail can never be rendered as the other's.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { badRequest, conflict } from "@/lib/api/http";
import {
  PLANS,
  PLAN_ORDER,
  UNLIMITED_PLAN_ID,
  UNLIMITED_PRICE_IDR,
  UNLIMITED_PRICE_USD_LABEL,
  isPlanId,
  isUnlimitedPlan,
  planOf,
  type Plan,
} from "@/lib/plans";
import { paymentsConfigured } from "@/lib/payments/registry";
import { cryptoPaymentsConfigured } from "@/lib/payments/crypto/registry";
import { latestPaymentForUser, type PaymentView } from "@/server/services/payment-service";
import { getCryptoOffer, type CryptoOffer } from "@/server/services/crypto-payment-service";
import { ensureSubscription, quotaFrom } from "@/lib/usage/accounting";

export interface SubscriptionView {
  plan: string;
  planName: string;
  status: string;
  allocation: number;
  used: number;
  remaining: number;
  percentUsed: number;
  renewalDate: string;
  requestsPerMinute: number;
  maxApiKeys: number | null;
  createdAt: string;
  /** Always false in this build — documented so the UI never implies recurring billing exists. */
  billingConnected: boolean;
  /** No token ceiling applies. Mirrors `QuotaStatus.unlimited` (the database column). */
  unlimited: boolean;
  /**
   * Unlimited *and* with no expiry date — the only shape a paid unlimited account may have.
   * The UI reads this rather than comparing dates, so "permanent" has one definition.
   */
  permanent: boolean;
  /** Null for a permanent plan. Present only if a future dated plan is ever introduced. */
  planExpiresAt: string | null;
}

export interface UnlimitedOffer {
  plan: Plan;
  priceIdr: number;
  /** False when the operator has not set the provider credentials yet. */
  available: boolean;
  /** The caller's most recent order, so the page can resume or report it. */
  latestPayment: PaymentView | null;
}

export interface SubscriptionPayload {
  subscription: SubscriptionView;
  /**
   * Cards for `PlanPicker`: every metered plan, including `enterprise` (which renders as
   * "Contact sales"). Excludes `unlimited`, which is bought once and has its own component —
   * putting it in this grid would make a purchase look like a plan switch.
   */
  plans: Plan[];
  /** The one-time purchase over QRIS, presented separately because it is not a plan switch. */
  unlimitedOffer: UnlimitedOffer;
  /** The same purchase over the on-chain rail. */
  cryptoOffer: CryptoOffer;
  /**
   * Which rail the page should render. Crypto wins when both are configured because it is the
   * rail that is actually live; QRIS is paused. Falls back to `"crypto"` when neither is set up,
   * so the page shows the on-chain card in its "not enabled" state and names the missing
   * variables rather than showing nothing at all.
   */
  purchaseRail: "crypto" | "qris";
  spendMicroUsdThisMonth: number;
  activeKeys: number;
}

export async function getSubscription(userId: string): Promise<SubscriptionPayload> {
  const subscription = await ensureSubscription(userId);
  const quota = quotaFrom(subscription);
  const plan = planOf(subscription.plan);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [spend, activeKeys, latestPayment, cryptoOffer] = await Promise.all([
    prisma.usageLog.aggregate({
      where: { userId, createdAt: { gte: monthStart } },
      _sum: { costMicroUsd: true },
    }),
    prisma.apiKey.count({ where: { userId, status: "active" } }),
    latestPaymentForUser(userId),
    getCryptoOffer(userId),
  ]);

  const cryptoReady = cryptoPaymentsConfigured();

  return {
    subscription: {
      plan: subscription.plan,
      planName: plan.name,
      status: subscription.status,
      allocation: quota.allocation,
      used: quota.used,
      remaining: quota.remaining,
      percentUsed: quota.percentUsed,
      renewalDate: quota.renewalDate.toISOString(),
      requestsPerMinute: plan.requestsPerMinute,
      maxApiKeys: plan.maxApiKeys,
      createdAt: subscription.createdAt.toISOString(),
      billingConnected: subscription.externalRef !== null,
      unlimited: quota.unlimited,
      permanent: quota.unlimited && subscription.planExpiresAt === null,
      planExpiresAt: subscription.planExpiresAt?.toISOString() ?? null,
    },
    plans: PLAN_ORDER.filter((id) => !PLANS[id].oneTime).map((id) => PLANS[id]),
    unlimitedOffer: {
      plan: PLANS[UNLIMITED_PLAN_ID],
      priceIdr: UNLIMITED_PRICE_IDR,
      available: paymentsConfigured(),
      latestPayment,
    },
    cryptoOffer,
    purchaseRail: cryptoReady || !paymentsConfigured() ? "crypto" : "qris",
    spendMicroUsdThisMonth: spend._sum.costMicroUsd ?? 0,
    activeKeys,
  };
}

export async function changePlan(
  userId: string,
  nextPlan: string,
  request: Request,
  actorEmail: string,
): Promise<SubscriptionPayload> {
  if (!isPlanId(nextPlan)) throw badRequest("Unknown plan.");
  const target = PLANS[nextPlan];

  // Second layer behind `changePlanSchema`. Kept even though the schema already rejects it:
  // the schema is one edit away from being widened, this is the invariant.
  if (isUnlimitedPlan(nextPlan)) {
    throw badRequest(
      `${target.name} is a one-time purchase, not a plan switch. Complete the ${UNLIMITED_PRICE_USD_LABEL} payment to activate it.`,
    );
  }
  if (!target.selfServe) {
    throw badRequest("Enterprise plans are arranged with our team — open a support ticket.");
  }

  const current = await ensureSubscription(userId);

  // A paid account keeps what it paid for. Nothing self-serve may take it away — the user's
  // rule is that unlimited never silently reverts to Free.
  if (current.unlimited) {
    throw conflict(
      "This account has permanent unlimited access. Contact support if you need it changed.",
    );
  }

  if (current.plan === nextPlan) throw badRequest(`You are already on ${target.name}.`);

  await prisma.subscription.update({
    where: { userId },
    data: {
      plan: target.id,
      tokenAllocation: target.tokenAllocation,
      status: "active",
      // Usage carries over: switching plans mid-cycle must not wipe recorded consumption.
    },
  });

  await recordAudit({
    action: "subscription.plan_changed",
    userId,
    actorEmail,
    targetType: "subscription",
    targetId: current.id,
    metadata: { from: current.plan, to: target.id },
    request,
  });

  return getSubscription(userId);
}
