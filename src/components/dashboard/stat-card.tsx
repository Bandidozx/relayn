/**
 * Metric card used across the overview and admin pages.
 *
 * `value` is always rendered as given — when the underlying query has no data the caller
 * passes an em dash rather than a zero that could be mistaken for a real measurement.
 */
import { cn } from "@/lib/cn";

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "brand" | "amber" | "rose";
  icon?: React.ReactNode;
}) {
  const accent =
    tone === "brand"
      ? "text-brand"
      : tone === "amber"
        ? "text-amber"
        : tone === "rose"
          ? "text-rose"
          : "text-ink";

  return (
    <div className="panel p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">{label}</p>
        {icon ? <span className="shrink-0 text-ink-faint">{icon}</span> : null}
      </div>
      <p className={cn("numeric mt-2 text-2xl leading-none font-semibold tracking-tight", accent)}>
        {value}
      </p>
      {hint ? <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p> : null}
    </div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {children}
    </div>
  );
}
