/**
 * Provider registry composition — how a `provider_configs` row becomes a routable upstream.
 *
 * The cases with security weight are the ones spelled out here: a database row must never be
 * able to claim `openai` and quietly redirect that traffic somewhere else, a stored header must
 * never be able to replace the credential the adapter just decrypted, and a credential that
 * will not decrypt must degrade to an unconfigured provider rather than throw from inside the
 * gateway's hot path.
 *
 * `@/lib/db` builds its PrismaClient at import time, so it is mocked; `env` snapshots
 * `process.env` at import time, so each case re-imports the graph after stubbing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderRow } from "@/lib/providers/registry";
import type { ModelProvider } from "@/lib/providers/types";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { providerConfig: { findMany } } }));

const KEY = "c3".repeat(32);

interface Loaded {
  registry: typeof import("@/lib/providers/registry");
  seal: (value: string) => string;
  /** Rows the next snapshot load will see. */
  rows: (...rows: CustomProviderRow[]) => void;
}

/** Fresh module graph with a known credential key and a controllable `provider_configs`. */
async function load(overrides: Record<string, string> = {}): Promise<Loaded> {
  vi.stubEnv("SESSION_SECRET", "s".repeat(48));
  vi.stubEnv("PROVIDER_CREDENTIAL_KEY", KEY);
  vi.stubEnv("OPENAI_API_KEY", "sk-builtin-openai");
  vi.stubEnv("OPENAI_BASE_URL", "https://builtin.openai.test/v1");
  for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value);

  vi.resetModules();
  const box = await import("@/lib/security/secret-box");
  box.resetSecretBoxKey();
  const registry = await import("@/lib/providers/registry");
  registry.invalidateProviderCache();
  findMany.mockReset();
  findMany.mockResolvedValue([]);

  return {
    registry,
    seal: box.sealSecret,
    rows: (...rows) => {
      findMany.mockReset();
      findMany.mockResolvedValue(rows);
      registry.invalidateProviderCache();
    },
  };
}

/** A `provider_configs` row with exactly the fields `loadSnapshot` selects. */
function row(overrides: Partial<CustomProviderRow> = {}): CustomProviderRow {
  return {
    provider: "acme",
    label: "Acme Gateway",
    baseUrl: "https://gateway.acme.test/v1",
    kind: "openai",
    apiKeyCipher: null,
    extraHeaders: "",
    custom: true,
    enabled: true,
    proxyCipher: null,
    ...overrides,
  };
}

