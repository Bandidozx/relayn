/**
 * GET /api/metrics/overview — every number on the dashboard.
 *
 * All values are aggregated from `usage_logs`; nothing is hardcoded. `?days=` selects the
 * trend window (7, 14 or 30).
 */
import { apiRoute, ok } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { getOverview } from "@/lib/usage/metrics";

const ALLOWED_WINDOWS = new Set([7, 14, 30]);

export const GET = apiRoute(async (request) => {
  const { user } = await requireUser();
  const raw = Number.parseInt(new URL(request.url).searchParams.get("days") ?? "14", 10);
  const days = ALLOWED_WINDOWS.has(raw) ? raw : 14;

  return ok(await getOverview(user.id, days));
});
