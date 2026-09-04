/** POST /api/auth/login — verify credentials and mint a fresh session. */
import { apiRoute, clientIp, ok, parseJson, tooManyRequests } from "@/lib/api/http";
import { loginSchema } from "@/lib/api/schemas";
import { rotateCsrfToken } from "@/lib/security/csrf";
import { authRateLimit } from "@/lib/security/rate-limit";
import { loginUser } from "@/server/services/auth-service";

export const POST = apiRoute(async (request) => {
  // Per-IP throttle so a stolen password list cannot be replayed quickly.
  const limit = authRateLimit(clientIp(request), "login");
  if (!limit.allowed) return tooManyRequests(limit);

  const body = await parseJson(request, loginSchema);
  const user = await loginUser(body, request);
  // New token at the authentication boundary, so a pre-login value cannot be reused.
  await rotateCsrfToken();

  return ok({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});
