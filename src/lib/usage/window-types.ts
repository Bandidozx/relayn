/**
 * Trend-window shapes shared by the server aggregation in `./metrics` and the client
 * components that reslice it.
 *
 * This module deliberately has no `server-only` import: the dashboard now ships every
 * window to the browser and switches between them without a navigation, so the client
 * needs these types and the window list too. Nothing here touches the database.
 */

/** Windows offered by the dashboard switcher, narrowest first. */
export const TREND_WINDOWS = [7, 14, 30] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];
export const DEFAULT_TREND_WINDOW: TrendWindow = 14;
export const MAX_TREND_WINDOW: TrendWindow = TREND_WINDOWS[TREND_WINDOWS.length - 1]!;

export function isTrendWindow(value: number): value is TrendWindow {
  return (TREND_WINDOWS as readonly number[]).includes(value);
}

export interface TrendPoint {
  date: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  costMicroUsd: number;
}

export interface ModelBreakdownRow {
  modelId: string;
  requests: number;
  totalTokens: number;
  costMicroUsd: number;
  avgLatencyMs: number;
  errorRate: number;
}

/** Everything that changes when the range switcher moves. */
export interface WindowMetrics {
  days: TrendWindow;
  trend: TrendPoint[];
  successRate: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  models: ModelBreakdownRow[];
}
