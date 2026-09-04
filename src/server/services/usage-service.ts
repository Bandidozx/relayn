/**
 * Usage log queries for the dashboard.
 *
 * Ownership is enforced structurally: `userId` is part of every `where` clause, including
 * the single-row lookup, so `GET /api/usage/:id` for another tenant's row returns 404
 * rather than data.
 *
 * `contains` is used without Prisma's `mode: "insensitive"` because SQLite does not
 * support that argument; LIKE is already case-insensitive for ASCII there.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/api/http";
import type { Prisma } from "@/generated/prisma/client";

export interface UsageRow {
  id: string;
  requestId: string;
  createdAt: string;
  modelId: string;
  provider: string;
  endpoint: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  status: string;
  httpStatus: number;
  errorCode: string | null;
  costMicroUsd: number;
  streamed: boolean;
  apiKeyId: string | null;
  apiKeyName: string | null;
  apiKeyLast4: string | null;
}

export interface UsageDetail extends UsageRow {
  errorMessage: string | null;
  ipAddress: string | null;
}

export interface UsageQuery {
  page: number;
  pageSize: number;
  search?: string | undefined;
  modelId?: string | undefined;
  status?: "success" | "error" | undefined;
  apiKeyId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  sort: "createdAt" | "totalTokens" | "latencyMs";
  direction: "asc" | "desc";
}

export interface UsageTotals {
  requests: number;
  totalTokens: number;
  errors: number;
  costMicroUsd: number;
  avgLatencyMs: number | null;
}

export interface UsageListResult {
  rows: UsageRow[];
  page: number;
  pageSize: number;
  total: number;
  totals: UsageTotals;
  facets: {
    models: string[];
    keys: Array<{ id: string; name: string; last4: string; status: string }>;
  };
}

function parseBoundary(value: string | undefined, endOfDay: boolean): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) parsed.setHours(23, 59, 59, 999);
  return parsed;
}

function buildWhere(userId: string, query: UsageQuery): Prisma.UsageLogWhereInput {
  const where: Prisma.UsageLogWhereInput = { userId };

  if (query.modelId) where.modelId = query.modelId;
  if (query.status) where.status = query.status;
  if (query.apiKeyId) where.apiKeyId = query.apiKeyId;

  const from = parseBoundary(query.from, false);
  const to = parseBoundary(query.to, true);
  if (from || to) {
    where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  if (query.search) {
    const term = query.search;
    where.OR = [
      { requestId: { contains: term } },
      { modelId: { contains: term } },
      { endpoint: { contains: term } },
      { errorCode: { contains: term } },
    ];
  }

  return where;
}

export async function listUsage(userId: string, query: UsageQuery): Promise<UsageListResult> {
  const where = buildWhere(userId, query);
  const skip = (query.page - 1) * query.pageSize;

  const [total, rows, aggregate, errorCount, distinctModels, keys] = await Promise.all([
    prisma.usageLog.count({ where }),
    prisma.usageLog.findMany({
      where,
      orderBy: [{ [query.sort]: query.direction }, { id: "desc" }],
      skip,
      take: query.pageSize,
      include: { apiKey: { select: { name: true, last4: true } } },
    }),
    prisma.usageLog.aggregate({
      where,
      _sum: { totalTokens: true, costMicroUsd: true },
      _avg: { latencyMs: true },
    }),
    prisma.usageLog.count({ where: { ...where, status: "error" } }),
    prisma.usageLog.findMany({
      where: { userId },
      distinct: ["modelId"],
      select: { modelId: true },
      orderBy: { modelId: "asc" },
      take: 60,
    }),
    prisma.apiKey.findMany({
      where: { userId },
      select: { id: true, name: true, last4: true, status: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    rows: rows.map((row) => ({
      id: row.id,
      requestId: row.requestId,
      createdAt: row.createdAt.toISOString(),
      modelId: row.modelId,
      provider: row.provider,
      endpoint: row.endpoint,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      latencyMs: row.latencyMs,
      status: row.status,
      httpStatus: row.httpStatus,
      errorCode: row.errorCode,
      costMicroUsd: row.costMicroUsd,
      streamed: row.streamed,
      apiKeyId: row.apiKeyId,
      apiKeyName: row.apiKey?.name ?? null,
      apiKeyLast4: row.apiKey?.last4 ?? null,
    })),
    totals: {
      requests: total,
      totalTokens: aggregate._sum.totalTokens ?? 0,
      costMicroUsd: aggregate._sum.costMicroUsd ?? 0,
      errors: errorCount,
      avgLatencyMs: aggregate._avg.latencyMs === null ? null : Math.round(aggregate._avg.latencyMs),
    },
    facets: {
      models: distinctModels.map((row) => row.modelId),
      keys,
    },
  };
}

export async function getUsageDetail(userId: string, id: string): Promise<UsageDetail> {
  const row = await prisma.usageLog.findFirst({
    where: { id, userId },
    include: { apiKey: { select: { name: true, last4: true } } },
  });
  if (!row) throw notFound("Usage record not found.");

  return {
    id: row.id,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
    modelId: row.modelId,
    provider: row.provider,
    endpoint: row.endpoint,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    latencyMs: row.latencyMs,
    status: row.status,
    httpStatus: row.httpStatus,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    costMicroUsd: row.costMicroUsd,
    streamed: row.streamed,
    ipAddress: row.ipAddress,
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKey?.name ?? null,
    apiKeyLast4: row.apiKey?.last4 ?? null,
  };
}
