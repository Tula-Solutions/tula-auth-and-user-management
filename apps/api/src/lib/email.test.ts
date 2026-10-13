import { describe, expect, test } from 'bun:test'
import { testAddress } from '@tula-tech/contract'
import { Glob } from 'bun'
import {
  maskEmail,
  normalizeEmail,
  parseEmail,
  type TestAddressPermit,
  testAddressPermit,
} from '~/lib/email'

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

// ADR 0058: an address of the reserved test domain is not an address, for everyone but the
// sign-in test's own run.
describe('an address of the reserved test domain', () => {
  const MARKED = testAddress('0123456789abcdef0123456789abcdef')

  test.each([
    MARKED,
    MARKED.toUpperCase(),
    'someone@test.tula.invalid',
    'someone@Sub.Test.Tula.Invalid',
    ` ${MARKED} `,
  ])('%p is refused like a malformed one', (address) => {
    expect(parseEmail(address)).toBeNull()
  })

  test('the run’s permit lets one through', () => {
    expect(parseEmail(MARKED, testAddressPermit())).toEqual({ email: MARKED, normalized: MARKED })
  })

  test('nothing but a permit this module made is a permit', () => {
    const forged = [
      {},
      true,
      'permit',
      { [Symbol('test address permit')]: true },
      { [Symbol.for('test address permit')]: true },
      Object.create(testAddressPermit()),
      JSON.parse(JSON.stringify(testAddressPermit())),
    ]
    for (const value of forged) {
      expect(parseEmail(MARKED, value as TestAddressPermit)).toBeNull()
    }
  })

  test('a permit changes nothing for any other address', () => {
    expect(parseEmail('\u212Aelvin@northline.app', testAddressPermit())).toBeNull()
    expect(parseEmail('maya@northline.app', testAddressPermit())?.normalized).toBe(
      'maya@northline.app'
    )
  })

  // The permit and the capture are made in one place each. A new caller is a decision (and
  // a paragraph in ADR 0058), then a line here.
  test('only the sign-in test makes a permit or a mail capture', async () => {
    const src = `${import.meta.dir}/..`
    const callers: Record<string, string[]> = { 'testAddressPermit(': [], 'captureMail(': [] }
    for await (const path of new Glob('**/*.ts').scan({ cwd: src })) {
      if (/\.(test|suite|integration)\.ts$/.test(path)) {
        continue
      }
      const code = (await Bun.file(`${src}/${path}`).text())
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n')
      for (const name of Object.keys(callers)) {
        if (code.includes(name)) {
          callers[name]?.push(path)
        }
      }
    }
    expect(callers['testAddressPermit(']?.sort()).toEqual([
      'lib/email.ts',
      'modules/sign-in-test/service.ts',
    ])
    expect(callers['captureMail(']?.sort()).toEqual([
      'lib/captured-mail.ts',
      'modules/sign-in-test/service.ts',
    ])
  })
})
