/**
 * GET /api/subscription — current plan, allocation, and the one-time purchase offer.
 *
 * **Read-only, deliberately.** There is no `PATCH`: the only plan a user can obtain is
 * `unlimited`, and the only things that grant it are a signature-verified provider callback
 * (`/api/payments/callback`) and a chain-verified transfer (`/api/payments/crypto/verify`).
 * Both read the amount, recipient and payer from the provider or the blockchain — never from a
 * request body.
 *
 * A self-serve plan switch used to live here to back the Free/Pro/Business picker. Both are gone.
 * Leaving the mutator behind a removed UI would have meant any signed-in caller could `curl`
 * themselves onto a 25M-token tier for free, which is the exact thing the payment design exists to
 * prevent. Unlisted verbs return 405 from the framework, so this file needs no extra guard.
 */
import { apiRoute, ok } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { getSubscription } from "@/server/services/subscription-service";

export const GET = apiRoute(async () => {
  const { user } = await requireUser();
  return ok(await getSubscription(user));
});
