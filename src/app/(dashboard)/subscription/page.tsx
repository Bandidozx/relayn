import type { Metadata } from "next";
import Link from "next/link";
import { StatCard, StatGrid } from "@/components/dashboard/stat-card";
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
 * One purchase, three account shapes.
 *
 * There is no plan ladder to browse and nothing to switch between: an account is either metered
 * (the `free` default, or a tier an operator assigned by hand) or uncapped. So this page sells
 * exactly one thing and otherwise reports state.
 *
 *  - a metered account has an allocation, a percentage and a monthly token window;
 *  - a paid unlimited account has none of those. Every cycle-shaped figure is replaced
 *    rather than filled with a sentinel, because a "2.0B allocation, resets 25 Sep" row would be
 *    a lie about a permanent purchase.
 *  - an **administrator** is uncapped by role, without having paid. Same absent figures, but none
 *    of the receipt copy: no price, no "paid once", no "permanent". `byRoleOnly` below gates every
 *    one of those strings, because inventing a purchase is worse than showing none.
 *
 * `subscription.unlimitedByPayment` is the database column, `unlimitedByRole` is derived from the
 * caller's role, `unlimited` is either, and `permanent` additionally asserts a paid account has no
 * expiry date — so the copy below never has to compare dates itself.
 *
 * The purchase card stays visible to an exempt administrator on purpose. Their exemption ends with
 * the role; buying is still a real, non-redundant action that sets their own permanent access, and
 * hiding the card would also remove the only path an operator has to exercise the payment rail.
 *
 * There are also two purchase rails, and `payload.purchaseRail` decides which card appears. The
 * page does not inspect environment variables to work that out — the service already knows which
 * rail is configured, and the price label follows from the same answer so the headline figure and
 * the purchase card can never quote different amounts.
 */
export default async function SubscriptionPage() {
  const { user } = await requireUser();
  const payload = await getSubscription(user);
  const { subscription, unlimitedOffer, cryptoOffer, purchaseRail } = payload;
  const unlimited = subscription.unlimited;
  /** Uncapped, but by role and with no payment behind it — so no receipt may be rendered. */
  const byRoleOnly = subscription.unlimitedByRole && !subscription.unlimitedByPayment;
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
        ["Account", subscription.planName],
        ["Status", subscription.status],
        ["Token ceiling", "None"],
        ["Used all-time", `${formatNumber(subscription.used)} tokens`],
        [
          "Access",
          byRoleOnly
            ? "While the admin role is held"
            : subscription.permanent
              ? "Permanent"
              : "Time-limited",
        ],
        byRoleOnly
          ? ["Granted by", "Admin role — nothing was paid"]
          : ["Renewal", "None — one-time payment"],
        ["Member since", formatDate(subscription.createdAt)],
        ["Active keys", formatNumber(payload.activeKeys)],
      ]
    : [
        ["Account", subscription.planName],
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
          byRoleOnly
            ? "This account is not metered because it holds the admin role. Nothing was purchased, and the exemption lasts as long as the role does."
            : unlimited
              ? "Your access, what it cost and what it covers. There is no cycle to manage — the payment was made once."
              : `Your allocation and rate limits. One ${priceLabel} payment removes both, permanently.`
        }
        action={<StatusBadge status={subscription.status} />}
      />

      <StatGrid>
        {/*
         * Labelled "Account", not "Current plan": there is nothing to compare it against. The value
         * is still the row's real plan name, so an operator-assigned tier reports itself honestly.
         */}
        <StatCard
          label="Account"
          value={subscription.planName}
          tone="brand"
          hint={
            byRoleOnly
              ? "Admin role · not metered"
              : unlimited
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

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="How billing works here"
            description="An honest note rather than a fake invoice screen."
          />
          <CardBody className="space-y-2 text-xs leading-relaxed text-ink-muted">
            <p>
              There is exactly one thing to buy here.{" "}
              <span className="text-ink">Unlimited</span> costs {priceLabel}, is paid once, and
              never renews
              {onChain
                ? " — it is verified by reading the transfer directly from the blockchain on our server"
                : " — it is activated only after the payment provider's signed callback is verified on our server"}
              . No button on this page can grant it, and the API refuses to assign it by hand.
            </p>
            <p>
              There are no monthly tiers to choose between and{" "}
              <span className="text-ink">no</span> recurring processor is connected, so nothing is
              ever charged to a card.{" "}
              {byRoleOnly
                ? "This account is exempt from metering because it holds the admin role — nothing was paid for it, and it is not a purchase. Buying Unlimited would still be worth doing if the role is ever handed over: paid access stays with the account, an exemption does not."
                : unlimited
                  ? "Your access was paid for and is never revoked by this page."
                  : `Until the ${priceLabel} payment lands, this account runs on its current allocation and rate limit.`}{" "}
              <span className="numeric text-ink">billingConnected</span> reports{" "}
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
              and we will arrange it with you directly.
            </p>
          </CardBody>
        </Card>

      </div>
    </>
  );
}
