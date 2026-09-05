/**
 * Regenerates `src/components/models/vendor-marks.ts`.
 *
 * Marks are generated rather than hand-copied so every path is byte-identical to its source. To
 * re-run after adding a slug below:
 *
 *   npm install --no-save simple-icons@16 @lobehub/icons-static-svg@1
 *   node scripts/generate-vendor-marks.mjs
 *
 * Neither package is a dependency of the app. The generated file is plain data with no imports,
 * so nothing reaches for them at build time or runtime — that is the whole point of vendoring the
 * path data instead of importing an icon library into the bundle.
 *
 * There are two sources because one is not enough:
 *
 * - simple-icons (CC0 1.0) covers most vendors. Public domain, so redistribution here carries no
 *   attribution obligation. Pin the version: DeepSeek, MiniMax, Kimi and Qwen only landed after
 *   15.x — an install of 15.15.0 is why those four shipped as monograms at first — and 16.x has
 *   since dropped OpenAI, so neither an older nor a newer install covers the whole set.
 * - @lobehub/icons-static-svg (MIT) is an AI-vendor set, and fills the two gaps: Z.ai, which
 *   simple-icons has never had a mark for, and OpenAI, which it removed. MIT requires its notice
 *   to travel with the copy, so the notice is written into the generated file's header.
 *
 * A vendor with no mark in either source keeps its monogram. That is a supported end state, not a
 * placeholder: inventing an approximation of someone else's trademark is worse than initials.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as simpleIcons from "simple-icons";

const require = createRequire(import.meta.url);
const OUT = "src/components/models/vendor-marks.ts";

/** Relayn vendor slug → source. `si` is a simple-icons slug, `lobe` a filename in that package. */
const SOURCES = [
  { slug: "anthropic", si: "claude" },
  { slug: "openai", lobe: "openai.svg" },
  { slug: "googlegemini", si: "googlegemini" },
  { slug: "google", si: "google" },
  { slug: "meta", si: "meta" },
  { slug: "mistralai", si: "mistralai" },
  { slug: "nvidia", si: "nvidia" },
  { slug: "xiaomi", si: "xiaomi" },
  { slug: "perplexity", si: "perplexity" },
  { slug: "bytedance", si: "bytedance" },
  { slug: "baidu", si: "baidu" },
  { slug: "deepseek", si: "deepseek" },
  { slug: "minimax", si: "minimax" },
  // The model ids say Kimi (`moonshotai/Kimi-K3`), so the product mark is the recognisable one.
  { slug: "moonshot", si: "kimi" },
  { slug: "qwen", si: "qwen" },
  { slug: "zai", lobe: "zai.svg" },
  // Same product-over-company reasoning as Kimi: the ids say `grok-*`, and a bare xAI "X" in a
  // 22px tile is hard to tell from the social network's.
  { slug: "xai", lobe: "grok.svg" },
  // Four squares, so four <path> elements. simple-icons 16 has no Microsoft mark at all.
  { slug: "microsoft", lobe: "microsoft.svg" },
  // The product mark again — `hunyuan.svg`, not `tencent.svg`, because the ids say `hunyuan-*`.
  { slug: "tencent", lobe: "hunyuan.svg" },
  { slug: "cohere", lobe: "cohere.svg" },
];

const bySlug = new Map();
for (const icon of Object.values(simpleIcons)) {
  if (icon && typeof icon === "object" && icon.slug) bySlug.set(icon.slug, icon);
}

/**
 * Pulls the paths out of a lobehub SVG, and whether it was authored for even-odd fill.
 *
 * Every path is kept rather than merged into one. Concatenating subpaths is only equivalent to
 * drawing them separately when none of them overlap — under `evenodd` an overlap punches a hole —
 * and deciding that needs geometry, per logo, by hand. Emitting the same element count the source
 * has is faithful by construction: Microsoft is four squares and Cohere is three ribbons in the
 * artwork, so they are four and three `<path>` elements here too.
 */
