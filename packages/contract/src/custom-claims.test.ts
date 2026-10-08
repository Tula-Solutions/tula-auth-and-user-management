import { describe, expect, test } from 'bun:test'
import {
  CUSTOM_CLAIMS_CLAIM,
  customClaimsBytes,
  isCustomClaimKey,
  MAX_CUSTOM_CLAIM_KEY_LENGTH,
  MAX_CUSTOM_CLAIMS_BYTES,
  RESERVED_CLAIM_NAMES,
  readCustomClaims,
} from './custom-claims'
import { AccessTokenClaimsSchema } from './tokens'

describe('the namespace claim', () => {
  test('is `ext`', () => {
    expect(CUSTOM_CLAIMS_CLAIM).toBe('ext')
  })

  // A claim a later step adds to the token (device binding's `cnf`) cannot be forgotten here:
  // it has to be in the schema to be issued, and then this fails until it is reserved.
  test('every claim the server itself sets is reserved', () => {
    for (const claim of Object.keys(AccessTokenClaimsSchema.shape)) {
      expect(RESERVED_CLAIM_NAMES as readonly string[]).toContain(claim)
    }
  })

  test.each([
    'iss',
    'sub',
    'aud',
    'exp',
    'nbf',
    'iat',
    'jti',
    'sid',
    'amr',
    'auth_time',
    'sp',
    'cnf',
    'ext',
  ])('%s is reserved', (name) => {
    expect(RESERVED_CLAIM_NAMES as readonly string[]).toContain(name)
    expect(isCustomClaimKey(name)).toBe(false)
  })
})

describe('a custom claim key', () => {
  test.each([
    'role',
    'plan_2',
    'isStaff',
    'A',
    '_internal',
    'x'.repeat(MAX_CUSTOM_CLAIM_KEY_LENGTH),
  ])('%s is accepted', (key) => {
    expect(isCustomClaimKey(key)).toBe(true)
  })

  test.each([
    ['empty', ''],
    ['too long', 'x'.repeat(MAX_CUSTOM_CLAIM_KEY_LENGTH + 1)],
    ['a hyphen', 'my-claim'],
    ['a dot', 'a.b'],
    ['a space', 'a b'],
    ['a leading digit', '1st'],
    ['a URL', 'https://example.com/role'],
    ['non-ASCII', 'r\u{f6}le'],
    ['__proto__', '__proto__'],
    ['constructor', 'constructor'],
    ['prototype', 'prototype'],
  ])('%s is refused', (_label, key) => {
    expect(isCustomClaimKey(key)).toBe(false)
  })

  test('something that is not a string is refused', () => {
    expect(isCustomClaimKey(1)).toBe(false)
    expect(isCustomClaimKey(null)).toBe(false)
  })
})

describe('the size of the namespace claim', () => {
  test('is the UTF-8 length of its JSON', () => {
    expect(customClaimsBytes({})).toBe(2)
    expect(customClaimsBytes({ role: 'admin' })).toBe('{"role":"admin"}'.length)
    expect(customClaimsBytes({ n: 12, ok: true })).toBe('{"n":12,"ok":true}'.length)
  })

  test('counts bytes, not characters', () => {
    // U+00E9 is two bytes, U+20AC three, U+1F600 four (two UTF-16 units).
    expect(customClaimsBytes({ a: '\u{e9}' })).toBe(8 + 2)
    expect(customClaimsBytes({ a: '\u{20ac}' })).toBe(8 + 3)
    expect(customClaimsBytes({ a: '\u{1f600}' })).toBe(8 + 4)
  })

  test('counts what JSON escapes', () => {
    expect(customClaimsBytes({ a: '"' })).toBe(8 + 2)
    expect(customClaimsBytes({ a: '\n' })).toBe(8 + 2)
    expect(customClaimsBytes({ a: '\u{1}' })).toBe(8 + 6)
  })

  test('agrees with a real encoder', () => {
    const claims = { a: 'caf\u{e9} \u{20ac} \u{1f600} "q" \\ \u{7}', b: -1.5e-7, c: false }
    expect(customClaimsBytes(claims)).toBe(new TextEncoder().encode(JSON.stringify(claims)).length)
  })
})

describe('reading custom claims from verified claims', () => {
  test('a plain object of strings, numbers and booleans is returned, frozen', () => {
    const read = readCustomClaims({ sub: 'u', ext: { role: 'admin', seats: 3, staff: false } })
    expect(read).toEqual({ role: 'admin', seats: 3, staff: false })
    expect(Object.isFrozen(read)).toBe(true)
  })

  test('the result is a copy: changing the token’s object does not change it', () => {
    const ext = { role: 'admin' }
    const read = readCustomClaims({ ext })
    ext.role = 'owner'
    expect(read).toEqual({ role: 'admin' })
  })

  test.each([
    ['no claims at all', null],
    ['claims that are not an object', 'ext'],
    ['no namespace claim', { sub: 'u' }],
    ['null', { ext: null }],
    ['a string', { ext: 'admin' }],
    ['a number', { ext: 1 }],
    ['an array', { ext: ['admin'] }],
    ['an empty object', { ext: {} }],
    ['a nested object', { ext: { role: { name: 'admin' } } }],
    ['an array value', { ext: { roles: ['admin'] } }],
    ['a null value', { ext: { role: null } }],
    ['a reserved key', { ext: { sub: 'someone-else' } }],
    ['a key outside the grammar', { ext: { 'my-claim': 1 } }],
    ['a `__proto__` key', { ext: JSON.parse('{"__proto__":{"admin":true}}') }],
    ['a `constructor` key', { ext: JSON.parse('{"constructor":"x"}') }],
    ['a number JSON cannot hold', { ext: { n: Number.POSITIVE_INFINITY } }],
    ['an instance of a class', { ext: new Date(0) }],
  ])('%s is absent', (_label, claims) => {
    expect(readCustomClaims(claims)).toBeNull()
  })

  test('a claim larger than the cap is absent', () => {
    const big = { ext: { a: 'x'.repeat(MAX_CUSTOM_CLAIMS_BYTES) } }
    expect(readCustomClaims(big)).toBeNull()
  })

  test('an inherited namespace claim is not read', () => {
    const claims = Object.create({ ext: { role: 'admin' } }) as Record<string, unknown>
    expect(readCustomClaims(claims)).toBeNull()
  })
})
