/**
 * TriPay adapter — closed QRIS transactions.
 *
 * Chosen over the alternatives for one reason: its callback signature is
 * `HMAC-SHA256(rawBody, privateKey)`, so it authenticates *every* field of the payload.
 * Midtrans and Duitku sign a concatenation of three or four selected fields, which leaves the
 * rest of the body unauthenticated; Xendit sends a static shared token, which is not a
 * signature at all.
 *
 * Docs consulted: `POST {base}/transaction/create`, `GET {base}/transaction/detail`, and the
 * `payment_status` callback (headers `X-Callback-Signature`, `X-Callback-Event`).
 *
 * Credentials live in `env.payments.tripay` and never leave this module. `isConfigured()` is
 * the only thing callers may ask about them.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";
import {
  PaymentProviderError,
  type CallbackEvent,
  type CallbackVerification,
  type ChargeResult,
  type CreateChargeInput,
  type PaymentProvider,
  type PaymentStatus,
  type RemoteStatus,
} from "@/lib/payments/types";

const SANDBOX_BASE = "https://tripay.co.id/api-sandbox";
const PRODUCTION_BASE = "https://tripay.co.id/api";

const SIGNATURE_HEADER = "x-callback-signature";
const EVENT_HEADER = "x-callback-event";
const PAYMENT_STATUS_EVENT = "payment_status";

/** Provider status strings → our normalised lifecycle. Anything unknown stays pending. */
function normaliseStatus(raw: string): PaymentStatus {
  switch (raw.trim().toUpperCase()) {
    case "PAID":
      return "paid";
    case "FAILED":
      return "failed";
    case "EXPIRED":
      return "expired";
    case "REFUND":
      return "refund";
    default:
      // "UNPAID" and anything the provider adds later. Never activates anything.
      return "pending";
  }
}

/** TriPay sends unix seconds; 0 and null both mean "not set". */
function fromUnixSeconds(value: number | null | undefined): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

/**
 * Callback payload. Deliberately permissive about extra keys (the provider adds fields over
 * time) and strict about the five that decide anything.
 */
const callbackSchema = z.object({
  reference: z.string().min(1).max(120),
  merchant_ref: z.string().min(1).max(120),
  status: z.string().min(1).max(40),
  total_amount: z.coerce.number().int().min(0).max(1_000_000_000),
  fee_customer: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
  payment_method_code: z.string().max(40).optional(),
  payment_method: z.string().max(80).optional(),
  paid_at: z.coerce.number().int().min(0).nullish(),
  is_closed_payment: z.coerce.number().int().optional(),
});

const chargeResponseSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  data: z
    .object({
      reference: z.string().min(1),
      merchant_ref: z.string().min(1),
      payment_method: z.string().optional(),
      payment_method_code: z.string().optional(),
      amount: z.coerce.number().int().min(0),
      total_amount: z.coerce.number().int().min(0).optional(),
      fee_customer: z.coerce.number().int().min(0).optional(),
      qr_string: z.string().nullish(),
      checkout_url: z.string().nullish(),
      pay_url: z.string().nullish(),
      expired_time: z.coerce.number().int().nullish(),
      status: z.string().optional(),
    })
    .nullish(),
});

const detailResponseSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  data: z
    .object({
      reference: z.string().min(1),
      status: z.string().min(1),
      total_amount: z.coerce.number().int().min(0),
      fee_customer: z.coerce.number().int().min(0).optional(),
      paid_at: z.coerce.number().int().min(0).nullish(),
    })
    .nullish(),
});

export interface TripayConfig {
  apiKey: string;
  privateKey: string;
  merchantCode: string;
  mode: string;
  baseUrl: string;
  method: string;
}

export class TripayProvider implements PaymentProvider {
  readonly id = "tripay";
  readonly label = "TriPay (QRIS)";
  readonly credentialEnvVars = [
    "TRIPAY_API_KEY",
    "TRIPAY_PRIVATE_KEY",
    "TRIPAY_MERCHANT_CODE",
  ] as const;

  private readonly config: TripayConfig;

  constructor(config: TripayConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return (
      this.config.apiKey.length > 0 &&
      this.config.privateKey.length > 0 &&
      this.config.merchantCode.length > 0
    );
  }

  private base(): string {
    if (this.config.baseUrl) return this.config.baseUrl.replace(/\/$/, "");
    return this.config.mode.toLowerCase() === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
  }

