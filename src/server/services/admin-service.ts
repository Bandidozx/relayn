/**
 * Administrative reads and writes.
 *
 * Every function here assumes the caller already passed `requireAdmin()` at the route
 * boundary — that check is server-side and is the only thing that grants access. Nothing
 * in this module returns a credential value; provider secrets are reported as a boolean.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { recordAudit, type AuditAction } from "@/lib/audit";
import { badRequest, forbidden, notFound } from "@/lib/api/http";
import { isModelCategory, splitFallbacks } from "@/lib/catalogue";
import { PLANS, isPlanId, isUnlimitedPlan, planOf } from "@/lib/plans";
import { parseProxyList, proxyHintFor } from "@/lib/providers/proxy";
import {
  invalidateProviderCache,
  isProviderKind,
  isReservedProviderId,
  providerStatuses,
  reservedProviderIds,
  resolveProvider,
  type ProviderStatus,
} from "@/lib/providers/registry";
import type { HealthStatus } from "@/lib/providers/types";
import { sealSecret, secretHint } from "@/lib/security/secret-box";
import { splitCapabilities } from "@/server/services/models-service";
import {
  deriveName,
  inferCategory,
  syncProviderCatalogue,
  type SyncSummary,
} from "@/server/services/model-sync-service";

export interface AdminStats {
  users: { total: number; active: number; suspended: number; admins: number; newThisWeek: number };
  keys: { active: number; revoked: number };
  requests: { total: number; last24h: number; errors24h: number };
  tokens: { last24h: number; last30d: number };
  spendMicroUsd: { last30d: number };
  tickets: { open: number; total: number };
  models: { total: number; enabled: number };
  plans: Array<{ plan: string; planName: string; count: number }>;
}

export async function getAdminStats(): Promise<AdminStats> {
  const dayAgo = new Date(Date.now() - 86_400_000);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);

  const [
    userCounts,
    admins,
    newThisWeek,
    keyCounts,
    totalRequests,
    day,
    dayErrors,
    month,
    tickets,
    openTickets,
    modelCount,
    enabledModels,
    planGroups,
  ] = await Promise.all([
    prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.user.count({ where: { role: "admin" } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.apiKey.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.usageLog.count(),
    prisma.usageLog.aggregate({
      where: { createdAt: { gte: dayAgo } },
      _count: { _all: true },
      _sum: { totalTokens: true },
    }),
    prisma.usageLog.count({ where: { createdAt: { gte: dayAgo }, status: "error" } }),
    prisma.usageLog.aggregate({
      where: { createdAt: { gte: monthAgo } },
      _sum: { totalTokens: true, costMicroUsd: true },
    }),
    prisma.supportTicket.count(),
    prisma.supportTicket.count({ where: { status: { in: ["open", "pending"] } } }),
    prisma.aiModel.count(),
    prisma.aiModel.count({ where: { enabled: true } }),
    prisma.subscription.groupBy({ by: ["plan"], _count: { _all: true } }),
  ]);

  const byStatus = (status: string) =>
    userCounts.find((row) => row.status === status)?._count._all ?? 0;
  const byKeyStatus = (status: string) =>
    keyCounts.find((row) => row.status === status)?._count._all ?? 0;

  return {
    users: {
      total: userCounts.reduce((sum, row) => sum + row._count._all, 0),
      active: byStatus("active"),
      suspended: byStatus("suspended"),
      admins,
      newThisWeek,
    },
    keys: { active: byKeyStatus("active"), revoked: byKeyStatus("revoked") },
    requests: { total: totalRequests, last24h: day._count._all, errors24h: dayErrors },
    tokens: { last24h: day._sum.totalTokens ?? 0, last30d: month._sum.totalTokens ?? 0 },
    spendMicroUsd: { last30d: month._sum.costMicroUsd ?? 0 },
    tickets: { open: openTickets, total: tickets },
    models: { total: modelCount, enabled: enabledModels },
    plans: planGroups
      .map((row) => ({
        plan: row.plan,
        planName: planOf(row.plan).name,
        count: row._count._all,
      }))
      .sort((a, b) => planOf(a.plan).order - planOf(b.plan).order),
  };
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  plan: string;
  planName: string;
  subscriptionStatus: string;
  tokensUsed: number;
  tokenAllocation: number;
  activeKeys: number;
  requests: number;
}

export interface AdminUserPage {
  rows: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listUsers(options: {
  page: number;
  pageSize: number;
  search?: string | undefined;
  status?: string | undefined;
}): Promise<AdminUserPage> {
  const where = {
    ...(options.status ? { status: options.status } : {}),
    ...(options.search
      ? {
          OR: [
            { email: { contains: options.search } },
            { name: { contains: options.search } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
      include: {
        subscription: true,
        _count: { select: { usageLogs: true } },
        apiKeys: { where: { status: "active" }, select: { id: true } },
      },
    }),
  ]);

  return {
    total,
    page: options.page,
    pageSize: options.pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
      emailVerified: row.emailVerifiedAt !== null,
      createdAt: row.createdAt.toISOString(),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      plan: row.subscription?.plan ?? "free",
      planName: planOf(row.subscription?.plan ?? "free").name,
      subscriptionStatus: row.subscription?.status ?? "active",
      tokensUsed: row.subscription?.tokensUsed ?? 0,
      tokenAllocation: row.subscription?.tokenAllocation ?? 0,
      activeKeys: row.apiKeys.length,
      requests: row._count.usageLogs,
    })),
  };
}

const USER_ACTIONS: Record<string, { status?: string; role?: string; audit: AuditAction }> = {
  suspend: { status: "suspended", audit: "admin.user_suspended" },
  reactivate: { status: "active", audit: "admin.user_restored" },
  make_admin: { role: "admin", audit: "admin.user_role_changed" },
  revoke_admin: { role: "user", audit: "admin.user_role_changed" },
};

export async function applyUserAction(
  actor: { id: string; email: string },
  targetUserId: string,
  action: string,
  request: Request,
): Promise<void> {
  const spec = USER_ACTIONS[action];
  if (!spec) throw badRequest("Unknown action.");
  if (targetUserId === actor.id) {
    throw forbidden("You cannot change your own role or status.");
  }

  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw notFound("User not found.");

  if (action === "revoke_admin") {
    const admins = await prisma.user.count({ where: { role: "admin", status: "active" } });
    if (admins <= 1) throw badRequest("At least one active administrator must remain.");
  }

  await prisma.user.update({
    where: { id: targetUserId },
    data: { ...(spec.status ? { status: spec.status } : {}), ...(spec.role ? { role: spec.role } : {}) },
  });

  // Suspending must take effect immediately, not at session expiry.
  if (spec.status === "suspended") {
    await prisma.session.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  await recordAudit({
    action: spec.audit,
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "user",
    targetId: targetUserId,
    metadata: { action, targetEmail: target.email },
    request,
  });
}

export interface AdminModelRow {
  id: string;
  modelId: string;
  name: string;
  provider: string;
  category: string;
  description: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPrice: number;
  outputPrice: number;
  capabilities: string[];
  minPlan: string;
  enabled: boolean;
  sortOrder: number;
  requests: number;
  /** Identifier sent upstream. "" when it is the same as `modelId`. */
  upstreamModel: string;
  /** Ordered catalogue ids retried when this model's upstream fails transiently. */
  fallbacks: string[];
  /** True for a hand-added row: sync neither overwrites nor recreates it. */
  manual: boolean;
}

