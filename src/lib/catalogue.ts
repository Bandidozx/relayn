/**
 * Shared vocabulary for catalogue rows (`models`).
 *
 * Deliberately dependency-free so both the server (validation, sync) and client (admin forms)
 * can import it without dragging zod or Prisma into a bundle that does not need them.
 */

/** Categories the dashboard filters by. `inferCategory` in the sync service produces these. */
export const MODEL_CATEGORIES = [
  "chat",
  "reasoning",
  "coding",
  "vision",
  "embeddings",
] as const;

export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

export function isModelCategory(value: unknown): value is ModelCategory {
  return typeof value === "string" && (MODEL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Characters allowed in a public catalogue id.
 *
 * The id appears in `"model"` on a gateway request and inside `x-relayn-model`, so it has to be
 * header-safe and free of anything a URL would re-interpret. Slashes are allowed because synced
 * ids are namespaced `<provider>/<upstream-id>`, and colons because upstreams publish variants
 * like `deepseek-v4-flash:free`.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;

/** How many links a fallback chain may declare, excluding the primary model. */
export const MAX_FALLBACKS = 5;

/** Splits the stored comma-separated fallback list, dropping blanks. */
export function splitFallbacks(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
