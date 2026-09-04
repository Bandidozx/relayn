/**
 * Fallback execution — attempting a chain of models until one of them answers.
 *
 * `resolveChain` decides *what* may be attempted; this module decides *when* to move on. The
 * distinction that matters is which failures are worth retrying:
 *
 *   **Transient / upstream-owned** — the upstream rate-limited us, timed out, returned 5xx, ran
 *   out of credit, or does not serve that id. Another provider will very likely answer the same
 *   request correctly, so the chain advances.
 *
 *   **Caller-owned** — the request itself is wrong (`invalid_request`: a malformed body, an
 *   oversized prompt, an unsupported parameter). Every link would reject it identically, so
 *   retrying only multiplies the latency and the upstream spend. These stop the chain.
 *
 * A rejected credential (`upstream_unauthorized`) also stops the chain. It means the operator's
 * own key is wrong, and silently routing around that would hide a broken provider indefinitely —
 * the failure is cheap to fix and expensive to not notice.
 *
 * Streaming has one extra rule, enforced by `openStreamWithFallback`: a chain may only advance
 * before the first byte reaches the client. Once a token has been emitted, the response is
 * committed and switching models mid-stream would splice two different completions together.
 */
import "server-only";
import { recordUsage } from "@/lib/usage/accounting";
import { buildUsage } from "@/lib/usage/tokenizer";
import { ProviderError, type StreamChunk } from "@/lib/providers/types";
import type { ResolvedModel, SkippedLink } from "@/lib/gateway/pipeline";

/** Upstream failures another provider might not have. */
const RETRYABLE: ReadonlySet<ProviderError["code"]> = new Set([
  "upstream_error",
  "upstream_timeout",
  "upstream_rate_limited",
  "upstream_out_of_credit",
  "model_unavailable",
  "provider_unconfigured",
]);

/**
 * True when the chain should advance past this error.
 *
 * Anything that is not a `ProviderError` — an abort because the client hung up, a bug in our own
 * code — is not retried. Only failures a provider deliberately classified are.
 */
export function isFallbackWorthy(error: unknown): boolean {
  return error instanceof ProviderError && RETRYABLE.has(error.code);
}

/** One link that was attempted and failed. Recorded as an error row so it stays visible. */
export interface FailedAttempt {
  modelId: string;
  provider: string;
  code: string;
  message: string;
  httpStatus: number;
  latencyMs: number;
}

/** Called after each failed link, before the next is attempted. Awaited, so the row lands. */
export type AttemptRecorder = (attempt: FailedAttempt) => Promise<void>;

function describe(error: unknown): { code: string; message: string; httpStatus: number } {
  if (error instanceof ProviderError) {
    return { code: error.code, message: error.message, httpStatus: error.httpStatus };
  }
  return {
    code: "upstream_error",
    message: error instanceof Error ? error.message : "Upstream call failed.",
    httpStatus: 502,
  };
}

export interface FallbackOutcome<T> {
  result: T;
  /** The link that actually answered. Bill and log this one, not the requested primary. */
  served: ResolvedModel;
  failed: FailedAttempt[];
}

/**
 * Attempts each link in turn and returns the first success.
 *
 * When every link fails the *last* error is thrown, because that is the one describing the state
 * the caller is actually in. Earlier failures are not lost: each has already been handed to
 * `record`, so they appear in the usage log either way.
 */
export async function runWithFallback<T>(
  links: readonly ResolvedModel[],
  attempt: (link: ResolvedModel) => Promise<T>,
  record?: AttemptRecorder,
): Promise<FallbackOutcome<T>> {
  const failed: FailedAttempt[] = [];

  for (let index = 0; index < links.length; index++) {
    const link = links[index]!;
    const startedAt = Date.now();
    try {
      return { result: await attempt(link), served: link, failed };
    } catch (error) {
      const last = index === links.length - 1;
      if (last || !isFallbackWorthy(error)) throw error;

      const detail = describe(error);
      const entry: FailedAttempt = {
        modelId: link.model.modelId,
        provider: link.model.provider,
        latencyMs: Date.now() - startedAt,
        ...detail,
      };
      failed.push(entry);
      if (record) await record(entry);
    }
  }

  // Unreachable: `links` always contains the primary, and the last link rethrows.
  throw new ProviderError("upstream_error", "No model was attempted.", 502);
}