export async function listAdminModels(): Promise<AdminModelRow[]> {
  const [rows, usage] = await Promise.all([
    prisma.aiModel.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.usageLog.groupBy({ by: ["modelId"], _count: { _all: true } }),
  ]);
  const counts = new Map(usage.map((row) => [row.modelId, row._count._all]));

  return rows.map((row) => ({
    id: row.id,
    modelId: row.modelId,
    name: row.name,
    provider: row.provider,
    category: row.category,
    description: row.description,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    inputPrice: row.inputPrice,
    outputPrice: row.outputPrice,
    capabilities: splitCapabilities(row.capabilities),
    minPlan: row.minPlan,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    requests: counts.get(row.modelId) ?? 0,
    upstreamModel: row.upstreamModel ?? "",
    fallbacks: splitFallbacks(row.fallbacks),
    manual: row.manual,
  }));
}

export interface AdminModelPatch {
  enabled?: boolean | undefined;
  minPlan?: string | undefined;
  inputPrice?: number | undefined;
  outputPrice?: number | undefined;
  description?: string | undefined;
  sortOrder?: number | undefined;
  fallbacks?: string | undefined;
  upstreamModel?: string | undefined;
  name?: string | undefined;
  category?: string | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
}

export async function updateAdminModel(
  actor: { id: string; email: string },
  modelRowId: string,
  patch: AdminModelPatch,
  request: Request,
): Promise<AdminModelRow[]> {
  const existing = await prisma.aiModel.findUnique({ where: { id: modelRowId } });
  if (!existing) throw notFound("Model not found.");
  if (patch.minPlan !== undefined && !isPlanId(patch.minPlan)) throw badRequest("Unknown plan.");
  if (patch.fallbacks !== undefined) {
    await assertFallbackChain(existing.modelId, patch.fallbacks);
  }

  const data = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(data).length === 0) throw badRequest("Nothing to update.");

  await prisma.aiModel.update({ where: { id: modelRowId }, data });

  await recordAudit({
    action: "admin.model_updated",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "model",
    targetId: existing.modelId,
    metadata: data,
    request,
  });

  return listAdminModels();
}

/**
 * Rejects a fallback chain that cannot work, while a human is still looking at the form.
 *
 * Two failures are worth catching early because both are silent at request time: a chain that
 * names the model itself (an immediate self-loop) and a chain that names an id no catalogue row
 * has (the gateway would skip it and the operator would never know why the fallback did
 * nothing). Deeper cycles — A → B → A — are *not* rejected here: the runtime walker already
 * guards against revisiting a model, and refusing them at save time would make it impossible to
 * build a mutual pair, which is the most natural two-provider arrangement there is.
 */
