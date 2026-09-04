/**
 * Fallback chain resolution — what a request is *allowed* to be retried against.
 *
 * The security-relevant rule lives here: a chain is operator data, so `planSatisfies` is
 * re-applied to every link independently. Without that, a `free` model naming a `business` model
 * as its fallback would hand every Free caller a paid model for free — a privilege escalation
 * with no request-side tell at all. That case is asserted first and directly.
 *
 * Everything else is about not letting catalogue edits break working traffic: a fallback that no
 * longer exists, was disabled, or lost its credential is skipped *with a reason* rather than
 * failing the request, while the primary keeps failing exactly as it did before fallbacks
 * existed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FALLBACKS } from "@/lib/catalogue";
import type { AiModel } from "@/lib/db-types";
import type { ModelProvider } from "@/lib/providers/types";

const { findUnique, findMany, resolveProvider } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  resolveProvider: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { aiModel: { findUnique, findMany } } }));
vi.mock("@/lib/providers/registry", () => ({ resolveProvider }));

const { GatewayError, resolveChain } = await import("@/lib/gateway/pipeline");

/** A catalogue row with only the columns resolution reads. */
function row(overrides: Partial<AiModel> = {}): AiModel {
  return {
    modelId: "primary",
    provider: "acme",
    upstreamModel: null,
    minPlan: "free",
    enabled: true,
    fallbacks: "",
    ...overrides,
  } as AiModel;
}

/** A configured provider, unless `configured` says otherwise. */
function provider(id: string, configured = true): ModelProvider {
  return {
    id,
    label: id.toUpperCase(),
    credentialEnvVar: `${id.toUpperCase()}_API_KEY`,
    isConfigured: () => configured,
  } as unknown as ModelProvider;
}

/** Loads the catalogue: the primary comes from `findUnique`, fallbacks from `findMany`. */
function catalogue(primary: AiModel, ...fallbacks: AiModel[]): void {
  findUnique.mockResolvedValue(primary);
  findMany.mockResolvedValue(fallbacks);
}

beforeEach(() => {
  findUnique.mockReset();
  findMany.mockReset().mockResolvedValue([]);
  resolveProvider.mockReset().mockImplementation(async (id: string) => provider(id));
});

describe("resolveChain — plan is re-checked per link", () => {
  it("never lets a free model's chain reach a model the caller's plan cannot call", async () => {
    catalogue(
      row({ modelId: "free-model", minPlan: "free", fallbacks: "paid-model" }),
      row({ modelId: "paid-model", minPlan: "business" }),
    );

    const chain = await resolveChain("free-model", "free");

    expect(chain.links.map((entry) => entry.model.modelId)).toEqual(["free-model"]);
    expect(chain.skipped).toEqual([{ modelId: "paid-model", reason: "requires Business" }]);
  });

  it("includes that same link for a caller whose plan does satisfy it", async () => {
    catalogue(
      row({ modelId: "free-model", minPlan: "free", fallbacks: "paid-model" }),
      row({ modelId: "paid-model", minPlan: "business" }),
    );

    const chain = await resolveChain("free-model", "business");

    expect(chain.links.map((entry) => entry.model.modelId)).toEqual(["free-model", "paid-model"]);
    expect(chain.skipped).toEqual([]);
  });
});

