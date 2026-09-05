/**
 * Plan gating. `planSatisfies` is the single decision behind "users should only see models
 * available to their account" — both the catalogue filter and the gateway's step-6 check
 * call it, so the full ordering matrix is asserted here rather than spot-checked.
 *
 * The `unlimited` plan is also asserted structurally: it must stay out of the admin-assignable
 * list the operator schema is built from, and `PUBLIC_PLAN_ORDER` must stay down to the two plans
 * a user can actually reach, because those two facts are what make "grant myself a better tier for
 * free" have no request shape at all.
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_ASSIGNABLE_PLAN_ORDER,
  PLANS,
  PLAN_ORDER,
  PUBLIC_PLAN_ORDER,
  UNLIMITED_PLAN_ID,
  UNLIMITED_PRICE_IDR,
  UNLIMITED_TOKEN_ALLOCATION,
  isPlanId,
  isUnlimitedPlan,
  nextRenewalDate,
  planOf,
  planSatisfies,
} from "@/lib/plans";

/** Every plan that is metered by a monthly allocation, in ascending order. */
const METERED = PLAN_ORDER.filter((id) => !PLANS[id].oneTime);

describe("plan catalogue", () => {
  it("declares every plan in PLAN_ORDER exactly once, ascending", () => {
    expect(PLAN_ORDER).toEqual(["free", "pro", "business", "enterprise", "unlimited"]);
    expect(Object.keys(PLANS).sort()).toEqual([...PLAN_ORDER].sort());
    const orders = PLAN_ORDER.map((id) => PLANS[id].order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("increases allocation and throughput as the price rises", () => {
    // Enterprise is negotiated (priceMonthlyUsd 0 + priceLabel) so it cannot join a price
    // comparison; unlimited is a one-time purchase and is not on the monthly ladder at all.
    const ladder = METERED.filter((id) => id !== "enterprise");
    for (let i = 1; i < ladder.length; i += 1) {
      const lower = PLANS[ladder[i - 1]!];
      const higher = PLANS[ladder[i]!];
      expect(higher.tokenAllocation).toBeGreaterThan(lower.tokenAllocation);
      expect(higher.requestsPerMinute).toBeGreaterThan(lower.requestsPerMinute);
      expect(higher.priceMonthlyUsd).toBeGreaterThan(lower.priceMonthlyUsd);
    }
  });

  it("advertises only the two plans a user can actually reach", () => {
    // Free on registration, unlimited after one verified payment. Pro/Business/Enterprise have no
    // processor and no assignment endpoint, so listing them would advertise an unbuyable product.
    expect(PUBLIC_PLAN_ORDER).toEqual(["free", UNLIMITED_PLAN_ID]);
    expect(PUBLIC_PLAN_ORDER.every((id) => PLAN_ORDER.includes(id))).toBe(true);
  });

  it("marks exactly one plan as unmetered, and it is the one-time purchase", () => {
    const unmetered = PLAN_ORDER.filter((id) => PLANS[id].unlimited);
    expect(unmetered).toEqual([UNLIMITED_PLAN_ID]);
    const oneTime = PLAN_ORDER.filter((id) => PLANS[id].oneTime);
    expect(oneTime).toEqual([UNLIMITED_PLAN_ID]);
    expect(PLANS.unlimited.priceIdr).toBe(UNLIMITED_PRICE_IDR);
    expect(PLANS.unlimited.priceMonthlyUsd).toBe(0);
    // A metered plan must never carry a rupiah price — that is what marks a real purchase.
    for (const id of METERED) expect(PLANS[id].priceIdr).toBeUndefined();
  });

  it("prices the one-time purchase at Rp5.000 and nothing else", () => {
    // Hardcoded on purpose: this constant is what the webhook compares the callback amount
    // against, so a silent edit here would silently change what activates an account.
    expect(UNLIMITED_PRICE_IDR).toBe(5_000);
  });

  it("keeps the unlimited sentinel allocation inside a Postgres int4", () => {
    // Prisma `Int` is int4 on PostgreSQL. A sentinel above 2_147_483_647 would fail to write.
    expect(PLANS.unlimited.tokenAllocation).toBe(UNLIMITED_TOKEN_ALLOCATION);
    expect(UNLIMITED_TOKEN_ALLOCATION).toBeLessThan(2_147_483_647);
    expect(Number.isInteger(UNLIMITED_TOKEN_ALLOCATION)).toBe(true);
  });

  it("gives Enterprise a price label so its $0 never renders as Free", () => {
    expect(PLANS.enterprise.priceLabel).toBeTruthy();
    expect(PLANS.free.priceLabel).toBeUndefined();
  });
});

describe("write-path exclusions", () => {
  it("exposes no self-serve plan list for a request schema to be built from", async () => {
    // `SELF_SERVE_PLAN_ORDER` used to feed `changePlanSchema`, which fed PATCH /api/subscription.
    // All three are gone: the only plan a user can obtain is bought, not requested. A reintroduced
    // export would be the first step back towards a free-upgrade endpoint, so its absence is pinned.
    const plans: Record<string, unknown> = await import("@/lib/plans");
    expect("SELF_SERVE_PLAN_ORDER" in plans).toBe(false);
  });

  it("excludes unlimited from the admin-assignable list", () => {
    expect(ADMIN_ASSIGNABLE_PLAN_ORDER).not.toContain(UNLIMITED_PLAN_ID);
    expect(ADMIN_ASSIGNABLE_PLAN_ORDER).toEqual(["free", "pro", "business", "enterprise"]);
  });

  it("puts unlimited above every plan an operator may assign", () => {
    // The consequence that matters: an operator cannot hand out an account that outranks a paid
    // one, so `planSatisfies` can never be satisfied for free.
    for (const id of ADMIN_ASSIGNABLE_PLAN_ORDER) {
      expect(planSatisfies(id, UNLIMITED_PLAN_ID)).toBe(false);
      expect(planSatisfies(UNLIMITED_PLAN_ID, id)).toBe(true);
    }
  });
});

describe("isPlanId", () => {
  it("accepts the known ids and nothing else", () => {
    for (const id of PLAN_ORDER) expect(isPlanId(id)).toBe(true);
    for (const bad of ["", "FREE", "premium", "free ", "enterprise-plus", "Unlimited"]) {
      expect(isPlanId(bad)).toBe(false);
    }
  });
});

describe("isUnlimitedPlan", () => {
  it("is true only for the unlimited id", () => {
    expect(isUnlimitedPlan("unlimited")).toBe(true);
    for (const id of METERED) expect(isUnlimitedPlan(id)).toBe(false);
  });

  it("does not treat a bogus value as unlimited", () => {
    for (const bad of ["", "god-mode", "UNLIMITED", "unlimited "]) {
      expect(isUnlimitedPlan(bad)).toBe(false);
    }
  });
});

describe("planOf", () => {
  it("falls back to Free for an unknown value rather than throwing", () => {
    // A row written by an older migration must never crash a dashboard render.
    expect(planOf("nonsense").id).toBe("free");
    expect(planOf("").id).toBe("free");
    expect(planOf("pro").id).toBe("pro");
    expect(planOf("unlimited").id).toBe("unlimited");
  });
});

describe("planSatisfies", () => {
  const expected: Record<string, string[]> = {
    free: ["free"],
    pro: ["free", "pro"],
    business: ["free", "pro", "business"],
    enterprise: ["free", "pro", "business", "enterprise"],
    unlimited: ["free", "pro", "business", "enterprise", "unlimited"],
  };

  it("permits a plan to reach its own tier and everything below it", () => {
    for (const plan of PLAN_ORDER) {
      for (const minimum of PLAN_ORDER) {
        expect(planSatisfies(plan, minimum)).toBe(expected[plan]!.includes(minimum));
      }
    }
  });

  it("lets an unlimited account reach every minPlan in the catalogue", () => {
    // The business promise of the purchase: every model, including paid tiers.
    for (const minimum of PLAN_ORDER) expect(planSatisfies("unlimited", minimum)).toBe(true);
  });

  it("blocks the specific case the gateway relies on", () => {
    // A Free key calling a Pro-only model — asserted end to end in scripts/e2e-smoke.sh.
    expect(planSatisfies("free", "pro")).toBe(false);
    expect(planSatisfies("business", "enterprise")).toBe(false);
    expect(planSatisfies("enterprise", "unlimited")).toBe(false);
  });

  it("treats an unrecognised plan as Free, not as unlimited", () => {
    expect(planSatisfies("god-mode", "pro")).toBe(false);
    expect(planSatisfies("god-mode", "free")).toBe(true);
    expect(planSatisfies("god-mode", "unlimited")).toBe(false);
  });
});

describe("nextRenewalDate", () => {
  // The function works in local time (`setMonth` / `setHours`), so the assertions read the
  // result with local getters too — otherwise they would pass only in UTC.
  it("advances exactly one calendar month and snaps to local midnight", () => {
    const next = nextRenewalDate(new Date(2026, 0, 15, 10, 30));
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(1); // February
    expect(next.getDate()).toBe(15);
    expect([next.getHours(), next.getMinutes(), next.getSeconds(), next.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("rolls the year over", () => {
    const next = nextRenewalDate(new Date(2026, 11, 5, 10, 0));
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0);
  });

  it("always lands in the future", () => {
    for (const from of [new Date(2026, 7, 21, 23, 59), new Date(2026, 1, 28, 12, 0), new Date()]) {
      expect(nextRenewalDate(from).getTime()).toBeGreaterThan(from.getTime());
    }
  });
});
