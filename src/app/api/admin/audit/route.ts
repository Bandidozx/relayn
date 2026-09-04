/** GET /api/admin/audit — paginated security trail. */
import { z } from "zod";
import { apiRoute, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/guards";
import { listAuditLog } from "@/server/services/admin-service";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
  action: z.string().trim().max(80).optional(),
});

export const GET = apiRoute(async (request) => {
  await requireAdmin();
  const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));

  return ok(await listAuditLog(query));
});
