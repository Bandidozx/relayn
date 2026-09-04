/** GET /api/admin/users — searchable, paginated user directory. Admin only. */
import { z } from "zod";
import { apiRoute, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/guards";
import { listUsers } from "@/server/services/admin-service";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
});

export const GET = apiRoute(async (request) => {
  await requireAdmin();
  const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));

  return ok(await listUsers(query));
});
