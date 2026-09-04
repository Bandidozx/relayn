/**
 * The short-lived state that has to survive the round trip to the identity provider.
 *
 * An OAuth redirect leaves the application entirely and comes back as a plain top-level
 * GET, so three things must be carried across it and none of them can be trusted to the
 * URL alone:
 *
 *   - `state` — proves the callback answers a request *this* browser started. Without it,
 *     an attacker can feed a victim a callback URL carrying the attacker's own `code` and
 *     silently sign the victim into the attacker's account (login CSRF).
 *   - `verifier` — the PKCE secret. The authorization request only publishes its SHA-256
 *     hash, so an intercepted `code` is useless to anyone who does not hold the verifier.
 *   - `next` — where the user was originally headed. Validated as a relative path here so
 *     the callback can never be turned into an open redirect.
 *
 * They are sealed into a single HMAC-signed cookie rather than a server-side row: the
 * payload is worthless ten minutes later, and a signed cookie needs no cleanup job and no
 * shared store between serverless instances. `SESSION_SECRET` signs it, so rotating that
 * secret invalidates in-flight logins exactly as it invalidates sessions.
 *
 * The functions here are deliberately pure string-in/string-out so they can be unit tested
 * without a request context; the cookie itself is set and read by the route handlers.
 */
import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { sessionSecret } from "@/lib/env";
import { constantTimeEquals } from "@/lib/security/tokens";

export const OAUTH_COOKIE = "relayn_oauth";

/** Long enough for a slow consent screen, short enough that a leaked cookie is stale. */
export const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;

export interface OAuthTransaction {
  /** Provider id, so a cookie minted for one provider cannot complete another's callback. */
  provider: string;
  state: string;
  verifier: string;
  nonce: string;
  /** Relative path to land on after a successful sign-in. */
  next: string;
  /**
   * Set only when the flow was started from the profile page to *attach* a provider to an
   * account that is already signed in. The callback then refuses to sign anyone in: it
   * verifies the live session still belongs to this id and links the identity to it. Sealed
   * rather than passed in the URL so the callback cannot be tricked into linking an identity
   * to an account of the attacker's choosing.
   */
  linkUserId: string | null;
  /** Epoch ms. Checked on open; the cookie's own Max-Age is only a hint. */
  issuedAt: number;
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

/**
 * Only same-site relative paths survive. Anything else — absolute URLs,
 * protocol-relative `//evil.example`, or a path with a control character — collapses to
 * the dashboard, which is what makes `?next=` safe to echo back into a redirect.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return "/dashboard";
  return /^\/(?!\/)[\w\-/?=&.]*$/.test(next) ? next : "/dashboard";
}

/** PKCE S256: the verifier stays in the cookie, only this hash goes on the wire. */
export function codeChallengeOf(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function newTransaction(
  provider: string,
  next: string | null | undefined,
  linkUserId: string | null = null,
): OAuthTransaction {
  return {
    provider,
    state: base64url(randomBytes(24)),
    verifier: base64url(randomBytes(32)),
    nonce: base64url(randomBytes(16)),
    next: safeNextPath(next),
    linkUserId,
    issuedAt: Date.now(),
  };
}

/** `<base64url(json)>.<hmac>` — tamper-evident, and readable by nobody but this server. */
export function sealTransaction(transaction: OAuthTransaction): string {
  const payload = base64url(Buffer.from(JSON.stringify(transaction), "utf8"));
  return `${payload}.${sign(payload)}`;
}

/**
 * Reverses `sealTransaction`, returning null for anything that is not a currently valid
 * transaction: a bad signature, a truncated cookie, an expired issue time, or a cookie
 * minted for a different provider. Callers treat null as "start again", never as "trust
 * the URL instead".
 */
export function openTransaction(sealed: string | undefined, provider: string): OAuthTransaction | null {
  if (!sealed) return null;
  const separator = sealed.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = sealed.slice(0, separator);
  const signature = sealed.slice(separator + 1);
  if (!constantTimeEquals(signature, sign(payload))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const transaction = parsed as Partial<OAuthTransaction>;
  if (
    typeof transaction.provider !== "string" ||
    typeof transaction.state !== "string" ||
    typeof transaction.verifier !== "string" ||
    typeof transaction.nonce !== "string" ||
    typeof transaction.next !== "string" ||
    typeof transaction.issuedAt !== "number"
  ) {
    return null;
  }
  // Absent is treated as "not a link flow"; anything other than a string is a malformed
  // payload rather than something to coerce.
  const linkUserId = transaction.linkUserId ?? null;
  if (linkUserId !== null && typeof linkUserId !== "string") return null;
  if (transaction.provider !== provider) return null;
  if (Date.now() - transaction.issuedAt > OAUTH_TRANSACTION_TTL_MS) return null;

  return {
    provider: transaction.provider,
    state: transaction.state,
    verifier: transaction.verifier,
    nonce: transaction.nonce,
    next: safeNextPath(transaction.next),
    linkUserId,
    issuedAt: transaction.issuedAt,
  };
}

/** Constant-time comparison of the callback's `state` against the sealed one. */
export function stateMatches(transaction: OAuthTransaction, presented: string | null): boolean {
  return typeof presented === "string" && constantTimeEquals(transaction.state, presented);
}
