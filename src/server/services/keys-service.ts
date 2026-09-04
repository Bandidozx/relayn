/**
 * API key lifecycle.
 *
 * The plaintext secret exists only inside `createApiKey`'s return value — the database
 * stores SHA-256(secret) plus a display prefix and last four characters. There is no
 * code path anywhere in the app that can re-read a key after creation.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { badRequest, conflict, notFound } from "@/lib/api/http";
import { generateApiKey } from "@/lib/security/tokens";
import { planOf } from "@/lib/plans";
import { ensureSubscription } from "@/lib/usage/accounting";

export interface ApiKeyView {
  id: string;
  name: string;
  masked: string;
  keyPrefix: string;
  last4: string;
  status: string;
  requestCount: number;
  totalTokens: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function mask(prefix: string, last4: string): string {
  return `${prefix}_${"•".repeat(8)}${last4}`;
}

/** Every query is scoped by userId, so an id from another tenant simply returns nothing. */
export async function listApiKeys(userId: string): Promise<ApiKeyView[]> {
  const rows = await prisma.apiKey.findMany({
    where: { userId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    masked: mask(row.keyPrefix, row.last4),
    keyPrefix: row.keyPrefix,
    last4: row.last4,
    status: row.status,
    requestCount: row.requestCount,
    totalTokens: row.totalTokens,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));
}

export interface CreatedApiKey {
  key: ApiKeyView;
  /** Shown to the user exactly once. */
  secret: string;
}

export async function createApiKey(
  userId: string,
  name: string,
  request: Request,
  actorEmail: string,
): Promise<CreatedApiKey> {
  const subscription = await ensureSubscription(userId);
  const limit = planOf(subscription.plan).maxApiKeys;

  if (limit !== null) {
    const active = await prisma.apiKey.count({ where: { userId, status: "active" } });
    if (active >= limit) {
      throw conflict(
        `The ${planOf(subscription.plan).name} plan allows ${limit} active ${limit === 1 ? "key" : "keys"}. Revoke one or upgrade your plan.`,
      );
    }
  }

  const generated = generateApiKey();
  const row = await prisma.apiKey.create({
    data: {
      userId,
      name,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      last4: generated.last4,
    },
  });

  await recordAudit({
    action: "api_key.created",
    userId,
    actorEmail,
    targetType: "api_key",
    targetId: row.id,
    metadata: { name, last4: generated.last4 },
    request,
  });

  return {
    secret: generated.secret,
    key: {
      id: row.id,
      name: row.name,
      masked: mask(row.keyPrefix, row.last4),
      keyPrefix: row.keyPrefix,
      last4: row.last4,
      status: row.status,
      requestCount: 0,
      totalTokens: 0,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    },
  };
}

export async function renameApiKey(userId: string, keyId: string, name: string): Promise<void> {
  const result = await prisma.apiKey.updateMany({ where: { id: keyId, userId }, data: { name } });
  if (result.count === 0) throw notFound("API key not found.");
}

export async function revokeApiKey(
  userId: string,
  keyId: string,
  request: Request,
  actorEmail: string,
): Promise<void> {
  // The userId filter is the ownership check: another tenant's id matches zero rows.
  const existing = await prisma.apiKey.findFirst({ where: { id: keyId, userId } });
  if (!existing) throw notFound("API key not found.");
  if (existing.status === "revoked") throw badRequest("That key is already revoked.");

  await prisma.apiKey.update({
    where: { id: keyId },
    data: { status: "revoked", revokedAt: new Date() },
  });

  await recordAudit({
    action: "api_key.revoked",
    userId,
    actorEmail,
    targetType: "api_key",
    targetId: keyId,
    metadata: { name: existing.name, last4: existing.last4 },
    request,
  });
}
