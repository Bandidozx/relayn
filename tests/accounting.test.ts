/**
 * Token accounting and cost maths — the numbers the dashboard shows.
 *
 * `costMicroUsd` is integer micro-USD on purpose: prices are floats per 1M tokens, and
 * accumulating those directly drifts. The estimator is only a fallback for responses that
 * carry no usage block, so what is asserted is monotonicity and non-zero output, not
 * agreement with any particular BPE tokeniser.
 *
 * `quotaFrom` reads a role as well as a row, so every call below names one. Two independent things
 * can leave an account uncapped — a verified payment (the `unlimited` column) and the admin role —
 * and they are asserted separately rather than only through `unlimited`, because only the first of
 * them may ever be described back to the account holder as a purchase.
 */
import { describe, expect, it } from "vitest";
import { UNLIMITED_PLAN_ID, UNLIMITED_TOKEN_ALLOCATION } from "@/lib/plans";
import { costMicroUsd, quotaFrom, type BillableModel } from "@/lib/usage/accounting";
import { describeQuota } from "@/lib/usage/quota-display";
import { buildUsage, estimatePromptTokens, estimateTextTokens } from "@/lib/usage/tokenizer";
import type { Subscription } from "@/lib/db-types";

const model: BillableModel = {
  modelId: "test-model",
  provider: "mock",
  inputPrice: 3, // USD per 1M input tokens
  outputPrice: 15,
};

function subscription(over: Partial<Subscription> = {}): Subscription {
  return {
    plan: "free",
    tokenAllocation: 250_000,
    tokensUsed: 0,
    renewalDate: new Date("2026-09-21T00:00:00Z"),
    status: "active",
    unlimited: false,
    planExpiresAt: null,
    ...over,
  } as Subscription;
}

/** A row in exactly the shape `applyVerifiedPayment` writes after a verified Rp5.000 payment. */
function unlimitedSubscription(over: Partial<Subscription> = {}): Subscription {
  return subscription({
    plan: UNLIMITED_PLAN_ID,
    status: "active",
    unlimited: true,
    tokenAllocation: UNLIMITED_TOKEN_ALLOCATION,
    planExpiresAt: null,
    ...over,
  });
}

/**
 * The two roles, passed explicitly at every `quotaFrom` call below.
 *
 * `quotaFrom`'s second argument is required rather than optional for exactly this reason: an
 * optional one would let a test — or a service — keep compiling while silently gaining or losing
 * the operator exemption. Naming the role at each call site makes every assertion say which of the
 * two sources it is about. `MEMBER` is the only one that leaves the stored row in charge.
 */
const MEMBER = { role: "user" };
const ADMIN = { role: "admin" };

describe("costMicroUsd", () => {
  it("prices input and output at their separate rates", () => {
    // 1M in at $3 + 1M out at $15 = $18 = 18_000_000 micro-USD.
    expect(costMicroUsd(model, buildUsage(1_000_000, 1_000_000))).toBe(18_000_000);
  });

  it("returns whole micro-USD, never a fraction", () => {
    const cost = costMicroUsd(model, buildUsage(37, 91));
    expect(Number.isInteger(cost)).toBe(true);
  });

  it("is zero for a free model", () => {
    const free: BillableModel = { ...model, inputPrice: 0, outputPrice: 0 };
    expect(costMicroUsd(free, buildUsage(10_000, 10_000))).toBe(0);
  });

  it("is zero for an empty request", () => {
    expect(costMicroUsd(model, buildUsage(0, 0))).toBe(0);
  });

  it("scales linearly, so a 10x request costs 10x", () => {
    const one = costMicroUsd(model, buildUsage(1_000, 1_000));
    const ten = costMicroUsd(model, buildUsage(10_000, 10_000));
    expect(ten).toBe(one * 10);
  });

  it("does not drift when many small charges are summed", () => {
    // 100k calls of 130 tokens each, accumulated as integers.
    const per = costMicroUsd(model, buildUsage(100, 30));
    let total = 0;
    for (let i = 0; i < 100_000; i += 1) total += per;
    expect(total).toBe(per * 100_000);
    expect(Number.isInteger(total)).toBe(true);
  });
});

