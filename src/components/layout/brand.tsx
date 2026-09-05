import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Relayn mark — an original glyph: one inbound signal fanned out to three upstream
 * providers, which is literally what the gateway does. No third-party asset is used
 * anywhere in this application.
 *
 * The tile stays dark in both themes and its mint is hardcoded rather than taken from
 * `--color-brand`. That token darkens to teal-700 in light mode so it stays readable as *text*;
 * on this tile it would only mean a muddy glyph on a slate square. A logo is one colour
 * everywhere, which is the whole point of a logo.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7.5 drop-shadow-[0_0_12px_var(--glow-brand)] transition-transform duration-300 group-hover:scale-105", className)} aria-hidden>
      <defs>
        <linearGradient id="relayn-logo-bg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#1e293b" />
          <stop offset="100%" stopColor="#0f172a" />
        </linearGradient>
      </defs>
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="9" fill="url(#relayn-logo-bg)" />
      <rect
        x="0.75"
        y="0.75"
        width="30.5"
        height="30.5"
        rx="9"
        fill="none"
        stroke="rgba(255, 255, 255, 0.14)"
        strokeWidth="1.2"
      />
      <path
        d="M9 16h4.5c1.6 0 2.4-1.2 3.2-2.6.9-1.5 1.7-2.9 3.4-2.9H23M16.7 16H23M9 16h4.5c1.6 0 2.4 1.2 3.2 2.6.9 1.5 1.7 2.9 3.4 2.9H23"
        fill="none"
        stroke="#3fdcb6"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <circle cx="8.6" cy="16" r="2.5" fill="#3fdcb6" />
      <circle cx="23.4" cy="10.5" r="1.7" fill="#3fdcb6" opacity="0.65" />
      <circle cx="23.4" cy="16" r="1.7" fill="#3fdcb6" opacity="0.95" />
      <circle cx="23.4" cy="21.5" r="1.7" fill="#3fdcb6" opacity="0.65" />
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
