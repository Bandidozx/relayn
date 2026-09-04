/**
 * Secret generation and hashing helpers.
 *
 * Everything long-lived (session tokens, API keys, verification tokens) is stored as a
 * SHA-256 hash. A database leak therefore never yields a usable credential.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const API_KEY_PREFIX = "rly_live";

/** URL-safe random string with `bytes * 8` bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface GeneratedApiKey {
  /** Full secret — returned to the user exactly once, never persisted. */
  secret: string;
  hash: string;
  prefix: string;
  last4: string;
}

/**
 * 256 bits of entropy, prefixed so keys are recognisable in logs and secret scanners.
 * Example: rly_live_9Qk2...ZP4a
 */
export function generateApiKey(): GeneratedApiKey {
  const body = randomBytes(32).toString("base64url");
  const secret = `${API_KEY_PREFIX}_${body}`;
  return {
    secret,
    hash: sha256(secret),
    prefix: API_KEY_PREFIX,
    last4: secret.slice(-4),
  };
}

/** Gateway request identifier, mirroring the shape upstream providers use. */
export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "")}`;
}

export function newCompletionId(): string {
  return `chatcmpl-${randomBytes(12).toString("hex")}`;
}

/** Anthropic-dialect message identifier for POST /v1/messages. */
export function newMessageId(): string {
  return `msg_${randomBytes(12).toString("hex")}`;
}
