/**
 * Turning a verified third-party identity into a Relayn session.
 *
 * Three cases, in this order:
 *
 *   1. **Known link** — an `oauth_accounts` row already points at a user. That row is keyed
 *      on the provider's subject id, so it keeps working even if the person renames their
 *      Google address.
 *   2. **Existing local account with the same email** — the identity is attached to it, so
 *      someone who registered with a password does not end up with a second, empty account
 *      the first time they use the Google button. Reached only for a provider-verified
 *      address (`identityFromClaims` refuses unverified ones), which is the proof of
 *      ownership that makes automatic linking safe enough to be the industry norm. It is
 *      audited as `auth.oauth_linked` so an operator can always see when it happened.
 *   3. **Nobody** — a new account is created with no password at all. It signs in through
 *      the provider until its owner sets one on the profile page.
 *
 * Session fixation is handled the same way as password login: `createSession` mints a new
 * session rather than adopting anything the browser presented.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { badRequest } from "@/lib/api/http";
import { createSession } from "@/lib/auth/session";
import { OAuthError, type OAuthIdentity } from "@/lib/auth/oauth/types";
import { ensureSubscription } from "@/lib/usage/accounting";
import type { User } from "@/lib/db-types";

function metaOf(request: Request): { ipAddress: string | null; userAgent: string | null } {
  const forwarded = request.headers.get("x-forwarded-for");
  return {
    ipAddress: forwarded?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent"),
  };
}

/** A suspended account must not be able to walk in through a side door. */
function assertUsable(user: User): void {
  if (user.status === "suspended") {
    throw new OAuthError("oauth_account_suspended", `account ${user.id} is suspended.`);
  }
}

export interface OAuthSignInResult {
  user: User;
  /** "created" | "linked" | "existing" — drives the wording on the redirect target. */
  outcome: "created" | "linked" | "existing";
}

export async function signInWithOAuthIdentity(
  identity: OAuthIdentity,
  request: Request,
): Promise<OAuthSignInResult> {
  const existingLink = await prisma.oAuthAccount.findUnique({
    where: {
      provider_providerUserId: {
        provider: identity.provider,
        providerUserId: identity.subject,
      },
    },
    include: { user: true },
  });

  let user: User | null = null;
  let outcome: OAuthSignInResult["outcome"] = "existing";

  if (existingLink && existingLink.user.status !== "deleted") {
    assertUsable(existingLink.user);
    user = existingLink.user;
    await prisma.oAuthAccount.update({
      where: { id: existingLink.id },
      data: { lastLoginAt: new Date(), email: identity.email },
    });
  } else {
    // A link pointing at a soft-deleted account is dropped rather than resurrected: the
    // tombstone keeps the old usage rows, and signing in again should start a fresh account.
    if (existingLink) {
      await prisma.oAuthAccount.delete({ where: { id: existingLink.id } });
    }

    const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });

    if (byEmail && byEmail.status !== "deleted") {
      assertUsable(byEmail);
      user = byEmail;
      outcome = "linked";
      await prisma.oAuthAccount.create({
        data: {
          userId: byEmail.id,
          provider: identity.provider,
          providerUserId: identity.subject,
          email: identity.email,
          displayName: identity.name ?? null,
          lastLoginAt: new Date(),
        },
      });
      // The provider vouched for the address, so an account that was created with a
      // password and never confirmed its email is confirmed now.
      if (!byEmail.emailVerifiedAt) {
        await prisma.user.update({
          where: { id: byEmail.id },
          data: { emailVerifiedAt: new Date() },
        });
      }
      await recordAudit({
        action: "auth.oauth_linked",
        userId: byEmail.id,
        actorEmail: byEmail.email,
        metadata: { provider: identity.provider },
        request,
      });
    } else {
      outcome = "created";
      user = await prisma.user.create({
        data: {
          name: identity.name?.trim() || identity.email.split("@")[0] || "New user",
          email: identity.email,
          // No password at all — not a random one. `null` is what makes "this account has
          // no password" a checkable fact instead of an unusable hash nobody can explain.
          passwordHash: null,
          ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
          // Same rule as password registration: never bootstrap an admin from a public
          // sign-up route. `npm run admin:promote -- <email>` is the only path.
          role: "user",
          status: "active",
          emailVerifiedAt: new Date(),
        },
      });
      await prisma.oAuthAccount.create({
        data: {
          userId: user.id,
          provider: identity.provider,
          providerUserId: identity.subject,
          email: identity.email,
          displayName: identity.name ?? null,
          lastLoginAt: new Date(),
        },
      });
      await recordAudit({
        action: "auth.oauth_registered",
        userId: user.id,
        actorEmail: user.email,
        metadata: { provider: identity.provider },
        request,
      });
    }
  }

  await ensureSubscription(user.id);
  await createSession(user.id, metaOf(request));
  const refreshed = await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await recordAudit({
    action: "auth.oauth_login",
    userId: user.id,
    actorEmail: user.email,
    metadata: { provider: identity.provider, outcome },
    request,
  });

  return { user: refreshed, outcome };
}

