/**
 * GET  /api/admin/models — full catalogue including disabled entries.
 * POST /api/admin/models — add a catalogue row by hand.
 *
 * The POST exists for what sync cannot reach: an upstream with no `/models` endpoint, a model an
 * aggregator serves without advertising, or an id an operator wants to republish under their own
 * name. Unless `test: false` is sent, the upstream is asked to serve one token before the row is
 * written, so a dead id fails here rather than for a paying caller later.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { adminModelCreateSchema } from "@/lib/api/schemas";
import { requireAdmin } from "@/lib/auth/guards";
import { createManualModel, listAdminModels } from "@/server/services/admin-service";

export const GET = apiRoute(async () => {
  await requireAdmin();
  return ok({ models: await listAdminModels() });
});

export const POST = apiRoute(async (request) => {
  const { user } = await requireAdmin();
  const body = await parseJson(request, adminModelCreateSchema);

  const result = await createManualModel({ id: user.id, email: user.email }, body, request);
  return ok(result, { status: 201 });
});
