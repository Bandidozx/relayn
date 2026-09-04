/**
 * Wire-format validation for the gateway. Rejecting malformed input here means the
 * provider adapters can trust their inputs, and callers get a precise 400 instead of an
 * opaque upstream error.
 */
import { z } from "zod";

const contentPart = z.object({
  type: z.string(),
  text: z.string().optional(),
  image_url: z.object({ url: z.string() }).optional(),
});

const message = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "developer"]),
  content: z.union([z.string(), z.array(contentPart), z.null()]),
  name: z.string().max(120).optional(),
  tool_call_id: z.string().max(200).optional(),
  tool_calls: z.array(z.unknown()).optional(),
});

export const chatCompletionSchema = z.object({
  model: z.string().min(1).max(200),
  messages: z.array(message).min(1).max(200),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).max(200_000).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  tools: z.array(z.unknown()).max(128).optional(),
  tool_choice: z.unknown().optional(),
  user: z.string().max(200).optional(),
  n: z.literal(1).optional(),
});

export type ChatCompletionBody = z.infer<typeof chatCompletionSchema>;

/** Anthropic-dialect body for POST /v1/messages. */
export const anthropicMessagesSchema = z.object({
  model: z.string().min(1).max(200),
  max_tokens: z.number().int().min(1).max(200_000),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([z.string(), z.array(contentPart)]),
      }),
    )
    .min(1)
    .max(200),
  system: z.union([z.string(), z.array(contentPart)]).optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop_sequences: z.array(z.string()).max(4).optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.unknown()).max(128).optional(),
});

export type AnthropicMessagesBody = z.infer<typeof anthropicMessagesSchema>;
