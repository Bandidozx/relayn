/**
 * Saved integrations.
 *
 * An integration is a bookmark: which client a user wired up and which key they used. No
 * credential is stored (only `apiKeyId`), so this table is safe to read into the UI.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { badRequest, notFound } from "@/lib/api/http";

export interface IntegrationView {
  id: string;
  type: string;
  name: string;
  configuration: Record<string, unknown>;
  apiKeyId: string | null;
  apiKeyLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

function parseConfiguration(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function listIntegrations(userId: string): Promise<IntegrationView[]> {
  const [rows, keys] = await Promise.all([
    prisma.integration.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.apiKey.findMany({ where: { userId }, select: { id: true, name: true, last4: true } }),
  ]);

  const keyLabels = new Map(keys.map((key) => [key.id, `${key.name} ····${key.last4}`]));

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    name: row.name,
    configuration: parseConfiguration(row.configuration),
    apiKeyId: row.apiKeyId,
    apiKeyLabel: row.apiKeyId ? keyLabels.get(row.apiKeyId) ?? null : null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

export interface CreateIntegrationInput {
  type: string;
  name: string;
  apiKeyId?: string | null | undefined;
  configuration?: Record<string, unknown> | undefined;
}

export async function createIntegration(
  userId: string,
  input: CreateIntegrationInput,
  request: Request,
  actorEmail: string,
): Promise<IntegrationView[]> {
  if (input.apiKeyId) {
    // Prevents attaching someone else's key id to your own integration row.
    const owned = await prisma.apiKey.findFirst({
      where: { id: input.apiKeyId, userId },
      select: { id: true },
    });
    if (!owned) throw badRequest("Select one of your own API keys.");
  }

  const count = await prisma.integration.count({ where: { userId } });
  if (count >= 25) throw badRequest("You have reached the 25 saved integration limit.");

  const created = await prisma.integration.create({
    data: {
      userId,
      type: input.type,
      name: input.name,
      apiKeyId: input.apiKeyId ?? null,
      configuration: JSON.stringify(input.configuration ?? {}),
    },
  });

  await recordAudit({
    action: "integration.created",
    userId,
    actorEmail,
    targetType: "integration",
    targetId: created.id,
    metadata: { type: input.type },
    request,
  });

  return listIntegrations(userId);
}

export async function deleteIntegration(
  userId: string,
  integrationId: string,
  request: Request,
  actorEmail: string,
): Promise<IntegrationView[]> {
  const result = await prisma.integration.deleteMany({ where: { id: integrationId, userId } });
  if (result.count === 0) throw notFound("Integration not found.");

  await recordAudit({
    action: "integration.deleted",
    userId,
    actorEmail,
    targetType: "integration",
    targetId: integrationId,
    request,
  });

  return listIntegrations(userId);
}
