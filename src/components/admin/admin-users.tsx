"use client";

/**
 * Admin user directory: search, filter, paginate, then act.
 *
 * Every mutation goes through `/api/admin/*`, which calls `requireAdmin()` server-side and
 * returns the refreshed page — the table never patches its own rows optimistically, so what
 * you see after an action is what the database actually holds. Self-targeting and demoting
 * the last administrator are refused by the server, not just hidden here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { Pagination, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { formatCompact, formatDate, formatNumber, formatPercent, titleCase } from "@/lib/format";
import { ADMIN_ASSIGNABLE_PLAN_ORDER, isUnlimitedPlan, planOf } from "@/lib/plans";
import type { AdminUserPage, AdminUserRow } from "@/server/services/admin-service";

type PendingAction = { row: AdminUserRow; action: "suspend" | "reactivate" | "make_admin" | "revoke_admin" };

const ACTION_COPY: Record<PendingAction["action"], { title: string; label: string; body: string }> = {
  suspend: {
    title: "Suspend this account?",
    label: "Suspend",
    body: "Their sessions are revoked immediately and every API call starts failing with 403 account_suspended.",
  },
  reactivate: {
    title: "Reactivate this account?",
    label: "Reactivate",
    body: "They can sign in again and existing keys resume working. Revoked keys stay revoked.",
  },
  make_admin: {
    title: "Grant administrator access?",
    label: "Make admin",
    body: "They gain this panel: every account, every model, the audit log and plan overrides.",
  },
  revoke_admin: {
    title: "Revoke administrator access?",
    label: "Revoke admin",
    body: "They keep their account and keys but lose the admin panel. The last active admin cannot be demoted.",
  },
};

export function AdminUsers({ initial, currentUserId }: { initial: AdminUserPage; currentUserId: string }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [planFor, setPlanFor] = useState<AdminUserRow | null>(null);
  const skipFirst = useRef(true);

  const query = new URLSearchParams({
    page: String(page),
    pageSize: "25",
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
  }).toString();

  const load = useCallback(
    async (qs: string, signal?: AbortSignal) => {
      setLoading(true);
      try {
        const next = await api.get<AdminUserPage>(`/api/admin/users?${qs}`, signal);
        setData(next);
        setError(null);
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setError(
          fetchError instanceof ApiClientError ? fetchError.message : "Could not load users.",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const controller = new AbortController();
    void load(query, controller.signal);
    return () => controller.abort();
  }, [query, load]);

  // Debounce typing so each keystroke does not become a query.
  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => {
      setSearch(draft);
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [draft, search]);

  async function runAction() {
    if (!pending) return;
    setBusy(true);
    try {
      await api.patch(`/api/admin/users/${pending.row.id}`, { action: pending.action });
      toast.success(`${ACTION_COPY[pending.action].label} applied`, pending.row.email);
      setPending(null);
      await load(query);
    } catch (actionError) {
      toast.error(
        "Action refused",
        actionError instanceof ApiClientError ? actionError.message : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Users"
          description={`${formatNumber(data.total)} ${data.total === 1 ? "account" : "accounts"} match the current filter.`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={draft}
                placeholder="Search email or name…"
                aria-label="Search users"
                className="h-8 w-52 text-xs"
                onChange={(event) => setDraft(event.target.value)}
              />
              <Select
                value={status}
                aria-label="Filter by status"
                className="h-8 w-36 text-xs"
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="deleted">Deleted</option>
              </Select>
            </div>
          }
        />
        {error ? (
          <ErrorState message={error} onRetry={() => void load(query)} />
        ) : data.rows.length === 0 ? (
          <EmptyState
            title="No accounts match"
            description="Clear the search or status filter to see everyone."
          />
        ) : (
          <>
            <TableWrap className={cn(loading && "opacity-55 transition-opacity")}>
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th>Status</Th>
                  <Th>Plan</Th>
                  <Th align="right">Allocation used</Th>
                  <Th align="right">Keys</Th>
                  <Th align="right">Requests</Th>
                  <Th>Joined</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const self = row.id === currentUserId;
                  const usedPercent =
                    row.tokenAllocation === 0 ? 0 : (row.tokensUsed / row.tokenAllocation) * 100;
                  return (
                    <Tr key={row.id}>
                      <Td>
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 truncate text-ink">
                            {row.name}
                            {row.role === "admin" ? <Badge tone="violet">Admin</Badge> : null}
                            {self ? <Badge tone="neutral">You</Badge> : null}
                          </p>
                          <p className="numeric truncate text-[11px] text-ink-faint">{row.email}</p>
                        </div>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-1.5">
                          <StatusBadge status={row.status} />
                          {row.emailVerified ? null : (
                            <span className="text-[11px] text-ink-faint">unverified</span>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <button
                          type="button"
                          onClick={() => setPlanFor(row)}
                          className="rounded-lg border border-line px-2 py-1 text-[11px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
                        >
                          {row.planName} · {titleCase(row.subscriptionStatus)}
                        </button>
                      </Td>
                      <Td align="right" className="numeric">
                        <span className="text-ink">{formatCompact(row.tokensUsed)}</span>
                        <span className="text-ink-faint">
                          {" / "}
                          {formatCompact(row.tokenAllocation)}
                        </span>
                        <span
                          className={cn(
                            "ml-1.5 text-[11px]",
                            usedPercent >= 90 ? "text-rose" : usedPercent >= 70 ? "text-amber" : "text-ink-faint",
                          )}
                        >
                          {formatPercent(usedPercent, 0)}
                        </span>
                      </Td>
                      <Td align="right" className="numeric">
                        {formatNumber(row.activeKeys)}
                      </Td>
                      <Td align="right" className="numeric">
                        {formatNumber(row.requests)}
                      </Td>
                      <Td className="numeric whitespace-nowrap text-[11px]">
                        {formatDate(row.createdAt)}
                      </Td>
                      <Td align="right">
                        {self ? (
                          <span className="text-[11px] text-ink-faint">
                            own account — use another admin
                          </span>
                        ) : (
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setPending({
                                  row,
                                  action: row.role === "admin" ? "revoke_admin" : "make_admin",
                                })
                              }
                            >
                              {row.role === "admin" ? "Revoke admin" : "Make admin"}
                            </Button>
                            <Button
                              variant={row.status === "suspended" ? "secondary" : "danger"}
                              size="sm"
                              disabled={row.status === "deleted"}
                              onClick={() =>
                                setPending({
                                  row,
                                  action: row.status === "suspended" ? "reactivate" : "suspend",
                                })
                              }
                            >
                              {row.status === "suspended" ? "Reactivate" : "Suspend"}
                            </Button>
                          </div>
                        )}
                      </Td>
                    </Tr>
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

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={runAction}
        loading={busy}
        title={pending ? ACTION_COPY[pending.action].title : ""}
        confirmLabel={pending ? ACTION_COPY[pending.action].label : "Confirm"}
        confirmVariant={pending?.action === "suspend" ? "danger" : "primary"}
        message={
          pending ? (
            <div className="space-y-2">
              <p>
                <span className="numeric text-ink">{pending.row.email}</span>
              </p>
              <p>{ACTION_COPY[pending.action].body}</p>
              <p className="text-xs text-ink-faint">
                Recorded in the audit log against your account.
              </p>
            </div>
          ) : null
        }
      />

      {planFor ? (
        <PlanOverride
          row={planFor}
          onClose={() => setPlanFor(null)}
          onSaved={async () => {
            setPlanFor(null);
            await load(query);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Operator override for one subscription. Allocation is left blank unless the operator wants
 * to depart from the plan default, so switching plan alone keeps plan-derived limits.
 */
