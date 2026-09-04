/** POST /api/auth/reset-password — consume a reset token and set a new password. */
import { apiRoute, clientIp, ok, parseJson, tooManyRequests } from "@/lib/api/http";
import { resetPasswordSchema } from "@/lib/api/schemas";
import { authRateLimit } from "@/lib/security/rate-limit";
import { resetPassword } from "@/server/services/auth-service";

export const POST = apiRoute(async (request) => {
  const limit = authRateLimit(clientIp(request), "reset");
  if (!limit.allowed) return tooManyRequests(limit);

  const body = await parseJson(request, resetPasswordSchema);
  await resetPassword(body, request);

  // Every session is dropped by the service, so the user signs in again deliberately.
  return ok({ reset: true });
});
