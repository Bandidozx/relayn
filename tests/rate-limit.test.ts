/**
 * Rate limiting. Fixed-window counters with an in-process store; the tests drive the clock
 * so window rollover is asserted rather than slept through.
 *
 * `gatewayRateLimit` is the one the gateway calls, and the property that matters is that
 * the per-key ceiling is checked *first* — one noisy key must not consume another key's
 * budget, but it must still count against the account-wide ceiling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authRateLimit,
  gatewayRateLimit,
  rateLimit,
  rateLimitHeaders,
  resetRateLimits,
  type RateLimitStore,
} from "@/lib/security/rate-limit";

beforeEach(() => {
  resetRateLimits();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  resetRateLimits();
});

describe("rateLimit", () => {
  it("allows exactly `limit` requests, then blocks", () => {
    const results = Array.from({ length: 6 }, () => rateLimit("k", 5));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
  });

  it("counts remaining down to zero and never below", () => {
    expect(rateLimit("k", 3).remaining).toBe(2);
    expect(rateLimit("k", 3).remaining).toBe(1);
    expect(rateLimit("k", 3).remaining).toBe(0);
    expect(rateLimit("k", 3).remaining).toBe(0);
  });

  it("keys are independent", () => {
    rateLimit("a", 1);
    expect(rateLimit("a", 1).allowed).toBe(false);
    expect(rateLimit("b", 1).allowed).toBe(true);
  });

  it("rolls over when the window expires", () => {
    rateLimit("k", 1);
    expect(rateLimit("k", 1).allowed).toBe(false);
    vi.advanceTimersByTime(59_999);
    expect(rateLimit("k", 1).allowed).toBe(false);
    vi.advanceTimersByTime(2);
    expect(rateLimit("k", 1).allowed).toBe(true);
  });

  it("reports a reset timestamp in whole seconds, one window ahead", () => {
    const result = rateLimit("k", 5);
    expect(result.resetAt).toBe(Math.ceil((Date.parse("2026-08-21T12:00:00Z") + 60_000) / 1000));
    expect(result.retryAfterSeconds).toBe(60);
  });

  it("treats a zero or negative limit as 1 rather than locking everyone out", () => {
    expect(rateLimit("z", 0).allowed).toBe(true);
    expect(rateLimit("z", 0).allowed).toBe(false);
    expect(rateLimit("n", -5).limit).toBe(1);
  });

  it("honours a custom window", () => {
    rateLimit("w", 1, 1_000);
    expect(rateLimit("w", 1, 1_000).allowed).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(rateLimit("w", 1, 1_000).allowed).toBe(true);
  });

  it("delegates to an injected store, which is the Redis seam", () => {
    const calls: Array<[string, number]> = [];
    const fake: RateLimitStore = {
      hit(key, windowMs) {
        calls.push([key, windowMs]);
        return { count: 99, resetAt: Date.now() + windowMs };
      },
    };
    const result = rateLimit("external", 10, 30_000, fake);
    expect(calls).toEqual([["external", 30_000]]);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

describe("gatewayRateLimit", () => {
  it("limits a single key to its plan's rate", () => {
    const results = Array.from({ length: 4 }, () => gatewayRateLimit("user-1", "key-1", 3));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]!.limit).toBe(3);
  });

  it("does not let one key eat another key's budget", () => {
    for (let i = 0; i < 3; i += 1) gatewayRateLimit("user-1", "key-1", 3);
    expect(gatewayRateLimit("user-1", "key-1", 3).allowed).toBe(false);
    expect(gatewayRateLimit("user-1", "key-2", 3).allowed).toBe(true);
  });

  it("still enforces an account-wide ceiling of twice the per-key rate", () => {
    // Two keys at 3/min each: the 7th account request trips the user bucket (limit 6).
    let allowed = 0;
    for (let i = 0; i < 4; i += 1) if (gatewayRateLimit("user-2", "key-a", 3).allowed) allowed += 1;
    for (let i = 0; i < 4; i += 1) if (gatewayRateLimit("user-2", "key-b", 3).allowed) allowed += 1;
    expect(allowed).toBe(6);
  });

  it("separates users", () => {
    for (let i = 0; i < 5; i += 1) gatewayRateLimit("user-3", "key-x", 2);
    expect(gatewayRateLimit("user-3", "key-x", 2).allowed).toBe(false);
    expect(gatewayRateLimit("user-4", "key-y", 2).allowed).toBe(true);
  });
});

describe("authRateLimit", () => {
  it("scopes by IP and by endpoint", () => {
    const first = authRateLimit("203.0.113.9", "login");
    expect(first.allowed).toBe(true);
    for (let i = 1; i < first.limit; i += 1) authRateLimit("203.0.113.9", "login");
    expect(authRateLimit("203.0.113.9", "login").allowed).toBe(false);
    // A different endpoint and a different IP each get their own bucket.
    expect(authRateLimit("203.0.113.9", "register").allowed).toBe(true);
    expect(authRateLimit("198.51.100.4", "login").allowed).toBe(true);
  });
});

describe("rateLimitHeaders", () => {
  it("omits Retry-After while requests are still allowed", () => {
    const headers = rateLimitHeaders(rateLimit("h", 5));
    expect(headers["x-ratelimit-limit"]).toBe("5");
    expect(headers["x-ratelimit-remaining"]).toBe("4");
    expect(headers["retry-after"]).toBeUndefined();
  });

  it("adds Retry-After once throttled, so a client knows when to come back", () => {
    rateLimit("h2", 1);
    const headers = rateLimitHeaders(rateLimit("h2", 1));
    expect(headers["x-ratelimit-remaining"]).toBe("0");
    expect(Number(headers["retry-after"])).toBeGreaterThan(0);
  });
});
