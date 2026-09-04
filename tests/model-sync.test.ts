/**
 * Catalogue-sync heuristics.
 *
 * These decide what a discovered model looks like the first time it is seen: which category
 * filter it lands under, and — the one with teeth — which plan may call it. `inferMinPlan`
 * gates spend, so its boundaries are asserted rather than assumed: a priced model must never
 * default onto the Free tier, where a 250K-token allocation could be spent on an expensive
 * upstream by an account that never paid.
 */
import { describe, expect, it } from "vitest";
import { deriveName, inferCategory, inferMinPlan } from "@/server/services/model-sync-service";

describe("inferCategory", () => {
  it("recognises embeddings before anything else", () => {
    expect(inferCategory("text-embedding-3-large")).toBe("embeddings");
    expect(inferCategory("BAAI/bge-m3")).toBe("embeddings");
  });

  it("recognises vision models", () => {
    expect(inferCategory("Qwen/Qwen2.5-VL-72B")).toBe("vision");
    expect(inferCategory("gpt-4o-vision-preview")).toBe("vision");
  });

  it("recognises coding models", () => {
    expect(inferCategory("Qwen/Qwen3-Coder-480B")).toBe("coding");
    expect(inferCategory("bigcode/starcoder2")).toBe("coding");
  });

  it("recognises reasoning models", () => {
    expect(inferCategory("deepseek-ai/DeepSeek-R1")).toBe("reasoning");
    expect(inferCategory("f/nemotron-3-ultra-free")).toBe("reasoning");
    expect(inferCategory("claude-sonnet-4-thinking")).toBe("reasoning");
  });

  it("falls back to chat rather than inventing a category", () => {
    expect(inferCategory("XiaomiMiMo/MiMo-V2.5")).toBe("chat");
    expect(inferCategory("f/big-pickle")).toBe("chat");
  });

  it("is case-insensitive", () => {
    expect(inferCategory("SOME/EMBEDDING-MODEL")).toBe("embeddings");
  });
});

describe("inferMinPlan", () => {
  it("keeps a genuinely free model open to everyone", () => {
    expect(inferMinPlan(0)).toBe("free");
  });

  it("treats an unpublished price as free rather than guessing a tier", () => {
    // A gateway that publishes no pricing is metered at zero cost, so gating it would deny
    // access to something that cannot generate a bill.
    expect(inferMinPlan(undefined)).toBe("free");
  });

  it("never leaves a priced model on the free tier", () => {
    // The smallest price above zero is still real money against a plan nobody paid for.
    expect(inferMinPlan(0.0001)).toBe("pro");
    expect(inferMinPlan(2)).toBe("pro");
  });

  it("escalates an expensive model past pro", () => {
    expect(inferMinPlan(2.01)).toBe("business");
    expect(inferMinPlan(13.3)).toBe("business");
  });
});

describe("deriveName", () => {
  it("drops the namespace and title-cases the rest", () => {
    expect(deriveName("deepseek-ai/DeepSeek-V4-Flash")).toBe("DeepSeek V4 Flash");
    expect(deriveName("f/nemotron-3.5-lightning-free")).toBe("Nemotron 3.5 Lightning Free");
  });

  it("leaves existing capitalisation alone", () => {
    expect(deriveName("XiaomiMiMo/MiMo-V2.5")).toBe("MiMo V2.5");
  });

  it("handles an id with no namespace", () => {
    expect(deriveName("gpt-4o-mini")).toBe("Gpt 4o Mini");
  });

  it("collapses underscores and repeated separators", () => {
    expect(deriveName("some__weird--id")).toBe("Some Weird Id");
  });
});
