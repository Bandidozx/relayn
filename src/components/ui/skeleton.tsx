import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-shimmer rounded-md bg-line-strong/60", className)}
      aria-hidden
    />
  );
}

/** Loading placeholder matching the metric card grid on the overview. */
export function SkeletonCards({ count = 5 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="panel space-y-3 p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="divide-y divide-line" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn("h-3.5", columnIndex === 0 ? "w-40" : "w-20 flex-1")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
