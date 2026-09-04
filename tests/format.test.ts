/**
 * Presentation formatters. Only the ones whose output is load-bearing are asserted here:
 * `formatIdr` renders the advertised price of a real purchase, and `formatCompact` /
 * `formatLimit` decide whether a missing upstream figure reads as "0" or as "unknown".
 */
import { describe, expect, it } from "vitest";
import { UNLIMITED_PRICE_IDR } from "@/lib/plans";
import {
  formatCompact,
  formatIdr,
  formatLatency,
  formatLimit,
  formatMicroUsd,
  formatNumber,
  formatPercent,
  formatPricePerMillion,
  formatUsd,
  titleCase,
} from "@/lib/format";

describe("formatIdr", () => {
  it("renders the one-time price exactly as the copy promises", () => {
    // The string the landing page, the subscription page and the pay button all show.
    expect(formatIdr(UNLIMITED_PRICE_IDR)).toBe("Rp5.000");
    expect(formatIdr(5000)).toBe("Rp5.000");
  });

  it("groups thousands with dots, Indonesian convention", () => {
    expect(formatIdr(0)).toBe("Rp0");
    expect(formatIdr(999)).toBe("Rp999");
    expect(formatIdr(1_000)).toBe("Rp1.000");
    expect(formatIdr(10_000)).toBe("Rp10.000");
    expect(formatIdr(100_000)).toBe("Rp100.000");
    expect(formatIdr(1_000_000)).toBe("Rp1.000.000");
    expect(formatIdr(12_345_678)).toBe("Rp12.345.678");
  });

  it("emits no non-breaking space and no fractional part", () => {
    // Why the grouping is hand-rolled: Intl's id-ID currency style emits "Rp 5.000,00".
    const rendered = formatIdr(UNLIMITED_PRICE_IDR);
    expect(rendered).not.toContain(" ");
    expect(rendered).not.toContain(",");
    expect(rendered).toMatch(/^Rp[\d.]+$/);
  });

  it("rounds to whole rupiah and never renders a negative price", () => {
    expect(formatIdr(4_999.6)).toBe("Rp5.000");
    expect(formatIdr(-5_000)).toBe("Rp0");
  });
});

describe("formatCompact", () => {
  it("prints small counts exactly", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(999)).toBe("999");
  });

  it("abbreviates larger counts", () => {
    expect(formatCompact(1_000)).toBe("1K");
    expect(formatCompact(250_000)).toBe("250K");
    expect(formatCompact(1_240_000)).toBe("1.2M");
    expect(formatCompact(2_000_000_000)).toBe("2B");
  });
});

describe("formatLimit", () => {
  it("says 'unknown' rather than zero for a figure the upstream did not publish", () => {
    expect(formatLimit(0)).toBe("—");
    expect(formatLimit(-1)).toBe("—");
    expect(formatLimit(128_000)).toBe("128K");
  });
});

describe("formatNumber and formatPercent", () => {
  it("groups with commas and rounds", () => {
    expect(formatNumber(1_234_567)).toBe("1,234,567");
    expect(formatNumber(0.6)).toBe("1");
  });

  it("renders a percentage at the requested precision", () => {
    expect(formatPercent(25)).toBe("25.0%");
    expect(formatPercent(25.44, 0)).toBe("25%");
  });
});

describe("money formatters", () => {
  it("renders micro-USD at a precision that does not hide sub-cent costs", () => {
    expect(formatMicroUsd(0)).toBe("$0.00");
    expect(formatMicroUsd(18_000_000)).toBe("$18.00");
    expect(formatMicroUsd(5_000)).not.toBe("$0.00");
  });

  it("drops a trailing .00 from whole-dollar plan prices", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(20)).toBe("$20");
    expect(formatUsd(9.5)).toBe("$9.50");
  });

  it("calls a zero catalogue price Free", () => {
    expect(formatPricePerMillion(0)).toBe("Free");
    expect(formatPricePerMillion(3)).toBe("$3/M");
    expect(formatPricePerMillion(0.15)).toBe("$0.15/M");
  });
});

describe("formatLatency", () => {
  it("says nothing rather than zero when there is no measurement", () => {
    expect(formatLatency(0)).toBe("—");
    expect(formatLatency(Number.NaN)).toBe("—");
  });

  it("switches from milliseconds to seconds", () => {
    expect(formatLatency(420)).toBe("420 ms");
    expect(formatLatency(1_500)).toBe("1.50 s");
    expect(formatLatency(45_000)).toBe("45.0 s");
  });
});

describe("titleCase", () => {
  it("humanises the status strings stored in the database", () => {
    expect(titleCase("past_due")).toBe("Past Due");
    expect(titleCase("active")).toBe("Active");
    expect(titleCase("payment_verified")).toBe("Payment Verified");
  });
});
