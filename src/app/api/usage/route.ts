/** GET /api/usage — filtered, sorted, paginated usage log for the signed-in user. */
import { apiRoute, ok } from "@/lib/api/http";
import { usageQuerySchema } from "@/lib/api/schemas";
import { requireUser } from "@/lib/auth/guards";
import { listUsage } from "@/server/services/usage-service";

export const GET = apiRoute(async (request) => {
  const { user } = await requireUser();
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const query = usageQuerySchema.parse(params);

  return ok(await listUsage(user.id, query));
});
