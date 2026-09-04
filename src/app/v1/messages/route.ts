/**
 * POST /v1/messages — Anthropic-dialect messages endpoint.
 *
 * Same pipeline, same accounting and the same `usage_logs` rows as the OpenAI dialect;
 * only the wire format differs. Callers authenticate with `x-api-key` (or `Authorization:
 * Bearer`) and get back Anthropic's `{type:"message", content:[{type:"text"}], usage:
 * {input_tokens, output_tokens}}` shape, so the Anthropic SDK can be pointed at Relayn by
 * changing `baseURL` alone — including against non-Anthropic upstreams.
 *
 * Fallback behaves exactly as it does in the OpenAI dialect: a transient upstream failure
 * advances to the next link in the model's chain, the link that answered is the one billed,
 * logged and named in `x-relayn-model`, and `x-relayn-requested-model` records what was asked
 * for when the two differ.
 */
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { clientIp } from "@/lib/api/http";
import {
  assertQuota,
  assertRateLimit,
  authenticate,
  GatewayError,
  resolveChain,
  type GatewayIdentity,
  type ResolvedModel,
} from "@/lib/gateway/pipeline";
import {
  attemptRecorder,
  fallbackHeaders,
  openStreamWithFallback,
  runWithFallback,
  warnIfChainDegraded,
} from "@/lib/gateway/fallback";
import { anthropicMessagesSchema } from "@/lib/gateway/schemas";
import {
  handleAnthropicFailure,
  normaliseError,
  type FailureContext,
} from "@/lib/gateway/respond";
import { newMessageId, newRequestId } from "@/lib/security/tokens";
import { costMicroUsd, recordUsage } from "@/lib/usage/accounting";
import { buildUsage } from "@/lib/usage/tokenizer";
import type { ChatMessage, TokenUsage } from "@/lib/providers/types";

const ENDPOINT = "/v1/messages";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}

export async function GET(): Promise<Response> {
  return NextResponse.json(
    {
      type: "error",
      error: { type: "invalid_request_error", message: "This endpoint accepts POST." },
    },
    { status: 405, headers: { allow: "POST, OPTIONS" } },
  );
}

