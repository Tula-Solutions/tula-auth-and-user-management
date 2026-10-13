import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeQr } from './encode'

// qr-cases.json is read by this test and by the Kotlin port of this encoder
// (native/android/tula-auth-ui: TulaQr.kt and its QrTest): a symbol is its size and the
// SHA-256 of its modules, row by row, '1' for dark. What a scanner reads back from this
// encoder is encode.test.ts's; the corpus holds the port to it. Never edit a hash to make one
// side pass.
const cases = JSON.parse(readFileSync(join(import.meta.dir, 'qr-cases.json'), 'utf8')) as {
  text: string
  size: number
  sha256: string
}[]

describe('encodeQr: the corpus the Kotlin encoder is held to', () => {
  test('every text of the corpus gives the symbol the corpus names', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12)
    for (const { text, size, sha256 } of cases) {
      const matrix = encodeQr(text)
      const cells = matrix.modules
        .map((row) => row.map((dark) => (dark ? '1' : '0')).join(''))
        .join('')
      expect(matrix.size).toBe(size)
      expect(createHash('sha256').update(cells).digest('hex')).toBe(sha256)
    }
  })

  test('the corpus reaches the smallest and the largest symbol, and text outside ASCII', () => {
    const sizes = cases.map((entry) => entry.size)
    expect(Math.min(...sizes)).toBe(21)
    expect(Math.max(...sizes)).toBe(177)
    const outsideAscii = (text: string) =>
      [...text].some((letter) => (letter.codePointAt(0) ?? 0) > 0x7f)
    expect(cases.some((entry) => outsideAscii(entry.text))).toBe(true)
  })
})
