/**
 * Provider-agnostic contract. The gateway only ever talks to this interface, so adding
 * an upstream is a matter of implementing `ModelProvider` and registering it — nothing
 * in the routing, accounting or dashboard layers changes.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool" | "developer";

export interface ChatMessagePart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatMessagePart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  /** Opaque end-user identifier forwarded upstream for abuse tracing. */
  user?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResult {
  id: string;
  model: string;
  created: number;
  content: string;
  finishReason: string;
  usage: TokenUsage;
  toolCalls?: unknown[];
  /** True when usage was estimated locally because the upstream omitted it. */
  usageEstimated: boolean;
}

export interface StreamChunk {
  delta?: string;
  finishReason?: string | null;
  usage?: TokenUsage;
}

export interface ProviderCallContext {
  /** Identifier to send upstream — may differ from the public catalogue id. */
  upstreamModel: string;
  /** Aborts the upstream call when the client disconnects. */
  signal?: AbortSignal;
}

export interface ProviderModelInfo {
  id: string;
  ownedBy: string;
  /** Upstream-published display name, when it offers one. */
  name?: string;
  /** USD per 1M tokens, as the upstream publishes it. Omitted when it publishes none. */
  inputPrice?: number;
  outputPrice?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Free-form upstream description, used verbatim when present. */
  description?: string;
}

export type HealthState = "ok" | "unconfigured" | "degraded" | "down";

export interface HealthStatus {
  state: HealthState;
  detail: string;
  latencyMs?: number;
}

export interface ModelProvider {
  readonly id: string;
  readonly label: string;
  /**
   * Documented env var holding this provider's credential. Empty for a provider added from
   * Admin → Providers, whose credential is sealed in the database instead — see
   * `credentialLabel` and `unconfiguredRemedy` for phrasing operator-facing errors that have
   * to cover both cases.
   */
  readonly credentialEnvVar: string;
  /** False when the credential is absent — the model is then not callable. */
  isConfigured(): boolean;
  chatCompletion(
    request: ChatCompletionRequest,
    context: ProviderCallContext,
  ): Promise<ChatCompletionResult>;
  streamChatCompletion(
    request: ChatCompletionRequest,
    context: ProviderCallContext,
  ): AsyncGenerator<StreamChunk>;
  getModel(modelId: string): Promise<ProviderModelInfo | null>;
  /**
   * Everything this upstream currently serves, for catalogue sync. Optional: a provider
   * with a fixed model list (or no catalogue endpoint) simply omits it and is skipped by
   * `syncProviderCatalogue`.
   */
  listModels?(): Promise<ProviderModelInfo[]>;
  healthCheck(): Promise<HealthStatus>;
}

/**
 * Names a provider's credential in an operator-facing message. Builtins name their env var;
 * a runtime-added provider has none, so it points at where the key actually lives.
 */
export function credentialLabel(credentialEnvVar: string): string {
  return credentialEnvVar || "the key stored in Admin → Providers";
}

/** The "how to fix it" half of a `provider_unconfigured` message, for either kind. */
export function unconfiguredRemedy(credentialEnvVar: string): string {
  return credentialEnvVar
    ? `Set ${credentialEnvVar} to enable it.`
    : "Add its API key in Admin → Providers to enable it.";
}

/** Raised by providers so the gateway can map upstream failures to stable API errors. */
export class ProviderError extends Error {
  constructor(
    readonly code:
      | "provider_unconfigured"
      | "upstream_error"
      | "upstream_timeout"
      | "upstream_rate_limited"
      | "upstream_unauthorized"
      | "upstream_out_of_credit"
      | "model_unavailable"
      | "invalid_request",
    message: string,
    readonly httpStatus = 502,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
