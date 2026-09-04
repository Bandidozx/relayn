/**
 * Gateway response + failure handling.
 *
 * Two invariants live here:
 *   1. Errors leave in the OpenAI/Anthropic envelope so existing SDK error handling
 *      keeps working.
 *   2. Any failure that happened *after* the key was authenticated is written to
 *      usage_logs (with zero billed tokens), so the dashboard's success-rate and error
 *      breakdown reflect reality rather than only counting happy paths.
 */
import "server-only";
import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { GatewayError, type GatewayIdentity } from "@/lib/gateway/pipeline";
import { ProviderError } from "@/lib/providers/types";
import { recordUsage } from "@/lib/usage/accounting";
import { buildUsage } from "@/lib/usage/tokenizer";

export interface FailureContext {
  identity: GatewayIdentity | null;
  requestId: string;
  endpoint: string;
  modelId: string;
  provider: string;
  startedAt: number;
  streamed: boolean;
  ipAddress: string | null;
  request: Request;
}

function envelope(type: string, code: string, message: string) {
  return { error: { message, type, code, param: null } };
}

export function gatewayErrorResponse(error: GatewayError, requestId: string): NextResponse {
  return NextResponse.json(envelope(error.type, error.code, error.message), {
    status: error.status,
    headers: { ...error.headers, "x-request-id": requestId },
  });
}

/** Normalises anything thrown inside the pipeline into a GatewayError. */
export function normaliseError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;

  if (error instanceof ProviderError) {
    const type =
      error.code === "upstream_rate_limited"
        ? "rate_limit_error"
        : error.code === "invalid_request"
          ? "invalid_request_error"
          : error.code === "provider_unconfigured" || error.code === "model_unavailable"
            ? "service_unavailable"
            : "api_error";
    return new GatewayError(error.httpStatus, type, error.code, error.message);
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new GatewayError(499 as number, "api_error", "client_closed_request", "Client closed the request.");
  }

  console.error("[relayn:gateway] unhandled error:", error);
  return new GatewayError(
    500,
    "api_error",
    "internal_error",
    "The gateway failed to process this request.",
  );
}

/**
 * Records a failure against the caller's account. Split out from `handleFailure` because
 * the Anthropic dialect needs the same logging with a different response envelope.
 */
export async function logFailure(
  gatewayError: GatewayError,
  context: FailureContext,
): Promise<void> {
  if (context.identity) {
    await recordUsage({
      userId: context.identity.user.id,
      apiKeyId: context.identity.apiKey.id,
      modelId: context.modelId || "unknown",
      provider: context.provider,
      endpoint: context.endpoint,
      requestId: context.requestId,
      usage: buildUsage(0, 0),
      latencyMs: Date.now() - context.startedAt,
      status: "error",
      httpStatus: gatewayError.status,
      errorCode: gatewayError.code,
      errorMessage: gatewayError.message,
      costMicroUsd: 0,
      streamed: context.streamed,
      ipAddress: context.ipAddress,
    }).catch((writeError) => {
      console.error("[relayn:gateway] failed to log error usage:", writeError);
    });

    if (gatewayError.code === "insufficient_tokens") {
      await recordAudit({
        action: "gateway.quota_exceeded",
        userId: context.identity.user.id,
        actorEmail: context.identity.user.email,
        targetType: "api_key",
        targetId: context.identity.apiKey.id,
        metadata: { modelId: context.modelId },
        request: context.request,
      });
    }
  } else if (
    gatewayError.code === "invalid_api_key" ||
    gatewayError.code === "api_key_revoked" ||
    gatewayError.code === "missing_api_key"
  ) {
    await recordAudit({
      action: "gateway.key_rejected",
      metadata: { reason: gatewayError.code, endpoint: context.endpoint },
      request: context.request,
    });
  }
}

/**
 * Converts a failure into a response, logging it against the caller's account when the
 * caller is known.
 */
export async function handleFailure(
  error: unknown,
  context: FailureContext,
): Promise<NextResponse> {
  const gatewayError = normaliseError(error);
  await logFailure(gatewayError, context);
  return gatewayErrorResponse(gatewayError, context.requestId);
}

/**
 * Anthropic-dialect equivalent of `handleFailure`: identical accounting, `{type:"error",
 * error:{type,message}}` envelope.
 */
export async function handleAnthropicFailure(
  error: unknown,
  context: FailureContext,
): Promise<NextResponse> {
  const gatewayError = normaliseError(error);
  await logFailure(gatewayError, context);
  return NextResponse.json(
    { type: "error", error: { type: gatewayError.type, message: gatewayError.message } },
    {
      status: gatewayError.status,
      headers: { ...gatewayError.headers, "x-request-id": context.requestId },
    },
  );
}
