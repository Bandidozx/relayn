/**
 * Cookie-backed server-side sessions.
 *
 * - The cookie holds a 256-bit random token; the database stores only
 *   HMAC-SHA256(SESSION_SECRET, token), so neither a database dump nor a log leak
 *   yields a usable session, and rotating SESSION_SECRET invalidates every session.
 * - Session fixation is prevented by minting a brand-new session on every successful
 *   login (and on password change) instead of reusing whatever the client presented.
 */
import "server-only";
import { createHmac } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { env, isProduction, sessionSecret } from "@/lib/env";
import { randomToken } from "@/lib/security/tokens";
import type { User } from "@/lib/db-types";

export const SESSION_COOKIE = "relayn_session";

function fingerprint(token: string): string {
  return createHmac("sha256", sessionSecret()).update(token).digest("hex");
}

function ttlMs(): number {
  return Math.max(1, env.sessionTtlDays) * 24 * 60 * 60 * 1000;
}

export interface SessionContext {
  user: User;
  sessionId: string;
}

/** Mints a new session row + sets the cookie. Always call after authenticating. */
export async function createSession(
  userId: string,
  meta: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<string> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlMs());

  await prisma.session.create({
    data: {
      userId,
      tokenHash: fingerprint(token),
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      expiresAt,
    },
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    expires: expiresAt,
  });

  return token;
}

/** Resolves the caller from the session cookie. Returns null when unauthenticated. */
async function loadSession(): Promise<SessionContext | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: fingerprint(token) },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;
  if (session.user.status !== "active") return null;

  // Throttled last-seen touch; avoids a write on every single request.
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    await prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  return { user: session.user, sessionId: session.id };
}

/**
 * Request-scoped session read.
 *
 * A dashboard render resolves the caller more than once — the layout authorises, then the
 * page (via `requireUser()`) authorises again — and each call was its own database round
 * trip. `cache()` makes those calls share one result for the lifetime of a single request,
 * so the query and the throttled `lastSeenAt` write happen once instead of N times.
 *
 * The authorisation boundary is unchanged: memoisation is per request, never across
 * requests or users, so every request still resolves its own cookie from the database.
 * Outside a request scope React does not memoise at all, which degrades to today's
 * behaviour rather than to a shared result.
 */
export const getSession = cache(loadSession);

export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session
      .updateMany({ where: { tokenHash: fingerprint(token) }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }
  jar.delete(SESSION_COOKIE);
}

/** Used on password change / account compromise: kills every other device. */
export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
  await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
}

export async function purgeExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
