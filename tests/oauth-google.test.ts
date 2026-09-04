/**
 * Google sign-in: the parts that decide whether a callback is trustworthy.
 *
 * These are pure functions by design — the transaction cookie is sealed and opened without a
 * request context, and `identityFromClaims` validates an ID token's claims without an HTTP
 * round trip — so the security rules can be exercised directly instead of through a mocked
 * network. What is *not* covered here (and cannot be, without live credentials) is the token
 * exchange itself; that is documented in the README as requiring a real Google OAuth client.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  OAUTH_TRANSACTION_TTL_MS,
  codeChallengeOf,
  newTransaction,
  openTransaction,
  safeNextPath,
  sealTransaction,
  stateMatches,
} = await import("@/lib/auth/oauth/transaction");

const { decodeIdTokenPayload, googleOAuthProvider, identityFromClaims, oauthRedirectUri } =
  await import("@/lib/auth/oauth/google");

const { OAuthError, OAUTH_ERROR_MESSAGES } = await import("@/lib/auth/oauth/types");

describe("safeNextPath", () => {
  it("keeps a relative in-app path", () => {
    expect(safeNextPath("/usage")).toBe("/usage");
    expect(safeNextPath("/usage?page=2&status=error")).toBe("/usage?page=2&status=error");
  });

  it("collapses anything that could leave the site", () => {
    for (const hostile of [
      "//evil.example",
      "https://evil.example",
      "http://evil.example",
      "javascript:alert(1)",
      "/\\evil.example",
      "/usage\nSet-Cookie: x=1",
      "dashboard",
      "",
      null,
      undefined,
    ]) {
      expect(safeNextPath(hostile), String(hostile)).toBe("/dashboard");
    }
  });
});

describe("codeChallengeOf", () => {
  it("is a deterministic base64url SHA-256 of the verifier", () => {
    const challenge = codeChallengeOf("abc");
    // Known SHA-256 of "abc", base64url — a wrong encoding (base64 with padding, or hex)
    // would break PKCE against Google without failing anywhere locally.
    expect(challenge).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    expect(challenge).toBe(codeChallengeOf("abc"));
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it("does not leak the verifier", () => {
    const verifier = newTransaction("google", null).verifier;
    expect(codeChallengeOf(verifier)).not.toContain(verifier);
  });
});

describe("newTransaction", () => {
  it("mints unguessable, distinct values on every call", () => {
    const a = newTransaction("google", "/usage");
    const b = newTransaction("google", "/usage");

    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.nonce).not.toBe(b.nonce);
    // 24 / 32 / 16 random bytes in base64url.
    expect(a.state.length).toBeGreaterThanOrEqual(32);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(a.nonce.length).toBeGreaterThanOrEqual(21);
    expect(a.next).toBe("/usage");
    expect(a.linkUserId).toBeNull();
  });

  it("normalises `next` at mint time, not at redirect time", () => {
    expect(newTransaction("google", "https://evil.example").next).toBe("/dashboard");
  });

  it("carries a link target when one is given", () => {
    expect(newTransaction("google", null, "user_123").linkUserId).toBe("user_123");
  });
});

describe("sealTransaction / openTransaction", () => {
  it("round-trips every field", () => {
    const transaction = newTransaction("google", "/api-keys", "user_123");
    expect(openTransaction(sealTransaction(transaction), "google")).toEqual(transaction);
  });

  it("rejects a payload edited in the browser", () => {
    const transaction = newTransaction("google", "/dashboard");
    const sealed = sealTransaction(transaction);
    const [payload, signature] = sealed.split(".");

    // Re-encode the payload with an attacker-chosen state; the HMAC no longer matches.
    const forged = Buffer.from(
      JSON.stringify({ ...transaction, state: "attacker-state" }),
      "utf8",
    ).toString("base64url");

    expect(openTransaction(`${forged}.${signature}`, "google")).toBeNull();
    expect(payload).not.toBe(forged);
  });

  it("rejects a tampered signature and a missing one", () => {
    const sealed = sealTransaction(newTransaction("google", "/dashboard"));
    const [payload, signature] = sealed.split(".");

    expect(openTransaction(`${payload}.${signature!.slice(0, -1)}x`, "google")).toBeNull();
    expect(openTransaction(payload!, "google")).toBeNull();
    expect(openTransaction(`${payload}.`, "google")).toBeNull();
    expect(openTransaction("", "google")).toBeNull();
    expect(openTransaction(undefined, "google")).toBeNull();
  });

  it("rejects a cookie minted for a different provider", () => {
    const sealed = sealTransaction(newTransaction("github", "/dashboard"));
    expect(openTransaction(sealed, "google")).toBeNull();
  });

  it("rejects a cookie older than the TTL", () => {
    const stale = {
      ...newTransaction("google", "/dashboard"),
      issuedAt: Date.now() - OAUTH_TRANSACTION_TTL_MS - 1_000,
    };
    expect(openTransaction(sealTransaction(stale), "google")).toBeNull();

    const fresh = { ...stale, issuedAt: Date.now() - 1_000 };
    expect(openTransaction(sealTransaction(fresh), "google")).not.toBeNull();
  });

  it("rejects a payload whose linkUserId is not a string", () => {
    // A number here would sail through `session.user.id !== transaction.linkUserId` as a
    // mismatch, but an object with a `toString` could not be reasoned about at all — so the
    // shape is rejected outright rather than coerced.
    const transaction = newTransaction("google", "/profile");
    // Sealed with the real secret: a *valid* cookie carrying a malformed payload, which is
    // the only interesting case here — an unsigned one is already covered above.
    const forge = (linkUserId: unknown): string =>
      sealTransaction({ ...transaction, linkUserId } as never);

    expect(openTransaction(forge(7), "google")).toBeNull();
    expect(openTransaction(forge({}), "google")).toBeNull();
    expect(openTransaction(forge(null), "google")?.linkUserId).toBeNull();
    // Absent entirely — a cookie sealed before link mode existed — reads as "not a link flow".
    const { linkUserId: _dropped, ...withoutField } = transaction;
    expect(openTransaction(sealTransaction(withoutField as never), "google")?.linkUserId).toBeNull();
  });
});

describe("stateMatches", () => {
  const transaction = newTransaction("google", "/dashboard");

  it("accepts only the exact sealed value", () => {
    expect(stateMatches(transaction, transaction.state)).toBe(true);
    expect(stateMatches(transaction, transaction.state.slice(0, -1))).toBe(false);
    expect(stateMatches(transaction, `${transaction.state}x`)).toBe(false);
    expect(stateMatches(transaction, transaction.state.toUpperCase())).toBe(false);
    expect(stateMatches(transaction, "")).toBe(false);
    expect(stateMatches(transaction, null)).toBe(false);
  });
});

describe("decodeIdTokenPayload", () => {
  function jwt(payload: unknown): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    // The signature is deliberately nonsense: this function does not verify it, which is
    // exactly why its output is only ever trusted when the token came straight from Google's
    // token endpoint over TLS.
    return `${part({ alg: "RS256" })}.${part(payload)}.not-a-signature`;
  }

  it("reads the claim set out of the middle segment", () => {
    expect(decodeIdTokenPayload(jwt({ sub: "1", email: "a@b.test" }))).toEqual({
      sub: "1",
      email: "a@b.test",
    });
  });

  it("returns null for anything that is not a three-part JWS", () => {
    for (const bad of ["", ".", "a.b", "a.b.c.d", "header..signature", "not a token at all"]) {
      expect(decodeIdTokenPayload(bad), bad).toBeNull();
    }
  });

  it("returns null when the payload is not JSON", () => {
    const payload = Buffer.from("plain text, not json", "utf8").toString("base64url");
    expect(decodeIdTokenPayload(`header.${payload}.signature`)).toBeNull();
  });
});

describe("identityFromClaims", () => {
  const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
  const CLIENT_ID = "1234.apps.googleusercontent.com";
  const NONCE = "transaction-nonce";

  /** A claim set Google would actually send, with per-test overrides. */
  function claims(overrides: Record<string, unknown> = {}) {
    return {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "108374615532",
      exp: Math.floor(NOW / 1000) + 3600,
      nonce: NONCE,
      email: "Person@Example.test",
      email_verified: true,
      name: "A Person",
      picture: "https://lh3.googleusercontent.com/a/abc",
      ...overrides,
    } as never;
  }

  const identify = (overrides?: Record<string, unknown>) =>
    identityFromClaims(claims(overrides), { clientId: CLIENT_ID, nonce: NONCE, now: NOW });

  /** The `code` of the OAuthError a call throws — fails the test if it throws nothing. */
  function refusalCode(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      if (error instanceof OAuthError) return error.code;
      throw error;
    }
    throw new Error("expected an OAuthError; the claims were accepted");
  }

  it("reduces a good token to the four facts that get persisted", () => {
    expect(identify()).toEqual({
      provider: "google",
      subject: "108374615532",
      // Normalised, because the account lookup and the local `users.email` column are both
      // lowercase — a mixed-case claim must not create a second account.
      email: "person@example.test",
      emailVerified: true,
      name: "A Person",
      avatarUrl: "https://lh3.googleusercontent.com/a/abc",
    });
  });

  it("accepts both issuer spellings Google uses", () => {
    expect(identify({ iss: "accounts.google.com" }).subject).toBe("108374615532");
    expect(identify({ iss: "https://accounts.google.com" }).subject).toBe("108374615532");
  });

  it("omits optional profile fields rather than storing empty ones", () => {
    const identity = identify({ name: undefined, picture: undefined });
    expect(identity.name).toBeUndefined();
    expect(identity.avatarUrl).toBeUndefined();
  });

  it("drops an avatar that is not https", () => {
    // Rendered in an <img src>, so a `javascript:`/`data:` value must never reach the DOM.
    for (const picture of [
      "http://lh3.googleusercontent.com/a/abc",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "//evil.example/a.png",
    ]) {
      expect(identify({ picture }).avatarUrl, picture).toBeUndefined();
    }
  });

  it("refuses a token minted by someone other than Google", () => {
    expect(refusalCode(() => identify({ iss: "https://accounts.google.com.evil.test" }))).toBe(
      "oauth_exchange_failed",
    );
    expect(refusalCode(() => identify({ iss: undefined }))).toBe("oauth_exchange_failed");
  });

  it("refuses a token minted for a different OAuth client", () => {
    // Without this check, an id_token obtained by any other Google app would sign its holder
    // in here as whoever the token describes.
    expect(refusalCode(() => identify({ aud: "9999.apps.googleusercontent.com" }))).toBe(
      "oauth_exchange_failed",
    );
    expect(refusalCode(() => identify({ aud: undefined }))).toBe("oauth_exchange_failed");
  });

  it("refuses an expired token but tolerates a minute of clock skew", () => {
    const secondsFromNow = (delta: number) => Math.floor(NOW / 1000) + delta;

    expect(refusalCode(() => identify({ exp: secondsFromNow(-3600) }))).toBe(
      "oauth_exchange_failed",
    );
    expect(refusalCode(() => identify({ exp: secondsFromNow(-61) }))).toBe("oauth_exchange_failed");
    expect(refusalCode(() => identify({ exp: undefined }))).toBe("oauth_exchange_failed");
    expect(refusalCode(() => identify({ exp: "9999999999" }))).toBe("oauth_exchange_failed");

    expect(identify({ exp: secondsFromNow(-30) }).subject).toBe("108374615532");
  });

  it("refuses a token that answers a different transaction", () => {
    // The nonce is what binds this token to the browser that started the flow; a mismatch is
    // reported as a state failure, not an exchange failure, because that is what it is.
    expect(refusalCode(() => identify({ nonce: "someone-elses-nonce" }))).toBe(
      "oauth_state_invalid",
    );
    expect(refusalCode(() => identify({ nonce: undefined }))).toBe("oauth_state_invalid");
  });

  it("refuses a token with no subject or no email", () => {
    expect(refusalCode(() => identify({ sub: undefined }))).toBe("oauth_exchange_failed");
    expect(refusalCode(() => identify({ sub: "" }))).toBe("oauth_exchange_failed");
    expect(refusalCode(() => identify({ email: undefined }))).toBe("oauth_exchange_failed");
    expect(refusalCode(() => identify({ email: "   " }))).toBe("oauth_exchange_failed");
  });

  it("refuses an unverified address, accepting the boolean and the string form", () => {
    // The userinfo endpoint sends "true"; the ID token sends true. Anything else — including
    // the string "false", which is truthy — must not count as verified.
    expect(identify({ email_verified: true }).emailVerified).toBe(true);
    expect(identify({ email_verified: "true" }).emailVerified).toBe(true);

    for (const value of [false, "false", "TRUE", 1, "1", undefined, null, ""]) {
      expect(refusalCode(() => identify({ email_verified: value })), String(value)).toBe(
        "oauth_email_unverified",
      );
    }
  });

  it("refuses claims that did not decode at all", () => {
    expect(
      refusalCode(() => identityFromClaims(null, { clientId: CLIENT_ID, nonce: NONCE, now: NOW })),
    ).toBe("oauth_exchange_failed");
  });

  it("never puts the upstream reason in a browser-facing message", () => {
    for (const code of Object.keys(OAUTH_ERROR_MESSAGES)) {
      const message = OAUTH_ERROR_MESSAGES[code]!;
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain("id_token");
      expect(message).not.toContain(CLIENT_ID);
    }
    // Every code the routes can redirect with has wording; an unknown one renders nothing.
    for (const code of [
      "oauth_unavailable",
      "oauth_state_invalid",
      "oauth_denied",
      "oauth_exchange_failed",
      "oauth_email_unverified",
      "oauth_account_suspended",
      "oauth_already_linked",
    ]) {
      expect(OAUTH_ERROR_MESSAGES[code], code).toBeTruthy();
    }
    expect(OAUTH_ERROR_MESSAGES["<script>alert(1)</script>"]).toBeUndefined();
  });
});

