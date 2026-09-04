/**
 * GET  /api/keys — list the caller's keys (masked; the secret is unrecoverable).
 * POST /api/keys — mint a new key. The plaintext secret is in this response only.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { createApiKeySchema } from "@/lib/api/schemas";
import { requireUser } from "@/lib/auth/guards";
import { createApiKey, listApiKeys } from "@/server/services/keys-service";

export const GET = apiRoute(async () => {
  const { user } = await requireUser();
  return ok({ keys: await listApiKeys(user.id) });
});

export const POST = apiRoute(async (request) => {
  const { user } = await requireUser();
  const body = await parseJson(request, createApiKeySchema);
  const created = await createApiKey(user.id, body.name, request, user.email);

  return ok(
    {
      key: created.key,
      // Shown once in the UI, then discarded client-side. Never persisted in plaintext.
      secret: created.secret,
      keys: await listApiKeys(user.id),
    },
    { status: 201 },
  );
});
