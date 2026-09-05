/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 *
 * Full path: authenticate key → check key/account/subscription → check allocation →
 * resolve + authorise model → resolve its fallback chain → rate limit → route to provider
 * adapter → measure latency → count tokens → price the call → write usage_logs + advance
 * counters → respond.
 *
 * When the requested model declares fallbacks, a transient upstream failure (429, 5xx, timeout,
 * out of credit, dead id) advances to the next link instead of failing the request. The link that
 * answered is the one billed, logged and named in the response; `x-relayn-requested-model` says
 * what was asked for when the two differ.
 *
 * Supports `stream: true` (SSE), including a terminal usage chunk. Accounting happens
 * once the upstream stream is exhausted and before the response is closed, using the
 * upstream's reported usage when present.
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
import { chatCompletionSchema } from "@/lib/gateway/schemas";
import { handleFailure, type FailureContext } from "@/lib/gateway/respond";
import { newCompletionId, newRequestId } from "@/lib/security/tokens";
import { costMicroUsd, recordUsage } from "@/lib/usage/accounting";
import { buildUsage } from "@/lib/usage/tokenizer";
import type { TokenUsage } from "@/lib/providers/types";

const ENDPOINT = "/v1/chat/completions";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}

export async function GET(): Promise<Response> {
  return NextResponse.json(
    {
      error: {
        message: "This endpoint accepts POST. See /docs for the request shape.",
        type: "invalid_request_error",
        code: "method_not_allowed",
        param: null,
      },
    },
    { status: 405, headers: { allow: "POST, OPTIONS" } },
  );
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
    return handleFailure(error, failure);
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
      body = chatCompletionSchema.parse(raw);
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

    assertQuota(identity);

    const chain = await resolveChain(body.model, identity.plan);
    const primary = chain.links[0]!;
    failure.provider = primary.model.provider;

    const providerRequest = {
      model: body.model,
      messages: body.messages,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
      ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
      ...(body.stop !== undefined ? { stop: body.stop } : {}),
      ...(body.tools !== undefined ? { tools: body.tools } : {}),
      ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
      ...(body.user !== undefined ? { user: body.user } : {}),
    };

    const billingFor = (link: ResolvedModel) => ({
      modelId: link.model.modelId,
      provider: link.model.provider,
      inputPrice: link.model.inputPrice,
      outputPrice: link.model.outputPrice,
    });

    // Failed links become zero-cost error rows under this request's id, so a chain that is
    // quietly papering over a dead upstream is still visible in the dashboard.
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
      // Opened before the response is built: the chain may only advance while nothing has
      // reached the client, and this is also what lets an immediate upstream failure come back
      // as a real HTTP status rather than an error frame inside a 200.
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

      const completionId = newCompletionId();
      const created = Math.floor(Date.now() / 1000);
      const encoder = new TextEncoder();
      const includeUsage = body.stream_options?.include_usage !== false;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (payload: unknown) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          };
          const frame = (
            delta: Record<string, unknown>,
            finishReason: string | null = null,
          ) => ({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: model.modelId,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          });

          let usage: TokenUsage = buildUsage(0, 0);
          let finishReason = "stop";
          let failed: unknown = null;

          try {
            send(frame({ role: "assistant", content: "" }));

            for await (const chunk of opened.result) {
              if (chunk.delta) send(frame({ content: chunk.delta }));
              if (chunk.finishReason) finishReason = chunk.finishReason;
              if (chunk.usage) usage = chunk.usage;
            }

            send(frame({}, finishReason));
            if (includeUsage) {
              send({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: model.modelId,
                choices: [],
                usage: {
                  prompt_tokens: usage.inputTokens,
                  completion_tokens: usage.outputTokens,
                  total_tokens: usage.totalTokens,
                },
              });
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch (error) {
            failed = error;
            // The response has already begun, so the error is delivered as a final
            // SSE frame rather than an HTTP status.
            const normalised =
              error instanceof Error ? error.message : "Upstream stream failed.";
            send({ error: { message: normalised, type: "api_error", code: "stream_failed" } });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } finally {
            // Accounting happens whether the stream completed or broke — and it must
            // finish *before* the stream is closed. On a serverless platform the instance
            // is free to freeze the moment the response ends, so anything awaited after
            // `controller.close()` is silently dropped: the usage row never lands and the
            // dashboard under-reports every streamed call. (This is not theoretical — it
            // reproduced on Vercel; it only passed locally because back-to-back requests
            // kept the instance warm.) Holding the stream open for one transaction costs
            // a few milliseconds after `[DONE]` and makes the write deterministic.
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
        id: result.id || newCompletionId(),
        object: "chat.completion",
        created: result.created,
        model: model.modelId,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: result.content,
              ...(result.toolCalls ? { tool_calls: result.toolCalls } : {}),
            },
            finish_reason: result.finishReason,
          },
        ],
        usage: {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.totalTokens,
        },
      },
      {
        headers: {
          "x-request-id": requestId,
          "x-relayn-model": model.modelId,
          "x-relayn-provider": model.provider,
          "x-relayn-latency-ms": String(latencyMs),
          "x-relayn-cost-micro-usd": String(cost),
          ...(result.usageEstimated ? { "x-relayn-usage-estimated": "true" } : {}),
          ...fallbackHeaders(body.model, outcome),
        },
      },
    );
  } catch (error) {
    return handleFailure(error, failure);
  }
}
