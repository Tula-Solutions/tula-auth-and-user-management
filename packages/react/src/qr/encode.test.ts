import { describe, expect, test } from 'bun:test'
import jsQR from 'jsqr'
import { encodeQr, QR_MAX_BYTES, type QrMatrix } from './encode'

/**
 * Byte-mode capacity at level M for versions 1 to 40, from the standard's table: written out
 * here so the encoder's own arithmetic is checked against it and not against itself.
 */
const CAPACITY: readonly number[] = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666,
  711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989,
  2099, 2213, 2331,
]
const VERSIONS = CAPACITY.map((capacity, index) => [index + 1, capacity] as [number, number])

const PIXELS_PER_MODULE = 4
const QUIET_ZONE = 4

function capacityOf(version: number): number {
  return CAPACITY[version - 1] ?? 0
}

function sizeOf(version: number): number {
  return 17 + 4 * version
}

/** Draw the symbol as an image a scanner would see: dark on white, inside a quiet zone. */
function rasterise(matrix: QrMatrix): { data: Uint8ClampedArray; side: number } {
  const side = (matrix.size + 2 * QUIET_ZONE) * PIXELS_PER_MODULE
  const data = new Uint8ClampedArray(side * side * 4).fill(255)
  for (const [y, row] of matrix.modules.entries()) {
    for (const [x, dark] of row.entries()) {
      if (dark) {
        for (let dy = 0; dy < PIXELS_PER_MODULE; dy++) {
          const top = (y + QUIET_ZONE) * PIXELS_PER_MODULE + dy
          const left = (x + QUIET_ZONE) * PIXELS_PER_MODULE
          for (let dx = 0; dx < PIXELS_PER_MODULE; dx++) {
            data.fill(0, (top * side + left + dx) * 4, (top * side + left + dx) * 4 + 3)
          }
        }
      }
    }
  }
  return { data, side }
}

/** What an independent decoder reads from the symbol, or `null` when it finds no code. */
function decode(matrix: QrMatrix): string | null {
  const { data, side } = rasterise(matrix)
  return jsQR(data, side, side, { inversionAttempts: 'dontInvert' })?.data ?? null
}

/** A deterministic text of printable ASCII, different for each length. */
function textOf(length: number): string {
  let state = length * 2654435761 + 12345
  let text = ''
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    text += String.fromCharCode(33 + ((state >>> 16) % 94))
  }
  return text
}

function isDark(matrix: QrMatrix, x: number, y: number): boolean {
  return matrix.modules[y]?.[x] === true
}

/** The 15 format bits, read from around the top-left finder and from the split second copy. */
function formatBits(matrix: QrMatrix): [number, number] {
  const { size } = matrix
  let first = 0
  let second = 0
  for (let i = 0; i < 15; i++) {
    const firstAt: [number, number] =
      i < 6 ? [8, i] : i < 8 ? [8, i + 1] : i === 8 ? [7, 8] : [14 - i, 8]
    const secondAt: [number, number] = i < 8 ? [size - 1 - i, 8] : [8, size - 15 + i]
    first |= Number(isDark(matrix, ...firstAt)) << i
    second |= Number(isDark(matrix, ...secondAt)) << i
  }
  return [first, second]
}

/** Remainder of a bit string divided by a BCH generator: zero for a valid codeword. */
function bchRemainder(value: number, generator: number, generatorBits: number): number {
  let remainder = value
  for (let bit = 31; bit >= generatorBits - 1; bit--) {
    if ((remainder >>> bit) & 1) {
      remainder ^= generator << (bit - generatorBits + 1)
    }
  }
  return remainder
}

