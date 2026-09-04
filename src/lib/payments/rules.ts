/**
 * Callback decision logic — pure, synchronous, and unit-tested.
 *
 * Everything that decides whether a payment activates anything lives here, separated from
 * Prisma and from the HTTP layer, so the rules the user specified can be asserted directly:
 *
 *   - the order must be one of ours, for the provider that owns it;
 *   - the provider reference must match the one we bound at checkout;
 *   - the order amount must equal the server-decided price exactly;
 *   - only `paid` activates anything;
 *   - a repeated callback must not activate twice;
 *   - an already-settled order is never rewritten — in particular a later `refund` callback
 *     does not revoke permanent access (business decision: paid once, unlimited forever).
 *
 * The action names map one-to-one onto what `applyVerifiedPayment` does with the row, and the
 * `reason` string is what lands in the audit log and in `Payment.failureReason`. Neither ever
 * carries a credential or raw payload.
 */
import type { CallbackEvent, PaymentStatus } from "@/lib/payments/types";

export type CallbackAction =
  /** Flip pending → paid and grant permanent unlimited access. */
  | "activate"
  /** Record a terminal non-paid outcome. Grants nothing. */
  | "mark_failed"
  /** A legitimate callback that changes nothing (still-unpaid, or a replay). */
  | "ignore"
  /** The callback contradicts our records. Audited, never acted on. */
  | "reject";

export interface CallbackDecision {
  action: CallbackAction;
  /** Machine-readable, stable, safe to persist and to log. */
  reason: string;
}

/** The only fields of a `Payment` row the decision depends on. */
export interface PaymentSnapshot {
  orderId: string;
  provider: string;
  reference: string | null;
  amount: number;
  status: string;
}

/**
 * `payment` is null when no row matched the callback's `merchant_ref`. That is the case a
 * forged-but-somehow-signed callback would land in, and it is also what a callback for a
 * different deployment sharing the same TriPay account looks like.
 */
export function evaluateCallback(input: {
  payment: PaymentSnapshot | null;
  event: CallbackEvent;
  providerId: string;
}): CallbackDecision {
  const { payment, event, providerId } = input;

  if (!payment) {
    return { action: "reject", reason: "unknown_order" };
  }

  if (payment.provider !== providerId) {
    return { action: "reject", reason: "provider_mismatch" };
  }

  // Bound at checkout from the provider's own create response. A callback quoting a different
  // reference is not about this order, whatever its `merchant_ref` says.
  if (payment.reference && payment.reference !== event.reference) {
    return { action: "reject", reason: "reference_mismatch" };
  }

  // The idempotency gate in decision form. The service repeats it as a conditional UPDATE,
  // because between this check and the write another callback may be in flight.
  if (payment.status !== "pending") {
    return { action: "ignore", reason: `already_settled:${payment.status}` };
  }

  if (event.status === "pending") {
    // TriPay fires a callback on every status change, including UNPAID at creation.
    return { action: "ignore", reason: "not_settled_yet" };
  }

  if (event.status === "paid") {
    if (event.amountIdr !== payment.amount) {
      return { action: "reject", reason: "amount_mismatch" };
    }
    return { action: "activate", reason: "paid" };
  }

  return { action: "mark_failed", reason: `provider_status:${event.status}` };
}

/** Terminal statuses a `mark_failed` decision may write. Keeps the service honest. */
export function isTerminalFailure(status: PaymentStatus): boolean {
  return status === "failed" || status === "expired" || status === "refund";
}
