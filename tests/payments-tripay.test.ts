/**
 * TriPay adapter — callback authentication and status normalisation.
 *
 * The signatures here are computed with the same `createHmac` the adapter uses, so these are
 * real fixtures rather than recorded strings: a change to the signing scheme fails the test
 * instead of silently passing against a stale constant.
 *
 * What matters most is the ordering: `verifyCallback` must reject on the HMAC **before** the
 * body is interpreted, so a tampered payload is never parsed into an event at all.
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNLIMITED_PRICE_IDR } from "@/lib/plans";
import { TripayProvider, __testables } from "@/lib/payments/tripay";
import { PaymentProviderError } from "@/lib/payments/types";

const PRIVATE_KEY = "test-private-key-not-a-real-secret";
const ORDER = "RLYN-UNL-abc123";

function provider(over: Partial<ConstructorParameters<typeof TripayProvider>[0]> = {}) {
  return new TripayProvider({
    apiKey: "test-api-key",
    privateKey: PRIVATE_KEY,
    merchantCode: "T1234",
    mode: "sandbox",
    baseUrl: "",
    method: "QRIS",
    ...over,
  });
}

function sign(body: string, key = PRIVATE_KEY): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

function callbackBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reference: "DEV-T1234567890",
    merchant_ref: ORDER,
    status: "PAID",
    total_amount: UNLIMITED_PRICE_IDR,
    fee_customer: 0,
    payment_method_code: "QRIS",
    payment_method: "QRIS",
    paid_at: 1_787_000_000,
    is_closed_payment: 1,
    ...over,
  });
}

function headers(signature: string, event = "payment_status"): Headers {
  return new Headers({
    "x-callback-signature": signature,
    "x-callback-event": event,
    "content-type": "application/json",
  });
}

describe("isConfigured", () => {
  it("requires all three credentials", () => {
    expect(provider().isConfigured()).toBe(true);
    expect(provider({ apiKey: "" }).isConfigured()).toBe(false);
    expect(provider({ privateKey: "" }).isConfigured()).toBe(false);
    expect(provider({ merchantCode: "" }).isConfigured()).toBe(false);
  });
});

describe("verifyCallback — signature", () => {
  it("accepts a body signed with the private key", () => {
    const body = callbackBody();
    const result = provider().verifyCallback(body, headers(sign(body)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.orderId).toBe(ORDER);
    expect(result.event.status).toBe("paid");
    expect(result.event.amountIdr).toBe(UNLIMITED_PRICE_IDR);
  });

  it("rejects a body whose signature was computed with a different key", () => {
    // The forged-callback case: an attacker who knows the payload shape but not the secret.
    const body = callbackBody();
    const result = provider().verifyCallback(body, headers(sign(body, "wrong-key")));
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a body that was tampered with after signing", () => {
    // Signature over the honest body, payload swapped for one claiming a bigger payment.
    const honest = callbackBody({ total_amount: UNLIMITED_PRICE_IDR });
    const tampered = callbackBody({ total_amount: 1 });
    const result = provider().verifyCallback(tampered, headers(sign(honest)));
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a signature that is merely truncated to the right prefix", () => {
    const body = callbackBody();
    const full = sign(body);
    expect(provider().verifyCallback(body, headers(full.slice(0, 32)))).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a missing signature header", () => {
    const body = callbackBody();
    const bare = new Headers({ "x-callback-event": "payment_status" });
    expect(provider().verifyCallback(body, bare)).toEqual({
      ok: false,
      reason: "signature_missing",
    });
    expect(provider().verifyCallback(body, headers("   "))).toEqual({
      ok: false,
      reason: "signature_missing",
    });
  });

  it("accepts an upper-case hex signature", () => {
    const body = callbackBody();
    expect(provider().verifyCallback(body, headers(sign(body).toUpperCase())).ok).toBe(true);
  });

  it("refuses to verify anything when the provider is unconfigured", () => {
    // No private key means no way to authenticate a callback — it must not be treated as valid.
    const body = callbackBody();
    const result = provider({ privateKey: "" }).verifyCallback(body, headers(sign(body)));
    expect(result).toEqual({ ok: false, reason: "provider_unconfigured" });
  });

  it("rejects an event type it does not handle", () => {
    const body = callbackBody();
    const result = provider().verifyCallback(body, headers(sign(body), "payout_status"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupported_event:payout_status");
  });

  it("tolerates a callback with no event header", () => {
    const body = callbackBody();
    const noEvent = new Headers({ "x-callback-signature": sign(body) });
    expect(provider().verifyCallback(body, noEvent).ok).toBe(true);
  });

  it("reports an unreadable payload separately from a bad signature", () => {
    // Correctly signed, but not JSON we can act on. Distinguishing the two keeps the audit log
    // honest about whether authentication or interpretation failed.
    const body = "not json at all";
    expect(provider().verifyCallback(body, headers(sign(body)))).toEqual({
      ok: false,
      reason: "payload_unreadable",
    });
    const missingFields = JSON.stringify({ reference: "X" });
    expect(provider().verifyCallback(missingFields, headers(sign(missingFields)))).toEqual({
      ok: false,
      reason: "payload_unreadable",
    });
  });

  it("verifies the exact bytes, so re-serialising the same object breaks it", () => {
    // Why the seam takes a raw string: key order and whitespace are part of what was signed.
    const body = callbackBody();
    const reserialised = JSON.stringify({ ...JSON.parse(body), extra: null });
    expect(provider().verifyCallback(reserialised, headers(sign(body))).ok).toBe(false);
  });
});

describe("verifyCallback — event mapping", () => {
  it("recovers the order amount net of a customer-borne fee", () => {
    // total_amount is what the payer sent; the order was still Rp5.000.
    const body = callbackBody({ total_amount: 5_750, fee_customer: 750 });
    const result = provider().verifyCallback(body, headers(sign(body)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.amountIdr).toBe(UNLIMITED_PRICE_IDR);
    expect(result.event.grossAmountIdr).toBe(5_750);
  });

  it("treats a missing fee as zero", () => {
    const body = JSON.stringify({
      reference: "DEV-1",
      merchant_ref: ORDER,
      status: "PAID",
      total_amount: UNLIMITED_PRICE_IDR,
    });
    const result = provider().verifyCallback(body, headers(sign(body)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.amountIdr).toBe(UNLIMITED_PRICE_IDR);
    expect(result.event.method).toBeNull();
    expect(result.event.paidAt).toBeNull();
  });

  it("converts paid_at from unix seconds", () => {
    const body = callbackBody({ paid_at: 1_787_000_000 });
    const result = provider().verifyCallback(body, headers(sign(body)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.paidAt?.getTime()).toBe(1_787_000_000_000);
  });
});

describe("normaliseStatus", () => {
  const { normaliseStatus } = __testables;

  it("maps the documented provider statuses", () => {
    expect(normaliseStatus("PAID")).toBe("paid");
    expect(normaliseStatus("FAILED")).toBe("failed");
    expect(normaliseStatus("EXPIRED")).toBe("expired");
    expect(normaliseStatus("REFUND")).toBe("refund");
    expect(normaliseStatus("UNPAID")).toBe("pending");
  });

  it("is insensitive to case and surrounding whitespace", () => {
    expect(normaliseStatus("  paid  ")).toBe("paid");
    expect(normaliseStatus("Paid")).toBe("paid");
  });

  it("falls back to pending for anything unrecognised, never to paid", () => {
    for (const raw of ["", "SETTLED", "SUCCESS", "COMPLETE", "paid-ish", "0"]) {
      expect(normaliseStatus(raw)).toBe("pending");
    }
  });
});

describe("fromUnixSeconds", () => {
  const { fromUnixSeconds } = __testables;

  it("returns null for the values the provider uses to mean 'unset'", () => {
    for (const value of [0, null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fromUnixSeconds(value)).toBeNull();
    }
  });

  it("converts seconds to milliseconds", () => {
    expect(fromUnixSeconds(1_787_000_000)?.toISOString()).toBe(
      new Date(1_787_000_000_000).toISOString(),
    );
  });
});

describe("createCharge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown, status = 200) {
    // Typed with the argument list so `mock.calls[0]` is indexable: the request URL and body
    // are what several of these assertions are actually about.
    const spy = vi.fn(async (..._args: unknown[]) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  const input = {
    orderId: ORDER,
    amountIdr: UNLIMITED_PRICE_IDR,
    itemName: "Unlimited access",
    customerName: "Demo",
    customerEmail: "demo@relayn.dev",
    returnUrl: "http://localhost:3200/subscription",
  };

  it("refuses to charge when the provider is unconfigured, naming the env vars", async () => {
    const spy = stubFetch({});
    await expect(provider({ apiKey: "" }).createCharge(input)).rejects.toThrow(
      PaymentProviderError,
    );
    await expect(provider({ apiKey: "" }).createCharge(input)).rejects.toThrow(/TRIPAY_API_KEY/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends the server-decided amount and a request signature, never a client figure", async () => {
    const spy = stubFetch({
      success: true,
      data: {
        reference: "DEV-T1",
        merchant_ref: ORDER,
        amount: UNLIMITED_PRICE_IDR,
        payment_method_code: "QRIS",
        qr_string: "00020101021226…",
        expired_time: 1_787_000_000,
        status: "UNPAID",
      },
    });

    const result = await provider().createCharge(input);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://tripay.co.id/api-sandbox/transaction/create");
    const sent = JSON.parse(String(init.body));
    expect(sent.amount).toBe(UNLIMITED_PRICE_IDR);
    expect(sent.merchant_ref).toBe(ORDER);
    expect(sent.method).toBe("QRIS");
    expect(sent.signature).toBe(
      createHmac("sha256", PRIVATE_KEY)
        .update(`T1234${ORDER}${UNLIMITED_PRICE_IDR}`)
        .digest("hex"),
    );
    expect(result.reference).toBe("DEV-T1");
    expect(result.qrString).toBe("00020101021226…");
    expect(result.amountIdr).toBe(UNLIMITED_PRICE_IDR);
    expect(result.expiresAt?.getTime()).toBe(1_787_000_000_000);
  });

  it("uses the production base URL only in production mode", async () => {
    const spy = stubFetch({
      success: true,
      data: { reference: "DEV-T1", merchant_ref: ORDER, amount: UNLIMITED_PRICE_IDR },
    });
    await provider({ mode: "production" }).createCharge(input);
    expect(String(spy.mock.calls[0]![0])).toBe("https://tripay.co.id/api/transaction/create");
  });

  it("refuses a response that echoes a different merchant reference", async () => {
    // Never bind a provider reference to an order we did not just create.
    stubFetch({
      success: true,
      data: { reference: "DEV-T1", merchant_ref: "SOMEONE-ELSES-ORDER", amount: UNLIMITED_PRICE_IDR },
    });
    await expect(provider().createCharge(input)).rejects.toThrow(/different merchant reference/);
  });

  it("surfaces a provider rejection without echoing an unbounded upstream body", async () => {
    stubFetch({ success: false, message: "x".repeat(500) }, 422);
    await expect(provider().createCharge(input)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect((error as PaymentProviderError).message.length).toBeLessThanOrEqual(200);
      return true;
    });
  });

  it("reports an unreadable response as a provider error, not a crash", async () => {
    stubFetch("<html>gateway timeout</html>", 504);
    await expect(provider().createCharge(input)).rejects.toThrow(/unreadable response/);
  });
});
