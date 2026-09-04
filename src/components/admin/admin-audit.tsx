"use client";

/**
 * Audit trail viewer.
 *
 * The `audit_logs` table is append-only — there is no update or delete path anywhere in the
 * codebase, and nothing on this page offers one. Rows are written by `recordAudit()` inside the
 * same request that performed the action, so a successful mutation always leaves a trace.
 *
 * `metadata` is stored as a JSON string. It is parsed for display only; if a row ever holds
 * something that is not valid JSON it is shown verbatim rather than swallowed.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { Pagination, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { ApiClientError, api } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { AuditRow } from "@/server/services/admin-service";

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  actions: string[];
}

/** Tone by namespace, so a scan of the column separates operator acts from user acts. */
const TONES: Array<[string, BadgeTone]> = [
  ["admin.", "violet"],
  ["auth.", "sky"],
  ["api_key.", "amber"],
  ["profile.", "neutral"],
  ["support.", "neutral"],
];

function toneOf(action: string): BadgeTone {
  return TONES.find(([prefix]) => action.startsWith(prefix))?.[1] ?? "neutral";
}

function prettyMetadata(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function AdminAudit({ initial }: { initial: AuditPage }) {
  const [data, setData] = useState(initial);
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const skipFirst = useRef(true);

  const query = useMemo(
    () =>
      new URLSearchParams({
        page: String(page),
        pageSize: "25",
        ...(action ? { action } : {}),
      }).toString(),
    [page, action],
  );

  const load = useCallback(async (qs: string, signal?: AbortSignal) => {
    setLoading(true);
    try {
      const next = await api.get<AuditPage>(`/api/admin/audit?${qs}`, signal);
      setData(next);
      setError(null);
    } catch (fetchError) {
      if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
      setError(
        fetchError instanceof ApiClientError ? fetchError.message : "Could not load the audit log.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const controller = new AbortController();
    void load(query, controller.signal);
    return () => controller.abort();
  }, [query, load]);

  return (
    <Card>
      <CardHeader
        title="Audit log"
        description={`${formatNumber(data.total)} ${data.total === 1 ? "entry" : "entries"} match. Append-only — entries are never edited or removed.`}
        action={
          <Select
            value={action}
            aria-label="Filter by action"
            className="h-8 w-56 text-xs"
            onChange={(event) => {
              setAction(event.target.value);
              setPage(1);
              setExpanded(null);
            }}
          >
            <option value="">All actions</option>
            {data.actions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        }
      />
      {error ? (
        <ErrorState message={error} onRetry={() => void load(query)} />
      ) : data.rows.length === 0 ? (
        <EmptyState
          title={action ? "No entries for that action" : "Nothing recorded yet"}
          description={
            action
              ? "Clear the filter to see the whole trail."
              : "Sign-ins, key changes and admin actions are written here as they happen."
          }
        />
      ) : (
        <>
          <TableWrap className={cn(loading && "opacity-55 transition-opacity")}>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th>Target</Th>
                <Th>IP</Th>
                <Th align="right">Detail</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const open = expanded === row.id;
                return (
                  <Fragment key={row.id}>
                    <Tr onClick={() => setExpanded(open ? null : row.id)}>
                      <Td className="numeric whitespace-nowrap text-[11px]">
                        {formatDateTime(row.createdAt)}
                      </Td>
                      <Td>
                        <Badge tone={toneOf(row.action)}>{row.action}</Badge>
                      </Td>
                      <Td className="numeric max-w-[16rem] truncate text-[11px]">
                        {row.actorEmail ?? "system"}
                      </Td>
                      <Td className="text-[11px]">
                        {row.targetType === null ? (
                          <span className="text-ink-faint">—</span>
                        ) : (
                          <span className="numeric">
                            {row.targetType}
                            {row.targetId ? (
                              <span className="text-ink-faint"> · {row.targetId}</span>
                            ) : null}
                          </span>
                        )}
                      </Td>
                      <Td className="numeric text-[11px]">
                        {row.ipAddress ?? <span className="text-ink-faint">—</span>}
                      </Td>
                      <Td align="right" className="text-[11px]">
                        {row.metadata ? (
                          <span className="text-brand">{open ? "Hide" : "Show"}</span>
                        ) : (
                          <span className="text-ink-faint">none</span>
                        )}
                      </Td>
                    </Tr>
                    {open && row.metadata ? (
                      <tr>
                        <Td colSpan={6} className="bg-raised/40">
                          <pre className="numeric overflow-x-auto text-[11px] leading-relaxed text-ink-muted">
                            {prettyMetadata(row.metadata)}
                          </pre>
                        </Td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </TableWrap>
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPage={setPage}
            loading={loading}
          />
        </>
      )}
    </Card>
  );
}
