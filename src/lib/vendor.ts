/**
 * Model-vendor resolution.
 *
 * The mark on a catalogue card identifies the organisation that TRAINED the model, not the
 * gateway that serves it. Relayn reaches most of its catalogue through a single aggregator, so
 * a per-provider mark would stamp the same logo on nearly every card and carry no information.
 * The provider name stays in the card footer, which is where the routing question belongs.
 *
 * The vendor is read out of the model id. In practice ids look like
 * `<provider>/[<vendor-namespace>/]<model>` — `madefaka/deepseek-ai/DeepSeek-V4-Flash`,
 * `token-harbor/mimo-v2.5:free`, `openai/gpt-5`. The namespace segment is optional and
 * formatted inconsistently between upstreams, so matching is keyword-based over the id rather
 * than positional.
 *
 * Nothing here reaches the network and nothing is inferred at build time: an unrecognised
 * vendor degrades to a monogram, so a provider added from Admin → Providers after deploy gets
 * a sensible tile with no code change.
 */
import { titleCase } from "@/lib/format";

export interface Vendor {
  /** Stable key. Also the lookup key for an SVG mark in `vendor-marks.ts`. */
  slug: string;
  /** Human label. Used as the mark's accessible name. */
  label: string;
  /**
   * Colour of the tile's glyph, background tint and border.
   *
   * A hex here is an authentic third-party brand colour, so it may only appear on a vendor whose
   * real logo we ship. The reverse does not hold: a vendor can have a real logo and still wear a
   * Relayn palette token, which is what happens when the published colour is black — readable on
   * the brand's own white page, invisible on this card. What never happens is a guessed hex, since
   * that would assert something unverified.
   *
   * This is the one place in the app where a literal hex is legitimate: these are other
   * companies' colours, not theme values, so they do not belong in `globals.css`.
   */
  color: string;
  /** 1–3 characters, rendered when no SVG mark exists for `slug`. */
  initials: string;
}

interface VendorRule extends Vendor {
  /** Lowercase substrings. The first rule with any hit wins, so order encodes specificity. */
  match: string[];
}

const PALETTE = [
  "var(--color-brand)",
  "var(--color-violet)",
  "var(--color-sky)",
  "var(--color-rose)",
] as const;

/*
 * Vendors we ship an authentic mark for.
 *
 * A literal hex is a published brand colour, so it may only ever appear next to a real logo. Four
 * are lifted in lightness from the published value because they do not survive a dark card:
 * OpenAI's #412991 (1.7:1 against `--color-surface`) and Baidu's #2932E1 (2.2:1) are unreadable,
 * and Meta's #0467DF (3.4:1) and Qwen's #6950EF (3.4:1) miss 4.5:1. MiniMax's #E73562 lands at
 * 4.31:1, close enough to lift by a hair rather than replace. Hue and saturation are preserved in
 * each case; brands publish dark-mode variants for exactly this reason. `tests/vendor.test.ts`
 * recomputes every ratio against the real token, so a future edit cannot quietly drop below it.
 *
 * Two vendors keep a Relayn colour despite having a real mark: Kimi and Z.ai both publish a
 * monochrome black logo, and black on a dark card is nothing at all. Microsoft is a third case —
 * four published colours, no primary — explained where it sits. Marks are generated into
 * `vendor-marks.ts` by `scripts/generate-vendor-marks.mjs` — see that file for sources.
 */
