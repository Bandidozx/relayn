/**
 * PATCH  /api/keys/:id — rename.
 * DELETE /api/keys/:id — revoke (irreversible; the secret can never be re-issued).
 *
 * Both operations filter on the caller's userId, so another tenant's id yields 404.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { renameApiKeySchema } from "@/lib/api/schemas";
import { requireUser } from "@/lib/auth/guards";
import { listApiKeys, renameApiKey, revokeApiKey } from "@/server/services/keys-service";

interface Params {
  id: string;
}

export const PATCH = apiRoute<Params>(async (request, { params }) => {
  const { user } = await requireUser();
  const { id } = await params;
  const body = await parseJson(request, renameApiKeySchema);

  await renameApiKey(user.id, id, body.name);
  return ok({ keys: await listApiKeys(user.id) });
});

export const DELETE = apiRoute<Params>(async (request, { params }) => {
  const { user } = await requireUser();
  const { id } = await params;

  await revokeApiKey(user.id, id, request, user.email);
  return ok({ keys: await listApiKeys(user.id) });
});
