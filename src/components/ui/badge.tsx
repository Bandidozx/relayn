import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "brand" | "amber" | "rose" | "violet" | "sky";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-raised text-ink-muted border-line-strong",
  brand: "bg-brand/12 text-brand border-brand/30",
  amber: "bg-amber/12 text-amber border-amber/30",
  rose: "bg-rose/12 text-rose border-rose/30",
  violet: "bg-violet/12 text-violet border-violet/30",
  sky: "bg-sky/12 text-sky border-sky/30",
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
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
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
