/**
 * PATCH  /api/admin/models/:id — enable/disable, retier, reprice, describe or re-chain a model.
 * DELETE /api/admin/models/:id — remove a hand-added row.
 *
 * Only `manual` rows can be deleted: a synced row would be recreated by the next sync run, so
 * the service refuses it and points the operator at "disable" instead.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { adminModelSchema } from "@/lib/api/schemas";
import { requireAdmin } from "@/lib/auth/guards";
import { deleteManualModel, updateAdminModel } from "@/server/services/admin-service";

export const PATCH = apiRoute<{ id: string }>(async (request, { params }) => {
  const { user } = await requireAdmin();
  const { id } = await params;
  const body = await parseJson(request, adminModelSchema);

  const models = await updateAdminModel({ id: user.id, email: user.email }, id, body, request);
  return ok({ models });
});

export const DELETE = apiRoute<{ id: string }>(async (request, { params }) => {
  const { user } = await requireAdmin();
  const { id } = await params;

  const models = await deleteManualModel({ id: user.id, email: user.email }, id, request);
  return ok({ models });
});
