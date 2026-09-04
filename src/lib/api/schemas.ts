/**
 * Request validation for the dashboard API (`/api/*`).
 *
 * Kept separate from the gateway schemas: these describe Relayn's own control plane, and
 * every mutating route parses its body through one of them before touching the database.
 */
import { z } from "zod";
import {
  MAX_FALLBACKS,
  MODEL_CATEGORIES,
  MODEL_ID_PATTERN,
  splitFallbacks,
} from "@/lib/catalogue";
import { ADMIN_ASSIGNABLE_PLAN_ORDER, PLAN_ORDER, SELF_SERVE_PLAN_ORDER } from "@/lib/plans";

const email = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .toLowerCase()
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value), "Enter a valid email address.");

const password = z.string().min(1).max(200);
const displayName = z.string().trim().min(1, "Name is required.").max(120);

export const registerSchema = z.object({
  name: displayName,
  email,
  password,
});

export const loginSchema = z.object({
  email,
  password,
  remember: z.boolean().optional(),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password,
});

export const updateProfileSchema = z.object({
  name: displayName.optional(),
  avatarUrl: z
    .string()
    .trim()
    .max(500)
    .refine(
      (value) => value === "" || /^https:\/\//.test(value),
      "Avatar URL must be an https:// link.",
    )
    .optional(),
});

/**
 * `currentPassword` is optional at the schema level and mandatory at the service level
 * whenever the account actually has a password. A provider-only account has none to prove,
 * and Zod cannot see the stored hash — so the decision belongs to `changePassword`, not here.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: password,
  signOutEverywhere: z.boolean().optional(),
});

/**
 * Same split: a password account confirms with `password`, a provider-only account by
 * retyping `confirmEmail`. `deleteAccount` picks the required one from the stored hash.
 */
export const deleteAccountSchema = z.object({
  password: z.string().max(200).optional(),
  confirmEmail: z.string().max(320).optional(),
  confirm: z.literal("DELETE"),
});

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, "Give the key a recognisable name.").max(80),
});

export const renameApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const usageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  modelId: z.string().trim().max(200).optional(),
  status: z.enum(["success", "error"]).optional(),
  apiKeyId: z.string().trim().max(60).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  sort: z.enum(["createdAt", "totalTokens", "latencyMs"]).default("createdAt"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});

/**
 * Self-serve plan changes only. `unlimited` is absent from `SELF_SERVE_PLAN_ORDER`, so
 * `PATCH /api/subscription { plan: "unlimited" }` fails validation with `validation_error`
 * before `changePlan` — or any database write — is reached. `changePlan` repeats the refusal;
 * this is the outer of the two layers.
 */
export const changePlanSchema = z.object({
  plan: z.enum(SELF_SERVE_PLAN_ORDER as unknown as [string, ...string[]]),
});

/**
 * The entire body of `POST /api/payments/crypto/verify`.
 *
 * One field, on purpose. There is nowhere here to put an amount, a recipient, a sender, a
 * network, an asset, a status, a plan or a user id — the request cannot carry them, so no
 * service code has to remember to ignore them. The hash itself is only an identifier: the shape
 * is checked so an obviously malformed value never reaches a node, and the value is re-read from
 * the chain before it is believed.
 */
export const verifyCryptoPaymentSchema = z.object({
  txHash: z
    .string()
    .trim()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, "Enter the 64-character transaction hash.")
    .transform((value) => (value.startsWith("0x") ? value.toLowerCase() : `0x${value.toLowerCase()}`)),
});

export const createTicketSchema = z.object({
  subject: z.string().trim().min(4, "Add a short subject.").max(160),
  category: z.enum(["billing", "technical", "account", "models", "other"]),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  message: z.string().trim().min(10, "Describe the issue in a little more detail.").max(5000),
});

export const ticketReplySchema = z.object({
  message: z.string().trim().min(1, "Write a reply first.").max(5000),
});

export const closeTicketSchema = z.object({
  status: z.enum(["open", "pending", "resolved", "closed"]),
});

export const upsertIntegrationSchema = z.object({
  type: z.enum(["openai_sdk", "anthropic_sdk", "rest", "langchain", "webhook", "custom"]),
  name: z.string().trim().min(1).max(80),
  apiKeyId: z.string().trim().max(60).nullable().optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
});

export const adminUserActionSchema = z.object({
  action: z.enum(["suspend", "reactivate", "make_admin", "revoke_admin"]),
});

/**
 * Public catalogue id — the string a caller puts in `"model"`.
 *
 * Not lowercased: upstreams publish mixed-case ids (`deepseek-ai/DeepSeek-V4-Flash`) and
 * `models.modelId` has to match what the gateway is asked for exactly.
 */