/** Anthropic reports finish reasons differently from OpenAI. */
function stopReason(finishReason: string): string {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "stop_sequence") return "stop_sequence";
  return "end_turn";
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const requestId = newRequestId();
  const ipAddress = clientIp(request);

  const failure: FailureContext = {
    identity: null,
    requestId,
    endpoint: ENDPOINT,
    modelId: "",
    provider: "",
    startedAt,
    streamed: false,
    ipAddress,
    request,
  };

  let identity: GatewayIdentity;
  try {
    identity = await authenticate(request);
    failure.identity = identity;
  } catch (error) {
    return handleAnthropicFailure(error, failure);
  }

  try {
    assertRateLimit(identity);

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new GatewayError(
        400,
        "invalid_request_error",
        "invalid_json",
        "Request body must be valid JSON.",
      );
    }

    let body;
    try {
      body = anthropicMessagesSchema.parse(raw);
    } catch (error) {
      if (error instanceof ZodError) {
        const issue = error.issues[0];
        throw new GatewayError(
          400,
          "invalid_request_error",
          "invalid_body",
          `${issue?.path.join(".") || "body"}: ${issue?.message ?? "is invalid"}`,
        );
      }
      throw error;
    }

    failure.modelId = body.model;
    failure.streamed = body.stream === true;

    assertQuota(identity.subscription);

    const chain = await resolveChain(body.model, identity.subscription.plan);
    failure.provider = chain.links[0]!.model.provider;

    // The provider contract is OpenAI-shaped, so a top-level `system` becomes a leading
    // system message. The Anthropic adapter folds it back out again on the way upstream.
    const messages: ChatMessage[] = [
      ...(body.system !== undefined ? [{ role: "system" as const, content: body.system }] : []),
      ...body.messages.map((entry) => ({ role: entry.role, content: entry.content })),
    ];

    const providerRequest = {
      model: body.model,
      messages,
      max_tokens: body.max_tokens,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
      ...(body.stop_sequences !== undefined ? { stop: body.stop_sequences } : {}),
      ...(body.tools !== undefined ? { tools: body.tools } : {}),
    };

    const billingFor = (link: ResolvedModel) => ({
      modelId: link.model.modelId,
      provider: link.model.provider,
      inputPrice: link.model.inputPrice,
      outputPrice: link.model.outputPrice,
    });

    // Failed links become zero-cost error rows under this request's id, so a chain quietly
    // papering over a dead upstream is still visible in the dashboard.
    const record = attemptRecorder({
      userId: identity.user.id,
      apiKeyId: identity.apiKey.id,
      endpoint: ENDPOINT,
      requestId,
      streamed: body.stream === true,
      ipAddress,
    });

    // ── streaming ─────────────────────────────────────────────────────────────
    if (body.stream) {
      // Opened before the response is built, for the same two reasons as the OpenAI dialect:
      // the chain may only advance while nothing has reached the client, and an immediate
      // upstream failure then surfaces as a real HTTP status instead of an `error` event
      // inside a 200.
      const opened = await openStreamWithFallback(
        chain.links,
        (link) =>
          link.provider.streamChatCompletion(providerRequest, {
            upstreamModel: link.upstreamModel,
            signal: request.signal,
          }),
        record,
      );
      warnIfChainDegraded(body.model, opened.failed, chain.skipped);

      const model = opened.served.model;
      const billing = billingFor(opened.served);
      failure.provider = model.provider;

      const messageId = newMessageId();
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: string, payload: unknown) => {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
            );
          };

          let usage: TokenUsage = buildUsage(0, 0);
          let finishReason = "stop";
          let failed: unknown = null;

          try {
            send("message_start", {
              type: "message_start",
              message: {
                id: messageId,
                type: "message",
                role: "assistant",
                model: model.modelId,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            });
            send("content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            });

            for await (const chunk of opened.result) {
              if (chunk.delta) {
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: chunk.delta },
                });
              }
              if (chunk.finishReason) finishReason = chunk.finishReason;
              if (chunk.usage) usage = chunk.usage;
            }

            send("content_block_stop", { type: "content_block_stop", index: 0 });
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason(finishReason), stop_sequence: null },
              usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
            });
            send("message_stop", { type: "message_stop" });
          } catch (error) {
            failed = error;
            const gatewayError = normaliseError(error);
            send("error", {
              type: "error",
              error: { type: gatewayError.type, message: gatewayError.message },
            });
          } finally {
            // The usage row must land before the stream closes: on serverless the instance
            // may freeze as soon as the response finishes, which drops anything awaited
            // after `controller.close()`. See the same note in /v1/chat/completions.
            await recordUsage({
              userId: identity.user.id,
              apiKeyId: identity.apiKey.id,
              modelId: model.modelId,
              provider: model.provider,
              endpoint: ENDPOINT,
              requestId,
              usage,
              latencyMs: Date.now() - startedAt,
              status: failed ? "error" : "success",
              httpStatus: failed ? 502 : 200,
              errorCode: failed ? "stream_failed" : null,
              errorMessage: failed instanceof Error ? failed.message : null,
              costMicroUsd: failed ? 0 : costMicroUsd(billing, usage),
              streamed: true,
              ipAddress,
            }).catch((writeError) => {
              console.error("[relayn:gateway] stream accounting failed:", writeError);
            });

            try {
              controller.close();
            } catch {
              // Already closed, or the consumer cancelled — nothing left to flush.
            }
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-request-id": requestId,
          "x-relayn-model": model.modelId,
          "x-relayn-provider": model.provider,
          ...fallbackHeaders(body.model, opened),
        },
      });
    }

    // ── non-streaming ─────────────────────────────────────────────────────────
    const outcome = await runWithFallback(
      chain.links,
      (link) =>
        link.provider.chatCompletion(providerRequest, {
          upstreamModel: link.upstreamModel,
          signal: request.signal,
        }),
      record,
    );
    warnIfChainDegraded(body.model, outcome.failed, chain.skipped);

    const model = outcome.served.model;
    const result = outcome.result;
    failure.provider = model.provider;

    const latencyMs = Date.now() - startedAt;
    const cost = costMicroUsd(billingFor(outcome.served), result.usage);

    await recordUsage({
      userId: identity.user.id,
      apiKeyId: identity.apiKey.id,
      modelId: model.modelId,
      provider: model.provider,
      endpoint: ENDPOINT,
      requestId,
      usage: result.usage,
      latencyMs,
      status: "success",
      httpStatus: 200,
      costMicroUsd: cost,
      streamed: false,
      ipAddress,
    });

    return NextResponse.json(
      {
        id: newMessageId(),
        type: "message",
        role: "assistant",
        model: model.modelId,
        content: [{ type: "text", text: result.content }],
        stop_reason: stopReason(result.finishReason),
        stop_sequence: null,
        usage: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        },
      },
      {
        headers: {
          "x-request-id": requestId,
          "x-relayn-model": model.modelId,
          "x-relayn-provider": model.provider,
          "x-relayn-latency-ms": String(latencyMs),
          "x-relayn-cost-micro-usd": String(cost),
          ...fallbackHeaders(body.model, outcome),
        },
      },
    );
  } catch (error) {
    return handleAnthropicFailure(error, failure);
  }
}
