"use client";

/**
 * The one-time Unlimited purchase, paid on-chain.
 *
 * This component's job is to display public configuration and to submit one string. It has no
 * opinion about whether a payment is valid: the only thing it sends is `{ txHash }`, and the
 * status it renders is whatever the server returned after reading the chain itself. There is no
 * "I have paid" button here, no proof upload, and no client-side amount — those are all ways of
 * letting the browser assert something it has no standing to assert.
 *
 * Two ways in, one gate. `WalletPayPanel` can build the transfer in an injected wallet and hand
 * back its hash; a payer sending from an exchange or another device pastes a hash by hand. Both
 * end at the same `verify()` below, so the wallet path is a convenience and never a shortcut —
 * a hash produced by a wallet gets exactly the same on-chain verification as a typed one.
 *
 * Copy is verbatim from the specification: Network / Asset / Amount / Receiving address, and the
 * five status strings (Waiting for payment, Verifying, Payment confirmed, Invalid transaction,
 * Already used). Nothing secret is rendered because nothing secret exists on this rail — Relayn
 * holds no key for the receiving address, it only reads transfers into it.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { WalletPayPanel } from "@/components/subscription/wallet-pay";
import { ApiClientError, api } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { CRYPTO_MESSAGES, cryptoMessageForReason } from "@/lib/payments/crypto/rules";
import { WALLET_MESSAGES } from "@/lib/payments/crypto/wallet";
import type {
  CryptoOffer,
  CryptoPaymentView,
  CryptoSubmitStatus,
} from "@/server/services/crypto-payment-service";
import type { SubscriptionView } from "@/server/services/subscription-service";

interface SubmitResult {
  status: CryptoSubmitStatus;
  message: string;
  activated: boolean;
  payment: CryptoPaymentView | null;
}

/** The five status labels the specification asks for, plus the idle one. */
const STATUS_LABEL: Record<CryptoSubmitStatus | "idle" | "verifying", string> = {
  idle: "Waiting for payment",
  verifying: "Verifying",
  confirmed: "Payment confirmed",
  pending: "Waiting for payment",
  rejected: "Invalid transaction",
  already_used: "Already used",
};

const STATUS_TONE: Record<string, "brand" | "amber" | "rose" | "neutral"> = {
  idle: "neutral",
  verifying: "amber",
  confirmed: "brand",
  pending: "amber",
  rejected: "rose",
  already_used: "rose",
};

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

/** A label/value row. `mono` for anything a payer has to compare character by character. */
function Detail({
  label,
  value,
  mono = false,
  action,
}: {
  label: string;
  value: string;
  mono?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-2 last:border-0">
      <dt className="shrink-0 text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <span className={mono ? "numeric text-[11px] break-all text-ink" : "text-xs text-ink"}>
          {value}
        </span>
        {action}
      </dd>
    </div>
  );
}

