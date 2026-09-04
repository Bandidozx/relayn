/**
 * GET /api/payments/:orderId — payment status for the signed-in owner.
 *
 * This is the endpoint the payment page polls while the QR is on screen. Two properties
 * matter:
 *
 *  - The lookup is `findFirst({ where: { orderId, userId } })`, so another account's order id
 *    is a 404 and never reveals that the order exists. Same shape as `/api/usage/:id`.
 *  - When the order is still pending it may trigger one throttled server-to-server status read
 *    (at most one per 5s per order), which routes through the same verification and idempotency
 *    gate as a signed callback. Polling therefore cannot activate an account on weaker evidence
 *    than the webhook needs — it just closes the gap when a callback is lost.
 */
import { apiRoute, ok, tooManyRequests } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { rateLimit } from "@/lib/security/rate-limit";
import { getPaymentForUser } from "@/server/services/payment-service";

export const GET = apiRoute<{ orderId: string }>(async (_request, { params }) => {
  const { user } = await requireUser();
  const { orderId } = await params;

  // Generous: a 3s poll is 20 reads a minute and legitimate.
  const limit = rateLimit(`payments:read:${user.id}`, 60);
  if (!limit.allowed) return tooManyRequests(limit);

  return ok({ payment: await getPaymentForUser(user.id, orderId) });
});
