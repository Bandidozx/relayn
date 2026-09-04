/**
 * Fixed-window rate limiter.
 *
 * Deliberately in-process: it needs no infrastructure and is correct for a single
 * instance, which is how this app runs by default. `RateLimitStore` is the seam to
 * swap in Redis/Upstash for a multi-instance deployment — implement `hit()` against
 * `INCR`/`EXPIRE` and pass it to `rateLimit()`.
 */
import { env } from "@/lib/env";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the current window rolls over. */
  resetAt: number;
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number): { count: number; resetAt: number };
}

class MemoryStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  hit(key: string, windowMs: number) {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) {
      for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
      this.lastSweep = now;
    }
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, fresh);
      return fresh;
    }
    existing.count += 1;
    return existing;
  }

  reset() {
    this.buckets.clear();
  }
}

const store = new MemoryStore();

/** Test helper — clears all counters. */
export function resetRateLimits(): void {
  store.reset();
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs = 60_000,
  backing: RateLimitStore = store,
): RateLimitResult {
  const effectiveLimit = Math.max(1, limit);
  const { count, resetAt } = backing.hit(key, windowMs);
  const remaining = Math.max(0, effectiveLimit - count);
  return {
    allowed: count <= effectiveLimit,
    limit: effectiveLimit,
    remaining,
    resetAt: Math.ceil(resetAt / 1000),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
  };
}

/**
 * Gateway traffic: limited per API key, and per user across all their keys.
 *
 * `limitPerMinute` comes from the caller's plan, so upgrading actually raises throughput;
 * `RATE_LIMIT_PER_MINUTE` is the fallback when no plan limit is supplied.
 */
export function gatewayRateLimit(
  userId: string,
  apiKeyId: string,
  limitPerMinute = env.rateLimitPerMinute,
): RateLimitResult {
  const perKey = rateLimit(`gw:key:${apiKeyId}`, limitPerMinute);
  if (!perKey.allowed) return perKey;
  // The account-wide ceiling is deliberately looser than the sum of key limits.
  return rateLimit(`gw:user:${userId}`, limitPerMinute * 2);
}

/** Credential endpoints: limited per IP to slow credential stuffing. */
export function authRateLimit(ip: string, scope: string): RateLimitResult {
  return rateLimit(`auth:${scope}:${ip}`, env.rateLimitAuthPerMinute);
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "x-ratelimit-limit": String(result.limit),
    "x-ratelimit-remaining": String(result.remaining),
    "x-ratelimit-reset": String(result.resetAt),
    ...(result.allowed ? {} : { "retry-after": String(result.retryAfterSeconds) }),
  };
}
