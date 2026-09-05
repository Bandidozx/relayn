/**
 * PATCH  /api/admin/models/:id — enable/disable, retier, reprice, describe or re-chain a model.
 * DELETE /api/admin/models/:id — remove a catalogue row.
 *
 * Any row may be deleted, hand-added or synced. A synced id is recorded in `removed_models` in the
 * same transaction, which is what stops the next sync from creating it again; the response carries
 * the refreshed removed list so the table can show where the row went, and `DELETE
 * /api/admin/models/removed/:id` puts it back in scope.
 *
 * `:id` is the `models.id` row handle, not the public model id, and the row is looked up by it
 * directly — there is no per-user scope to enforce here because the catalogue is global, but the
 * `requireAdmin()` gate is what makes that safe.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { adminModelSchema } from "@/lib/api/schemas";
import { requireAdmin } from "@/lib/auth/guards";
import { deleteCatalogueModel, updateAdminModel } from "@/server/services/admin-service";

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

  return ok(await deleteCatalogueModel({ id: user.id, email: user.email }, id, request));
});
