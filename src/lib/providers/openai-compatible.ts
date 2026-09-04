/**
 * Adapter for any upstream that speaks the OpenAI `/chat/completions` dialect.
 * Covers OpenAI itself, OpenRouter, Google's OpenAI-compatible endpoint and any
 * self-hosted gateway (vLLM, LiteLLM, Ollama, ...).
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
  type TokenUsage,
} from "@/lib/providers/types";
import { fetchThroughPool, type ProxyPool } from "@/lib/providers/proxy";
import { buildUsage, estimatePromptTokens, estimateTextTokens } from "@/lib/usage/tokenizer";

const REQUEST_TIMEOUT_MS = 120_000;

export interface OpenAiCompatibleOptions {
  id: string;
  label: string;
  credentialEnvVar: string;
  baseUrl: string;
  apiKey: string;
  /** Extra headers some gateways require (e.g. OpenRouter attribution). */
  extraHeaders?: Record<string, string>;
  /** Outbound proxies for this upstream. Absent means egress straight from the deployment. */
  proxyPool?: ProxyPool | null;
}

interface UpstreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Reconciles the upstream's usage block with what actually came back.
 *
 * Trusting the block verbatim is not safe. Some gateways publish a usage block whose
 * completion count is zero while streaming a full answer — jerouter's terminal chunk reads
 * `{prompt_tokens: 10, completion_tokens: 0, total_tokens: 10}` next to real content — and
 * metering that as written understates both the dashboard's token counts and the allocation
 * the caller has genuinely spent. So where the reported output is zero but text was
 * produced, the output half is estimated locally; the reported prompt count is still
 * preferred, because that half is not in doubt.
 *
 * An empty `output` with zero reported output tokens is left alone: a response that is
 * nothing but tool calls really did emit no text.
 */
function reconcileUsage(
  reported: UpstreamUsage | undefined,
  messages: ChatMessage[],
  output: string,
): { usage: TokenUsage; estimated: boolean } {
  const promptReported = reported?.prompt_tokens;
  const totalReported = reported?.total_tokens;

  const inputTokens = promptReported ?? estimatePromptTokens(messages);
  let outputTokens =
    reported?.completion_tokens ??
    (totalReported === undefined ? undefined : Math.max(0, totalReported - (promptReported ?? 0)));

  let estimated = totalReported === undefined && promptReported === undefined;
  if (outputTokens === undefined || (outputTokens === 0 && output.length > 0)) {
    outputTokens = estimateTextTokens(output);
    estimated = true;
  }

  return { usage: buildUsage(inputTokens, outputTokens), estimated };
}

/** The union of `/models` fields seen across OpenAI, OpenRouter and self-hosted gateways. */
interface UpstreamModel {
  id?: string;
  owned_by?: string;
  name?: string;
  display_name?: string;
  description?: string;
  context_length?: number | string;
  context_window?: number | string;
  max_output_tokens?: number | string;
  top_provider?: { context_length?: number | string; max_completion_tokens?: number | string };
  pricing?: {
    /** OpenRouter: USD per single token, as a decimal string. */
    prompt?: number | string;
    completion?: number | string;
    /** Gateways that publish per-million instead. */
    input_per_mtok?: number | string;
    output_per_mtok?: number | string;
    input?: number | string;
    output?: number | string;
  };
}

/** Parses a numeric field that may arrive as a string; returns undefined when unusable. */
function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolves a price to USD per 1M tokens — the unit `models.inputPrice` stores and
 * `costMicroUsd` multiplies by.
 *
 * `*_per_mtok` is already per million. `pricing.prompt`/`pricing.completion` follow
 * OpenRouter and are per single token, so they are scaled up. A published zero is kept as
 * a real zero (free models exist and must meter as free); only an absent field is undefined.
 */