/**
 * Attaches an identity to an account that is *already* signed in ("Connect Google" on the
 * profile page). Deliberately not a sign-in: nothing here mints a session, so a link attempt
 * can never end with the browser signed in as somebody else.
 *
 * Unlike the sign-in path this does not require the provider's email to match the account's.
 * People routinely have a work login and a personal Google address, and the account is
 * identified by the live session, not by the address. What it does refuse is stealing a
 * subject that already belongs elsewhere, or stacking a second Google on one account —
 * both would break the assumption that `(provider, subject)` and `(userId, provider)` are
 * each unique.
 */
export async function linkOAuthIdentity(
  user: User,
  identity: OAuthIdentity,
  request: Request,
): Promise<void> {
  assertUsable(user);

  const existingLink = await prisma.oAuthAccount.findUnique({
    where: {
      provider_providerUserId: {
        provider: identity.provider,
        providerUserId: identity.subject,
      },
    },
  });
  if (existingLink) {
    // Already ours: re-consenting is a no-op, not an error.
    if (existingLink.userId === user.id) {
      await prisma.oAuthAccount.update({
        where: { id: existingLink.id },
        data: { email: identity.email, displayName: identity.name ?? null },
      });
      return;
    }
    throw new OAuthError(
      "oauth_already_linked",
      `${identity.provider} subject is linked to user ${existingLink.userId}, not ${user.id}.`,
    );
  }

  const alreadyHasProvider = await prisma.oAuthAccount.findFirst({
    where: { userId: user.id, provider: identity.provider },
  });
  if (alreadyHasProvider) {
    throw new OAuthError(
      "oauth_already_linked",
      `user ${user.id} already has a ${identity.provider} link; disconnect it first.`,
    );
  }

  await prisma.oAuthAccount.create({
    data: {
      userId: user.id,
      provider: identity.provider,
      providerUserId: identity.subject,
      email: identity.email,
      displayName: identity.name ?? null,
      lastLoginAt: null,
    },
  });

  // Only when the provider vouched for *this account's* address — a link from a different
  // Google address says nothing about whether the account's own email is real.
  if (!user.emailVerifiedAt && identity.email === user.email.toLowerCase()) {
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
  }

  await recordAudit({
    action: "auth.oauth_linked",
    userId: user.id,
    actorEmail: user.email,
    metadata: { provider: identity.provider, source: "profile" },
    request,
  });
}

/**
 * Removes a linked identity. Refuses to strand the account: an owner with no password and
 * no other provider would have nothing left to sign in with, and this endpoint would
 * otherwise be a one-click way to lock yourself out permanently.
 *
 * A missing link is a no-op rather than a 404, so the button is idempotent and the response
 * does not confirm which providers some other account has linked.
 */
export async function unlinkOAuthAccount(
  user: User,
  provider: string,
  request: Request,
): Promise<void> {
  const links = await prisma.oAuthAccount.findMany({ where: { userId: user.id } });
  const target = links.find((link) => link.provider === provider);
  if (!target) return;

  if (!user.passwordHash && links.length === 1) {
    throw badRequest(
      "Set a password first — this is the only way you can sign in right now.",
      { provider: "Cannot remove your only sign-in method." },
    );
  }

  await prisma.oAuthAccount.delete({ where: { id: target.id } });
  await recordAudit({
    action: "auth.oauth_unlinked",
    userId: user.id,
    actorEmail: user.email,
    metadata: { provider },
    request,
  });
}
