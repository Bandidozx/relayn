/**
 * DELETE /api/admin/models/removed/:id — lift a deletion, so sync may create the row again.
 *
 * DELETE rather than POST because that is what it does: the resource this addresses is the
 * suppression in `removed_models`, and removing it is the whole operation. It does not recreate the
 * model — prices and context windows belong to the upstream, so the row comes back from the next
 * catalogue sync with current numbers, or not at all if the upstream has since dropped it.
 *
 * `:id` is the `removed_models.id` handle. No conflict with `/api/admin/models/:id`: a static
 * segment wins over a sibling dynamic one, and this route is a segment deeper regardless.
 */
import { apiRoute, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/guards";
import { restoreRemovedModel } from "@/server/services/admin-service";

export const DELETE = apiRoute<{ id: string }>(async (request, { params }) => {
  const { user } = await requireAdmin();
  const { id } = await params;

  return ok(await restoreRemovedModel({ id: user.id, email: user.email }, id, request));
});
