/**
 * Dashboard metrics. Everything is aggregated from `usage_logs` in JavaScript rather
 * than with database-specific date functions, so the same code is correct on SQLite and
 * PostgreSQL and day buckets follow the server's local calendar instead of whatever
 * timezone the database happens to run in.
 *
 * One read covers every window the dashboard offers: `usage_logs` is scanned once for the
 * widest window (30 days) and the 7- and 14-day figures are folded out of the same day
 * buckets. That is what lets the range switcher be a client-side slice rather than a
 * server round trip. The read is an index range scan on `usage_logs (userId, createdAt)`.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { getRequestSubscription, quotaFrom, type QuotaStatus } from "@/lib/usage/accounting";
import {
  DEFAULT_TREND_WINDOW,
  MAX_TREND_WINDOW,
  TREND_WINDOWS,
  isTrendWindow,
  type ModelBreakdownRow,
  type TrendPoint,
  type TrendWindow,
  type WindowMetrics,
} from "@/lib/usage/window-types";

/** Re-exported so existing importers of this module keep working unchanged. */
export {
  DEFAULT_TREND_WINDOW,
  TREND_WINDOWS,
  isTrendWindow,
  type ModelBreakdownRow,
  type TrendPoint,
  type TrendWindow,
  type WindowMetrics,
};

/** Card values that do not depend on the selected trend window. */
export interface StaticCards {
  tokensRemaining: number;
  tokensUsedToday: number;
  tokensUsedThisMonth: number;
  requestsToday: number;
  requestsThisMonth: number;
  spendMicroUsdThisMonth: number;
}

export interface OverviewCards extends StaticCards {
  successRate: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface BudgetRunway {
  /** null when there is not enough history to project — and always null when unlimited. */
  daysRemaining: number | null;
  avgDailyTokens: number;
  projectedExhaustion: string | null;
  onTrack: boolean;
}

export interface RecentRequest {
  id: string;
  requestId: string;
  createdAt: string;
  modelId: string;
  endpoint: string;
  totalTokens: number;
  latencyMs: number;
  status: string;
  errorCode: string | null;
  apiKeyName: string | null;
}

/** Shape returned by `GET /api/metrics/overview`: a single window, flattened. */
export interface OverviewPayload {
  cards: OverviewCards;
  quota: QuotaStatus;
  trend: TrendPoint[];
  runway: BudgetRunway;
  recent: RecentRequest[];
  models: ModelBreakdownRow[];
  activeKeys: number;
  totalKeys: number;
  hasAnyUsage: boolean;
}

/** Shape the dashboard page renders: every window at once, sliced on the client. */
export interface DashboardOverview {
  cards: StaticCards;
  quota: QuotaStatus;
  runway: BudgetRunway;
  recent: RecentRequest[];
  activeKeys: number;
  totalKeys: number;
  hasAnyUsage: boolean;
  windows: WindowMetrics[];
  defaultWindow: TrendWindow;
}

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? null;
}

interface ModelAccumulator {
  requests: number;
  totalTokens: number;
  costMicroUsd: number;
  latencySum: number;
  errors: number;
}

/** One calendar day of the scan, kept separable so any window can be folded from it. */
interface DayAccumulator {
  date: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  latencySum: number;
  /** Individual latencies, needed because p95 cannot be derived from a daily average. */
  latencies: number[];
  models: Map<string, ModelAccumulator>;
}

function emptyDay(date: string): DayAccumulator {
  return {
    date,
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costMicroUsd: 0,
    latencySum: 0,
    latencies: [],
    models: new Map(),
  };
}

function toTrendPoint(day: DayAccumulator): TrendPoint {
  return {
    date: day.date,
    requests: day.requests,
    errors: day.errors,
    inputTokens: day.inputTokens,
    outputTokens: day.outputTokens,
    totalTokens: day.totalTokens,
    costMicroUsd: day.costMicroUsd,
    avgLatencyMs: day.requests === 0 ? 0 : Math.round(day.latencySum / day.requests),
  };
}

