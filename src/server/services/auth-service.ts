/**
 * Account lifecycle: registration, login, password change/reset, account deletion.
 *
 * Route handlers stay thin; the security-relevant decisions live here so they are applied
 * identically no matter which entry point calls them.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { badRequest, conflict, unauthorized, ApiError } from "@/lib/api/http";
import { hashPassword, passwordPolicyError, verifyPassword } from "@/lib/security/password";
import { randomToken, sha256 } from "@/lib/security/tokens";
import { createSession, revokeAllSessions } from "@/lib/auth/session";
import { ensureSubscription } from "@/lib/usage/accounting";
import { env, isProduction } from "@/lib/env";
import type { User } from "@/lib/db-types";

const RESET_TTL_MINUTES = 60;
const VERIFY_TTL_HOURS = 48;

/**
 * True only when a real outbound transport is configured. `none` and `log` are both
 * non-delivering: `log` writes the link to the server log for local development. No SMTP
 * client is bundled — wiring one is a single call inside `sendVerificationEmail`, and the
 * env var is documented in .env.example.
 */
function deliversEmail(): boolean {
  return env.emailTransport !== "none" && env.emailTransport !== "log";
}

function metaOf(request: Request): { ipAddress: string | null; userAgent: string | null } {
  const forwarded = request.headers.get("x-forwarded-for");
  return {
    ipAddress: forwarded?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent"),
  };
}

/**
 * Creates the account, its Free subscription and a fresh session.
 *
 * Email uniqueness is enforced by the database; the duplicate branch returns the same
 * 409 for every caller, and registration never reveals whether a *deleted* account once
 * used the address.
 */
export async function registerUser(
  input: { name: string; email: string; password: string },
  request: Request,
): Promise<User> {
  const policyError = passwordPolicyError(input.password);
  if (policyError) throw badRequest(policyError, { password: policyError });

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw conflict("An account with that email already exists.");

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash,
      // Always a plain user — there is deliberately no "first account owns the deployment"
      // bootstrap. On a freshly migrated production database that rule would hand the admin
      // panel to whoever reached /register first, which on a public URL is a race with the
      // internet. The only path to `role: "admin"` is an operator with database access
      // running `npm run admin:promote -- <email>`, or an existing admin promoting from the
      // admin panel; both are audited.
      role: "user",
      status: "active",
    },
  });

  await ensureSubscription(user.id);

  // Email verification is architected but not delivered: with no transport configured the
  // address is marked verified so the account is usable, and a token is only minted when
  // an operator has wired a real transport (EMAIL_TRANSPORT in .env.example).
  if (deliversEmail()) {
    const token = await createVerificationToken(user.id, "email_verify", VERIFY_TTL_HOURS * 60);
    console.info(`[relayn:auth] verification link: ${env.appUrl}/verify-email?token=${token}`);
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
  }

  const meta = metaOf(request);
  await createSession(user.id, meta);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  await recordAudit({
    action: "auth.register",
    userId: user.id,
    actorEmail: user.email,
    metadata: { role: user.role },
    request,
  });

  return user;
}

/**
 * Verifies credentials and mints a *new* session (never reusing a presented one), which
 * is what makes session fixation impossible.
 */
export async function loginUser(
  input: { email: string; password: string },
  request: Request,
): Promise<User> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Same error and comparable timing whether the address exists or not, so the response
  // cannot be used to enumerate accounts.
  const stored = user?.passwordHash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA";
  const valid = await verifyPassword(input.password, stored);

  if (!user || !valid) {
    await recordAudit({
      action: "auth.login_failed",
      metadata: { email: input.email },
      request,
    });
    throw unauthorized("Incorrect email or password.");
  }

  if (user.status === "suspended") {
    throw new ApiError(
      403,
      "account_suspended",
      "This account is suspended. Contact support.",
    );
  }
  if (user.status !== "active") {
    throw unauthorized("Incorrect email or password.");
  }

  await ensureSubscription(user.id);
  await createSession(user.id, metaOf(request));
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  await recordAudit({
    action: "auth.login",
    userId: user.id,
    actorEmail: user.email,
    request,
  });

  return user;
}

/**
 * Rotates the password — or sets the first one.
 *
 * An account created through an identity provider has `passwordHash === null`, and there is
 * no current password to prove. Requiring one would leave such an owner permanently unable
 * to add a second sign-in method; accepting a blank one on a *password* account would be an
 * authentication bypass. The branch is therefore on the stored hash, never on what the
 * client submitted: `currentPassword` is optional in the schema and mandatory here whenever
 * a hash exists.
 */
export async function changePassword(
  user: User,
  input: { currentPassword?: string | undefined; newPassword: string; signOutEverywhere?: boolean },
  context: { sessionId: string; request: Request },
): Promise<void> {
  const settingFirstPassword = user.passwordHash === null;

  if (!settingFirstPassword) {
    const valid = await verifyPassword(input.currentPassword ?? "", user.passwordHash);
    if (!valid) {
      throw badRequest("Your current password is incorrect.", {
        currentPassword: "Incorrect password.",
      });
    }
  }

  const policyError = passwordPolicyError(input.newPassword);
  if (policyError) throw badRequest(policyError, { newPassword: policyError });

  if (!settingFirstPassword && (await verifyPassword(input.newPassword, user.passwordHash))) {
    throw badRequest("Choose a password you have not used here before.", {
      newPassword: "Must differ from the current password.",
    });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });

  // Other devices lose access by default; the current session is kept so the user is not
  // logged out of the tab they just used.
  if (input.signOutEverywhere !== false) {
    await revokeAllSessions(user.id, context.sessionId);
  }

  await recordAudit({
    action: "auth.password_changed",
    userId: user.id,
    actorEmail: user.email,
    metadata: {
      signedOutOtherSessions: input.signOutEverywhere !== false,
      firstPassword: settingFirstPassword,
    },
    request: context.request,
  });
}