export function CryptoPaymentCard({
  offer,
  subscription,
}: {
  offer: CryptoOffer;
  subscription: SubscriptionView;
}) {
  const router = useRouter();
  const toast = useToast();
  const [txHash, setTxHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(
    offer.latestPayment ? viewToResult(offer.latestPayment) : null,
  );

  const plan = offer.plan;
  const instructions = offer.instructions;
  const state: CryptoSubmitStatus | "idle" | "verifying" = busy
    ? "verifying"
    : (result?.status ?? "idle");

  /**
   * The only path to activation, shared by the wallet button and the pasted hash.
   *
   * `hash` is an identifier and nothing more: the request body is `{ txHash }` with no amount, no
   * recipient, no chain, no status, no plan and no user id. Whatever comes back is what the
   * server concluded after reading the chain — this function never decides anything itself.
   */
  async function verify(hash: string) {
    setBusy(true);
    try {
      // The entire request body. No amount, no recipient, no plan, no user id.
      const next = await api.post<SubmitResult>("/api/payments/crypto/verify", {
        txHash: hash,
      });
      setResult(next);
      if (next.activated) {
        toast.success("Payment confirmed", "Unlimited access is now active on this account.");
        // Re-render the server tree so the quota card and plan badge reflect the new plan.
        router.refresh();
      } else if (next.status === "pending") {
        toast.info("Not confirmed yet", next.message);
      } else if (next.status !== "confirmed") {
        toast.error("Payment not verified", next.message);
      }
    } catch (error) {
      const message =
        error instanceof ApiClientError ? error.message : WALLET_MESSAGES.verifyFailed;
      setResult({ status: "rejected", message, activated: false, payment: null });
      toast.error("Payment not verified", message);
    } finally {
      setBusy(false);
    }
  }

  /*
   * ---- already paid ------------------------------------------------------------------
   *
   * `unlimitedByPayment`, not `unlimited`. An administrator is uncapped by role without having
   * bought anything, and every string in this branch is a receipt — "Unlimited Permanent", "Paid
   * once, yours for good", "$0.50 one-time". Rendering it for an account that never paid would
   * invent a purchase, and it would also hide the purchase card from the one account most likely
   * to need to exercise this rail. So an exempt operator falls through to the offer below; the
   * moment a payment actually settles, this branch is the one that applies.
   */
  if (subscription.unlimitedByPayment) {
    const receipt = result?.payment?.status === "paid" ? result.payment : null;
    return (
      <Card className="border-brand/40 ring-1 ring-brand/15">
        <CardHeader
          title="Unlimited Permanent"
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
          <dl className="self-start">
            <Detail label="Payment" value={`${offer.priceUsd} one-time`} />
            <Detail
              label="Access"
              value={
                subscription.permanent
                  ? "Permanent — no renewal, no expiry"
                  : `Ends ${subscription.planExpiresAt ? formatDateTime(subscription.planExpiresAt) : "—"}`
              }
            />
            <Detail label="Token ceiling" value="None" />
            {receipt ? (
              <>
                <Detail label="Network" value={receipt.network ?? "—"} />
                <Detail
                  label="Amount"
                  value={receipt.amount ? `${receipt.amount} ${receipt.asset ?? ""}`.trim() : "—"}
                />
                <Detail label="TX hash" value={receipt.txHash ?? "—"} mono />
                <Detail
                  label="Verified"
                  value={receipt.verifiedAt ? formatDateTime(receipt.verifiedAt) : "—"}
                />
              </>
            ) : null}
          </dl>
        </CardBody>
      </Card>
    );
  }

  // ---- not paid yet ------------------------------------------------------------------
  const hashLooksValid = /^(0x)?[0-9a-fA-F]{64}$/.test(txHash.trim());

  return (
    <Card>
      <CardHeader
        title="Unlimited Permanent"
        description={plan.tagline}
        action={
          <>
            <Badge tone="brand">{offer.priceUsd} one-time payment</Badge>
            <Badge tone={STATUS_TONE[state] ?? "neutral"} dot>
              {STATUS_LABEL[state]}
            </Badge>
          </>
        }
      />
      <CardBody className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <div>
            <p className="numeric text-3xl leading-none font-semibold text-ink">
              {offer.priceUsd}
              <span className="text-xs font-normal text-ink-faint"> one-time payment</span>
            </p>
            <p className="mt-1 text-[11px] text-ink-faint">
              Permanent access — no renewal, no expiry, no subscription.
            </p>
          </div>

          <ul className="space-y-1.5 text-[11px] text-ink-muted">
            {plan.features.map((feature) => (
              <Feature key={feature} text={feature} />
            ))}
          </ul>

          {instructions ? (
            <div className="rounded-xl border border-line bg-raised/40 p-3">
              <dl>
                <Detail label="Network" value={`${instructions.networkLabel} (chain ${instructions.chainId})`} />
                <Detail label="Asset" value={`${instructions.asset} · ${instructions.assetAddress}`} mono />
                <Detail label="Amount" value={`${instructions.amount} ${instructions.asset}`} />
                <Detail
                  label="Receiving address"
                  value={instructions.address}
                  mono
                  action={<CopyButton value={instructions.address} label="Copy Address" compact />}
                />
                <Detail
                  label="Confirmations"
                  value={`${instructions.minConfirmations} required`}
                />
              </dl>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                Send exactly {instructions.amount} {instructions.asset} on{" "}
                {instructions.networkLabel} to the address above, then paste the transaction hash.
                Transfers of any other token, on any other network, or to any other address cannot
                be credited. Relayn holds no key for this address — it only reads transfers into it.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-amber/30 bg-amber/8 p-3 text-[11px] leading-relaxed text-ink-muted">
              <p className="font-medium text-amber">
                Crypto payments are not enabled on this deployment.
              </p>
              <p className="mt-1">
                The operator must set {offer.missingEnvVars.join(", ")} before this form can do
                anything.{" "}
                {subscription.unlimitedByRole
                  ? "This account is not metered while it holds the admin role, so nothing is blocked in the meantime."
                  : `Until then this account stays on ${subscription.planName}.`}
              </p>
            </div>
          )}
        </div>

        <div className="space-y-3 rounded-xl border border-line bg-raised/40 p-3">
          {instructions ? (
            <>
              <WalletPayPanel
                target={instructions}
                priceUsd={offer.priceUsd}
                verifying={busy}
                onTxHash={verify}
              />
              <div className="flex items-center gap-2">
                <span className="h-px flex-1 bg-line" />
                <span className="text-[10px] tracking-wide text-ink-faint uppercase">
                  or pay manually
                </span>
                <span className="h-px flex-1 bg-line" />
              </div>
            </>
          ) : null}

          <Field
            label="TX Hash"
            htmlFor="crypto-tx-hash"
            help="Paid from an exchange or another device? Paste the transaction hash here. 66 characters, starting 0x."
          >
            <Input
              id="crypto-tx-hash"
              value={txHash}
              onChange={(event) => setTxHash(event.target.value)}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              className="numeric text-[11px]"
              disabled={!instructions || busy}
            />
          </Field>

          <Button
            variant="secondary"
            size="md"
            loading={busy}
            disabled={!instructions || !hashLooksValid}
            onClick={() => void verify(txHash)}
            className="w-full"
          >
            Verify Payment
          </Button>

          <div className="border-t border-line pt-2">
            <p className="text-[11px] text-ink-faint">
              Status:{" "}
              <span
                className={
                  state === "confirmed"
                    ? "text-brand"
                    : state === "rejected" || state === "already_used"
                      ? "text-rose"
                      : state === "verifying" || state === "pending"
                        ? "text-amber"
                        : "text-ink-muted"
                }
              >
                {STATUS_LABEL[state]}
              </span>
            </p>
            {result ? (
              <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{result.message}</p>
            ) : (
              <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                Your hash is verified against the chain by our server. Nothing on this page can
                activate access on its own.
              </p>
            )}
          </div>

          {result?.payment ? (
            <dl className="border-t border-line pt-2">
              <Detail label="Order" value={result.payment.orderId} mono />
              {result.payment.amount ? (
                <Detail
                  label="Seen on-chain"
                  value={`${result.payment.amount} ${result.payment.asset ?? ""}`.trim()}
                />
              ) : null}
              {result.payment.confirmations !== null ? (
                <Detail label="Confirmations" value={String(result.payment.confirmations)} />
              ) : null}
              {result.payment.explorerTxUrl ? (
                <div className="pt-2">
                  <a
                    href={result.payment.explorerTxUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-[11px] text-brand underline-offset-2 hover:underline"
                  >
                    View on the block explorer ↗
                  </a>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Reconstructs a display state from a stored row on first render.
 *
 * A payer who reloads the page mid-verification should see where they left off rather than an
 * empty form. The row's own status is the source — the client never infers "paid" from anything
 * it computed locally.
 */
function viewToResult(payment: CryptoPaymentView): SubmitResult {
  if (payment.status === "paid") {
    return { status: "confirmed", message: CRYPTO_MESSAGES.confirmed, activated: false, payment };
  }
  if (payment.status === "failed") {
    return {
      status: "rejected",
      message: cryptoMessageForReason(payment.failureReason),
      activated: false,
      payment,
    };
  }
  return {
    status: "pending",
    message: cryptoMessageForReason(payment.failureReason ?? "unconfirmed"),
    activated: false,
    payment,
  };
}