/**
 * Opens a stream from the first link that produces a chunk, and hands back an iterable that
 * replays that chunk followed by the rest.
 *
 * The first chunk is awaited here, before the route returns its `Response`. That is what makes
 * pre-first-byte fallback possible, and it has a second benefit: an upstream that fails
 * immediately now produces a real HTTP error status instead of an error frame inside a 200
 * response, which every SDK handles better.
 */
export async function openStreamWithFallback(
  links: readonly ResolvedModel[],
  open: (link: ResolvedModel) => AsyncIterable<StreamChunk>,
  record?: AttemptRecorder,
): Promise<FallbackOutcome<AsyncIterable<StreamChunk>>> {
  return runWithFallback(
    links,
    async (link) => {
      const iterator = open(link)[Symbol.asyncIterator]();
      // Any failure the upstream reports up front — 429, 404, a refused credential — surfaces
      // from this first `next()`, which is still inside the retry loop.
      const first = await iterator.next();

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
          if (first.done) return;
          try {
            yield first.value;
            let next = await iterator.next();
            while (!next.done) {
              yield next.value;
              next = await iterator.next();
            }
          } finally {
            // A consumer that stops early — the client disconnected, or a route `break`s —
            // finishes *this* generator at its `yield`, which does not propagate to the
            // iterator opened above. Closing it explicitly is what runs the adapter's own
            // cleanup and releases the upstream response body. Already-finished iterators
            // treat this as a no-op, so the normal path pays nothing.
            await iterator.return?.();
          }
        },
      };
    },
    record,
  );
}

/** Everything a failed attempt needs to become a `usage_logs` row. */
export interface AttemptLogContext {
  userId: string;
  apiKeyId: string;
  endpoint: string;
  requestId: string;
  streamed: boolean;
  ipAddress: string;
}

/**
 * Records each failed link as an error row in `usage_logs`.
 *
 * Without this, a fallback would make failures *less* visible than before it existed: a primary
 * that 429s on every request would be served transparently and never appear anywhere, so an
 * operator would have no way to notice a dead upstream. The row carries zero tokens and zero
 * cost, so it neither bills the caller nor consumes their allocation — it is a trace, not a
 * charge. Failures share the successful call's `requestId`, which is what ties an attempt to the
 * request it was part of.
 */
export function attemptRecorder(context: AttemptLogContext): AttemptRecorder {
  return async (attempt) => {
    await recordUsage({
      userId: context.userId,
      apiKeyId: context.apiKeyId,
      modelId: attempt.modelId,
      provider: attempt.provider,
      endpoint: context.endpoint,
      requestId: context.requestId,
      usage: buildUsage(0, 0),
      latencyMs: attempt.latencyMs,
      status: "error",
      httpStatus: attempt.httpStatus,
      errorCode: attempt.code,
      errorMessage: attempt.message,
      costMicroUsd: 0,
      streamed: context.streamed,
      ipAddress: context.ipAddress,
    }).catch((error) => {
      // A trace row failing to write must not turn a served request into an error.
      console.error("[relayn:gateway] fallback attempt log failed:", error);
    });
  };
}

/**
 * Response headers describing a fallback, added only when one actually happened.
 *
 * Deliberately minimal: the model that served and the model that was asked for. The reasons
 * individual links were skipped stay server-side — they are operator diagnostics about the
 * catalogue, not something every API caller needs.
 */
export function fallbackHeaders(
  requested: string,
  outcome: { served: ResolvedModel; failed: FailedAttempt[] },
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (outcome.served.model.modelId !== requested) {
    headers["x-relayn-requested-model"] = requested;
  }
  if (outcome.failed.length > 0) {
    headers["x-relayn-fallback-attempts"] = String(outcome.failed.length);
  }
  return headers;
}

/**
 * Warns once, server-side, when a chain that had to fail over also had unusable links. That
 * combination means the operator's fallback list is not doing what they think it is.
 */
export function warnIfChainDegraded(
  requested: string,
  failed: FailedAttempt[],
  skipped: readonly SkippedLink[],
): void {
  if (failed.length === 0 || skipped.length === 0) return;
  console.warn(
    `[relayn:gateway] \`${requested}\` fell back after ${failed.length} failure(s); unusable links: ${skipped
      .map((link) => `${link.modelId} (${link.reason})`)
      .join(", ")}`,
  );
}
