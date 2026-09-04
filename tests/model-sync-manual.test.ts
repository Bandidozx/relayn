/**
 * What catalogue sync will and will not overwrite.
 *
 * Two claims in the module doc are load-bearing enough to assert directly. First, on **update**
 * sync refreshes only facts the upstream owns — never `enabled`, `minPlan`, `description` or
 * `sortOrder`, because those are operator decisions and an aggregator re-listing its catalogue
 * would otherwise silently reopen a model someone deliberately closed, or re-tier a priced one
 * onto Free.
 *
 * Second, a `manual` row is skipped entirely: not updated, and not reported as stale. Both halves
 * matter. Manual rows usually exist *because* the upstream does not list the id, so "the listing
 * dropped it" is the normal state rather than a problem, and refreshing one would overwrite the
 * price and upstream id the operator typed in by hand.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider, ProviderModelInfo } from "@/lib/providers/types";

const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
const { listProviders } = vi.hoisted(() => ({ listProviders: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { aiModel: { findMany: db.findMany, create: db.create, update: db.update } },
}));
vi.mock("@/lib/providers/registry", () => ({ listProviders }));

const { syncProviderCatalogue } = await import("@/server/services/model-sync-service");

/** A provider that lists exactly what it is given. */
function upstream(models: ProviderModelInfo[], overrides: { configured?: boolean } = {}) {
  return {
    id: "acme",
    label: "Acme Gateway",
    credentialEnvVar: "ACME_API_KEY",
    isConfigured: () => overrides.configured !== false,
    listModels: vi.fn(async () => models),
  } as unknown as ModelProvider;
}

/** Existing catalogue rows, as `syncOne` selects them. */
function existing(...rows: { modelId: string; manual: boolean }[]): void {
  db.findMany.mockResolvedValue(rows);
}

beforeEach(() => {
  db.findMany.mockReset().mockResolvedValue([]);
  db.create.mockReset().mockResolvedValue({});
  db.update.mockReset().mockResolvedValue({});
  listProviders.mockReset();
});

describe("syncProviderCatalogue — a manual row is the operator's", () => {
  beforeEach(() => {
    listProviders.mockResolvedValue([upstream([{ id: "one", ownedBy: "acme" }])]);
  });

  it("does not update a manual row the upstream also lists", async () => {
    existing({ modelId: "acme/one", manual: true });

    const summary = await syncProviderCatalogue();

    expect(db.update).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ created: 0, updated: 0, preserved: 1 });
  });

  it("does update the same row when it came from sync", async () => {
    // The contrast is the point: `manual` is the only thing holding the write back.
    existing({ modelId: "acme/one", manual: false });

    const summary = await syncProviderCatalogue();

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ updated: 1, preserved: 0 });
  });

  it("does not report a manual row as stale when the upstream stops listing it", async () => {
    // Being unlisted is usually why the row was added by hand in the first place.
    listProviders.mockResolvedValue([upstream([{ id: "two", ownedBy: "acme" }])]);
    existing({ modelId: "acme/one", manual: true }, { modelId: "acme/gone", manual: false });

    const [result] = (await syncProviderCatalogue()).results;

    expect(result!.stale).toEqual(["acme/gone"]);
  });

  it("counts a preserved row without counting it as discovered work", async () => {
    existing({ modelId: "acme/one", manual: true });

    const [result] = (await syncProviderCatalogue()).results;

    expect(result).toMatchObject({ discovered: 1, created: 0, updated: 0, preserved: 1 });
  });
});

describe("syncProviderCatalogue — update touches only what the upstream owns", () => {
  it("refreshes the upstream id, window and price and nothing else", async () => {
    listProviders.mockResolvedValue([
      upstream([{ id: "one", ownedBy: "acme", contextWindow: 128_000, inputPrice: 0.5, outputPrice: 1.5 }]),
    ]);
    existing({ modelId: "acme/one", manual: false });

    await syncProviderCatalogue();

    const call = db.update.mock.calls[0]![0];
    expect(call.where).toEqual({ modelId: "acme/one" });
    expect(call.data).toEqual({
      provider: "acme",
      upstreamModel: "one",
      contextWindow: 128_000,
      inputPrice: 0.5,
      outputPrice: 1.5,
    });
    // An operator's decisions are absent from the write, not merely equal to their current value.
    for (const field of ["enabled", "minPlan", "description", "sortOrder", "name", "fallbacks"]) {
      expect(call.data).not.toHaveProperty(field);
    }
  });

  it("omits a price the upstream does not publish rather than writing zero over one", async () => {
    // Writing 0 here would meter a paid model as free until someone noticed.
    listProviders.mockResolvedValue([upstream([{ id: "one", ownedBy: "acme" }])]);
    existing({ modelId: "acme/one", manual: false });

    await syncProviderCatalogue();

    expect(db.update.mock.calls[0]![0].data).toEqual({ provider: "acme", upstreamModel: "one" });
  });
});

describe("syncProviderCatalogue — new rows", () => {
  it("namespaces the public id and keeps the upstream's own id separately", async () => {
    listProviders.mockResolvedValue([upstream([{ id: "vendor/one", ownedBy: "acme" }])]);

    await syncProviderCatalogue();

    expect(db.create.mock.calls[0]![0].data).toMatchObject({
      modelId: "acme/vendor/one",
      upstreamModel: "vendor/one",
      enabled: true,
    });
  });

  it("never puts a priced model on the free tier", async () => {
    listProviders.mockResolvedValue([upstream([{ id: "one", ownedBy: "acme", outputPrice: 3 }])]);

    await syncProviderCatalogue();

    expect(db.create.mock.calls[0]![0].data).toMatchObject({ minPlan: "business" });
  });
});

describe("syncProviderCatalogue — provider selection", () => {
  it("skips a provider with no credential instead of failing it", async () => {
    listProviders.mockResolvedValue([upstream([{ id: "one", ownedBy: "acme" }], { configured: false })]);

    const summary = await syncProviderCatalogue();

    expect(summary.skipped).toEqual(["acme"]);
    expect(summary.results).toEqual([]);
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("reports an unreachable upstream without touching the catalogue", async () => {
    const provider = upstream([]);
    (provider.listModels as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("502 Bad Gateway"));
    listProviders.mockResolvedValue([provider]);

    const [result] = (await syncProviderCatalogue()).results;

    expect(result).toMatchObject({ provider: "acme", error: "502 Bad Gateway", discovered: 0 });
    expect(db.create).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("syncs only the providers named", async () => {
    const other = { ...upstream([{ id: "one", ownedBy: "acme" }]), id: "other" } as ModelProvider;
    listProviders.mockResolvedValue([upstream([{ id: "one", ownedBy: "acme" }]), other]);

    const summary = await syncProviderCatalogue(["acme"]);

    expect(summary.results.map((entry) => entry.provider)).toEqual(["acme"]);
  });
});
