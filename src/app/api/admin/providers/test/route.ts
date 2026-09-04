/**
 * POST /api/admin/providers/test — probe one upstream with the credential it is configured
 * with and report what came back.
 *
 * Read-only against our own state: it stores nothing and changes nothing, so it is safe to
 * press before committing a catalogue sync. The response carries the health state, the number
 * of models on offer and a short sample of their ids — never the credential.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { adminProviderTestSchema } from "@/lib/api/schemas";
import { requireAdmin } from "@/lib/auth/guards";
import { testProvider } from "@/server/services/admin-service";

export const POST = apiRoute(async (request) => {
  const { user } = await requireAdmin();
  const { provider } = await parseJson(request, adminProviderTestSchema);

  const result = await testProvider({ id: user.id, email: user.email }, provider, request);
  return ok(result);
});
