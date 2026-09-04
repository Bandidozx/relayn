/**
 * CSRF defence for cookie-authenticated dashboard endpoints.
 *
 * Two independent checks must both pass on every state-changing request:
 *   1. Origin/Referer must match the request host (blocks cross-site form posts).
 *   2. Double-submit token: the `relayn_csrf` cookie must equal the `x-csrf-token`
 *      header. A cross-origin attacker can send the cookie but cannot read it, so it
 *      cannot populate the header.
 *
 * The Bearer-authenticated gateway under /v1 never accepts cookie auth, so it is not
 * reachable by CSRF and is intentionally exempt.
 */
import "server-only";
import { cookies } from "next/headers";
import { constantTimeEquals, randomToken } from "@/lib/security/tokens";
import { isProduction } from "@/lib/env";

export const CSRF_COOKIE = "relayn_csrf";
export const CSRF_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const COOKIE_OPTIONS = {
  httpOnly: false, // must be readable by the client to echo it back in the header
  sameSite: "lax",
  secure: isProduction,
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
} as const;

/**
 * Mints a fresh token. **Route Handlers only** — this writes a cookie, and Next.js
 * forbids cookie writes during a layout/page render (a `set()` there throws "Cookies can
 * only be modified in a Server Action or Route Handler" and 500s the page). Ordinary
 * issuance for document requests happens in `src/proxy.ts` instead.
 *
 * Called on login and register so the token changes at every authentication boundary:
 * a value an attacker managed to plant before sign-in is not still valid after it, which
 * is the CSRF analogue of the session-fixation defence in `createSession`.
 */
export async function rotateCsrfToken(): Promise<string> {
  const jar = await cookies();
  const token = randomToken(24);
  jar.set(CSRF_COOKIE, token, COOKIE_OPTIONS);
  return token;
}

export async function clearCsrfToken(): Promise<void> {
  const jar = await cookies();
  jar.delete(CSRF_COOKIE);
}

export interface CsrfFailure {
  code: "csrf_origin_mismatch" | "csrf_token_missing" | "csrf_token_mismatch";
  message: string;
}

/** Returns null when the request is safe, or a failure describing what was wrong. */
export async function checkCsrf(request: Request): Promise<CsrfFailure | null> {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const host = request.headers.get("host");
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!origin || !host) {
    return { code: "csrf_origin_mismatch", message: "Missing Origin header on a write request." };
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { code: "csrf_origin_mismatch", message: "Malformed Origin header." };
  }
  if (originHost !== host) {
    return { code: "csrf_origin_mismatch", message: "Cross-site request rejected." };
  }

  const jar = await cookies();
  const cookieToken = jar.get(CSRF_COOKIE)?.value ?? "";
  const headerToken = request.headers.get(CSRF_HEADER) ?? "";
  if (!cookieToken || !headerToken) {
    return { code: "csrf_token_missing", message: "Missing CSRF token." };
  }
  if (!constantTimeEquals(cookieToken, headerToken)) {
    return { code: "csrf_token_mismatch", message: "Invalid CSRF token." };
  }
  return null;
}
