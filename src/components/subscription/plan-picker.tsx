"use client";

/**
 * Metered plan picker (Free / Pro / Business / Enterprise).
 *
 * These tiers have no recurring processor behind them — the brief said not to add one — so a
 * switch takes effect immediately and the UI says so plainly rather than showing a fake
 * checkout. The Stripe seam is `Subscription.externalRef`; `billingConnected` stays false
 * until it exists.
 *
 * The one-time **Unlimited** purchase is deliberately not in this grid. It is real money
 * through QRIS and lives in `unlimited-offer.tsx`; `payload.plans` excludes it, and
 * `changePlanSchema` rejects it, so no card here can ever produce it.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { formatCompact, formatNumber, formatUsd } from "@/lib/format";
import type { Plan } from "@/lib/plans";
import type { SubscriptionPayload } from "@/server/services/subscription-service";

export function PlanPicker({ initial }: { initial: SubscriptionPayload }) {
  const router = useRouter();
  const toast = useToast();
  const [payload, setPayload] = useState(initial);
  const [target, setTarget] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);

  const current = payload.subscription;

  async function confirmChange() {
    if (!target) return;
    setBusy(true);
    try {
      const next = await api.patch<SubscriptionPayload>("/api/subscription", { plan: target.id });
      setPayload(next);
      setTarget(null);
      toast.success(
        `Now on ${next.subscription.planName}`,
        `Your allocation is ${formatNumber(next.subscription.allocation)} tokens per cycle.`,
      );
      // The sidebar quota card is server-rendered, so refresh it too.
      router.refresh();
    } catch (error) {
      toast.error(
        "Plan change failed",
        error instanceof ApiClientError ? error.message : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
        {payload.plans.map((plan) => {
          const isCurrent = plan.id === current.plan;
          const isUpgrade = plan.order > (payload.plans.find((p) => p.id === current.plan)?.order ?? 0);
          return (
            <article
              key={plan.id}
              className={cn(
                "panel flex flex-col gap-3 p-4",
                isCurrent && "border-brand/45 ring-1 ring-brand/20",
              )}
            >
              <header>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ink">{plan.name}</h3>
                  {isCurrent ? <Badge tone="brand" dot>Current</Badge> : null}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{plan.tagline}</p>
              </header>

              <p className="numeric text-2xl leading-none font-semibold text-ink">
                {plan.priceLabel ? (
                  // Enterprise is negotiated: its `priceMonthlyUsd` of 0 must never render as
                  // "Free", which is a different plan on this very grid.
                  <span className="text-lg">{plan.priceLabel}</span>
                ) : (
                  <>
                    {formatUsd(plan.priceMonthlyUsd)}
                    <span className="text-xs font-normal text-ink-faint"> / month</span>
                  </>
                )}
              </p>

              <ul className="space-y-1.5 text-[11px] text-ink-muted">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <svg viewBox="0 0 16 16" className="mt-0.5 size-3 shrink-0 text-brand" aria-hidden>
                      <path
                        d="M3.5 8.5l3 3 6-6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <dl className="mt-auto grid grid-cols-2 gap-2 border-t border-line pt-3 text-[10.5px]">
                <div>
                  <dt className="text-ink-faint">Allocation</dt>
                  <dd className="numeric text-ink">{formatCompact(plan.tokenAllocation)}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Rate limit</dt>
                  <dd className="numeric text-ink">{plan.requestsPerMinute}/min</dd>
                </div>
              </dl>

              {isCurrent ? (
                <Button variant="secondary" size="sm" disabled>
                  Your plan
                </Button>
              ) : plan.selfServe ? (
                <Button
                  variant={isUpgrade ? "primary" : "outline"}
                  size="sm"
                  onClick={() => setTarget(plan)}
                >
                  {isUpgrade ? `Upgrade to ${plan.name}` : `Switch to ${plan.name}`}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => router.push("/support")}>
                  Contact sales
                </Button>
              )}
            </article>
          );
        })}
      </div>

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        onConfirm={confirmChange}
        loading={busy}
        confirmVariant="primary"
        confirmLabel={`Move to ${target?.name ?? ""}`}
        title={`Switch to ${target?.name ?? ""}?`}
        message={
          <div className="space-y-2">
            <p>
              Your allocation becomes{" "}
              <span className="numeric text-ink">
                {formatNumber(target?.tokenAllocation ?? 0)} tokens
              </span>{" "}
              per cycle and your rate limit becomes{" "}
              <span className="numeric text-ink">{target?.requestsPerMinute ?? 0}/min</span>.
            </p>
            <p>
              Tokens already used this cycle ({formatNumber(current.used)}) carry over — switching
              plans is not a reset.
            </p>
            <p className="text-xs text-ink-faint">
              No payment is taken: these tiers have no recurring processor connected, so the change
              applies immediately and is recorded in your audit trail. The one-time Unlimited
              purchase is separate and is the only thing on this page that costs money.
            </p>
          </div>
        }
      />
    </>
  );
}
