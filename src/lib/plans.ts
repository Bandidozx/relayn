/**
 * Plan catalogue. Shared by the dashboard, the subscription API and the gateway's
 * authorisation checks, so there is exactly one definition of what a plan grants.
 *
 * Two pricing shapes coexist here:
 *   - `free`/`pro`/`business`/`enterprise` are the original monthly, allocation-metered
 *     tiers. `priceMonthlyUsd` is display-only for these; no recurring processor is wired
 *     up and none is planned.
 *   - `unlimited` is a **one-time** purchase (`oneTime: true`) that grants uncapped tokens
 *     permanently. It is deliberately the highest `order`, so `planSatisfies` lets it reach
 *     every `minPlan` in the model catalogue without any existing row being re-gated or
 *     remapped. Two prices are carried because two rails exist: `priceUsdMicro` for the
 *     active on-chain rail and `priceIdr` for the paused QRIS rail.
 *
 * `unlimited` is NOT self-serve and is NOT admin-assignable: the only code paths that may set
 * it are a signature-verified payment callback (`src/server/services/payment-service.ts`) and a
 * chain-verified transfer (`src/server/services/crypto-payment-service.ts`). That is why it is
 * excluded from `SELF_SERVE_PLAN_ORDER` and `ADMIN_ASSIGNABLE_PLAN_ORDER` — the request schemas
 * are built from those lists, so "upgrade myself for free" is rejected at the validation layer
 * before any service code runs.
 */
export type PlanId = "free" | "pro" | "business" | "enterprise" | "unlimited";

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  priceMonthlyUsd: number;
  /**
   * Overrides the rendered price. Enterprise is negotiated, so its `priceMonthlyUsd` of 0
   * must not be shown as "Free" — that is the same string the actual Free plan uses, which
   * would read as a $0 enterprise tier. Renderers prefer this label when it is present.
   */
  priceLabel?: string;
  /** One-time price in whole rupiah. Present only on `oneTime` plans. */
  priceIdr?: number;
  /** One-time price in micro-USD. Present only on `oneTime` plans. */
  priceUsdMicro?: number;
  /** True when `priceIdr` buys permanent access rather than a month of it. */
  oneTime?: boolean;
  /** True when the plan is not metered at all — see `quotaFrom`. */
  unlimited: boolean;
  tokenAllocation: number;
  requestsPerMinute: number;
  /** Concurrent active API keys allowed. `null` means unlimited. */
  maxApiKeys: number | null;
  order: number;
  /** Highest model tier this plan may call. */
  features: string[];
  /** Self-serve plan changes are allowed; enterprise requires a conversation. */
  selfServe: boolean;
}

/** The plan a verified one-time payment grants. */
export const UNLIMITED_PLAN_ID = "unlimited" as const;

/**
 * The one-time price, in whole rupiah, decided entirely server-side.
 *
 * This constant is the single source of truth for three places that must agree: the amount
 * sent to the payment provider, the amount the webhook demands before activating anything,
 * and the price the UI advertises. A client never supplies an amount.
 */
export const UNLIMITED_PRICE_IDR = 5_000;

/**
 * The one-time price in **micro-USD** (millionths of a dollar), decided entirely server-side.
 *
 * $0.10 = 100,000 micro-USD. The unit matches `UsageLog.costMicroUsd` and `formatMicroUsd`, so
 * the whole codebase has one integer money representation and no float arithmetic on prices.
 *
 * This is the figure the crypto payment rail is priced at. It is *not* the on-chain amount:
 * converting it into token base units is `CRYPTO_PAYMENT_AMOUNT`'s job, configured as a fixed
 * decimal string ("0.10" USDC) precisely so no market rate is ever consulted at request time.
 */
export const UNLIMITED_PRICE_USD_MICRO = 100_000;

/** The advertised price. One string, so the UI and the plan card cannot disagree. */
export const UNLIMITED_PRICE_USD_LABEL = "$0.10";

/**
 * Nominal allocation stored on an unlimited subscription row.
 *
 * Quota is decided by the `unlimited` boolean, never by this number — but the column is a
 * non-null `Int`, and Prisma `Int` is `int4` on PostgreSQL (max 2,147,483,647). Two billion
 * stays inside that bound while being obviously a sentinel rather than a real budget.
 */
