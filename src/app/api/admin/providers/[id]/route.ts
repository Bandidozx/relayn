/**
 * PATCH/DELETE /api/admin/providers/:id — edit or remove a stored provider row.
 *
 * `:id` is `provider_configs.id`, not the provider slug: a row has to have been created before
 * it can be addressed, so no request can reach a provider by guessing its name. Admin-only and
 * audit-logged; the credential is sealed by the service layer and never echoed back.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { adminProviderUpdateSchema } from "@/lib/api/schemas";
import { requireAdmin } from "@/lib/auth/guards";
import { deleteCustomProvider, updateProviderConfig } from "@/server/services/admin-service";

export const PATCH = apiRoute<{ id: string }>(async (request, { params }) => {
  const { user } = await requireAdmin();
  const { id } = await params;
  const body = await parseJson(request, adminProviderUpdateSchema);

  const providers = await updateProviderConfig(
    { id: user.id, email: user.email },
    id,
    body,
    request,
  );
  return ok({ providers });
});

export const DELETE = apiRoute<{ id: string }>(async (request, { params }) => {
  const { user } = await requireAdmin();
  const { id } = await params;

  const providers = await deleteCustomProvider({ id: user.id, email: user.email }, id, request);
  return ok({ providers });
});