const catalogueModelId = z
  .string()
  .trim()
  .min(1, "Model id is required.")
  .max(120, "Model id must be at most 120 characters.")
  .refine(
    (value) => MODEL_ID_PATTERN.test(value),
    "Use letters, digits and . _ : / - only, starting with a letter or digit.",
  );

/** Identifier sent upstream. Same character set; "" means "identical to the catalogue id". */
const upstreamModelId = z
  .string()
  .trim()
  .max(120)
  .refine(
    (value) => value.length === 0 || MODEL_ID_PATTERN.test(value),
    "Use letters, digits and . _ : / - only.",
  );

/**
 * Ordered fallback chain, as a comma-separated list of catalogue ids.
 *
 * Validated for shape only. Whether each id exists, is enabled and is reachable on the caller's
 * plan is decided at request time by the gateway, not here: a chain that names a model an
 * operator is about to add should be storable, and a plan check frozen at save time would be
 * the wrong answer for every later request anyway.
 */
const modelFallbacks = z
  .string()
  .trim()
  .max(600)
  .refine((value) => {
    const entries = splitFallbacks(value);
    return entries.length <= MAX_FALLBACKS;
  }, `A chain may name at most ${MAX_FALLBACKS} fallbacks.`)
  .refine(
    (value) => splitFallbacks(value).every((entry) => MODEL_ID_PATTERN.test(entry)),
    "Each fallback must be a catalogue model id.",
  )
  .refine((value) => {
    const entries = splitFallbacks(value);
    return new Set(entries).size === entries.length;
  }, "The same fallback is listed twice.")
  // Stored canonically so the gateway can split on "," without re-trimming every request.
  .transform((value) => splitFallbacks(value).join(","));

export const adminModelSchema = z.object({
  enabled: z.boolean().optional(),
  // Full `PLAN_ORDER` on purpose: `minPlan` *gates* a model, it does not grant anything, so
  // "unlimited" is a legitimate ceiling for an expensive model.
  minPlan: z.enum(PLAN_ORDER as unknown as [string, ...string[]]).optional(),
  inputPrice: z.number().min(0).max(10_000).optional(),
  outputPrice: z.number().min(0).max(10_000).optional(),
  description: z.string().trim().max(500).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  /** Editable on synced rows too, so a fallback chain does not require a hand-made model. */
  fallbacks: modelFallbacks.optional(),
  upstreamModel: upstreamModelId.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  category: z.enum(MODEL_CATEGORIES).optional(),
  contextWindow: z.number().int().min(0).max(100_000_000).optional(),
  maxOutputTokens: z.number().int().min(0).max(100_000_000).optional(),
});

/**
 * A hand-added catalogue row.
 *
 * `provider` must already be registered — the service checks the live registry rather than a
 * hardcoded list, so a custom provider added minutes ago is immediately usable here. `modelId`
 * is what callers will send as `"model"`, and `upstreamModel` is what Relayn sends on: leaving
 * the second empty means the two are identical, which is the common case.
 *
 * Prices default to 0 rather than being required. A guessed price would be metered against real
 * users, so an unknown price is recorded as free until an operator fills it in.
 */
export const adminModelCreateSchema = z.object({
  modelId: catalogueModelId,
  provider: z.string().trim().min(1).max(40),
  upstreamModel: upstreamModelId.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  category: z.enum(MODEL_CATEGORIES).optional(),
  description: z.string().trim().max(500).optional(),
  contextWindow: z.number().int().min(0).max(100_000_000).optional(),
  maxOutputTokens: z.number().int().min(0).max(100_000_000).optional(),
  inputPrice: z.number().min(0).max(10_000).optional(),
  outputPrice: z.number().min(0).max(10_000).optional(),
  capabilities: z.string().trim().max(200).optional(),
  minPlan: z.enum(PLAN_ORDER as unknown as [string, ...string[]]).optional(),
  enabled: z.boolean().optional(),
  fallbacks: modelFallbacks.optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  /**
   * Call the upstream once with this model before writing the row. Default on: the whole point
   * of the form is to stop dead ids entering the catalogue and 404-ing real callers.
   */
  test: z.boolean().optional(),
});

/**
 * Live probe of one `provider` + `model` pair, without storing anything.
 *
 * `model` is the id sent upstream, and unlike `upstreamModel` on the create form it may not be
 * empty: there is no row to inherit an id from here, so "" would probe nothing.
 */
export const adminModelTestSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  model: catalogueModelId,
});

/**
 * Optional body for the catalogue sync. `providers` narrows the run to named upstreams;
 * an empty body syncs every configured provider that can list its models.
 */
