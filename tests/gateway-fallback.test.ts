/**
 * Fallback execution — when a chain advances, and when it must not.
 *
 * Three properties matter enough to pin down:
 *
 *   1. **Only upstream-owned failures advance.** A malformed request would be rejected
 *      identically by every link, so retrying it multiplies latency and upstream spend for
 *      nothing. A rejected operator credential stops the chain too, so a broken provider stays
 *      visible instead of being silently routed around forever.
 *   2. **A committed stream is never spliced.** `openStreamWithFallback` may only switch models
 *      before the first chunk reaches the caller; after that a failure has to surface as a
 *      failure, because two different completions concatenated is worse than a truncated one.
 *   3. **Every failed attempt is recorded.** Without this a primary that 429s on every request
 *      would be invisible to the operator, which is exactly the fault a fallback hides.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fallbackHeaders,
  isFallbackWorthy,
  openStreamWithFallback,
  runWithFallback,
  type FailedAttempt,
} from "@/lib/gateway/fallback";
import { ProviderError, type StreamChunk } from "@/lib/providers/types";
import type { ResolvedModel } from "@/lib/gateway/pipeline";

// `fallback` pulls in usage accounting, which builds a PrismaClient at import time.
vi.mock("@/lib/db", () => ({ prisma: {} }));

/** A chain link with only the fields this module reads. */
function link(modelId: string, provider = "acme"): ResolvedModel {
  return {
    model: { modelId, provider } as ResolvedModel["model"],
    provider: { id: provider } as ResolvedModel["provider"],
    upstreamModel: modelId,
  };
}

const RETRYABLE = [
  "upstream_error",
  "upstream_timeout",
  "upstream_rate_limited",
  "upstream_out_of_credit",
  "model_unavailable",
  "provider_unconfigured",
] as const;

const TERMINAL = ["invalid_request", "upstream_unauthorized"] as const;