/**
 * These read `env`, which snapshots `process.env` once at import time — so each case stubs the
 * variables and re-imports the module rather than mutating a live object.
 */
describe("googleOAuthProvider configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function reimport(vars: Record<string, string>) {
    for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
    vi.resetModules();
    return await import("@/lib/auth/oauth/google");
  }

  it("stays off unless both halves of the credential are present", async () => {
    for (const vars of [
      { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "" },
      { GOOGLE_OAUTH_CLIENT_ID: "client-id", GOOGLE_OAUTH_CLIENT_SECRET: "" },
      { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "secret" },
    ]) {
      const { googleOAuthProvider: provider, isGoogleOAuthConfigured } = await reimport(vars);
      expect(provider.isConfigured(), JSON.stringify(vars)).toBe(false);
      // What the login and register pages actually branch on.
      expect(isGoogleOAuthConfigured()).toBe(false);
    }

    const { isGoogleOAuthConfigured } = await reimport({
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
    });
    expect(isGoogleOAuthConfigured()).toBe(true);
  });

  it("names the env vars an operator has to set", async () => {
    const { googleOAuthProvider: provider } = await reimport({});
    expect(provider.credentialEnvVars).toEqual([
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
    ]);
    expect(provider.id).toBe("google");
  });

  it("builds an authorization URL Google will accept", async () => {
    const { googleOAuthProvider: provider } = await reimport({
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
    });
    const transaction = newTransaction("google", "/usage");
    const url = new URL(
      provider.authorizationUrl(transaction, "https://relayn.test/api/auth/oauth/google/callback"),
    );

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-id",
      redirect_uri: "https://relayn.test/api/auth/oauth/google/callback",
      response_type: "code",
      scope: "openid email profile",
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: codeChallengeOf(transaction.verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    // The PKCE secret and the client secret both stay on this side of the redirect.
    expect(url.toString()).not.toContain(transaction.verifier);
    expect(url.toString()).not.toContain("secret");
  });

  it("derives the callback URL from APP_URL, trailing slash or not", async () => {
    for (const appUrl of ["https://relayn.example", "https://relayn.example/"]) {
      const { oauthRedirectUri: redirectUri } = await reimport({ APP_URL: appUrl });
      // This string has to match a registered redirect URI byte for byte, which is why
      // `redirect_uri_mismatch` is the usual first-run failure.
      expect(redirectUri("google"), appUrl).toBe(
        "https://relayn.example/api/auth/oauth/google/callback",
      );
    }
  });

  it("resolves google and nothing else", async () => {
    const { getOAuthProvider } = await reimport({});
    expect(getOAuthProvider("google")?.id).toBe("google");
    expect(getOAuthProvider("github")).toBeNull();
    expect(getOAuthProvider("")).toBeNull();
    // A prototype key must not resolve to a "provider".
    expect(getOAuthProvider("constructor")).toBeNull();
    expect(getOAuthProvider("__proto__")).toBeNull();
  });
});









