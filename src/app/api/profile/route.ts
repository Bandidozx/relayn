/**
 * GET    /api/profile — account facts + a few counters.
 * PATCH  /api/profile — display name and avatar URL.
 * DELETE /api/profile — soft-delete the account (password confirmation required).
 */
import { apiRoute, notFound, ok, parseJson } from "@/lib/api/http";
import { deleteAccountSchema, updateProfileSchema } from "@/lib/api/schemas";
import { requireUser } from "@/lib/auth/guards";
import { clearCsrfToken } from "@/lib/security/csrf";
import { deleteAccount } from "@/server/services/auth-service";
import { getProfile, updateProfile } from "@/server/services/profile-service";

export const GET = apiRoute(async () => {
  const { user } = await requireUser();
  const profile = await getProfile(user.id);
  if (!profile) throw notFound("Account not found.");
  return ok({ profile });
});

export const PATCH = apiRoute(async (request) => {
  const { user } = await requireUser();
  const body = await parseJson(request, updateProfileSchema);
  const profile = await updateProfile(user.id, body, request, user.email);
  if (!profile) throw notFound("Account not found.");
  return ok({ profile });
});

export const DELETE = apiRoute(async (request) => {
  const { user } = await requireUser();
  const body = await parseJson(request, deleteAccountSchema);

  await deleteAccount(user, { password: body.password, confirmEmail: body.confirmEmail }, request);
  await clearCsrfToken();

  return ok({ deleted: true });
});
