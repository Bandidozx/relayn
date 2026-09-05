/**
 * Profile reads and edits. Password changes, deletion and verification live in
 * `auth-service.ts` because they touch credentials and sessions.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { effectivePlan, planOf } from "@/lib/plans";
import { getRequestSubscription } from "@/lib/usage/accounting";

export interface ProfileConnection {
  provider: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ProfileView {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
  status: string;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  plan: string;
  planName: string;
  activeSessions: number;
  activeKeys: number;
  totalRequests: number;
  /**
   * Whether a password is set at all. False for accounts that only ever signed in through an
   * identity provider — the UI offers "set a password" instead of "change password", and the
   * delete confirmation cannot ask for a password that does not exist. Never the hash itself.
   */
  hasPassword: boolean;
  /** Linked identity providers, so the owner can see and remove them. */
  connections: ProfileConnection[];
}

export async function getProfile(userId: string): Promise<ProfileView | null> {
  const [user, subscription, sessions, keys, requests, links] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    getRequestSubscription(userId),
    prisma.session.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.apiKey.count({ where: { userId, status: "active" } }),
    prisma.usageLog.count({ where: { userId } }),
    prisma.oAuthAccount.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  ]);
  if (!user) return null;

  // The effective plan, matching the sidebar and the subscription page. This panel sits next to a
  // role badge, so showing "Free" beside "Admin" while the account is uncapped would be the one
  // place in the app that contradicts the others.
  const plan = effectivePlan(subscription.plan, user.role);

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: user.role,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    plan,
    planName: planOf(plan).name,
    activeSessions: sessions,
    activeKeys: keys,
    totalRequests: requests,
    hasPassword: user.passwordHash !== null,
    connections: links.map((link) => ({
      provider: link.provider,
      email: link.email,
      displayName: link.displayName,
      createdAt: link.createdAt.toISOString(),
      lastLoginAt: link.lastLoginAt?.toISOString() ?? null,
    })),
  };
}

export interface UpdateProfileInput {
  name?: string | undefined;
  avatarUrl?: string | undefined;
}

export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
  request: Request,
  actorEmail: string,
): Promise<ProfileView | null> {
  const data: { name?: string; avatarUrl?: string | null } = {};
  if (input.name !== undefined) data.name = input.name;
  // An empty string is a deliberate "remove my avatar", stored as NULL.
  if (input.avatarUrl !== undefined) data.avatarUrl = input.avatarUrl === "" ? null : input.avatarUrl;

  if (Object.keys(data).length > 0) {
    await prisma.user.update({ where: { id: userId }, data });
    await recordAudit({
      action: "account.updated",
      userId,
      actorEmail,
      targetType: "user",
      targetId: userId,
      metadata: { fields: Object.keys(data) },
      request,
    });
  }

  return getProfile(userId);
}
