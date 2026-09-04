/**
 * GET   /api/subscription — current plan, allocation and the plan catalogue.
 * PATCH /api/subscription — self-serve plan change.
 *
 * No payment processing is wired up (per the brief). The plan switch is immediate and
 * audited; `Subscription.externalRef` is the seam for a real billing provider.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { changePlanSchema } from "@/lib/api/schemas";
import { requireUser } from "@/lib/auth/guards";
import { changePlan, getSubscription } from "@/server/services/subscription-service";

export const GET = apiRoute(async () => {
  const { user } = await requireUser();
  return ok(await getSubscription(user.id));
});

export const PATCH = apiRoute(async (request) => {
  const { user } = await requireUser();
  const body = await parseJson(request, changePlanSchema);

  return ok(await changePlan(user.id, body.plan, request, user.email));
});