describe("resolveChain — the primary still fails as it always did", () => {
  it("404s an unknown model", async () => {
    findUnique.mockResolvedValue(null);
    await expect(resolveChain("nope", "free")).rejects.toMatchObject({
      status: 404,
      code: "model_not_found",
    });
  });

  it("503s a disabled model rather than skipping it", async () => {
    catalogue(row({ enabled: false }));
    await expect(resolveChain("primary", "free")).rejects.toMatchObject({
      status: 503,
      code: "model_disabled",
    });
  });

  it("403s a model above the caller's plan", async () => {
    catalogue(row({ minPlan: "pro" }));
    await expect(resolveChain("primary", "free")).rejects.toMatchObject({
      status: 403,
      code: "model_not_available_on_plan",
    });
  });

  it("503s when the primary's provider has no credential", async () => {
    catalogue(row());
    resolveProvider.mockResolvedValue(provider("acme", false));
    await expect(resolveChain("primary", "free")).rejects.toMatchObject({
      status: 503,
      code: "provider_unconfigured",
    });
  });

  it("400s a missing model id", async () => {
    await expect(resolveChain("", "free")).rejects.toBeInstanceOf(GatewayError);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("resolveChain — a stale chain degrades instead of failing", () => {
  it("skips a fallback with no catalogue row", async () => {
    catalogue(row({ fallbacks: "ghost" }));
    const chain = await resolveChain("primary", "free");

    expect(chain.links).toHaveLength(1);
    expect(chain.skipped).toEqual([{ modelId: "ghost", reason: "no catalogue row" }]);
  });

  it("skips a disabled fallback", async () => {
    catalogue(row({ fallbacks: "backup" }), row({ modelId: "backup", enabled: false }));
    const chain = await resolveChain("primary", "free");

    expect(chain.skipped).toEqual([{ modelId: "backup", reason: "disabled" }]);
  });

  it("skips a fallback whose provider is not registered", async () => {
    catalogue(row({ fallbacks: "backup" }), row({ modelId: "backup", provider: "gone" }));
    resolveProvider.mockImplementation(async (id: string) => (id === "gone" ? null : provider(id)));

    const chain = await resolveChain("primary", "free");
    expect(chain.skipped).toEqual([
      { modelId: "backup", reason: "provider `gone` not registered" },
    ]);
  });

  it("skips a fallback whose provider lost its credential", async () => {
    catalogue(row({ fallbacks: "backup" }), row({ modelId: "backup", provider: "dry" }));
    resolveProvider.mockImplementation(async (id: string) => provider(id, id !== "dry"));

    const chain = await resolveChain("primary", "free");
    expect(chain.skipped).toEqual([{ modelId: "backup", reason: "DRY has no credential" }]);
  });
});

describe("resolveChain — chain shape", () => {
  it("preserves the declared order rather than the query's", async () => {
    catalogue(
      row({ fallbacks: "third, second" }),
      // `findMany` has no ordering guarantee, so the rows come back the other way round.
      row({ modelId: "second" }),
      row({ modelId: "third" }),
    );

    const chain = await resolveChain("primary", "free");
    expect(chain.links.map((entry) => entry.model.modelId)).toEqual(["primary", "third", "second"]);
  });

  it("costs nothing when a model names itself, and does not report a skip", async () => {
    catalogue(row({ modelId: "primary", fallbacks: "primary" }));
    const chain = await resolveChain("primary", "free");

    expect(chain.links.map((entry) => entry.model.modelId)).toEqual(["primary"]);
    expect(chain.skipped).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("de-duplicates a repeated fallback", async () => {
    catalogue(row({ fallbacks: "backup, backup" }), row({ modelId: "backup" }));
    const chain = await resolveChain("primary", "free");

    expect(chain.links.map((entry) => entry.model.modelId)).toEqual(["primary", "backup"]);
  });

  it("caps the chain at MAX_FALLBACKS regardless of what the row declares", async () => {
    const declared = Array.from({ length: MAX_FALLBACKS + 3 }, (_, index) => `f${index}`);
    catalogue(
      row({ fallbacks: declared.join(",") }),
      ...declared.map((modelId) => row({ modelId })),
    );

    const chain = await resolveChain("primary", "free");
    // Worst case stays MAX_FALLBACKS + 1 upstream calls no matter how the catalogue is wired.
    expect(chain.links).toHaveLength(MAX_FALLBACKS + 1);
    expect(chain.skipped).toEqual([]);
  });

  it("does not follow a fallback's own fallbacks", async () => {
    catalogue(
      row({ fallbacks: "backup" }),
      row({ modelId: "backup", fallbacks: "deeper" }),
      row({ modelId: "deeper" }),
    );

    const chain = await resolveChain("primary", "free");
    // One level only, which makes cycles structurally impossible rather than merely guarded.
    expect(chain.links.map((entry) => entry.model.modelId)).toEqual(["primary", "backup"]);
  });

  it("resolves the whole chain in one query", async () => {
    catalogue(row({ fallbacks: "a,b,c" }), row({ modelId: "a" }), row({ modelId: "b" }), row({ modelId: "c" }));
    await resolveChain("primary", "free");

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ where: { modelId: { in: ["a", "b", "c"] } } });
  });

  it("sends the upstream id when one is set, and the catalogue id otherwise", async () => {
    catalogue(
      row({ modelId: "public-alias", upstreamModel: "vendor/real-id", fallbacks: "plain" }),
      row({ modelId: "plain", upstreamModel: null }),
    );

    const chain = await resolveChain("public-alias", "free");
    expect(chain.links.map((entry) => entry.upstreamModel)).toEqual(["vendor/real-id", "plain"]);
  });
});
