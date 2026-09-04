/**
 * `/api/admin/providers` — upstream provider status, and registration of new ones.
 *
 * GET reports whether each provider has a credential; the credential value itself is never
 * read into the response, so it cannot reach the browser. POST registers a runtime-added
 * upstream, sealing its API key before it is stored.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { adminProviderCreateSchema } from "@/lib/api/schemas";
import { requireAdmin } from "@/lib/auth/guards";
import { createCustomProvider, listAdminProviders } from "@/server/services/admin-service";

export const GET = apiRoute(async () => {
  await requireAdmin();
  return ok({ providers: await listAdminProviders() });
});

export const POST = apiRoute(async (request) => {
  const { user } = await requireAdmin();
  const body = await parseJson(request, adminProviderCreateSchema);

  const result = await createCustomProvider({ id: user.id, email: user.email }, body, request);
  return ok(result, { status: 201 });
});
