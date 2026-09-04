/**
 * Local token estimator.
 *
 * Upstream providers report authoritative usage and that is always preferred. This is
 * the fallback for streaming responses that omit a usage block and for the local mock
 * provider, so accounting is never silently zero. The heuristic blends a
 * bytes-per-token ratio with a word count, which lands within a few percent of BPE
 * tokenisers for ordinary prose and code.
 */
import type { ChatMessage, TokenUsage } from "@/lib/providers/types";

const BYTES_PER_TOKEN = 4;
/** Every message carries role/separator overhead in chat templates. */
const PER_MESSAGE_OVERHEAD = 4;

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const byBytes = Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN;
  const byWords = (text.trim().split(/\s+/).filter(Boolean).length || 0) * 1.32;
  return Math.max(1, Math.round((byBytes + byWords) / 2));
}

function messageText(message: ChatMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((part) => part.text ?? (part.image_url ? "[image]".repeat(170) : ""))
    .join(" ");
}

export function estimatePromptTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (total, message) => total + PER_MESSAGE_OVERHEAD + estimateTextTokens(messageText(message)),
    2,
  );
}

export function buildUsage(inputTokens: number, outputTokens: number): TokenUsage {
  const input = Math.max(0, Math.round(inputTokens));
  const output = Math.max(0, Math.round(outputTokens));
  return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}