async function assertFallbackChain(modelId: string, fallbacks: string): Promise<void> {
  const entries = splitFallbacks(fallbacks);
  if (entries.length === 0) return;
  if (entries.includes(modelId)) {
    throw badRequest(`\`${modelId}\` cannot fall back to itself.`);
  }

  const found = await prisma.aiModel.findMany({
    where: { modelId: { in: entries } },
    select: { modelId: true },
  });
  const known = new Set(found.map((row) => row.modelId));
  const missing = entries.filter((entry) => !known.has(entry));
  if (missing.length > 0) {
    throw badRequest(
      `No catalogue model named ${missing.map((id) => `\`${id}\``).join(", ")}. Add it first, or correct the id.`,
    );
  }
}

export interface AdminModelCreateInput {
  modelId: string;
  provider: string;
  upstreamModel?: string | undefined;
  name?: string | undefined;
  category?: string | undefined;
  description?: string | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  inputPrice?: number | undefined;
  outputPrice?: number | undefined;
  capabilities?: string | undefined;
  minPlan?: string | undefined;
  enabled?: boolean | undefined;
  fallbacks?: string | undefined;
  sortOrder?: number | undefined;
  test?: boolean | undefined;
}

/**
 * Adds a catalogue row by hand.
 *
 * This is the path that does not exist in sync: an upstream that publishes no `/models`, a model
 * an aggregator serves but does not advertise, or an alias an operator wants to expose under
 * their own name. The row is marked `manual` so sync neither overwrites nor resurrects it.
 *
 * `test` defaults to on and is the reason this is not just an INSERT. A dead id accepted here
 * becomes a 502 for a paying caller later, so unless the operator opts out, the upstream is
 * asked to serve one token first and the row is refused if it will not.
 *
 * Prices are stored exactly as given and default to zero. Zero means metered-as-free, which is
 * the honest answer when the operator does not know the price yet — a guess would be billed.
 */
export async function createManualModel(
  actor: { id: string; email: string },
  input: AdminModelCreateInput,
  request: Request,
): Promise<AdminModelsPayload & { probe?: ModelProbeResult }> {
  if (input.minPlan !== undefined && !isPlanId(input.minPlan)) throw badRequest("Unknown plan.");
  if (input.category !== undefined && !isModelCategory(input.category)) {
    throw badRequest("Unknown category.");
  }

  const provider = await resolveProvider(input.provider);
  if (!provider) {
    throw badRequest(
      `\`${input.provider}\` is not a registered provider. Add it in Admin → Providers first.`,
    );
  }

  const clash = await prisma.aiModel.findUnique({ where: { modelId: input.modelId } });
  if (clash) throw badRequest(`A model with the id \`${input.modelId}\` already exists.`);

  const upstreamModel = input.upstreamModel?.trim() || input.modelId;
  if (input.fallbacks !== undefined) {
    await assertFallbackChain(input.modelId, input.fallbacks);
  }

  // Opt-out rather than opt-in: the point of the form is to keep dead ids out of the catalogue.
  let probe: ModelProbeResult | undefined;
  if (input.test !== false) {
    probe = await probeUpstreamModel(provider.id, upstreamModel);
    if (!probe.ok) {
      throw badRequest(
        `${provider.label} would not serve \`${upstreamModel}\`: ${probe.error ?? "the request failed."} Fix the id, or save with the test switched off.`,
      );
    }
  }

  const category = input.category ?? inferCategory(upstreamModel);
  // A hand-added row and a suppression for the same id would contradict each other in the UI —
  // listed as live and as removed at once. Adding the id back by hand is a clearer statement of
  // intent than the earlier deletion, so the suppression goes. `deleteMany` because there may be
  // nothing to delete, which is the common case.
  await prisma.removedModel.deleteMany({ where: { modelId: input.modelId } });
  await prisma.aiModel.create({
    data: {
      modelId: input.modelId,
      provider: provider.id,
      upstreamModel,
      name: input.name?.trim() || deriveName(upstreamModel),
      category,
      description: input.description ?? "",
      contextWindow: input.contextWindow ?? 0,
      maxOutputTokens: input.maxOutputTokens ?? 0,
      inputPrice: input.inputPrice ?? 0,
      outputPrice: input.outputPrice ?? 0,
      capabilities: input.capabilities ?? "streaming",
      minPlan: input.minPlan ?? "free",
      enabled: input.enabled ?? true,
      fallbacks: input.fallbacks ?? "",
      sortOrder: input.sortOrder ?? 900,
      manual: true,
    },
  });

  await recordAudit({
    action: "admin.model_created",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "model",
    targetId: input.modelId,
    metadata: {
      provider: provider.id,
      upstreamModel,
      minPlan: input.minPlan ?? "free",
      enabled: input.enabled ?? true,
      inputPrice: input.inputPrice ?? 0,
      outputPrice: input.outputPrice ?? 0,
      ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
      tested: input.test !== false,
    },
    request,
  });

  const payload = await listAdminModelsPayload();
  return probe ? { ...payload, probe } : payload;
}

/**
 * A catalogue id an operator deleted, kept so sync does not put it back.
 */
export interface RemovedModelRow {
  id: string;
  modelId: string;
  provider: string;
  /** Name the row carried when it was deleted. Display only. */
  name: string;
  removedAt: string;
}

/**
 * Everything Admin → Models renders. Both halves travel together because a delete moves a row
 * from one to the other, and a client that refreshed only the first would show it as simply gone.
 */
export interface AdminModelsPayload {
  models: AdminModelRow[];
  removed: RemovedModelRow[];
}

export async function listRemovedModels(): Promise<RemovedModelRow[]> {
  const rows = await prisma.removedModel.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map((row) => ({
    id: row.id,
    modelId: row.modelId,
    provider: row.provider,
    name: row.name,
    removedAt: row.createdAt.toISOString(),
  }));
}

