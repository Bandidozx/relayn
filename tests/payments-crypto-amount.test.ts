/**
 * Exact money arithmetic and transaction-hash canonicalisation.
 *
 * These two modules are the reason no float ever touches a payment comparison, and the reason
 * the UNIQUE index on `Payment.txHash` is a real double-spend defence rather than a
 * case-sensitive near-miss. Both are pure, so the whole surface is assertable here.
 */
import { describe, expect, it } from "vitest";
import {
  AmountFormatError,
  formatAssetAmount,
  fromBaseUnits,
  normalizeTxHash,
  parseBaseUnits,
  toBaseUnits,
} from "@/lib/payments/crypto/amount";

const HASH = "0x" + "ab".repeat(32);

describe("toBaseUnits", () => {
  it("converts the configured $0.10 price to exactly 100000 USDC base units", () => {
    // The whole point: 0.1 * 1e6 is 100000.00000000001 in IEEE-754. This must be an integer.
    expect(toBaseUnits("0.10", 6)).toBe("100000");
    expect(toBaseUnits("0.1", 6)).toBe("100000");
  });

  it("handles whole numbers, high decimals and leading zeros", () => {
    expect(toBaseUnits("1", 6)).toBe("1000000");
    expect(toBaseUnits("0.000001", 6)).toBe("1");
    expect(toBaseUnits("1.5", 18)).toBe("1500000000000000000");
    expect(toBaseUnits("  0.25  ", 2)).toBe("25");
  });

  it("rejects over-precision instead of silently rounding it", () => {
    // An operator writing 0.1000005 for a 6-decimal token has made a mistake worth surfacing.
    expect(() => toBaseUnits("0.1000005", 6)).toThrow(AmountFormatError);
  });

  it("rejects anything that is not a plain positive decimal", () => {
    for (const bad of ["", "abc", "-1", "1e6", "0", "0.0", "1,5", "0x10", "Infinity", "NaN"]) {
      expect(() => toBaseUnits(bad, 6), bad).toThrow(AmountFormatError);
    }
  });

  it("rejects unusable decimals", () => {
    expect(() => toBaseUnits("1", -1)).toThrow(AmountFormatError);
    expect(() => toBaseUnits("1", 37)).toThrow(AmountFormatError);
    expect(() => toBaseUnits("1", 1.5)).toThrow(AmountFormatError);
  });
});

describe("fromBaseUnits", () => {
  it("round-trips the price and drops trailing fractional zeros", () => {
    expect(fromBaseUnits("100000", 6)).toBe("0.1");
    expect(fromBaseUnits("1000000", 6)).toBe("1");
    expect(fromBaseUnits("1", 6)).toBe("0.000001");
    expect(fromBaseUnits("0", 6)).toBe("0");
    expect(fromBaseUnits("1500000000000000000", 18)).toBe("1.5");
  });

  it("passes base units through unchanged for a zero-decimal asset", () => {
    expect(fromBaseUnits("42", 0)).toBe("42");
  });
});

describe("parseBaseUnits", () => {
  it('treats "no transfer observed" as zero rather than as an error', () => {
    expect(parseBaseUnits(null)).toBe(0n);
    expect(parseBaseUnits(undefined)).toBe(0n);
    expect(parseBaseUnits("")).toBe(0n);
  });

  it("parses values far beyond Number.MAX_SAFE_INTEGER exactly", () => {
    expect(parseBaseUnits("9007199254740993")).toBe(9007199254740993n);
  });

  it("refuses a non-integer string", () => {
    for (const bad of ["0.1", "-1", "1e3", "0x1", " 1"]) {
      expect(() => parseBaseUnits(bad), bad).toThrow(AmountFormatError);
    }
  });
});

describe("formatAssetAmount", () => {
  it('renders 0.10 next to a "$0.10" price rather than 0.1', () => {
    expect(formatAssetAmount("100000", 6)).toBe("0.10");
  });

  it("marks a truncated remainder so a rounded figure never reads as exact", () => {
    expect(formatAssetAmount("100001", 6)).toBe("0.10…");
    expect(formatAssetAmount("123456", 6, 4)).toBe("0.1234…");
    expect(formatAssetAmount("120000", 6)).toBe("0.12");
    expect(formatAssetAmount("1000000", 6, 0)).toBe("1");
  });
});

describe("normalizeTxHash", () => {
  it("canonicalises case, so 0xAB… and 0xab… collide on the UNIQUE index", () => {
    expect(normalizeTxHash("0x" + "AB".repeat(32))).toBe(HASH);
    expect(normalizeTxHash(HASH)).toBe(HASH);
  });

  it("accepts a hash pasted without the 0x prefix, and trims whitespace", () => {
    expect(normalizeTxHash("ab".repeat(32))).toBe(HASH);
    expect(normalizeTxHash(`  ${HASH}\n`)).toBe(HASH);
  });

  it("returns null for anything that is not a 32-byte hash", () => {
    for (const bad of [
      "",
      "0x",
      "0x" + "ab".repeat(31),
      "0x" + "ab".repeat(33),
      "0x" + "zz".repeat(32),
      42,
      null,
      undefined,
      {},
      ["0x" + "ab".repeat(32)],
    ]) {
      expect(normalizeTxHash(bad)).toBeNull();
    }
  });
});
