"use client";

/**
 * Usage log explorer: search, filters, sorting, paging and a per-request detail dialog.
 *
 * The first page is rendered on the server and handed in as `initial`, so the table has real
 * rows before any client fetch happens. Every subsequent query goes through `/api/usage`,
 * which scopes rows to the signed-in user — the client never sends a user id, so there is no
 * parameter here that could be tampered with to read another account's traffic.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Pagination, Td, TableWrap, Th, Tr } from "@/components/ui/table";
import { ApiClientError, api } from "@/lib/client/api";
import {
  formatDateTime,
  formatLatency,
  formatMicroUsd,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import type { UsageDetail, UsageListResult, UsageRow } from "@/server/services/usage-service";

type SortKey = "createdAt" | "totalTokens" | "latencyMs";

export interface UsageFilters {
  search: string;
  modelId: string;
  status: "" | "success" | "error";
  apiKeyId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: UsageFilters = {
  search: "",
  modelId: "",
  status: "",
  apiKeyId: "",
  from: "",
  to: "",
};

function buildQuery(
  filters: UsageFilters,
  page: number,
  pageSize: number,
  sort: SortKey,
  direction: "asc" | "desc",
): string {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    sort,
    direction,
  });
  if (filters.search) params.set("search", filters.search);
  if (filters.modelId) params.set("modelId", filters.modelId);
  if (filters.status) params.set("status", filters.status);
  if (filters.apiKeyId) params.set("apiKeyId", filters.apiKeyId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return params.toString();
}

export function UsageExplorer({
  initial,
  initialFilters,
}: {
  initial: UsageListResult;
  initialFilters?: Partial<UsageFilters>;
}) {
  const [filters, setFilters] = useState<UsageFilters>({ ...EMPTY_FILTERS, ...initialFilters });
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [page, setPage] = useState(initial.page);
  const [pageSize, setPageSize] = useState(initial.pageSize);
  const [sort, setSort] = useState<SortKey>("createdAt");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [data, setData] = useState<UsageListResult>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<UsageRow | null>(null);
  const [detail, setDetail] = useState<UsageDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const skipFirst = useRef(true);

  const query = buildQuery(filters, page, pageSize, sort, direction);

  const load = useCallback(async (search: string, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<UsageListResult>(`/api/usage?${search}`, signal);
      setData(result);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(
        caught instanceof ApiClientError ? caught.message : "Could not load the usage log.",
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

  // Debounce typing so a five-character search does not fire five queries.
  useEffect(() => {
    if (searchDraft === filters.search) return;
    const timer = setTimeout(() => {
      setFilters((current) => ({ ...current, search: searchDraft }));
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [searchDraft, filters.search]);

  const activeFilterCount = useMemo(
    () => Object.values(filters).filter((value) => value !== "").length,
    [filters],
  );

  function patch(next: Partial<UsageFilters>) {
    setFilters((current) => ({ ...current, ...next }));
    setPage(1);
  }

  function toggleSort(key: SortKey) {
    if (key === sort) {
      setDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
      setDirection("desc");
    }
    setPage(1);
  }

  function reset() {
    setFilters(EMPTY_FILTERS);
    setSearchDraft("");
    setSort("createdAt");
    setDirection("desc");
    setPage(1);
  }

  /** Row click fetches the full record — the list payload deliberately omits IP and error text. */
  async function openDetail(row: UsageRow) {
    setDetailFor(row);
    setDetail(null);
    setDetailError(null);
    try {
      const result = await api.get<UsageDetail>(`/api/usage/${row.id}`);
      setDetail(result);
    } catch (caught) {
      setDetailError(
        caught instanceof ApiClientError ? caught.message : "Could not load that request.",
      );
    }
  }

  const errorRate =
    data.totals.requests === 0 ? 0 : (data.totals.errors / data.totals.requests) * 100;

  return (
    <>
      <Card>
        <CardHeader
          title="Filters"
          description="Narrow the log by key, model, status or date. Search matches request id, model, endpoint and error code."
          action={
            <div className="flex items-center gap-2">
              {activeFilterCount > 0 ? (
                <Button variant="ghost" size="sm" onClick={reset}>
                  Clear {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"}
                </Button>
              ) : null}
              <label htmlFor="usage-page-size" className="sr-only">
                Rows per page
              </label>
              <Select
                id="usage-page-size"
                className="h-8 w-auto text-xs"
                value={String(pageSize)}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {[25, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size} rows
                  </option>
                ))}
              </Select>
            </div>
          }
        />
        {/* `grid-cols-1` is not the default: with no unprefixed `grid-cols-*` the single implicit
            track is sized `auto`, which takes its minimum from the widest child — so the search
            field's placeholder pushed the filter row a few pixels past the card and the page
            scrolled sideways on a phone. `grid-cols-1` compiles to `repeat(1, minmax(0, 1fr))`. */}
        <div className="grid grid-cols-1 gap-2.5 border-b border-line px-4 py-4 sm:grid-cols-2 xl:grid-cols-6">
          <div className="sm:col-span-2">
            <label htmlFor="usage-search" className="sr-only">
              Search requests
            </label>
            <Input
              id="usage-search"
              value={searchDraft}
              placeholder="Search request id, model, endpoint…"
              onChange={(event) => setSearchDraft(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="usage-model" className="sr-only">
              Model
            </label>
            <Select
              id="usage-model"
              value={filters.modelId}
              onChange={(event) => patch({ modelId: event.target.value })}
            >
              <option value="">All models</option>
              {data.facets.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="usage-key" className="sr-only">
              API key
            </label>
            <Select
              id="usage-key"
              value={filters.apiKeyId}
              onChange={(event) => patch({ apiKeyId: event.target.value })}
            >
              <option value="">All keys</option>
              {data.facets.keys.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.name} ····{key.last4}
                  {key.status === "revoked" ? " (revoked)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="usage-status" className="sr-only">
              Status
            </label>
            <Select
              id="usage-status"
              value={filters.status}
              onChange={(event) =>
                patch({ status: event.target.value as UsageFilters["status"] })
              }
            >
              <option value="">Any status</option>
              <option value="success">Success only</option>
              <option value="error">Errors only</option>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="usage-from" className="sr-only">
                From date
              </label>
              <Input
                id="usage-from"
                type="date"
                value={filters.from}
                max={filters.to || undefined}
                onChange={(event) => patch({ from: event.target.value })}
              />
            </div>
            <span className="text-xs text-ink-faint">→</span>
            <div className="min-w-0 flex-1">
              <label htmlFor="usage-to" className="sr-only">
                To date
              </label>
              <Input
                id="usage-to"
                type="date"
                value={filters.to}
                min={filters.from || undefined}
                onChange={(event) => patch({ to: event.target.value })}
              />
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-2 divide-line border-b border-line sm:grid-cols-5 sm:divide-x">
          {[
            { label: "Requests", value: formatNumber(data.totals.requests) },
            { label: "Tokens", value: formatNumber(data.totals.totalTokens) },
            {
              label: "Errors",
              value: `${formatNumber(data.totals.errors)} (${formatPercent(errorRate, 1)})`,
            },
            {
              label: "Avg latency",
              value:
                data.totals.avgLatencyMs === null ? "—" : formatLatency(data.totals.avgLatencyMs),
            },
            { label: "Cost", value: formatMicroUsd(data.totals.costMicroUsd) },
          ].map((item) => (
            <div key={item.label} className="px-4 py-3">
              <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{item.label}</dt>
              <dd className="numeric mt-1 text-sm font-medium text-ink">{item.value}</dd>
            </div>
          ))}
        </dl>
        {error ? (
          <ErrorState message={error} onRetry={() => void load(query)} />
        ) : data.rows.length === 0 ? (
          <EmptyState
            title={activeFilterCount > 0 ? "No requests match those filters" : "No requests yet"}
            description={
              activeFilterCount > 0
                ? "Try widening the date range or clearing the model and key filters."
                : "Every call through the gateway is logged here within milliseconds of completing."
            }
            action={
              activeFilterCount > 0 ? (
                <Button variant="secondary" size="sm" onClick={reset}>
                  Clear filters
                </Button>
              ) : null
            }
          />
        ) : (
          <>
            <div className={loading ? "opacity-55 transition-opacity" : "transition-opacity"}>
              <TableWrap>
                <thead>
                  <tr>
                    <Th
                      sortable
                      sorted={sort === "createdAt" ? direction : null}
                      onSort={() => toggleSort("createdAt")}
                    >
                      Timestamp
                    </Th>
                    <Th>API key</Th>
                    <Th>Model</Th>
                    <Th>Endpoint</Th>
                    <Th
                      align="right"
                      sortable
                      sorted={sort === "totalTokens" ? direction : null}
                      onSort={() => toggleSort("totalTokens")}
                    >
                      Tokens
                    </Th>
                    <Th
                      align="right"
                      sortable
                      sorted={sort === "latencyMs" ? direction : null}
                      onSort={() => toggleSort("latencyMs")}
                    >
                      Latency
                    </Th>
                    <Th>Status</Th>
                    <Th>Request id</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <Tr key={row.id} onClick={() => void openDetail(row)}>
                      <Td className="whitespace-nowrap text-ink">{formatDateTime(row.createdAt)}</Td>
                      <Td className="whitespace-nowrap">
                        {row.apiKeyName ? (
                          <>
                            {row.apiKeyName}
                            <span className="numeric text-ink-faint"> ····{row.apiKeyLast4}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td className="numeric text-ink">{row.modelId}</Td>
                      <Td className="numeric">{row.endpoint}</Td>
                      <Td align="right" className="numeric text-ink">
                        {formatNumber(row.totalTokens)}
                        <span className="text-ink-faint">
                          {" "}
                          ({formatNumber(row.inputTokens)}/{formatNumber(row.outputTokens)})
                        </span>
                      </Td>
                      <Td align="right" className="numeric">
                        {formatLatency(row.latencyMs)}
                      </Td>
                      <Td>
                        {row.status === "success" ? (
                          <StatusBadge status="success" />
                        ) : (
                          <Badge tone="rose" dot>
                            {row.errorCode ?? `http ${row.httpStatus}`}
                          </Badge>
                        )}
                      </Td>
                      <Td className="numeric text-ink-faint">{row.requestId}</Td>
                    </Tr>
                  ))}
                </tbody>
              </TableWrap>
            </div>
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              loading={loading}
              onPage={setPage}
            />
          </>
        )}
      </Card>
      <Modal
        open={detailFor !== null}
        onClose={() => setDetailFor(null)}
        title="Request detail"
        description={detailFor ? `Request ${detailFor.requestId}` : undefined}
        size="lg"
        footer={
          detailFor ? (
            <>
              <CopyButton value={detailFor.requestId} label="Copy request id" />
              <Button variant="secondary" onClick={() => setDetailFor(null)}>
                Close
              </Button>
            </>
          ) : null
        }
      >
        {detailError ? (
          <ErrorState message={detailError} />
        ) : !detail ? (
          <div className="space-y-2 py-2">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="h-9 animate-pulse rounded-lg bg-raised" />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {(
                [
                  ["Timestamp", formatDateTime(detail.createdAt)],
                  [
                    "Status",
                    detail.status === "success"
                      ? `success · http ${detail.httpStatus}`
                      : `${detail.errorCode ?? "error"} · http ${detail.httpStatus}`,
                  ],
                  ["Model", detail.modelId],
                  ["Provider", detail.provider],
                  ["Endpoint", detail.endpoint],
                  ["Streamed", detail.streamed ? "yes" : "no"],
                  [
                    "API key",
                    detail.apiKeyName
                      ? `${detail.apiKeyName} ····${detail.apiKeyLast4}`
                      : "key deleted",
                  ],
                  ["Client IP", detail.ipAddress ?? "not recorded"],
                  ["Input tokens", formatNumber(detail.inputTokens)],
                  ["Output tokens", formatNumber(detail.outputTokens)],
                  ["Total tokens", formatNumber(detail.totalTokens)],
                  ["Latency", formatLatency(detail.latencyMs)],
                  ["Cost", formatMicroUsd(detail.costMicroUsd)],
                  ["Record id", detail.id],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
                  <dd className="numeric mt-0.5 truncate text-sm text-ink" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>

            {detail.errorMessage ? (
              <div className="rounded-xl border border-rose/30 bg-rose/8 px-3.5 py-3">
                <p className="text-[11px] tracking-wide text-rose uppercase">Provider error</p>
                <p className="mt-1 font-mono text-xs leading-relaxed break-words text-ink-muted">
                  {detail.errorMessage}
                </p>
              </div>
            ) : null}

            <p className="text-[11px] leading-relaxed text-ink-faint">
              Prompt and completion content is never stored — only the metadata above. That keeps
              your users&apos; data out of our database while still giving you an auditable trail.
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
