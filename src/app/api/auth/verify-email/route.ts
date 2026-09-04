/** POST /api/auth/verify-email — consume an email-verification token. */
import { apiRoute, clientIp, ok, parseJson, tooManyRequests } from "@/lib/api/http";
import { z } from "zod";
import { authRateLimit } from "@/lib/security/rate-limit";
import { verifyEmailToken } from "@/server/services/auth-service";

const schema = z.object({ token: z.string().min(20).max(200) });

export const POST = apiRoute(async (request) => {
  const limit = authRateLimit(clientIp(request), "verify");
  if (!limit.allowed) return tooManyRequests(limit);

  const { token } = await parseJson(request, schema);
  await verifyEmailToken(token, request);

  return ok({ verified: true });
});