  /** Request signature: HMAC-SHA256(merchantCode + merchantRef + amount, privateKey). */
  private requestSignature(orderId: string, amountIdr: number): string {
    return createHmac("sha256", this.config.privateKey)
      .update(`${this.config.merchantCode}${orderId}${amountIdr}`)
      .digest("hex");
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
    if (!this.isConfigured()) {
      throw new PaymentProviderError(
        `${this.label} is not configured on this deployment. The operator must set ${this.credentialEnvVars.join(", ")}.`,
        this.id,
      );
    }

    const body = {
      method: this.config.method,
      merchant_ref: input.orderId,
      amount: input.amountIdr,
      customer_name: input.customerName,
      customer_email: input.customerEmail,
      order_items: [
        {
          sku: input.orderId,
          name: input.itemName,
          price: input.amountIdr,
          quantity: 1,
        },
      ],
      return_url: input.returnUrl,
      signature: this.requestSignature(input.orderId, input.amountIdr),
    };

    let response: Response;
    try {
      response = await fetch(`${this.base()}/transaction/create`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        // A payment provider that has not answered in 20s is not going to.
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new PaymentProviderError(
        `Could not reach ${this.label}: ${error instanceof Error ? error.message : "network error"}`,
        this.id,
      );
    }

    const text = await response.text();
    let parsed: z.infer<typeof chargeResponseSchema>;
    try {
      parsed = chargeResponseSchema.parse(JSON.parse(text));
    } catch {
      // The body may carry an upstream error page; do not echo it to the client.
      console.error(`[relayn] ${this.id}: unreadable create response (HTTP ${response.status})`);
      throw new PaymentProviderError(
        `${this.label} returned an unreadable response.`,
        this.id,
        response.status,
      );
    }

    if (!response.ok || parsed.success === false || !parsed.data) {
      throw new PaymentProviderError(
        parsed.message?.slice(0, 200) || `${this.label} rejected the transaction.`,
        this.id,
        response.status,
      );
    }

    const data = parsed.data;
    if (data.merchant_ref !== input.orderId) {
      // Defensive: never bind a provider reference to an order we did not just create.
      throw new PaymentProviderError(
        `${this.label} echoed a different merchant reference.`,
        this.id,
        response.status,
      );
    }

    return {
      reference: data.reference,
      method: data.payment_method_code || this.config.method,
      qrString: data.qr_string?.trim() || null,
      checkoutUrl: data.checkout_url || data.pay_url || null,
      expiresAt: fromUnixSeconds(data.expired_time ?? null),
      amountIdr: data.amount,
    };
  }

  verifyCallback(rawBody: string, headers: Headers): CallbackVerification {
    if (!this.isConfigured()) {
      return { ok: false, reason: "provider_unconfigured" };
    }

    const event = headers.get(EVENT_HEADER)?.trim().toLowerCase();
    if (event && event !== PAYMENT_STATUS_EVENT) {
      return { ok: false, reason: `unsupported_event:${event.slice(0, 40)}` };
    }

    const presented = headers.get(SIGNATURE_HEADER)?.trim() ?? "";
    if (!presented) return { ok: false, reason: "signature_missing" };

    // HMAC over the exact bytes received — computed before the body is parsed, so a payload
    // that fails verification is never interpreted as anything.
    const expected = createHmac("sha256", this.config.privateKey).update(rawBody).digest("hex");
    const left = Buffer.from(presented.toLowerCase(), "utf8");
    const right = Buffer.from(expected, "utf8");
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return { ok: false, reason: "signature_mismatch" };
    }

    let payload: z.infer<typeof callbackSchema>;
    try {
      payload = callbackSchema.parse(JSON.parse(rawBody));
    } catch {
      return { ok: false, reason: "payload_unreadable" };
    }

    const feeCustomer = payload.fee_customer ?? 0;
    const callbackEvent: CallbackEvent = {
      orderId: payload.merchant_ref,
      reference: payload.reference,
      status: normaliseStatus(payload.status),
      // `total_amount` is what the payer transferred. When the account passes processing fees
      // to the customer it exceeds the order amount, so the order amount is recovered by
      // subtracting `fee_customer`. This makes the equality check below independent of how the
      // TriPay account splits fees.
      amountIdr: payload.total_amount - feeCustomer,
      grossAmountIdr: payload.total_amount,
      paidAt: fromUnixSeconds(payload.paid_at ?? null),
      method: payload.payment_method_code || payload.payment_method || null,
    };

    return { ok: true, event: callbackEvent };
  }

  async fetchStatus(reference: string): Promise<RemoteStatus | null> {
    if (!this.isConfigured()) return null;

    let response: Response;
    try {
      response = await fetch(
        `${this.base()}/transaction/detail?reference=${encodeURIComponent(reference)}`,
        {
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      return null;
    }

    if (!response.ok) return null;

    let parsed: z.infer<typeof detailResponseSchema>;
    try {
      parsed = detailResponseSchema.parse(await response.json());
    } catch {
      return null;
    }
    if (!parsed.data) return null;

    return {
      reference: parsed.data.reference,
      status: normaliseStatus(parsed.data.status),
      amountIdr: parsed.data.total_amount - (parsed.data.fee_customer ?? 0),
      paidAt: fromUnixSeconds(parsed.data.paid_at ?? null),
    };
  }
}

export function tripayFromEnv(): TripayProvider {
  return new TripayProvider({
    apiKey: env.payments.tripay.apiKey,
    privateKey: env.payments.tripay.privateKey,
    merchantCode: env.payments.tripay.merchantCode,
    mode: env.payments.tripay.mode,
    baseUrl: env.payments.tripay.baseUrl,
    method: env.payments.tripay.method || "QRIS",
  });
}

/** Exported for tests: status normalisation is the gate that keeps non-PAID inert. */
export const __testables = { normaliseStatus, fromUnixSeconds };
