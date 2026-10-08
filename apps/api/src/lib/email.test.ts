import { describe, expect, test } from 'bun:test'
import { maskEmail, normalizeEmail, parseEmail } from '~/lib/email'

describe('normalizeEmail', () => {
  test.each([
    ['  Maya@Northline.APP ', 'maya@northline.app'],
    ['maya@northline.app', 'maya@northline.app'],
    ['MAYA+tag@Northline.app', 'maya+tag@northline.app'],
  ])('%p → %p', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected)
  })

  test('folds ASCII letters only: a Kelvin sign is never turned into a "k"', () => {
    expect(normalizeEmail('\u212AELVIN@Northline.app')).toBe('\u212Aelvin@northline.app')
  })
})

describe('maskEmail', () => {
  test.each([
    ['maya@northline.app', 'm***@northline.app'],
    ['a@b.co', 'a***@b.co'],
    ['Maya@Northline.app', 'M***@Northline.app'],
    ['not-an-email', '***'],
    ['@northline.app', '***'],
    ['', '***'],
  ])('%p → %p', (input, expected) => {
    expect(maskEmail(input)).toBe(expected)
  })

  test('never reveals more than the first character of the local part', () => {
    expect(maskEmail('averyveryverylongname@example.com')).toBe('a***@example.com')
  })
})

describe('parseEmail', () => {
  test('returns the trimmed and the normalized form', () => {
    expect(parseEmail(' Maya@Northline.app ')).toEqual({
      email: 'Maya@Northline.app',
      normalized: 'maya@northline.app',
    })
  })

  test.each(['', 'nope', 'maya@', '@northline.app', `${'a'.repeat(320)}@northline.app`])(
    'rejects %p',
    (input) => {
      expect(parseEmail(input)).toBeNull()
    }
  )

  // Review finding F1: validation ran on the lowercased form, and lowercasing maps some
  // non-ASCII characters to ASCII, so a look-alike address became someone else's mailbox.
  test.each([
    ['the Kelvin sign (U+212A), which lowercases to an ASCII k', 'Kelvin@northline.app'],
    ['the Kelvin sign in the domain', 'maya@Korthline.app'],
    ['a dotted capital I (U+0130)', 'mayİ@northline.app'],
    ['fullwidth letters, which NFKC folds to ASCII', 'ｍａｙａ@northline.app'],
    ['a fullwidth at sign', 'maya＠northline.app'],
    ['an internationalised local part', 'mäya@northline.app'],
    ['a combining mark after an ASCII letter', 'mayä@northline.app'],
    ['an IDN domain written in Unicode', 'maya@münchen.de'],
    ['a control character', 'ma\u0000ya@northline.app'],
    ['a space inside', 'ma ya@northline.app'],
  ])('refuses %s', (_what, input) => {
    expect(parseEmail(input)).toBeNull()
  })

  test('accepts an IDN domain in its punycode form', () => {
    expect(parseEmail('Maya@XN--Mnchen-3ya.de')).toEqual({
      email: 'Maya@XN--Mnchen-3ya.de',
      normalized: 'maya@xn--mnchen-3ya.de',
    })
  })

  test('the normalized form of an accepted address is ASCII and differs from the input only in case', () => {
    const parsed = parseEmail("Maya.O'Neil+Tag@Northline.app")
    expect(parsed?.normalized).toBe("maya.o'neil+tag@northline.app")
    expect(/^[\x21-\x7e]+$/.test(parsed?.normalized ?? '')).toBe(true)
  })
})
