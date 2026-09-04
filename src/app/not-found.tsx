/**
 * 404 for any unmatched path, including `notFound()` thrown by a page whose row does not
 * belong to the caller — ownership failures surface as "not found" rather than "forbidden"
 * so an id cannot be probed for existence.
 */
import Link from "next/link";
import { Brand } from "@/components/layout/brand";

export default function NotFound() {
  return (
    <div className="grid-backdrop flex min-h-dvh flex-col items-center justify-center gap-6 px-5 text-center">
      <Brand href="/" showTagline />
      <div>
        <p className="numeric text-sm text-brand">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
          Nothing lives at this address
        </h1>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
          The page may have moved, or the record you asked for is not one this account can see.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/dashboard"
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90"
        >
          Go to the dashboard
        </Link>
        <Link
          href="/"
          className="rounded-xl border border-line-strong px-4 py-2.5 text-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink"
        >
          Back to the start
        </Link>
      </div>
    </div>
  );
}
