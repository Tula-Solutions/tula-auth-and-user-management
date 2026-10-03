import { describe, expect, test } from 'bun:test'
import { base32Decode, hotp, totp, totpStep, wrongTotp } from './totp'

/** The secret of the RFC 4226 and RFC 6238 (SHA-1) test vectors. */
const RFC_SECRET = new TextEncoder().encode('12345678901234567890')
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('base32Decode', () => {
  test.each([
    ['', ''],
    ['MY', 'f'],
    ['MZXQ', 'fo'],
    ['MZXW6', 'foo'],
    ['MZXW6YQ', 'foob'],
    ['MZXW6YTB', 'fooba'],
    ['MZXW6YTBOI', 'foobar'],
  ])('decodes the RFC 4648 vector %p', (encoded, decoded) => {
    expect(text(base32Decode(encoded))).toBe(decoded)
  })

  test('ignores case, spaces, dashes and padding, as secrets are typed', () => {
    expect(text(base32Decode('mzxw 6ytb-oi======'))).toBe('foobar')
    expect(text(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'))).toBe('12345678901234567890')
  })

  test('refuses a character outside the alphabet without quoting the text', () => {
    expect(() => base32Decode('MZXW1')).toThrow(/^not a Base32 secret$/)
  })
})

describe('hotp', () => {
  test('matches RFC 4226 Appendix D for counters 0 to 9', async () => {
    const codes = await Promise.all(
      Array.from({ length: 10 }, (_unused, counter) => hotp(RFC_SECRET, counter))
    )
    expect(codes).toEqual([
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ])
  })

  test('handles a counter beyond 32 bits', async () => {
    expect(await hotp(RFC_SECRET, 2 ** 32 + 1)).toMatch(/^\d{6}$/)
    expect(await hotp(RFC_SECRET, 2 ** 32 + 1)).not.toBe(await hotp(RFC_SECRET, 1))
  })
})

describe('totp', () => {
  test.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
  ])('matches RFC 6238 Appendix B (SHA-1) at T=%p', async (seconds, code) => {
    expect(await totp(RFC_SECRET, seconds * 1000)).toBe(code)
  })

  test('a code holds for its 30-second step and changes with the next', async () => {
    expect(totpStep(59_999)).toBe(1)
    expect(totpStep(60_000)).toBe(2)
    expect(await totp(RFC_SECRET, 30_000)).toBe(await totp(RFC_SECRET, 59_999))
    expect(await totp(RFC_SECRET, 60_000)).toBe('359152')
  })
})

describe('wrongTotp', () => {
  test('is a 6-digit code that no step near the moment produces', async () => {
    for (const seconds of [59, 1_111_111_109, 2_000_000_000]) {
      const wrong = await wrongTotp(RFC_SECRET, seconds * 1000)
      expect(wrong).toMatch(/^\d{6}$/)
      for (const near of [-2, -1, 0, 1, 2]) {
        expect(wrong).not.toBe(await totp(RFC_SECRET, (seconds + near * 30) * 1000))
      }
    }
  })
})
