"use client";

/**
 * Catalogue editor.
 *
 * Every change is a `PATCH /api/admin/models/:id` that returns the whole refreshed catalogue,
 * so the table always shows stored rows rather than a local guess. Disabling a model takes
 * effect on the next gateway request — in-flight calls are not interrupted, and users keep
 * seeing it in `/models` only if their plan allows it, because that page filters on the same
 * `enabled` + `minPlan` columns this one writes.
 *
 * Rows arrive from two places. Sync pulls whatever each upstream lists; "Add model" writes one
 * by hand for a model an upstream serves but does not publish. A hand-added row is marked
 * `manual`, which stops the next sync from overwriting the id and prices typed here.
 *
 * Any row can be deleted, from either source. Deleting a synced one also records its id as
 * suppressed, because sync would otherwise list the upstream again and recreate it — that list is
 * rendered under the table so a deletion is visible and reversible rather than just a row that
 * vanished.
 */
import { useMemo, useState } from "react";
import type { BadgeTone } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { MODEL_CATEGORIES, MAX_FALLBACKS } from "@/lib/catalogue";
import {
  formatDateTime,
  formatLatency,
  formatLimit,
  formatNumber,
  formatPricePerMillion,
  titleCase,
} from "@/lib/format";
import { PLAN_ORDER, planOf } from "@/lib/plans";
import type {
  AdminModelRow,
  AdminProviderRow,
  ModelProbeResult,
  RemovedModelRow,
} from "@/server/services/admin-service";
import type { SyncSummary } from "@/server/services/model-sync-service";

const CATEGORY_TONES: Record<string, BadgeTone> = {
  chat: "brand",
  reasoning: "violet",
  coding: "sky",
  vision: "amber",
  embeddings: "neutral",
};

type ModelPatch = {
  enabled?: boolean;
  minPlan?: string;
  inputPrice?: number;
  outputPrice?: number;
  description?: string;
  sortOrder?: number;
  fallbacks?: string;
  upstreamModel?: string;
};

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

/** What every catalogue mutation returns: a delete moves a row from one list to the other. */
interface ModelsPayload {
  models: AdminModelRow[];
  removed: RemovedModelRow[];
}

