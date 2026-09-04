/**
 * QRIS renderer.
 *
 * Draws the geometry produced by `src/lib/payments/qr.ts` — a single SVG path in module
 * units — rather than the provider's hosted `qr_url`. Three reasons, all load-bearing:
 *
 *  1. The CSP in `next.config.ts` allows `img-src 'self' data: blob:`, so a remote QR image
 *     would simply not render.
 *  2. Nothing is injected with `dangerouslySetInnerHTML`; the path string is a `d` attribute.
 *  3. No QR encoder reaches the client bundle — the encoding already happened on the server.
 *
 * `import type` on `QrPath` matters: a value import would pull `qrcode` (a Node package listed
 * in `serverExternalPackages`) into a client component.
 */
import { cn } from "@/lib/cn";
import type { QrPath } from "@/lib/payments/qr";

export function QrisCode({
  qr,
  className,
  label = "QRIS payment code",
}: {
  qr: QrPath;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${qr.extent} ${qr.extent}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={cn("h-auto w-full max-w-64 rounded-xl bg-white p-2", className)}
    >
      {/* Quiet zone is part of the viewBox, so the white field must cover the whole extent. */}
      <rect x="0" y="0" width={qr.extent} height={qr.extent} fill="#ffffff" />
      <path d={qr.path} fill="#000000" />
    </svg>
  );
}
