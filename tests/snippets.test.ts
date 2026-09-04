/**
 * Documentation snippets.
 *
 * The spec requires that the examples on /docs and /integrations "actually work against the
 * backend API", so these are regression tests, not formatting tests. The specific bug they
 * exist to catch: the snippet helpers append `/v1` themselves, and a caller that passed
 * `${appUrl}/v1` produced `http://localhost:3200/v1/v1/chat/completions` in every sample.
 */
import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_KEY,
  anthropicSnippet,
  curlSnippet,
  curlStreamSnippet,
  envSnippet,
  fetchSnippet,
  langchainSnippet,
  listModelsSnippet,
  nodeOpenAiSnippet,
  nodeStreamSnippet,
  pythonOpenAiSnippet,
  pythonStreamSnippet,
  quickstartSnippets,
  streamingSnippets,
  type SnippetContext,
} from "@/lib/snippets";

const context: SnippetContext = {
  baseUrl: "http://localhost:3200",
  apiKey: PLACEHOLDER_KEY,
  model: "relayn-sandbox-chat",
};

const ALL = [
  curlSnippet,
  curlStreamSnippet,
  pythonOpenAiSnippet,
  pythonStreamSnippet,
  nodeOpenAiSnippet,
  nodeStreamSnippet,
  fetchSnippet,
  anthropicSnippet,
  langchainSnippet,
  listModelsSnippet,
  envSnippet,
];

describe("every snippet", () => {
  it("never doubles the API version segment", () => {
    for (const build of ALL) {
      expect(build(context), build.name).not.toContain("/v1/v1");
    }
  });

  it("points at the configured origin and nothing else", () => {
    for (const build of ALL) {
      const code = build(context);
      expect(code, build.name).toContain("localhost:3200");
      expect(code, build.name).not.toContain("api.openai.com");
      expect(code, build.name).not.toContain("api.anthropic.com");
    }
  });

  it("uses the placeholder key, never a real-looking secret", () => {
    for (const build of ALL) {
      const code = build(context);
      // Any literal key in a doc sample must be the obvious placeholder.
      const keys = code.match(/rly_live_[A-Za-z0-9_-]+/g) ?? [];
      for (const key of keys) expect(key, build.name).toBe(PLACEHOLDER_KEY);
    }
  });

  it("names the model that was passed in", () => {
    const withModel = ALL.filter((build) => build !== listModelsSnippet && build !== envSnippet);
    for (const build of withModel) {
      expect(build(context), build.name).toContain("relayn-sandbox-chat");
    }
  });
});

describe("curlSnippet", () => {
  it("targets POST /v1/chat/completions with a Bearer header", () => {
    const code = curlSnippet(context);
    expect(code).toContain("http://localhost:3200/v1/chat/completions");
    expect(code).toContain("Authorization: Bearer");
    expect(code).toContain("Content-Type: application/json");
  });

  it("sends a body that parses as the request the gateway expects", () => {
    const code = curlSnippet(context);
    const body = code.slice(code.indexOf("{"), code.lastIndexOf("}") + 1);
    const parsed = JSON.parse(body) as { model: string; messages: Array<{ role: string }> };
    expect(parsed.model).toBe("relayn-sandbox-chat");
    expect(parsed.messages.length).toBeGreaterThan(0);
    expect(parsed.messages[0]!.role).toBe("user");
  });
});

describe("streaming snippets", () => {
  it("set stream: true", () => {
    for (const build of [curlStreamSnippet, pythonStreamSnippet, nodeStreamSnippet]) {
      expect(build(context), build.name).toMatch(/stream["']?\s*[:=]\s*(true|True)/);
    }
  });

  it("the non-streaming variants do not", () => {
    for (const build of [curlSnippet, pythonOpenAiSnippet, nodeOpenAiSnippet]) {
      expect(build(context), build.name).not.toMatch(/stream["']?\s*[:=]\s*(true|True)/);
    }
  });
});

describe("SDK snippets", () => {
  it("override base_url / baseURL so the OpenAI SDK talks to this gateway", () => {
    expect(pythonOpenAiSnippet(context)).toContain("base_url");
    expect(nodeOpenAiSnippet(context)).toContain("baseURL");
    expect(pythonOpenAiSnippet(context)).toContain("http://localhost:3200/v1");
  });

  it("passes the bare origin to the Anthropic SDK, which appends /v1/messages itself", () => {
    const code = anthropicSnippet(context);
    expect(code).toContain('base_url="http://localhost:3200"');
    // Appending /v1 here would produce /v1/v1/messages once the SDK adds its own path.
    expect(code).not.toContain("localhost:3200/v1");
    expect(code).toContain("messages.create");
  });

  it("lists models from GET /v1/models", () => {
    expect(listModelsSnippet(context)).toContain("/v1/models");
  });
});

describe("envSnippet", () => {
  it("documents both variables an SDK needs", () => {
    const code = envSnippet(context);
    expect(code).toContain("http://localhost:3200/v1");
    expect(code).toContain(PLACEHOLDER_KEY);
  });
});

describe("snippet collections", () => {
  it("quickstart and streaming tabs are non-empty and uniquely labelled", () => {
    for (const collection of [quickstartSnippets(context), streamingSnippets(context)]) {
      expect(collection.length).toBeGreaterThan(0);
      const labels = collection.map((snippet) => snippet.label);
      expect(new Set(labels).size).toBe(labels.length);
      for (const snippet of collection) {
        expect(snippet.code.trim().length).toBeGreaterThan(0);
        expect(snippet.code).not.toContain("/v1/v1");
      }
    }
  });

  it("survives an origin with a trailing path-free port only", () => {
    // `env.appUrl` strips a trailing slash; assert the helpers do not reintroduce one.
    const snippets = quickstartSnippets({ ...context, baseUrl: "https://gateway.example.com" });
    for (const snippet of snippets) {
      expect(snippet.code).not.toContain("//v1");
      expect(snippet.code).not.toContain("/v1/v1");
    }
  });
});