function readLobe(file) {
  const dir = require.resolve("@lobehub/icons-static-svg/package.json").replace(/package\.json$/, "");
  const svg = readFileSync(`${dir}icons/${file}`, "utf8");
  const paths = [...svg.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
  if (paths.length === 0) throw new Error(`${file}: no <path> found`);
  // Anything else — <circle>, <rect>, a gradient — would silently vanish from the copy.
  const others = [...svg.matchAll(/<(circle|rect|ellipse|polygon|polyline|line|use|image)\b/g)];
  if (others.length > 0) {
    throw new Error(`${file}: contains non-path shapes (${others.map((m) => m[1]).join(", ")})`);
  }
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
  if (viewBox !== "0 0 24 24") throw new Error(`${file}: unexpected viewBox ${viewBox}`);
  return { paths, evenOdd: /fill-rule="evenodd"/.test(svg) };
}

const entries = SOURCES.map((source) => {
  if (source.lobe) return { slug: source.slug, ...readLobe(source.lobe), from: `lobehub ${source.lobe}` };
  const icon = bySlug.get(source.si);
  if (!icon) throw new Error(`simple-icons has no "${source.si}" — check the installed version`);
  return { slug: source.slug, paths: [icon.path], evenOdd: false, from: `simple-icons ${source.si}` };
});

const body = entries
  .map(({ slug, paths, evenOdd, from }) => {
    const d = `paths: [${paths.map((one) => JSON.stringify(one)).join(", ")}]`;
    const fields = evenOdd ? `${d}, evenOdd: true` : d;
    return `  // ${from}\n  ${slug}: { ${fields} },`;
  })
  .join("\n");

const file = `/**
 * Vendor marks, vendored as SVG path data. GENERATED — see \`scripts/generate-vendor-marks.mjs\`.
 *
 * Sources, both permissive:
 *
 * - simple-icons (https://simpleicons.org), CC0 1.0. Public domain; no attribution required.
 * - @lobehub/icons-static-svg (https://github.com/lobehub/lobe-icons), MIT. Its notice:
 *
 *     MIT License. Copyright (c) 2023 LobeHub.
 *     Permission is hereby granted, free of charge, to any person obtaining a copy of this
 *     software and associated documentation files (the "Software"), to deal in the Software
 *     without restriction, including without limitation the rights to use, copy, modify, merge,
 *     publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
 *     to whom the Software is furnished to do so, subject to the following conditions: The above
 *     copyright notice and this permission notice shall be included in all copies or substantial
 *     portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 *     EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 *     FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 *     HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 *     CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 *     USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * The logos remain the trademarks of their owners and appear here only to identify which
 * organisation trained a model — the same use a printed comparison table makes of them.
 *
 * Path data is inlined rather than served from \`public/\`: a per-card <img> would fire a 404 for
 * every vendor with no file, and an existence flag would have to be kept in sync by hand.
 *
 * To add a vendor: add its slug to the generator's SOURCES, re-run it, then move that entry from
 * UNMARKED to MARKED in \`@/lib/vendor\`. A slug with no entry here renders a monogram.
 */

export interface VendorMarkShape {
  /**
   * One entry per \`<path>\` in the source artwork, on a \`0 0 24 24\` viewBox, each drawn with
   * \`fill: currentColor\`. Most marks are a single path; Microsoft's four squares and Cohere's
   * three ribbons are not, and they are kept as separate elements rather than concatenated
   * because merging subpaths changes the result wherever they overlap.
   */
  paths: string[];
  /**
   * True when the artwork was authored for \`fill-rule: evenodd\`, where overlapping subpaths
   * punch holes instead of merging. Applying the wrong rule silently fills a logo solid, so it
   * travels with the path rather than being set once for every mark.
   */
  evenOdd?: boolean;
}

export const VENDOR_MARKS: Record<string, VendorMarkShape> = {
${body}
};
`;

writeFileSync(OUT, file);
console.log(`wrote ${OUT} — ${entries.length} marks`);
for (const entry of entries) {
  const shape = entry.paths.length === 1 ? "" : ` (${entry.paths.length} paths)`;
  console.log(`  ${entry.slug.padEnd(13)} ${entry.from}${shape}`);
}
