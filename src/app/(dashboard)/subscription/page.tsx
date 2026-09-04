import type { Metadata } from "next";
import Link from "next/link";
import { StatCard, StatGrid } from "@/components/dashboard/stat-card";
import { PlanPicker } from "@/components/subscription/plan-picker";
import { CryptoPaymentCard } from "@/components/subscription/crypto-payment";
import { UnlimitedOfferCard } from "@/components/subscription/unlimited-offer";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import {
  formatCompact,
  formatDate,
  formatDateTime,
  formatIdr,
  formatMicroUsd,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { getSubscription } from "@/server/services/subscription-service";

export const metadata: Metadata = { title: "Subscription" };

/**
 * Two entirely different accounts render from this one page:
 *
 *  - a metered account (`free`/`pro`/`business`), which has an allocation, a percentage and a
 *    monthly token window, and may switch between self-serve plans;
 *  - a paid unlimited account, which has none of those. Every cycle-shaped figure is replaced
 *    rather than filled with a sentinel, because a "2.0B allocation, resets 25 Sep" row would be
 *    a lie about a permanent purchase.
 *
 * `subscription.unlimited` is the database column and `subscription.permanent` additionally
 * asserts there is no expiry date, so the copy below never has to compare dates itself.
 *
 * There are also two purchase rails, and `payload.purchaseRail` decides which card appears. The
 * page does not inspect environment variables to work that out — the service already knows which
 * rail is configured, and the price label follows from the same answer so the headline figure and
 * the purchase card can never quote different amounts.
 */
export default async function SubscriptionPage() {
  const { user } = await requireUser();
  const payload = await getSubscription(user.id);
  const { subscription, unlimitedOffer, cryptoOffer, purchaseRail } = payload;
  const unlimited = subscription.unlimited;
  const onChain = purchaseRail === "crypto";
  const priceLabel = onChain ? cryptoOffer.priceUsd : formatIdr(unlimitedOffer.priceIdr);
  const receipt = unlimitedOffer.latestPayment;
  const chainReceipt = cryptoOffer.latestPayment;
  /** The settled receipt for whichever rail actually paid, used for the order-id caption. */
  const settledOrderId =
    chainReceipt?.status === "paid"
      ? chainReceipt.orderId
      : receipt?.status === "paid"
        ? receipt.orderId
        : null;

  const details: Array<[string, string]> = unlimited
    ? [
        ["Plan", subscription.planName],
        ["Status", subscription.status],
        ["Token ceiling", "None"],
        ["Used all-time", `${formatNumber(subscription.used)} tokens`],
        ["Access", subscription.permanent ? "Permanent" : "Time-limited"],
        ["Renewal", "None — one-time payment"],
        ["Member since", formatDate(subscription.createdAt)],
        ["Active keys", formatNumber(payload.activeKeys)],
      ]
    : [
        ["Plan", subscription.planName],
        ["Status", subscription.status],
        ["Allocation", `${formatNumber(subscription.allocation)} tokens`],
        ["Used this cycle", `${formatNumber(subscription.used)} tokens`],
        ["Renews", formatDate(subscription.renewalDate)],
        ["Subscribed since", formatDate(subscription.createdAt)],
        ["Active keys", formatNumber(payload.activeKeys)],
        [
          "Key limit",
          subscription.maxApiKeys === null ? "unlimited" : String(subscription.maxApiKeys),
        ],
      ];
  return (
    <>
      <PageHeader
        title="Subscription"
        description={
          unlimited
            ? "Your access, what it cost and what it covers. There is no cycle to manage — the payment was made once."
            : "Your allocation, rate limits and plan. Changes apply to the current cycle immediately."
        }
        action={<StatusBadge status={subscription.status} />}
      />

      <StatGrid>
        <StatCard
          label="Current plan"
          value={subscription.planName}
          tone="brand"
          hint={
            unlimited
              ? `${priceLabel} one-time · permanent access`
              : `Renews ${formatDate(subscription.renewalDate)}`
          }
        />
        <StatCard
          label="Tokens used"
          value={formatCompact(subscription.used)}
          tone={
            unlimited
              ? "default"
              : subscription.percentUsed >= 90
                ? "rose"
                : subscription.percentUsed >= 70
                  ? "amber"
                  : "default"
          }
          hint={
            unlimited
              ? "Lifetime total — nothing is deducted from a budget"
              : `${formatPercent(subscription.percentUsed, 1)} of ${formatCompact(subscription.allocation)}`
          }
        />
        {unlimited ? (
          <StatCard label="Token ceiling" value="None" tone="brand" hint="No allocation, no reset" />
        ) : (
          <StatCard
            label="Tokens remaining"
            value={formatCompact(subscription.remaining)}
            hint="Resets at the start of the next cycle"
          />
        )}
        <StatCard
          label="Rate limit"
          value={`${subscription.requestsPerMinute}/min`}
          hint={
            subscription.maxApiKeys === null
              ? "Unlimited API keys"
              : `Up to ${subscription.maxApiKeys} active ${subscription.maxApiKeys === 1 ? "key" : "keys"}`
          }
        />
        <StatCard
          label="Metered cost"
          value={formatMicroUsd(payload.spendMicroUsdThisMonth)}
          hint="Catalogue price of this month's traffic"
        />
      </StatGrid>

      {onChain ? (
        <CryptoPaymentCard offer={cryptoOffer} subscription={subscription} />
      ) : (
        <UnlimitedOfferCard offer={unlimitedOffer} subscription={subscription} />
      )}
      {unlimited ? (
        // The picker is hidden rather than disabled: `changePlan` refuses to touch an unlimited
        // account at all, so showing switchable cards would offer an action the API rejects.
        <Card>
          <CardHeader
            title="Metered plans"
            description="Not applicable while permanent unlimited access is active."
          />
          <CardBody className="text-xs leading-relaxed text-ink-muted">
            <p>
              Free, Pro and Business are monthly allocation tiers. Your account is above all of
              them and has no allocation to meter, so there is nothing to switch to. Downgrading
              is not automatic either — the access you paid for is never revoked by this page.
            </p>
            <p className="mt-2 text-[11px] text-ink-faint">
              Need it changed anyway?{" "}
              <Link href="/support" className="text-brand hover:opacity-80">
                Open a ticket
              </Link>
              .
            </p>
          </CardBody>
        </Card>
      ) : (
        <PlanPicker initial={payload} />
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="How billing works here"
            description="An honest note rather than a fake invoice screen."
          />
          <CardBody className="space-y-2 text-xs leading-relaxed text-ink-muted">
            <p>
              There are two different things on this page.{" "}
              <span className="text-ink">Unlimited</span> is a real one-time purchase:{" "}
              {priceLabel} paid once
              {onChain
                ? ", verified by reading the transfer directly from the blockchain on our server"
                : " through QRIS, activated only after the payment provider's signed callback is verified on our server"}
              . No button here can grant it, and the API refuses to assign it by hand.
            </p>
            <p>
              The metered plans (Free, Pro, Business) have{" "}
              <span className="text-ink">no</span> recurring processor connected. Switching between
              them updates your allocation and rate limit directly and is written to the audit log —
              nothing is charged. <span className="numeric text-ink">billingConnected</span> reports{" "}
              <span className="numeric text-ink">{String(subscription.billingConnected)}</span>.
            </p>
            <p>
              The <span className="numeric text-ink">Metered cost</span> figure above is computed
              from catalogue prices against your recorded usage — it is what this traffic would
              cost, not an amount charged to you.
              {unlimited ? " Your access is uncapped regardless of it." : ""}
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={unlimited ? "Access details" : "Cycle details"}
            action={
              settledOrderId ? (
                <span className="numeric text-[11px] text-ink-faint">order {settledOrderId}</span>
              ) : null
            }
          />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {details.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
                  <dd className="numeric mt-0.5 text-sm text-ink">{value}</dd>
                </div>
              ))}
            </dl>

            {chainReceipt && chainReceipt.status === "paid" ? (
              <p className="mt-4 text-[11px] text-ink-faint">
                Paid{" "}
                {chainReceipt.verifiedAt ? formatDateTime(chainReceipt.verifiedAt) : "on-chain"} —{" "}
                {chainReceipt.amount ?? "—"} {chainReceipt.asset ?? ""} received on{" "}
                {chainReceipt.network ?? "chain"}.
              </p>
            ) : receipt && receipt.status === "paid" && receipt.paidAt ? (
              <p className="mt-4 text-[11px] text-ink-faint">
                Paid {formatDateTime(receipt.paidAt)} via {receipt.method} —{" "}
                {formatIdr(receipt.paidAmountIdr ?? receipt.amountIdr)} received.
              </p>
            ) : null}

            <p className="mt-4 text-[11px] text-ink-faint">
              Need a custom allocation, private routing or an SLA?{" "}
              <Link href="/support" className="text-brand hover:opacity-80">
                Open a ticket
              </Link>{" "}
              and we will size an Enterprise plan with you.
            </p>
          </CardBody>
        </Card>

      </div>
    </>
  );
}
