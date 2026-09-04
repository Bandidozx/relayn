/**
 * DELETE /api/profile/connections/:provider — unlink a third-party sign-in.
 *
 * Scoped to the caller's own row, so the `:provider` segment cannot reach anyone else's
 * link. The service refuses to remove the last remaining way into an account.
 */
import { apiRoute, notFound, ok } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { unlinkOAuthAccount } from "@/server/services/oauth-service";
import { getProfile } from "@/server/services/profile-service";

interface Params {
  provider: string;
}

export const DELETE = apiRoute<Params>(async (request, { params }) => {
  const { user } = await requireUser();
  const { provider } = await params;

  await unlinkOAuthAccount(user, provider, request);

  const profile = await getProfile(user.id);
  if (!profile) throw notFound("Account not found.");
  return ok({ profile });
});
