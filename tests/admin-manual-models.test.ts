/**
 * Hand-added catalogue rows and catalogue deletion — the two write paths sync does not have.
 *
 * The refusals carry the weight here, and each exists because the failure it prevents is silent
 * rather than loud:
 *
 *   - **A dead id is refused before it is written.** The probe asks the upstream to serve one
 *     token; an id that fails it would otherwise become a 502 for a paying caller later, long
 *     after whoever typed it stopped looking.
 *   - **A row another chain still names cannot be deleted.** The gateway would skip the gap and
 *     report nothing, leaving a fallback that looks configured and does nothing.
 *
 * Deletion itself is asserted from the other direction: a **synced** row must leave a suppression
 * behind, written in the same transaction, or the next sync lists the upstream, does not recognise
 * the id, and recreates the row — a delete that silently undoes itself. A **manual** row must leave
 * none, because sync never created it and never will.
 *
 * Prices default to zero rather than to a guess, which is asserted: a guessed price is billed to
 * real users.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiModel } from "@/lib/db-types";
import type { ModelProvider } from "@/lib/providers/types";

const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  destroy: vi.fn(),
  groupBy: vi.fn(),
  removedFindMany: vi.fn(),
  removedFindUnique: vi.fn(),
  removedUpsert: vi.fn(),
  removedDestroy: vi.fn(),
  removedDeleteMany: vi.fn(),
  transaction: vi.fn(),
}));
const { resolveProvider, recordAudit } = vi.hoisted(() => ({
  resolveProvider: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    aiModel: {
      findUnique: db.findUnique,
      findMany: db.findMany,
      create: db.create,
      delete: db.destroy,
      groupBy: vi.fn(async () => []),
    },
    removedModel: {
      findMany: db.removedFindMany,
      findUnique: db.removedFindUnique,
      upsert: db.removedUpsert,
      delete: db.removedDestroy,
      deleteMany: db.removedDeleteMany,
    },
    usageLog: { groupBy: db.groupBy },
    providerConfig: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    $transaction: db.transaction,
  },
}));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/providers/registry", () => ({
  resolveProvider,
  invalidateProviderCache: vi.fn(),
  providerStatuses: vi.fn(async () => []),
  isProviderKind: (value: string) => value === "openai" || value === "anthropic",
  isReservedProviderId: () => false,
  reservedProviderIds: () => [],
}));

const service = await import("@/server/services/admin-service");

const ACTOR = { id: "admin-1", email: "admin@relayn.test" };
const REQUEST = new Request("https://bandidoz.biz.id/api/admin/models", { method: "POST" });

function row(overrides: Partial<AiModel> = {}): AiModel {
  return {
    id: "row-1",
    modelId: "acme/one",
    provider: "acme",
    upstreamModel: null,
    name: "One",
    category: "chat",
    description: "",
    contextWindow: 0,
    maxOutputTokens: 0,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: "streaming",
    minPlan: "free",
    enabled: true,
    sortOrder: 900,
    fallbacks: "",
    manual: true,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  } as AiModel;
}

/** A provider whose one-token probe either answers or throws. */
function provider(overrides: { configured?: boolean; answer?: string; fail?: string } = {}): ModelProvider {
  return {
    id: "acme",
    label: "Acme Gateway",
    credentialEnvVar: "",
    isConfigured: () => overrides.configured !== false,
    chatCompletion: vi.fn(async () => {
      if (overrides.fail) throw new Error(overrides.fail);
      return { content: overrides.answer ?? "pong", usage: undefined, usageEstimated: true };
    }),
  } as unknown as ModelProvider;
}

