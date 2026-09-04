"use client";

/**
 * Global error boundary.
 *
 * Next.js passes an `Error` whose message is redacted in production builds, so nothing
 * server-side leaks into the page. The `digest` is shown because it is the only handle that
 * ties this screen to the corresponding server log line.
 */
import { useEffect } from "react";
import Link from "next/link";
import { Brand } from "@/components/layout/brand";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced in the browser console so a developer sees it without digging through the panel.
    console.error("Unhandled application error", error);
  }, [error]);

  return (
    <div className="grid-backdrop flex min-h-dvh flex-col items-center justify-center gap-6 px-5 text-center">
      <Brand href="/" showTagline />
      <div>
        <p className="numeric text-sm text-rose">Something broke</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
          This page could not be rendered
        </h1>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
          The failure was logged on the server. Retrying is safe — no partial write is left behind,
          because every mutation in this app runs inside a single request.
        </p>
        {error.digest ? (
          <p className="numeric mt-3 text-[11px] text-ink-faint">digest {error.digest}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="rounded-xl border border-line-strong px-4 py-2.5 text-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink"
        >
          Go to the dashboard
        </Link>
      </div>
    </div>
  );
}