export async function listAdminModelsPayload(): Promise<AdminModelsPayload> {
  const [models, removed] = await Promise.all([listAdminModels(), listRemovedModels()]);
  return { models, removed };
}

/**
 * Deletes a catalogue row.
 *
 * Two kinds of row, one behaviour, different bookkeeping. A `manual` row was typed in by an
 * operator and sync never touches it, so deleting it is already final and nothing is recorded. A
 * **synced** row is different: the next sync lists the upstream, does not recognise the id, and
 * creates it again — same name, same prices, no trace of the deletion. So the id goes into
 * `removed_models` in the same transaction as the delete, and sync skips it from then on. That is
 * what makes this button mean what it says, and it is why deleting a synced row is now allowed at
 * all; the old advice to disable it instead only existed because deletion did not stick.
 *
 * A row still named by another model's fallback chain is refused — deleting it would leave a chain
 * quietly stepping over a gap. Usage history is deliberately *not* a blocker: `usage_logs` stores
 * `modelId` as a string with no foreign key, so past requests keep their billing record either
 * way, and refusing to tidy the catalogue because a model was once used would mean never tidying
 * it at all.
 */
export async function deleteCatalogueModel(
  actor: { id: string; email: string },
  modelRowId: string,
  request: Request,
): Promise<AdminModelsPayload> {
  const existing = await prisma.aiModel.findUnique({ where: { id: modelRowId } });
  if (!existing) throw notFound("Model not found.");

  const referencedBy = (
    await prisma.aiModel.findMany({
      where: { fallbacks: { contains: existing.modelId } },
      select: { modelId: true, fallbacks: true },
    })
  ).filter(
    (row) => row.modelId !== existing.modelId && splitFallbacks(row.fallbacks).includes(existing.modelId),
  );
  if (referencedBy.length > 0) {
    throw forbidden(
      `\`${existing.modelId}\` is still a fallback for ${referencedBy.map((row) => `\`${row.modelId}\``).join(", ")}. Remove it from those chains first.`,
    );
  }

  // One transaction: a delete that committed without its suppression row would be undone by the
  // next sync, which is the exact failure this table exists to prevent.
  await prisma.$transaction([
    prisma.aiModel.delete({ where: { id: modelRowId } }),
    ...(existing.manual
      ? []
      : [
          prisma.removedModel.upsert({
            where: { modelId: existing.modelId },
            // Re-deleting after a restore is ordinary, so this is an upsert rather than a create.
            update: { name: existing.name, removedBy: actor.id },
            create: {
              modelId: existing.modelId,
              provider: existing.provider,
              name: existing.name,
              removedBy: actor.id,
            },
          }),
        ]),
  ]);

  await recordAudit({
    action: "admin.model_deleted",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "model",
    targetId: existing.modelId,
    metadata: {
      provider: existing.provider,
      upstreamModel: existing.upstreamModel ?? "",
      manual: existing.manual,
      // False for a manual row: nothing to suppress, because sync would never create it.
      suppressed: !existing.manual,
    },
    request,
  });

  return listAdminModelsPayload();
}

/**
 * Lifts a deletion, so the next catalogue sync may create the row again.
 *
 * Deliberately does not recreate the row itself. The suppression stores an id, not a snapshot —
 * prices, context window and the upstream identifier belong to the provider, and restoring a copy
 * of them would serve numbers that were correct whenever the model happened to be deleted. So this
 * removes the block and the row comes back from the upstream on the next sync, or never, if the
 * upstream has since dropped it. Nothing is invented either way.
 */
export async function restoreRemovedModel(
  actor: { id: string; email: string },
  removedRowId: string,
  request: Request,
): Promise<AdminModelsPayload> {
  const existing = await prisma.removedModel.findUnique({ where: { id: removedRowId } });
  if (!existing) throw notFound("That model is not on the removed list.");

  await prisma.removedModel.delete({ where: { id: removedRowId } });

  await recordAudit({
    action: "admin.model_restored",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "model",
    targetId: existing.modelId,
    metadata: { provider: existing.provider },
    request,
  });

  return listAdminModelsPayload();
}

export interface ModelProbeResult {
  provider: string;
  label: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  /** Upstream wording when the probe failed. Never contains a credential. */
  error?: string;
  /** First few characters the upstream produced, as evidence it really answered. */
  sample?: string;
}

/**
 * Asks an upstream to serve one token from a model id, and reports whether it did.
 *
 * A one-token completion rather than a catalogue lookup: several aggregators list models they
 * cannot actually serve, and at least one serves ids it does not list, so `/models` answers the
 * wrong question. Cost is a single token on the operator's own upstream account.
 */
export async function probeUpstreamModel(
  providerId: string,
  upstreamModel: string,
): Promise<ModelProbeResult> {
  const provider = await resolveProvider(providerId);
  if (!provider) throw notFound("Provider not found.");

  const base = { provider: provider.id, label: provider.label, model: upstreamModel };
  if (!provider.isConfigured()) {
    return { ...base, ok: false, latencyMs: 0, error: "This provider has no usable credential." };
  }

  const started = Date.now();
  try {
    const result = await provider.chatCompletion(
      { model: upstreamModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
      { upstreamModel, signal: AbortSignal.timeout(30_000) },
    );
    const sample = result.content.trim().slice(0, 60);
    return {
      ...base,
      ok: true,
      latencyMs: Date.now() - started,
      ...(sample ? { sample } : {}),
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message.slice(0, 300) : "The request failed.",
    };
  }
}

/** Probe wrapper for the admin route: same call, plus an audit row. */
export async function testModelUpstream(
  actor: { id: string; email: string },
  providerId: string,
  upstreamModel: string,
  request: Request,
): Promise<ModelProbeResult> {
  const result = await probeUpstreamModel(providerId, upstreamModel);
  await recordAudit({
    action: "admin.model_tested",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "model",
    targetId: upstreamModel,
    metadata: {
      provider: result.provider,
      ok: result.ok,
      latencyMs: result.latencyMs,
      ...(result.error ? { error: result.error.slice(0, 200) } : {}),
    },
    request,
  });
  return result;
}

/**
 * Runs catalogue sync and reports what changed. The audit row records the counts and any
 * per-provider error, so an operator can tell "the upstream published nothing new" apart
 * from "the upstream refused our credential" after the fact.
 */
export async function syncAdminModels(
  actor: { id: string; email: string },
  providers: string[] | undefined,
  request: Request,
): Promise<AdminModelsPayload & { summary: SyncSummary }> {
  const summary = await syncProviderCatalogue(providers);

  await recordAudit({
    action: "admin.models_synced",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "model",
    metadata: {
      requested: providers ?? "all",
      created: summary.created,
      updated: summary.updated,
      preserved: summary.preserved,
      suppressed: summary.suppressed,
      skipped: summary.skipped,
      providers: summary.results.map((entry) => ({
        provider: entry.provider,
        discovered: entry.discovered,
        created: entry.created,
        updated: entry.updated,
        preserved: entry.preserved,
        suppressed: entry.suppressed,
        stale: entry.stale.length,
        ...(entry.error ? { error: entry.error } : {}),
      })),
    },
    request,
  });

  return { ...(await listAdminModelsPayload()), summary };
}

export interface AdminProviderRow extends ProviderStatus {
  /** `provider_configs.id`, the handle PATCH/DELETE address. Null for an un-annotated builtin. */
  configId: string | null;
  baseUrl: string | null;
  notes: string;
  models: number;
  dbEnabled: boolean;
  /** Dialect spoken upstream. Builtins report the adapter they were compiled with. */
  kind: string;
  /** Last four characters of the stored credential, or "" — never the whole value. */
  apiKeyHint: string;
  /** Stored extra headers as JSON, for the edit form. Contains no credential. */
  extraHeaders: string;
  /** Redacted proxy list for display, e.g. "http://user:***@1.2.3.4:8080 +2 more". */
  proxyHint: string;
}

/**
 * Merges the runtime registry with the stored provider settings.
 *
 * Two kinds of row come back. A builtin is reported from env and its `configId` is null unless
 * an operator has annotated it. A custom provider is reported from its database row, and
 * `configId` is what the edit and delete routes use — the slug is never a URL parameter, so a
 * request cannot address a provider by guessing its name.
 *
 * `apiKeyCipher` is read but never returned: only `apiKeyHint` leaves this function.
 */
export async function listAdminProviders(): Promise<AdminProviderRow[]> {
  const [statuses, configs, modelCounts] = await Promise.all([
    providerStatuses(false),
    prisma.providerConfig.findMany(),
    prisma.aiModel.groupBy({ by: ["provider"], _count: { _all: true } }),
  ]);

  const byProvider = new Map(configs.map((config) => [config.provider, config]));
  const counts = new Map(modelCounts.map((row) => [row.provider, row._count._all]));

  const rows: AdminProviderRow[] = statuses.map((status) => {
    const config = byProvider.get(status.id);
    return {
      ...status,
      configId: config?.id ?? null,
      baseUrl: config?.baseUrl ?? null,
      notes: config?.notes ?? "",
      dbEnabled: config?.enabled ?? true,
      models: counts.get(status.id) ?? 0,
      kind: config?.kind ?? (status.id === "anthropic" ? "anthropic" : "openai"),
      apiKeyHint: config?.apiKeyHint ?? "",
      extraHeaders: config?.extraHeaders ?? "",
      proxyHint: config?.proxyHint ?? "",
    };
  });

  // A custom provider that has been disabled is absent from the registry, so it has no status
  // row — but the operator still has to see it to re-enable or delete it. Its health is
  // reported as unconfigured rather than probed: a disabled provider serves no traffic.
  const shown = new Set(rows.map((row) => row.id));
  for (const config of configs) {
    if (!config.custom || shown.has(config.provider)) continue;
    rows.push({
      id: config.provider,
      label: config.label,
      credentialEnvVar: "",
      configured: Boolean(config.apiKeyCipher),
      custom: true,
      health: { state: "unconfigured", detail: "Disabled — not routable." },
      configId: config.id,
      baseUrl: config.baseUrl,
      notes: config.notes,
      dbEnabled: false,
      models: counts.get(config.provider) ?? 0,
      kind: config.kind,
      apiKeyHint: config.apiKeyHint,
      extraHeaders: config.extraHeaders,
      // Stored, but not rotating: a disabled provider serves no traffic, so it has no pool.
      proxies: 0,
      proxyHint: config.proxyHint,
    });
  }

  return rows;
}

export interface AdminProviderCreateInput {
  provider: string;
  label: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  extraHeaders?: string | undefined;
  notes?: string | undefined;
  enabled?: boolean | undefined;
  syncModels?: boolean | undefined;
}

/**
 * Registers a runtime-added upstream.
 *
 * The credential is sealed before the row is written and the plaintext is never persisted,
 * logged or audited — `metadata` carries the hint (last four characters) and nothing more.
 *
 * Slugs that name a builtin are refused: allowing `openai` here would let a dashboard row
 * shadow a compiled-in provider, and every model already prefixed `openai/` would silently
 * start routing to the operator's URL. The registry enforces the same rule again when it
 * composes the snapshot, so a row inserted by any other means still cannot take over.
 */
export async function createCustomProvider(
  actor: { id: string; email: string },
  input: AdminProviderCreateInput,
  request: Request,
): Promise<{ providers: AdminProviderRow[]; sync?: SyncSummary }> {
  if (isReservedProviderId(input.provider)) {
    throw badRequest(
      `\`${input.provider}\` is a built-in provider id. Reserved: ${reservedProviderIds().join(", ")}.`,
    );
  }
  if (!isProviderKind(input.kind)) throw badRequest("Unknown provider kind.");

  const existing = await prisma.providerConfig.findUnique({ where: { provider: input.provider } });
  if (existing) throw badRequest(`A provider with the id \`${input.provider}\` already exists.`);

  await prisma.providerConfig.create({
    data: {
      provider: input.provider,
      label: input.label,
      kind: input.kind,
      baseUrl: input.baseUrl,
      apiKeyCipher: sealSecret(input.apiKey),
      apiKeyHint: secretHint(input.apiKey),
      extraHeaders: input.extraHeaders ?? "",
      notes: input.notes ?? "",
      enabled: input.enabled ?? true,
      custom: true,
      // Custom providers have no env var: the credential is the sealed column above.
      envVar: "",
    },
  });
  invalidateProviderCache();

  await recordAudit({
    action: "admin.provider_created",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "provider",
    targetId: input.provider,
    metadata: {
      label: input.label,
      kind: input.kind,
      baseUrl: input.baseUrl,
      enabled: input.enabled ?? true,
      // The hint, never the key.
      apiKeyHint: secretHint(input.apiKey),
    },
    request,
  });

  // Catalogue pull is opt-in and best-effort: a provider that was added correctly should not
  // fail to be created because its `/models` endpoint happened to be down.
  let sync: SyncSummary | undefined;
  if (input.syncModels) {
    sync = await syncProviderCatalogue([input.provider]);
  }

  return sync ? { providers: await listAdminProviders(), sync } : { providers: await listAdminProviders() };
}

