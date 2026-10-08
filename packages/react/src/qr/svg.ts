import type { QrMatrix } from './encode'

/**
 * Draw a QR code's dark modules as one SVG path.
 *
 * Each module is a unit square in module coordinates, from `0` to `matrix.size` on both axes;
 * neighbouring dark modules in a row are drawn as one rectangle, which keeps the path short.
 * The quiet zone is not included: give the `<svg>` a `viewBox` four modules wider on every
 * side, over a light background.
 *
 * @param matrix - The symbol from `encodeQr`.
 * @returns The path's `d` attribute; an empty string when no module is dark.
 * @example
 * const matrix = encodeQr(uri)
 * const viewBox = `-4 -4 ${matrix.size + 8} ${matrix.size + 8}`
 * // <svg viewBox={viewBox} shapeRendering="crispEdges"><path d={qrPath(matrix)} /></svg>
 */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = []
  for (const [y, row] of matrix.modules.entries()) {
    let start = -1
    for (let x = 0; x <= row.length; x++) {
      // Reading one past the end is `undefined`, which closes a run that reaches the edge.
      if (row[x] === true) {
        if (start < 0) {
          start = x
        }
      } else if (start >= 0) {
        const width = x - start
        parts.push(`M${start} ${y}h${width}v1h-${width}z`)
        start = -1
      }
    }
  }
  return parts.join('')
}
