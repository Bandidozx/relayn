/**
 * Google as a sign-in provider (OpenID Connect authorization-code flow with PKCE).
 *
 * Shape of the flow, and why each step is there:
 *
 *   1. `/api/auth/oauth/google` seals a transaction (state + PKCE verifier + nonce) into a
 *      cookie and redirects to Google.
 *   2. Google redirects back to `/api/auth/oauth/google/callback?code=…&state=…`.
 *   3. `state` is compared against the cookie, then the code is exchanged server-to-server
 *      for an `id_token`. The client secret and the PKCE verifier both go in that request,
 *      so a stolen `code` alone is not enough for anyone.
 *   4. The `id_token`'s claims are validated and reduced to an `OAuthIdentity`.
 *
 * On signature verification: the `id_token` is read from the body of a direct TLS request
 * to Google's own token endpoint, which OIDC Core §3.1.3.7 explicitly allows to be trusted
 * without re-checking the JWS — the transport already authenticates the issuer. What must
 * still be checked, and is checked below, are the claims: `iss`, `aud` (this deployment's
 * client, so a token minted for a different app is refused), `exp`, and `nonce` (binding the
 * token to the transaction this browser started). A token arriving any other way would need
 * full JWKS verification and is never accepted here.
 */
import "server-only";
import { env } from "@/lib/env";
import { codeChallengeOf, type OAuthTransaction } from "@/lib/auth/oauth/transaction";
import { OAuthError, type OAuthIdentity, type OAuthProvider } from "@/lib/auth/oauth/types";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const EXCHANGE_TIMEOUT_MS = 15_000;
/** Tolerance for clock skew between this host and Google when checking `exp`. */
const CLOCK_SKEW_SECONDS = 60;

/** The subset of the ID token this application reads. */
export interface GoogleIdTokenClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

/** Decodes a JWS payload without verifying it — see the module note on why that is sound here. */
export function decodeIdTokenPayload(idToken: string): GoogleIdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as GoogleIdTokenClaims;
  } catch {
    return null;
  }
}

/**
 * Turns raw claims into an identity, or throws. Split out from the network call so the
 * rules are unit-testable without stubbing an HTTP round trip.
 */
export function identityFromClaims(
  claims: GoogleIdTokenClaims | null,
  input: { clientId: string; nonce: string; now?: number },
): OAuthIdentity {
  if (!claims) throw new OAuthError("oauth_exchange_failed", "id_token was not decodable JSON.");

  if (!claims.iss || !ISSUERS.has(claims.iss)) {
    throw new OAuthError("oauth_exchange_failed", `unexpected issuer: ${claims.iss ?? "none"}`);
  }
  if (claims.aud !== input.clientId) {
    // A token minted for another OAuth client would otherwise be replayable here.
    throw new OAuthError("oauth_exchange_failed", "id_token audience is not this client.");
  }
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now) {
    throw new OAuthError("oauth_exchange_failed", "id_token has expired.");
  }
  if (claims.nonce !== input.nonce) {
    throw new OAuthError("oauth_state_invalid", "id_token nonce does not match the transaction.");
  }
  if (!claims.sub) {
    throw new OAuthError("oauth_exchange_failed", "id_token carries no subject.");
  }

  const email = claims.email?.trim().toLowerCase();
  if (!email) {
    throw new OAuthError("oauth_exchange_failed", "Google returned no email address.");
  }
  // Google sends this as a real boolean on the ID token and as the string "true" on the
  // userinfo endpoint; accept both, and treat anything else as unverified.
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  if (!emailVerified) {
    throw new OAuthError("oauth_email_unverified", `Google has not verified ${email}.`);
  }

  return {
    provider: "google",
    subject: claims.sub,
    email,
    emailVerified,
    ...(claims.name ? { name: claims.name } : {}),
    ...(claims.picture?.startsWith("https://") ? { avatarUrl: claims.picture } : {}),
  };
}

export const googleOAuthProvider: OAuthProvider = {
  id: "google",
  label: "Google",
  credentialEnvVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],

  isConfigured(): boolean {
    return (
      env.oauth.google.clientId.length > 0 && env.oauth.google.clientSecret.length > 0
    );
  },

  authorizationUrl(transaction: OAuthTransaction, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: env.oauth.google.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: codeChallengeOf(transaction.verifier),
      code_challenge_method: "S256",
      // Google remembers a previous consent; `select_account` still lets someone sign in
      // with a different address than the one their browser defaults to.
      prompt: "select_account",
    });
    return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
  },

  async exchange({ code, transaction, redirectUri }): Promise<OAuthIdentity> {
    const body = new URLSearchParams({
      code,
      client_id: env.oauth.google.clientId,
      client_secret: env.oauth.google.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: transaction.verifier,
    });

    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OAuthError(
        "oauth_exchange_failed",
        `token endpoint unreachable: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }

    if (!response.ok) {
      // Google's error body can name the misconfiguration (redirect_uri_mismatch, bad
      // secret). It goes to the server log for the operator, never to the browser.
      const detail = await response.text().catch(() => "");
      throw new OAuthError(
        "oauth_exchange_failed",
        `token endpoint returned ${response.status}: ${detail.slice(0, 300)}`,
      );
    }

    const payload = (await response.json().catch(() => null)) as { id_token?: string } | null;
    if (!payload?.id_token) {
      throw new OAuthError("oauth_exchange_failed", "token response carried no id_token.");
    }

    return identityFromClaims(decodeIdTokenPayload(payload.id_token), {
      clientId: env.oauth.google.clientId,
      nonce: transaction.nonce,
    });
  },
};

/**
 * Registry of sign-in providers. Null-prototyped because the lookup key is a URL path
 * segment: on a plain object literal, `getOAuthProvider("__proto__")` would hand back
 * `Object.prototype` and `"constructor"` would hand back a function, either of which then
 * fails deep inside a route rather than at the lookup.
 */
const PROVIDERS: Record<string, OAuthProvider> = Object.assign(Object.create(null), {
  google: googleOAuthProvider,
});

export function getOAuthProvider(id: string): OAuthProvider | null {
  return PROVIDERS[id] ?? null;
}

/** Drives whether the sign-in pages offer the button at all. */
export function isGoogleOAuthConfigured(): boolean {
  return googleOAuthProvider.isConfigured();
}

/** Absolute callback URL. Must match a redirect URI registered in Google Cloud Console. */
export function oauthRedirectUri(providerId: string): string {
  return `${env.appUrl}/api/auth/oauth/${providerId}/callback`;
}
