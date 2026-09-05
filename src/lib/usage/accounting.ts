/**
 * Token accounting. Every number the dashboard shows is derived from these functions,
 * which read `usage_logs` — there are no hardcoded metrics anywhere in the app.
 */
import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { nextRenewalDate, planOf } from "@/lib/plans";
import type { Subscription } from "@/lib/db-types";
import type { TokenUsage } from "@/lib/providers/types";

export interface BillableModel {
  modelId: string;
  provider: string;
  inputPrice: number;
  outputPrice: number;
}

/** Cost in integer micro-USD. Prices are per 1M tokens; integers avoid float drift. */
export function costMicroUsd(model: BillableModel, usage: TokenUsage): number {
  const input = (usage.inputTokens * model.inputPrice) / 1_000_000;
  const output = (usage.outputTokens * model.outputPrice) / 1_000_000;
  return Math.round((input + output) * 1_000_000);
}

/**
 * Returns the caller's subscription, creating one on first touch and rolling the
 * monthly window over when the renewal date has passed.
 *
 * A permanently unlimited subscription is returned untouched. It has no monthly window to
 * roll, and rolling one would zero `tokensUsed` — losing the lifetime total that is the only
 * usage figure such an account has. Nothing in this function may lower a plan: the sole
 * downgrade-shaped branch is the metered rollover, which unlimited now skips.
 */
export async function ensureSubscription(userId: string): Promise<Subscription> {
  const existing = await prisma.subscription.findUnique({ where: { userId } });

  if (!existing) {
    return prisma.subscription.create({
      data: {
        userId,
        plan: "free",
        status: "active",
        tokenAllocation: planOf("free").tokenAllocation,
        tokensUsed: 0,
        renewalDate: nextRenewalDate(),
      },
    });
  }

  if (existing.unlimited) return existing;

  if (existing.renewalDate.getTime() <= Date.now()) {
    return prisma.subscription.update({
      where: { userId },
      data: { tokensUsed: 0, renewalDate: nextRenewalDate() },
    });
  }

  return existing;
}

/**
 * Request-scoped version of `ensureSubscription`, for read-only render paths.
 *
 * Rendering a dashboard page asks for the subscription twice — the layout needs it for the
 * sidebar quota card, the page needs it for its own figures — which was two round trips for
 * one row. Keyed on `userId`, so a request that legitimately touches two accounts still
 * reads both.
 *
 * Use this only where nothing writes to `subscriptions` in the same request. Mutation paths
 * (a verified payment activation, the gateway's token debit, registration, operator plan
 * assignment) must keep calling `ensureSubscription` directly: they re-read the row after updating
 * it and have to see the new value, not the one memoised before the write.
 */
export const getRequestSubscription = cache(ensureSubscription);

export interface QuotaStatus {
  plan: string;
  allocation: number;
  used: number;
  remaining: number
  percentUsed: number;
  renewalDate: Date;
  status: string;
  exhausted: boolean;
  /**
   * True when no token ceiling applies. Every other number stays finite — `Infinity` would
   * serialise to `null` through the RSC boundary and corrupt the runway projection — so
   * consumers must branch on this flag rather than compare `remaining` against a sentinel.
   */
  unlimited: boolean;
}

export function quotaFrom(subscription: Subscription): QuotaStatus {
  const allocation = Math.max(0, subscription.tokenAllocation);
  const used = Math.max(0, subscription.tokensUsed);
  const remaining = Math.max(0, allocation - used);
  // The column, not the plan string and not the allocation: only `applyVerifiedPayment` sets
  // it, so an account cannot talk its way past the quota gate by having its plan renamed.
  const unlimited = subscription.unlimited === true;
  return {
    plan: subscription.plan,
    allocation,
    used,
    remaining,
    percentUsed: unlimited ? 0 : allocation === 0 ? 100 : Math.min(100, (used / allocation) * 100),
    renewalDate: subscription.renewalDate,
    status: subscription.status,
    // An unlimited account is never out of tokens, including once `used` passes the sentinel
    // allocation — which is what `remaining <= 0` would otherwise conclude.
    exhausted: unlimited ? false : remaining <= 0,
    unlimited,
  };
}

export interface RecordUsageInput {
  userId: string;
  apiKeyId: string | null;
  modelId: string;
  provider: string;
  endpoint: string;
  requestId: string;
  usage: TokenUsage;
  latencyMs: number;
  status: "success" | "error";
  httpStatus: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  costMicroUsd: number;
  streamed: boolean;
  ipAddress?: string | null;
}

/**
 * Writes the usage log and advances the counters in one transaction, so a request can
 * never be billed without being logged (or logged without being billed).
 * Failed requests are logged but do not consume allocation.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  const billable = input.status === "success" && input.usage.totalTokens > 0;

  await prisma.$transaction(async (tx) => {
    await tx.usageLog.create({
      data: {
        userId: input.userId,
        apiKeyId: input.apiKeyId,
        modelId: input.modelId,
        provider: input.provider,
        endpoint: input.endpoint,
        requestId: input.requestId,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        totalTokens: input.usage.totalTokens,
        latencyMs: input.latencyMs,
        status: input.status,
        httpStatus: input.httpStatus,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage?.slice(0, 500) ?? null,
        costMicroUsd: input.costMicroUsd,
        streamed: input.streamed,
        ipAddress: input.ipAddress ?? null,
      },
    });

    if (billable) {
      await tx.subscription.updateMany({
        where: { userId: input.userId },
        data: { tokensUsed: { increment: input.usage.totalTokens } },
      });
    }

    if (input.apiKeyId) {
      await tx.apiKey.update({
        where: { id: input.apiKeyId },
        data: {
          lastUsedAt: new Date(),
          requestCount: { increment: 1 },
          ...(billable ? { totalTokens: { increment: input.usage.totalTokens } } : {}),
        },
      });
    }
  });
}
