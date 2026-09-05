/**
 * Vendor resolution for catalogue cards.
 *
 * The point of this module is that the mark on a card identifies who *trained* the model, not who
 * *serves* it. Relayn reaches most of its catalogue through one aggregator, so resolving from
 * `model.provider` would stamp an identical logo on nearly every card. These tests pin that
 * behaviour with real ids taken from the live catalogue, because the failure mode is silent: a
 * regression still renders a tile, just the wrong one on every row.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveVendor } from "@/lib/vendor";
import { VENDOR_MARKS } from "@/components/models/vendor-marks";
import { visibleDescription } from "@/server/services/models-service";

describe("resolveVendor", () => {
  it("distinguishes vendors that all arrive through the same provider", () => {
    const provider = "madefaka";
    const slugs = [
      "madefaka/deepseek-ai/DeepSeek-V4-Flash",
      "madefaka/MiniMaxAI/MiniMax-M2.7",
      "madefaka/XiaomiMiMo/MiMo-V2.5-Pro",
      "madefaka/moonshotai/Kimi-K3",
      "madefaka/zai-org/GLM-4.7",
      "madefaka/nvidia/Nemotron-5-Super",
    ].map((id) => resolveVendor(id, provider).slug);

    expect(slugs).toEqual(["deepseek", "minimax", "xiaomi", "moonshot", "zai", "nvidia"]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("reads the segment after the provider prefix first", () => {
    // A provider is free to be named anything from Admin → Providers, so its name may collide
    // with a vendor keyword. The model, not the route, decides the mark.
    expect(resolveVendor("claude-proxy/llama-3.4-70b", "claude-proxy").slug).toBe("meta");
    expect(resolveVendor("openrouter/anthropic/claude-sonnet-5", "openrouter").slug).toBe(
      "anthropic",
    );
  });

  it("falls back to the whole id when the tail says nothing", () => {
    expect(resolveVendor("mock/relayn-echo", "mock").slug).toBe("sandbox");
  });

  it("uses the provider when a first-party id carries no vendor signal", () => {
    // First-party rows are stored unprefixed, so "o3" on its own says nothing about who made it.
    const vendor = resolveVendor("o3", "openai");
    expect(vendor.slug).toBe("openai");
    expect(vendor.color).toBe("#DFE4EE");
    expect(VENDOR_MARKS[vendor.slug]?.d).toBeTypeOf("string");
  });

  it("namespaces a fallback slug so it cannot borrow someone else's logo", () => {
    // `meta` is a mark slug but the Meta rule keys on "meta-", so an unrelated provider called
    // "meta" would otherwise render Meta's logo in a palette colour that is not Meta's blue.
    const vendor = resolveVendor("house-model-v1", "meta");
    expect(vendor.slug).toBe("provider:meta");
    expect(VENDOR_MARKS[vendor.slug]).toBeUndefined();
  });

  it("keeps Gemma on the Google mark rather than the Gemini one", () => {
    expect(resolveVendor("google/gemma-4-27b", "google").slug).toBe("google");
    expect(resolveVendor("google/gemini-3-pro", "google").slug).toBe("googlegemini");
  });

  it("degrades to a monogram for a vendor it has never seen", () => {
    // The case that matters operationally: a provider added after deploy. It must still get a
    // usable tile with no code change.
    const vendor = resolveVendor("token-harbor/some-unreleased-model", "token-harbor");
    expect(vendor.label).toBe("Token Harbor");
    expect(vendor.initials).toBe("TH");
    expect(VENDOR_MARKS[vendor.slug]).toBeUndefined();
  });

  it("is deterministic, so a card does not change colour between renders", () => {
    const id = "brand-new-provider/unknown-model";
    expect(resolveVendor(id, "brand-new-provider")).toEqual(
      resolveVendor(id, "brand-new-provider"),
    );
  });

  it("only pairs a literal brand colour with a mark it actually ships", () => {
    // The documented rule in @/lib/vendor is one-way: a hex asserts an authentic brand colour, so
    // it may not appear without an authentic logo. A logo without a hex is fine and deliberate —
    // Kimi and Z.ai publish black marks, which are invisible on a dark card.
    const ids = [
      "openai/gpt-5",
      "openrouter/anthropic/claude-sonnet-5",
      "google/gemini-3-pro",
      "google/gemma-4-27b",
      "madefaka/meta-llama/Llama-4-70B",
      "madefaka/mistralai/Mistral-Large-3",
      "madefaka/nvidia/Nemotron-5-Super",
      "madefaka/XiaomiMiMo/MiMo-V2.5-Pro",
      "madefaka/deepseek-ai/DeepSeek-V4-Flash",
      "madefaka/moonshotai/Kimi-K3",
      "madefaka/zai-org/GLM-4.7",
      "madefaka/Qwen/Qwen3-Max",
      "mock/relayn-echo",
    ];

    for (const id of ids) {
      const vendor = resolveVendor(id, id.split("/")[0]);
      const hasMark = typeof VENDOR_MARKS[vendor.slug]?.d === "string";
      if (vendor.color.startsWith("#")) {
        expect(hasMark, `${id} → ${vendor.slug} claims a brand colour`).toBe(true);
      }
      expect(vendor.initials, `${id} → ${vendor.slug}`).toMatch(/^[A-Z]{1,3}$/);
    }
  });

  it("ships a real mark for every vendor the live catalogue actually routes to", () => {
    // The regression this pins is the one a user reported: five of these arrived through Madefaka
    // and rendered as monograms, because the installed simple-icons predated their marks.
    const rows: Array<[string, string]> = [
      ["madefaka/deepseek-ai/DeepSeek-V4-Flash", "madefaka"],
      ["madefaka/MiniMaxAI/MiniMax-M2.7", "madefaka"],
      ["madefaka/moonshotai/Kimi-K3", "madefaka"],
      ["madefaka/Qwen/Qwen3-Max", "madefaka"],
      ["madefaka/zai-org/GLM-4.7", "madefaka"],
      ["madefaka/XiaomiMiMo/MiMo-V2.5-Pro", "madefaka"],
      ["madefaka/nvidia/Nemotron-5-Super", "madefaka"],
      ["claude-opus-5", "anthropic"],
      // Unprefixed first-party row: the mark has to come from the provider, not the id.
      ["o3", "openai"],
    ];

    for (const [id, provider] of rows) {
      const vendor = resolveVendor(id, provider);
      expect(VENDOR_MARKS[vendor.slug]?.d, `${id} → ${vendor.slug}`).toBeTypeOf("string");
    }
  });

  it("keeps every brand colour readable on the card it is drawn on", () => {
    // Reads the real token instead of a copy of it, so retuning the palette re-runs the check.
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    const surface = css.match(/--color-surface:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(surface, "--color-surface must be a hex in globals.css").toBeTypeOf("string");

    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const luminance = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return (
        0.2126 * channel((n >> 16) & 255) +
        0.7152 * channel((n >> 8) & 255) +
        0.0722 * channel(n & 255)
      );
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };

    const ids = [
      "openai/gpt-5",
      "openrouter/anthropic/claude-sonnet-5",
      "google/gemini-3-pro",
      "google/gemma-4-27b",
      "madefaka/meta-llama/Llama-4-70B",
      "madefaka/mistralai/Mistral-Large-3",
      "madefaka/nvidia/Nemotron-5-Super",
      "madefaka/XiaomiMiMo/MiMo-V2.5-Pro",
      "madefaka/deepseek-ai/DeepSeek-V4-Flash",
      "madefaka/MiniMaxAI/MiniMax-M2.7",
      "madefaka/Qwen/Qwen3-Max",
      "x/ernie-5.0",
      "x/doubao-pro",
      "x/sonar-large",
    ];

    for (const id of ids) {
      const { slug, color } = resolveVendor(id, id.split("/")[0]);
      if (!color.startsWith("#")) continue;
      expect(contrast(color, surface as string), `${slug} ${color} on ${surface}`).toBeGreaterThan(
        4.5,
      );
    }
  });

  it("never spends amber on a vendor, because the card spends it on the plan gate", () => {
    const ids = ["madefaka/Qwen/Qwen3-Max", "madefaka/moonshotai/Kimi-K3", "x/grok-5"];
    for (const id of ids) {
      expect(resolveVendor(id, id.split("/")[0]).color).not.toContain("amber");
    }
  });
});

describe("visibleDescription", () => {
  it("drops the sentence catalogue sync used to generate", () => {
    const generated =
      "Served by Madefaka as `deepseek-ai/DeepSeek-V4-Flash`. Discovered by catalogue sync; " +
      "pricing and tier are editable in Admin → Models.";
    expect(visibleDescription(generated)).toBe("");
  });

  it("leaves a description an operator typed alone", () => {
    const written = "Fast reasoning model. Cheapest option for bulk classification.";
    expect(visibleDescription(written)).toBe(written);
  });

  it("treats an empty description as empty rather than throwing", () => {
    expect(visibleDescription("")).toBe("");
    expect(visibleDescription("   ")).toBe("");
  });
});
