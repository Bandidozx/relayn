/**
 * POST /api/payments/crypto/verify — verify a pasted transaction hash on-chain.
 *
 * The body carries exactly one field, `txHash`, and it is an identifier rather than a claim.
 * Everything the activation decision rests on is read from a JSON-RPC node inside the service:
 * the chain id, the token contract, the recipient, the amount, the confirmation count and
 * whether the transaction succeeded at all. There is no parameter here for an amount, a
 * recipient, a sender, a status, a network, an asset, a plan or a user id — the user comes from
 * the verified session, and the price comes from `src/lib/plans.ts`.
 *
 * Rate-limited per user because each call spends several RPC round trips, and because the
 * endpoint is the natural place to grind through hashes looking for an unclaimed one. Six per
 * minute is generous for a payer waiting on confirmations and useless for enumeration.
 */
import { apiRoute, ok, parseJson, tooManyRequests } from "@/lib/api/http";
import { verifyCryptoPaymentSchema } from "@/lib/api/schemas";
import { requireUser } from "@/lib/auth/guards";
import { rateLimit } from "@/lib/security/rate-limit";
import { submitTransactionHash } from "@/server/services/crypto-payment-service";

export const POST = apiRoute(async (request) => {
  const { user } = await requireUser();

  const limit = rateLimit(`payments:crypto:verify:${user.id}`, 6);
  if (!limit.allowed) return tooManyRequests(limit);

  const { txHash } = await parseJson(request, verifyCryptoPaymentSchema);

  const result = await submitTransactionHash({
    userId: user.id,
    rawTxHash: txHash,
    actorEmail: user.email,
    request,
  });

  return ok(result);
});