describe("isFallbackWorthy", () => {
  it("advances on every failure another provider might not have", () => {
    for (const code of RETRYABLE) {
      expect(isFallbackWorthy(new ProviderError(code, "boom", 502))).toBe(true);
    }
  });

  it("stops on a caller-owned request and on a rejected credential", () => {
    for (const code of TERMINAL) {
      expect(isFallbackWorthy(new ProviderError(code, "boom", 400))).toBe(false);
    }
  });

  it("stops on anything a provider did not deliberately classify", () => {
    expect(isFallbackWorthy(new Error("socket hang up"))).toBe(false);
    expect(isFallbackWorthy(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isFallbackWorthy("upstream_rate_limited")).toBe(false);
  });
});

describe("runWithFallback", () => {
  it("returns the primary's result and attempts nothing else", async () => {
    const attempt = vi.fn().mockResolvedValue("answer");
    const outcome = await runWithFallback([link("a"), link("b")], attempt);

    expect(outcome.result).toBe("answer");
    expect(outcome.served.model.modelId).toBe("a");
    expect(outcome.failed).toEqual([]);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("advances in declared order and reports the link that actually served", async () => {
    const tried: string[] = [];
    const outcome = await runWithFallback([link("a"), link("b"), link("c")], async (candidate) => {
      tried.push(candidate.model.modelId);
      if (candidate.model.modelId !== "c") {
        throw new ProviderError("upstream_rate_limited", "429 from upstream", 429);
      }
      return "answer";
    });

    expect(tried).toEqual(["a", "b", "c"]);
    expect(outcome.served.model.modelId).toBe("c");
    expect(outcome.failed.map((entry) => entry.modelId)).toEqual(["a", "b"]);
  });

  it("records every failed attempt before the next is tried", async () => {
    const recorded: FailedAttempt[] = [];
    const record = vi.fn(async (attempt: FailedAttempt) => {
      recorded.push(attempt);
    });

    await runWithFallback(
      [link("a", "one"), link("b", "two")],
      async (candidate) => {
        if (candidate.model.modelId === "a") {
          throw new ProviderError("upstream_out_of_credit", "no credit", 402);
        }
        return "answer";
      },
      record,
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      modelId: "a",
      provider: "one",
      code: "upstream_out_of_credit",
      message: "no credit",
      httpStatus: 402,
    });
    expect(recorded[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("stops immediately on a caller-owned error and rethrows it untouched", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new ProviderError("invalid_request", "messages: Too big", 400));
    const record = vi.fn();

    await expect(runWithFallback([link("a"), link("b")], attempt, record)).rejects.toMatchObject({
      code: "invalid_request",
      message: "messages: Too big",
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it("stops on a rejected operator credential rather than hiding a broken provider", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new ProviderError("upstream_unauthorized", "bad key", 401));

    await expect(runWithFallback([link("a"), link("b")], attempt)).rejects.toMatchObject({
      code: "upstream_unauthorized",
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("throws the last error when every link fails, and records all but that one", async () => {
    // The final error describes the state the caller is actually in; earlier ones are not lost
    // because each was already handed to the recorder.
    const record = vi.fn();
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError("upstream_rate_limited", "first", 429))
      .mockRejectedValueOnce(new ProviderError("upstream_timeout", "last", 504));

    await expect(runWithFallback([link("a"), link("b")], attempt, record)).rejects.toMatchObject({
      code: "upstream_timeout",
      message: "last",
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ modelId: "a", code: "upstream_rate_limited" });
  });
});

/** Collects a whole stream so the assertion is about what a caller would have received. */
async function drain(chunks: AsyncIterable<StreamChunk>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) text += chunk.delta ?? "";
  return text;
}

describe("openStreamWithFallback", () => {
  it("fails over when the upstream refuses before the first chunk", async () => {
    const outcome = await openStreamWithFallback([link("a"), link("b")], (candidate) => ({
      async *[Symbol.asyncIterator]() {
        if (candidate.model.modelId === "a") {
          throw new ProviderError("upstream_rate_limited", "429", 429);
        }
        yield { delta: "hi " };
        yield { delta: "there" };
      },
    }));

    expect(outcome.served.model.modelId).toBe("b");
    expect(outcome.failed.map((entry) => entry.modelId)).toEqual(["a"]);
    expect(await drain(outcome.result)).toBe("hi there");
  });

  it("replays the probed first chunk exactly once", async () => {
    // The first chunk is consumed inside the retry loop; forgetting to re-emit it would silently
    // drop the opening token of every streamed response.
    const outcome = await openStreamWithFallback([link("a")], () => ({
      async *[Symbol.asyncIterator]() {
        yield { delta: "one" };
        yield { delta: "two" };
      },
    }));

    expect(await drain(outcome.result)).toBe("onetwo");
  });

  it("does not switch models once a chunk has been emitted", async () => {
    const opened: string[] = [];
    const outcome = await openStreamWithFallback([link("a"), link("b")], (candidate) => {
      opened.push(candidate.model.modelId);
      return {
        async *[Symbol.asyncIterator]() {
          yield { delta: "partial" };
          throw new ProviderError("upstream_error", "died mid-stream", 502);
        },
      };
    });

    // The response is already committed, so the failure must surface rather than be papered over
    // by splicing a second completion onto the first.
    await expect(drain(outcome.result)).rejects.toMatchObject({ code: "upstream_error" });
    expect(opened).toEqual(["a"]);
  });

  it("closes the upstream iterator when the consumer stops early", async () => {
    let closed = false;
    const outcome = await openStreamWithFallback([link("a")], () => ({
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            index += 1;
            return { done: false, value: { delta: `c${index}` } };
          },
          async return() {
            closed = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    }));

    for await (const chunk of outcome.result) {
      if (chunk.delta === "c2") break;
    }
    expect(closed).toBe(true);
  });

  it("yields nothing for an upstream that closes without a chunk", async () => {
    const outcome = await openStreamWithFallback([link("a")], () => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {},
    }));
    expect(await drain(outcome.result)).toBe("");
  });
});

describe("fallbackHeaders", () => {
  const failure: FailedAttempt = {
    modelId: "a",
    provider: "one",
    code: "upstream_rate_limited",
    message: "429",
    httpStatus: 429,
    latencyMs: 12,
  };

  it("adds nothing when the requested model served it", () => {
    expect(fallbackHeaders("a", { served: link("a"), failed: [] })).toEqual({});
  });

  it("names the requested model only when a different one answered", () => {
    expect(fallbackHeaders("a", { served: link("b"), failed: [failure] })).toEqual({
      "x-relayn-requested-model": "a",
      "x-relayn-fallback-attempts": "1",
    });
  });

  it("counts attempts even when the primary eventually served", () => {
    // A retry that lands back on the primary is still worth reporting: the caller paid the
    // latency of a failed upstream call.
    expect(fallbackHeaders("a", { served: link("a"), failed: [failure, failure] })).toEqual({
      "x-relayn-fallback-attempts": "2",
    });
  });
});