function price(
  pricing: UpstreamModel["pricing"],
  perMillionKey: "input_per_mtok" | "output_per_mtok",
  perTokenKey: "prompt" | "completion",
  plainKey: "input" | "output",
): number | undefined {
  if (!pricing) return undefined;
  const perMillion = num(pricing[perMillionKey]) ?? num(pricing[plainKey]);
  if (perMillion !== undefined) return perMillion;
  const perToken = num(pricing[perTokenKey]);
  return perToken === undefined ? undefined : perToken * 1_000_000;
}

function normaliseModel(
  data: UpstreamModel,
  fallbackId: string,
  providerId: string,
): ProviderModelInfo {
  const contextWindow =
    num(data.context_length) ?? num(data.context_window) ?? num(data.top_provider?.context_length);
  const maxOutputTokens =
    num(data.max_output_tokens) ?? num(data.top_provider?.max_completion_tokens);
  const inputPrice = price(data.pricing, "input_per_mtok", "prompt", "input");
  const outputPrice = price(data.pricing, "output_per_mtok", "completion", "output");
  const name = data.name ?? data.display_name;

  return {
    id: data.id ?? fallbackId,
    ownedBy: data.owned_by ?? providerId,
    ...(name ? { name } : {}),
    ...(data.description ? { description: data.description } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(inputPrice !== undefined ? { inputPrice } : {}),
    ...(outputPrice !== undefined ? { outputPrice } : {}),
  };
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  readonly credentialEnvVar: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly proxyPool: ProxyPool | null;

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.label = options.label;
    this.credentialEnvVar = options.credentialEnvVar;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.extraHeaders = options.extraHeaders ?? {};
    this.proxyPool = options.proxyPool ?? null;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ProviderError(
        "provider_unconfigured",
        `${this.label} is not configured on this deployment. ${unconfiguredRemedy(this.credentialEnvVar)}`,
        503,
      );
    }
  }

  /** Provider credentials live here and never leave the server process. */
  private headers(stream: boolean): HeadersInit {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      accept: stream ? "text/event-stream" : "application/json",
      ...this.extraHeaders,
    };
  }

  private signal(context: ProviderCallContext): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
  }

  private payload(request: ChatCompletionRequest, context: ProviderCallContext, stream: boolean) {
    const body: Record<string, unknown> = {
      model: context.upstreamModel,
      messages: request.messages,
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.tools !== undefined) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    if (request.user !== undefined) body.user = request.user;
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  private async fetchUpstream(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      const { response } = await fetchThroughPool(`${this.baseUrl}${path}`, init, this.proxyPool);
      return response;
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const proxied = (this.proxyPool?.size ?? 0) > 0;
      throw new ProviderError(
        aborted ? "upstream_timeout" : "upstream_error",
        aborted
          ? `${this.label} did not respond in time.`
          : proxied
            // No underlying message: a proxy connection error can echo back the proxy URL,
            // and that URL carries the operator's proxy password.
            ? `${this.label} could not be reached through its configured proxy.`
            : `${this.label} could not be reached.`,
        aborted ? 504 : 502,
      );
    }
  }

  private async raiseForStatus(response: Response): Promise<never> {
    const text = await response.text().catch(() => "");
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      /* non-JSON upstream error; keep the truncated body */
    }
    if (response.status === 429) {
      throw new ProviderError(
        "upstream_rate_limited",
        `${this.label} rate-limited this request. ${detail}`.trim(),
        429,
        response.status,
      );
    }
    // 401/403 and 402 are operator problems, not caller problems: the credential in
    // `${this.credentialEnvVar}` is wrong or the account behind it has no balance left.
    // They are reported as 502 with the upstream's own wording, so the message on the
    // usage row says which of the two it was instead of a flat "upstream error".
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
    if (response.status === 404) {
      throw new ProviderError(
        "model_unavailable",
        `${this.label} does not currently serve this model. ${detail}`.trim(),
        502,
        response.status,
      );
    }
    if (response.status === 400 || response.status === 422) {
      throw new ProviderError("invalid_request", detail || "Upstream rejected the request.", 400, response.status);
    }
    throw new ProviderError(
      "upstream_error",
      `${this.label} returned ${response.status}. ${detail}`.trim(),
      502,
      response.status,
    );
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    context: ProviderCallContext,
  ): Promise<ChatCompletionResult> {
    this.assertConfigured();
    const response = await this.fetchUpstream("/chat/completions", {
      method: "POST",
      headers: this.headers(false),
      body: JSON.stringify(this.payload(request, context, false)),
      signal: this.signal(context),
    });
    if (!response.ok) await this.raiseForStatus(response);

    const data = (await response.json()) as {
      id?: string;
      created?: number;
      model?: string;
      usage?: UpstreamUsage;
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: unknown[] };
        finish_reason?: string;
      }>;
    };

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    const { usage, estimated } = reconcileUsage(data.usage, request.messages, content);

    return {
      id: data.id ?? "",
      model: data.model ?? context.upstreamModel,
      created: data.created ?? Math.floor(Date.now() / 1000),
      content,
      finishReason: choice?.finish_reason ?? "stop",
      usage,
      ...(choice?.message?.tool_calls ? { toolCalls: choice.message.tool_calls } : {}),
      usageEstimated: estimated,
    };
  }

  async *streamChatCompletion(
    request: ChatCompletionRequest,
    context: ProviderCallContext,
  ): AsyncGenerator<StreamChunk> {
    this.assertConfigured();
    const response = await this.fetchUpstream("/chat/completions", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(this.payload(request, context, true)),
      signal: this.signal(context),
    });
    if (!response.ok) await this.raiseForStatus(response);
    if (!response.body) {
      throw new ProviderError("upstream_error", `${this.label} returned an empty stream.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reportedUsage: UpstreamUsage | undefined;
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
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let parsed: {
            usage?: UpstreamUsage;
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          };
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (parsed.usage) reportedUsage = parsed.usage;
          const choice = parsed.choices?.[0];
          const delta = choice?.delta?.content;
          if (delta) {
            output += delta;
            yield { delta };
          }
          if (choice?.finish_reason) yield { finishReason: choice.finish_reason };
        }
      }
    }

    yield { usage: reconcileUsage(reportedUsage, request.messages, output).usage };
  }

  async getModel(modelId: string): Promise<ProviderModelInfo | null> {
    if (!this.isConfigured()) return null;
    const response = await this.fetchUpstream(`/models/${encodeURIComponent(modelId)}`, {
      headers: this.headers(false),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as UpstreamModel;
    return normaliseModel(data, modelId, this.id);
  }

  /**
   * `GET /models` on the upstream, normalised for catalogue sync.
   *
   * The `/models` payload is only loosely standardised past `{id, object, owned_by}`:
   * OpenRouter publishes `pricing` in USD per *token* and `context_length`, some gateways
   * publish USD per *million* tokens under `input_per_mtok`, and plenty publish nothing at
   * all. Everything past the id is therefore treated as optional and only used when it is
   * actually present — a missing price stays absent rather than becoming a confident zero.
   */
  async listModels(): Promise<ProviderModelInfo[]> {
    this.assertConfigured();
    const response = await this.fetchUpstream("/models", {
      headers: this.headers(false),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) await this.raiseForStatus(response);

    const payload = (await response.json()) as { data?: UpstreamModel[] } | UpstreamModel[];
    const entries = Array.isArray(payload) ? payload : (payload.data ?? []);
    return entries
      .filter((entry) => typeof entry?.id === "string" && entry.id.length > 0)
      .map((entry) => normaliseModel(entry, entry.id as string, this.id));
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
      if (!response.ok) {
        return {
          state: "degraded",
          detail: `Catalogue probe returned ${response.status}${suffix}.`,
          latencyMs,
        };
      }
      return { state: "ok", detail: `Catalogue reachable${suffix}.`, latencyMs };
    } catch {
      return {
        state: "down",
        detail:
          (this.proxyPool?.size ?? 0) > 0
            ? "Catalogue probe failed through every configured proxy."
            : "Catalogue probe failed.",
        latencyMs: Date.now() - started,
      };
    }
  }
}
