/**
 * Plan catalogue. Shared by the dashboard, the subscription API and the gateway's
 * authorisation checks, so there is exactly one definition of what a plan grants.
 *
 * **Only two of these are obtainable** (`PUBLIC_PLAN_ORDER`): `free`, which every account starts
 * on, and `unlimited`, which one payment grants permanently. There is no plan-switching UI and no
 * plan-switching endpoint — see `src/app/api/subscription/route.ts`, which exposes `GET` only.
 *
 * `pro`, `business` and `enterprise` are retained as **account states an operator may assign**, not
 * as products. Existing subscription rows still name them, `planSatisfies` still gates models by
 * them, and `ADMIN_ASSIGNABLE_PLAN_ORDER` still lists them; their `priceMonthlyUsd` is legacy
 * display data and no recurring processor is, or ever was, wired up. Nothing advertises them for
 * sale, because nothing can sell them.
 *
 * `unlimited` is the highest `order` on purpose, so `planSatisfies` lets it reach every `minPlan`
 * in the model catalogue without any existing row being re-gated or remapped. Two prices are
 * carried because two rails exist: `priceUsdMicro` for the active on-chain rail and `priceIdr` for
 * the paused QRIS rail.
 *
 * `unlimited` is NOT admin-assignable either: the only code paths that may set it are a
 * signature-verified payment callback (`src/server/services/payment-service.ts`) and a
 * chain-verified transfer (`src/server/services/crypto-payment-service.ts`). It is excluded from
 * `ADMIN_ASSIGNABLE_PLAN_ORDER`, whose schema rejects it at the validation layer, so "grant myself
 * permanent access for free" has no request shape at all.
 *
 * **Operators are exempt from metering, and that exemption is derived, never stored.**
 * `roleGrantsUnlimited` reads `User.role`; `effectivePlan` folds it into the plan an account's
 * entitlements are computed from. Nothing about it writes `Subscription.plan` or
 * `Subscription.unlimited`, which is the whole point: the paragraph above stays true, the single
 * write path to permanent access is still a verified payment, and demoting an admin removes the
 * exemption on their very next request because there is no row left behind holding it open.
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
}

/** The plan a verified one-time payment grants. */
export const UNLIMITED_PLAN_ID = "unlimited" as const;

/**
 * The one-time price, in whole rupiah, decided entirely server-side.
 *
 * This constant is the single source of truth for three places that must agree: the amount
 * sent to the payment provider, the amount the webhook demands before activating anything,
 * and the price the UI advertises. A client never supplies an amount.
 *
 * **Stale by design, pending an operator decision.** This is the QRIS rail's price, and QRIS is
 * paused (no TriPay credentials are configured), so nothing is sold at this figure today. It was
 * set when the product cost $0.10 and has deliberately not been scaled alongside
 * `UNLIMITED_PRICE_USD_MICRO` — what Rp5.000 should become is a pricing decision, not a unit
 * conversion. Re-enabling TriPay without revisiting this number would sell $0.50 of access for
 * the old rupiah price.
 */
export const UNLIMITED_PRICE_IDR = 5_000;

/**
 * The one-time price in **micro-USD** (millionths of a dollar), decided entirely server-side.
 *
 * $0.50 = 500,000 micro-USD. The unit matches `UsageLog.costMicroUsd` and `formatMicroUsd`, so
 * the whole codebase has one integer money representation and no float arithmetic on prices.
 *
 * This is the figure the crypto payment rail is priced at. It is *not* the on-chain amount:
 * converting it into token base units is `CRYPTO_PAYMENT_AMOUNT`'s job, configured as a fixed
 * decimal string ("0.50" USDC) precisely so no market rate is ever consulted at request time.
 *
 * Those two are separate authorities — one advertises, the other gates — so they are reconciled
 * explicitly at boot by `evmConfigFromEnv()`, which disables the rail outright when the amount an
 * operator configured does not match the price this constant advertises. Raising the price here
 * without raising `CRYPTO_PAYMENT_AMOUNT` therefore turns crypto payments off rather than
 * quietly selling $0.50 of access for $0.10.
 */
export const UNLIMITED_PRICE_USD_MICRO = 500_000;

/** The advertised price. One string, so the UI and the plan card cannot disagree. */
export const UNLIMITED_PRICE_USD_LABEL = "$0.50";

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
    // Never reachable from a request of any kind — only from a verified payment.
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
 * The only plans a user can actually end up on by their own action, in the order they are
 * advertised: `free` on registration, `unlimited` after one verified payment.
 *
 * This is what the public pricing grid iterates. `pro`/`business`/`enterprise` are deliberately
 * absent — there is no processor behind them and no endpoint that assigns them, so listing them
 * would advertise something nobody can buy. They remain in `PLAN_ORDER` because live subscription
 * rows still carry those ids and `planSatisfies` still gates models by them.
 */
export const PUBLIC_PLAN_ORDER: PlanId[] = ["free", UNLIMITED_PLAN_ID];

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
 * True when holding this role exempts an account from metering.
 *
 * Operators run the gateway; billing them for calls against their own catalogue would mean the
 * only accounts that can diagnose a provider are the ones paying to do it. So `admin` is exempt.
 *
 * The exemption lives here, in one predicate, rather than as an `=== "admin"` scattered across
 * quota, rate-limit and model-authorisation code — a role list that drifts between those three
 * would authorise a call and then refuse to meter it, or the reverse.
 *
 * This grants **entitlements**, not the `unlimited` column. See the module docblock: no caller of
 * this function writes anything.
 */
export function roleGrantsUnlimited(role: string): boolean {
  return role === "admin";
}

/**
 * The plan an account's entitlements are computed from: what it bought, unless its role outranks
 * that.
 *
 * Every gate that asks "may this account do X" — the quota check, `minPlan` model authorisation,
 * the requests-per-minute ceiling, the API-key cap — reads this rather than `Subscription.plan`,
 * so an exempt operator is uncapped consistently instead of being handed unlimited tokens and then
 * refused a second API key by the Free cap.
 *
 * `Subscription.plan` itself is never rewritten. It records what the account actually holds, which
 * is what the admin user list, the audit trail and every receipt must keep showing; the difference
 * between the two is exactly the exemption, and collapsing it would lose that.
 */
export function effectivePlan(plan: string, role: string): PlanId {
  if (roleGrantsUnlimited(role)) return UNLIMITED_PLAN_ID;
  return isPlanId(plan) ? plan : "free";
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
