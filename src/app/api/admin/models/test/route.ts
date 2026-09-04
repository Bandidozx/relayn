/**
 * POST /api/admin/models/test — ask one upstream to serve one token from a model id.
 *
 * A one-token completion rather than a catalogue lookup, because `/models` answers the wrong
 * question: several aggregators list ids they cannot serve, and at least one serves ids it does
 * not list. Stores nothing, so it is safe to press repeatedly while filling in the add-model
 * form; the cost is a single token on the operator's own upstream account.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { adminModelTestSchema } from "@/lib/api/schemas";
import { requireAdmin } from "@/lib/auth/guards";
import { testModelUpstream } from "@/server/services/admin-service";

export const POST = apiRoute(async (request) => {
  const { user } = await requireAdmin();
  const { provider, model } = await parseJson(request, adminModelTestSchema);

  const result = await testModelUpstream(
    { id: user.id, email: user.email },
    provider,
    model,
    request,
  );
  return ok(result);
});
