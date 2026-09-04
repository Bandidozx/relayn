/**
 * PATCH /api/profile/password — change password.
 *
 * Every other session is revoked by default, so a stolen cookie elsewhere stops working
 * the moment the owner rotates their password.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { changePasswordSchema } from "@/lib/api/schemas";
import { requireUser } from "@/lib/auth/guards";
import { changePassword } from "@/server/services/auth-service";

export const PATCH = apiRoute(async (request) => {
  const { user, sessionId } = await requireUser();
  const body = await parseJson(request, changePasswordSchema);

  await changePassword(user, body, { sessionId, request });

  return ok({ changed: true, signedOutOtherSessions: body.signOutEverywhere !== false });
});
