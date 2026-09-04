"use client";

/**
 * Provider board — status of every upstream, and self-service registration of new ones.
 *
 * Two kinds of row appear here. A *builtin* is compiled into the app and reads its credential
 * from the environment, so this page can annotate it (label, base URL, notes) but not re-key it:
 * the value lives in `.env`, and storing a sealed key nothing ever reads would only look like it
 * worked. A *custom* provider is a `provider_configs` row created from the form below — an
 * operator adds an OpenAI-compatible or Anthropic-compatible upstream, the key is sealed
 * server-side, and the gateway routes to it on the next request without a redeploy.
 *
 * No credential value ever reaches this component. A row carries `apiKeyHint` — the last four
 * characters — and nothing more, so the key field is write-only and always starts empty rather
 * than pre-filled with something that merely looks like the stored value.
 */
import { useState } from "react";
import type { BadgeTone } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { formatLatency, formatNumber, titleCase } from "@/lib/format";
import { MAX_PROXIES_PER_PROVIDER, parseProxyList } from "@/lib/providers/proxy-format";
import type {
  AdminProviderRow,
  ProviderTestResult,
  ProxySaveResult,
} from "@/server/services/admin-service";
import type { SyncSummary } from "@/server/services/model-sync-service";

const HEALTH: Record<string, { tone: BadgeTone; label: string }> = {
  ok: { tone: "brand", label: "Healthy" },
  degraded: { tone: "amber", label: "Degraded" },
  down: { tone: "rose", label: "Down" },
  unconfigured: { tone: "neutral", label: "Unconfigured" },
};

/**
 * The two dialects the gateway can speak. `id` matches `PROVIDER_KINDS` in the registry — the
 * adapter chosen for a stored row — so adding a third one here without adding it there would be
 * rejected by the API rather than silently mis-routed.
 */
const KINDS = [
  {
    id: "openai",
    label: "OpenAI-compatible",
    hint: "Calls POST {base}/chat/completions with an Authorization: Bearer header. Most aggregators and self-hosted gateways speak this.",
    placeholder: "https://jerouter.web.id/v1",
  },
  {
    id: "anthropic",
    label: "Anthropic-compatible",
    hint: "Calls POST {base}/messages with x-api-key and anthropic-version headers.",
    placeholder: "https://api.anthropic.com/v1",
  },
] as const;

function kindLabel(kind: string): string {
  return KINDS.find((entry) => entry.id === kind)?.label ?? titleCase(kind);
}

/** A failed submit: the envelope message plus any per-field detail the API returned. */
interface SubmitError {
  message: string;
  fields: Record<string, string>;
}

function submitError(error: unknown, fallback: string): SubmitError {
  if (error instanceof ApiClientError) {
    return { message: error.message, fields: error.details ?? {} };
  }
  return { message: fallback, fields: {} };
}

