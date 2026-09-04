"use client";

/**
 * Staff ticket queue.
 *
 * Two panes: the list on the left, the selected thread on the right. Replying posts to
 * `PATCH /api/admin/tickets/:id`, which appends a message with `authorRole: "admin"` and — if
 * no explicit status is sent — moves the ticket to `pending`, meaning "waiting on the user".
 * The endpoint returns the whole refreshed queue, so the list and the open thread update from
 * stored rows together.
 *
 * There is no mail transport in this build: a reply becomes visible on the user's `/support`
 * page and nowhere else. The composer says so, so nobody assumes an email went out.
 */
import { useMemo, useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { formatDateTime, formatRelative, titleCase } from "@/lib/format";
import type { AdminTicketRow } from "@/server/services/admin-service";

const STATUSES = ["open", "pending", "resolved", "closed"] as const;

const PRIORITY_TONES: Record<string, "neutral" | "amber" | "rose"> = {
  low: "neutral",
  normal: "neutral",
  high: "rose",
};

export function AdminTickets({ initial }: { initial: AdminTicketRow[] }) {
  const toast = useToast();
  const [tickets, setTickets] = useState(initial);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const visible = useMemo(
    () => (filter ? tickets.filter((ticket) => ticket.status === filter) : tickets),
    [tickets, filter],
  );
  const selected = visible.find((ticket) => ticket.id === selectedId) ?? visible[0] ?? null;
  const openCount = tickets.filter((ticket) => ticket.status === "open").length;

  async function refetch(status: string) {
    setLoading(true);
    try {
      const next = await api.get<{ tickets: AdminTicketRow[] }>(
        `/api/admin/tickets${status ? `?status=${status}` : ""}`,
      );
      setTickets(next.tickets);
    } catch (error) {
      toast.error(
        "Could not load tickets",
        error instanceof ApiClientError ? error.message : "Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  /** Reply, change status, or both in one call — the server rejects an empty patch. */
  async function patchTicket(id: string, body: { status?: string; reply?: string }, note: string) {
    setBusy(true);
    try {
      const next = await api.patch<{ tickets: AdminTicketRow[] }>(
        `/api/admin/tickets/${id}`,
        body,
      );
      // The endpoint returns the unfiltered queue; keep the current filter applied locally.
      setTickets(next.tickets);
      setSelectedId(id);
      if (body.reply) setReply("");
      toast.success(note);
    } catch (error) {
      toast.error(
        "Could not update ticket",
        error instanceof ApiClientError ? error.message : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
      <Card>
        <CardHeader
          title="Queue"
          description={`${openCount} open of ${tickets.length} loaded. Newest activity first, 100 most recent.`}
          action={
            <Select
              value={filter}
              aria-label="Filter by status"
              className="h-8 w-32 text-xs"
              disabled={loading}
              onChange={(event) => {
                setFilter(event.target.value);
                void refetch(event.target.value);
              }}
            >
              <option value="">All</option>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {titleCase(status)}
                </option>
              ))}
            </Select>
          }
        />
        {visible.length === 0 ? (
          <EmptyState
            title={filter ? "Nothing in this state" : "No tickets yet"}
            description={
              filter
                ? "Switch the filter to see the rest of the queue."
                : "Tickets raised from the user-facing support page appear here."
            }
          />
        ) : (
          <CardBody className={cn("space-y-2", loading && "opacity-55 transition-opacity")}>
            {visible.map((ticket) => {
              const active = selected?.id === ticket.id;
              return (
                <button
                  key={ticket.id}
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => setSelectedId(ticket.id)}
                  className={cn(
                    "w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
                    active
                      ? "border-brand/40 bg-brand/8"
                      : "border-line hover:border-line-strong hover:bg-hover",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-xs text-ink">{ticket.subject}</p>
                    <StatusBadge status={ticket.status} />
                  </div>
                  <p className="numeric mt-1 truncate text-[11px] text-ink-faint">
                    {ticket.user.email}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Badge tone={PRIORITY_TONES[ticket.priority] ?? "neutral"}>
                      {titleCase(ticket.priority)}
                    </Badge>
                    <Badge tone="neutral">{titleCase(ticket.category)}</Badge>
                    <span className="ml-auto text-[11px] text-ink-faint">
                      {formatRelative(ticket.updatedAt)}
                    </span>
                  </div>
                </button>
              );
            })}
          </CardBody>
        )}
      </Card>

      {selected === null ? (
        <Card>
          <EmptyState
            title="No thread selected"
            description="Pick a ticket from the queue to read it and reply."
          />
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={selected.subject}
            description={`${selected.user.name} · ${selected.user.email} · opened ${formatDateTime(selected.createdAt)}`}
            action={
              <Select
                value={selected.status}
                aria-label="Ticket status"
                className="h-8 w-32 text-xs"
                disabled={busy}
                onChange={(event) =>
                  void patchTicket(
                    selected.id,
                    { status: event.target.value },
                    `Moved to ${event.target.value}`,
                  )
                }
              >
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {titleCase(status)}
                  </option>
                ))}
              </Select>
            }
          />
          <CardBody className="space-y-3">
            <div className="flex items-center gap-1.5">
              <Badge tone={PRIORITY_TONES[selected.priority] ?? "neutral"}>
                {titleCase(selected.priority)} priority
              </Badge>
              <Badge tone="neutral">{titleCase(selected.category)}</Badge>
              <span className="numeric ml-auto text-[11px] text-ink-faint">{selected.id}</span>
            </div>

            <ol className="space-y-2">
              <li className="rounded-xl border border-line bg-raised/40 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-ink-muted">
                    {selected.user.name} opened the ticket
                  </span>
                  <span className="numeric text-[11px] text-ink-faint">
                    {formatDateTime(selected.createdAt)}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed whitespace-pre-wrap text-ink">
                  {selected.message}
                </p>
              </li>
              {selected.messages.map((entry) => {
                const staff = entry.authorRole === "admin";
                return (
                  <li
                    key={entry.id}
                    className={cn(
                      "rounded-xl border px-3 py-2.5",
                      staff ? "border-brand/25 bg-brand/6" : "border-line bg-raised/40",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn("text-[11px]", staff ? "text-brand" : "text-ink-muted")}>
                        {staff ? "Support" : selected.user.name}
                      </span>
                      <span className="numeric text-[11px] text-ink-faint">
                        {formatDateTime(entry.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed whitespace-pre-wrap text-ink">
                      {entry.body}
                    </p>
                  </li>
                );
              })}
            </ol>

            <Field
              label="Reply as support"
              htmlFor="admin-reply"
              help="Posting a reply moves the ticket to Pending. It appears on the user's support page — no email is sent, this build has no mail transport."
            >
              <Textarea
                id="admin-reply"
                rows={4}
                value={reply}
                placeholder="Write the response the user will see…"
                onChange={(event) => setReply(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || selected.status === "resolved"}
                onClick={() =>
                  void patchTicket(
                    selected.id,
                    {
                      status: "resolved",
                      ...(reply.trim().length > 0 ? { reply: reply.trim() } : {}),
                    },
                    "Ticket resolved",
                  )
                }
              >
                {reply.trim().length > 0 ? "Reply and resolve" : "Mark resolved"}
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={reply.trim().length === 0}
                onClick={() =>
                  void patchTicket(selected.id, { reply: reply.trim() }, "Reply posted")
                }
              >
                Send reply
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
