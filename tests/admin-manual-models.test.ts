/**
 * Hand-added catalogue rows — the write path sync does not have.
 *
 * Three refusals carry the weight here, and all three exist because the failure they prevent is
 * silent rather than loud:
 *
 *   - **A dead id is refused before it is written.** The probe asks the upstream to serve one
 *     token; an id that fails it would otherwise become a 502 for a paying caller later, long
 *     after whoever typed it stopped looking.
 *   - **A synced row cannot be deleted.** The next sync would recreate it, so the delete would
 *     appear to work and then quietly undo itself. Those are disabled instead.
 *   - **A row another chain still names cannot be deleted.** The gateway would skip the gap and
 *     report nothing, leaving a fallback that looks configured and does nothing.
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
    usageLog: { groupBy: db.groupBy },
    providerConfig: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
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

beforeEach(() => {
  db.findUnique.mockReset().mockResolvedValue(null);
  db.findMany.mockReset().mockResolvedValue([]);
  db.create.mockReset().mockResolvedValue(row());
  db.destroy.mockReset().mockResolvedValue(row());
  db.groupBy.mockReset().mockResolvedValue([]);
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

describe("deleteManualModel", () => {
  it("deletes a hand-added row and audits the catalogue id, not the row id", async () => {
    db.findUnique.mockResolvedValue(row({ id: "row-1", modelId: "acme/one", manual: true }));

    await service.deleteManualModel(ACTOR, "row-1", REQUEST);

    expect(db.destroy).toHaveBeenCalledWith({ where: { id: "row-1" } });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.model_deleted", targetId: "acme/one" }),
    );
  });

  it("refuses a synced row, because the next sync would recreate it", async () => {
    // The delete would appear to work and then quietly undo itself. Disabling is the real remedy,
    // so the message says so.
    db.findUnique.mockResolvedValue(row({ manual: false }));

    await expect(service.deleteManualModel(ACTOR, "row-1", REQUEST)).rejects.toThrow(
      /came from catalogue sync and would be recreated by the next run\. Disable it instead\./,
    );
    expect(db.destroy).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a row another model still falls back to, and names the chains", async () => {
    db.findUnique.mockResolvedValue(row({ modelId: "acme/one", manual: true }));
    db.findMany.mockResolvedValue([{ modelId: "acme/two", fallbacks: "acme/one" }]);

    await expect(service.deleteManualModel(ACTOR, "row-1", REQUEST)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    await expect(service.deleteManualModel(ACTOR, "row-1", REQUEST)).rejects.toThrow(
      /still a fallback for `acme\/two`\. Remove it from those chains first\./,
    );
    expect(db.destroy).not.toHaveBeenCalled();
  });

  it("is not blocked by a substring match in someone else's chain", async () => {
    // `contains` is a cheap pre-filter, so `acme/one-mini` comes back when deleting `acme/one`.
    // Only a whole-entry match may block the delete, or an operator could be stuck forever.
    db.findUnique.mockResolvedValue(row({ modelId: "acme/one", manual: true }));
    db.findMany.mockResolvedValue([row({ modelId: "acme/two", fallbacks: "acme/one-mini" })]);

    await service.deleteManualModel(ACTOR, "row-1", REQUEST);

    expect(db.destroy).toHaveBeenCalledTimes(1);
  });

  it("is not blocked by its own chain naming itself", async () => {
    db.findUnique.mockResolvedValue(row({ modelId: "acme/one", manual: true }));
    db.findMany.mockResolvedValue([row({ modelId: "acme/one", fallbacks: "acme/one" })]);

    await service.deleteManualModel(ACTOR, "row-1", REQUEST);

    expect(db.destroy).toHaveBeenCalledTimes(1);
  });

  it("404s an unknown row id instead of reporting a successful delete", async () => {
    db.findUnique.mockResolvedValue(null);

    await expect(service.deleteManualModel(ACTOR, "ghost", REQUEST)).rejects.toMatchObject({
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

    await service.deleteManualModel(ACTOR, "row-1", REQUEST);

    expect(db.destroy).toHaveBeenCalledTimes(1);
  });
});
