/**
 * Append-only audit trail. Records security-relevant events (auth, credential
 * lifecycle, plan changes, administrative actions) with the actor and source IP.
 *
 * Never pass secrets in `metadata`: it is surfaced verbatim in the admin UI.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { clientIp } from "@/lib/api/http";

export type AuditAction =
  | "auth.register"
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.password_changed"
  | "auth.password_reset_requested"
  | "auth.password_reset_completed"
  | "auth.email_verified"
  | "auth.oauth_registered"
  | "auth.oauth_linked"
  | "auth.oauth_login"
  | "auth.oauth_unlinked"
  | "account.updated"
  | "account.deleted"
  | "api_key.created"
  | "api_key.revoked"
  | "integration.created"
  | "integration.deleted"
  | "subscription.plan_changed"
  // Payment lifecycle. `payment.rejected` is the one that matters for review: it records a
  // signature-valid callback whose contents contradicted our own order row.
  | "payment.created"
  | "payment.verified"
  | "payment.rejected"
  | "payment.activated"
  | "payment.failed"
  | "support.ticket_created"
  | "support.ticket_updated"
  | "admin.user_suspended"
  | "admin.user_restored"
  | "admin.user_role_changed"
  | "admin.model_updated"
  | "admin.model_created"
  | "admin.model_deleted"
  | "admin.model_restored"
  | "admin.model_tested"
  | "admin.models_synced"
  | "admin.provider_created"
  | "admin.provider_updated"
  | "admin.provider_credential_rotated"
  | "admin.provider_deleted"
  | "admin.provider_tested"
  | "admin.provider_proxies_updated"
  | "admin.subscription_updated"
  | "admin.ticket_updated"
  | "gateway.key_rejected"
  | "gateway.quota_exceeded";

export interface AuditInput {
  action: AuditAction;
  userId?: string | null;
  actorEmail?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  request?: Request;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        userId: input.userId ?? null,
        actorEmail: input.actorEmail ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        ipAddress: input.request ? clientIp(input.request) : null,
        userAgent: input.request?.headers.get("user-agent")?.slice(0, 300) ?? null,
      },
    });
  } catch (error) {
    // Auditing must never break the user-facing operation.
    console.error("[relayn] audit write failed:", error);
  }
}
