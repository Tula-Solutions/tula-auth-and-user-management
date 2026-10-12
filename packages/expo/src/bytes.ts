// Bytes and text, written out: the package asks the runtime for nothing a React Native
// engine may lack (`TextEncoder`, `atob`, `btoa` and `crypto.subtle` are not in every one).

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * The UTF-8 bytes of a text. A lone surrogate is encoded as the replacement character, as
 * `TextEncoder` does.
 *
 * @param text - The text.
 * @returns Its bytes.
 */
export function utf8Bytes(text: string): number[] {
  const bytes: number[] = []
  for (const character of text) {
    let point = character.codePointAt(0) as number
    if (point >= 0xd800 && point <= 0xdfff) {
      point = 0xfffd
    }
    if (point < 0x80) {
      bytes.push(point)
    } else if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f))
    } else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f))
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f)
      )
    }
  }
  return bytes
}

/**
 * Bytes as base64url without padding (RFC 7515).
 *
 * @param bytes - The bytes.
 * @returns The text.
 */
export function base64url(bytes: ArrayLike<number>): string {
  let text = ''
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at] as number
    const b = bytes[at + 1]
    const c = bytes[at + 2]
    text += BASE64[a >> 2]
    text += BASE64[((a & 0x03) << 4) | ((b ?? 0) >> 4)]
    if (b !== undefined) {
      text += BASE64[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]
    }
    if (c !== undefined) {
      text += BASE64[c & 0x3f]
    }
  }
  return text.replace(/\+/g, '-').replace(/\//g, '_')
}

/**
 * The bytes of a base64 or base64url text, with or without padding.
 *
 * @param text - The text.
 * @returns The bytes, or `null` for a text that is neither.
 */
export function base64Bytes(text: string): Uint8Array | null {
  const plain = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (plain.length % 4 === 1) {
    return null
  }
  const bytes = new Uint8Array(Math.floor((plain.length * 3) / 4))
  let bits = 0
  let held = 0
  let at = 0
  for (const character of plain) {
    const value = BASE64.indexOf(character)
    if (value === -1) {
      return null
    }
    // Only the low bits are ever read: kept small so the shift never overflows.
    bits = ((bits << 6) | value) & 0xffffff
    held += 6
    if (held >= 8) {
      held -= 8
      bytes[at] = (bits >> held) & 0xff
      at += 1
    }
  }
  return bytes
}
