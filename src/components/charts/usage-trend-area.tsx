"use client";

/**
 * The Recharts half of the usage trend chart.
 *
 * Split out of `usage-trend.tsx` purely so Recharts lands in its own client chunk: it is
 * ~99 KB gzip, which was a third of the dashboard's blocking JavaScript. The chart is still
 * prerendered through `next/dynamic`, though that only ever emitted an empty
 * `ResponsiveContainer` — it has no measured size on the server — so the plot appears after
 * hydration exactly as it always has.
 *
 * Everything below is moved verbatim from the original single-file component.
 */
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCompact, formatDayLabel, formatNumber } from "@/lib/format";
import { type Metric, type MetricDef, type TrendDatum, metricById } from "./usage-trend-metrics";

interface TooltipPayloadEntry {
  payload?: TrendDatum;
}

function ChartTooltip({
  active,
  payload,
  metric,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  metric: MetricDef;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-lg border border-line-strong bg-surface/95 px-3 py-2 shadow-pop backdrop-blur">
      <p className="text-[11px] font-medium text-ink">{formatDayLabel(point.date)}</p>
      <p className="numeric mt-1 text-sm text-brand">{metric.format(point[metric.id])}</p>
      <p className="mt-1 text-[10.5px] text-ink-faint">
        {formatNumber(point.requests)} requests · {formatNumber(point.errors)} errors
      </p>
      {metric.id === "totalTokens" ? (
        <p className="text-[10.5px] text-ink-faint">
          {formatCompact(point.inputTokens)} in · {formatCompact(point.outputTokens)} out
        </p>
      ) : null}
    </div>
  );
}

export default function UsageTrendArea({
  data,
  metricId,
}: {
  data: TrendDatum[];
  metricId: Metric;
}) {
  const metric = metricById(metricId);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="relaynTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-brand)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--color-brand)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatDayLabel}
          tick={{ fill: "var(--color-ink-faint)", fontSize: 10.5 }}
          axisLine={{ stroke: "var(--color-line)" }}
          tickLine={false}
          minTickGap={16}
        />
        <YAxis
          tickFormatter={(value: number) => metric.format(value)}
          tick={{ fill: "var(--color-ink-faint)", fontSize: 10.5 }}
          axisLine={false}
          tickLine={false}
          width={56}
        />
        <Tooltip
          content={<ChartTooltip metric={metric} />}
          cursor={{ stroke: "var(--color-line-strong)" }}
        />
        <Area
          type="monotone"
          dataKey={metric.id}
          stroke="var(--color-brand)"
          strokeWidth={2}
          fill="url(#relaynTrendFill)"
          dot={false}
          activeDot={{ r: 3, fill: "var(--color-brand)" }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
