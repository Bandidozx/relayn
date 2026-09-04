/**
 * GET /api/auth/oauth/google/callback — finishes the Google flow, in either of its two modes.
 *
 * Sign-in: validate `state`, exchange the code, then mint a session for the identity.
 * Linking (`?link=1` on the start leg): validate the same way, but attach the identity to
 * the account named in the sealed cookie — and only if the live session still belongs to
 * that account. Nothing signs anyone in on that path, so a link attempt cannot end with the
 * browser logged in as a different user.
 *
 * Every failure path ends the same way: the transaction cookie is burned and the browser
 * lands on `/login?error=<code>` (or `/profile?error=<code>` while linking) with a short,
 * non-revealing code. The detail — Google's own error body, a mismatched audience, a redirect
 * URI the console does not know about — goes to the server log, where the operator can act on
 * it; an OAuth misconfiguration message in the browser tells an attacker more than it tells
 * the user.
 *
 * The cookie is deleted before anything is validated, which makes the transaction
 * single-use: a replayed callback URL finds no cookie and cannot be completed twice.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { getSession } from "@/lib/auth/session";
import { googleOAuthProvider, oauthRedirectUri } from "@/lib/auth/oauth/google";
import { OAUTH_COOKIE, openTransaction, stateMatches } from "@/lib/auth/oauth/transaction";
import { OAuthError } from "@/lib/auth/oauth/types";
import { linkOAuthIdentity, signInWithOAuthIdentity } from "@/server/services/oauth-service";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const jar = await cookies();
  const sealed = jar.get(OAUTH_COOKIE)?.value;
  jar.delete(OAUTH_COOKIE);

  // Where a failure lands. Starts at /login and moves to /profile as soon as the cookie
  // reveals this was a link attempt by someone already signed in.
  let errorPage = "/login";

  function failure(code: OAuthError["code"], detail: string): Response {
    console.warn(`[relayn:oauth] google callback failed (${code}): ${detail}`);
    return NextResponse.redirect(new URL(`${errorPage}?error=${code}`, env.appUrl));
  }

  try {
    if (!googleOAuthProvider.isConfigured()) {
      throw new OAuthError("oauth_unavailable", "callback reached with no client credentials.");
    }

    // The user pressed "Cancel" on the consent screen, or Google refused the request.
    const denied = url.searchParams.get("error");
    if (denied) {
      throw new OAuthError("oauth_denied", `Google returned error=${denied}`);
    }

    const transaction = openTransaction(sealed, "google");
    if (!transaction) {
      throw new OAuthError(
        "oauth_state_invalid",
        "no valid transaction cookie — expired, replayed, or never started here.",
      );
    }
    if (transaction.linkUserId) errorPage = "/profile";

    if (!stateMatches(transaction, url.searchParams.get("state"))) {
      throw new OAuthError("oauth_state_invalid", "state parameter did not match the cookie.");
    }

    const code = url.searchParams.get("code");
    if (!code) {
      throw new OAuthError("oauth_exchange_failed", "callback carried no authorization code.");
    }

    const identity = await googleOAuthProvider.exchange({
      code,
      transaction,
      redirectUri: oauthRedirectUri("google"),
    });

    if (transaction.linkUserId) {
      // The session is re-read here rather than trusted from the cookie alone: signing out
      // (or signing in as somebody else) in another tab mid-consent must not let the link
      // land on whichever account happens to be current.
      const session = await getSession();
      if (!session || session.user.id !== transaction.linkUserId) {
        throw new OAuthError(
          "oauth_state_invalid",
          "link callback arrived without the session that started it.",
        );
      }
      await linkOAuthIdentity(session.user, identity, request);
      return NextResponse.redirect(new URL("/profile?linked=google", env.appUrl));
    }

    await signInWithOAuthIdentity(identity, request);

    // `transaction.next` was normalised to a relative path when the transaction was sealed,
    // so this cannot be steered off-site.
    return NextResponse.redirect(new URL(transaction.next, env.appUrl));
  } catch (error) {
    if (error instanceof OAuthError) return failure(error.code, error.message);
    console.error("[relayn:oauth] unhandled google callback error:", error);
    return NextResponse.redirect(
      new URL(`${errorPage}?error=oauth_exchange_failed`, env.appUrl),
    );
  }
}
