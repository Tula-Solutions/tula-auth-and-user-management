/**
 * The relative luminance of an sRGB colour (WCAG 2.x).
 *
 * @param hex - A colour written `#RRGGBB`.
 * @returns 0 for black up to 1 for white.
 * @throws Error for anything that is not six hex digits after a `#`.
 */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (match === null) {
    throw new Error(`not a #RRGGBB colour: ${hex}`)
  }
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => {
    const channel = Number.parseInt(part as string, 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The contrast ratio of a foreground on a background.
 *
 * @param foreground - A `#RRGGBB` colour.
 * @param background - A `#RRGGBB` colour.
 * @returns 1 to 21; text needs 4.5, large text and the edge of a control need 3.
 */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
