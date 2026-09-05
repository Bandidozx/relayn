/**
 * Vendor mark tile.
 *
 * One shape for every vendor — a rounded square tinted from the vendor's colour — holding either
 * a real logo or a monogram. Keeping the tile identical is what makes a mixed grid read as
 * deliberate: the marks we can ship legally do not cover the whole catalogue, and a card that
 * falls back to two letters should look like a designed state rather than a broken image.
 *
 * Colours arrive as `Vendor.color`, so they are set inline. `currentColor` inside the two
 * `color-mix()` calls resolves against this element's own `color`, which is why one value drives
 * the glyph, the tint and the hairline.
 */
import type { Vendor } from "@/lib/vendor";
import { VENDOR_MARKS } from "./vendor-marks";

export function VendorMark({ vendor }: { vendor: Vendor }) {
  const mark = VENDOR_MARKS[vendor.slug];

  return (
    <span
      aria-hidden="true"
      style={{
        color: vendor.color,
        backgroundColor: "color-mix(in oklab, currentColor 12%, transparent)",
        borderColor: "color-mix(in oklab, currentColor 28%, transparent)",
      }}
      className="grid size-9 shrink-0 place-items-center rounded-xl border"
    >
      {mark ? (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          // Set per mark, not once for all of them: a path authored for even-odd fills solid
          // under the default rule, which turns a logo with counters into a blob.
          fillRule={mark.evenOdd ? "evenodd" : undefined}
          clipRule={mark.evenOdd ? "evenodd" : undefined}
          className="size-[18px]"
        >
          <path d={mark.d} />
        </svg>
      ) : (
        <span className="text-[10px] font-semibold tracking-tight">{vendor.initials}</span>
      )}
    </span>
  );
}
