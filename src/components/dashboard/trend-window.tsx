"use client";

/**
 * Client-side range switcher for the overview.
 *
 * The 7/14/30 selector used to be three `<Link href="/dashboard?days=N">`, so every change
 * was a full navigation that re-ran the entire overview aggregation — and Next prefetched
 * all three variants on top of that, costing three speculative server renders per visit.
 * `getDashboardOverview` now returns all three windows from a single `usage_logs` scan and
 * this module swaps between them in React state, so changing the range costs no requests.
 *
 * Only the parts that actually depend on the range live here. The rest of the page — stat
 * cards for today and the billing cycle, budget runway, allocation, recent activity — stays
 * a server component and is not re-rendered when the range changes.
 */
import { createContext, useContext, useMemo, useState } from "react";
import { UsageTrendChart } from "@/components/charts/usage-trend";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/dashboard/stat-card";
import {
  formatCompact,
  formatLatency,
  formatMicroUsd,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import type { TrendWindow, WindowMetrics } from "@/lib/usage/window-types";

interface TrendWindowState {
  days: TrendWindow;
  setDays: (days: TrendWindow) => void;
  active: WindowMetrics;
  options: TrendWindow[];
}

const TrendWindowContext = createContext<TrendWindowState | null>(null);

function useTrendWindow(): TrendWindowState {
  const value = useContext(TrendWindowContext);
  if (!value) {
    throw new Error("useTrendWindow must be used inside <TrendWindowProvider>");
  }
  return value;
}

/**
 * Holds the selected range. Server-rendered children pass straight through; the client
 * pieces below read the selection out of context, which is what lets the window-dependent
 * cards sit in different parts of the page layout without lifting the whole page client-side.
 */
export function TrendWindowProvider({
  windows,
  defaultWindow,
  children,
}: {
  windows: WindowMetrics[];
  defaultWindow: TrendWindow;
  children: React.ReactNode;
}) {
  const [days, setDays] = useState<TrendWindow>(defaultWindow);

  const value = useMemo<TrendWindowState>(() => {
    const active = windows.find((entry) => entry.days === days) ?? windows[0]!;
    return { days: active.days, setDays, active, options: windows.map((entry) => entry.days) };
  }, [windows, days]);

  return <TrendWindowContext.Provider value={value}>{children}</TrendWindowContext.Provider>;
}

/** The 7d/14d/30d selector. Same markup as the old `<Link>` trio, minus the navigation. */
export function TrendWindowSwitcher() {
  const { days, setDays, options } = useTrendWindow();

  return (
    <div className="flex gap-1 rounded-lg border border-line p-0.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setDays(option)}
          aria-current={option === days ? "true" : undefined}
          className={
            option === days
              ? "rounded-md bg-brand/15 px-2.5 py-1 text-[11px] font-medium text-brand"
              : "rounded-md px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-hover hover:text-ink"
          }
        >
          {option}d
        </button>
      ))}
    </div>
  );
}

/** The two stat cards whose figures are window-scoped; the other three stay server-rendered. */
export function WindowStatCards() {
  const { days, active } = useTrendWindow();
  const { successRate, avgLatencyMs, p95LatencyMs } = active;

  return (
    <>
      <StatCard
        label="Success rate"
        value={successRate === null ? "—" : formatPercent(successRate)}
        tone={
          successRate === null
            ? "default"
            : successRate >= 99
              ? "brand"
              : successRate >= 95
                ? "amber"
                : "rose"
        }
        hint={successRate === null ? `No requests in the last ${days} days` : `Last ${days} days`}
      />
      <StatCard
        label="Average latency"
        value={avgLatencyMs === null ? "—" : formatLatency(avgLatencyMs)}
        hint={p95LatencyMs === null ? "Awaiting first request" : `p95 ${formatLatency(p95LatencyMs)}`}
      />
    </>
  );
}

/** Feeds the selected window's day buckets to the (lazily loaded) chart. */
export function WindowTrendChart() {
  const { active } = useTrendWindow();
  return <UsageTrendChart data={active.trend} />;
}

/** Top models, ranked within the selected window. */
export function TopModelsCard() {
  const { days, active } = useTrendWindow();
  const models = active.models;

  return (
    <Card>
      <CardHeader title="Top models" description={`By tokens over the last ${days} days.`} />
      {models.length === 0 ? (
        <EmptyState
          compact
          title="Nothing to rank yet"
          description="Model usage appears here after your first successful call."
        />
      ) : (
        <CardBody className="space-y-3">
          {models.map((model) => {
            const share =
              models[0]!.totalTokens === 0 ? 0 : (model.totalTokens / models[0]!.totalTokens) * 100;
            return (
              <div key={model.modelId}>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="numeric truncate text-xs text-ink">{model.modelId}</p>
                  <p className="numeric shrink-0 text-[11px] text-ink-muted">
                    {formatCompact(model.totalTokens)}
                  </p>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-brand/70" style={{ width: `${share}%` }} />
                </div>
                <p className="mt-1 text-[10.5px] text-ink-faint">
                  {formatNumber(model.requests)} requests · {formatLatency(model.avgLatencyMs)} avg
                  {model.errorRate > 0 ? ` · ${formatPercent(model.errorRate * 100, 0)} errors` : ""}
                  {" · "}
                  {formatMicroUsd(model.costMicroUsd)}
                </p>
              </div>
            );
          })}
        </CardBody>
      )}
    </Card>
  );
}