/** Creates a single-use token and returns the plaintext. Only the hash is stored. */
export async function createVerificationToken(
  userId: string,
  type: "email_verify" | "password_reset",
  ttlMinutes: number,
): Promise<string> {
  const token = randomToken(32);
  await prisma.verificationToken.create({
    data: {
      userId,
      type,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    },
  });
  return token;
}

export interface ResetRequestOutcome {
  /**
   * Present only when no email transport is configured, so a self-hosted operator can
   * still complete the flow. Never returned to the browser in production.
   */
  devToken?: string;
}

/**
 * Always resolves successfully, whether or not the address exists — the response must not
 * disclose which emails are registered.
 */
export async function requestPasswordReset(
  email: string,
  request: Request,
): Promise<ResetRequestOutcome> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== "active") return {};

  // Older outstanding reset tokens are burned so only the newest link works.
  await prisma.verificationToken.updateMany({
    where: { userId: user.id, type: "password_reset", usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = await createVerificationToken(user.id, "password_reset", RESET_TTL_MINUTES);

  await recordAudit({
    action: "auth.password_reset_requested",
    userId: user.id,
    actorEmail: user.email,
    request,
  });

  if (!deliversEmail()) {
    // No transport configured: log the link server-side for the operator instead of
    // pretending an email was sent.
    console.warn(
      `[relayn:auth] password reset link (EMAIL_TRANSPORT=${env.emailTransport}): ${env.appUrl}/reset-password?token=${token}`,
    );
    return isProduction ? {} : { devToken: token };
  }

  // A real transport would send the link here. Documented in .env.example.
  return {};
}

export async function resetPassword(
  input: { token: string; password: string },
  request: Request,
): Promise<void> {
  const policyError = passwordPolicyError(input.password);
  if (policyError) throw badRequest(policyError, { password: policyError });

  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash: sha256(input.token) },
    include: { user: true },
  });

  if (
    !record ||
    record.type !== "password_reset" ||
    record.usedAt ||
    record.expiresAt.getTime() < Date.now()
  ) {
    throw badRequest("This reset link is invalid or has expired. Request a new one.");
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await hashPassword(input.password) },
    }),
    prisma.verificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  // A reset implies the account may have been compromised: drop every session.
  await revokeAllSessions(record.userId);

  await recordAudit({
    action: "auth.password_reset_completed",
    userId: record.userId,
    actorEmail: record.user.email,
    request,
  });
}

export async function verifyEmailToken(token: string, request: Request): Promise<void> {
  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash: sha256(token) },
  });
  if (
    !record ||
    record.type !== "email_verify" ||
    record.usedAt ||
    record.expiresAt.getTime() < Date.now()
  ) {
    throw badRequest("This verification link is invalid or has expired.");
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
    prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);

  await recordAudit({ action: "auth.email_verified", userId: record.userId, request });
}

/**
 * Soft-deletes the account: the row is retained (usage logs reference it and billing
 * records must survive) but the email is released, credentials are destroyed, keys are
 * revoked and every session is dropped.
 *
 * Confirmation depends on what the account actually has. A password account proves intent
 * by re-entering it. A provider-only account has nothing to re-enter, so it types its own
 * email address instead — weaker than a password, but this endpoint already requires a live
 * session and a CSRF token, and the alternative is an account nobody can ever close.
 * Linked identities are deleted outright: leaving one behind would let the next sign-in
 * resurrect a tombstoned row.
 */
export async function deleteAccount(
  user: User,
  input: { password?: string | undefined; confirmEmail?: string | undefined },
  request: Request,
): Promise<void> {
  if (user.passwordHash !== null) {
    if (!(await verifyPassword(input.password ?? "", user.passwordHash))) {
      throw badRequest("Your password is incorrect.", { password: "Incorrect password." });
    }
  } else if (input.confirmEmail?.trim().toLowerCase() !== user.email.toLowerCase()) {
    throw badRequest("Type your email address exactly to confirm.", {
      confirmEmail: "That does not match your account email.",
    });
  }

  const tombstone = `deleted+${user.id}@relayn.invalid`;

  await prisma.$transaction([
    prisma.apiKey.updateMany({
      where: { userId: user.id, status: "active" },
      data: { status: "revoked", revokedAt: new Date() },
    }),
    prisma.oAuthAccount.deleteMany({ where: { userId: user.id } }),
    prisma.user.update({
      where: { id: user.id },
      data: {
        status: "deleted",
        email: tombstone,
        name: "Deleted account",
        passwordHash: await hashPassword(randomToken(32)),
        avatarUrl: null,
      },
    }),
  ]);

  await revokeAllSessions(user.id);

  await recordAudit({
    action: "account.deleted",
    userId: user.id,
    actorEmail: user.email,
    request,
  });
}
