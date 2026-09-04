/**
 * GET  /api/integrations — saved integrations for the caller.
 * POST /api/integrations — save one. Only the key *id* is stored, never a secret.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { upsertIntegrationSchema } from "@/lib/api/schemas";
import { requireUser } from "@/lib/auth/guards";
import { createIntegration, listIntegrations } from "@/server/services/integrations-service";

export const GET = apiRoute(async () => {
  const { user } = await requireUser();
  return ok({ integrations: await listIntegrations(user.id) });
});

export const POST = apiRoute(async (request) => {
  const { user } = await requireUser();
  const body = await parseJson(request, upsertIntegrationSchema);
  const integrations = await createIntegration(user.id, body, request, user.email);

  return ok({ integrations }, { status: 201 });
});
