/** GET /api/admin/stats — platform-wide counters. Admin only, enforced server-side. */
import { apiRoute, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/guards";
import { getAdminStats } from "@/server/services/admin-service";

export const GET = apiRoute(async () => {
  await requireAdmin();
  return ok(await getAdminStats());
});
