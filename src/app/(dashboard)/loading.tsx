/**
 * Navigation placeholder for every signed-in page.
 *
 * Dashboard routes are dynamic (they read the session cookie), so a click used to block on
 * the server render with no feedback at all. This boundary gives the router something to
 * paint immediately — and, because Next prefetches a dynamic route only as far as its
 * nearest loading boundary, it is also what makes the sidebar's prefetching useful.
 *
 * The shell (sidebar, header, quota card) is owned by the layout and stays on screen; only
 * this page region is replaced, so the shape below mirrors the common page skeleton rather
 * than any one route.
 */
import { Skeleton, SkeletonCards } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="space-y-5" role="status" aria-busy="true">
      <span className="sr-only">Loading page</span>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-3.5 w-full max-w-xl" />
          <Skeleton className="h-3.5 w-2/3 max-w-sm" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>

      <SkeletonCards />

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="panel space-y-4 p-4">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-56 w-full" />
        </div>
        <div className="grid gap-4">
          {[0, 1].map((index) => (
            <div key={index} className="panel space-y-3 p-4">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