describe("buildUsage", () => {
  it("sums the total and rounds", () => {
    expect(buildUsage(10, 5)).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(buildUsage(10.4, 5.6)).toEqual({ inputTokens: 10, outputTokens: 6, totalTokens: 16 });
  });

  it("clamps negatives to zero so a bad upstream report cannot credit tokens back", () => {
    expect(buildUsage(-100, -1)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});

describe("estimateTextTokens", () => {
  it("is zero only for empty input", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("a")).toBeGreaterThanOrEqual(1);
  });

  it("grows with length", () => {
    const short = estimateTextTokens("hello world");
    const long = estimateTextTokens("hello world ".repeat(50));
    expect(long).toBeGreaterThan(short * 20);
  });

  it("lands in a plausible range for ordinary prose", () => {
    // ~440 characters of English. A BPE tokeniser gives roughly 90–115 tokens.
    const prose =
      "The gateway validates the key, resolves the model, forwards the request upstream and " +
      "records the usage row before the response is returned to the caller. Every number on " +
      "the dashboard is aggregated from those rows, so an accounting bug shows up as a wrong " +
      "chart rather than as a silent overcharge. That is the point of writing usage first.";
    const estimate = estimateTextTokens(prose);
    expect(estimate).toBeGreaterThan(60);
    expect(estimate).toBeLessThan(160);
  });

  it("charges an image part like a fixed block of tokens rather than ignoring it", () => {
    // The tokenizer stands an image in as "[image]" x170, which lands around 150 tokens —
    // the same ballpark providers bill for a small image tile.
    const imageCost = estimateTextTokens("[image]".repeat(170));
    expect(imageCost).toBeGreaterThan(100);
    expect(imageCost).toBeLessThan(250);
  });
});

describe("estimatePromptTokens", () => {
  it("adds per-message overhead, so two short messages cost more than one", () => {
    const one = estimatePromptTokens([{ role: "user", content: "hi" }]);
    const two = estimatePromptTokens([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hi" },
    ]);
    expect(two).toBeGreaterThan(one);
  });

  it("never returns zero for a non-empty conversation", () => {
    expect(estimatePromptTokens([{ role: "user", content: "x" }])).toBeGreaterThan(0);
  });

  it("handles structured content parts", () => {
    const tokens = estimatePromptTokens([
      { role: "user", content: [{ type: "text", text: "describe this" }] },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });

  it("costs an image message far more than the same message without one", () => {
    const textOnly = estimatePromptTokens([
      { role: "user", content: [{ type: "text", text: "describe this" }] },
    ]);
    const withImage = estimatePromptTokens([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
    ]);
    expect(withImage).toBeGreaterThan(textOnly * 10);
  });

  it("tolerates an empty message list", () => {
    expect(estimatePromptTokens([])).toBe(2);
  });
});

describe("quotaFrom", () => {
  it("derives remaining and percent from the stored counters", () => {
    const quota = quotaFrom(subscription({ tokensUsed: 62_500 }), MEMBER);
    expect(quota.remaining).toBe(187_500);
    expect(quota.percentUsed).toBe(25);
    expect(quota.exhausted).toBe(false);
  });

  it("reports exhaustion once the allocation is spent", () => {
    const quota = quotaFrom(subscription({ tokensUsed: 250_000 }), MEMBER);
    expect(quota.remaining).toBe(0);
    expect(quota.percentUsed).toBe(100);
    expect(quota.exhausted).toBe(true);
  });

  it("clamps an overspend rather than reporting negative tokens", () => {
    const quota = quotaFrom(subscription({ tokensUsed: 400_000 }), MEMBER);
    expect(quota.remaining).toBe(0);
    expect(quota.percentUsed).toBe(100);
  });

  it("treats a zero allocation as fully used instead of dividing by zero", () => {
    const quota = quotaFrom(subscription({ tokenAllocation: 0, tokensUsed: 0 }), MEMBER);
    expect(quota.percentUsed).toBe(100);
    expect(quota.exhausted).toBe(true);
  });

  it("ignores nonsensical negative counters", () => {
    const quota = quotaFrom(subscription({ tokenAllocation: -1, tokensUsed: -5 }), MEMBER);
    expect(quota.allocation).toBe(0);
    expect(quota.used).toBe(0);
  });
});

describe("quotaFrom on a permanently unlimited subscription", () => {
  it("reports no ceiling and never reports exhaustion", () => {
    const quota = quotaFrom(unlimitedSubscription({ tokensUsed: 4_000_000 }), MEMBER);
    expect(quota.unlimited).toBe(true);
    expect(quota.exhausted).toBe(false);
    expect(quota.percentUsed).toBe(0);
    expect(quota.used).toBe(4_000_000);
  });

  it("stays unexhausted even once usage passes the sentinel allocation", () => {
    // The whole point of the flag: `remaining <= 0` would otherwise lock the account out at
    // exactly the moment the purchase promised it never would be.
    const quota = quotaFrom(
      unlimitedSubscription({ tokensUsed: UNLIMITED_TOKEN_ALLOCATION + 1_000_000 }),
      MEMBER,
    );
    expect(quota.remaining).toBe(0);
    expect(quota.exhausted).toBe(false);
    expect(quota.percentUsed).toBe(0);
  });

  it("keeps every field finite so the RSC boundary cannot turn one into null", () => {
    const quota = quotaFrom(unlimitedSubscription({ tokensUsed: 1 }), MEMBER);
    for (const value of [quota.allocation, quota.used, quota.remaining, quota.percentUsed]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("reads the column, not the plan string", () => {
    // An account whose plan was renamed by hand must not become unlimited, and a row carrying
    // the flag must not lose it because its plan string is something else. Both cases are asserted
    // as a `user`, so the role exemption cannot be what is answering.
    expect(quotaFrom(subscription({ plan: UNLIMITED_PLAN_ID }), MEMBER).unlimited).toBe(false);
    expect(quotaFrom(subscription({ plan: "free", unlimited: true }), MEMBER).unlimited).toBe(true);
  });

  it("does not treat a truthy non-boolean as unlimited", () => {
    // `subscription.unlimited === true` is a strict comparison on purpose; a legacy row that
    // somehow holds 1 instead of true must not silently grant permanent access.
    const quota = quotaFrom(subscription({ unlimited: 1 as unknown as boolean }), MEMBER);
    expect(quota.unlimited).toBe(false);
  });
});

describe("quotaFrom for an operator", () => {
  it("grants unlimited from the role alone, with the stored row untouched", () => {
    const row = subscription({ tokensUsed: 100_000 });
    const quota = quotaFrom(row, ADMIN);
    expect(quota.unlimited).toBe(true);
    expect(quota.unlimitedByRole).toBe(true);
    expect(quota.unlimitedByPayment).toBe(false);
    expect(quota.exhausted).toBe(false);
    expect(quota.percentUsed).toBe(0);
    // Nothing was written. The row still says free, metered and not unlimited — which is what makes
    // losing the role restore metering on the very next request, with nothing left to clean up.
    expect(row.plan).toBe("free");
    expect(row.unlimited).toBe(false);
    expect(row.tokenAllocation).toBe(250_000);
  });

  it("meters the same row for a member", () => {
    // One row, two roles, two answers, no mutation in between: the exemption is a property of the
    // caller, not of the subscription.
    const row = subscription({ tokensUsed: 400_000 });
    expect(quotaFrom(row, MEMBER).exhausted).toBe(true);
    expect(quotaFrom(row, MEMBER).unlimited).toBe(false);
    expect(quotaFrom(row, ADMIN).exhausted).toBe(false);
  });

  it("keeps an operator uncapped past a spent allocation", () => {
    const quota = quotaFrom(subscription({ tokensUsed: 900_000 }), ADMIN);
    // `remaining` still reports the arithmetic honestly; `exhausted` is the gate, and it is open.
    expect(quota.remaining).toBe(0);
    expect(quota.exhausted).toBe(false);
    expect(quota.used).toBe(900_000);
  });

  it("reports the two sources independently so receipt copy can key on the payment", () => {
    const byRole = quotaFrom(subscription(), ADMIN);
    expect([byRole.unlimitedByRole, byRole.unlimitedByPayment]).toEqual([true, false]);

    const byPayment = quotaFrom(unlimitedSubscription(), MEMBER);
    expect([byPayment.unlimitedByRole, byPayment.unlimitedByPayment]).toEqual([false, true]);

    // An operator who also paid. The payment is the more durable of the two facts — it is what
    // survives the role being handed over — so the exemption must not mask it.
    const both = quotaFrom(unlimitedSubscription(), ADMIN);
    expect([both.unlimitedByRole, both.unlimitedByPayment]).toEqual([true, true]);

    const neither = quotaFrom(subscription(), MEMBER);
    expect([neither.unlimitedByRole, neither.unlimitedByPayment]).toEqual([false, false]);
    expect(neither.unlimited).toBe(false);
  });

  it("reports the effective plan, which is the one the gateway enforces", () => {
    expect(quotaFrom(subscription({ plan: "free" }), ADMIN).plan).toBe(UNLIMITED_PLAN_ID);
    expect(quotaFrom(subscription({ plan: "free" }), MEMBER).plan).toBe("free");
    // An operator-assigned tier is reported as stored for a member, and still lifted for an admin.
    expect(quotaFrom(subscription({ plan: "business" }), MEMBER).plan).toBe("business");
    expect(quotaFrom(subscription({ plan: "business" }), ADMIN).plan).toBe(UNLIMITED_PLAN_ID);
  });

  it("describes an operator like any uncapped account, with no bar and no renewal", () => {
    // `describeQuota` branches on `quota.unlimited` alone, so it never has to learn about roles.
    const display = describeQuota(quotaFrom(subscription({ tokensUsed: 7_000 }), ADMIN));
    expect(display.unlimited).toBe(true);
    expect(display.primary).toBe("Unlimited");
    expect(display.percent).toBe(null);
    expect(display.renewalLabel).toBe(null);
    expect(display.exhausted).toBe(false);
  });
});

describe("describeQuota", () => {
  it("describes an unlimited account with no bar and no renewal", () => {
    const display = describeQuota(
      quotaFrom(unlimitedSubscription({ tokensUsed: 12_345_678 }), MEMBER),
    );
    expect(display).toEqual({
      unlimited: true,
      primary: "Unlimited",
      secondary: "no token ceiling",
      percent: null,
      warning: false,
      exhausted: false,
      renewalLabel: null,
    });
  });

  it("never prints the 2B sentinel as if it were a budget", () => {
    const display = describeQuota(quotaFrom(unlimitedSubscription({ tokensUsed: 5 }), MEMBER));
    for (const text of [display.primary, display.secondary]) {
      expect(text).not.toMatch(/2(\.0)?B/);
    }
  });

  it("describes a metered account with a percentage and a reset label", () => {
    const display = describeQuota(quotaFrom(subscription({ tokensUsed: 125_000 }), MEMBER));
    expect(display.unlimited).toBe(false);
    expect(display.primary).toBe("125K");
    expect(display.secondary).toBe("of 250K left");
    expect(display.percent).toBe(50);
    expect(display.warning).toBe(false);
    expect(display.renewalLabel).toBe("resets");
  });

  it("warns past 85% but not once the allocation is spent", () => {
    expect(describeQuota(quotaFrom(subscription({ tokensUsed: 220_000 }), MEMBER)).warning).toBe(
      true,
    );
    const spent = describeQuota(quotaFrom(subscription({ tokensUsed: 250_000 }), MEMBER));
    expect(spent.warning).toBe(false);
    expect(spent.exhausted).toBe(true);
    expect(spent.percent).toBe(100);
  });
});
