/**
 * Shared HTTP plumbing for dashboard API routes: consistent JSON envelopes, a typed
 * error channel, automatic CSRF enforcement and safe error mapping (internal details
 * are logged server-side, never returned to the client).
 */
import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { checkCsrf } from "@/lib/security/csrf";
import { rateLimitHeaders, type RateLimitResult } from "@/lib/security/rate-limit";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const unauthorized = (message = "You must be signed in.") =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (message = "You do not have access to this resource.") =>
  new ApiError(403, "forbidden", message);
export const notFound = (message = "Resource not found.") =>
  new ApiError(404, "not_found", message);
export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "bad_request", message, details);
export const conflict = (message: string) => new ApiError(409, "conflict", message);

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as object, init);
}

export function fail(
  status: number,
  code: string,
  message: string,
  details?: unknown,
  headers?: Record<string, string>,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status, headers },
  );
}

export function tooManyRequests(result: RateLimitResult): NextResponse {
  return fail(
    429,
    "rate_limit_exceeded",
    `Too many requests. Try again in ${result.retryAfterSeconds}s.`,
    { limit: result.limit, resetAt: result.resetAt },
    rateLimitHeaders(result),
  );
}

function flattenZod(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_";
    if (!out[path]) out[path] = issue.message;
  }
  return out;
}

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return fail(error.status, error.code, error.message, error.details);
  }
  if (error instanceof ZodError) {
    return fail(400, "validation_error", "Some fields need attention.", flattenZod(error));
  }
  console.error("[relayn] unhandled route error:", error);
  return fail(500, "internal_error", "Something went wrong on our side.");
}

type RouteHandler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

/**
 * Wraps a route handler with CSRF enforcement (mutations only) and error mapping.
 * Use for every /api route. The /v1 gateway has its own Bearer-auth pipeline.
 */
export function apiRoute<P = Record<string, never>>(handler: RouteHandler<P>): RouteHandler<P> {
  return async (request, context) => {
    try {
      const csrfFailure = await checkCsrf(request);
      if (csrfFailure) return fail(403, csrfFailure.code, csrfFailure.message);
      return await handler(request, context);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export async function parseJson<T>(request: Request, schema: { parse: (v: unknown) => T }): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
  return schema.parse(body);
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}
