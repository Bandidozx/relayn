/**
 * QRIS payload → SVG path.
 *
 * The QR is drawn server-side because the CSP forbids the provider's hosted image, which makes
 * this module the only thing standing between a valid `qr_string` and a scannable code. The
 * geometry assertions below use a hand-built matrix so they do not depend on how `qrcode`
 * happens to lay out a particular payload.
 */
import { describe, expect, it } from "vitest";
import { modulesToPath, qrisToPath, qrisToPathOrNull } from "@/lib/payments/qr";

/** A realistic dynamic QRIS payload (EMVCo TLV), long enough to need a mid-size symbol. */
const QRIS_PAYLOAD =
  "00020101021226670016COM.NOBUBANK.WWW01189360050300000898240214123456789012340303UMI51440014ID.CO.QRIS.WWW0215ID20232891234560303UMI5204541153033605802ID5910Relayn Dev6013Jakarta Barat61051141062070703A016304A1B2";

describe("modulesToPath", () => {
  it("emits nothing for an all-light matrix", () => {
    expect(modulesToPath(4, () => false)).toBe("");
  });

  it("merges a run of dark modules into a single rectangle", () => {
    // Row 0, columns 0-2 dark: one 3-wide rect, not three 1-wide ones.
    const path = modulesToPath(3, (row, col) => row === 0 && col < 3, 0);
    expect(path).toBe("M0 0h3v1h-3z");
  });

  it("closes a run that reaches the last column", () => {
    // The loop runs to `col === size` precisely so a run touching the edge is still emitted.
    const path = modulesToPath(2, () => true, 0);
    expect(path).toBe("M0 0h2v1h-2zM0 1h2v1h-2z");
  });

  it("splits a row broken by a light module into separate rectangles", () => {
    const path = modulesToPath(4, (row, col) => row === 0 && col !== 2, 0);
    expect(path).toBe("M0 0h2v1h-2zM3 0h1v1h-1z");
  });

  it("offsets every rectangle by the quiet zone", () => {
    expect(modulesToPath(1, () => true, 4)).toBe("M4 4h1v1h-1z");
  });

  it("produces one rectangle per run, so a checkerboard is the worst case", () => {
    const size = 8;
    const path = modulesToPath(size, (row, col) => (row + col) % 2 === 0, 0);
    // 4 dark modules per row, none adjacent → 4 rects × 8 rows.
    expect(path.match(/M/g)?.length).toBe(32);
  });
});

describe("qrisToPath", () => {
  it("encodes a real QRIS payload into a square symbol with a 4-module quiet zone", () => {
    const qr = qrisToPath(QRIS_PAYLOAD);
    expect(qr.quietZone).toBe(4);
    expect(qr.extent).toBe(qr.size + 8);
    // Valid QR versions are 21..177 modules, odd, stepping by 4.
    expect(qr.size).toBeGreaterThanOrEqual(21);
    expect(qr.size).toBeLessThanOrEqual(177);
    expect((qr.size - 21) % 4).toBe(0);
  });

  it("returns path data that only ever contains SVG path commands", () => {
    // The value is interpolated into a `d` attribute, so anything else would be a defect.
    const qr = qrisToPath(QRIS_PAYLOAD);
    expect(qr.path.length).toBeGreaterThan(0);
    expect(qr.path).toMatch(/^[Mhvz0-9 .-]+$/);
    expect(qr.path).not.toContain("<");
  });

  it("keeps every rectangle inside the viewBox", () => {
    const qr = qrisToPath(QRIS_PAYLOAD);
    for (const [, x, y] of qr.path.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(qr.quietZone);
      expect(Number(y)).toBeGreaterThanOrEqual(qr.quietZone);
      expect(Number(x)).toBeLessThan(qr.extent);
      expect(Number(y)).toBeLessThan(qr.extent);
    }
  });

  it("draws the finder pattern in the top-left corner of the symbol", () => {
    // Every QR starts with a 7×7 finder whose first row is solid, at the quiet-zone origin.
    const qr = qrisToPath(QRIS_PAYLOAD);
    expect(qr.path.startsWith(`M${qr.quietZone} ${qr.quietZone}h7v1h-7z`)).toBe(true);
  });

  it("is deterministic for the same payload", () => {
    expect(qrisToPath(QRIS_PAYLOAD)).toEqual(qrisToPath(QRIS_PAYLOAD));
  });

  it("stays well under the size where a path string would bloat a page", () => {
    // Run-merging is the reason: unmerged, a symbol this size is roughly five times longer.
    expect(qrisToPath(QRIS_PAYLOAD).path.length).toBeLessThan(40_000);
  });

  it("throws on an empty or blank payload", () => {
    expect(() => qrisToPath("")).toThrow(/Empty QRIS payload/);
    expect(() => qrisToPath("   \n ")).toThrow(/Empty QRIS payload/);
  });
});

describe("qrisToPathOrNull", () => {
  it("returns null rather than throwing for a missing payload", () => {
    expect(qrisToPathOrNull(null)).toBeNull();
    expect(qrisToPathOrNull(undefined)).toBeNull();
    expect(qrisToPathOrNull("")).toBeNull();
  });

  it("encodes a usable payload", () => {
    // The page falls back to the checkout link when this is null, so a valid payload returning
    // null would silently hide the QR.
    expect(qrisToPathOrNull(QRIS_PAYLOAD)?.size).toBe(qrisToPath(QRIS_PAYLOAD).size);
  });

  it("returns null for a payload too large to encode at all", () => {
    // Beyond QR version 40 there is no symbol to draw.
    expect(qrisToPathOrNull("A".repeat(10_000))).toBeNull();
  });
});