describe('encodeQr: what a scanner reads back', () => {
  test.each([
    ['short', 'otpauth://totp/Acme:maya?secret=JBSWY3DPEHPK3PXP&issuer=Acme', 4],
    [
      'typical',
      'otpauth://totp/Acme:maya.torres%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA1&digits=6&period=30',
      8,
    ],
    [
      'long',
      'otpauth://totp/Acme%20Corporation%20%28Production%20Workspace%29:maya.torres%2Bsecurity-team%40subsidiary.example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Acme%20Corporation%20%28Production%20Workspace%29&algorithm=SHA256&digits=6&period=30',
      12,
    ],
  ] as [string, string, number][])('a %s otpauth URI', (_name, uri, version) => {
    const matrix = encodeQr(uri)
    expect(matrix.size).toBe(sizeOf(version))
    expect(decode(matrix)).toBe(uri)
  })

  test.each(VERSIONS)('version %i holds exactly %i bytes', (version, capacity) => {
    const text = textOf(capacity)
    const matrix = encodeQr(text)
    expect(matrix.size).toBe(sizeOf(version))
    expect(matrix.modules.length).toBe(matrix.size)
    expect(matrix.modules.every((row) => row.length === matrix.size)).toBe(true)
    expect(decode(matrix)).toBe(text)
  })

  test('one byte more than a version holds moves to the next version, for every version', () => {
    for (const [version, capacity] of VERSIONS.slice(0, -1)) {
      expect(`${version}: ${encodeQr(textOf(capacity + 1)).size}`).toBe(
        `${version}: ${sizeOf(version + 1)}`
      )
    }
  })

  // 6 → 7 is where version information appears, 9 → 10 where the count field becomes 16 bits.
  test.each([1, 2, 6, 9, 14, 15, 26, 39])('one byte past version %i decodes', (version) => {
    const text = textOf(capacityOf(version) + 1)
    const matrix = encodeQr(text)
    expect(matrix.size).toBe(sizeOf(version + 1))
    expect(decode(matrix)).toBe(text)
  })

  test.each([
    ['one character', 'a', 1],
    ['a few bytes, far below capacity (padding with 0xEC, 0x11)', 'tula', 1],
    ['accents and a euro sign', 'Zoë Müller — café, 12 €', 3],
    ['Japanese and an emoji outside the BMP', '認証コード 🔐 確認', 3],
    ['a line break and a tab', 'line one\n\tline two', 2],
  ] as [string, string, number][])('%s', (_name, text, version) => {
    const matrix = encodeQr(text)
    expect(matrix.size).toBe(sizeOf(version))
    expect(decode(matrix)).toBe(text)
  })

  test('length is counted in UTF-8 bytes, not characters', () => {
    // 14 bytes fit version 1; five euro signs are 15 bytes in 5 characters.
    expect(encodeQr('€€€€').size).toBe(sizeOf(1))
    expect(encodeQr('€€€€€').size).toBe(sizeOf(2))
    const longest = '€'.repeat(QR_MAX_BYTES / 3)
    const matrix = encodeQr(longest)
    expect(matrix.size).toBe(sizeOf(40))
    expect(decode(matrix)).toBe(longest)
  })

  test('an empty text is a version 1 symbol', () => {
    expect(encodeQr('').size).toBe(sizeOf(1))
  })
})