/** A suppression row: the id of a synced model an operator deleted. */
function removedRow(overrides: Partial<{ id: string; modelId: string; provider: string; name: string }> = {}) {
  return {
    id: "gone-1",
    modelId: "acme/one",
    provider: "acme",
    name: "One",
    removedBy: "admin-1",
    createdAt: new Date("2026-09-05T10:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  db.findUnique.mockReset().mockResolvedValue(null);
  db.findMany.mockReset().mockResolvedValue([]);
  db.create.mockReset().mockResolvedValue(row());
  db.destroy.mockReset().mockResolvedValue(row());
  db.groupBy.mockReset().mockResolvedValue([]);
  db.removedFindMany.mockReset().mockResolvedValue([]);
  db.removedFindUnique.mockReset().mockResolvedValue(null);
  db.removedUpsert.mockReset().mockResolvedValue(removedRow());
  db.removedDestroy.mockReset().mockResolvedValue(removedRow());
  db.removedDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  // Stands in for the real transaction by awaiting the operations it was handed. Enough to assert
  // *what* is enrolled, which is the property that matters: the delete and the suppression must
  // both be in the same call.
  db.transaction.mockReset().mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  recordAudit.mockReset().mockResolvedValue(undefined);
  resolveProvider.mockReset().mockResolvedValue(provider());
});

describe("createManualModel", () => {
  const input = { modelId: "acme/one", provider: "acme" };

  it("writes the row, marks it manual, and audits the id", async () => {
    await service.createManualModel(ACTOR, input, REQUEST);

    expect(db.create).toHaveBeenCalledTimes(1);
    expect(db.create.mock.calls[0]![0].data).toMatchObject({
      modelId: "acme/one",
      provider: "acme",
      upstreamModel: "acme/one",
      manual: true,
      enabled: true,
      minPlan: "free",
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.model_created", targetId: "acme/one" }),
    );
  });

  it("clears a suppression for the id it writes", async () => {
    // Adding an id back by hand is a clearer statement of intent than the earlier deletion. Leaving
    // the suppression would list the same model as live and as removed at the same time.
    await service.createManualModel(ACTOR, input, REQUEST);

    expect(db.removedDeleteMany).toHaveBeenCalledWith({ where: { modelId: "acme/one" } });
  });

  it("records an unknown price as zero rather than guessing one", async () => {
    // Zero means metered-as-free. A guess would be billed against real users.
    await service.createManualModel(ACTOR, input, REQUEST);

    expect(db.create.mock.calls[0]![0].data).toMatchObject({ inputPrice: 0, outputPrice: 0 });
  });

  it("probes the upstream id, not the catalogue id", async () => {
    const acme = provider();
    resolveProvider.mockResolvedValue(acme);

    await service.createManualModel(
      ACTOR,
      { ...input, modelId: "house-brand", upstreamModel: "vendor/real-id" },
      REQUEST,
    );

    expect(acme.chatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: "vendor/real-id" }),
      expect.objectContaining({ upstreamModel: "vendor/real-id" }),
    );
    expect(db.create.mock.calls[0]![0].data).toMatchObject({
      modelId: "house-brand",
      upstreamModel: "vendor/real-id",
    });
  });

  it("returns the probe as evidence the upstream really answered", async () => {
    resolveProvider.mockResolvedValue(provider({ answer: "pong from acme" }));
    const result = await service.createManualModel(ACTOR, input, REQUEST);

    expect(result.probe).toMatchObject({ ok: true, model: "acme/one", sample: "pong from acme" });
  });

  it("refuses an id the upstream will not serve, and writes nothing", async () => {
    resolveProvider.mockResolvedValue(provider({ fail: "404 model not found" }));

    await expect(service.createManualModel(ACTOR, input, REQUEST)).rejects.toMatchObject({
      status: 400,
      code: "bad_request",
    });
    expect(db.create).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("names the remedy when the probe fails", async () => {
    resolveProvider.mockResolvedValue(provider({ fail: "404 model not found" }));

    await expect(service.createManualModel(ACTOR, input, REQUEST)).rejects.toThrow(
      /save with the test switched off/,
    );
  });

  it("skips the probe when the operator opts out", async () => {
    const acme = provider();
    resolveProvider.mockResolvedValue(acme);

    const result = await service.createManualModel(ACTOR, { ...input, test: false }, REQUEST);

    expect(acme.chatCompletion).not.toHaveBeenCalled();
    expect(result.probe).toBeUndefined();
    expect(db.create).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0]![0].metadata).toMatchObject({ tested: false });
  });

  it("refuses a provider that is not registered", async () => {
    resolveProvider.mockResolvedValue(null);

    await expect(service.createManualModel(ACTOR, input, REQUEST)).rejects.toThrow(
      /is not a registered provider/,
    );
    expect(db.create).not.toHaveBeenCalled();
  });

  it("refuses an id that already exists instead of overwriting it", async () => {
    db.findUnique.mockResolvedValue(row());

    await expect(service.createManualModel(ACTOR, input, REQUEST)).rejects.toThrow(
      /already exists/,
    );
    expect(db.create).not.toHaveBeenCalled();
  });

  it("refuses an unknown plan and an unknown category before touching the upstream", async () => {
    await expect(
      service.createManualModel(ACTOR, { ...input, minPlan: "platinum" }, REQUEST),
    ).rejects.toThrow("Unknown plan.");
    await expect(
      service.createManualModel(ACTOR, { ...input, category: "telepathy" }, REQUEST),
    ).rejects.toThrow("Unknown category.");
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it("refuses a chain naming an id no catalogue row has", async () => {
    db.findMany.mockResolvedValue([]);

    await expect(
      service.createManualModel(ACTOR, { ...input, fallbacks: "ghost" }, REQUEST),
    ).rejects.toThrow(/No catalogue model named `ghost`/);
    expect(db.create).not.toHaveBeenCalled();
  });

  it("refuses a chain naming the model itself", async () => {
    await expect(
      service.createManualModel(ACTOR, { ...input, fallbacks: "acme/one" }, REQUEST),
    ).rejects.toThrow(/cannot fall back to itself/);
  });

  it("accepts a chain whose links all exist", async () => {
    // Full rows, not just `{modelId}`: this same mock also answers the `listAdminModels()` the
    // service ends with, which reads every column.
    db.findMany.mockResolvedValue([row({ modelId: "acme/two" })]);

    await service.createManualModel(ACTOR, { ...input, fallbacks: "acme/two" }, REQUEST);

    expect(db.create.mock.calls[0]![0].data).toMatchObject({ fallbacks: "acme/two" });
  });
});

describe("deleteCatalogueModel", () => {
  it("deletes a hand-added row and audits the catalogue id, not the row id", async () => {
    db.findUnique.mockResolvedValue(row({ id: "row-1", modelId: "acme/one", manual: true }));

    await service.deleteCatalogueModel(ACTOR, "row-1", REQUEST);

    expect(db.destroy).toHaveBeenCalledWith({ where: { id: "row-1" } });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.model_deleted", targetId: "acme/one" }),
    );
  });

  it("leaves no suppression for a hand-added row", async () => {
    // Sync never created it and never will, so there is nothing to suppress. An entry here would
    // show the model as both live-by-hand and removed if it were ever re-added.
    db.findUnique.mockResolvedValue(row({ manual: true }));

    await service.deleteCatalogueModel(ACTOR, "row-1", REQUEST);

    expect(db.removedUpsert).not.toHaveBeenCalled();
    expect(recordAudit.mock.calls[0]![0].metadata).toMatchObject({
      manual: true,
      suppressed: false,
    });
  });

  it("suppresses a synced id so the next sync cannot recreate it", async () => {
    db.findUnique.mockResolvedValue(row({ modelId: "acme/one", provider: "acme", manual: false }));

    await service.deleteCatalogueModel(ACTOR, "row-1", REQUEST);

    expect(db.destroy).toHaveBeenCalledWith({ where: { id: "row-1" } });
    expect(db.removedUpsert).toHaveBeenCalledTimes(1);
    // The catalogue id, not the row handle: sync matches on `modelId`, and a row handle would
    // suppress nothing while looking like it had.
    expect(db.removedUpsert.mock.calls[0]![0]).toMatchObject({
      where: { modelId: "acme/one" },
      create: { modelId: "acme/one", provider: "acme", removedBy: "admin-1" },
    });
    expect(recordAudit.mock.calls[0]![0].metadata).toMatchObject({
      manual: false,
      suppressed: true,
    });
  });

  it("enrols the delete and the suppression in one transaction", async () => {
    // Separate writes would let the delete commit alone, and the next sync would undo it.
    db.findUnique.mockResolvedValue(row({ manual: false }));

    await service.deleteCatalogueModel(ACTOR, "row-1", REQUEST);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.transaction.mock.calls[0]![0]).toHaveLength(2);
  });

  it("re-suppresses an id that was restored before, rather than failing on the unique index", async () => {
    // `removed_models.modelId` is unique, so a second delete of the same id must update the
    // existing row. A bare create would throw and the delete would be refused for no good reason.
    db.findUnique.mockResolvedValue(row({ manual: false }));

    await service.deleteCatalogueModel(ACTOR, "row-1", REQUEST);

    expect(db.removedUpsert.mock.calls[0]![0].update).toMatchObject({ removedBy: "admin-1" });
  });

  it("refuses a row another model still falls back to, and names the chains", async () => {
    db.findUnique.mockResolvedValue(row({ modelId: "acme/one", manual: true }));
    db.findMany.mockResolvedValue([{ modelId: "acme/two", fallbacks: "acme/one" }]);

    await expect(service.deleteCatalogueModel(ACTOR, "row-1", REQUEST)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    await expect(service.deleteCatalogueModel(ACTOR, "row-1", REQUEST)).rejects.toThrow(
      /still a fallback for `acme\/two`\. Remove it from those chains first\./,
    );
    expect(db.destroy).not.toHaveBeenCalled();
    expect(db.removedUpsert).not.toHaveBeenCalled();
  });

  it("is not blocked by a substring match in someone else's chain", async () => {
    // `contains` is a cheap pre-filter, so `acme/one-mini` comes back when deleting `acme/one`.
    // Only a whole-entry match may block the delete, or an operator could be stuck forever.
    db.findUnique.mockResolvedValue(row({ modelId: "acme/one", manual: true }));
    db.findMany.mockResolvedValue([row({ modelId: "acme/two", fallbacks: "acme/one-mini" })]);

    await service.deleteCatalogueModel(ACTOR, "row-1", REQUEST);

    expect(db.destroy).toHaveBeenCalledTimes(1);
  });

  it("is not blocked by its own chain naming itself", async () => {
    db.findUnique.mockResolvedValue(row({ modelId: "acme/one", manual: true }));
    db.findMany.mockResolvedValue([row({ modelId: "acme/one", fallbacks: "acme/one" })]);

    await service.deleteCatalogueModel(ACTOR, "row-1", REQUEST);

    expect(db.destroy).toHaveBeenCalledTimes(1);
  });

  it("404s an unknown row id instead of reporting a successful delete", async () => {
    db.findUnique.mockResolvedValue(null);

    await expect(service.deleteCatalogueModel(ACTOR, "ghost", REQUEST)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(db.destroy).not.toHaveBeenCalled();
  });

  it("keeps usage history out of the decision", async () => {
    // `usage_logs.modelId` is a string, so past billing rows survive the delete. Blocking on
    // history would make every model that was ever called undeletable.
    db.findUnique.mockResolvedValue(row({ modelId: "acme/one", manual: true }));
    db.groupBy.mockResolvedValue([{ modelId: "acme/one", _count: { _all: 4_000 } }]);

    await service.deleteCatalogueModel(ACTOR, "row-1", REQUEST);

    expect(db.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("restoreRemovedModel", () => {
  it("drops the suppression and audits the catalogue id", async () => {
    db.removedFindUnique.mockResolvedValue(removedRow({ id: "gone-1", modelId: "acme/one" }));

    await service.restoreRemovedModel(ACTOR, "gone-1", REQUEST);

    expect(db.removedDestroy).toHaveBeenCalledWith({ where: { id: "gone-1" } });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.model_restored", targetId: "acme/one" }),
    );
  });

  it("does not recreate the model row", async () => {
    // Prices and context windows belong to the upstream. Restoring a snapshot would serve numbers
    // that were current whenever the model happened to be deleted; the next sync re-reads them.
    db.removedFindUnique.mockResolvedValue(removedRow());

    await service.restoreRemovedModel(ACTOR, "gone-1", REQUEST);

    expect(db.create).not.toHaveBeenCalled();
  });

  it("404s an id that is not on the removed list", async () => {
    db.removedFindUnique.mockResolvedValue(null);

    await expect(service.restoreRemovedModel(ACTOR, "ghost", REQUEST)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(db.removedDestroy).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
