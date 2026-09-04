/**
 * Shared shape for dashboard identity providers.
 *
 * Sign-in providers are kept behind an interface for the same reason model providers are:
 * Google is the one wired today, and adding GitHub or a corporate IdP should not mean
 * editing the login route, the session code or the account-linking rules. Everything
 * provider-specific — endpoints, scopes, claim names — lives inside an implementation.
 */
import "server-only";
import type { OAuthTransaction } from "@/lib/auth/oauth/transaction";

/** The provider-agnostic facts a sign-in needs. Nothing else is persisted. */
export interface OAuthIdentity {
  /** Provider id, e.g. "google". */
  provider: string;
  /** The provider's immutable subject id. Accounts are keyed on this, never on email. */
  subject: string;
  email: string;
  /**
   * Whether the *provider* vouches for the address. An unverified address must never be
   * allowed to attach itself to an existing account: anyone can put someone else's email
   * on an account they control at a sloppy IdP, and linking on that basis is an account
   * takeover.
   */
  emailVerified: boolean;
  name?: string | undefined;
  avatarUrl?: string | undefined;
}

/**
 * A failure that is safe to surface to the browser as a short code in the URL.
 *
 * The `code` lands in `/login?error=…` and is mapped to human wording by the login page;
 * `detail` is for the server log only. Upstream error bodies are never echoed to the user.
 */
export class OAuthError extends Error {
  constructor(
    readonly code:
      | "oauth_unavailable"
      | "oauth_state_invalid"
      | "oauth_denied"
      | "oauth_exchange_failed"
      | "oauth_email_unverified"
      | "oauth_account_suspended"
      | "oauth_already_linked",
    detail: string,
  ) {
    super(detail);
    this.name = "OAuthError";
  }
}

/**
 * Browser-facing wording for each code. A lookup table, not string interpolation: the value
 * in `?error=` comes from the URL bar, so an unknown code renders nothing at all rather than
 * reflecting attacker-supplied text onto the login page.
 *
 * The wording stays vague about *why* the provider refused. "Google could not complete the
 * sign-in" is all a legitimate user can act on; the operator gets the real reason in the log.
 */
export const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_unavailable: "Google sign-in is not available on this deployment. Use your email and password.",
  oauth_state_invalid: "That sign-in link has expired. Please try again.",
  oauth_denied: "Google sign-in was cancelled.",
  oauth_exchange_failed: "Google could not complete the sign-in. Please try again.",
  oauth_email_unverified:
    "Google has not verified that email address. Verify it with Google first, or sign in with a password.",
  oauth_account_suspended: "This account is suspended. Contact support.",
  oauth_already_linked:
    "That Google account is already connected to a different Relayn account. Disconnect it there first.",
};

export interface OAuthProvider {
  readonly id: string;
  readonly label: string;
  /** Env vars an operator must set, named in the "not configured" message. */
  readonly credentialEnvVars: readonly string[];
  isConfigured(): boolean;
  /** Where to send the browser to obtain consent. */
  authorizationUrl(transaction: OAuthTransaction, redirectUri: string): string;
  /** Exchanges the one-time code for a verified identity. Throws `OAuthError` otherwise. */
  exchange(
    input: { code: string; transaction: OAuthTransaction; redirectUri: string },
  ): Promise<OAuthIdentity>;
}
