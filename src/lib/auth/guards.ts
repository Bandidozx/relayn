/**
 * Authorisation guards.
 *
 * Every dashboard route resolves the caller through these helpers, and every
 * repository query is scoped by the resulting `user.id`. Ownership is therefore
 * enforced in the data layer rather than trusted from a client-supplied id — which is
 * what makes the IDOR tests pass.
 */
import "server-only";
import { getSession } from "@/lib/auth/session";
import { forbidden, notFound, unauthorized } from "@/lib/api/http";
import type { User } from "@/lib/db-types";

export interface AuthContext {
  user: User;
  sessionId: string;
}

export async function requireUser(): Promise<AuthContext> {
  const session = await getSession();
  if (!session) throw unauthorized();
  if (session.user.status === "suspended") {
    throw forbidden("This account is suspended. Contact support to restore access.");
  }
  return session;
}

export async function requireAdmin(): Promise<AuthContext> {
  const context = await requireUser();
  if (context.user.role !== "admin") throw forbidden("Administrator access required.");
  return context;
}

/** Guards a resource that was fetched without a userId filter. */
export function assertOwnership(resource: { userId: string } | null, userId: string): void {
  if (!resource || resource.userId !== userId) {
    // Deliberately 404, not 403: never confirm that another tenant's id exists.
    throw notFound();
  }
}
