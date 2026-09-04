/**
 * Exact decimal ↔ base-unit conversion for token amounts.
 *
 * Pure string and BigInt arithmetic, with no floating point anywhere. That is not fussiness:
 * `0.1 * 1e6` is `100000.00000000001` in IEEE-754, and `parseFloat("0.10") * 10 ** 18` loses
 * precision outright. A payment gate that compares amounts must not be built on either.
 *
 * These functions are also the reason the configured price can be written the way an operator
 * would naturally write it (`CRYPTO_PAYMENT_AMOUNT="0.10"`) without the ambiguity of "is that
 * whole units or base units?" — the conversion is explicit, and over-precise input is an error
 * rather than a silent truncation.
 */

/** Thrown for a malformed configured amount. Never surfaced to a payer. */
export class AmountFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountFormatError";
  }
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * `"0.10"`, 6 → `"100000"`.
 *
 * Rejects a fraction longer than the asset supports rather than rounding it: an operator who
 * writes `0.1000005` for a 6-decimal token has made a mistake worth surfacing at boot, not a
 * request-time rounding decision.
 */
export function toBaseUnits(amount: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new AmountFormatError(`Unsupported decimals: ${decimals}`);
  }
  const match = DECIMAL.exec(amount.trim());
  if (!match) {
    throw new AmountFormatError(`Not a plain decimal amount: ${JSON.stringify(amount)}`);
  }
  const whole = match[1] as string;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new AmountFormatError(
      `${amount} has ${fraction.length} decimal places but the asset has ${decimals}.`,
    );
  }
  const scaled = `${whole}${fraction.padEnd(decimals, "0")}`;
  // Strip leading zeros without turning "0" into "".
  const value = BigInt(scaled);
  if (value <= 0n) {
    throw new AmountFormatError(`Amount must be greater than zero: ${amount}`);
  }
  return value.toString();
}

/** `"100000"`, 6 → `"0.1"`. Trailing fractional zeros are dropped. */
export function fromBaseUnits(baseUnits: string, decimals: number): string {
  const value = parseBaseUnits(baseUnits);
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/**
 * Parses a base-unit string that came out of the database or off the chain.
 *
 * Returns `0n` for null/empty rather than throwing, because "no transfer was observed" is a
 * legitimate observation that the rules layer must be able to reason about.
 */
export function parseBaseUnits(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (!/^\d+$/.test(value)) {
    throw new AmountFormatError(`Not a base-unit integer: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/**
 * Formats a base-unit amount for display with a fixed number of fractional digits, so
 * "0.1 USDC" reads as "0.10 USDC" next to a "$0.10" price.
 */
export function formatAssetAmount(baseUnits: string, decimals: number, digits = 2): string {
  const value = parseBaseUnits(baseUnits);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  if (digits === 0) return whole.toString();
  const fraction = (value % scale).toString().padStart(decimals, "0");
  const shown = fraction.slice(0, digits).padEnd(digits, "0");
  // A non-zero remainder beyond `digits` must not read as an exact figure.
  const truncated = /[1-9]/.test(fraction.slice(digits));
  return `${whole}.${shown}${truncated ? "…" : ""}`;
}

/**
 * Canonicalises a client-supplied transaction hash, or returns null.
 *
 * The only thing a payer sends us. Normalising to lowercase here is what makes the UNIQUE
 * index on `Payment.txHash` an actual double-spend defence — `0xAB…` and `0xab…` are the same
 * transaction, and a case-sensitive index would happily store both.
 */
export function normalizeTxHash(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  return /^0x[0-9a-f]{64}$/.test(withPrefix) ? withPrefix : null;
}