/** Stubs one upstream response and returns the spy, for URL and header assertions. */
function stubFetch(body: unknown = { data: [] }) {
  const spy = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** The headers a provider actually puts on the wire. `url` may be a string or a `URL`. */
async function sentHeaders(provider: ModelProvider) {
  const spy = stubFetch();
  // Both adapters implement the catalogue call; a provider without one would fail obscurely.
  expect(provider.listModels).toBeTypeOf("function");
  await provider.listModels!();
  const [url, init] = spy.mock.calls[0] as unknown as [string | URL, RequestInit];
  return { url: String(url), headers: init.headers as Record<string, string> };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("isProviderKind", () => {
  it("accepts only the two dialects that have an adapter", async () => {
    const { registry } = await load();
    expect(registry.isProviderKind("openai")).toBe(true);
    expect(registry.isProviderKind("anthropic")).toBe(true);
    for (const bad of ["google", "gemini", "", "OpenAI", null, 1, undefined]) {
      expect(registry.isProviderKind(bad)).toBe(false);
    }
  });
});

describe("reserved ids", () => {
  it("refuses every id this deployment already means", async () => {
    const { registry } = await load();
    for (const id of ["openai", "anthropic", "google", "openrouter", "mock", "jerouter", "madefaka"]) {
      expect(registry.isReservedProviderId(id)).toBe(true);
    }
    expect(registry.isReservedProviderId("acme")).toBe(false);
    expect(registry.isReservedProviderId("openai-eu")).toBe(false);
  });

  it("lists them sorted, for the operator-facing error message", async () => {
    const { registry } = await load();
    const ids = registry.reservedProviderIds();
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain("madefaka");
  });
});

describe("parseExtraHeaders", () => {
  it("returns nothing for an empty or unparsable value", async () => {
    const { registry } = await load();
    for (const bad of ["", "   ", "not json", "[1,2]", "null", '"a string"', "42"]) {
      expect(registry.parseExtraHeaders(bad)).toEqual({});
    }
  });

  it("lowercases names and keeps string values", async () => {
    const { registry } = await load();
    expect(registry.parseExtraHeaders('{"X-Source":"relayn","x-tier":"paid"}')).toEqual({
      "x-source": "relayn",
      "x-tier": "paid",
    });
  });

  it("drops every header that could override the credential or the body framing", async () => {
    const { registry } = await load();
    const parsed = registry.parseExtraHeaders(
      JSON.stringify({
        Authorization: "Bearer attacker-key",
        "X-Api-Key": "attacker-key",
        "content-type": "text/plain",
        "Content-Length": "0",
        accept: "text/event-stream",
        "anthropic-version": "1999-01-01",
        Host: "evil.test",
        "x-kept": "yes",
      }),
    );
    expect(parsed).toEqual({ "x-kept": "yes" });
  });
});

describe("parseExtraHeaders — value and name hygiene", () => {
  it("drops values carrying CR or LF, which are header-injection primitives", async () => {
    const { registry } = await load();
    const parsed = registry.parseExtraHeaders(
      JSON.stringify({
        "x-clean": "fine",
        "x-crlf": "a\r\nauthorization: Bearer attacker",
        "x-lf": "a\nb",
      }),
    );
    expect(parsed).toEqual({ "x-clean": "fine" });
  });

  it("drops non-string values rather than coercing them", async () => {
    const { registry } = await load();
    const parsed = registry.parseExtraHeaders(
      JSON.stringify({ "x-num": 7, "x-bool": true, "x-null": null, "x-obj": { a: 1 }, "x-ok": "1" }),
    );
    expect(parsed).toEqual({ "x-ok": "1" });
  });

  it("drops names outside the HTTP token charset", async () => {
    const { registry } = await load();
    const parsed = registry.parseExtraHeaders(
      JSON.stringify({ "x bad": "1", "x:bad": "1", "x/bad": "1", "": "1", "x-good": "1" }),
    );
    expect(parsed).toEqual({ "x-good": "1" });
  });
});

describe("providerFromRow", () => {
  it("builds an OpenAI-compatible adapter that calls the row's base URL", async () => {
    const { registry, seal } = await load();
    const { provider, problem } = registry.providerFromRow(
      row({ apiKeyCipher: seal("sk-acme-live") }),
    );
    expect(problem).toBeUndefined();
    expect(provider.id).toBe("acme");
    expect(provider.label).toBe("Acme Gateway");
    // No env var to point the operator at: the credential lives in the database.
    expect(provider.credentialEnvVar).toBe("");
    expect(provider.isConfigured()).toBe(true);

    const { url, headers } = await sentHeaders(provider);
    expect(url).toBe("https://gateway.acme.test/v1/models");
    expect(headers.authorization).toBe("Bearer sk-acme-live");
  });

  it("builds an Anthropic adapter, with that dialect's auth headers", async () => {
    const { registry, seal } = await load();
    const { provider } = registry.providerFromRow(
      row({ kind: "anthropic", baseUrl: "https://claude.acme.test/v1", apiKeyCipher: seal("sk-ant-live") }),
    );
    const { url, headers } = await sentHeaders(provider);
    expect(url).toContain("https://claude.acme.test/v1/models");
    expect(headers["x-api-key"]).toBe("sk-ant-live");
    expect(headers["anthropic-version"]).toBeTruthy();
    expect(headers.authorization).toBeUndefined();
  });
});

describe("providerFromRow — defaults and degraded rows", () => {
  it("falls back to the OpenAI dialect for a kind it does not recognise", async () => {
    const { registry, seal } = await load();
    // A row written by an older release, or edited straight in the database.
    const { provider } = registry.providerFromRow(
      row({ kind: "cohere", apiKeyCipher: seal("sk-unknown-kind") }),
    );
    const { headers } = await sentHeaders(provider);
    expect(headers.authorization).toBe("Bearer sk-unknown-kind");
  });

  it("supplies the dialect's own default base URL when the row has none", async () => {
    const { registry, seal } = await load();
    const openai = registry.providerFromRow(
      row({ baseUrl: null, apiKeyCipher: seal("sk-a") }),
    ).provider;
    const anthropic = registry.providerFromRow(
      row({ provider: "ant", kind: "anthropic", baseUrl: "   ", apiKeyCipher: seal("sk-b") }),
    ).provider;

    expect((await sentHeaders(openai)).url).toBe("https://api.openai.com/v1/models");
    expect((await sentHeaders(anthropic)).url).toContain("https://api.anthropic.com/v1/models");
  });

  it("attaches surviving extra headers and never the protected ones", async () => {
    const { registry, seal } = await load();
    const { provider } = registry.providerFromRow(
      row({
        apiKeyCipher: seal("sk-real-credential"),
        extraHeaders: '{"x-source":"relayn","Authorization":"Bearer attacker-key"}',
      }),
    );
    const { headers } = await sentHeaders(provider);
    expect(headers["x-source"]).toBe("relayn");
    // The decrypted credential wins: a stored header cannot swap it out.
    expect(headers.authorization).toBe("Bearer sk-real-credential");
  });

  it("reports a missing credential instead of building a usable provider", async () => {
    const { registry } = await load();
    const { provider, problem } = registry.providerFromRow(row({ apiKeyCipher: null }));
    expect(problem).toBe("No API key is stored for this provider.");
    expect(provider.isConfigured()).toBe(false);
  });

  it("reports an undecryptable credential as an actionable problem, not a throw", async () => {
    const { seal } = await load();
    const sealed = seal("sk-sealed-with-old-key");
    // Same row, different PROVIDER_CREDENTIAL_KEY: what a key rotation leaves behind.
    const { registry } = await load({ PROVIDER_CREDENTIAL_KEY: "d4".repeat(32) });
    const { provider, problem } = registry.providerFromRow(row({ apiKeyCipher: sealed }));
    expect(problem).toMatch(/re-enter it/);
    expect(provider.isConfigured()).toBe(false);
  });
});

describe("snapshot composition", () => {
  it("routes to a custom row and marks it custom", async () => {
    const { registry, seal, rows } = await load();
    rows(row({ apiKeyCipher: seal("sk-acme-live") }));

    const provider = await registry.resolveProvider("acme");
    expect(provider?.label).toBe("Acme Gateway");
    expect(await registry.isCustomProvider("acme")).toBe(true);
    expect((await registry.listProviders()).map((entry) => entry.id)).toContain("acme");
  });

  it("never routes a disabled custom row, whatever the query returns", async () => {
    // This used to pin the `where` clause. It no longer can: the read was widened to an OR so a
    // *builtin's* annotation row — `custom: false`, carrying nothing but a proxy list — could be
    // found at all. So the rule is asserted where it actually lives, on composition: a disabled
    // row is skipped even when the query hands it over.
    const { registry, seal, rows } = await load();
    rows(row({ enabled: false, apiKeyCipher: seal("sk-acme-live") }));

    expect(await registry.resolveProvider("acme")).toBeNull();
    expect((await registry.listProviders()).map((entry) => entry.id)).not.toContain("acme");
    expect(await registry.isCustomProvider("acme")).toBe(false);
  });

  it("reads a builtin's annotation row, which is why the filter is an OR", async () => {
    const { registry, rows } = await load();
    rows();
    await registry.listProviders();

    const where = findMany.mock.calls[0]![0].where as {
      OR: Array<Record<string, unknown>>;
    };
    expect(where.OR).toEqual([{ custom: true, enabled: true }, { proxyCipher: { not: null } }]);
  });

  it("does not turn a builtin's annotation row into an adapter", async () => {
    // `custom: false` contributes a proxy list and nothing else. If this row could compose, a
    // dashboard write would be able to re-point builtin traffic — the shadowing case, by a
    // different door.
    const { registry, seal, rows } = await load();
    rows(
      row({
        provider: "madefaka",
        custom: false,
        label: "Not Madefaka",
        baseUrl: "https://evil.test/v1",
        apiKeyCipher: seal("sk-attacker"),
      }),
    );

    expect(await registry.isCustomProvider("madefaka")).toBe(false);
  });

  it("never lets a row shadow a builtin id", async () => {
    const { registry, seal, rows } = await load();
    rows(
      row({
        provider: "openai",
        label: "Not OpenAI",
        baseUrl: "https://evil.test/v1",
        apiKeyCipher: seal("sk-attacker"),
      }),
    );

    const provider = await registry.resolveProvider("openai");
    expect(provider?.label).toBe("OpenAI");
    expect(await registry.isCustomProvider("openai")).toBe(false);
    const { url, headers } = await sentHeaders(provider!);
    expect(url).toBe("https://builtin.openai.test/v1/models");
    expect(headers.authorization).toBe("Bearer sk-builtin-openai");
  });

  it("returns null for an id nothing serves", async () => {
    const { registry } = await load();
    expect(await registry.resolveProvider("nobody")).toBeNull();
  });

  it("still serves builtins when the database read fails", async () => {
    // The gateway's own traffic does not depend on custom providers existing.
    const { registry } = await load();
    findMany.mockReset();
    findMany.mockRejectedValue(new Error("connection terminated unexpectedly"));
    registry.invalidateProviderCache();

    expect((await registry.resolveProvider("openai"))?.label).toBe("OpenAI");
    expect(await registry.resolveProvider("acme")).toBeNull();
  });
});

describe("caching", () => {
  it("reads the database once for many resolutions", async () => {
    const { registry, rows } = await load();
    rows(row({ apiKeyCipher: null }));
    await registry.resolveProvider("acme");
    await registry.resolveProvider("openai");
    await registry.listProviders();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("shares one read between concurrent callers instead of stampeding", async () => {
    const { registry, rows } = await load();
    rows();
    await Promise.all([
      registry.resolveProvider("openai"),
      registry.resolveProvider("anthropic"),
      registry.listProviders(),
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("picks up a new row after an admin write invalidates the cache", async () => {
    const { registry, seal, rows } = await load();
    rows();
    expect(await registry.resolveProvider("acme")).toBeNull();

    rows(row({ apiKeyCipher: seal("sk-added-later") }));
    expect((await registry.resolveProvider("acme"))?.label).toBe("Acme Gateway");
  });
});

describe("providerStatuses", () => {
  it("reports a working custom provider as configured, without probing it", async () => {
    const spy = stubFetch();
    const { registry, seal, rows } = await load();
    rows(row({ apiKeyCipher: seal("sk-acme-live") }));

    const status = (await registry.providerStatuses()).find((entry) => entry.id === "acme");
    expect(status).toMatchObject({
      label: "Acme Gateway",
      credentialEnvVar: "",
      configured: true,
      custom: true,
      health: { state: "ok" },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces the row's own problem as the unconfigured reason", async () => {
    const { registry, rows } = await load();
    rows(row({ apiKeyCipher: null }));

    const status = (await registry.providerStatuses()).find((entry) => entry.id === "acme");
    expect(status?.configured).toBe(false);
    expect(status?.health).toEqual({
      state: "unconfigured",
      detail: "No API key is stored for this provider.",
    });
  });

  it("names the env var for a builtin that has none set", async () => {
    const { registry } = await load({ ANTHROPIC_API_KEY: "" });
    const status = (await registry.providerStatuses()).find((entry) => entry.id === "anthropic");
    expect(status).toMatchObject({
      custom: false,
      configured: false,
      credentialEnvVar: "ANTHROPIC_API_KEY",
      health: { state: "unconfigured", detail: "ANTHROPIC_API_KEY is not set." },
    });
  });

  it("never exposes a credential value in a status row", async () => {
    const { registry, seal, rows } = await load();
    rows(row({ apiKeyCipher: seal("sk-acme-live") }));
    const serialised = JSON.stringify(await registry.providerStatuses());
    expect(serialised).not.toContain("sk-acme-live");
    expect(serialised).not.toContain("sk-builtin-openai");
  });
});
