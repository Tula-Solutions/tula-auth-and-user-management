import { encodeQr } from './encode'
import { qrPath } from './svg'

/** What an inline SVG needs to draw a QR code. */
export interface QrDrawing {
  /** Modules per side, without the quiet zone. */
  size: number
  /** The `d` of one path covering every dark module, in module units. */
  path: string
}

/**
 * Encode a text as a QR code and describe it as one SVG path.
 *
 * Loaded on demand (`import('../qr')`) by the one component that draws a QR code, so an app
 * that never shows an authenticator enrolment does not carry the encoder.
 *
 * @param text - What the code says, e.g. an `otpauth://` URI.
 * @returns The symbol's size and path.
 * @throws RangeError when the text is too long for a QR code.
 */
export function qrDrawing(text: string): QrDrawing {
  const matrix = encodeQr(text)
  return { size: matrix.size, path: qrPath(matrix) }
}
