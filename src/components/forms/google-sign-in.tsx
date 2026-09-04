/**
 * "Continue with Google" — a link, not a button.
 *
 * The OAuth handshake starts by *navigating* the browser to Google, so this cannot be a
 * `fetch`: the response is a cross-origin redirect that only a top-level navigation can
 * follow. That also rules out sending the CSRF token that guards every mutating POST here,
 * which is why the start route seals a `state` value into a cookie instead — see
 * `src/lib/auth/oauth/transaction.ts`.
 *
 * The mark is Google's own "G", required by their branding terms for this button; it is the
 * one asset on the page that is deliberately not ours.
 */
import Link from "next/link";
import { cn } from "@/lib/cn";

export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 18" className={cn("size-4 shrink-0", className)} aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.28-1.72V4.94H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.06l3.01-2.34Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.94l3 2.34C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

export function GoogleSignInButton({
  nextPath,
  label = "Continue with Google",
  className,
}: {
  /** Where to land after a successful sign-in. Re-validated server-side; never trusted here. */
  nextPath?: string;
  label?: string;
  className?: string;
}) {
  const href = nextPath
    ? `/api/auth/oauth/google?next=${encodeURIComponent(nextPath)}`
    : "/api/auth/oauth/google";

  return (
    <Link
      href={href}
      // A full navigation, not a client transition: the destination is an external redirect.
      prefetch={false}
      className={cn(
        "inline-flex h-11 w-full items-center justify-center gap-2.5 rounded-xl border border-line-strong text-sm font-medium text-ink transition-colors hover:border-ink-faint hover:bg-hover",
        className,
      )}
    >
      <GoogleMark />
      {label}
    </Link>
  );
}

/** `——— or ———`, so the two sign-in methods read as alternatives rather than a sequence. */
export function AuthDivider({ label = "or" }: { label?: string }) {
  return (
    <div className="my-5 flex items-center gap-3" aria-hidden>
      <span className="h-px flex-1 bg-line" />
      <span className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
