/** POST /api/auth/logout — revoke the current session and clear its cookies. */
import { apiRoute, ok } from "@/lib/api/http";
import { recordAudit } from "@/lib/audit";
import { destroyCurrentSession, getSession } from "@/lib/auth/session";
import { clearCsrfToken } from "@/lib/security/csrf";

export const POST = apiRoute(async (request) => {
  const session = await getSession();
  await destroyCurrentSession();
  await clearCsrfToken();

  if (session) {
    await recordAudit({
      action: "auth.logout",
      userId: session.user.id,
      actorEmail: session.user.email,
      request,
    });
  }

  return ok({ signedOut: true });
});
