/**
 * GET /api/auth/oauth/google — starts the Google sign-in flow.
 *
 * A plain link, not a form POST, because the browser has to be *navigated* to Google. That
 * also means no CSRF token can travel with it, which is exactly what the `state` value in
 * the sealed transaction cookie replaces: the callback proves it answers a request this
 * browser made here. Nothing is written to the database on this leg.
 *
 * `?link=1` switches the flow from "sign in" to "attach this provider to the account I am
 * already signed in as". The account id is read from the session and sealed into the cookie,
 * never taken from the query string.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { env, isProduction } from "@/lib/env";
import { getSession } from "@/lib/auth/session";
import { googleOAuthProvider, oauthRedirectUri } from "@/lib/auth/oauth/google";
import {
  OAUTH_COOKIE,
  OAUTH_TRANSACTION_TTL_MS,
  newTransaction,
  safeNextPath,
  sealTransaction,
} from "@/lib/auth/oauth/transaction";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Not configured is an operator state, not a user error: the button is hidden when the
  // credentials are missing, so reaching this is either a stale tab or a hand-typed URL.
  if (!googleOAuthProvider.isConfigured()) {
    console.warn(
      `[relayn:oauth] Google sign-in is not configured. Set ${googleOAuthProvider.credentialEnvVars.join(" and ")}.`,
    );
    return NextResponse.redirect(new URL("/login?error=oauth_unavailable", env.appUrl));
  }

  const linking = url.searchParams.get("link") === "1";
  let linkUserId: string | null = null;
  if (linking) {
    const session = await getSession();
    // Linking without a session would have nothing to link to; send them to sign in first.
    if (!session) {
      return NextResponse.redirect(new URL("/login?next=%2Fprofile", env.appUrl));
    }
    linkUserId = session.user.id;
  }

  const transaction = newTransaction(
    "google",
    linking ? safeNextPath("/profile") : url.searchParams.get("next"),
    linkUserId,
  );

  const jar = await cookies();
  jar.set(OAUTH_COOKIE, sealTransaction(transaction), {
    httpOnly: true,
    // `lax` is required, not a preference: Google's callback is a cross-site top-level
    // navigation, and a `strict` cookie would not be sent with it.
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: OAUTH_TRANSACTION_TTL_MS / 1000,
  });

  return NextResponse.redirect(
    googleOAuthProvider.authorizationUrl(transaction, oauthRedirectUri("google")),
  );
}
