/**
 * PUT /api/admin/providers/proxy — set or clear the outbound proxy list for one upstream.
 *
 * Addressed by registry id rather than `provider_configs.id` because the providers that need
 * this most are builtins, which may have no row yet — the service upserts one. The list is
 * sealed like a credential (a proxy URL usually carries `user:password`), and only a redacted
 * hint and a count ever come back. An empty `proxies` string returns the provider to direct
 * egress.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { adminProviderProxySchema } from "@/lib/api/schemas";
import { requireAdmin } from "@/lib/auth/guards";
import { setProviderProxies } from "@/server/services/admin-service";

export const PUT = apiRoute(async (request) => {
  const { user } = await requireAdmin();
  const { provider, proxies } = await parseJson(request, adminProviderProxySchema);

  const result = await setProviderProxies(
    { id: user.id, email: user.email },
    provider,
    proxies,
    request,
  );
  return ok(result);
});
