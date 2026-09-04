/**
 * POST /api/payments/checkout — start (or resume) the one-time unlimited purchase.
 *
 * The handler reads **nothing** from the request body. There is no schema to parse because
 * there is no input: the plan and the amount come from `src/lib/plans.ts`, and the user comes
 * from the verified session. That is the structural answer to "amount tidak boleh berasal dari
 * frontend" and "userId tidak boleh berasal dari frontend" — not a validation rule that could
 * be relaxed later, but an absent parameter.
 *
 * Rate-limited per user because each call may create an upstream transaction.
 */
import { apiRoute, ok, tooManyRequests } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { rateLimit } from "@/lib/security/rate-limit";
import { startUnlimitedCheckout } from "@/server/services/payment-service";

export const POST = apiRoute(async (request) => {
  const { user } = await requireUser();

  const limit = rateLimit(`payments:checkout:${user.id}`, 6);
  if (!limit.allowed) return tooManyRequests(limit);

  const payment = await startUnlimitedCheckout(
    user.id,
    { email: user.email, name: user.name },
    request,
  );

  return ok({ payment });
});
