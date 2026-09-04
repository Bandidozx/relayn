"use client";

/**
 * Usage trend chart. Recharts is client-only, so this file is the boundary: the page
 * stays a server component and passes already-aggregated points in as props.
 *
 * The plot itself lives in `./usage-trend-area` and is pulled in through `next/dynamic`,
 * which moves Recharts (~99 KB gzip, a third of this route's client JavaScript) out of the
 * dashboard's blocking script set and into its own chunk.
 *
 * Prerendering is deliberately left enabled (no `ssr: false`). It costs nothing in markup —
 * `ResponsiveContainer` has no measured size on the server, so the server HTML is an empty
 * 256px box either way and the plot has always painted only after hydration — but it keeps
 * the chunk preloaded in parallel with the main bundle, so the chart appears at the same
 * moment it did before. `ssr: false` would additionally drop those 99 KB from the initial
 * load at the cost of one extra round trip before the chart shows up.
 *
 * The `dynamic()` call has to sit in a client component: per the Next lazy-loading guide, a
 * server component dynamically importing a client component is not code-split at all.
 *
 * The metric toggle stays here so switching metrics remains instant and does not depend on
 * the chart chunk having loaded.
 */
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { METRICS, type Metric, type TrendDatum } from "./usage-trend-metrics";

/** Re-exported so existing importers of this module keep working unchanged. */
export type { TrendDatum } from "./usage-trend-metrics";

const UsageTrendArea = dynamic(() => import("./usage-trend-area"), {
  // The 256px-tall box is owned by the wrapper below, so an empty placeholder holds the
  // exact same space and there is no layout shift if the chunk is still in flight.
  loading: () => <div className="h-full w-full" />,
});

export function UsageTrendChart({ data }: { data: TrendDatum[] }) {
  const [metricId, setMetricId] = useState<Metric>("totalTokens");

  // A flat zero series would render a misleading baseline, so say so instead.
  const hasSignal = useMemo(() => data.some((point) => point.requests > 0), [data]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-ink-faint">
          {hasSignal ? `Last ${data.length} days` : "No traffic in this window yet"}
        </p>
        <div className="flex gap-1 rounded-lg border border-line p-0.5">
          {METRICS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setMetricId(entry.id)}
              aria-pressed={entry.id === metricId}
              className={cn(
                "rounded-md px-2 py-1 text-[11px] transition-colors",
                entry.id === metricId
                  ? "bg-brand/15 font-medium text-brand"
                  : "text-ink-muted hover:bg-hover hover:text-ink",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div className="h-64 w-full">
        <UsageTrendArea data={data} metricId={metricId} />
      </div>
    </div>
  );
}