export interface AdminProviderPatch {
  label?: string | undefined;
  kind?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  extraHeaders?: string | undefined;
  notes?: string | undefined;
  enabled?: boolean | undefined;
}

/**
 * Edits a stored provider row.
 *
 * Works for both kinds, but the two differ in what may change. A builtin's row only annotates
 * a compiled-in provider, so its credential is not editable here — the key lives in the
 * environment and pretending otherwise would produce a row whose sealed key is never read.
 * `provider` (the slug) is immutable for both: catalogue ids are prefixed with it.
 */
export async function updateProviderConfig(
  actor: { id: string; email: string },
  configId: string,
  patch: AdminProviderPatch,
  request: Request,
): Promise<AdminProviderRow[]> {
  const existing = await prisma.providerConfig.findUnique({ where: { id: configId } });
  if (!existing) throw notFound("Provider not found.");
  if (patch.kind !== undefined && !isProviderKind(patch.kind)) throw badRequest("Unknown provider kind.");
  if (patch.apiKey !== undefined && !existing.custom) {
    throw badRequest(
      `\`${existing.provider}\` is a built-in provider. Its credential comes from ${existing.envVar || "the environment"} and cannot be set here.`,
    );
  }

  const data: Record<string, unknown> = {};
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.kind !== undefined) data.kind = patch.kind;
  if (patch.baseUrl !== undefined) data.baseUrl = patch.baseUrl;
  if (patch.extraHeaders !== undefined) data.extraHeaders = patch.extraHeaders;
  if (patch.notes !== undefined) data.notes = patch.notes;
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (patch.apiKey !== undefined) {
    data.apiKeyCipher = sealSecret(patch.apiKey);
    data.apiKeyHint = secretHint(patch.apiKey);
  }
  if (Object.keys(data).length === 0) throw badRequest("Nothing to update.");

  await prisma.providerConfig.update({ where: { id: configId }, data });
  invalidateProviderCache();

  // The audit row records *which* fields moved, never their secret values: the credential is
  // reported as a rotation with its hint.
  const { apiKeyCipher: _cipher, ...safe } = data;
  await recordAudit({
    action: patch.apiKey !== undefined ? "admin.provider_credential_rotated" : "admin.provider_updated",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "provider",
    targetId: existing.provider,
    metadata: safe,
    request,
  });

  return listAdminProviders();
}