export const adminModelSyncSchema = z.object({
  providers: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

/**
 * Slug of a runtime-added provider. It becomes the prefix of every model id this provider
 * serves (`<slug>/<upstream-id>`), so the character set is the one that is safe in a model
 * identifier and in a URL path: lowercase alphanumerics and single dashes, no leading or
 * trailing dash. Collision with a builtin id is rejected in the service layer, which is the
 * only place that knows what the builtins are.
 */
const providerSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Provider id must be at least 2 characters.")
  .max(32, "Provider id must be at most 32 characters.")
  .refine(
    (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value),
    "Use lowercase letters, digits and single dashes only.",
  );

/**
 * Base URL of a custom upstream.
 *
 * https is required outside localhost: the credential travels in a request header, so a plain
 * http upstream would put it on the wire in clear text. A trailing slash is stripped because
 * the adapters append `/chat/completions` and `/models` directly.
 */
const providerBaseUrl = z
  .string()
  .trim()
  .min(8)
  .max(300)
  .transform((value) => value.replace(/\/+$/, ""))
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol === "https:") return true;
    // `hostname` rather than `host.split(":")` — the latter yields "[" for an IPv6 literal,
    // which would make the `[::1]` entry below unreachable.
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  }, "Enter an absolute https:// URL (http:// is allowed only for localhost).");

/**
 * Extra request headers, as a JSON object. Parsed here so a malformed value is a 400 the
 * operator can see rather than silently-dropped headers at request time; the registry
 * additionally refuses names that would override the credential or the body framing.
 */
const providerExtraHeaders = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    if (value.length === 0) return true;
    try {
      const parsed: unknown = JSON.parse(value);
      return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }, "Extra headers must be a JSON object, e.g. {\"x-source\":\"relayn\"}.");

/** An upstream credential. Never logged, never returned — only sealed and stored. */
const providerApiKey = z.string().trim().min(8, "That key looks too short.").max(400);

export const adminProviderCreateSchema = z.object({
  provider: providerSlug,
  label: z.string().trim().min(2, "Give the provider a display name.").max(60),
  kind: z.enum(["openai", "anthropic"]),
  baseUrl: providerBaseUrl,
  apiKey: providerApiKey,
  extraHeaders: providerExtraHeaders.optional(),
  notes: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  /** Pull the upstream's catalogue immediately after creating the provider. */
  syncModels: z.boolean().optional(),
});

/**
 * Provider edit. Every field is optional; omitting `apiKey` keeps the stored credential
 * exactly as it is, which is what makes "edit the label without re-entering the key" work.
 * `provider` (the slug) is absent on purpose — renaming it would orphan every catalogue row
 * whose id is prefixed with it.
 */
export const adminProviderUpdateSchema = z.object({
  label: z.string().trim().min(2).max(60).optional(),
  kind: z.enum(["openai", "anthropic"]).optional(),
  baseUrl: providerBaseUrl.optional(),
  apiKey: providerApiKey.optional(),
  extraHeaders: providerExtraHeaders.optional(),
  notes: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
});

/**
 * Live probe of one provider. Addressed by registry id rather than row id so a builtin —
 * which may have no `provider_configs` row at all — can be tested the same way.
 */
export const adminProviderTestSchema = z.object({
  provider: z.string().trim().min(1).max(40),
});

/**
 * Outbound proxy list for one upstream.
 *
 * Addressed by registry id, like the test probe, because a builtin such as `madefaka` may have
 * no `provider_configs` row yet — the service upserts an annotation row for it. `proxies` is
 * the raw pasted list (newline- or comma-separated); an empty string clears the configuration
 * and returns that provider to direct egress. Validation of individual entries happens in
 * `lib/providers/proxy`, which reports one message per rejected line rather than failing the
 * whole save.
 */
export const adminProviderProxySchema = z.object({
  provider: z.string().trim().min(1).max(40),
  proxies: z.string().max(4000),
});

/**
 * Administrative subscription edit.
 *
 * `plan` is drawn from `ADMIN_ASSIGNABLE_PLAN_ORDER`, which omits `unlimited`: permanent
 * uncapped access is a payment outcome, so there is exactly one write path to it in the
 * codebase (`applyVerifiedPayment`) and not even an operator can shortcut it.
 *
 * `tokenAllocation` is bounded by `int4` because Prisma `Int` is `int4` on PostgreSQL — a
 * larger value would be rejected by the database rather than by validation.
 */
export const adminSubscriptionSchema = z.object({
  plan: z.enum(ADMIN_ASSIGNABLE_PLAN_ORDER as unknown as [string, ...string[]]).optional(),
  status: z.enum(["active", "past_due", "canceled", "trialing"]).optional(),
  tokenAllocation: z.number().int().min(0).max(2_147_483_647).optional(),
  resetUsage: z.boolean().optional(),
});
