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

  /*
   * Tokens, not literals: the hover glow has to be the *palette's* accent, and the resting drop
   * shadow has to stop being pure black once the card sits on paper.
   */
  const glowBorder =
    tone === "brand"
      ? "hover:border-brand/40 hover:shadow-[0_8px_24px_-4px_var(--glow-brand)]"
      : tone === "amber"
        ? "hover:border-amber/40 hover:shadow-[0_8px_24px_-4px_var(--glow-amber)]"
        : tone === "rose"
          ? "hover:border-rose/40 hover:shadow-[0_8px_24px_-4px_var(--glow-rose)]"
          : "hover:border-line-strong hover:shadow-[0_8px_24px_-4px_var(--shade)]";

  return (
    <div
      className={cn(
        "group relative flex flex-col justify-between rounded-2xl border border-line/70 bg-gradient-to-b from-surface/90 to-surface/60 p-4.5 backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 shadow-[inset_0_1px_0_var(--sheen),0_4px_16px_-2px_var(--shade)]",
        glowBorder,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold tracking-wider text-ink-faint uppercase">{label}</p>
        {icon ? (
          <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-line/60 bg-raised/60 text-ink-muted transition-colors group-hover:text-ink">
            {icon}
          </span>
        ) : null}
      </div>
      <div className="mt-3">
        <p className={cn("numeric text-2xl font-bold tracking-tight sm:text-3xl", accent)}>
          {value}
        </p>
        {hint ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint group-hover:text-ink-muted transition-colors">
            {hint}
          </p>
        ) : null}
      </div>
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
