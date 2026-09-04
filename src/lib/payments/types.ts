/**
 * Payment provider contract.
 *
 * Mirrors the shape of `src/lib/providers/types.ts` (the *model* provider seam) on purpose:
 * one interface, one registry, so swapping TriPay for Midtrans or Xendit means adding a file
 * and changing `PAYMENT_PROVIDER` — no service or route code changes.
 *
 * Two rules are baked into the signatures rather than left to convention:
 *
 *  1. `createCharge` takes an `amountIdr` decided by the caller from the plan catalogue. There
 *     is no code path where an amount arrives from a request body.
 *  2. `verifyCallback` receives the **raw body string**, not a parsed object, because the HMAC
 *     covers the exact bytes the provider signed. Parsing first and re-serialising would
 *     change key order and whitespace and break verification — or, worse, verify a
 *     re-serialisation while acting on the original.
 */
import "server-only";

/** Normalised lifecycle of a one-time payment, as stored in `Payment.status`. */
export type PaymentStatus = "pending" | "paid" | "failed" | "expired" | "refund";

export interface CreateChargeInput {
  /** Our merchant reference. Sent upstream and echoed back in the callback. */
  orderId: string;
  /** Whole rupiah. Never client-supplied. */
  amountIdr: number;
  /** Shown on the provider's checkout, so keep it non-sensitive. */
  itemName: string;
  /** Payer details the provider requires for a closed transaction. */
  customerName: string;
  customerEmail: string;
  /** Where the provider should send the payer after checkout. */
  returnUrl: string;
}

export interface ChargeResult {
  /** Provider-side transaction reference. */
  reference: string;
  /** Channel code actually used, e.g. "QRIS". */
  method: string;
  /** EMVCo QRIS payload to render as a QR. Null when the channel has no QR. */
  qrString: string | null;
  /** Provider-hosted checkout page, used as a fallback link. */
  checkoutUrl: string | null;
  /** When the provider stops accepting payment for this order. */
  expiresAt: Date | null;
  /** Amount the provider expects, echoed back for a sanity check against our own figure. */
  amountIdr: number;
}

/** What a verified callback told us. All fields are provider-attested, none client-supplied. */
export interface CallbackEvent {
  /** Our `Payment.orderId`, echoed by the provider (TriPay calls it `merchant_ref`). */
  orderId: string;
  reference: string;
  status: PaymentStatus;
  /**
   * The **order** amount in whole rupiah, net of any processing fee passed to the payer.
   * This is the figure compared against `Payment.amount`, because it is independent of how
   * the provider account splits fees between merchant and customer.
   */
  amountIdr: number;
  /** What the payer actually transferred, fee included. Recorded, never used for gating. */
  grossAmountIdr: number;
  paidAt: Date | null;
  method: string | null;
}

export type CallbackVerification =
  | { ok: true; event: CallbackEvent }
  | { ok: false; reason: string };

/** Server-to-server status read, used to reconcile when a callback never arrived. */
export interface RemoteStatus {
  reference: string;
  status: PaymentStatus;
  amountIdr: number;
  paidAt: Date | null;
}

export interface PaymentProvider {
  readonly id: string;
  readonly label: string;
  /** Env vars an operator must set. Names only — values never leave this process. */
  readonly credentialEnvVars: readonly string[];
  isConfigured(): boolean;
  createCharge(input: CreateChargeInput): Promise<ChargeResult>;
  /**
   * Authenticates a callback against the untouched request body. Returns a reason string
   * rather than throwing so the route can audit the rejection without leaking internals.
   */
  verifyCallback(rawBody: string, headers: Headers): CallbackVerification;
  /** Optional: not every provider exposes a status endpoint. */
  fetchStatus(reference: string): Promise<RemoteStatus | null>;
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
