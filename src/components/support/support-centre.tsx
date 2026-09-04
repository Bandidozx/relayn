"use client";

/**
 * Support centre: ticket list, thread view, reply box and the new-ticket dialog.
 *
 * Threads are fetched per id through `/api/support/tickets/:id`, which scopes the lookup to
 * the signed-in user — pasting another account's ticket id returns 404, not a thread.
 */
import { useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { formatDateTime, formatRelative, titleCase } from "@/lib/format";
import type { TicketDetail, TicketView } from "@/server/services/support-service";

const CATEGORIES = ["technical", "billing", "account", "models", "other"] as const;
const PRIORITIES = ["low", "normal", "high"] as const;

const PRIORITY_TONES: Record<string, "neutral" | "amber" | "rose"> = {
  low: "neutral",
  normal: "neutral",
  high: "rose",
};

interface TicketsResponse {
  tickets: TicketView[];
}

interface TicketResponse {
  ticket: TicketDetail;
}

export function SupportCentre({ initialTickets }: { initialTickets: TicketView[] }) {
  const toast = useToast();
  const [tickets, setTickets] = useState(initialTickets);
  const [thread, setThread] = useState<TicketDetail | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    subject: "",
    category: "technical" as string,
    priority: "normal" as string,
    message: "",
  });

  const message = (error: unknown, fallback: string) =>
    error instanceof ApiClientError ? error.message : fallback;

  async function openThread(id: string) {
    setLoadingThread(true);
    setThreadError(null);
    setReply("");
    try {
      const data = await api.get<TicketResponse>(`/api/support/tickets/${id}`);
      setThread(data.ticket);
    } catch (error) {
      setThread(null);
      setThreadError(message(error, "Could not load that ticket."));
    } finally {
      setLoadingThread(false);
    }
  }

  async function submitCreate() {
    if (form.subject.trim().length < 4) {
      setFormError("Add a subject of at least 4 characters.");
      return;
    }
    if (form.message.trim().length < 10) {
      setFormError("Describe the issue in a little more detail (10 characters minimum).");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const data = await api.post<TicketResponse & TicketsResponse>("/api/support/tickets", {
        subject: form.subject.trim(),
        category: form.category,
        priority: form.priority,
        message: form.message.trim(),
      });
      setTickets(data.tickets);
      setThread(data.ticket);
      setCreateOpen(false);
      setForm({ subject: "", category: "technical", priority: "normal", message: "" });
      toast.success("Ticket opened", "We reply in the thread — you will see it here.");
    } catch (error) {
      setFormError(message(error, "Could not open the ticket."));
    } finally {
      setBusy(false);
    }
  }

  async function submitReply() {
    if (!thread || reply.trim().length === 0) return;
    setBusy(true);
    try {
      const data = await api.post<TicketResponse>(`/api/support/tickets/${thread.id}`, {
        message: reply.trim(),
      });
      setThread(data.ticket);
      setReply("");
      const list = await api.get<TicketsResponse>("/api/support/tickets");
      setTickets(list.tickets);
    } catch (error) {
      toast.error("Reply failed", message(error, "Could not post your reply."));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: "open" | "closed") {
    if (!thread) return;
    setBusy(true);
    try {
      const data = await api.patch<TicketResponse>(`/api/support/tickets/${thread.id}`, { status });
      setThread(data.ticket);
      const list = await api.get<TicketsResponse>("/api/support/tickets");
      setTickets(list.tickets);
      toast.success(status === "closed" ? "Ticket closed" : "Ticket reopened");
    } catch (error) {
      toast.error("Update failed", message(error, "Could not update the ticket."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        <Card>
          <CardHeader
            title="Your tickets"
            description={
              tickets.length === 0
                ? "Nothing open"
                : `${tickets.filter((ticket) => ticket.status === "open" || ticket.status === "pending").length} open of ${tickets.length}`
            }
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setFormError(null);
                  setCreateOpen(true);
                }}
              >
                New ticket
              </Button>
            }
          />
          {tickets.length === 0 ? (
            <EmptyState
              compact
              title="No tickets yet"
              description="Open one and it appears here with the full conversation."
            />
          ) : (
            <ul className="divide-y divide-line">
              {tickets.map((ticket) => (
                <li key={ticket.id}>
                  <button
                    type="button"
                    onClick={() => void openThread(ticket.id)}
                    aria-current={thread?.id === ticket.id ? "true" : undefined}
                    className={cn(
                      "w-full px-4 py-3 text-left transition-colors hover:bg-hover",
                      thread?.id === ticket.id && "bg-brand/8",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="truncate text-sm text-ink">{ticket.subject}</p>
                      <StatusBadge status={ticket.status} />
                    </div>
                    <p className="mt-1 text-[11px] text-ink-faint">
                      {titleCase(ticket.category)} · {ticket.replyCount} repl
                      {ticket.replyCount === 1 ? "y" : "ies"} · {formatRelative(ticket.updatedAt)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          {threadError ? (
            <ErrorState message={threadError} />
          ) : loadingThread ? (
            <CardBody className="space-y-2">
              {[0, 1, 2].map((row) => (
                <div key={row} className="h-16 animate-pulse rounded-xl bg-raised" />
              ))}
            </CardBody>
          ) : !thread ? (
            <EmptyState
              title="Select a ticket"
              description="Pick a ticket on the left to read the thread, or open a new one to reach us."
            />
          ) : (
            <>
              <CardHeader
                title={thread.subject}
                description={`Opened ${formatDateTime(thread.createdAt)} · ${titleCase(thread.category)}`}
                action={
                  <div className="flex items-center gap-2">
                    <Badge tone={PRIORITY_TONES[thread.priority] ?? "neutral"}>
                      {titleCase(thread.priority)} priority
                    </Badge>
                    <StatusBadge status={thread.status} />
                  </div>
                }
              />
              <CardBody className="space-y-3">
                <article className="rounded-xl border border-line bg-raised/40 px-3.5 py-3">
                  <p className="text-[11px] text-ink-faint">
                    You · {formatDateTime(thread.createdAt)}
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap text-ink-muted">
                    {thread.message}
                  </p>
                </article>

                {thread.messages.map((entry) => (
                  <article
                    key={entry.id}
                    className={cn(
                      "rounded-xl border px-3.5 py-3",
                      entry.mine
                        ? "border-line bg-raised/40"
                        : "border-brand/25 bg-brand/6",
                    )}
                  >
                    <p className="text-[11px] text-ink-faint">
                      {entry.mine ? "You" : entry.authorRole === "admin" ? "Relayn support" : titleCase(entry.authorRole)} ·{" "}
                      {formatDateTime(entry.createdAt)}
                    </p>
                    <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap text-ink-muted">
                      {entry.body}
                    </p>
                  </article>
                ))}

                {thread.status === "closed" || thread.status === "resolved" ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-raised/40 px-3.5 py-3">
                    <p className="text-xs text-ink-muted">
                      This ticket is {thread.status}. Reopen it if the problem came back.
                    </p>
                    <Button variant="secondary" size="sm" loading={busy} onClick={() => void setStatus("open")}>
                      Reopen
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <label htmlFor="ticket-reply" className="sr-only">
                      Reply
                    </label>
                    <Textarea
                      id="ticket-reply"
                      value={reply}
                      maxLength={5000}
                      placeholder="Add more detail, logs or a request id…"
                      onChange={(event) => setReply(event.target.value)}
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void setStatus("closed")}
                      >
                        Close ticket
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        loading={busy}
                        disabled={reply.trim().length === 0}
                        onClick={submitReply}
                      >
                        Send reply
                      </Button>
                    </div>
                  </div>
                )}
              </CardBody>
            </>
          )}
        </Card>
      </div>
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Open a support ticket"
        description="Include a request id from your usage log if the issue is about a specific call — it makes diagnosis much faster."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitCreate} loading={busy}>
              Open ticket
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Subject" htmlFor="ticket-subject" error={formError}>
            <Input
              id="ticket-subject"
              value={form.subject}
              maxLength={160}
              placeholder="Streaming responses cut off after ~30s"
              onChange={(event) =>
                setForm((current) => ({ ...current, subject: event.target.value }))
              }
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Category" htmlFor="ticket-category">
              <Select
                id="ticket-category"
                value={form.category}
                onChange={(event) =>
                  setForm((current) => ({ ...current, category: event.target.value }))
                }
              >
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {titleCase(category)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority" htmlFor="ticket-priority">
              <Select
                id="ticket-priority"
                value={form.priority}
                onChange={(event) =>
                  setForm((current) => ({ ...current, priority: event.target.value }))
                }
              >
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {titleCase(priority)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="What is happening?"
            htmlFor="ticket-message"
            help="Model id, request id, expected vs actual behaviour."
          >
            <Textarea
              id="ticket-message"
              value={form.message}
              maxLength={5000}
              className="min-h-32"
              onChange={(event) =>
                setForm((current) => ({ ...current, message: event.target.value }))
              }
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}
