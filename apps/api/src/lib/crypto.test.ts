import { describe, expect, test } from 'bun:test'
import { randomToken, sha256Hex, timingSafeEqual } from '~/lib/crypto'

describe('randomToken', () => {
  test('returns base64url with the requested entropy', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  test('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => randomToken()))
    expect(tokens.size).toBe(1000)
  })

  test.each([0, 15, 1025, 16.5, Number.NaN])('rejects %p bytes', (bytes) => {
    expect(() => randomToken(bytes)).toThrow(RangeError)
  })
})

describe('sha256Hex', () => {
  test('matches the standard test vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})

describe('timingSafeEqual', () => {
  test.each([
    ['equal strings', 'secret', 'secret', true],
    ['different strings', 'secret', 'secreT', false],
    ['different lengths', 'secret', 'secrets', false],
    ['empty', '', '', true],
  ])('%s', (_, a, b, expected) => {
    expect(timingSafeEqual(a, b)).toBe(expected)
  })

  test('compares byte arrays', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(timingSafeEqual(new Uint8Array([1, 2]), 'ab')).toBe(false)
  })
})
