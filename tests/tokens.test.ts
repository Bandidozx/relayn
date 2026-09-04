/**
 * Credential primitives: API keys, hashes, constant-time comparison.
 *
 * These are the functions that decide whether a leaked database is exploitable, so the
 * properties asserted here are the ones that matter: keys are random, only their hash is
 * derivable from them, and comparison does not short-circuit on content.
 */
import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  constantTimeEquals,
  generateApiKey,
  newCompletionId,
  newRequestId,
  randomToken,
  sha256,
} from "@/lib/security/tokens";

describe("randomToken", () => {
  it("is URL-safe base64 with no padding", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(randomToken(24)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
  });

  it("does not repeat across 2000 draws", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => randomToken(24)));
    expect(seen.size).toBe(2000);
  });

  it("scales length with the byte count", () => {
    expect(randomToken(16)).toHaveLength(22);
    expect(randomToken(32)).toHaveLength(43);
  });
});

describe("generateApiKey", () => {
  it("prefixes the secret so it is recognisable in logs and secret scanners", () => {
    const key = generateApiKey();
    expect(key.secret.startsWith(`${API_KEY_PREFIX}_`)).toBe(true);
    expect(key.prefix).toBe(API_KEY_PREFIX);
  });

  it("carries at least 256 bits of entropy in the body", () => {
    // Split on the prefix rather than "_": base64url itself contains underscores.
    const body = generateApiKey().secret.slice(API_KEY_PREFIX.length + 1);
    // 32 random bytes in base64url.
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("stores only a hash, and that hash is derivable from the secret", () => {
    const key = generateApiKey();
    expect(key.hash).toBe(sha256(key.secret));
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
    // The reverse must not hold: the hash must not contain the secret.
    expect(key.hash).not.toContain(key.secret);
  });

  it("keeps a last4 that matches the tail of the secret", () => {
    const key = generateApiKey();
    expect(key.secret.endsWith(key.last4)).toBe(true);
    expect(key.last4).toHaveLength(4);
  });

  it("never issues the same secret twice", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateApiKey().secret));
    expect(seen.size).toBe(500);
  });
});

describe("sha256", () => {
  it("matches the published digest for a known input", () => {
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is stable across calls and sensitive to a single bit", () => {
    expect(sha256("relayn")).toBe(sha256("relayn"));
    expect(sha256("relayn")).not.toBe(sha256("relayo"));
  });
});

describe("constantTimeEquals", () => {
  it("accepts identical strings", () => {
    expect(constantTimeEquals("rly_live_abc", "rly_live_abc")).toBe(true);
  });

  it("rejects a difference in the first or last character", () => {
    expect(constantTimeEquals("abcdef", "Xbcdef")).toBe(false);
    expect(constantTimeEquals("abcdef", "abcdeX")).toBe(false);
  });

  it("rejects length mismatches without throwing", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals("", "a")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });

  it("handles multi-byte characters by byte length", () => {
    expect(constantTimeEquals("é", "é")).toBe(true);
    expect(constantTimeEquals("é", "e")).toBe(false);
  });
});

describe("identifiers", () => {
  it("shapes request and completion ids like the upstream APIs", () => {
    expect(newRequestId()).toMatch(/^req_[0-9a-f]{32}$/);
    expect(newCompletionId()).toMatch(/^chatcmpl-[0-9a-f]{24}$/);
  });
});