function failureText(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

type FormMode = "create" | "edit" | "rotate";

export function AdminProviders({ initial }: { initial: AdminProviderRow[] }) {
  const toast = useToast();
  const [providers, setProviders] = useState(initial);
  const [loading, setLoading] = useState(false);
  /** `"<providerId>:<action>"`, so only the pressed button spins. */
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: FormMode; row?: AdminProviderRow } | null>(null);
  const [proxyFor, setProxyFor] = useState<AdminProviderRow | null>(null);
  const [removing, setRemoving] = useState<AdminProviderRow | null>(null);
  const [tests, setTests] = useState<Record<string, ProviderTestResult>>({});

  const configured = providers.filter((provider) => provider.configured);
  const custom = providers.filter((provider) => provider.custom);

  const isBusy = (id: string, action: string) => busy === `${id}:${action}`;
  const rowBusy = (id: string) => busy?.startsWith(`${id}:`) ?? false;

  async function reread() {
    setLoading(true);
    try {
      const next = await api.get<{ providers: AdminProviderRow[] }>("/api/admin/providers");
      setProviders(next.providers);
      setTests({});
      toast.success("Status re-read", `${next.providers.length} providers`);
    } catch (error) {
      toast.error(
        "Could not read provider status",
        failureText(error, "Please try again."),
      );
    } finally {
      setLoading(false);
    }
  }

  /** Model counts move when a sync lands; a failed refresh leaves them stale, nothing worse. */
  async function refreshQuietly() {
    try {
      const next = await api.get<{ providers: AdminProviderRow[] }>("/api/admin/providers");
      setProviders(next.providers);
    } catch {
      /* The operation's own toast already reported what happened. */
    }
  }

  /**
   * Registers a new upstream. Returns the failure so the dialog can show it inline (including
   * per-field detail from the API) instead of closing over an error the operator cannot fix.
   */
  async function create(payload: Record<string, unknown>): Promise<SubmitError | null> {
    const label = String(payload.label ?? "Provider");
    try {
      const next = await api.post<{ providers: AdminProviderRow[]; sync?: SyncSummary }>(
        "/api/admin/providers",
        payload,
      );
      setProviders(next.providers);
      setForm(null);

      const summary = next.sync;
      if (!summary) {
        toast.success(`${label} added`, "Press “Sync models” to load its catalogue.");
      } else {
        const failed = summary.results.filter((entry) => entry.error);
        if (failed.length > 0) {
          toast.error(
            `${label} added, catalogue not loaded`,
            failed[0]?.error ?? "The upstream did not answer /models.",
          );
        } else {
          toast.success(
            `${label} added`,
            `${formatNumber(summary.created)} models imported, ${formatNumber(summary.updated)} refreshed.`,
          );
        }
      }
      return null;
    } catch (error) {
      return submitError(error, "Could not add the provider.");
    }
  }

  /** Shared by the edit dialog, the rotate dialog and the inline enable/disable button. */
  async function patchProvider(
    row: AdminProviderRow,
    patch: Record<string, unknown>,
    action: string,
  ): Promise<SubmitError | null> {
    if (!row.configId) {
      return {
        message: `${row.label} has no stored settings row, so there is nothing to edit here.`,
        fields: {},
      };
    }
    setBusy(`${row.id}:${action}`);
    try {
      const next = await api.patch<{ providers: AdminProviderRow[] }>(
        `/api/admin/providers/${row.configId}`,
        patch,
      );
      setProviders(next.providers);
      return null;
    } catch (error) {
      return submitError(error, "Could not update the provider.");
    } finally {
      setBusy(null);
    }
  }

  async function submitEdit(
    row: AdminProviderRow,
    payload: Record<string, unknown>,
    mode: FormMode,
  ): Promise<SubmitError | null> {
    const problem = await patchProvider(row, payload, mode === "rotate" ? "rotate" : "edit");
    if (problem) return problem;
    setForm(null);
    toast.success(
      mode === "rotate" ? "Credential rotated" : "Provider updated",
      mode === "rotate"
        ? `${row.label} will use the new key on its next request.`
        : row.label,
    );
    return null;
  }

  async function toggle(row: AdminProviderRow) {
    const next = !row.dbEnabled;
    const problem = await patchProvider(row, { enabled: next }, "toggle");
    if (problem) {
      toast.error("Could not update the provider", problem.message);
      return;
    }
    toast.success(
      next ? "Provider enabled" : "Provider disabled",
      next
        ? `${row.label} is routable again.`
        : `${row.label} stops serving new requests. Its models stay in the catalogue.`,
    );
  }

  async function remove() {
    if (!removing?.configId) return;
    const row = removing;
    setBusy(`${row.id}:delete`);
    try {
      const next = await api.delete<{ providers: AdminProviderRow[] }>(
        `/api/admin/providers/${row.configId}`,
      );
      setProviders(next.providers);
      setRemoving(null);
      toast.success("Provider removed", `${row.label} is no longer registered.`);
    } catch (error) {
      toast.error("Could not remove the provider", failureText(error, "Please try again."));
    } finally {
      setBusy(null);
    }
  }

  /** Live probe with the credential already stored. Writes nothing, so it is safe to repeat. */
  async function test(row: AdminProviderRow) {
    setBusy(`${row.id}:test`);
    try {
      const result = await api.post<ProviderTestResult>("/api/admin/providers/test", {
        provider: row.id,
      });
      setTests((prev) => ({ ...prev, [row.id]: result }));
      if (result.error) {
        toast.error(`${row.label} answered with an error`, result.error);
      } else if (result.models !== undefined) {
        toast.success(`${row.label} reachable`, `${formatNumber(result.models)} models on offer.`);
      } else {
        toast.success(`${row.label} probed`, result.health.detail);
      }
    } catch (error) {
      toast.error("Probe failed", failureText(error, "Please try again."));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Replaces one upstream's outbound proxy list. The whole list is sent, because that is what the
   * PUT means — an empty body returns the provider to direct egress rather than leaving the old
   * list in place. Lines the server could not use come back in `rejected` and are shown in the
   * dialog: a paste of twenty proxies with one SOCKS entry saves the other nineteen, and the
   * operator needs to see which one was dropped.
   */
  async function saveProxies(row: AdminProviderRow, raw: string): Promise<ProxySaveResult | null> {
    setBusy(`${row.id}:proxy`);
    try {
      const result = await api.put<ProxySaveResult>("/api/admin/providers/proxy", {
        provider: row.id,
        proxies: raw,
      });
      setProviders(result.providers);
      toast.success(
        result.accepted === 0 ? "Proxies cleared" : "Proxy list saved",
        result.accepted === 0
          ? `${row.label} calls the upstream directly again.`
          : `${row.label} now rotates through ${formatNumber(result.accepted)} ${result.accepted === 1 ? "proxy" : "proxies"}.`,
      );
      return result;
    } catch (error) {
      toast.error("Could not save the proxy list", failureText(error, "Please try again."));
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Targeted catalogue pull — the same endpoint the models table uses, scoped to one provider. */
  async function sync(row: AdminProviderRow) {    setBusy(`${row.id}:sync`);
    try {
      const next = await api.post<{ summary: SyncSummary }>("/api/admin/models/sync", {
        providers: [row.id],
      });
      const entry = next.summary.results[0];
      if (!entry) {
        toast.error(
          "Nothing to sync",
          `${row.label} is not routable right now, so its catalogue was not read.`,
        );
      } else if (entry.error) {
        toast.error(`${row.label} could not be read`, entry.error);
      } else {
        const stale = entry.stale.length > 0 ? `, ${formatNumber(entry.stale.length)} no longer offered` : "";
        toast.success(
          `${row.label} synced`,
          `${formatNumber(entry.created)} new, ${formatNumber(entry.updated)} refreshed${stale}.`,
        );
      }
      await refreshQuietly();
    } catch (error) {
      toast.error("Sync failed", failureText(error, "Please try again."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Upstream providers"
          description={`${configured.length} of ${providers.length} have a working credential · ${custom.length} added from this page. Requests are routed by each model's provider column.`}
          action={
            <>
              <Button variant="secondary" size="sm" loading={loading} onClick={() => void reread()}>
                Re-read
              </Button>
              <Button variant="primary" size="sm" onClick={() => setForm({ mode: "create" })}>
                Add provider
              </Button>
            </>
          }
        />
        <CardBody className="space-y-3">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              test={tests[provider.id]}
              busy={rowBusy(provider.id)}
              isBusy={isBusy}
              onTest={() => void test(provider)}
              onSync={() => void sync(provider)}
              onEdit={() => setForm({ mode: "edit", row: provider })}
              onRotate={() => setForm({ mode: "rotate", row: provider })}
              onProxies={() => setProxyFor(provider)}
              onToggle={() => void toggle(provider)}
              onDelete={() => setRemoving(provider)}
            />
          ))}
          <FootNote />
        </CardBody>
      </Card>

      {form ? (
        <ProviderDialog
          mode={form.mode}
          row={form.row}
          onClose={() => setForm(null)}
          onSubmit={(payload) =>
            form.row ? submitEdit(form.row, payload, form.mode) : create(payload)
          }
        />
      ) : null}

      {proxyFor ? (
        <ProxyDialog
          // Looked up rather than held: a save that drops a line keeps this dialog open, and a
          // snapshot taken when the button was pressed would go on reporting the pre-save list.
          row={providers.find((entry) => entry.id === proxyFor.id) ?? proxyFor}
          saving={isBusy(proxyFor.id, "proxy")}
          onClose={() => setProxyFor(null)}
          onSubmit={(raw) => saveProxies(proxyFor, raw)}
        />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
        loading={removing ? isBusy(removing.id, "delete") : false}
        title="Remove this provider?"
        confirmLabel="Remove provider"
        confirmPhrase={removing?.id}
        message={
          removing ? (
            <>
              <p>
                <span className="text-ink">{removing.label}</span> is unregistered and its sealed
                credential is deleted. Nothing else is touched: usage rows and audit history keep
                referring to it by id.
              </p>
              <p className="mt-2">
                {removing.models > 0
                  ? `It still has ${formatNumber(removing.models)} model${removing.models === 1 ? "" : "s"} in the catalogue, so this will be refused — delete those models first, or disable the provider instead.`
                  : "This cannot be undone; you would have to add the provider and its key again."}
              </p>
            </>
          ) : null
        }
      />
    </>
  );
}

/**
 * One provider row: what it is, whether it can serve traffic, and every action available on it.
 *
 * The action set differs by kind on purpose. A builtin exposes Test and Sync (both read-only
 * against our own state) and Edit only when it has a stored row to edit; its credential is not
 * offered because it comes from the environment. A custom provider adds Rotate key,
 * Enable/Disable and Delete. Proxies are offered on both: egress is a transport setting that
 * applies to a builtin's environment-held key just as much as to a stored one.
 */
function ProviderCard({
  provider,
  test,
  busy,
  isBusy,
  onTest,
  onSync,
  onEdit,
  onRotate,
  onProxies,
  onToggle,
  onDelete,
}: {
  provider: AdminProviderRow;
  test: ProviderTestResult | undefined;
  busy: boolean;
  isBusy: (id: string, action: string) => boolean;
  onTest: () => void;
  onSync: () => void;
  onEdit: () => void;
  onRotate: () => void;
  onProxies: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const health = HEALTH[provider.health.state] ?? HEALTH.unconfigured!;
  const live = provider.configured && provider.dbEnabled;
  const syncBlocked = !live
    ? provider.dbEnabled
      ? "Add a credential before pulling its catalogue."
      : "Enable the provider before pulling its catalogue."
    : undefined;

  return (
    <article
      className={cn(
        "rounded-xl border border-line p-4",
        live ? "bg-raised/40" : "bg-transparent",
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
            {provider.label}
            <code className="numeric text-[11px] font-normal text-ink-faint">{provider.id}</code>
            <Badge tone={provider.custom ? "sky" : "neutral"}>
              {provider.custom ? "Custom" : "Built-in"}
            </Badge>
            <Badge tone="violet">{kindLabel(provider.kind)}</Badge>
          </h3>
          <p className="mt-1 text-[11px] text-ink-faint">
            {formatNumber(provider.models)} {provider.models === 1 ? "model" : "models"} in the
            catalogue
            {provider.dbEnabled ? "" : " · disabled, not routable"}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge tone={health.tone} dot>
            {health.label}
          </Badge>
          {provider.health.latencyMs === undefined ? null : (
            <span className="numeric text-[11px] text-ink-faint">
              {formatLatency(provider.health.latencyMs)}
            </span>
          )}
        </div>
      </header>

      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="text-[11px] tracking-wide text-ink-faint uppercase">
            {provider.custom ? "Stored key" : "Credential variable"}
          </dt>
          <dd className="numeric mt-0.5 flex items-center gap-2 text-xs text-ink">
            {provider.custom
              ? provider.apiKeyHint || "not set"
              : provider.credentialEnvVar || "none"}
            <Badge tone={provider.configured ? "brand" : "amber"}>
              {provider.configured ? "set" : "missing"}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="text-[11px] tracking-wide text-ink-faint uppercase">Base URL</dt>
          <dd className="numeric mt-0.5 truncate text-xs text-ink">
            {provider.baseUrl ?? "provider default"}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[11px] tracking-wide text-ink-faint uppercase">Egress</dt>
          <dd className="numeric mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink">
            {provider.proxies === 0 ? (
              <span className="text-ink-muted">direct — this deployment&rsquo;s own IP</span>
            ) : (
              <>
                <Badge tone="sky">
                  {provider.proxies === 1 ? "1 proxy" : `${provider.proxies} proxies`}
                </Badge>
                <span className="truncate text-ink-muted">{provider.proxyHint}</span>
              </>
            )}
          </dd>
        </div>
      </dl>

      <p className="mt-2.5 text-[11px] leading-relaxed text-ink-muted">
        {provider.health.detail}
        {provider.notes ? ` — ${provider.notes}` : ""}
      </p>

      {test ? <TestReport result={test} /> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button
          variant="secondary"
          size="sm"
          loading={isBusy(provider.id, "test")}
          disabled={busy}
          onClick={onTest}
        >
          Test
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={isBusy(provider.id, "sync")}
          disabled={busy || !live}
          {...(syncBlocked ? { title: syncBlocked } : {})}
          onClick={onSync}
        >
          Sync models
        </Button>
        {provider.configId ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onEdit}>
            Edit
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          loading={isBusy(provider.id, "proxy")}
          disabled={busy}
          onClick={onProxies}
        >
          {provider.proxies === 0 ? "Proxies" : `Proxies (${provider.proxies})`}
        </Button>
        {provider.custom ? (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onRotate}>
              Rotate key
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={isBusy(provider.id, "toggle")}
              disabled={busy}
              onClick={onToggle}
            >
              {provider.dbEnabled ? "Disable" : "Enable"}
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={onDelete}>
              Delete
            </Button>
          </>
        ) : (
          <span className="text-[11px] text-ink-faint">
            Built-in — its key comes from{" "}
            <span className="numeric">{provider.credentialEnvVar || "the environment"}</span>.
          </span>
        )}
      </div>
    </article>
  );
}

/**
 * Result of the last probe of this provider. Kept on screen rather than left in a toast: the
 * sample of model ids is how an operator confirms the URL points at the upstream they meant,
 * and that is worth reading twice.
 */
function TestReport({ result }: { result: ProviderTestResult }) {
  const health = HEALTH[result.health.state] ?? HEALTH.unconfigured!;
  const sample = result.sample ?? [];
  return (
    <div className="mt-3 rounded-lg border border-line bg-canvas/60 p-3">
      <p className="text-[11px] tracking-wide text-ink-faint uppercase">Last probe</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <Badge tone={health.tone} dot>
          {health.label}
        </Badge>
        <span className="leading-relaxed">{result.health.detail}</span>
        {result.health.latencyMs === undefined ? null : (
          <span className="numeric text-[11px] text-ink-faint">
            {formatLatency(result.health.latencyMs)}
          </span>
        )}
      </div>
      {result.error ? <p className="mt-1.5 text-xs leading-relaxed text-rose">{result.error}</p> : null}
      {result.models === undefined ? null : (
        <p className="numeric mt-1.5 text-[11px] leading-relaxed break-all text-ink-faint">
          {formatNumber(result.models)} models offered
          {sample.length > 0
            ? ` · ${sample.join(", ")}${result.models > sample.length ? " …" : ""}`
            : ""}
        </p>
      )}
    </div>
  );
}

/**
 * Outbound proxy list for one upstream.
 *
 * The textarea holds the whole list, not an addition to it: PUT replaces what is stored, and an
 * empty box returns the provider to direct egress. That is the honest shape for a rotating pool —
 * a per-entry add/remove UI would imply stable identities the stored value does not have.
 *
 * A stored list is never sent back to the browser, so the box always starts empty and the current
 * state is shown above it as a redacted hint. That is deliberate: a proxy URL usually carries
 * `user:password`, which makes it a credential, and the one rule this project does not bend is
 * that credentials do not travel to the client. The consequence is worth stating in the UI —
 * saving replaces the list, so a partial edit means re-pasting all of it.
 *
 * Parsing runs locally with the same function the server uses, so the count and the rejected
 * lines shown here match what a save would do. The server parses again and stays the enforcement
 * point.
 */
function ProxyDialog({
  row,
  saving,
  onClose,
  onSubmit,
}: {
  row: AdminProviderRow;
  saving: boolean;
  onClose: () => void;
  onSubmit: (raw: string) => Promise<ProxySaveResult | null>;
}) {
  const [raw, setRaw] = useState("");
  const [result, setResult] = useState<ProxySaveResult | null>(null);

  const preview = parseProxyList(raw);
  const clearing = raw.trim().length === 0;
  // The server refuses a list where every line failed, rather than silently saving nothing.
  const allRejected = !clearing && preview.proxies.length === 0;

  async function submit() {
    const saved = await onSubmit(raw);
    if (!saved) return;
    setResult(saved);
    // Kept open when something was dropped: the rejected lines are the point of pressing save.
    if (saved.rejected.length === 0) onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Egress for ${row.label}`}
      description="Route this upstream's calls through forward proxies instead of the deployment's own IP."
      size="md"
      closeOnBackdrop={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant={clearing ? "danger" : "primary"}
            loading={saving}
            disabled={allRejected}
            onClick={() => void submit()}
          >
            {clearing ? "Clear proxies" : `Save ${preview.proxies.length}`}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg border border-line bg-canvas/60 p-3 text-xs leading-relaxed">
          <p className="text-[11px] tracking-wide text-ink-faint uppercase">Currently stored</p>
          <p className="numeric mt-1 break-all text-ink">
            {row.proxies === 0
              ? "Nothing — calls leave from this deployment's IP."
              : `${formatNumber(row.proxies)} ${row.proxies === 1 ? "proxy" : "proxies"} · ${row.proxyHint}`}
          </p>
        </div>

        <Field
          label="Proxy list"
          htmlFor="proxy-list"
          help={`One per line, or comma-separated. http:// and https:// only — SOCKS cannot be dispatched. Up to ${MAX_PROXIES_PER_PROVIDER}. Lines starting with # are ignored.`}
        >
          <Textarea
            id="proxy-list"
            rows={6}
            spellCheck={false}
            value={raw}
            placeholder={"http://user:pass@1.2.3.4:8080\nhttp://user:pass@5.6.7.8:8080"}
            onChange={(event) => {
              setRaw(event.target.value);
              setResult(null);
            }}
          />
        </Field>

        {preview.proxies.length > 0 ? (
          <div className="rounded-lg border border-line bg-canvas/60 p-3">
            <p className="text-[11px] tracking-wide text-ink-faint uppercase">
              Will be saved ({preview.proxies.length})
            </p>
            <ul className="numeric mt-1 space-y-0.5 text-[11px] break-all text-ink-muted">
              {preview.proxies.map((proxy) => (
                <li key={proxy.url}>{proxy.origin}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {preview.errors.length > 0 ? (
          <div className="rounded-lg border border-amber/35 bg-amber/10 p-3">
            <p className="text-[11px] tracking-wide text-amber uppercase">
              {allRejected ? "Nothing usable in that list" : "Will be skipped"}
            </p>
            <ul className="mt-1 space-y-0.5 text-xs leading-relaxed break-all text-amber">
              {preview.errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {result && result.rejected.length > 0 ? (
          <p className="rounded-lg border border-line bg-raised/40 px-3 py-2 text-xs leading-relaxed text-ink-muted">
            Saved {formatNumber(result.accepted)}{" "}
            {result.accepted === 1 ? "proxy" : "proxies"}; {result.rejected.length} line
            {result.rejected.length === 1 ? "" : "s"} could not be used. Close when you have read
            the reasons above.
          </p>
        ) : null}

        {clearing && row.proxies > 0 ? (
          <p className="rounded-lg border border-rose/35 bg-rose/10 px-3 py-2 text-xs leading-relaxed text-rose">
            Saving an empty list deletes the stored proxies and returns {row.label} to direct
            egress.
          </p>
        ) : null}

        <p className="text-[11px] leading-relaxed text-ink-faint">
          Proxies spread traffic across several egress IPs, which helps when an upstream limits{" "}
          <em>per IP</em> or allowlists addresses. If its limit is per account, they change nothing
          — and rotating IPs specifically to get around a published limit may breach that
          provider&rsquo;s terms. For capacity, the durable fix is a fallback chain on the model
          plus more upstream accounts. The list is encrypted at rest like a credential, and only
          the redacted hint above ever comes back.
        </p>
      </div>
    </Modal>
  );
}

function FootNote() {
  return (
    <p className="text-[11px] leading-relaxed text-ink-faint">
      Credential values are never sent to this page — a stored key is shown only as its last four
      characters. Keys added here are encrypted at rest with{" "}
      <span className="numeric text-ink-muted">PROVIDER_CREDENTIAL_KEY</span> (or a key derived
      from <span className="numeric text-ink-muted">SESSION_SECRET</span> when that is unset), so
      changing either one means re-entering them. A built-in provider reads its key from the
      environment and needs a restart to pick up a change; a model whose provider has no working
      credential fails with{" "}
      <span className="numeric text-ink-muted">503 provider_unconfigured</span> instead of
      silently returning something fabricated.
    </p>
  );
}

/** Mirrors `providerSlug` in the API schema, so the suggestion is always a value the API takes. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/** Same rule as `providerBaseUrl`: https everywhere, http only on loopback. */
function baseUrlOk(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function jsonObjectOk(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

const TITLES: Record<FormMode, string> = {
  create: "Add a provider",
  edit: "Edit provider",
  rotate: "Rotate credential",
};

/**
 * Add / edit / rotate, in one dialog with three shapes.
 *
 * The slug is only editable while creating: it prefixes every catalogue id
 * (`<slug>/<model>`), so renaming it later would orphan every model row — the API has no field
 * for it either. The credential is write-only in all three modes; `edit` does not render the
 * field at all, which is what makes "fix the label without knowing the key" possible.
 *
 * Validation here mirrors the server schema so mistakes are caught before a round trip, but it
 * is not the enforcement point: the API validates again, and its per-field messages are merged
 * into the same slots.
 */
function ProviderDialog({
  mode,
  row,
  onClose,
  onSubmit,
}: {
  mode: FormMode;
  row: AdminProviderRow | undefined;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<SubmitError | null>;
}) {
  const [kind, setKind] = useState(row?.kind ?? "openai");
  const [label, setLabel] = useState(row?.label ?? "");
  const [slug, setSlug] = useState(row?.id ?? "");
  const [slugPinned, setSlugPinned] = useState(mode !== "create");
  const [baseUrl, setBaseUrl] = useState(row?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [extraHeaders, setExtraHeaders] = useState(row?.extraHeaders ?? "");
  const [notes, setNotes] = useState(row?.notes ?? "");
  const [enabled, setEnabled] = useState(row?.dbEnabled ?? true);
  const [syncModels, setSyncModels] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SubmitError | null>(null);

  const dialect = KINDS.find((entry) => entry.id === kind) ?? KINDS[0];
  const fieldError = (name: string) => error?.fields[name];

  function validate(): Record<string, string> {
    const problems: Record<string, string> = {};
    if (mode !== "rotate") {
      if (label.trim().length < 2) problems.label = "Give the provider a display name.";
      if (mode === "create") {
        const value = slug.trim();
        if (value.length < 2 || value.length > 32) {
          problems.provider = "Between 2 and 32 characters.";
        } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
          problems.provider = "Lowercase letters, digits and single dashes only.";
        }
      }
      if (!baseUrlOk(baseUrl)) {
        problems.baseUrl = "Absolute https:// URL (http:// is allowed only for localhost).";
      }
      if (extraHeaders.trim().length > 0 && !jsonObjectOk(extraHeaders.trim())) {
        problems.extraHeaders = 'Must be a JSON object, e.g. {"x-source":"relayn"}.';
      }
    }
    // `edit` never sends a credential, so it never checks one.
    if (mode !== "edit" && apiKey.trim().length < 8) {
      problems.apiKey = "That key looks too short.";
    }
    return problems;
  }

  function payload(): Record<string, unknown> {
    if (mode === "rotate") return { apiKey: apiKey.trim() };
    const common = {
      label: label.trim(),
      kind,
      baseUrl: baseUrl.trim(),
      extraHeaders: extraHeaders.trim(),
      notes: notes.trim(),
      enabled,
    };
    if (mode === "create") {
      return { ...common, provider: slug.trim(), apiKey: apiKey.trim(), syncModels };
    }
    return common;
  }

  async function submit() {
    const problems = validate();
    if (Object.keys(problems).length > 0) {
      setError({ message: "Some fields need attention.", fields: problems });
      return;
    }
    setSaving(true);
    setError(null);
    const failed = await onSubmit(payload());
    // On success the parent closes this dialog, so the button keeps its spinner until unmount.
    if (failed) {
      setError(failed);
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={TITLES[mode]}
      description={
        mode === "create"
          ? "Any OpenAI-compatible or Anthropic-compatible endpoint. The key is encrypted before it is stored and is never sent back to this page."
          : row?.id
      }
      size="md"
      closeOnBackdrop={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {mode === "create" ? "Add provider" : mode === "rotate" ? "Replace key" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? (
          <p role="alert" className="rounded-lg border border-rose/35 bg-rose/10 px-3 py-2 text-xs leading-relaxed text-rose">
            {error.message}
          </p>
        ) : null}

        {mode === "rotate" ? (
          <>
            <p className="text-xs leading-relaxed text-ink-muted">
              The stored key for <span className="text-ink">{row?.label}</span> is replaced
              immediately. The current one ends in{" "}
              <span className="numeric text-ink">{row?.apiKeyHint || "—"}</span> and cannot be read
              back, so paste the whole new key.
            </p>
            <Field
              label="New API key"
              htmlFor="provider-api-key"
              error={fieldError("apiKey")}
              help="Encrypted before it is stored. Requests already in flight finish on the old key."
            >
              <Input
                id="provider-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Upstream dialect"
              htmlFor="provider-kind"
              error={fieldError("kind")}
              help={dialect!.hint}
            >
              <Select
                id="provider-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                {KINDS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Display name"
                htmlFor="provider-label"
                error={fieldError("label")}
                help="Shown here and in the models table."
              >
                <Input
                  id="provider-label"
                  value={label}
                  placeholder="Jerouter"
                  onChange={(event) => {
                    setLabel(event.target.value);
                    if (mode === "create" && !slugPinned) setSlug(slugify(event.target.value));
                  }}
                />
              </Field>
              {mode === "create" ? (
                <Field
                  label="Provider id"
                  htmlFor="provider-slug"
                  error={fieldError("provider")}
                  help="Prefixes every model id, e.g. jerouter/gpt-4o-mini. Cannot be changed later."
                >
                  <Input
                    id="provider-slug"
                    value={slug}
                    placeholder="jerouter"
                    spellCheck={false}
                    onChange={(event) => {
                      setSlugPinned(true);
                      setSlug(event.target.value.trim().toLowerCase());
                    }}
                  />
                </Field>
              ) : (
                <Field label="Provider id" htmlFor="provider-slug-fixed" help="Immutable — catalogue ids are prefixed with it.">
                  <Input id="provider-slug-fixed" value={row?.id ?? ""} readOnly disabled />
                </Field>
              )}
            </div>

            <Field
              label="Base URL"
              htmlFor="provider-base-url"
              error={fieldError("baseUrl")}
              help={
                kind === "anthropic"
                  ? "Without a trailing slash. /messages and /models are appended to it."
                  : "Without a trailing slash. /chat/completions and /models are appended to it."
              }
            >
              <Input
                id="provider-base-url"
                inputMode="url"
                spellCheck={false}
                value={baseUrl}
                placeholder={dialect!.placeholder}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>

            {mode === "create" ? (
              <Field
                label="API key"
                htmlFor="provider-api-key"
                error={fieldError("apiKey")}
                help="Encrypted at rest and never returned to the browser — only its last four characters are shown afterwards."
              >
                <Input
                  id="provider-api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </Field>
            ) : row?.custom ? (
              <p className="text-[11px] leading-relaxed text-ink-faint">
                Stored key ends in{" "}
                <span className="numeric text-ink-muted">{row.apiKeyHint || "—"}</span>. Use “Rotate
                key” to replace it; editing here leaves it untouched.
              </p>
            ) : (
              <p className="text-[11px] leading-relaxed text-ink-faint">
                Built-in provider — its credential comes from{" "}
                <span className="numeric text-ink-muted">
                  {row?.credentialEnvVar || "the environment"}
                </span>{" "}
                and cannot be set here.
              </p>
            )}

            <Field
              label="Extra headers"
              htmlFor="provider-headers"
              error={fieldError("extraHeaders")}
              help='Optional JSON object, e.g. {"http-referer":"https://bandidoz.biz.id"}. Authorization, x-api-key, content-type and host are ignored — the adapter sets those.'
            >
              <Textarea
                id="provider-headers"
                rows={2}
                spellCheck={false}
                value={extraHeaders}
                placeholder="{}"
                onChange={(event) => setExtraHeaders(event.target.value)}
              />
            </Field>

            <Field
              label="Notes"
              htmlFor="provider-notes"
              error={fieldError("notes")}
              help="Internal only. Shown on this page, never to users."
            >
              <Input
                id="provider-notes"
                value={notes}
                placeholder="Reseller upstream, billed per token."
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>

            <div className="space-y-2 border-t border-line pt-3">
              <Checkbox
                id="provider-enabled"
                checked={enabled}
                label="Routable — the gateway may send requests to this provider"
                onChange={(event) => setEnabled(event.target.checked)}
              />
              {mode === "create" ? (
                <Checkbox
                  id="provider-sync"
                  checked={syncModels}
                  label="Load its model catalogue now (calls /models once)"
                  onChange={(event) => setSyncModels(event.target.checked)}
                />
              ) : null}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