export function AdminModels({
  initial,
  initialRemoved = [],
  providers = [],
}: {
  initial: AdminModelRow[];
  initialRemoved?: RemovedModelRow[];
  providers?: AdminProviderRow[];
}) {
  const toast = useToast();
  const [models, setModels] = useState(initial);
  const [removed, setRemoved] = useState(initialRemoved);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [provider, setProvider] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminModelRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AdminModelRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);

  const categories = useMemo(
    () => [...new Set(models.map((model) => model.category))].sort(),
    [models],
  );
  const providerIds = useMemo(
    () => [...new Set(models.map((model) => model.provider))].sort(),
    [models],
  );

  /** Providers a hand-added row may name. Routable only: an unusable one cannot be probed. */
  const addable = useMemo(
    () => providers.filter((row) => row.configured && row.dbEnabled),
    [providers],
  );

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return models.filter((model) => {
      if (category && model.category !== category) return false;
      if (provider && model.provider !== provider) return false;
      if (!term) return true;
      return (
        model.name.toLowerCase().includes(term) ||
        model.modelId.toLowerCase().includes(term) ||
        model.provider.toLowerCase().includes(term)
      );
    });
  }, [models, search, category, provider]);

  const enabled = models.filter((model) => model.enabled).length;

  /** Returns true on success so the editor knows whether to close. */
  async function applyPatch(row: AdminModelRow, patch: ModelPatch, note: string) {
    setSavingId(row.id);
    try {
      const next = await api.patch<{ models: AdminModelRow[] }>(
        `/api/admin/models/${row.id}`,
        patch,
      );
      setModels(next.models);
      toast.success(note, row.modelId);
      return true;
    } catch (error) {
      toast.error(
        "Could not update model",
        error instanceof ApiClientError ? error.message : "Please try again.",
      );
      return false;
    } finally {
      setSavingId(null);
    }
  }

  /**
   * Writes one hand-made row. The API probes the upstream first unless the operator switched
   * the test off, so a refusal here usually means the id is wrong rather than the form.
   */
  async function create(payload: Record<string, unknown>): Promise<SubmitError | null> {
    try {
      const next = await api.post<ModelsPayload & { probe?: ModelProbeResult }>(
        "/api/admin/models",
        payload,
      );
      setModels(next.models);
      setRemoved(next.removed);
      setAdding(false);
      toast.success(
        "Model added",
        next.probe?.ok
          ? `${payload.modelId as string} answered in ${formatLatency(next.probe.latencyMs)}.`
          : `${payload.modelId as string} is in the catalogue.`,
      );
      return null;
    } catch (error) {
      return submitError(error, "Could not add the model.");
    }
  }

  /**
   * Deletes a catalogue row. A synced id is also recorded as suppressed server-side, which is the
   * only reason deleting one sticks; the toast says which of the two happened, because "deleted"
   * alone would not explain why the id then appears in the removed list below.
   */
  async function remove() {
    if (!removing) return;
    const row = removing;
    setDeleting(true);
    try {
      const next = await api.delete<ModelsPayload>(`/api/admin/models/${row.id}`);
      setModels(next.models);
      setRemoved(next.removed);
      setRemoving(null);
      toast.success(
        "Model deleted",
        row.manual
          ? `${row.modelId} is no longer in the catalogue.`
          : `${row.modelId} is gone and will stay gone — sync will skip it from now on.`,
      );
    } catch (error) {
      toast.error(
        "Could not delete model",
        error instanceof ApiClientError ? error.message : "Please try again.",
      );
    } finally {
      setDeleting(false);
    }
  }

  /**
   * Lifts a suppression. Does not put the row back by itself — the model returns on the next sync
   * with the upstream's current prices, which is the only place those numbers are trustworthy.
   */
  async function restore(row: RemovedModelRow) {
    setRestoringId(row.id);
    try {
      const next = await api.delete<ModelsPayload>(`/api/admin/models/removed/${row.id}`);
      setModels(next.models);
      setRemoved(next.removed);
      toast.success("Model no longer suppressed", `Run a sync to pull ${row.modelId} back in.`);
    } catch (error) {
      toast.error(
        "Could not restore model",
        error instanceof ApiClientError ? error.message : "Please try again.",
      );
    } finally {
      setRestoringId(null);
    }
  }

  /**
   * Pulls each configured upstream's `/models` into the catalogue. Deliberately manual: an
   * aggregator can add or drop a dozen models overnight, and an operator should be the one
   * deciding when that lands. Rows the upstream no longer lists are reported, not disabled.
   */
  async function runSync() {
    setSyncing(true);
    try {
      const next = await api.post<ModelsPayload & { summary: SyncSummary }>(
        "/api/admin/models/sync",
      );
      setModels(next.models);
      setRemoved(next.removed);
      setLastSync(next.summary);
      const failed = next.summary.results.filter((entry) => entry.error);
      const detail = `${formatNumber(next.summary.created)} new, ${formatNumber(next.summary.updated)} refreshed`;
      if (failed.length > 0) {
        toast.error(
          "Some providers could not be reached",
          `${detail}. Failed: ${failed.map((entry) => entry.label).join(", ")}.`,
        );
      } else {
        toast.success("Catalogue synced", detail);
      }
    } catch (error) {
      toast.error(
        "Sync failed",
        error instanceof ApiClientError ? error.message : "Please try again.",
      );
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Model catalogue"
          description={`${formatNumber(enabled)} of ${formatNumber(models.length)} models are callable. Disabled entries stay in the database and keep their usage history.`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={search}
                placeholder="Search name or id…"
                aria-label="Search models"
                className="h-8 w-48 text-xs"
                onChange={(event) => setSearch(event.target.value)}
              />
              <Select
                value={category}
                aria-label="Filter by category"
                className="h-8 w-auto text-xs"
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">All categories</option>
                {categories.map((value) => (
                  <option key={value} value={value}>
                    {titleCase(value)}
                  </option>
                ))}
              </Select>
              <Select
                value={provider}
                aria-label="Filter by provider"
                className="h-8 w-auto text-xs"
                onChange={(event) => setProvider(event.target.value)}
              >
                <option value="">All providers</option>
                {providerIds.map((value) => (
                  <option key={value} value={value}>
                    {titleCase(value)}
                  </option>
                ))}
              </Select>
              <Button variant="secondary" size="sm" loading={syncing} onClick={() => void runSync()}>
                Sync from providers
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={addable.length === 0}
                {...(addable.length === 0
                  ? { title: "Register a provider with a working credential first." }
                  : {})}
                onClick={() => setAdding(true)}
              >
                Add model
              </Button>
            </div>
          }
        />
        {lastSync ? <SyncReport summary={lastSync} /> : null}
        {models.length === 0 ? (
          <EmptyState
            title="The catalogue is empty"
            description="Run the seed script to load the starter model list, use “Sync from providers” to pull whatever the configured upstreams currently serve, or add one model by hand."
          />
        ) : rows.length === 0 ? (
          <EmptyState title="No models match" description="Clear the search or filters." />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Model</Th>
                <Th>Category</Th>
                <Th>Min plan</Th>
                <Th align="right">Input</Th>
                <Th align="right">Output</Th>
                <Th align="right">Context</Th>
                <Th align="right">Requests</Th>
                <Th align="right">State</Th>
                <Th align="right">Edit</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const busy = savingId === row.id;
                return (
                  <Tr key={row.id} className={cn(!row.enabled && "opacity-70")}>
                    <Td>
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate text-ink">
                          {row.name}
                          {row.manual ? <Badge tone="sky">Manual</Badge> : null}
                          {row.fallbacks.length > 0 ? (
                            <Badge tone="violet">
                              {row.fallbacks.length === 1
                                ? "1 fallback"
                                : `${row.fallbacks.length} fallbacks`}
                            </Badge>
                          ) : null}
                        </p>
                        <p className="numeric truncate text-[11px] text-ink-faint">
                          {row.modelId} · {titleCase(row.provider)}
                          {row.upstreamModel ? ` → ${row.upstreamModel}` : ""}
                        </p>
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={CATEGORY_TONES[row.category] ?? "neutral"}>
                        {titleCase(row.category)}
                      </Badge>
                    </Td>
                    <Td>
                      <Select
                        value={row.minPlan}
                        aria-label={`Minimum plan for ${row.modelId}`}
                        className="h-7 w-auto text-[11px]"
                        disabled={busy}
                        onChange={(event) =>
                          void applyPatch(row, { minPlan: event.target.value }, "Tier changed")
                        }
                      >
                        {PLAN_ORDER.map((id) => (
                          <option key={id} value={id}>
                            {planOf(id).name}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td align="right" className="numeric">
                      {formatPricePerMillion(row.inputPrice)}
                    </Td>
                    <Td align="right" className="numeric">
                      {formatPricePerMillion(row.outputPrice)}
                    </Td>
                    <Td align="right" className="numeric">
                      {formatLimit(row.contextWindow)}
                    </Td>
                    <Td align="right" className="numeric">
                      {formatNumber(row.requests)}
                    </Td>
                    <Td align="right">
                      <Button
                        variant={row.enabled ? "secondary" : "primary"}
                        size="sm"
                        loading={busy}
                        onClick={() =>
                          void applyPatch(
                            row,
                            { enabled: !row.enabled },
                            row.enabled ? "Model disabled" : "Model enabled",
                          )
                        }
                      >
                        {row.enabled ? "Disable" : "Enable"}
                      </Button>
                    </Td>
                    <Td align="right">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(row)}>
                        Details
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {removed.length > 0 ? (
        <RemovedModels
          rows={removed}
          restoringId={restoringId}
          onRestore={(row) => void restore(row)}
        />
      ) : null}

      {editing ? (
        <ModelEditor
          row={editing}
          models={models}
          saving={savingId === editing.id}
          onClose={() => setEditing(null)}
          onDelete={() => {
            setRemoving(editing);
            setEditing(null);
          }}
          onSave={async (patch) => {
            const done = await applyPatch(editing, patch, "Model updated");
            if (done) setEditing(null);
          }}
        />
      ) : null}

      {adding ? (
        <ModelCreator
          providers={addable}
          models={models}
          onClose={() => setAdding(false)}
          onSubmit={create}
        />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
        loading={deleting}
        title="Delete this model?"
        confirmLabel="Delete model"
        confirmPhrase={removing?.modelId}
        message={
          removing ? (
            <>
              <p>
                <span className="text-ink">{removing.modelId}</span> is removed from the catalogue
                and stops being callable immediately. Usage rows and audit history keep referring
                to it by id, so past reporting is unaffected.
              </p>
              <p className="mt-2">
                {removing.manual
                  ? "Hand-added, so this is final: sync never created it and will not bring it back."
                  : "It came from sync, so its id is remembered and skipped on future runs. It stays listed under “Removed from catalogue”, where one click puts it back in scope."}
              </p>
              {removing.requests > 0 ? (
                <p className="mt-2">
                  It has served {formatNumber(removing.requests)} request
                  {removing.requests === 1 ? "" : "s"}. Disabling it instead keeps it visible here
                  with its history in reach.
                </p>
              ) : null}
            </>
          ) : null
        }
      />
    </>
  );
}

/**
 * Ids an operator deleted that sync would otherwise recreate.
 *
 * Shown because a suppression is invisible everywhere else: the row is gone from the table, and
 * without this list the only symptom would be a model the upstream clearly offers never appearing.
 * Restoring lifts the block; it does not recreate the row, because the prices and context window
 * belong to the upstream and are re-read on the next sync.
 *
 * Absent entirely when nothing is suppressed — an empty panel would suggest an operator has
 * something to do here.
 */
function RemovedModels({
  rows,
  restoringId,
  onRestore,
}: {
  rows: RemovedModelRow[];
  restoringId: string | null;
  onRestore: (row: RemovedModelRow) => void;
}) {
  return (
    <Card>
      <CardHeader
        title="Removed from catalogue"
        description="Synced ids an admin deleted. Sync skips them, so they stay gone until restored — restoring lets the next sync fetch the model again with the upstream's current pricing."
      />
      <TableWrap>
        <thead>
          <tr>
            <Th>Model</Th>
            <Th>Provider</Th>
            <Th align="right">Removed</Th>
            <Th align="right">Restore</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td>
                <div className="min-w-0">
                  {row.name ? <p className="truncate text-ink">{row.name}</p> : null}
                  <p className="numeric truncate text-[11px] text-ink-faint">{row.modelId}</p>
                </div>
              </Td>
              <Td>{titleCase(row.provider)}</Td>
              <Td align="right" className="numeric text-[11px] text-ink-muted">
                {formatDateTime(row.removedAt)}
              </Td>
              <Td align="right">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={restoringId === row.id}
                  onClick={() => onRestore(row)}
                >
                  Restore
                </Button>
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableWrap>
    </Card>
  );
}

/**
 * What the last sync actually did, per provider. Worth showing rather than collapsing into a
 * toast: `stale` rows (in the catalogue, no longer offered upstream) are left enabled on
 * purpose, so an operator needs to see them to decide whether to disable them by hand.
 *
 * `preserved` counts hand-added rows the upstream also lists. Sync leaves those alone, so an
 * operator can see that the id and prices they typed were not quietly replaced. `suppressed`
 * counts ids the upstream offers that an admin deleted — reported so a model missing from the
 * catalogue on purpose does not read as a sync that lost it.
 */
function SyncReport({ summary }: { summary: SyncSummary }) {
  return (
    <div className="border-b border-line px-4 py-3 sm:px-5">
      <p className="text-[11px] tracking-wide text-ink-faint uppercase">Last sync</p>
      <ul className="mt-2 space-y-1.5">
        {summary.results.map((entry) => (
          <li key={entry.provider} className="text-xs leading-relaxed">
            <span className="text-ink">{entry.label}</span>{" "}
            {entry.error ? (
              <span className="text-rose">unreachable — {entry.error}</span>
            ) : (
              <span className="numeric text-ink-muted">
                {formatNumber(entry.discovered)} offered · {formatNumber(entry.created)} new ·{" "}
                {formatNumber(entry.updated)} refreshed
                {entry.preserved > 0
                  ? ` · ${formatNumber(entry.preserved)} hand-added, left as typed`
                  : ""}
                {entry.suppressed > 0
                  ? ` · ${formatNumber(entry.suppressed)} skipped, deleted here`
                  : ""}
                {entry.stale.length > 0
                  ? ` · ${formatNumber(entry.stale.length)} no longer offered: ${entry.stale.join(", ")}`
                  : ""}
              </span>
            )}
          </li>
        ))}
        {summary.skipped.length > 0 ? (
          <li className="text-xs text-ink-faint">
            Skipped (no credential configured): {summary.skipped.join(", ")}
          </li>
        ) : null}
        {summary.results.length === 0 && summary.skipped.length === 0 ? (
          <li className="text-xs text-ink-faint">
            No provider in the registry can list its catalogue.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * Pricing, copy and routing for one catalogue entry. Prices are USD per million tokens, the same
 * unit the gateway multiplies by to store `costMicroUsd` on each usage row — editing them changes
 * what future requests are metered at, never what is already recorded.
 *
 * The fallback chain is editable on synced rows too: pointing a rate-limited primary at a second
 * provider is the main reason to come here, and requiring a hand-made row for it would be
 * pointless friction.
 */
function ModelEditor({
  row,
  models,
  saving,
  onClose,
  onSave,
  onDelete,
}: {
  row: AdminModelRow;
  models: AdminModelRow[];
  saving: boolean;
  onClose: () => void;
  onSave: (patch: ModelPatch) => Promise<void>;
  onDelete?: (() => void) | undefined;
}) {
  const [description, setDescription] = useState(row.description);
  const [inputPrice, setInputPrice] = useState(String(row.inputPrice));
  const [outputPrice, setOutputPrice] = useState(String(row.outputPrice));
  const [sortOrder, setSortOrder] = useState(String(row.sortOrder));
  const [fallbacks, setFallbacks] = useState(row.fallbacks.join(", "));
  const [upstreamModel, setUpstreamModel] = useState(row.upstreamModel);

  const input = Number(inputPrice.trim());
  const output = Number(outputPrice.trim());
  const order = Number(sortOrder.trim());
  const priceBad = (value: number, raw: string) =>
    raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > 10_000;
  const inputBad = priceBad(input, inputPrice);
  const outputBad = priceBad(output, outputPrice);
  const orderBad =
    sortOrder.trim() === "" || !Number.isInteger(order) || order < 0 || order > 9999;
  const chain = chainProblem(fallbacks, row.modelId, models);
  const invalid = inputBad || outputBad || orderBad || chain !== undefined;

  const chainValue = normaliseChain(fallbacks);
  const patch: ModelPatch = {
    ...(description.trim() !== row.description ? { description: description.trim() } : {}),
    ...(!inputBad && input !== row.inputPrice ? { inputPrice: input } : {}),
    ...(!outputBad && output !== row.outputPrice ? { outputPrice: output } : {}),
    ...(!orderBad && order !== row.sortOrder ? { sortOrder: order } : {}),
    ...(chain === undefined && chainValue !== row.fallbacks.join(",")
      ? { fallbacks: chainValue }
      : {}),
    ...(upstreamModel.trim() !== row.upstreamModel
      ? { upstreamModel: upstreamModel.trim() }
      : {}),
  };
  const dirty = Object.keys(patch).length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={row.name}
      description={row.modelId}
      size="md"
      closeOnBackdrop={!saving}
      footer={
        <>
          {onDelete ? (
            <Button variant="danger" onClick={onDelete} disabled={saving} className="mr-auto">
              Delete
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!dirty || invalid}
            onClick={() => void onSave(patch)}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          {(
            [
              ["Provider", titleCase(row.provider)],
              ["Context", formatLimit(row.contextWindow)],
              ["Max output", formatLimit(row.maxOutputTokens)],
              ["Requests", formatNumber(row.requests)],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
              <dd className="numeric mt-0.5 text-xs text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        {row.capabilities.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {row.capabilities.map((capability) => (
              <li
                key={capability}
                className="rounded-md border border-line bg-raised/60 px-1.5 py-0.5 text-[10.5px] text-ink-faint"
              >
                {capability}
              </li>
            ))}
          </ul>
        ) : null}

        <Field
          label="Description"
          htmlFor="model-description"
          help="Shown on the user-facing catalogue card. 500 characters maximum."
        >
          <Textarea
            id="model-description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Input $/M"
            htmlFor="model-input-price"
            error={inputBad ? "0 – 10000" : undefined}
          >
            <Input
              id="model-input-price"
              inputMode="decimal"
              value={inputPrice}
              onChange={(event) => setInputPrice(event.target.value)}
            />
          </Field>
          <Field
            label="Output $/M"
            htmlFor="model-output-price"
            error={outputBad ? "0 – 10000" : undefined}
          >
            <Input
              id="model-output-price"
              inputMode="decimal"
              value={outputPrice}
              onChange={(event) => setOutputPrice(event.target.value)}
            />
          </Field>
          <Field
            label="Sort order"
            htmlFor="model-sort-order"
            error={orderBad ? "Whole number 0 – 9999" : undefined}
            help="Lower first."
          >
            <Input
              id="model-sort-order"
              inputMode="numeric"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </Field>
        </div>

        <Field
          label="Upstream id"
          htmlFor="model-upstream"
          help={`What Relayn sends on the wire. Leave empty when it is identical to ${row.modelId}.`}
        >
          <Input
            id="model-upstream"
            spellCheck={false}
            value={upstreamModel}
            placeholder={row.modelId}
            onChange={(event) => setUpstreamModel(event.target.value)}
          />
        </Field>

        <Field
          label="Fallback chain"
          htmlFor="model-fallbacks"
          error={chain}
          help={`Catalogue ids, in order, tried when this upstream rate-limits or errors. At most ${MAX_FALLBACKS}. Each one is re-checked against the caller's plan, so a cheaper model cannot leak a paid one.`}
        >
          <Input
            id="model-fallbacks"
            spellCheck={false}
            value={fallbacks}
            placeholder="madefaka/gpt-4o-mini, jerouter/gpt-4o-mini"
            onChange={(event) => setFallbacks(event.target.value)}
          />
        </Field>

        <p className="text-[11px] leading-relaxed text-ink-faint">
          Pricing is metered only — this build never charges anyone. Changes are written to the
          audit log as <span className="numeric text-ink-muted">admin.model_updated</span>. When a
          fallback answers instead of the primary, the request is billed and logged against the
          model that actually served it.
        </p>
      </div>
    </Modal>
  );
}

/** Canonical storage form: comma-separated, no spaces — matches `splitFallbacks` on the server. */
function normaliseChain(raw: string): string {
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(",");
}

/**
 * Mirrors the server's chain rules so a mistake is caught before a round trip. Not the
 * enforcement point — `assertFallbackChain` re-validates, including whether each id exists.
 */
function chainProblem(
  raw: string,
  modelId: string,
  models: AdminModelRow[],
): string | undefined {
  const entries = normaliseChain(raw).split(",").filter(Boolean);
  if (entries.length === 0) return undefined;
  if (entries.length > MAX_FALLBACKS) return `At most ${MAX_FALLBACKS} fallbacks.`;
  if (new Set(entries).size !== entries.length) return "The same fallback is listed twice.";
  if (entries.includes(modelId)) return "A model cannot fall back to itself.";
  const known = new Set(models.map((model) => model.modelId));
  const missing = entries.filter((entry) => !known.has(entry));
  if (missing.length > 0) return `Not in the catalogue: ${missing.join(", ")}.`;
  return undefined;
}

/**
 * Adds one catalogue row by hand.
 *
 * This exists for the case sync cannot cover: an upstream that serves a model it does not publish
 * in `/models`, or one an operator wants under a different public id. "Test" is the important
 * control — it asks the upstream for a single token from that exact id, so a typo is caught here
 * instead of by a paying caller. The same probe runs server-side before the row is written unless
 * the switch below is cleared.
 *
 * Prices default to 0. A guessed price would be metered against real users, so an unknown one is
 * recorded as free until someone fills it in.
 */
function ModelCreator({
  providers,
  models,
  onClose,
  onSubmit,
}: {
  providers: AdminProviderRow[];
  models: AdminModelRow[];
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<SubmitError | null>;
}) {
  const toast = useToast();
  const [provider, setProvider] = useState(providers[0]?.id ?? "");
  const [modelId, setModelId] = useState("");
  const [upstreamModel, setUpstreamModel] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("chat");
  const [description, setDescription] = useState("");
  const [inputPrice, setInputPrice] = useState("0");
  const [outputPrice, setOutputPrice] = useState("0");
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [minPlan, setMinPlan] = useState("free");
  const [fallbacks, setFallbacks] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [test, setTest] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ModelProbeResult | null>(null);
  const [error, setError] = useState<SubmitError | null>(null);

  const fieldError = (field: string) => error?.fields[field];
  /** The id actually sent upstream — what both the probe and the saved row will use. */
  const wireId = upstreamModel.trim() || modelId.trim();
  const chain = chainProblem(fallbacks, modelId.trim(), models);

  const numberBad = (raw: string) =>
    raw.trim() !== "" && (!Number.isInteger(Number(raw.trim())) || Number(raw.trim()) < 0);
  const priceBad = (raw: string) => {
    const value = Number(raw.trim());
    return raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > 10_000;
  };

  function validate(): Record<string, string> {
    const problems: Record<string, string> = {};
    if (!provider) problems.provider = "Choose a provider.";
    const id = modelId.trim();
    if (id.length === 0) problems.modelId = "Model id is required.";
    else if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)) {
      problems.modelId = "Letters, digits and . _ : / - only, starting with a letter or digit.";
    } else if (models.some((row) => row.modelId === id)) {
      problems.modelId = "That id is already in the catalogue.";
    }
    if (priceBad(inputPrice)) problems.inputPrice = "0 – 10000";
    if (priceBad(outputPrice)) problems.outputPrice = "0 – 10000";
    if (numberBad(contextWindow)) problems.contextWindow = "Whole number, or empty.";
    if (numberBad(maxOutputTokens)) problems.maxOutputTokens = "Whole number, or empty.";
    if (chain) problems.fallbacks = chain;
    return problems;
  }

  function payload(): Record<string, unknown> {
    const trimmedUpstream = upstreamModel.trim();
    const chainValue = normaliseChain(fallbacks);
    return {
      modelId: modelId.trim(),
      provider,
      ...(trimmedUpstream ? { upstreamModel: trimmedUpstream } : {}),
      ...(name.trim() ? { name: name.trim() } : {}),
      category,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(contextWindow.trim() ? { contextWindow: Number(contextWindow.trim()) } : {}),
      ...(maxOutputTokens.trim() ? { maxOutputTokens: Number(maxOutputTokens.trim()) } : {}),
      inputPrice: Number(inputPrice.trim()),
      outputPrice: Number(outputPrice.trim()),
      minPlan,
      enabled,
      ...(chainValue ? { fallbacks: chainValue } : {}),
      test,
    };
  }

  /** Probe only — writes nothing, so it is safe to press repeatedly while fixing an id. */
  async function runTest() {
    if (!provider || wireId.length === 0) {
      setError({
        message: "Choose a provider and enter a model id first.",
        fields: { modelId: wireId.length === 0 ? "Required before testing." : "" },
      });
      return;
    }
    setProbing(true);
    setError(null);
    try {
      const result = await api.post<ModelProbeResult>("/api/admin/models/test", {
        provider,
        model: wireId,
      });
      setProbe(result);
      if (result.ok) {
        toast.success(`${result.label} served ${result.model}`, formatLatency(result.latencyMs));
      } else {
        toast.error(`${result.label} refused ${result.model}`, result.error ?? "No detail given.");
      }
    } catch (failed) {
      setError(submitError(failed, "The probe could not be run."));
    } finally {
      setProbing(false);
    }
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
      title="Add a model"
      description="For a model an upstream serves but does not list. Sync leaves hand-added rows exactly as typed."
      size="md"
      closeOnBackdrop={!saving && !probing}
      footer={
        <>
          <Button
            variant="secondary"
            loading={probing}
            disabled={saving || !provider || wireId.length === 0}
            onClick={() => void runTest()}
            className="mr-auto"
          >
            Test upstream
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving || probing}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={probing} onClick={() => void submit()}>
            Add model
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose/35 bg-rose/10 px-3 py-2 text-xs leading-relaxed text-rose"
          >
            {error.message}
          </p>
        ) : null}

        {probe ? <ProbeReport result={probe} /> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Provider"
            htmlFor="new-model-provider"
            error={fieldError("provider")}
            help="Only providers with a working credential can be probed."
          >
            <Select
              id="new-model-provider"
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
                setProbe(null);
              }}
            >
              {providers.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Category"
            htmlFor="new-model-category"
            help="Shown as a badge here and on the user-facing catalogue."
          >
            <Select
              id="new-model-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              {MODEL_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Catalogue id"
          htmlFor="new-model-id"
          error={fieldError("modelId")}
          help="What callers send as “model”. Convention is provider/model, e.g. madefaka/gpt-4o-mini."
        >
          <Input
            id="new-model-id"
            spellCheck={false}
            value={modelId}
            placeholder={provider ? `${provider}/gpt-4o-mini` : "provider/model"}
            onChange={(event) => {
              setModelId(event.target.value);
              setProbe(null);
            }}
          />
        </Field>

        <Field
          label="Upstream id"
          htmlFor="new-model-upstream"
          error={fieldError("upstreamModel")}
          help="What Relayn sends on the wire. Leave empty when it is identical to the catalogue id."
        >
          <Input
            id="new-model-upstream"
            spellCheck={false}
            value={upstreamModel}
            placeholder={modelId.trim() || "gpt-4o-mini"}
            onChange={(event) => {
              setUpstreamModel(event.target.value);
              setProbe(null);
            }}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Display name"
            htmlFor="new-model-name"
            error={fieldError("name")}
            help="Optional — derived from the id when empty."
          >
            <Input
              id="new-model-name"
              value={name}
              placeholder="GPT-4o mini"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Minimum plan" htmlFor="new-model-plan" help="Plans below this get a 403.">
            <Select
              id="new-model-plan"
              value={minPlan}
              onChange={(event) => setMinPlan(event.target.value)}
            >
              {PLAN_ORDER.map((id) => (
                <option key={id} value={id}>
                  {planOf(id).name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Input $/M" htmlFor="new-model-input" error={fieldError("inputPrice")}>
            <Input
              id="new-model-input"
              inputMode="decimal"
              value={inputPrice}
              onChange={(event) => setInputPrice(event.target.value)}
            />
          </Field>
          <Field label="Output $/M" htmlFor="new-model-output" error={fieldError("outputPrice")}>
            <Input
              id="new-model-output"
              inputMode="decimal"
              value={outputPrice}
              onChange={(event) => setOutputPrice(event.target.value)}
            />
          </Field>
          <Field label="Context" htmlFor="new-model-context" error={fieldError("contextWindow")}>
            <Input
              id="new-model-context"
              inputMode="numeric"
              value={contextWindow}
              placeholder="128000"
              onChange={(event) => setContextWindow(event.target.value)}
            />
          </Field>
          <Field
            label="Max output"
            htmlFor="new-model-max-output"
            error={fieldError("maxOutputTokens")}
          >
            <Input
              id="new-model-max-output"
              inputMode="numeric"
              value={maxOutputTokens}
              placeholder="16384"
              onChange={(event) => setMaxOutputTokens(event.target.value)}
            />
          </Field>
        </div>

        <Field
          label="Description"
          htmlFor="new-model-description"
          error={fieldError("description")}
          help="Shown on the user-facing catalogue card. Optional."
        >
          <Textarea
            id="new-model-description"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <Field
          label="Fallback chain"
          htmlFor="new-model-fallbacks"
          error={fieldError("fallbacks") ?? chain}
          help={`Optional. Catalogue ids tried in order when this upstream rate-limits or errors. At most ${MAX_FALLBACKS}.`}
        >
          <Input
            id="new-model-fallbacks"
            spellCheck={false}
            value={fallbacks}
            placeholder="jerouter/gpt-4o-mini"
            onChange={(event) => setFallbacks(event.target.value)}
          />
        </Field>

        <div className="space-y-2 border-t border-line pt-3">
          <Checkbox
            id="new-model-enabled"
            checked={enabled}
            label="Callable — users on the minimum plan or higher may request it"
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <Checkbox
            id="new-model-test"
            checked={test}
            label="Ask the upstream for one token before saving (recommended)"
            onChange={(event) => setTest(event.target.checked)}
          />
          <p className="text-[11px] leading-relaxed text-ink-faint">
            With the test on, a model the upstream will not serve is refused rather than written —
            so a dead id never reaches a caller. Clear it only for a model you know is correct but
            temporarily unreachable. Prices are metered only; this build charges nobody.
          </p>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Result of the last probe. Kept on screen rather than left in a toast: the sample text is the
 * evidence that the upstream really answered from that id, and it is worth reading twice before
 * committing a row that callers will depend on.
 */
function ProbeReport({ result }: { result: ModelProbeResult }) {
  return (
    <div className="rounded-lg border border-line bg-canvas/60 p-3">
      <p className="text-[11px] tracking-wide text-ink-faint uppercase">Last probe</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <Badge tone={result.ok ? "brand" : "rose"} dot>
          {result.ok ? "Served" : "Refused"}
        </Badge>
        <span className="numeric leading-relaxed break-all">
          {result.label} · {result.model}
        </span>
        <span className="numeric text-[11px] text-ink-faint">
          {formatLatency(result.latencyMs)}
        </span>
      </div>
      {result.error ? (
        <p className="mt-1.5 text-xs leading-relaxed text-rose">{result.error}</p>
      ) : null}
      {result.sample ? (
        <p className="numeric mt-1.5 text-[11px] leading-relaxed break-all text-ink-faint">
          Returned: {result.sample}
        </p>
      ) : null}
    </div>
  );
}

