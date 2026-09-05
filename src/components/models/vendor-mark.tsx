/**
 * Vendor mark tile.
 *
 * A luxury dark-glass tile with an ambient radial spotlight tuned to the vendor's brand colour.
 * Holding either an authentic SVG mark or a sleek monospace monogram.
 *
 * Colours arrive as `Vendor.color`, set inline so `currentColor` resolves against this element's
 * own colour in CSS radial gradients, glows, and borders.
 *
 * **The tile stays dark in light mode, deliberately.** `Vendor.color` values are each vendor's own
 * brand colour, chosen to sit on a dark backdrop; several are near-white. Flipping the tile would
 * make those marks vanish, and a vendor's logo is not ours to re-tint. Only the outer drop shadow
 * follows the palette — a hard black smear reads as dirt on a white card.
 */
import { cn } from "@/lib/cn";
import type { Vendor } from "@/lib/vendor";
import { VENDOR_MARKS } from "./vendor-marks";

export interface VendorMarkProps {
  vendor: Vendor;
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function VendorMark({ vendor, className, size = "md" }: VendorMarkProps) {
  const mark = VENDOR_MARKS[vendor.slug];

  const sizeClasses = {
    sm: "size-8 rounded-lg",
    md: "size-11 rounded-xl",
    lg: "size-14 rounded-2xl",
  }[size];

  const iconSizes = {
    sm: "size-4",
    md: "size-[22px]",
    lg: "size-7",
  }[size];

  return (
    <span
      aria-hidden="true"
      style={{
        color: vendor.color,
        background:
          "radial-gradient(circle at 50% 20%, color-mix(in srgb, currentColor 22%, transparent) 0%, rgba(13, 18, 27, 0.95) 80%)",
        borderColor: "color-mix(in srgb, currentColor 28%, rgba(255, 255, 255, 0.08))",
        boxShadow:
          "inset 0 1px 1px 0 rgba(255, 255, 255, 0.14), 0 4px 12px -2px var(--shade)",
      }}
      className={cn(
        "relative grid shrink-0 place-items-center border backdrop-blur-md transition-all duration-300 group-hover:scale-105",
        sizeClasses,
        className,
      )}
    >
      {mark ? (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          // Set per mark, not once for all of them: a path authored for even-odd fills solid
          // under the default rule, which turns a logo with counters into a blob. On the <svg>
          // so it inherits, which is where the source artwork carries it too.
          fillRule={mark.evenOdd ? "evenodd" : undefined}
          clipRule={mark.evenOdd ? "evenodd" : undefined}
          className={cn(
            "transition-transform duration-300 drop-shadow-[0_2px_8px_color-mix(in_srgb,currentColor_35%,transparent)]",
            iconSizes,
          )}
        >
          {/* One element per path in the source. Merging them would change any logo whose
              subpaths overlap, so the element count is preserved instead. */}
          {mark.paths.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      ) : (
        <span className="font-mono text-xs font-bold tracking-wider text-ink/90">
          {vendor.initials}
        </span>
      )}
    </span>
  );
}

