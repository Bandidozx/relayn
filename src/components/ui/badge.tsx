import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "brand" | "amber" | "rose" | "violet" | "sky";

/*
 * Each tone is the same accent at three strengths — a 12% fill, a 35% hairline, and a glow — so a
 * badge stays legible on either canvas without a per-theme variant. The glow is a token because it
 * is the one part that must change *hue*: the light palette's accents are darker, and a badge
 * ringed in mint on white paper looks like a print misregistration.
 */
const TONES: Record<BadgeTone, string> = {
  neutral: "bg-raised/70 text-ink-muted border-line-strong/80",
  brand: "bg-brand/12 text-brand border-brand/35 shadow-[0_0_12px_-3px_var(--glow-brand)]",
  amber: "bg-amber/12 text-amber border-amber/35 shadow-[0_0_12px_-3px_var(--glow-amber)]",
  rose: "bg-rose/12 text-rose border-rose/35 shadow-[0_0_12px_-3px_var(--glow-rose)]",
  violet: "bg-violet/12 text-violet border-violet/35 shadow-[0_0_12px_-3px_var(--glow-violet)]",
  sky: "bg-sky/12 text-sky border-sky/35 shadow-[0_0_12px_-3px_var(--glow-sky)]",
};

export function Badge({
  tone = "neutral",
  className,
  children,
  dot = false,
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap backdrop-blur-sm",
        TONES[tone],
        className,
      )}
    >
      {dot ? (
        <span className="relative flex size-1.5 shrink-0" aria-hidden>
          {tone === "brand" ? (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
          ) : null}
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {children}
    </span>
  );
}

/** Maps the string statuses used across the schema onto badge tones. */
export function StatusBadge({ status }: { status: string }) {
  const tone: BadgeTone =
    status === "active" || status === "success" || status === "resolved" || status === "enabled"
      ? "brand"
      : status === "error" || status === "revoked" || status === "suspended" || status === "past_due"
        ? "rose"
        : status === "pending" || status === "open" || status === "trialing"
          ? "amber"
          : "neutral";
  return (
    <Badge tone={tone} dot>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
