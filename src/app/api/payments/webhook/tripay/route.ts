/**
 * POST /api/payments/webhook/tripay — provider callback.
 *
 * Deliberately **not** wrapped in `apiRoute`. `apiRoute` enforces CSRF (matching `Origin` plus
 * a header echoing the `relayn_csrf` cookie), which a server-to-server callback has no way to
 * satisfy and no need to: its authenticity comes from the HMAC over the body, which is strictly
 * stronger than an origin check. `src/proxy.ts` already excludes `/api/*` from the CSRF cookie
 * issuance path, so nothing here depends on session state.
 *
 * Order of operations, in this exact sequence:
 *
 *   1. read the raw body as text — never `request.json()`, because the signature covers the
 *      exact bytes and a parse-then-reserialise would authenticate a different string than the
 *      one we act on;
 *   2. verify `X-Callback-Signature` against `HMAC-SHA256(rawBody, TRIPAY_PRIVATE_KEY)` in
 *      constant time, and the `X-Callback-Event` header;
 *   3. only then parse, and re-derive every decision from our own `Payment` row.
 *
 * Response policy is chosen around TriPay's retry behaviour (3 attempts, 2 minutes apart):
 *
 *   - bad or missing signature → 401. A forged callback is never acknowledged, and the failure
 *     is visible in the provider's callback log.
 *   - accepted (activated, replayed, still-unpaid, or terminal-failure) → 200 `{"success":true}`.
 *   - contradicts our records (unknown order, wrong amount, wrong reference) → 200 with a note.
 *     A retry cannot fix any of these, so re-delivery would only repeat the audit entry.
 *   - unexpected server error → 500, so the provider retries and we do not silently lose a
 *     payment that our own database was briefly unable to record.
 */
import { fail, ok } from "@/lib/api/http";
import { recordAudit } from "@/lib/audit";
import { getPaymentProvider } from "@/lib/payments/registry";
import { applyVerifiedPayment } from "@/server/services/payment-service";

/** A `payment_status` callback is well under 4KB. Anything larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  const provider = getPaymentProvider("tripay");
  if (!provider) {
    return fail(404, "not_found", "This deployment has no TriPay adapter.");
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return fail(400, "bad_request", "Unreadable request body.");
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    return fail(413, "payload_too_large", "Callback body is too large.");
  }

  // Authentication happens here, before any interpretation of the payload.
  const verification = provider.verifyCallback(rawBody, request.headers);
  if (!verification.ok) {
    // Reason strings are fixed vocabulary from the adapter — no payload content, no key
    // material, and no raw body. The body is deliberately not logged even on failure.
    console.warn(`[relayn] tripay callback rejected: ${verification.reason}`);
    await recordAudit({
      action: "payment.rejected",
      targetType: "payment",
      metadata: { reason: verification.reason, source: "callback", provider: provider.id },
      request,
    });
    return fail(401, "invalid_signature", "Callback could not be authenticated.");
  }

  try {
    const result = await applyVerifiedPayment({
      providerId: provider.id,
      event: verification.event,
      source: "callback",
      request,
    });

    if (!result.accepted) {
      // Audited inside the service. Acknowledged so the provider stops retrying something a
      // retry cannot change.
      return ok({ success: true, note: result.reason });
    }

    // TriPay treats any 200 with `success: true` as delivered.
    return ok({ success: true });
  } catch (error) {
    console.error("[relayn] tripay callback processing failed:", error);
    // Non-2xx on purpose: let the provider retry rather than drop a real payment.
    return fail(500, "internal_error", "Could not process the callback. Retry.");
  }
}
