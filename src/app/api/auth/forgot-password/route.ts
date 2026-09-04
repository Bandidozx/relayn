/**
 * POST /api/auth/forgot-password — start a password reset.
 *
 * Always returns 200 with the same body: the response must not reveal whether an address
 * is registered. With no mail transport configured the link is written to the server log,
 * and in development the token is returned so the flow is completable locally.
 */
import { apiRoute, clientIp, ok, parseJson, tooManyRequests } from "@/lib/api/http";
import { forgotPasswordSchema } from "@/lib/api/schemas";
import { authRateLimit } from "@/lib/security/rate-limit";
import { requestPasswordReset } from "@/server/services/auth-service";

export const POST = apiRoute(async (request) => {
  const limit = authRateLimit(clientIp(request), "forgot");
  if (!limit.allowed) return tooManyRequests(limit);

  const { email } = await parseJson(request, forgotPasswordSchema);
  const outcome = await requestPasswordReset(email, request);

  return ok({
    sent: true,
    message: "If that address has an account, a reset link is on its way.",
    ...(outcome.devToken ? { devToken: outcome.devToken } : {}),
  });
});
