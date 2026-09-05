/**
 * Gateway request pipeline, shared by every /v1 dialect.
 *
 *   Bearer key → key status → account status → subscription → allocation →
 *   model resolution → plan authorisation → provider readiness → rate limit
 *
 * Each step returns a stable error code so SDK users can branch on it, and every
 * rejection that indicates abuse or exhaustion is recorded (audit log / usage log).
 *
 * The three plan-sensitive steps — allocation, model authorisation, rate limit — all read
 * `GatewayIdentity.plan`, which folds in the operator exemption once at `authenticate`. None of
 * them reads `subscription.plan` directly, so they cannot come to different conclusions about the
 * same caller.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { MAX_FALLBACKS, splitFallbacks } from "@/lib/catalogue";
import { planSatisfies, planOf, effectivePlan, type PlanId } from "@/lib/plans";
import { resolveProvider } from "@/lib/providers/registry";
import { sha256 } from "@/lib/security/tokens";
import { gatewayRateLimit, type RateLimitResult } from "@/lib/security/rate-limit";
import { ensureSubscription, quotaFrom } from "@/lib/usage/accounting";
import type { AiModel, ApiKey, Subscription, User } from "@/lib/db-types";
import { unconfiguredRemedy, type ModelProvider } from "@/lib/providers/types";

export type GatewayErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "insufficient_quota"
  | "api_error"
  | "service_unavailable";

/** Error shaped exactly like the OpenAI/Anthropic error envelope. */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly type: GatewayErrorType,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface GatewayIdentity {
  user: User;
  apiKey: ApiKey;
  subscription: Subscription;
  /**
   * The plan every gate in this pipeline authorises against: `subscription.plan`, unless
   * `user.role` outranks it.
   *
   * Resolved once here, from the same freshly-read `users` row the key lookup already returned, so
   * the quota check, `minPlan` authorisation and the rate-limit window cannot disagree about what
   * the caller is entitled to. `subscription.plan` stays available on `subscription` for anything
   * that needs what the account actually bought.
   */
  plan: PlanId;
}

/** Extracts the credential from either dialect: OpenAI Bearer or Anthropic x-api-key. */
export function extractApiKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
  }
  const anthropicStyle = request.headers.get("x-api-key");
  return anthropicStyle ? anthropicStyle.trim() : null;
}

/**
 * Step 1–5. Resolves the caller from the API key. Cookies are deliberately ignored
 * here: the gateway is never authenticated by session, so it cannot be driven by CSRF.
 */
export async function authenticate(request: Request): Promise<GatewayIdentity> {
  const presented = extractApiKey(request);
  if (!presented) {
    throw new GatewayError(
      401,
      "authentication_error",
      "missing_api_key",
      "No API key provided. Send `Authorization: Bearer <key>`.",
    );
  }

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: sha256(presented) },
    include: { user: true },
  });

  if (!apiKey) {
    throw new GatewayError(
      401,
      "authentication_error",
      "invalid_api_key",
      "Incorrect API key provided.",
    );
  }
  if (apiKey.status !== "active") {
    throw new GatewayError(
      401,
      "authentication_error",
      "api_key_revoked",
      "This API key has been revoked.",
    );
  }
  if (apiKey.user.status !== "active") {
    throw new GatewayError(
      403,
      "permission_error",
      "account_suspended",
      "This account is suspended. Contact support.",
    );
  }

  const subscription = await ensureSubscription(apiKey.userId);
  if (subscription.status !== "active") {
    throw new GatewayError(
      402,
      "insufficient_quota",
      "subscription_inactive",
      `Subscription is ${subscription.status}. Update billing to resume access.`,
    );
  }

  return {
    user: apiKey.user,
    apiKey,
    subscription,
    plan: effectivePlan(subscription.plan, apiKey.user.role),
  };
}

/** Step 5. Allocation check, evaluated before the upstream call is made. */
export function assertQuota(identity: GatewayIdentity): void {
  // The identity, not the bare subscription: the exemption lives on `user.role`, and a signature
  // that took only the row could not see it.
  const quota = quotaFrom(identity.subscription, identity.user);
  if (quota.exhausted) {
    throw new GatewayError(
      402,
      "insufficient_quota",
      "insufficient_tokens",
      `Monthly token allocation exhausted (${quota.used.toLocaleString()} / ${quota.allocation.toLocaleString()}). Allocation resets ${quota.renewalDate.toISOString().slice(0, 10)}.`,
    );
  }
}

export interface ResolvedModel {
  model: AiModel;
  provider: ModelProvider;
  upstreamModel: string;
}

