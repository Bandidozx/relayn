/**
 * GET /api/usage/:id — one usage record.
 *
 * This is the endpoint the brief called out for IDOR: the lookup is
 * `findFirst({ where: { id, userId } })`, so substituting another tenant's id returns 404
 * and never leaks the row's existence.
 */
import { apiRoute, ok } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { getUsageDetail } from "@/server/services/usage-service";

export const GET = apiRoute<{ id: string }>(async (_request, { params }) => {
  const { user } = await requireUser();
  const { id } = await params;

  return ok({ record: await getUsageDetail(user.id, id) });
});