const MARKED: VendorRule[] = [
  {
    slug: "anthropic",
    label: "Anthropic",
    color: "#D97757",
    initials: "AN",
    match: ["claude", "anthropic", "sonnet", "opus", "haiku"],
  },
  {
    slug: "openai",
    label: "OpenAI",
    color: "#DFE4EE",
    initials: "AI",
    match: ["gpt", "openai", "codex", "dall-e", "whisper"],
  },
  {
    slug: "googlegemini",
    label: "Google Gemini",
    color: "#A78FD0",
    initials: "GM",
    match: ["gemini"],
  },
  {
    slug: "google",
    label: "Google",
    color: "#4285F4",
    initials: "GO",
    match: ["gemma", "google", "palm"],
  },
  { slug: "meta", label: "Meta Llama", color: "#1E8AFF", initials: "LL", match: ["llama", "meta-"] },
  {
    slug: "mistralai",
    label: "Mistral AI",
    color: "#FA520F",
    initials: "MS",
    match: ["mistral", "mixtral", "magistral", "codestral", "devstral", "pixtral"],
  },
  { slug: "nvidia", label: "NVIDIA", color: "#76B900", initials: "NV", match: ["nemotron", "nvidia"] },
  { slug: "xiaomi", label: "Xiaomi MiMo", color: "#FF6900", initials: "MI", match: ["mimo", "xiaomi"] },
  {
    slug: "perplexity",
    label: "Perplexity",
    color: "#1FB8CD",
    initials: "PX",
    match: ["sonar", "perplexity"],
  },
  {
    slug: "bytedance",
    label: "ByteDance",
    color: "#3C8CFF",
    initials: "BD",
    match: ["doubao", "bytedance", "seed-"],
  },
  { slug: "baidu", label: "Baidu ERNIE", color: "#7B82FF", initials: "BA", match: ["ernie", "baidu"] },
  { slug: "deepseek", label: "DeepSeek", color: "#5786FE", initials: "DS", match: ["deepseek"] },
  { slug: "minimax", label: "MiniMax", color: "#E9456F", initials: "MM", match: ["minimax"] },
  {
    slug: "moonshot",
    label: "Moonshot Kimi",
    color: PALETTE[1],
    initials: "KI",
    match: ["kimi", "moonshot"],
  },
  {
    slug: "qwen",
    label: "Alibaba Qwen",
    color: "#8470F2",
    initials: "QW",
    match: ["qwen", "qwq", "tongyi"],
  },
  { slug: "zai", label: "Z.ai GLM", color: PALETTE[0], initials: "GL", match: ["glm", "z-ai", "zhipu"] },
  {
    slug: "xai",
    // xAI publishes its mark in black and white only, with no chromatic brand colour to borrow.
    // White is not a guess here — it is the published reverse mark, which is exactly the variant
    // a dark tile calls for.
    label: "xAI Grok",
    color: "#FFFFFF",
    initials: "XA",
    match: ["grok", "x-ai"],
  },
  {
    // Microsoft's logo is four squares in four published colours (#F25022, #7FBA00, #00A4EF,
    // #FFB900) with no designated primary. A tile draws one colour, so naming one of the four
    // would assert a hierarchy the brand does not publish — hence a Relayn token beside a real
    // logo, which the rule above explicitly allows.
    slug: "microsoft",
    label: "Microsoft",
    color: PALETTE[2],
    initials: "MS",
    match: ["phi-", "wizardlm"],
  },
  {
    // Hunyuan's artwork is a #0055E9 disc behind a cyan-and-white swirl. The disc blue manages
    // 3.1:1 on this card, and lifting it lands on top of the four blues already in this list
    // (Google, Meta, ByteDance, DeepSeek), so the tile wears the other large published colour
    // from the same mark instead of a fifth near-identical blue.
    slug: "tencent",
    label: "Tencent Hunyuan",
    color: "#00BCFF",
    initials: "HY",
    match: ["hunyuan", "tencent"],
  },
  {
    // Tri-colour mark. The primary, Volcanic Green #39594D, is 2.4:1 here — unreadable — so the
    // coral of the third ribbon carries it.
    slug: "cohere",
    label: "Cohere",
    color: "#FF7759",
    initials: "CO",
    match: ["command-", "cohere"],
  },
];

/*
 * The one vendor with no mark, and the one that will never have one: Relayn's own mock provider is
 * not a third party, so there is no logo to ship. A monogram in a Relayn palette colour — and
 * deliberately never amber, which this page already spends on the locked-model state — is the end
 * state, not a placeholder. Anything the rules above do not recognise degrades the same way.
 */
const UNMARKED: VendorRule[] = [
  { slug: "sandbox", label: "Relayn Sandbox", color: "var(--color-ink-faint)", initials: "RL", match: ["mock", "sandbox"] },
];

const RULES: VendorRule[] = [...MARKED, ...UNMARKED];

function findRule(haystack: string): VendorRule | undefined {
  return RULES.find((rule) => rule.match.some((needle) => haystack.includes(needle)));
}

function initialsOf(label: string): string {
  const [first = label, second] = label.split(/\s+/).filter(Boolean);
  const raw = second ? first.slice(0, 1) + second.slice(0, 1) : first.slice(0, 2);
  return raw.toUpperCase();
}

/**
 * Resolves the training organisation behind a catalogue row.
 *
 * Three lookups, narrowest first.
 *
 * 1. The segment after the provider prefix. Providers can be created from Admin → Providers with
 *    an arbitrary name, so a provider slug is free to collide with a vendor keyword —
 *    `claude-proxy/llama-3.4` has to resolve to Meta, not Anthropic.
 * 2. The whole id. Catches single-segment ids and providers that really are the vendor.
 * 3. The provider name on its own. First-party rows are stored unprefixed (`o3`, not
 *    `openai/o3`), so the id alone can carry no vendor signal at all.
 *
 * Anything left over becomes a monogram. Its slug is namespaced so it can never collide with a
 * mark: a provider named `meta` must not borrow Meta's logo while wearing a palette colour.
 */
export function resolveVendor(modelId: string, provider = ""): Vendor {
  const id = modelId.toLowerCase();
  const slash = id.indexOf("/");
  const tail = slash === -1 ? "" : id.slice(slash + 1);
  const name = (provider || id.split("/")[0] || "unknown").toLowerCase();

  const hit = (tail ? findRule(tail) : undefined) ?? findRule(id) ?? findRule(name);
  if (hit) {
    return { slug: hit.slug, label: hit.label, color: hit.color, initials: hit.initials };
  }

  const label = titleCase(name).trim() || "Unknown";
  const spread = [...name].reduce((total, char) => total + char.charCodeAt(0), 0);
  const color = PALETTE[spread % PALETTE.length] ?? PALETTE[0];
  return { slug: `provider:${name}`, label, color, initials: initialsOf(label) };
}


