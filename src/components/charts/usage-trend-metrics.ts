/**
 * Shared shape and metric definitions for the usage trend chart.
 *
 * Kept out of both chart modules so the toggle UI and the Recharts-backed plot can agree
 * on the metric list without the toggle pulling Recharts into the initial bundle.
 */
import { formatCompact, formatLatency, formatNumber } from "@/lib/format";

export interface TrendDatum {
  date: string;
  requests: number;
  errors: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
}

export type Metric = "totalTokens" | "requests" | "avgLatencyMs";

export interface MetricDef {
  id: Metric;
  label: string;
  format: (value: number) => string;
}

export const METRICS: MetricDef[] = [
  { id: "totalTokens", label: "Tokens", format: (value) => formatCompact(value) },
  { id: "requests", label: "Requests", format: (value) => formatNumber(value) },
  { id: "avgLatencyMs", label: "Latency", format: (value) => formatLatency(value) },
];

export function metricById(id: Metric): MetricDef {
  return METRICS.find((entry) => entry.id === id) ?? METRICS[0]!;
}