/** Steps 6–7. Catalogue lookup, plan authorisation and provider readiness. */
export async function resolveModel(modelId: string, plan: string): Promise<ResolvedModel> {
  if (!modelId || typeof modelId !== "string") {
    throw new GatewayError(400, "invalid_request_error", "model_required", "`model` is required.");
  }

  const model = await prisma.aiModel.findUnique({ where: { modelId } });
  if (!model) {
    throw new GatewayError(
      404,
      "not_found_error",
      "model_not_found",
      `The model \`${modelId}\` does not exist. GET /v1/models lists what is available to your key.`,
    );
  }
  if (!model.enabled) {
    throw new GatewayError(
      503,
      "service_unavailable",
      "model_disabled",
      `The model \`${modelId}\` is currently disabled by the operator.`,
    );
  }
  if (!planSatisfies(plan, model.minPlan)) {
    // The wire `code` is unchanged — it is documented and clients match on it. The message names
    // the one action that actually clears the gate: naming the required tier used to point callers
    // at Pro/Business, which nothing sells. Unlimited satisfies every `minPlan` in the catalogue.
    throw new GatewayError(
      403,
      "permission_error",
      "model_not_available_on_plan",
      `\`${modelId}\` is not available to this account. The one-time Unlimited purchase unlocks the full catalogue.`,
    );
  }

  const provider = await resolveProvider(model.provider);
  if (!provider) {
    throw new GatewayError(
      503,
      "service_unavailable",
      "provider_not_registered",
      `No adapter is registered for provider \`${model.provider}\`.`,
    );
  }
  if (!provider.isConfigured()) {
    throw new GatewayError(
      503,
      "service_unavailable",
      "provider_unconfigured",
      `${provider.label} is not configured on this deployment. ${unconfiguredRemedy(provider.credentialEnvVar)}`,
    );
  }

  return { model, provider, upstreamModel: model.upstreamModel ?? model.modelId };
}

/** A fallback that was declared but cannot be used for this request, and why. */
export interface SkippedLink {
  modelId: string;
  reason: string;
}

export interface ResolvedChain {
  /** `[primary, ...usable fallbacks]`, in the order they will be attempted. */
  links: ResolvedModel[];
  /** Declared fallbacks that were filtered out. Reported in a response header, not an error. */
  skipped: SkippedLink[];
}

/**
 * Steps 6–7, plus the model's fallback chain.
 *
 * The primary is resolved exactly as before, so nothing about a model without fallbacks changes:
 * a missing, disabled, or out-of-plan primary still fails with the same code it always did.
 *
 * Fallbacks are resolved *leniently* — one that no longer exists, has been disabled, sits above
 * the caller's plan, or whose provider lost its credential is dropped from the chain with a
 * reason rather than failing the request. An operator editing the catalogue must not be able to
 * break working traffic by leaving a stale id in someone else's chain.
 *
 * Three limits, all deliberate:
 *
 *  - **Plan is re-checked per link.** This is the security-relevant one. A chain is operator
 *    data, so without this check a `free`-tier model could name a `business` model as its
 *    fallback and hand every caller a paid model for free. `planSatisfies` is applied to each
 *    candidate independently, exactly as it is to the primary.
 *  - **One level only.** A fallback's own `fallbacks` are not followed. That makes cycles
 *    structurally impossible instead of merely guarded against, and keeps the worst case at
 *    `MAX_FALLBACKS + 1` upstream calls no matter how the operator wires the catalogue.
 *  - **The primary can never be a fallback of itself**, so a self-reference costs nothing.
 */
export async function resolveChain(modelId: string, plan: string): Promise<ResolvedChain> {
  const primary = await resolveModel(modelId, plan);

  const wanted = splitFallbacks(primary.model.fallbacks)
    .filter((candidate) => candidate !== primary.model.modelId)
    .slice(0, MAX_FALLBACKS);
  if (wanted.length === 0) return { links: [primary], skipped: [] };

  // One query for the whole chain: a fallback list is short, but a round trip per link would
  // add latency to the request that is already failing over.
  const rows = await prisma.aiModel.findMany({ where: { modelId: { in: wanted } } });
  const byId = new Map(rows.map((row) => [row.modelId, row]));

  const links: ResolvedModel[] = [primary];
  const skipped: SkippedLink[] = [];
  const seen = new Set([primary.model.modelId]);

  for (const candidate of wanted) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const model = byId.get(candidate);
    if (!model) {
      skipped.push({ modelId: candidate, reason: "no catalogue row" });
      continue;
    }
    if (!model.enabled) {
      skipped.push({ modelId: candidate, reason: "disabled" });
      continue;
    }
    if (!planSatisfies(plan, model.minPlan)) {
      skipped.push({ modelId: candidate, reason: `requires ${planOf(model.minPlan).name}` });
      continue;
    }
    const provider = await resolveProvider(model.provider);
    if (!provider) {
      skipped.push({ modelId: candidate, reason: `provider \`${model.provider}\` not registered` });
      continue;
    }
    if (!provider.isConfigured()) {
      skipped.push({ modelId: candidate, reason: `${provider.label} has no credential` });
      continue;
    }
    links.push({ model, provider, upstreamModel: model.upstreamModel ?? model.modelId });
  }

  return { links, skipped };
}

/** Step 2 (transport-level). Per-key and per-account fixed windows, sized by plan. */
export function assertRateLimit(identity: GatewayIdentity): RateLimitResult {
  const perMinute = planOf(identity.plan).requestsPerMinute;
  const result = gatewayRateLimit(identity.user.id, identity.apiKey.id, perMinute);
  if (!result.allowed) {
    throw new GatewayError(
      429,
      "rate_limit_error",
      "rate_limit_exceeded",
      `Rate limit reached for this key (${result.limit} requests/minute). Retry in ${result.retryAfterSeconds}s.`,
      {
        "retry-after": String(result.retryAfterSeconds),
        "x-ratelimit-limit": String(result.limit),
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(result.resetAt),
      },
    );
  }
  return result;
}
