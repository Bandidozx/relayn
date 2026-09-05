/**
 * The two gates the operator exemption has to pass through: step 5 (allocation) and the
 * transport-level rate limit.
 *
 * Both read `GatewayIdentity` rather than the subscription row, because the exemption lives on
 * `user.role` and a signature that took only the row could not see it. That makes these the two
 * places where the exemption is *permissive* — it lets a request through that would otherwise be
 * refused — so they are asserted directly rather than only through the dashboard's copy.
 *
 * Nothing here writes: the same `subscription` object is reused across roles on purpose, so a test
 * that passed only because the row had been mutated would fail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLANS, UNLIMITED_PLAN_ID, UNLIMITED_TOKEN_ALLOCATION } from "@/lib/plans";
import { resetRateLimits } from "@/lib/security/rate-limit";
import type { ApiKey, Subscription, User } from "@/lib/db-types";

// `pipeline.ts` imports prisma at module scope. Neither gate under test touches it.
vi.mock("@/lib/db", () => ({ prisma: {} }));

const { GatewayError, assertQuota, assertRateLimit } = await import("@/lib/gateway/pipeline");

function user(role: string): User {
  return { id: `u_${role}`, email: `${role}@relayn.test`, name: role, role } as User;
}

function apiKey(id = "k_1"): ApiKey {
  return { id, userId: "u_user", status: "active" } as ApiKey;
}

function subscription(over: Partial<Subscription> = {}): Subscription {
  return {
    plan: "free",
    tokenAllocation: 250_000,
    tokensUsed: 0,
    renewalDate: new Date("2026-10-01T00:00:00Z"),
    status: "active",
    unlimited: false,
    planExpiresAt: null,
    ...over,
  } as Subscription;
}

/** An identity in the shape `authenticate()` returns, including its resolved effective plan. */
function identity(role: string, sub: Subscription, plan = role === "admin" ? UNLIMITED_PLAN_ID : sub.plan) {
  return { user: user(role), apiKey: apiKey(`k_${role}`), subscription: sub, plan } as Parameters<
    typeof assertQuota
  >[0];
}

beforeEach(() => resetRateLimits());

describe("assertQuota", () => {
  it("refuses a metered account that has spent its allocation", () => {
    const spent = subscription({ tokensUsed: 250_000 });
    expect(() => assertQuota(identity("user", spent))).toThrow(GatewayError);
    try {
      assertQuota(identity("user", spent));
      expect.unreachable("the gate should have thrown");
    } catch (error) {
      // 402 + `insufficient_tokens` is the documented wire contract; clients match on the code.
      expect(error).toMatchObject({ status: 402, type: "insufficient_quota", code: "insufficient_tokens" });
    }
  });

  it("lets an operator through on the very same row", () => {
    // The one assertion the whole task turns on: identical subscription, different role, and
    // nothing in between mutated it.
    const spent = subscription({ tokensUsed: 250_000 });
    expect(() => assertQuota(identity("user", spent))).toThrow(GatewayError);
    expect(() => assertQuota(identity("admin", spent))).not.toThrow();
    expect(spent.unlimited).toBe(false);
    expect(spent.plan).toBe("free");
  });

  it("keeps an operator through even far past the allocation", () => {
    const overspent = subscription({ tokensUsed: 250_000_000 });
    expect(() => assertQuota(identity("admin", overspent))).not.toThrow();
  });

  it("still refuses every other role", () => {
    // The exemption is one role, not "any elevated-sounding role".
    const spent = subscription({ tokensUsed: 999_999 });
    for (const role of ["user", "member", "staff", "Admin", "administrator", ""]) {
      expect(() => assertQuota(identity(role, spent, "free"))).toThrow(GatewayError);
    }
  });

  it("passes a metered account that has allocation left", () => {
    expect(() => assertQuota(identity("user", subscription({ tokensUsed: 1 })))).not.toThrow();
  });

  it("passes a paid unlimited account past the sentinel allocation", () => {
    // Unchanged behaviour, asserted here because the two sources now share one gate.
    const paid = subscription({
      plan: UNLIMITED_PLAN_ID,
      unlimited: true,
      tokenAllocation: UNLIMITED_TOKEN_ALLOCATION,
      tokensUsed: UNLIMITED_TOKEN_ALLOCATION + 1,
    });
    expect(() => assertQuota(identity("user", paid, UNLIMITED_PLAN_ID))).not.toThrow();
  });
});

describe("assertRateLimit", () => {
  it("holds a Free account to the Free window", () => {
    const id = identity("user", subscription(), "free");
    const free = PLANS.free.requestsPerMinute;
    for (let i = 0; i < free; i += 1) expect(() => assertRateLimit(id)).not.toThrow();
    // The per-key window is the tighter of the two, so the next request is the one that trips.
    expect(() => assertRateLimit(id)).toThrow(GatewayError);
  });

  it("sizes an operator's window from the effective plan, not the stored one", () => {
    // Uncapped tokens behind a 20/min Free window would read as a broken account rather than as a
    // limit, so the exemption has to reach this gate too.
    const id = identity("admin", subscription());
    for (let i = 0; i <= PLANS.free.requestsPerMinute; i += 1) {
      expect(() => assertRateLimit(id)).not.toThrow();
    }
    expect(assertRateLimit(id).limit).toBeGreaterThan(PLANS.free.requestsPerMinute);
  });

  it("reports the unlimited plan's throughput for an operator", () => {
    const admin = assertRateLimit(identity("admin", subscription()));
    const member = assertRateLimit(identity("user", subscription(), "free"));
    expect(admin.limit).toBeGreaterThan(member.limit);
    expect(admin.limit).toBeGreaterThanOrEqual(PLANS[UNLIMITED_PLAN_ID].requestsPerMinute);
  });
});
