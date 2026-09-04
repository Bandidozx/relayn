/** PATCH /api/admin/users/:id/subscription — override plan, status or allocation. */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { adminSubscriptionSchema } from "@/lib/api/schemas";
import { requireAdmin } from "@/lib/auth/guards";
import { listUsers, updateUserSubscription } from "@/server/services/admin-service";

export const PATCH = apiRoute<{ id: string }>(async (request, { params }) => {
  const { user } = await requireAdmin();
  const { id } = await params;
  const body = await parseJson(request, adminSubscriptionSchema);

  await updateUserSubscription({ id: user.id, email: user.email }, id, body, request);

  return ok(await listUsers({ page: 1, pageSize: 25 }));
});