describe('encodeQr: a text that does not fit', () => {
  test('the largest capacity is the table’s', () => {
    expect(QR_MAX_BYTES).toBe(capacityOf(40))
  })

  test.each([
    ['one byte too many', 'a'.repeat(QR_MAX_BYTES + 1), QR_MAX_BYTES + 1],
    ['few enough characters, too many bytes', '€'.repeat(778), 2334],
  ] as [string, string, number][])('%s is a RangeError', (_name, text, bytes) => {
    expect(() => encodeQr(text)).toThrow(RangeError)
    expect(() => encodeQr(text)).toThrow(`${bytes} bytes`)
  })

  test('the error does not repeat the text, which may be a secret', () => {
    let message = ''
    try {
      encodeQr(`otpauth://totp/x?secret=${'JBSWY3DP'.repeat(400)}`)
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(message).toContain('too long')
    expect(message).not.toContain('JBSWY3DP')
  })
})

describe('encodeQr: the symbol’s structure', () => {
  const FINDER = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']
  const symbols = [1, 2, 6, 7, 10, 15, 32, 40].map(
    (version) => [version, encodeQr(textOf(capacityOf(version)))] as [number, QrMatrix]
  )

  function square(matrix: QrMatrix, left: number, top: number, side: number): string[] {
    return Array.from({ length: side }, (_row, dy) =>
      Array.from({ length: side }, (_cell, dx) =>
        isDark(matrix, left + dx, top + dy) ? '1' : '0'
      ).join('')
    )
  }

  test.each(symbols)('version %i: three finder patterns with light separators', (_v, matrix) => {
    const { size } = matrix
    expect(square(matrix, 0, 0, 7)).toEqual(FINDER)
    expect(square(matrix, size - 7, 0, 7)).toEqual(FINDER)
    expect(square(matrix, 0, size - 7, 7)).toEqual(FINDER)
    for (let i = 0; i < 8; i++) {
      const separators = [
        isDark(matrix, 7, i),
        isDark(matrix, i, 7),
        isDark(matrix, size - 8, i),
        isDark(matrix, size - 1 - i, 7),
        isDark(matrix, 7, size - 1 - i),
        isDark(matrix, i, size - 8),
      ]
      expect(separators).toEqual([false, false, false, false, false, false])
    }
    // No fourth finder: the bottom-right corner is data.
    expect(square(matrix, size - 7, size - 7, 7)).not.toEqual(FINDER)
  })

  test.each(symbols)('version %i: the dark module and the timing patterns', (_v, matrix) => {
    const { size } = matrix
    expect(isDark(matrix, 8, size - 8)).toBe(true)
    for (let i = 8; i < size - 8; i++) {
      expect([i, isDark(matrix, i, 6), isDark(matrix, 6, i)]).toEqual([i, i % 2 === 0, i % 2 === 0])
    }
  })

  test.each(symbols)(
    'version %i: an alignment pattern near the bottom-right corner',
    (v, matrix) => {
      const centre = matrix.size - 7
      const expected = v === 1 ? [] : ['11111', '10001', '10101', '10001', '11111']
      expect(v === 1 ? [] : square(matrix, centre - 2, centre - 2, 5)).toEqual(expected)
    }
  )

  test.each(symbols)('version %i: both copies of the format say level M, validly', (_v, matrix) => {
    const [first, second] = formatBits(matrix)
    expect(first).toBe(second)
    const unmasked = first ^ 0x5412
    // Level M is 00 in the two highest bits; the low ten are the BCH(15,5) check.
    expect(unmasked >>> 13).toBe(0)
    expect(bchRemainder(unmasked, 0x537, 11)).toBe(0)
  })

  test.each(symbols)('version %i: version information from 7 up, in both places', (v, matrix) => {
    const { size } = matrix
    let topRight = 0
    let bottomLeft = 0
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      topRight |= Number(isDark(matrix, a, b)) << i
      bottomLeft |= Number(isDark(matrix, b, a)) << i
    }
    if (v >= 7) {
      expect(topRight).toBe(bottomLeft)
      expect(topRight >>> 12).toBe(v)
      expect(bchRemainder(topRight, 0x1f25, 13)).toBe(0)
    } else {
      // Below version 7 those modules are data; they never spell a valid version word.
      expect(topRight >>> 12 === v && bchRemainder(topRight, 0x1f25, 13) === 0).toBe(false)
    }
  })

  test('the mask is chosen per symbol: different texts end up with different masks', () => {
    const masks = new Set(
      Array.from({ length: 40 }, (_item, index) => {
        const [bits] = formatBits(encodeQr(textOf(20 + index)))
        return ((bits ^ 0x5412) >>> 10) & 0b111
      })
    )
    expect(masks.size).toBeGreaterThan(2)
  })

  test('the same text always gives the same symbol, and a different text another', () => {
    const text = 'otpauth://totp/Acme:maya?secret=JBSWY3DPEHPK3PXP&issuer=Acme'
    expect(encodeQr(text)).toEqual(encodeQr(text))
    expect(encodeQr(text)).not.toEqual(encodeQr(`${text}x`))
  })
})