/**
 * Removes a custom provider.
 *
 * Refused while catalogue rows still name it: deleting the row would leave every
 * `<slug>/<model>` entry pointing at an adapter that no longer exists, which the gateway
 * reports as `provider_not_registered` — a confusing 503 for callers whose model "vanished".
 * The operator is told to remove or disable those models first. Builtins cannot be deleted at
 * all; their row is only an annotation and would be recreated from env anyway.
 */
export async function deleteCustomProvider(
  actor: { id: string; email: string },
  configId: string,
  request: Request,
): Promise<AdminProviderRow[]> {
  const existing = await prisma.providerConfig.findUnique({ where: { id: configId } });
  if (!existing) throw notFound("Provider not found.");
  if (!existing.custom || isReservedProviderId(existing.provider)) {
    throw badRequest(`\`${existing.provider}\` is a built-in provider and cannot be deleted.`);
  }

  const models = await prisma.aiModel.count({ where: { provider: existing.provider } });
  if (models > 0) {
    throw forbidden(
      `${existing.label} still has ${models} model${models === 1 ? "" : "s"} in the catalogue. Delete those models first, or disable the provider instead.`,
    );
  }

  await prisma.providerConfig.delete({ where: { id: configId } });
  invalidateProviderCache();

  await recordAudit({
    action: "admin.provider_deleted",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "provider",
    targetId: existing.provider,
    metadata: { label: existing.label, kind: existing.kind, baseUrl: existing.baseUrl },
    request,
  });

  return listAdminProviders();
}

