"use client";

/**
 * The one-time Unlimited purchase.
 *
 * The one and only thing this deployment sells. There is no plan ladder beside it and no
 * plan-change endpoint: `/api/subscription` is read-only, so unlimited can be produced by nothing
 * except a verified QRIS payment.
 *
 * The checkout call sends **no body**. Amount, plan and user are all decided server-side, so
 * there is nothing here for a tampered request to change. Progress is observed by re-reading
 * `GET /api/payments/:orderId`, which is owner-scoped; the client never asserts a status.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { QrisCode } from "@/components/subscription/qris-code";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/client/api";
import { formatDateTime, formatIdr } from "@/lib/format";
import type { PaymentView } from "@/server/services/payment-service";
import type { SubscriptionView, UnlimitedOffer } from "@/server/services/subscription-service";

/** How often a pending order is re-read. The server throttles its own upstream poll separately. */
const POLL_MS = 4_000;

/** Ceiling on the poll loop so a forgotten tab does not read forever. 150 × 4s = 10 minutes. */
const MAX_POLLS = 150;

function expiryMs(payment: PaymentView): number | null {
  if (!payment.expiresAt) return null;
  const at = new Date(payment.expiresAt).getTime();
  return Number.isFinite(at) ? at : null;
}

function countdown(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function Feature({ text }: { text: string }) {
  return (
    <li className="flex gap-2">
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
      <span>{text}</span>
    </li>
  );
}
export function UnlimitedOfferCard({
  offer,
  subscription,
}: {
  offer: UnlimitedOffer;
  subscription: SubscriptionView;
}) {
  const router = useRouter();
  const toast = useToast();
  const [payment, setPayment] = useState<PaymentView | null>(offer.latestPayment);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // `router.refresh()` re-renders the server tree, which re-mounts nothing here — the guard is
  // what keeps a repeated poll from firing a second toast for the same activation.
  const announced = useRef(false);
  const ticks = useRef(0);

  const plan = offer.plan;
  const pendingOrderId = payment && payment.status === "pending" ? payment.orderId : null;
  const expiresAt = payment ? expiryMs(payment) : null;
  const expired = expiresAt !== null && now >= expiresAt;

  const settle = useCallback(
    (next: PaymentView) => {
      setPayment(next);
      if (next.applied && !announced.current) {
        announced.current = true;
        toast.success("Payment confirmed", "Unlimited access is now active on this account.");
        router.refresh();
      }
    },
    [router, toast],
  );

  // Countdown ticker, only while there is something to count down.
  useEffect(() => {
    if (!pendingOrderId) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pendingOrderId]);

  // Status polling. Reads only; the server decides what a status means.
  useEffect(() => {
    if (!pendingOrderId) return;
    let cancelled = false;
    const controller = new AbortController();

    async function read() {
      try {
        const next = await api.get<{ payment: PaymentView }>(
          `/api/payments/${encodeURIComponent(pendingOrderId as string)}`,
          controller.signal,
        );
        if (!cancelled) settle(next.payment);
      } catch {
        // A transient read failure is not worth a toast — the next tick retries.
      }
    }

    const id = setInterval(() => {
      ticks.current += 1;
      if (ticks.current > MAX_POLLS) {
        clearInterval(id);
        return;
      }
      void read();
    }, POLL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
  }, [pendingOrderId, settle]);

  async function startCheckout() {
    setBusy(true);
    try {
      // No body. There is no amount, plan or user id for a client to supply.
      const created = await api.post<{ payment: PaymentView }>("/api/payments/checkout");
      announced.current = false;
      ticks.current = 0;
      setNow(Date.now());
      settle(created.payment);
    } catch (error) {
      toast.error(
        "Could not start the payment",
        error instanceof ApiClientError ? error.message : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  /*
   * ---- already paid ------------------------------------------------------------------
   *
   * `unlimitedByPayment`, not `unlimited` — same reason as the on-chain card. Every row below is a
   * receipt (a rupiah amount, an order id, a payment method), and an administrator exempt by role
   * has none of those. They fall through to the offer instead.
   */
  if (subscription.unlimitedByPayment) {
    const receipt = payment && payment.status === "paid" ? payment : null;
    const rows: Array<[string, string]> = [
      ["Payment", `${formatIdr(plan.priceIdr ?? offer.priceIdr)} one-time`],
      [
        "Access",
        subscription.permanent
          ? "Permanent — no renewal, no expiry"
          : `Ends ${subscription.planExpiresAt ? formatDateTime(subscription.planExpiresAt) : "—"}`,
      ],
      ["Token ceiling", "None"],
      ["Models", "Every model in the catalogue, including paid tiers"],
    ];
    if (receipt) {
      rows.push(["Order", receipt.orderId]);
      rows.push(["Paid", receipt.paidAt ? formatDateTime(receipt.paidAt) : "—"]);
      rows.push(["Method", receipt.method]);
    }

    return (
      <Card className="border-brand/40 ring-1 ring-brand/15">
        <CardHeader
          title="Unlimited Access"
          description={plan.tagline}
          action={
            <Badge tone="brand" dot>
              Active
            </Badge>
          }
        />
        <CardBody className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-3">
            <p className="text-3xl leading-none font-semibold text-brand">Unlimited</p>
            <p className="text-xs leading-relaxed text-ink-muted">
              {subscription.permanent
                ? "Paid once, yours for good. There is no monthly allocation to reset and no renewal to miss."
                : "Active on this account."}
            </p>
            <ul className="space-y-1.5 text-[11px] text-ink-muted">
              {plan.features.map((feature) => (
                <Feature key={feature} text={feature} />
              ))}
            </ul>
          </div>
          <dl className="grid gap-x-6 gap-y-3 self-start sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
                <dd className="numeric mt-0.5 text-xs break-words text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
    );
  }

  // ---- not paid yet ------------------------------------------------------------------
  const showQr = pendingOrderId !== null && payment?.qr != null && !expired;
  const failed =
    payment !== null &&
    (payment.status === "failed" || payment.status === "expired" || payment.status === "refund");

  return (
    <Card>
      <CardHeader
        title="Unlimited Access"
        description={plan.tagline}
        action={
          <>
            <Badge tone="brand">{formatIdr(offer.priceIdr)} one-time</Badge>
            {payment ? <StatusBadge status={payment.status} /> : null}
          </>
        }
      />
      <CardBody className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <div>
            <p className="numeric text-3xl leading-none font-semibold text-ink">
              {formatIdr(offer.priceIdr)}
              <span className="text-xs font-normal text-ink-faint"> once</span>
            </p>
            <p className="mt-1 text-[11px] text-ink-faint">
              One-time payment. Permanent access — no renewal, no expiry, no subscription.
            </p>
          </div>

          <ul className="space-y-1.5 text-[11px] text-ink-muted">
            {plan.features.map((feature) => (
              <Feature key={feature} text={feature} />
            ))}
          </ul>

          {offer.available ? (
            <div className="space-y-2">
              <Button
                variant="primary"
                size="md"
                loading={busy}
                onClick={startCheckout}
                disabled={showQr}
              >
                {showQr ? "QRIS ready — scan to pay" : `Pay ${formatIdr(offer.priceIdr)} with QRIS`}
              </Button>
              <p className="text-[11px] leading-relaxed text-ink-faint">
                Access is granted only after the payment provider confirms the transfer to our
                server. Nothing on this page can activate it on its own.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-amber/30 bg-amber/8 p-3 text-[11px] leading-relaxed text-ink-muted">
              <p className="font-medium text-amber">Payments are not enabled on this deployment.</p>
              <p className="mt-1">
                The operator must configure the QRIS provider credentials before this button can do
                anything.{" "}
                {subscription.unlimitedByRole
                  ? "This account is not metered while it holds the admin role, so nothing is blocked in the meantime."
                  : `Until then this account stays on ${subscription.planName}.`}
              </p>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-line bg-raised/40 p-3">
          {showQr && payment?.qr ? (
            <div className="space-y-2.5">
              <div className="flex justify-center">
                <QrisCode qr={payment.qr} />
              </div>
              <p className="text-center text-[11px] text-ink-muted">
                Scan with any QRIS-capable app and pay exactly{" "}
                <span className="numeric text-ink">{formatIdr(payment.amountIdr)}</span>.
              </p>
              <dl className="space-y-1 text-[10.5px]">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-ink-faint">Order</dt>
                  <dd className="numeric truncate text-ink">{payment.orderId}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-ink-faint">Method</dt>
                  <dd className="numeric text-ink">{payment.method}</dd>
                </div>
                {expiresAt !== null ? (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-ink-faint">Expires in</dt>
                    <dd className="numeric text-ink">{countdown(expiresAt - now)}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="flex items-center justify-between gap-2 border-t border-line pt-2">
                <span className="inline-flex items-center gap-1.5 text-[10.5px] text-ink-faint">
                  <span className="size-1.5 animate-pulse rounded-full bg-amber" aria-hidden />
                  Waiting for confirmation…
                </span>
                {payment.qrString ? (
                  <CopyButton value={payment.qrString} label="Copy code" compact />
                ) : null}
              </div>
            </div>
          ) : expired ? (
            <div className="space-y-2 text-[11px] leading-relaxed text-ink-muted">
              <p className="font-medium text-amber">This QR code expired.</p>
              <p>Nothing was charged. Start a new payment to get a fresh code.</p>
              <Button variant="outline" size="sm" loading={busy} onClick={startCheckout}>
                New QRIS code
              </Button>
            </div>
          ) : failed ? (
            <div className="space-y-2 text-[11px] leading-relaxed text-ink-muted">
              <p className="font-medium text-rose">
                Your last order ended as “{payment?.status}”.
              </p>
              <p>No access was granted and nothing is owed. You can try again.</p>
              <Button variant="outline" size="sm" loading={busy} onClick={startCheckout}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="space-y-2 text-[11px] leading-relaxed text-ink-faint">
              <p className="font-medium text-ink-muted">How this works</p>
              <ol className="list-decimal space-y-1 pl-4">
                <li>Press the pay button — we create the order server-side.</li>
                <li>A QRIS code appears here; scan and pay {formatIdr(offer.priceIdr)}.</li>
                <li>
                  The provider notifies our server, the signature is verified, and unlimited access
                  turns on by itself. This page updates without a reload.
                </li>
              </ol>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
