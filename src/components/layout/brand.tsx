import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Relayn mark — an original glyph: one inbound signal fanned out to three upstream
 * providers, which is literally what the gateway does. No third-party asset is used
 * anywhere in this application.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden>
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="9" fill="var(--color-raised)" />
      <rect
        x="0.75"
        y="0.75"
        width="30.5"
        height="30.5"
        rx="9"
        fill="none"
        stroke="var(--color-line-strong)"
        strokeWidth="1.5"
      />
      <path
        d="M9 16h4.5c1.6 0 2.4-1.2 3.2-2.6.9-1.5 1.7-2.9 3.4-2.9H23M16.7 16H23M9 16h4.5c1.6 0 2.4 1.2 3.2 2.6.9 1.5 1.7 2.9 3.4 2.9H23"
        fill="none"
        stroke="var(--color-brand)"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <circle cx="8.6" cy="16" r="2.5" fill="var(--color-brand)" />
      <circle cx="23.4" cy="10.5" r="1.7" fill="var(--color-brand)" opacity="0.55" />
      <circle cx="23.4" cy="16" r="1.7" fill="var(--color-brand)" opacity="0.8" />
      <circle cx="23.4" cy="21.5" r="1.7" fill="var(--color-brand)" opacity="0.55" />
    </svg>
  );
}

export function Brand({
  href = "/dashboard",
  showTagline = false,
  className,
}: {
  href?: string;
  showTagline?: boolean;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn("group flex items-center gap-2.5 rounded-lg outline-none", className)}
    >
      <Logo className="shrink-0 transition-transform group-hover:scale-105" />
      <span className="min-w-0">
        <span className="block text-[15px] leading-none font-semibold tracking-tight text-ink">
          Relayn
        </span>
        {showTagline ? (
          <span className="mt-1 block truncate text-[11px] leading-none text-ink-faint">
            One key. Every model.
          </span>
        ) : null}
      </span>
    </Link>
  );
}
