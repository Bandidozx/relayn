/**
 * Issues the double-submit CSRF cookie on document navigations.
 *
 * `proxy.ts` is Next 16's replacement for `middleware.ts` — same request-interception
 * hook, renamed to discourage putting app logic here. This has to live at the network
 * boundary rather than in a layout: Next.js only permits cookie mutation from a Server
 * Action or a Route Handler, so `cookies().set()` inside `(auth)/layout.tsx` throws
 * "Cookies can only be modified in a Server Action or Route Handler" and 500s the page.
 * The proxy runs before the render and owns the response, so it is the one place a
 * document request can be handed a cookie.
 *
 * Randomness comes from Web Crypto rather than `node:crypto` so the file stays runnable
 * on either runtime. The value format (base64url, 32 chars) matches `randomToken(24)` in
 * `src/lib/security/tokens.ts`, so this issuer and `rotateCsrfToken()` are interchangeable.
 *
 * The token is only *created* here, never validated: `checkCsrf` compares the cookie
 * against the `x-csrf-token` header inside each Route Handler, where the body and session
 * are already in scope. This file is not an authorisation boundary — `(dashboard)/layout.tsx`
 * and `requireUser()` are.
 */
import { NextResponse, type NextRequest } from "next/server";

const CSRF_COOKIE = "relayn_csrf";
const TOKEN_BYTES = 24;
const MAX_AGE = 60 * 60 * 24 * 7;

/** base64url of `TOKEN_BYTES` random bytes, without pulling in node:crypto. */
function newToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function proxy(request: NextRequest) {
  const existing = request.cookies.get(CSRF_COOKIE)?.value;
  if (existing && existing.length >= 32) return NextResponse.next();

  const token = newToken();

  // Setting it on the *request* too makes it visible to `cookies()` during this same
  // render, so a server component reading the token does not see one render behind.
  request.cookies.set(CSRF_COOKIE, token);
  const response = NextResponse.next({ request });
  response.cookies.set(CSRF_COOKIE, token, {
    httpOnly: false, // the browser must read it to echo it back in the header
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
  return response;
}

export const config = {
  /*
   * Document requests only. `/v1` is the Bearer-authenticated gateway and must stay
   * cookie-free; `/api` is called by the browser only after a document has already been
   * served, so the cookie is guaranteed to exist by then.
   */
  matcher: ["/((?!api/|v1/|_next/|favicon.ico|robots.txt|sitemap.xml).*)"],
};
