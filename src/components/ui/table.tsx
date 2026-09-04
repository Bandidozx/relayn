import { cn } from "@/lib/cn";

/**
 * Table shell. Wide tables scroll horizontally inside the card on small screens rather
 * than breaking the layout; column definitions decide what collapses via `hideBelow`.
 */
export function TableWrap({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <table className="w-full min-w-max border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  className,
  children,
  align = "left",
  sortable = false,
  sorted,
  onSort,
}: {
  className?: string;
  children?: React.ReactNode;
  align?: "left" | "right" | "center";
  sortable?: boolean;
  sorted?: "asc" | "desc" | null;
  onSort?: () => void;
}) {
  const content = sortable ? (
    <button
      type="button"
      onClick={onSort}
      className="inline-flex items-center gap-1 transition-colors hover:text-ink"
    >
      {children}
      <svg viewBox="0 0 12 12" className="size-2.5 shrink-0" aria-hidden>
        <path
          d="M6 2.5l2.5 3h-5z"
          fill="currentColor"
          opacity={sorted === "asc" ? 1 : 0.3}
        />
        <path
          d="M6 9.5l-2.5-3h5z"
          fill="currentColor"
          opacity={sorted === "desc" ? 1 : 0.3}
        />
      </svg>
    </button>
  ) : (
    children
  );

  return (
    <th
      scope="col"
      aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}
      className={cn(
        "sticky top-0 z-10 border-b border-line bg-surface px-4 py-2.5 text-[11px] font-medium tracking-wide text-ink-faint uppercase",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
    >
      {content}
    </th>
  );
}

export function Td({
  className,
  children,
  align = "left",
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" | "center" }) {
  return (
    <td
      className={cn(
        "border-b border-line/70 px-4 py-3 align-middle text-ink-muted",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

export function Tr({
  className,
  children,
  onClick,
  ...rest
}: React.HTMLAttributes<HTMLTableRowElement>) {
  const interactive = Boolean(onClick);
  return (
    <tr
      onClick={onClick}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                (event.currentTarget as HTMLElement).click();
              }
            }
          : undefined
      }
      className={cn(
        "transition-colors last:[&>td]:border-b-0",
        interactive && "cursor-pointer hover:bg-hover/70",
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

/** Page N of M with prev/next. Server-side paging keeps payloads small. */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  loading = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  loading?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
      <p className="numeric text-xs text-ink-faint">
        {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1 || loading}
          className="rounded-lg border border-line-strong px-2.5 py-1.5 text-xs transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45"
        >
          Previous
        </button>
        <span className="numeric px-2 text-xs text-ink-muted">
          {page} / {pages}
        </span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= pages || loading}
          className="rounded-lg border border-line-strong px-2.5 py-1.5 text-xs transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45"
        >
          Next
        </button>
      </div>
    </div>
  );
}
