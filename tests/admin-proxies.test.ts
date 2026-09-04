/**
 * Outbound proxy configuration for one upstream.
 *
 * A proxy URL is a credential — it almost always carries `user:password` — so the properties that
 * matter here are the same ones that matter for an API key: the list is sealed with `secret-box`
 * before it is written, and the only thing stored or returned in the clear is a redacted hint.
 * Those are asserted against the real `sealSecret`, not a stub, because a mock cannot tell you
 * that the password stopped appearing in the row.
 *
 * The other half is partial acceptance. A pasted list of twenty proxies with one SOCKS entry has
 * to save the other nineteen and say what happened to the odd one out; refusing the whole paste
 * would send the operator hunting for it by hand. A list where *nothing* is usable is refused
 * instead, because silently configuring zero proxies looks identical to success.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
const { recordAudit, invalidateProviderCache, resolveProvider, providerStatuses } = vi.hoisted(
  () => ({
    recordAudit: vi.fn(),
    invalidateProviderCache: vi.fn(),
    resolveProvider: vi.fn(),
    providerStatuses: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    providerConfig: {
      findUnique: db.findUnique,
      findMany: db.findMany,
      create: db.create,
      update: db.update,
    },
    aiModel: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) },
    usageLog: { groupBy: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/providers/registry", () => ({
  resolveProvider,
  invalidateProviderCache,
  providerStatuses,
  isProviderKind: (value: string) => value === "openai" || value === "anthropic",
  isReservedProviderId: () => false,
  reservedProviderIds: () => [],
}));

// Stubbed before the import below: `secret-box` snapshots the environment when its module graph
// loads, and this suite deliberately exercises the real sealing rather than a stub.
vi.stubEnv("SESSION_SECRET", "s".repeat(48));
vi.stubEnv("PROVIDER_CREDENTIAL_KEY", "a1".repeat(32));

const service = await import("@/server/services/admin-service");
const { openSecret } = await import("@/lib/security/secret-box");
const { MAX_PROXIES_PER_PROVIDER } = await import("@/lib/providers/proxy-format");

const ACTOR = { id: "admin-1", email: "admin@relayn.test" };
const REQUEST = new Request("https://bandidoz.biz.id/api/admin/providers/madefaka/proxies", {
  method: "PUT",
});

/** A registry entry for a builtin — the case with no `provider_configs` row yet. */
function builtin(id = "madefaka") {
  return {
    id,
    label: "Madefaka",
    credentialEnvVar: "MADEFAKA_API_KEY",
    isConfigured: () => true,
  };
}

/** An existing annotation row, so the update branch is taken. */
function configRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cfg-1",
    provider: "madefaka",
    label: "Madefaka",
    kind: "openai",
    envVar: "MADEFAKA_API_KEY",
    custom: false,
    enabled: true,
    proxyCipher: null,
    proxyHint: "",
    ...overrides,
  };
}

/** The saved cipher, decrypted — what the gateway would actually dial. */
function savedProxies(): string[] {
  const data = (db.update.mock.calls[0]?.[0] ?? db.create.mock.calls[0]?.[0])?.data;
  const cipher = data?.proxyCipher as string | null;
  return cipher ? openSecret(cipher).split("\n") : [];
}

beforeEach(() => {
  db.findUnique.mockReset().mockResolvedValue(configRow());
  db.findMany.mockReset().mockResolvedValue([]);
  db.create.mockReset().mockResolvedValue(configRow());
  db.update.mockReset().mockResolvedValue(configRow());
  recordAudit.mockReset().mockResolvedValue(undefined);
  invalidateProviderCache.mockReset();
  resolveProvider.mockReset().mockResolvedValue(builtin());
  providerStatuses.mockReset().mockResolvedValue([]);
});

describe("setProviderProxies — the list is a credential", () => {
  it("seals the list and stores only a redacted hint in the clear", async () => {
    const result = await service.setProviderProxies(
      ACTOR,
      "madefaka",
      "http://rotate:s3cret@a.example:8080\nhttp://rotate:s3cret@b.example:8080",
      REQUEST,
    );

    const data = db.update.mock.calls[0]![0].data;
    expect(data.proxyCipher).toBeTypeOf("string");
    expect(data.proxyCipher).not.toContain("s3cret");
    expect(data.proxyHint).toBe("http://rotate:***@a.example:8080/ +1 more");
    expect(result).toMatchObject({ provider: "madefaka", accepted: 2, rejected: [] });
    expect(result.hint).not.toContain("s3cret");
  });

  it("round-trips exactly what the gateway will dial, in the pasted order", async () => {
    await service.setProviderProxies(
      ACTOR,
      "madefaka",
      "http://a.example:8080\nhttp://b.example:3128",
      REQUEST,
    );

    expect(savedProxies()).toEqual(["http://a.example:8080/", "http://b.example:3128/"]);
  });

  it("keeps the password out of the audit row", async () => {
    // The audit trail is read by more people than the database is, and it is retained longer.
    await service.setProviderProxies(ACTOR, "madefaka", "http://rotate:s3cret@a.example:8080", REQUEST);

    const entry = recordAudit.mock.calls[0]![0];
    expect(entry).toMatchObject({
      action: "admin.provider_proxies_updated",
      targetId: "madefaka",
      metadata: { proxies: 1, hint: "http://rotate:***@a.example:8080/", rejected: 0 },
    });
    expect(JSON.stringify(entry)).not.toContain("s3cret");
  });
});

