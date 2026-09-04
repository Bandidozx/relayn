/**
 * CSRF. Both halves of the defence are exercised: the Origin/Referer host check and the
 * double-submit token. `next/headers` is mocked because `checkCsrf` reads the cookie jar
 * through it; everything else is the real implementation.
 *
 * The cases here mirror the failures seen for real while building the app — a curl POST
 * with no Origin header, and a foreign Origin carrying a valid token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const { CSRF_COOKIE, CSRF_HEADER, checkCsrf, clearCsrfToken, rotateCsrfToken } = await import(
  "@/lib/security/csrf"
);

const TOKEN = "a".repeat(32);
const ORIGIN = "http://localhost:3200";

function req(init: {
  method?: string;
  origin?: string | null;
  referer?: string | null;
  host?: string | null;
  token?: string | null;
}): Request {
  const headers = new Headers();
  if (init.host !== null) headers.set("host", init.host ?? "localhost:3200");
  if (init.origin) headers.set("origin", init.origin);
  if (init.referer) headers.set("referer", init.referer);
  if (init.token) headers.set(CSRF_HEADER, init.token);
  return new Request("http://localhost:3200/api/keys", {
    method: init.method ?? "POST",
    headers,
  });
}

beforeEach(() => {
  jar.clear();
  jar.set(CSRF_COOKIE, TOKEN);
});

describe("rotateCsrfToken", () => {
  it("issues a readable token of at least 32 characters", async () => {
    jar.clear();
    const token = await rotateCsrfToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(jar.get(CSRF_COOKIE)).toBe(token);
  });

  it("replaces an existing token, so sign-in invalidates a planted value", async () => {
    const planted = jar.get(CSRF_COOKIE);
    const rotated = await rotateCsrfToken();
    expect(rotated).not.toBe(planted);
    expect(jar.get(CSRF_COOKIE)).toBe(rotated);
  });
});

describe("clearCsrfToken", () => {
  it("removes the cookie on logout and account deletion", async () => {
    await clearCsrfToken();
    expect(jar.has(CSRF_COOKIE)).toBe(false);
  });
});

describe("checkCsrf — safe methods", () => {
  it("never blocks a read, even with no Origin and no token", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get", "head"]) {
      jar.clear();
      await expect(checkCsrf(req({ method, host: null }))).resolves.toBeNull();
    }
  });
});

describe("checkCsrf — Origin check", () => {
  it("accepts a same-origin write carrying the matching token", async () => {
    await expect(checkCsrf(req({ origin: ORIGIN, token: TOKEN }))).resolves.toBeNull();
  });

  it("falls back to Referer when Origin is absent", async () => {
    await expect(
      checkCsrf(req({ referer: `${ORIGIN}/api-keys`, token: TOKEN })),
    ).resolves.toBeNull();
  });

  it("rejects a write with no Origin and no Referer", async () => {
    // This is exactly what a plain `curl -X POST` looks like.
    const failure = await checkCsrf(req({ token: TOKEN }));
    expect(failure?.code).toBe("csrf_origin_mismatch");
  });

  it("rejects a cross-site Origin even when the token is right", async () => {
    const failure = await checkCsrf(req({ origin: "https://evil.example", token: TOKEN }));
    expect(failure?.code).toBe("csrf_origin_mismatch");
  });

  it("rejects a look-alike host", async () => {
    for (const origin of [
      "http://localhost:3201",
      "http://localhost",
      "http://localhost.evil.example:3200",
      "http://evil.example/?x=http://localhost:3200",
    ]) {
      const failure = await checkCsrf(req({ origin, token: TOKEN }));
      expect(failure?.code, origin).toBe("csrf_origin_mismatch");
    }
  });

  it("rejects a malformed Origin instead of throwing", async () => {
    const failure = await checkCsrf(req({ origin: "not-a-url", token: TOKEN }));
    expect(failure?.code).toBe("csrf_origin_mismatch");
  });

  it("rejects when the Host header is missing", async () => {
    const failure = await checkCsrf(req({ origin: ORIGIN, token: TOKEN, host: null }));
    expect(failure?.code).toBe("csrf_origin_mismatch");
  });
});

describe("checkCsrf — double-submit token", () => {
  it("rejects a missing header", async () => {
    const failure = await checkCsrf(req({ origin: ORIGIN }));
    expect(failure?.code).toBe("csrf_token_missing");
  });

  it("rejects a missing cookie", async () => {
    jar.clear();
    const failure = await checkCsrf(req({ origin: ORIGIN, token: TOKEN }));
    expect(failure?.code).toBe("csrf_token_missing");
  });

  it("rejects a header that does not match the cookie", async () => {
    const failure = await checkCsrf(req({ origin: ORIGIN, token: "b".repeat(32) }));
    expect(failure?.code).toBe("csrf_token_mismatch");
  });

  it("rejects a token that is merely a prefix of the cookie", async () => {
    const failure = await checkCsrf(req({ origin: ORIGIN, token: TOKEN.slice(0, 31) }));
    expect(failure?.code).toBe("csrf_token_mismatch");
  });

  it("accepts the freshly rotated token", async () => {
    const token = await rotateCsrfToken();
    await expect(checkCsrf(req({ origin: ORIGIN, token }))).resolves.toBeNull();
  });
});
