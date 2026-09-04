/**
 * Presentation formatters, shared by server and client components so a token count or a
 * price renders identically everywhere.
 */

const NUMBER = new Intl.NumberFormat("en-US");
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatNumber(value: number): string {
  return NUMBER.format(Math.round(value));
}

/** 1_240_000 → "1.2M". Used in metric cards where width is tight. */
export function formatCompact(value: number): string {
  if (Math.abs(value) < 1000) return String(Math.round(value));
  return COMPACT.format(value);
}

export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/**
 * A model limit (context window, max output) that the upstream may simply not publish.
 * Zero means "unknown" for these fields, and rendering it as `0` reads as a broken row —
 * an em dash says the same thing truthfully. Not `formatCompact`, where 0 is a real count.
 */
export function formatLimit(value: number): string {
  return value > 0 ? formatCompact(value) : "—";
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Money is stored as integer micro-USD; render it at a sensible precision. */
export function formatMicroUsd(micro: number): string {
  if (micro === 0) return "$0.00";
  const usd = micro / 1_000_000;
  if (usd < 0.01) return `$${usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0")}`;
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${NUMBER.format(Math.round(usd))}`;
}

export function formatUsd(value: number): string {
  return value % 1 === 0 ? `$${NUMBER.format(value)}` : `$${value.toFixed(2)}`;
}

/**
 * Whole rupiah, Indonesian convention: `Rp5.000`, dot as the thousands separator.
 *
 * Grouped by hand rather than through `Intl.NumberFormat("id-ID", { style: "currency" })`,
 * which emits `Rp` followed by a non-breaking space (U+00A0) and a `,00` fraction. That is
 * invisible in a browser but makes the string awkward to place inline in copy and impossible
 * to assert on without pasting a U+00A0 into the test. Doing the grouping here also keeps the
 * output identical regardless of which ICU locale data the runtime ships with.
 */
export function formatIdr(value: number): string {
  const digits = String(Math.max(0, Math.round(value)));
  let grouped = "";
  for (let i = 0; i < digits.length; i += 1) {
    // Dot before every third digit counted from the right, except at the very start.
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ".";
    grouped += digits[i];
  }
  return `Rp${grouped}`;
}

/** Per-1M-token catalogue price. */
export function formatPricePerMillion(value: number): string {
  if (value === 0) return "Free";
  return `$${value < 1 ? value.toFixed(2) : value.toFixed(2).replace(/\.00$/, "")}/M`;
}

export function formatDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return "Never";
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const table: Array<[number, string]> = [
    [60, "minute"],
    [3600, "hour"],
    [86_400, "day"],
    [604_800, "week"],
    [2_592_000, "month"],
  ];
  let unitSeconds = 60;
  let unit = "minute";
  for (const [threshold, name] of table) {
    if (seconds >= threshold) {
      unitSeconds = threshold;
      unit = name;
    }
  }
  if (seconds >= 31_536_000) {
    unitSeconds = 31_536_000;
    unit = "year";
  }
  const amount = Math.max(1, Math.floor(seconds / unitSeconds));
  return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}

export function formatTokens(value: number): string {
  return `${formatCompact(value)} tok`;
}

/** Short axis label for day-bucketed charts. */
export function formatDayLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}
