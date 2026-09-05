/**
 * Subscription state and the one-time purchase offers.
 *
 * There is exactly **one** way an account's plan changes by the account holder's own action: a
 * verified payment for `unlimited`. This module is read-only with respect to `Subscription.plan` —
 * it deliberately exports no mutator. The write paths are `applyVerifiedPayment` (behind a
 * signature-verified provider callback), `submitTransactionHash` (behind a chain-verified
 * transfer), and the operator tool in `admin-service.ts` (which cannot assign `unlimited`).
 *
 * The metered tiers (`pro`/`business`/`enterprise`) are not sold: no recurring processor is
 * integrated, `Subscription.externalRef` is the seam for one, and `billingConnected` stays false
 * until it exists. An account sits on `free` until it pays, and on `unlimited` afterwards.
 *
 * Two purchase rails are surfaced, and the page picks one: `cryptoOffer` when the deployment has
 * `CRYPTO_PAYMENT_*` set, `unlimitedOffer` (QRIS) otherwise. Both are computed because whether a
 * rail is configured is a server fact the page should not have to re-derive, and each reads its
 * own most recent payment row so a receipt from one rail can never be rendered as the other's.
 */
import "server-only";
import { prisma } from "@/lib/db";
import {
  PLANS,
  UNLIMITED_PLAN_ID,
  UNLIMITED_PRICE_IDR,
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

/*
 * No `changePlan` export, by design.
 *
 * It used to back `PATCH /api/subscription` for the Free/Pro/Business picker. The picker is gone —
 * `unlimited` at $0.10 is the only thing on offer — and a mutator with no UI behind it is just a
 * free-upgrade endpoint waiting to be called directly with curl. Removing the function removes the
 * capability rather than guarding it, which is the stronger of the two.
 *
 * If a plan ladder is ever reintroduced it needs a processor first, and the write must go through
 * the same verified-payment path `applyVerifiedPayment` and `submitTransactionHash` already use.
 */
