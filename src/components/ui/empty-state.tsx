import { cn } from "@/lib/cn";

/**
 * Empty state. Used wherever a query legitimately returns nothing — the spec is explicit
 * that a professional empty state must appear instead of invented statistics.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
  compact = false,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14",
        className,
      )}
    >
      <span
        className="grid size-10 place-items-center rounded-xl border border-line bg-raised text-ink-faint"
        aria-hidden
      >
        {icon ?? (
          <svg viewBox="0 0 20 20" className="size-4.5" aria-hidden>
            <path
              d="M3 6.5h14M3 10h14M3 13.5h9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        )}
      </span>
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        {description ? (
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="mt-1 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** Inline error state with a retry affordance, for failed client-side fetches. */
export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="grid size-10 place-items-center rounded-xl border border-rose/30 bg-rose/10 text-rose" aria-hidden>
        <svg viewBox="0 0 20 20" className="size-4.5" aria-hidden>
          <path
            d="M10 6.5v5M10 14h.01"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </span>
      <div>
        <p className="text-sm font-medium text-ink">Something went wrong</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-muted">{message}</p>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink transition-colors hover:bg-hover"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
