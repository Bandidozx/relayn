/**
 * Anthropic adapter, speaking the native `/v1/messages` dialect.
 *
 * Kept separate from the OpenAI-compatible adapter because the wire format differs in
 * three ways that matter: `system` is a top-level field rather than a message, `usage`
 * uses input/output naming, and streaming emits typed events instead of choice deltas.
 *
 * Identity is parametrised rather than fixed to "anthropic" because Anthropic's dialect is not
 * exclusive to Anthropic: resellers and self-hosted gateways expose the same `/messages` and
 * `x-api-key` contract at their own base URL. A provider added from Admin → Providers with
 * `kind: "anthropic"` is this class with a different id, label and credential.
 */
import {
  ProviderError,
  credentialLabel,
  unconfiguredRemedy,
  type ChatCompletionRequest,
  type ChatCompletionResult,
  type ChatMessage,
  type HealthStatus,
  type ModelProvider,
  type ProviderCallContext,
  type ProviderModelInfo,
  type StreamChunk,
} from "@/lib/providers/types";
import { fetchThroughPool, type ProxyPool } from "@/lib/providers/proxy";
import { buildUsage, estimatePromptTokens, estimateTextTokens } from "@/lib/usage/tokenizer";

const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
  /** Defaults to "anthropic" — the builtin. Custom rows pass their own slug. */
  id?: string;
  label?: string;
  /** "" for a runtime-added provider, whose credential is sealed in the database instead. */
  credentialEnvVar?: string;
  /** Extra headers some gateways require (e.g. a reseller's routing header). */
  extraHeaders?: Record<string, string>;
  /** Outbound proxies for this upstream. Absent means egress straight from the deployment. */
  proxyPool?: ProxyPool | null;
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((part) => part.text ?? "").join("");
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  readonly credentialEnvVar: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly proxyPool: ProxyPool | null;

  constructor(options: AnthropicOptions) {
    this.id = options.id ?? "anthropic";
    this.label = options.label ?? "Anthropic";
    this.credentialEnvVar = options.credentialEnvVar ?? "ANTHROPIC_API_KEY";
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.extraHeaders = options.extraHeaders ?? {};
    this.proxyPool = options.proxyPool ?? null;
  }

  /**
   * Single egress point for this adapter, so a configured proxy pool applies to messages,
   * catalogue reads and health probes alike rather than only the paths someone remembered.
   */
  private async egress(url: string, init: RequestInit): Promise<Response> {
    const { response } = await fetchThroughPool(url, init, this.proxyPool);
    return response;
  }

  /** True when this upstream's traffic is being routed through a proxy. */
  private get proxied(): boolean {
    return (this.proxyPool?.size ?? 0) > 0;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  private assertConfigured(): void {
    if (this.isConfigured()) return;
    throw new ProviderError(
      "provider_unconfigured",
      `${this.label} is not configured on this deployment. ${unconfiguredRemedy(this.credentialEnvVar)}`,
      503,
    );
  }

  private headers(stream: boolean): HeadersInit {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      accept: stream ? "text/event-stream" : "application/json",
      ...this.extraHeaders,
    };
  }

  private signal(context: ProviderCallContext): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
  }

  /** Splits OpenAI-shaped messages into Anthropic's system + turns layout. */
  private payload(request: ChatCompletionRequest, context: ProviderCallContext, stream: boolean) {
    const system = request.messages
      .filter((m) => m.role === "system" || m.role === "developer")
      .map((m) => textOf(m.content))
      .filter(Boolean)
      .join("\n\n");

    const turns = request.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: textOf(m.content) }));

    const body: Record<string, unknown> = {
      model: context.upstreamModel,
      max_tokens: request.max_tokens ?? DEFAULT_MAX_TOKENS,
      messages: turns.length > 0 ? turns : [{ role: "user", content: "" }],
      stream,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.stop !== undefined) {
      body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
    }
    if (request.tools !== undefined) body.tools = request.tools;
    return body;
  }

  private async post(body: unknown, stream: boolean, context: ProviderCallContext) {
    let response: Response;
    try {
      response = await this.egress(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.headers(stream),
        body: JSON.stringify(body),
        signal: this.signal(context),
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new ProviderError(
        aborted ? "upstream_timeout" : "upstream_error",
        aborted
          ? `${this.label} did not respond in time.`
          : this.proxied
            // No underlying message: a proxy connection error can echo back the proxy URL,
            // and that URL carries the operator's proxy password.
            ? `${this.label} could not be reached through its configured proxy.`
            : `${this.label} could not be reached.`,
        aborted ? 504 : 502,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        /* keep raw body */
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(
          "upstream_unauthorized",
          `${this.label} rejected Relayn's credential (${credentialLabel(this.credentialEnvVar)}). ${detail}`.trim(),
          502,
          response.status,
        );
      }
      if (response.status === 402) {
        throw new ProviderError(
          "upstream_out_of_credit",
          `${this.label} has no remaining balance for Relayn's credential. ${detail}`.trim(),
          502,
          response.status,
        );
      }
      if (response.status === 429) {
        throw new ProviderError("upstream_rate_limited", `${this.label} rate-limited this request. ${detail}`.trim(), 429, 429);
      }
      if (response.status === 404) {
        throw new ProviderError("model_unavailable", `${this.label} does not serve this model. ${detail}`.trim(), 502, 404);
      }
      if (response.status === 400) {
        throw new ProviderError("invalid_request", detail || `${this.label} rejected the request.`, 400, 400);
      }
      throw new ProviderError("upstream_error", `${this.label} returned ${response.status}. ${detail}`.trim(), 502, response.status);
    }
    return response;
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    context: ProviderCallContext,
  ): Promise<ChatCompletionResult> {
    this.assertConfigured();
    const response = await this.post(this.payload(request, context, false), false, context);
    const data = (await response.json()) as {
      id?: string;
      model?: string;
      stop_reason?: string;
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const content = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const hasUsage = data.usage?.input_tokens !== undefined;

    return {
      id: data.id ?? "",
      model: data.model ?? context.upstreamModel,
      created: Math.floor(Date.now() / 1000),
      content,
      finishReason: data.stop_reason === "max_tokens" ? "length" : "stop",
      usage: hasUsage
        ? buildUsage(data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0)
        : buildUsage(estimatePromptTokens(request.messages), estimateTextTokens(content)),
      usageEstimated: !hasUsage,
    };
  }

  async *streamChatCompletion(
    request: ChatCompletionRequest,
    context: ProviderCallContext,
  ): AsyncGenerator<StreamChunk> {
    this.assertConfigured();
    const response = await this.post(this.payload(request, context, true), true, context);
    if (!response.body) throw new ProviderError("upstream_error", "Anthropic returned an empty stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    let output = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let parsed: {
            type?: string;
            delta?: { text?: string; stop_reason?: string };
            message?: { usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }

          if (parsed.type === "message_start" && parsed.message?.usage) {
            sawUsage = true;
            inputTokens = parsed.message.usage.input_tokens ?? 0;
            outputTokens = parsed.message.usage.output_tokens ?? 0;
          }
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            output += parsed.delta.text;
            yield { delta: parsed.delta.text };
          }
          if (parsed.type === "message_delta") {
            if (parsed.usage?.output_tokens !== undefined) {
              sawUsage = true;
              outputTokens = parsed.usage.output_tokens;
            }
            if (parsed.delta?.stop_reason) {
              yield { finishReason: parsed.delta.stop_reason === "max_tokens" ? "length" : "stop" };
            }
          }
        }
      }
    }

    yield {
      usage: sawUsage
        ? buildUsage(inputTokens, outputTokens)
        : buildUsage(estimatePromptTokens(request.messages), estimateTextTokens(output)),
    };
  }

  async getModel(modelId: string): Promise<ProviderModelInfo | null> {
    if (!this.isConfigured()) return null;
    try {
      const response = await this.egress(`${this.baseUrl}/models/${encodeURIComponent(modelId)}`, {
        headers: this.headers(false),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { id?: string };
      return { id: data.id ?? modelId, ownedBy: this.id };
    } catch {
      return null;
    }
  }

  /**
   * Catalogue for `syncProviderCatalogue`, over Anthropic's `GET /models`.
   *
   * The response is `{data: [{id, display_name, created_at}], has_more, last_id}` — paginated,
   * so this follows `last_id` until `has_more` is false, capped so a misbehaving upstream
   * cannot spin here forever. Anthropic publishes no pricing or context window on this
   * endpoint, so those fields stay undefined and the sync leaves them at their defaults for
   * an admin to fill in; that is deliberate, since a guessed price would be metered.
   */
  async listModels(): Promise<ProviderModelInfo[]> {
    this.assertConfigured();
    const models: ProviderModelInfo[] = [];
    let after: string | undefined;

    for (let page = 0; page < 10; page++) {
      const url = new URL(`${this.baseUrl}/models`);
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after_id", after);

      let response: Response;
      try {
        response = await this.egress(url.toString(), {
          headers: this.headers(false),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new ProviderError(
          aborted ? "upstream_timeout" : "upstream_error",
          aborted
            ? `${this.label} did not respond in time.`
            : this.proxied
              ? `${this.label} could not be reached through its configured proxy.`
              : `${this.label} could not be reached.`,
          aborted ? 504 : 502,
        );
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        if (response.status === 401 || response.status === 403) {
          throw new ProviderError(
            "upstream_unauthorized",
            `${this.label} rejected Relayn's credential (${credentialLabel(this.credentialEnvVar)}).`,
            502,
            response.status,
          );
        }
        throw new ProviderError(
          "upstream_error",
          `${this.label} catalogue request returned ${response.status}. ${detail}`.trim(),
          502,
          response.status,
        );
      }

      const payload = (await response.json()) as {
        data?: Array<{ id?: string; display_name?: string }>;
        has_more?: boolean;
        last_id?: string | null;
      };
      const entries = payload.data ?? [];
      for (const entry of entries) {
        if (typeof entry?.id !== "string" || entry.id.length === 0) continue;
        models.push({
          id: entry.id,
          ownedBy: this.id,
          ...(entry.display_name ? { name: entry.display_name } : {}),
        });
      }

      if (!payload.has_more || !payload.last_id || entries.length === 0) break;
      after = payload.last_id;
    }

    return models;
  }

  async healthCheck(): Promise<HealthStatus> {
    if (!this.isConfigured()) {
      return {
        state: "unconfigured",
        detail: this.credentialEnvVar
          ? `${this.credentialEnvVar} is not set.`
          : "No API key is stored for this provider.",
      };
    }
    const started = Date.now();
    try {
      const { response, via } = await fetchThroughPool(
        `${this.baseUrl}/models`,
        { headers: this.headers(false), signal: AbortSignal.timeout(10_000) },
        this.proxyPool,
      );
      const latencyMs = Date.now() - started;
      const suffix = via ? ` via proxy ${via}` : "";
      return response.ok
        ? { state: "ok", detail: `Catalogue reachable${suffix}.`, latencyMs }
        : {
            state: "degraded",
            detail: `Catalogue probe returned ${response.status}${suffix}.`,
            latencyMs,
          };
    } catch {
      return {
        state: "down",
        detail: this.proxied
          ? "Catalogue probe failed through every configured proxy."
          : "Catalogue probe failed.",
        latencyMs: Date.now() - started,
      };
    }
  }
}