describe("setProviderProxies — partial acceptance", () => {
  it("saves the usable lines and reports the rest", async () => {
    const result = await service.setProviderProxies(
      ACTOR,
      "madefaka",
      ["http://a.example:8080", "socks5://b.example:1080", "http://c.example:8080"].join("\n"),
      REQUEST,
    );

    expect(result.accepted).toBe(2);
    expect(savedProxies()).toEqual(["http://a.example:8080/", "http://c.example:8080/"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatch(/SOCKS proxies are not supported/);
  });

  it("refuses a list where nothing is usable, and writes nothing", async () => {
    // Saving zero proxies here would look like success and change nothing about egress.
    await expect(
      service.setProviderProxies(ACTOR, "madefaka", "socks5://a.example:1080\nnot-a-url", REQUEST),
    ).rejects.toMatchObject({ status: 400, code: "bad_request" });

    expect(db.update).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(invalidateProviderCache).not.toHaveBeenCalled();
  });

  it("caps the list and says how many were dropped", async () => {
    const pasted = Array.from(
      { length: MAX_PROXIES_PER_PROVIDER + 3 },
      (_, index) => `http://p${index}.example:8080`,
    ).join("\n");

    const result = await service.setProviderProxies(ACTOR, "madefaka", pasted, REQUEST);

    expect(result.accepted).toBe(MAX_PROXIES_PER_PROVIDER);
    expect(result.rejected[0]).toMatch(/3 more were ignored/);
  });
});

describe("setProviderProxies — clearing", () => {
  it("returns the provider to direct egress on an empty body", async () => {
    db.findUnique.mockResolvedValue(configRow({ proxyCipher: "old-cipher", proxyHint: "x" }));

    const result = await service.setProviderProxies(ACTOR, "madefaka", "", REQUEST);

    expect(db.update.mock.calls[0]![0].data).toEqual({ proxyCipher: null, proxyHint: "" });
    expect(result).toMatchObject({ accepted: 0, hint: "", rejected: [] });
  });

  it("treats a comment-only paste as a clear rather than an error", async () => {
    const result = await service.setProviderProxies(ACTOR, "madefaka", "# none for now", REQUEST);

    expect(db.update.mock.calls[0]![0].data).toEqual({ proxyCipher: null, proxyHint: "" });
    expect(result.rejected).toEqual([]);
  });
});

describe("setProviderProxies — which row it writes", () => {
  it("creates the first row for a builtin without making it an adapter", async () => {
    // `custom: false` is what keeps a builtin out of adapter composition: the row contributes a
    // proxy list, and the credential stays in the environment where it already is.
    db.findUnique.mockResolvedValue(null);

    await service.setProviderProxies(ACTOR, "madefaka", "http://a.example:8080", REQUEST);

    expect(db.update).not.toHaveBeenCalled();
    expect(db.create.mock.calls[0]![0].data).toMatchObject({
      provider: "madefaka",
      label: "Madefaka",
      kind: "openai",
      envVar: "MADEFAKA_API_KEY",
      custom: false,
      enabled: true,
    });
  });

  it("records an anthropic builtin's kind correctly", async () => {
    db.findUnique.mockResolvedValue(null);
    resolveProvider.mockResolvedValue({ ...builtin("anthropic"), label: "Anthropic" });

    await service.setProviderProxies(ACTOR, "anthropic", "http://a.example:8080", REQUEST);

    expect(db.create.mock.calls[0]![0].data).toMatchObject({ kind: "anthropic" });
  });

  it("configures a disabled custom provider, which has a row but no registry entry", async () => {
    resolveProvider.mockResolvedValue(null);
    db.findUnique.mockResolvedValue(configRow({ provider: "retired", custom: true }));

    await service.setProviderProxies(ACTOR, "retired", "http://a.example:8080", REQUEST);

    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("404s a provider that is neither registered nor configured", async () => {
    resolveProvider.mockResolvedValue(null);
    db.findUnique.mockResolvedValue(null);

    await expect(
      service.setProviderProxies(ACTOR, "ghost", "http://a.example:8080", REQUEST),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(db.create).not.toHaveBeenCalled();
  });

  it("drops the adapter cache so the next request dials through the new list", async () => {
    await service.setProviderProxies(ACTOR, "madefaka", "http://a.example:8080", REQUEST);

    expect(invalidateProviderCache).toHaveBeenCalledTimes(1);
  });
});
