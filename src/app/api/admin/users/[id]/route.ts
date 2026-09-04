/**
 * PATCH /api/admin/users/:id — suspend, reactivate, grant or revoke admin.
 *
 * Suspending revokes the target's sessions immediately. Admins cannot act on themselves,
 * and the last remaining active administrator cannot be demoted.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { adminUserActionSchema } from "@/lib/api/schemas";
import { requireAdmin } from "@/lib/auth/guards";
import { applyUserAction, listUsers } from "@/server/services/admin-service";

export const PATCH = apiRoute<{ id: string }>(async (request, { params }) => {
  const { user } = await requireAdmin();
  const { id } = await params;
  const body = await parseJson(request, adminUserActionSchema);

  await applyUserAction({ id: user.id, email: user.email }, id, body.action, request);

  return ok(await listUsers({ page: 1, pageSize: 25 }));
});