export interface ProviderTestResult {
  provider: string;
  label: string;
  health: HealthStatus;
  /** How many models the upstream lists, when it can list them at all. */
  models?: number;
  /** Sample of the ids on offer, so the operator can see it is the right upstream. */
  sample?: string[];
  /** Present when the catalogue probe failed. Upstream wording, no credential. */
  error?: string;
}

/**
 * Probes a provider live and reports what came back. Stores nothing: this is the "does my key
 * work" button, and it must be safe to press before committing a catalogue sync.
 */
export async function testProvider(
  actor: { id: string; email: string },
  providerId: string,
  request: Request,
): Promise<ProviderTestResult> {
  const provider = await resolveProvider(providerId);
  if (!provider) throw notFound("Provider not found.");

  const health = await provider.healthCheck();
  const result: ProviderTestResult = { provider: provider.id, label: provider.label, health };

  if (provider.isConfigured() && typeof provider.listModels === "function") {
    try {
      const listed = await provider.listModels();
      result.models = listed.length;
      result.sample = listed.slice(0, 8).map((info) => info.id);
    } catch (error) {
      // Upstream wording only. A ProviderError message never contains the credential.
      result.error = error instanceof Error ? error.message : "Catalogue request failed.";
    }
  }

  await recordAudit({
    action: "admin.provider_tested",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "provider",
    targetId: provider.id,
    metadata: {
      health: health.state,
      ...(result.models !== undefined ? { models: result.models } : {}),
      ...(result.error ? { error: result.error.slice(0, 200) } : {}),
    },
    request,
  });

  return result;
}

export interface ProxySaveResult {
  provider: string;
  /** How many proxies this upstream will now rotate through. 0 means direct egress. */
  accepted: number;
  /** Redacted list for display. Never contains a proxy password. */
  hint: string;
  /** One message per line that could not be used, so a paste is not silently truncated. */
  rejected: string[];
  providers: AdminProviderRow[];
}

/**
 * Points one upstream's outbound traffic through a rotating proxy list.
 *
 * Addressed by registry id rather than `provider_configs.id` because the providers that most
 * need this are builtins: `madefaka` and `jerouter` have no annotation row at all until now, so
 * the row is upserted rather than required. A builtin's row stays `custom: false`, which keeps
 * it out of adapter composition — it contributes a proxy list and nothing else.
 *
 * The list is sealed with the same `secret-box` key as an upstream credential, because it is
 * one: a proxy URL usually carries `user:password`. Only `proxyHint` (redacted) and a count are
 * ever stored in the clear or returned, and the audit row records the same two facts. An empty
 * body clears the configuration and returns the provider to direct egress.
 *
 * Lines that cannot be used are reported rather than fatal. A pasted list of 20 proxies with one
 * SOCKS entry should save the other 19 and say what happened to the odd one out — refusing the
 * whole paste would just make the operator hunt for it by hand.
 */
export async function setProviderProxies(
  actor: { id: string; email: string },
  providerId: string,
  raw: string,
  request: Request,
): Promise<ProxySaveResult> {
  const provider = await resolveProvider(providerId);
  const existing = await prisma.providerConfig.findUnique({ where: { provider: providerId } });
  // A disabled custom provider is absent from the registry but still has a row to configure.
  if (!provider && !existing) throw notFound("Provider not found.");

  const { proxies, errors } = parseProxyList(raw);
  if (proxies.length === 0 && errors.length > 0) {
    throw badRequest(`No usable proxy in that list: ${errors.join(" ")}`);
  }

  const cipher = proxies.length > 0 ? sealSecret(proxies.map((entry) => entry.url).join("\n")) : null;
  const hint = proxyHintFor(proxies);

  if (existing) {
    await prisma.providerConfig.update({
      where: { id: existing.id },
      data: { proxyCipher: cipher, proxyHint: hint },
    });
  } else {
    // First-ever row for a builtin. `custom: false` is what stops it becoming an adapter, and
    // `label`/`kind`/`envVar` are recorded from the registry so the admin list has something to
    // show — the credential itself stays in the environment where it already is.
    await prisma.providerConfig.create({
      data: {
        provider: providerId,
        label: provider?.label ?? providerId,
        kind: providerId === "anthropic" ? "anthropic" : "openai",
        envVar: provider?.credentialEnvVar ?? "",
        custom: false,
        enabled: true,
        proxyCipher: cipher,
        proxyHint: hint,
      },
    });
  }

  invalidateProviderCache();

  await recordAudit({
    action: "admin.provider_proxies_updated",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "provider",
    targetId: providerId,
    // Count and redacted hint only: the sealed value is a credential.
    metadata: { proxies: proxies.length, hint, rejected: errors.length },
    request,
  });

  return {
    provider: providerId,
    accepted: proxies.length,
    hint,
    rejected: errors,
    providers: await listAdminProviders(),
  };
}

