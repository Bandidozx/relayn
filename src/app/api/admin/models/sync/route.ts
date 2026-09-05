/**
 * POST /api/admin/models/sync — pull each configured upstream's current catalogue into
 * `models`. Admin-only and audit-logged; the response carries the refreshed model list so
 * the admin table can replace its state without a second round trip.
 */
import { apiRoute, badRequest, ok } from "@/lib/api/http";
import { adminModelSyncSchema } from "@/lib/api/schemas";
import { requireAdmin } from "@/lib/auth/guards";
import { syncAdminModels } from "@/server/services/admin-service";

export const POST = apiRoute(async (request) => {
  const { user } = await requireAdmin();

  // The body is optional: the button sends nothing, a targeted sync sends `{providers:[…]}`.
  const raw = (await request.text()).trim();
  let parsed: { providers?: string[] | undefined } = {};
  if (raw.length > 0) {
    try {
      parsed = adminModelSyncSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (error instanceof SyntaxError) throw badRequest("Request body must be valid JSON.");
      throw error;
    }
  }

  const { models, removed, summary } = await syncAdminModels(
    { id: user.id, email: user.email },
    parsed.providers,
    request,
  );
  return ok({ models, removed, summary });
});
