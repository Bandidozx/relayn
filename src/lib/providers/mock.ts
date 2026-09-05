/**
 * Deterministic in-process provider.
 *
 * Its purpose is to make the whole pipeline — key auth, quota checks, routing,
 * streaming, token accounting, usage logging — genuinely exercisable (and testable in
 * CI) on a machine with no upstream credentials. Models seeded with
 * `provider = "mock"` route here.
 *
 * It is enabled by ENABLE_MOCK_PROVIDER and defaults to off in production. Responses
 * are clearly labelled as synthetic so they can never be mistaken for a real model.
 */
import { createHash } from "node:crypto";
import {
  ProviderError,
  type ChatCompletionRequest,
  type ChatCompletionResult,
  type ChatMessage,
  type HealthStatus,
  type ModelProvider,
  type ProviderCallContext,
  type ProviderModelInfo,
  type StreamChunk,
} from "@/lib/providers/types";
import { buildUsage, estimatePromptTokens, estimateTextTokens } from "@/lib/usage/tokenizer";
import { newCompletionId } from "@/lib/security/tokens";

const OPENERS = [
  "Here is a synthetic completion from the Relayn sandbox model.",
  "Sandbox response — generated locally by Relayn, not by a hosted model.",
  "This reply comes from Relayn's built-in sandbox provider.",
];

function lastUserText(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const { content } = message;
    if (typeof content === "string") return content;
    if (content) return content.map((part) => part.text ?? "").join(" ");
  }
  return "";
}

function seedOf(text: string): number {
  return Number.parseInt(createHash("sha256").update(text).digest("hex").slice(0, 8), 16);
}

export class MockProvider implements ModelProvider {
  readonly id = "mock";
  readonly label = "Relayn Sandbox";
  readonly credentialEnvVar = "ENABLE_MOCK_PROVIDER";

  constructor(private readonly enabled: boolean) {}

  isConfigured(): boolean {
    return this.enabled;
  }

  private assertConfigured(): void {
    if (!this.enabled) {
      throw new ProviderError(
        "provider_unconfigured",
        "The sandbox provider is disabled on this deployment. Set ENABLE_MOCK_PROVIDER=true to enable it.",
        503,
      );
    }
  }

  private compose(request: ChatCompletionRequest, upstreamModel: string): string {
    const prompt = lastUserText(request.messages).trim();
    const seed = seedOf(`${upstreamModel}:${prompt}`);
    const opener = OPENERS[seed % OPENERS.length] ?? OPENERS[0]!;
    const excerpt = prompt.length > 220 ? `${prompt.slice(0, 220)}…` : prompt;

    const lines = [
      opener,
      "",
      prompt
        ? `You asked: "${excerpt}"`
        : "No user message was supplied, so there is nothing to respond to.",
      "",
      `Routed as \`${upstreamModel}\` through the sandbox adapter. Everything downstream of this point is real: the request was authenticated with your API key, checked against your account's token allocation, timed, billed and written to your usage log.`,
      "",
      "Point ENABLE_MOCK_PROVIDER at a real credential (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY or OPENROUTER_API_KEY) and enable a model from that provider to receive genuine completions.",
    ];
    return lines.join("\n");
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    context: ProviderCallContext,
  ): Promise<ChatCompletionResult> {
    this.assertConfigured();
    const content = this.compose(request, context.upstreamModel);
    // Simulated upstream latency so dashboard latency metrics are non-degenerate.
    const delay = 90 + (seedOf(content) % 260);
    await new Promise((resolve) => setTimeout(resolve, delay));

    return {
      id: newCompletionId(),
      model: context.upstreamModel,
      created: Math.floor(Date.now() / 1000),
      content,
      finishReason: "stop",
      usage: buildUsage(estimatePromptTokens(request.messages), estimateTextTokens(content)),
      usageEstimated: true,
    };
  }

  async *streamChatCompletion(
    request: ChatCompletionRequest,
    context: ProviderCallContext,
  ): AsyncGenerator<StreamChunk> {
    this.assertConfigured();
    const content = this.compose(request, context.upstreamModel);
    const tokens = content.match(/\S+\s*/g) ?? [];

    for (const token of tokens) {
      if (context.signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 6));
      yield { delta: token };
    }
    yield { finishReason: "stop" };
    yield { usage: buildUsage(estimatePromptTokens(request.messages), estimateTextTokens(content)) };
  }

  async getModel(modelId: string): Promise<ProviderModelInfo | null> {
    return this.enabled ? { id: modelId, ownedBy: "relayn-sandbox" } : null;
  }

  async healthCheck(): Promise<HealthStatus> {
    return this.enabled
      ? { state: "ok", detail: "In-process sandbox provider ready.", latencyMs: 0 }
      : { state: "unconfigured", detail: "ENABLE_MOCK_PROVIDER is not set." };
  }
}