export interface AdminSubscriptionPatch {
  plan?: string | undefined;
  status?: string | undefined;
  tokenAllocation?: number | undefined;
  resetUsage?: boolean | undefined;
}

/**
 * Administrative subscription edit.
 *
 * Two things an operator may not do here, both because permanent unlimited access is a
 * payment outcome with exactly one write path (`applyVerifiedPayment`):
 *
 *  1. grant it — `unlimited` is not in `ADMIN_ASSIGNABLE_PLAN_ORDER` and is refused below;
 *  2. revoke it by accident — a paid account cannot be re-planned through this endpoint at
 *     all, since the user's rule is that unlimited never silently reverts.
 *
 * The `unlimited` column itself is never in `data`: it is not part of `AdminSubscriptionPatch`,
 * so no request shape can reach it.
 */
export async function updateUserSubscription(
  actor: { id: string; email: string },
  targetUserId: string,
  patch: AdminSubscriptionPatch,
  request: Request,
): Promise<void> {
  const subscription = await prisma.subscription.findUnique({ where: { userId: targetUserId } });
  if (!subscription) throw notFound("Subscription not found.");

  if (subscription.unlimited) {
    throw badRequest(
      "This account has permanent unlimited access from a verified payment. It cannot be edited here.",
    );
  }

  const data: Record<string, unknown> = {};
  if (patch.plan !== undefined) {
    if (!isPlanId(patch.plan)) throw badRequest("Unknown plan.");
    if (isUnlimitedPlan(patch.plan)) {
      throw badRequest("Unlimited access is granted by a verified payment, not assigned by hand.");
    }
    data.plan = patch.plan;
    // Allocation follows the plan unless the operator overrides it explicitly below.
    data.tokenAllocation = PLANS[patch.plan].tokenAllocation;
  }
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.tokenAllocation !== undefined) data.tokenAllocation = patch.tokenAllocation;
  if (patch.resetUsage) data.tokensUsed = 0;
  if (Object.keys(data).length === 0) throw badRequest("Nothing to update.");

  await prisma.subscription.update({ where: { userId: targetUserId }, data });

  await recordAudit({
    action: "admin.subscription_updated",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "subscription",
    targetId: subscription.id,
    metadata: { targetUserId, ...data },
    request,
  });
}

export interface AdminTicketRow {
  id: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  replyCount: number;
  user: { id: string; email: string; name: string };
  messages: Array<{ id: string; authorRole: string; body: string; createdAt: string }>;
}

export async function listAdminTickets(status?: string): Promise<AdminTicketRow[]> {
  const rows = await prisma.supportTicket.findMany({
    where: status ? { status } : {},
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      user: { select: { id: true, email: true, name: true } },
      messages: { orderBy: { createdAt: "asc" } },
      _count: { select: { messages: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    replyCount: row._count.messages,
    user: row.user,
    messages: row.messages.map((message) => ({
      id: message.id,
      authorRole: message.authorRole,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    })),
  }));
}

export async function adminUpdateTicket(
  actor: { id: string; email: string },
  ticketId: string,
  patch: { status?: string | undefined; reply?: string | undefined },
  request: Request,
): Promise<AdminTicketRow[]> {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw notFound("Ticket not found.");

  if (patch.reply) {
    await prisma.ticketMessage.create({
      data: { ticketId, authorId: actor.id, authorRole: "admin", body: patch.reply },
    });
  }
  if (patch.status) {
    await prisma.supportTicket.update({ where: { id: ticketId }, data: { status: patch.status } });
  } else if (patch.reply) {
    await prisma.supportTicket.update({ where: { id: ticketId }, data: { status: "pending" } });
  }
  if (!patch.reply && !patch.status) throw badRequest("Nothing to update.");

  await recordAudit({
    action: "admin.ticket_updated",
    userId: actor.id,
    actorEmail: actor.email,
    targetType: "ticket",
    targetId: ticketId,
    metadata: { status: patch.status ?? null, replied: Boolean(patch.reply) },
    request,
  });

  return listAdminTickets();
}

export interface AuditRow {
  id: string;
  action: string;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export async function listAuditLog(options: {
  page: number;
  pageSize: number;
  action?: string | undefined;
}): Promise<{ rows: AuditRow[]; total: number; page: number; pageSize: number; actions: string[] }> {
  const where = options.action ? { action: options.action } : {};

  const [total, rows, actions] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    prisma.auditLog.findMany({
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
      take: 80,
    }),
  ]);

  return {
    total,
    page: options.page,
    pageSize: options.pageSize,
    actions: actions.map((row) => row.action),
    rows: rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorEmail: row.actorEmail,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
