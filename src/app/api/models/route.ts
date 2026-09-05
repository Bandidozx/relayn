/** GET /api/models — catalogue with per-plan availability for the signed-in user. */
import { apiRoute, ok } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { listModelsForUser } from "@/server/services/models-service";

export const GET = apiRoute(async () => {
  const { user } = await requireUser();
  return ok(await listModelsForUser(user));
});
