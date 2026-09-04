/**
 * The Anthropic adapter, exercised as what it now is: a dialect, not a vendor.
 *
 * Since Admin → Providers can add an `anthropic`-kind upstream, this class runs with a
 * caller-supplied id, label and credential — so the cases here pin the parts a reseller row
 * depends on: catalogue pagination that terminates, `ownedBy` carrying the *row's* id (it
 * becomes the model-id prefix, so getting it wrong misroutes every request), and unauthorized
 * errors that name the right thing to fix when there is no environment variable to name.
 */
import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "@/lib/providers/anthropic";
import { ProviderError } from "@/lib/providers/types";

function provider(overrides: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) {
  return new AnthropicProvider({
    baseUrl: "https://claude.example/v1",
    apiKey: "sk-ant-test",
    ...overrides,
  });
}

function json(body: unknown, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stubs one response per call, repeating the last one once the script runs out. */
function stubFetch(...pages: Array<{ body: unknown; status?: number }>) {
  let call = 0;
  const spy = vi.fn(async () => {
    const page = pages[Math.min(call, pages.length - 1)] ?? { body: {} };
    call += 1;
    return json(page.body, page.status ?? 200);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** URLs the adapter requested, as strings (it builds `URL` objects for the catalogue). */
function urls(spy: ReturnType<typeof stubFetch>): string[] {
  return spy.mock.calls.map((call) => String((call as unknown as [string | URL])[0]));
}

describe("listModels", () => {
  it("maps display_name to name and leaves it absent when the upstream omits it", async () => {
    stubFetch({
      body: {
        data: [
          { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" },
          { id: "claude-haiku-4-5" },
        ],
        has_more: false,
      },
    });
    const models = await provider().listModels();
    expect(models[0]).toEqual({ id: "claude-sonnet-4-5", ownedBy: "anthropic", name: "Claude Sonnet 4.5" });
    expect(models[1]).toEqual({ id: "claude-haiku-4-5", ownedBy: "anthropic" });
    expect("name" in models[1]!).toBe(false);
  });

  it("stamps ownedBy with the row's id, which becomes the model-id prefix", async () => {
    stubFetch({ body: { data: [{ id: "big-model" }], has_more: false } });
    const [model] = await provider({ id: "acme", label: "Acme Claude" }).listModels();
    expect(model?.ownedBy).toBe("acme");
  });

  it("requests one page of 100 and asks for the credential's own dialect headers", async () => {
    const spy = stubFetch({ body: { data: [], has_more: false } });
    await provider().listModels();
    expect(urls(spy)).toEqual(["https://claude.example/v1/models?limit=100"]);
    const [, init] = spy.mock.calls[0] as unknown as [unknown, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
  });

  it("follows last_id until has_more goes false", async () => {
    const spy = stubFetch(
      { body: { data: [{ id: "one" }], has_more: true, last_id: "one" } },
      { body: { data: [{ id: "two" }], has_more: true, last_id: "two" } },
      { body: { data: [{ id: "three" }], has_more: false, last_id: "three" } },
    );
    const models = await provider().listModels();
    expect(models.map((model) => model.id)).toEqual(["one", "two", "three"]);
    expect(urls(spy)).toEqual([
      "https://claude.example/v1/models?limit=100",
      "https://claude.example/v1/models?limit=100&after_id=one",
      "https://claude.example/v1/models?limit=100&after_id=two",
    ]);
  });

  it("stops when has_more is true but no cursor came back", async () => {
    // Otherwise the same page would be re-requested until the cap.
    const spy = stubFetch({ body: { data: [{ id: "one" }], has_more: true } });
    const models = await provider().listModels();
    expect(models).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("caps pagination so a misbehaving upstream cannot spin forever", async () => {
    const spy = stubFetch({ body: { data: [{ id: "endless" }], has_more: true, last_id: "endless" } });
    const models = await provider().listModels();
    expect(spy).toHaveBeenCalledTimes(10);
    expect(models).toHaveLength(10);
  });

  it("skips entries with no usable id instead of creating junk rows", async () => {
    stubFetch({ body: { data: [{ id: "ok" }, { id: "" }, { display_name: "no id" }, { id: 42 }], has_more: false } });
    const models = await provider().listModels();
    expect(models.map((model) => model.id)).toEqual(["ok"]);
  });

  it("tolerates a response with no data array", async () => {
    stubFetch({ body: { has_more: false } });
    expect(await provider().listModels()).toEqual([]);
  });
});

describe("listModels — failure mapping", () => {
  it("refuses to run without a credential rather than calling the upstream anonymously", async () => {
    const spy = stubFetch({ body: { data: [] } });
    await expect(provider({ apiKey: "" }).listModels()).rejects.toMatchObject({
      code: "provider_unconfigured",
      httpStatus: 503,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("names the env var to fix for a builtin", async () => {
    stubFetch({ body: { error: { message: "invalid x-api-key" } }, status: 401 });
    const error = (await provider()
      .listModels()
      .catch((caught: unknown) => caught)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe("upstream_unauthorized");
    expect(error.upstreamStatus).toBe(401);
    expect(error.message).toContain("ANTHROPIC_API_KEY");
  });

  it("points a dashboard-added provider at the dashboard instead of a nonexistent env var", async () => {
    stubFetch({ body: {}, status: 403 });
    const error = (await provider({ id: "acme", label: "Acme Claude", credentialEnvVar: "" })
      .listModels()
      .catch((caught: unknown) => caught)) as ProviderError;
    expect(error.message).toContain("Acme Claude");
    expect(error.message).toContain("Admin → Providers");
    expect(error.message).not.toContain("()");
  });

  it("keeps the upstream status and body on any other failure", async () => {
    stubFetch({ body: "<html>502 Bad Gateway</html>", status: 502 });
    const error = (await provider()
      .listModels()
      .catch((caught: unknown) => caught)) as ProviderError;
    expect(error.code).toBe("upstream_error");
    expect(error.httpStatus).toBe(502);
    expect(error.upstreamStatus).toBe(502);
    expect(error.message).toContain("returned 502");
    expect(error.message).toContain("Bad Gateway");
  });
});

describe("chatCompletion — dialect translation", () => {
  /** Returns the JSON body the adapter posted. */
  async function sent(messages: Array<{ role: string; content: string }>, extra: Record<string, unknown> = {}) {
    const spy = stubFetch({
      body: {
        id: "msg_1",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "RELAYN-OK" }],
        usage: { input_tokens: 11, output_tokens: 4 },
      },
    });
    const result = await provider().chatCompletion(
      { model: "anthropic/claude-sonnet-4-5", messages: messages as never, ...extra },
      { upstreamModel: "claude-sonnet-4-5" },
    );
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    return { url, body: JSON.parse(init.body as string) as Record<string, unknown>, result };
  }

  it("hoists system turns to the top-level system field", async () => {
    const { url, body } = await sent([
      { role: "system", content: "Be terse." },
      { role: "developer", content: "Answer in English." },
      { role: "user", content: "Hi" },
    ]);
    expect(url).toBe("https://claude.example/v1/messages");
    expect(body.system).toBe("Be terse.\n\nAnswer in English.");
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(body.max_tokens).toBe(4096);
    expect(body.stream).toBe(false);
  });

  it("never sends an empty messages array, which the dialect rejects", async () => {
    const { body } = await sent([{ role: "system", content: "Only a system prompt." }]);
    expect(body.messages).toEqual([{ role: "user", content: "" }]);
  });

  it("passes the caller's own max_tokens and sampling through", async () => {
    const { body } = await sent([{ role: "user", content: "Hi" }], {
      max_tokens: 64,
      temperature: 0.2,
      stop: "STOP",
    });
    expect(body.max_tokens).toBe(64);
    expect(body.temperature).toBe(0.2);
    expect(body.stop_sequences).toEqual(["STOP"]);
  });

  it("trusts the upstream's own token counts when it publishes them", async () => {
    const { result } = await sent([{ role: "user", content: "Hi" }]);
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 4, totalTokens: 15 });
    expect(result.usageEstimated).toBe(false);
    expect(result.content).toBe("RELAYN-OK");
  });

  it("estimates and says so when the upstream publishes no usage", async () => {
    stubFetch({ body: { id: "msg_2", content: [{ type: "text", text: "a longer answer here" }] } });
    const result = await provider().chatCompletion(
      { model: "anthropic/x", messages: [{ role: "user", content: "Hi" }] },
      { upstreamModel: "x" },
    );
    expect(result.usageEstimated).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it("reports a truncated answer as finishReason length", async () => {
    stubFetch({ body: { content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens" } });
    const result = await provider().chatCompletion(
      { model: "anthropic/x", messages: [{ role: "user", content: "Hi" }] },
      { upstreamModel: "x" },
    );
    expect(result.finishReason).toBe("length");
  });
});

describe("healthCheck", () => {
  it("phrases the unconfigured reason for whichever kind of provider it is", async () => {
    expect(await provider({ apiKey: "" }).healthCheck()).toEqual({
      state: "unconfigured",
      detail: "ANTHROPIC_API_KEY is not set.",
    });
    expect(await provider({ apiKey: "", credentialEnvVar: "" }).healthCheck()).toEqual({
      state: "unconfigured",
      detail: "No API key is stored for this provider.",
    });
  });

  it("reports ok with a latency when the catalogue answers", async () => {
    stubFetch({ body: { data: [] } });
    const health = await provider().healthCheck();
    expect(health.state).toBe("ok");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports degraded with the status rather than failing the page", async () => {
    stubFetch({ body: {}, status: 500 });
    expect(await provider().healthCheck()).toMatchObject({
      state: "degraded",
      detail: "Catalogue probe returned 500.",
    });
  });

  it("reports down when the upstream cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    expect(await provider().healthCheck()).toMatchObject({ state: "down", detail: "Catalogue probe failed." });
  });
});

describe("getModel", () => {
  it("returns the upstream id, owned by this provider", async () => {
    const spy = stubFetch({ body: { id: "claude-opus-4-1" } });
    expect(await provider({ id: "acme" }).getModel("claude-opus-4-1")).toEqual({
      id: "claude-opus-4-1",
      ownedBy: "acme",
    });
    expect(urls(spy)).toEqual(["https://claude.example/v1/models/claude-opus-4-1"]);
  });

  it("returns null for an unknown model, and without a credential", async () => {
    stubFetch({ body: {}, status: 404 });
    expect(await provider().getModel("nope")).toBeNull();

    const spy = stubFetch({ body: { id: "x" } });
    expect(await provider({ apiKey: "" }).getModel("x")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
