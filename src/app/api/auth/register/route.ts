/** POST /api/auth/register — create an account and sign in. */
import { apiRoute, clientIp, ok, parseJson, tooManyRequests } from "@/lib/api/http";
import { registerSchema } from "@/lib/api/schemas";
import { rotateCsrfToken } from "@/lib/security/csrf";
import { authRateLimit } from "@/lib/security/rate-limit";
import { registerUser } from "@/server/services/auth-service";

export const POST = apiRoute(async (request) => {
  const limit = authRateLimit(clientIp(request), "register");
  if (!limit.allowed) return tooManyRequests(limit);

  const body = await parseJson(request, registerSchema);
  const user = await registerUser(body, request);
  // New token at the authentication boundary, so a pre-login value cannot be reused.
  await rotateCsrfToken();

  return ok({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});
