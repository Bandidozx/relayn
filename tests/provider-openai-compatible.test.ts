/**
 * The generic OpenAI-compatible adapter: catalogue normalisation and upstream failure mapping.
 *
 * Two things are worth pinning down here. First, price units — `/models` payloads publish USD
 * per *token* (OpenRouter) or per *million* (most gateways), and the catalogue stores per
 * million. Getting that wrong is a 1,000,000× cost error, not a cosmetic one. Second, an
 * absent price must stay absent: writing a confident `0` would meter a paid model as free.
 */
import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "@/lib/providers/openai-compatible";
import { ProviderError } from "@/lib/providers/types";

function provider(overrides: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {}) {
  return new OpenAiCompatibleProvider({
    id: "testgw",
    label: "Test Gateway",
    credentialEnvVar: "TESTGW_API_KEY",
    baseUrl: "https://gw.example/v1",
    apiKey: "sk-test",
    ...overrides,
  });
}

/** Stubs a single upstream response and returns the fetch spy for URL/header assertions. */
function stubFetch(body: unknown, init: { status?: number } = {}) {
  const spy = vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("listModels — catalogue normalisation", () => {
  it("reads a per-million price as-is", async () => {
    stubFetch({
      data: [{ id: "acme/big", pricing: { input_per_mtok: "1.254", output_per_mtok: "3.762" } }],
    });
    const [model] = await provider().listModels();
    expect(model?.inputPrice).toBe(1.254);
    expect(model?.outputPrice).toBe(3.762);
  });

  it("scales an OpenRouter per-token price up to per-million", async () => {
    // $0.0000005 / token = $0.50 / 1M tokens.
    stubFetch({ data: [{ id: "acme/or", pricing: { prompt: "0.0000005", completion: "0.0000015" } }] });
    const [model] = await provider().listModels();
    expect(model?.inputPrice).toBeCloseTo(0.5, 10);
    expect(model?.outputPrice).toBeCloseTo(1.5, 10);
  });

  it("leaves the price absent when the upstream publishes none", async () => {
    // Absent must not become 0: a 0 would be stored as a real price and meter a paid model
    // as free forever, silently.
    stubFetch({ data: [{ id: "f/mystery", object: "model", owned_by: "f" }] });
    const [model] = await provider().listModels();
    expect(model).toBeDefined();
    expect("inputPrice" in model!).toBe(false);
    expect("outputPrice" in model!).toBe(false);
    expect("contextWindow" in model!).toBe(false);
  });

  it("keeps a published zero as a real zero", async () => {
    stubFetch({ data: [{ id: "acme/free", pricing: { input_per_mtok: "0", output_per_mtok: "0" } }] });
    const [model] = await provider().listModels();
    expect(model?.inputPrice).toBe(0);
    expect(model?.outputPrice).toBe(0);
  });

  it("takes the context window from whichever field the gateway uses", async () => {
    stubFetch({
      data: [
        { id: "a", context_length: 128_000 },
        { id: "b", context_window: 200_000 },
        { id: "c", top_provider: { context_length: 1_000_000, max_completion_tokens: 64_000 } },
      ],
    });
    const models = await provider().listModels();
    expect(models.map((model) => model.contextWindow)).toEqual([128_000, 200_000, 1_000_000]);
    expect(models[2]?.maxOutputTokens).toBe(64_000);
  });

  it("accepts a bare array as well as a { data } envelope", async () => {
    stubFetch([{ id: "acme/one" }, { id: "acme/two" }]);
    const models = await provider().listModels();
    expect(models.map((model) => model.id)).toEqual(["acme/one", "acme/two"]);
  });

  it("skips entries with no usable id instead of creating junk rows", async () => {
    stubFetch({ data: [{ id: "acme/ok" }, { id: "" }, { object: "model" }, { id: 42 }] });
    const models = await provider().listModels();
    expect(models.map((model) => model.id)).toEqual(["acme/ok"]);
  });

  it("defaults ownedBy to the provider id and ignores unparsable numbers", async () => {
    stubFetch({ data: [{ id: "acme/x", context_length: "not-a-number" }] });
    const [model] = await provider().listModels();
    expect(model?.ownedBy).toBe("testgw");
    expect("contextWindow" in model!).toBe(false);
  });

  it("calls /models on the configured base URL with the credential attached", async () => {
    const spy = stubFetch({ data: [] });
    await provider().listModels();
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("refuses to run without a credential rather than calling the upstream anonymously", async () => {
    const spy = stubFetch({ data: [] });
    await expect(provider({ apiKey: "" }).listModels()).rejects.toMatchObject({
      code: "provider_unconfigured",
      httpStatus: 503,
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("upstream failure mapping", () => {
  const cases = [
    { status: 401, code: "upstream_unauthorized", httpStatus: 502 },
    { status: 403, code: "upstream_unauthorized", httpStatus: 502 },
    { status: 402, code: "upstream_out_of_credit", httpStatus: 502 },
    { status: 429, code: "upstream_rate_limited", httpStatus: 429 },
    { status: 404, code: "model_unavailable", httpStatus: 502 },
    { status: 400, code: "invalid_request", httpStatus: 400 },
    { status: 500, code: "upstream_error", httpStatus: 502 },
  ] as const;

  for (const expected of cases) {
    it(`maps upstream ${expected.status} to ${expected.code}`, async () => {
      stubFetch(
        { error: { message: "upstream said so", type: "some_upstream_type" } },
        { status: expected.status },
      );
      const error = await provider()
        .listModels()
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({
        code: expected.code,
        httpStatus: expected.httpStatus,
        upstreamStatus: expected.status,
      });
    });
  }

  it("keeps the upstream's own wording so the usage row says which problem it was", async () => {
    // A credential that authenticates but has no balance is a different operator action from
    // a credential that is simply wrong; a flat "upstream error" loses that distinction.
    stubFetch(
      {
        error: {
          message: "Your lifetime token allocation is exhausted; an administrator must add more tokens",
          type: "user_token_limit_exhausted",
        },
      },
      { status: 402 },
    );
    const error = (await provider()
      .listModels()
      .catch((caught: unknown) => caught)) as ProviderError;

    expect(error.code).toBe("upstream_out_of_credit");
    expect(error.message).toContain("Test Gateway has no remaining balance");
    expect(error.message).toContain("lifetime token allocation is exhausted");
  });

  it("names the env var to fix when the credential is rejected", async () => {
    stubFetch({ error: { message: "invalid api key" } }, { status: 401 });
    const error = (await provider()
      .listModels()
      .catch((caught: unknown) => caught)) as ProviderError;
    expect(error.message).toContain("TESTGW_API_KEY");
  });

  it("falls back to the raw body when the upstream error is not JSON", async () => {
    stubFetch("<html>502 Bad Gateway</html>", { status: 502 });
    const error = (await provider()
      .listModels()
      .catch((caught: unknown) => caught)) as ProviderError;
    expect(error.code).toBe("upstream_error");
    expect(error.message).toContain("502 Bad Gateway");
  });
});

/**
 * Usage reconciliation. These numbers are the ones the dashboard renders and the ones a
 * caller's token allocation is debited by, so a gateway that publishes an implausible usage
 * block must not be taken at its word.
 */
describe("usage reconciliation", () => {
  const messages = [{ role: "user" as const, content: "Reply with exactly: RELAYN-OK" }];

  function completion(body: unknown) {
    stubFetch(body);
    return provider().chatCompletion(
      { model: "testgw/x", messages },
      { upstreamModel: "x" },
    );
  }

  it("uses the upstream's own counts when they are plausible", async () => {
    const result = await completion({
      choices: [{ message: { content: "RELAYN-OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 92, completion_tokens: 22, total_tokens: 114 },
    });
    expect(result.usage).toEqual({ inputTokens: 92, outputTokens: 22, totalTokens: 114 });
    expect(result.usageEstimated).toBe(false);
  });

  it("derives output tokens from the total when completion_tokens is missing", async () => {
    const result = await completion({
      choices: [{ message: { content: "RELAYN-OK" } }],
      usage: { prompt_tokens: 90, total_tokens: 114 },
    });
    expect(result.usage.outputTokens).toBe(24);
    expect(result.usageEstimated).toBe(false);
  });

  it("estimates output when the upstream reports zero next to real content", async () => {
    // jerouter does exactly this: total_tokens == prompt_tokens, completion_tokens 0, and a
    // full answer in the body. Recording 0 output would under-debit the caller's allocation.
    const result = await completion({
      choices: [{ message: { content: "one two three four five six seven eight" } }],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    });
    expect(result.usage.inputTokens).toBe(10); // reported prompt count is still trusted
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBe(10 + result.usage.outputTokens);
    expect(result.usageEstimated).toBe(true);
  });

  it("leaves a genuinely empty response at zero output tokens", async () => {
    // Tool-call-only replies emit no text; zero is the right answer, not a suspicious one.
    const result = await completion({
      choices: [{ message: { content: "", tool_calls: [{ id: "call_1" }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 40, completion_tokens: 0, total_tokens: 40 },
    });
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usageEstimated).toBe(false);
    expect(result.toolCalls).toHaveLength(1);
  });

  it("estimates both halves when the upstream publishes no usage at all", async () => {
    const result = await completion({ choices: [{ message: { content: "RELAYN-OK" } }] });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usageEstimated).toBe(true);
  });

  it("applies the same reconciliation to the streamed terminal usage chunk", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"one two three four five six seven eight"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":0,"total_tokens":10}}',
      "data: [DONE]",
    ].join("\n\n");
    stubFetch(sse);

    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
    for await (const chunk of provider().streamChatCompletion(
      { model: "testgw/x", messages, stream: true },
      { upstreamModel: "x" },
    )) {
      if (chunk.usage) usage = chunk.usage;
    }

    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBeGreaterThan(0);
  });
});

describe("getModel", () => {
  it("normalises a single-model lookup the same way as the catalogue", async () => {
    stubFetch({ id: "acme/x", pricing: { input_per_mtok: "2" }, context_length: 64_000 });
    const model = await provider().getModel("acme/x");
    expect(model).toMatchObject({ id: "acme/x", inputPrice: 2, contextWindow: 64_000 });
  });

  it("returns null for an unknown model rather than throwing", async () => {
    stubFetch({ error: { message: "no such model" } }, { status: 404 });
    expect(await provider().getModel("acme/nope")).toBeNull();
  });

  it("returns null when the provider has no credential", async () => {
    const spy = stubFetch({});
    expect(await provider({ apiKey: "" }).getModel("acme/x")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