function PlanOverride({
  row,
  onClose,
  onSaved,
}: {
  row: AdminUserRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [plan, setPlan] = useState(row.plan);
  const [status, setStatus] = useState(row.subscriptionStatus);
  const [allocation, setAllocation] = useState("");
  const [resetUsage, setResetUsage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const planChanged = plan !== row.plan;
  const statusChanged = status !== row.subscriptionStatus;
  const allocationValue = allocation.trim() === "" ? null : Number(allocation.trim());
  const allocationInvalid =
    allocationValue !== null && (!Number.isInteger(allocationValue) || allocationValue < 0);
  // A paid unlimited account is not editable here at all — `updateUserSubscription` refuses it.
  // Locking the form matches the server instead of letting an operator discover it by error.
  const locked = isUnlimitedPlan(row.plan);
  const dirty =
    !locked && (planChanged || statusChanged || allocationValue !== null || resetUsage);

  async function save() {
    if (allocationInvalid) {
      setError("Allocation must be a whole number of tokens.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/admin/users/${row.id}/subscription`, {
        ...(planChanged ? { plan } : {}),
        ...(statusChanged ? { status } : {}),
        ...(allocationValue !== null ? { tokenAllocation: allocationValue } : {}),
        ...(resetUsage ? { resetUsage: true } : {}),
      });
      toast.success("Subscription updated", row.email);
      await onSaved();
    } catch (saveError) {
      setError(saveError instanceof ApiClientError ? saveError.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Override subscription"
      description={row.email}
      size="sm"
      closeOnBackdrop={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>
            Apply
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {locked ? (
          <p className="rounded-lg border border-brand/30 bg-brand/8 px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
            This account has permanent unlimited access from a verified payment. It cannot be
            edited here — the only write path to that state is the payment callback.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan" htmlFor="override-plan">
            <Select
              id="override-plan"
              value={plan}
              disabled={locked}
              onChange={(event) => setPlan(event.target.value)}
            >
              {/* `unlimited` is absent on purpose: it is granted by a verified payment, and
                  `adminSubscriptionSchema` rejects it, so offering it here would be a dead option. */}
              {ADMIN_ASSIGNABLE_PLAN_ORDER.map((id) => (
                <option key={id} value={id}>
                  {planOf(id).name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status" htmlFor="override-status">
            <Select
              id="override-status"
              value={status}
              disabled={locked}
              onChange={(event) => setStatus(event.target.value)}
            >
              {["active", "past_due", "canceled", "trialing"].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value.replace("_", " "))}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label="Allocation override"
          htmlFor="override-allocation"
          error={allocationInvalid ? "Whole number of tokens." : error}
          help={`Leave empty to use the plan default (${formatNumber(planOf(plan).tokenAllocation)} tokens). Current: ${formatNumber(row.tokenAllocation)}.`}
        >
          <Input
            id="override-allocation"
            inputMode="numeric"
            placeholder="plan default"
            value={allocation}
            disabled={locked}
            onChange={(event) => setAllocation(event.target.value)}
          />
        </Field>
        <Checkbox
          id="override-reset"
          checked={resetUsage}
          disabled={locked}
          label={
            <span className="text-xs leading-relaxed">
              Reset consumed tokens to zero ({formatCompact(row.tokensUsed)} used this cycle). Usage
              rows are kept — only the counter that gates requests is cleared.
            </span>
          }
          onChange={(event) => setResetUsage(event.target.checked)}
        />
      </div>
    </Modal>
  );
}