export const UNLIMITED_TOKEN_ALLOCATION = 2_000_000_000;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "Kick the tyres on every open model.",
    priceMonthlyUsd: 0,
    unlimited: false,
    tokenAllocation: 250_000,
    requestsPerMinute: 20,
    maxApiKeys: 1,
    order: 0,
    selfServe: true,
    features: [
      "250K tokens / month",
      "Open-weight + budget models",
      "1 API key",
      "Community support",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "For solo builders shipping real traffic.",
    priceMonthlyUsd: 20,
    unlimited: false,
    tokenAllocation: 5_000_000,
    requestsPerMinute: 60,
    maxApiKeys: 10,
    order: 1,
    selfServe: true,
    features: [
      "5M tokens / month",
      "Frontier chat + reasoning models",
      "10 API keys",
      "Streaming + tool calls",
      "Email support",
    ],
  },
  business: {
    id: "business",
    name: "Business",
    tagline: "Team-scale throughput with spend controls.",
    priceMonthlyUsd: 99,
    unlimited: false,
    tokenAllocation: 25_000_000,
    requestsPerMinute: 300,
    maxApiKeys: null,
    order: 2,
    selfServe: true,
    features: [
      "25M tokens / month",
      "Full catalogue incl. vision + embeddings",
      "Unlimited API keys",
      "Per-key usage breakdown",
      "Priority support",
    ],
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    tagline: "Dedicated capacity and contractual guarantees.",
    priceMonthlyUsd: 0,
    priceLabel: "Custom",
    unlimited: false,
    tokenAllocation: 250_000_000,
    requestsPerMinute: 1_200,
    maxApiKeys: null,
    order: 3,
    selfServe: false,
    features: [
      "250M tokens / month",
      "Private model routing pools",
      "SSO + audit export",
      "99.9% uptime SLA",
      "Dedicated support channel",
    ],
  },
  unlimited: {
    id: "unlimited",
    name: "Unlimited",
    tagline: "One payment. Every model. No token ceiling, ever.",
    priceMonthlyUsd: 0,
    priceLabel: `${UNLIMITED_PRICE_USD_LABEL} once`,
    priceIdr: UNLIMITED_PRICE_IDR,
    priceUsdMicro: UNLIMITED_PRICE_USD_MICRO,
    oneTime: true,
    unlimited: true,
    tokenAllocation: UNLIMITED_TOKEN_ALLOCATION,
    requestsPerMinute: 1_200,
    maxApiKeys: null,
    order: 4,
    // Never reachable from PATCH /api/subscription — only from a verified payment.
    selfServe: false,
    features: [
      "Permanent access — no renewal, no expiry",
      "All available models, including paid tiers",
      "API access",
      "Streaming",
      "Unlimited API keys",
    ],
  },
};

/** Every plan in the catalogue, ascending by `order`. Drives `minPlan` gating and display. */
export const PLAN_ORDER: PlanId[] = ["free", "pro", "business", "enterprise", "unlimited"];

/**
 * Plans a signed-in user may move between with no payment at all.
 *
 * `changePlanSchema` is built from this list, so `PATCH /api/subscription { plan: "unlimited" }`
 * fails Zod validation before `changePlan` is even called.
 */
export const SELF_SERVE_PLAN_ORDER: PlanId[] = ["free", "pro", "business"];

/**
 * Plans an administrator may assign by hand. Deliberately excludes `unlimited`: granting
 * permanent uncapped access is a payment outcome, not an operator toggle, so there is exactly
 * one write path to it in the codebase.
 */
export const ADMIN_ASSIGNABLE_PLAN_ORDER: PlanId[] = ["free", "pro", "business", "enterprise"];

export function isPlanId(value: string): value is PlanId {
  return value in PLANS;
}

export function planOf(value: string): Plan {
  return isPlanId(value) ? PLANS[value] : PLANS.free;
}

/** True when `value` names a plan that grants uncapped tokens. */
export function isUnlimitedPlan(value: string): boolean {
  return isPlanId(value) && PLANS[value].unlimited;
}

/** True when `plan` is at least as high as `minimum`. Drives model authorisation. */
export function planSatisfies(plan: string, minimum: string): boolean {
  return planOf(plan).order >= planOf(minimum).order;
}

/**
 * Start of the next monthly **token window**, not a plan expiry date.
 *
 * `ensureSubscription` uses this to zero `tokensUsed` for metered plans. Unlimited accounts
 * have no window and no expiry — `Subscription.planExpiresAt` stays null for them and this
 * function is never consulted on their behalf.
 */
export function nextRenewalDate(from: Date = new Date()): Date {
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  next.setHours(0, 0, 0, 0);
  return next;
}
