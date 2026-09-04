/**
 * QRIS payload → SVG path, computed on the server.
 *
 * Three constraints forced this shape:
 *
 *  1. The CSP in `next.config.ts` allows `img-src 'self' data: blob:`, so the provider's
 *     hosted `qr_url` image would be blocked by the browser. The QR has to be drawn from the
 *     `qr_string` we already store.
 *  2. Rendering as `<svg><path d="…"/></svg>` from a plain data string keeps
 *     `dangerouslySetInnerHTML` out of the payment page entirely.
 *  3. Encoding runs server-side, so the client bundle never gains a QR library.
 *
 * The returned path is in *module* units — one QR module is one unit — so the caller sizes the
 * QR purely with `viewBox` and CSS and never has to agree with this module about pixels.
 */
import "server-only";
import QRCode from "qrcode";

/** Modules of untouched margin around the symbol. 4 is the EMVCo/ISO minimum. */
const QUIET_ZONE = 4;

export interface QrPath {
  /** Symbol width in modules, excluding the quiet zone. */
  size: number;
  /** Quiet-zone width in modules, on every side. */
  quietZone: number;
  /** `size + quietZone * 2` — use directly as the SVG `viewBox` extent. */
  extent: number;
  /** SVG path data for every dark module, in module units, offset by the quiet zone. */
  path: string;
}

/**
 * Merges consecutive dark modules in a row into one rectangle. A v11 QRIS symbol has ~3,600
 * dark modules; emitted individually that is a ~90KB path string on every poll. Run-merging
 * brings it to roughly a fifth of that, and produces identical geometry.
 */
export function modulesToPath(
  size: number,
  isDark: (row: number, col: number) => boolean,
  quietZone = QUIET_ZONE,
): string {
  const parts: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let runStart = -1;
    for (let col = 0; col <= size; col += 1) {
      const dark = col < size && isDark(row, col);
      if (dark && runStart < 0) {
        runStart = col;
      } else if (!dark && runStart >= 0) {
        const width = col - runStart;
        parts.push(`M${runStart + quietZone} ${row + quietZone}h${width}v1h-${width}z`);
        runStart = -1;
      }
    }
  }
  return parts.join("");
}

/**
 * Encodes an EMVCo QRIS payload.
 *
 * Error correction level M (~15% recovery) is what Indonesian QRIS acquirers publish for
 * static and dynamic merchant codes; L would shrink the symbol but leaves less headroom for a
 * scan off a glossy phone screen.
 *
 * Throws when the payload cannot be encoded at all (empty, or beyond the largest version).
 * Callers treat that as "show the checkout link instead", never as a payment failure.
 */
export function qrisToPath(payload: string): QrPath {
  const trimmed = payload.trim();
  if (!trimmed) throw new Error("Empty QRIS payload.");

  const symbol = QRCode.create(trimmed, { errorCorrectionLevel: "M" });
  const { size } = symbol.modules;

  return {
    size,
    quietZone: QUIET_ZONE,
    extent: size + QUIET_ZONE * 2,
    path: modulesToPath(size, (row, col) => symbol.modules.get(row, col) === 1),
  };
}

/** Never throws: returns null when the payload is missing or unencodable. */
export function qrisToPathOrNull(payload: string | null | undefined): QrPath | null {
  if (!payload) return null;
  try {
    return qrisToPath(payload);
  } catch {
    return null;
  }
}