/** Folds the trailing `days` buckets into the figures the switcher swaps between. */
function foldWindow(allDays: DayAccumulator[], days: TrendWindow): WindowMetrics {
  const slice = allDays.slice(-days);

  let requests = 0;
  let successes = 0;
  const latencies: number[] = [];
  const perModel = new Map<string, ModelAccumulator>();

  for (const day of slice) {
    requests += day.requests;
    successes += day.requests - day.errors;
    latencies.push(...day.latencies);
    for (const [modelId, stats] of day.models) {
      const target = perModel.get(modelId);
      if (!target) {
        perModel.set(modelId, { ...stats });
        continue;
      }
      target.requests += stats.requests;
      target.totalTokens += stats.totalTokens;
      target.costMicroUsd += stats.costMicroUsd;
      target.latencySum += stats.latencySum;
      target.errors += stats.errors;
    }
  }

  const models: ModelBreakdownRow[] = [...perModel.entries()]
    .map(([modelId, value]) => ({
      modelId,
      requests: value.requests,
      totalTokens: value.totalTokens,
      costMicroUsd: value.costMicroUsd,
      avgLatencyMs: Math.round(value.latencySum / value.requests),
      errorRate: value.errors / value.requests,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 6);

  return {
    days,
    trend: slice.map(toTrendPoint),
    successRate: requests === 0 ? null : (successes / requests) * 100,
    avgLatencyMs:
      latencies.length === 0
        ? null
        : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    p95LatencyMs: percentile(latencies, 0.95),
    models,
  };
}

async function collect(userId: string) {
  const subscription = await getRequestSubscription(userId);
  const windowStart = new Date(
    startOfToday().getTime() - (MAX_TREND_WINDOW - 1) * 86_400_000,
  );
  const monthStart = startOfMonth();
  const earliest = windowStart < monthStart ? windowStart : monthStart;

  const [logs, keyCounts, recentRows] = await Promise.all([
    prisma.usageLog.findMany({
      where: { userId, createdAt: { gte: earliest } },
      select: {
        createdAt: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        latencyMs: true,
        status: true,
        modelId: true,
        costMicroUsd: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.apiKey.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
    prisma.usageLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { apiKey: { select: { name: true } } },
    }),
  ]);

  // ── one bucket per calendar day of the widest window, oldest first ───────────
  const allDays: DayAccumulator[] = [];
  const byDate = new Map<string, DayAccumulator>();
  for (let offset = 0; offset < MAX_TREND_WINDOW; offset += 1) {
    const day = emptyDay(dayKey(new Date(windowStart.getTime() + offset * 86_400_000)));
    allDays.push(day);
    byDate.set(day.date, day);
  }

  const todayKey = dayKey(new Date());
  let tokensUsedToday = 0;
  let requestsToday = 0;
  let tokensThisMonth = 0;
  let requestsThisMonth = 0;
  let spendThisMonth = 0;

  for (const log of logs) {
    const key = dayKey(log.createdAt);
    const day = byDate.get(key);
    if (day) {
      day.requests += 1;
      day.inputTokens += log.inputTokens;
      day.outputTokens += log.outputTokens;
      day.totalTokens += log.totalTokens;
      day.costMicroUsd += log.costMicroUsd;
      day.latencySum += log.latencyMs;
      if (log.status !== "success") day.errors += 1;
      if (log.latencyMs > 0) day.latencies.push(log.latencyMs);

      const model = day.models.get(log.modelId) ?? {
        requests: 0,
        totalTokens: 0,
        costMicroUsd: 0,
        latencySum: 0,
        errors: 0,
      };
      model.requests += 1;
      model.totalTokens += log.totalTokens;
      model.costMicroUsd += log.costMicroUsd;
      model.latencySum += log.latencyMs;
      if (log.status !== "success") model.errors += 1;
      day.models.set(log.modelId, model);
    }

    if (key === todayKey) {
      requestsToday += 1;
      tokensUsedToday += log.totalTokens;
    }
    if (log.createdAt >= monthStart) {
      requestsThisMonth += 1;
      tokensThisMonth += log.totalTokens;
      spendThisMonth += log.costMicroUsd;
    }
  }

  const quota = quotaFrom(subscription);

  // ── runway projection from the trailing 7 days that actually have traffic ───
  const trailing = allDays.slice(-7);
  const activeDays = trailing.filter((day) => day.requests > 0).length;
  const trailingTokens = trailing.reduce((sum, day) => sum + day.totalTokens, 0);
  const avgDailyTokens = activeDays === 0 ? 0 : Math.round(trailingTokens / activeDays);
  // An unlimited account has nothing to run out of, so there is no projection to make. Left
  // null rather than set to a large number: the UI branches on `quota.unlimited` and would
  // otherwise render "3,652 days of budget left", which is a ceiling where there is none.
  const daysRemaining =
    quota.unlimited || avgDailyTokens <= 0
      ? null
      : Math.max(0, Math.floor(quota.remaining / avgDailyTokens));
  const daysToRenewal = quota.unlimited
    ? 0
    : Math.max(0, Math.ceil((quota.renewalDate.getTime() - Date.now()) / 86_400_000));

  const runway: BudgetRunway = {
    daysRemaining,
    avgDailyTokens,
    projectedExhaustion:
      daysRemaining === null
        ? null
        : new Date(Date.now() + daysRemaining * 86_400_000).toISOString(),
    onTrack: daysRemaining === null ? true : daysRemaining >= daysToRenewal,
  };

  const activeKeys = keyCounts.find((row) => row.status === "active")?._count._all ?? 0;
  const totalKeys = keyCounts.reduce((sum, row) => sum + row._count._all, 0);

  return {
    allDays,
    quota,
    runway,
    activeKeys,
    totalKeys,
    cards: {
      tokensRemaining: quota.remaining,
      tokensUsedToday,
      tokensUsedThisMonth: tokensThisMonth,
      requestsToday,
      requestsThisMonth,
      spendMicroUsdThisMonth: spendThisMonth,
    } satisfies StaticCards,
    recent: recentRows.map((row) => ({
      id: row.id,
      requestId: row.requestId,
      createdAt: row.createdAt.toISOString(),
      modelId: row.modelId,
      endpoint: row.endpoint,
      totalTokens: row.totalTokens,
      latencyMs: row.latencyMs,
      status: row.status,
      errorCode: row.errorCode,
      apiKeyName: row.apiKey?.name ?? null,
    })) satisfies RecentRequest[],
    hasAnyUsage: recentRows.length > 0,
  };
}

/**
 * Every window at once, for the dashboard page. The range switcher then reslices this on
 * the client instead of navigating, so changing the range costs no server work at all.
 */
export async function getDashboardOverview(userId: string): Promise<DashboardOverview> {
  const base = await collect(userId);

  return {
    cards: base.cards,
    quota: base.quota,
    runway: base.runway,
    recent: base.recent,
    activeKeys: base.activeKeys,
    totalKeys: base.totalKeys,
    hasAnyUsage: base.hasAnyUsage,
    windows: TREND_WINDOWS.map((days) => foldWindow(base.allDays, days)),
    defaultWindow: DEFAULT_TREND_WINDOW,
  };
}

/**
 * A single flattened window. Kept for `GET /api/metrics/overview`, whose `?days=` contract
 * predates the client-side switcher and is unchanged.
 */
export async function getOverview(
  userId: string,
  days: number = DEFAULT_TREND_WINDOW,
): Promise<OverviewPayload> {
  const window: TrendWindow = isTrendWindow(days) ? days : DEFAULT_TREND_WINDOW;
  const base = await collect(userId);
  const folded = foldWindow(base.allDays, window);

  return {
    cards: {
      ...base.cards,
      successRate: folded.successRate,
      avgLatencyMs: folded.avgLatencyMs,
      p95LatencyMs: folded.p95LatencyMs,
    },
    quota: base.quota,
    trend: folded.trend,
    runway: base.runway,
    recent: base.recent,
    models: folded.models,
    activeKeys: base.activeKeys,
    totalKeys: base.totalKeys,
    hasAnyUsage: base.hasAnyUsage,
  };
}
