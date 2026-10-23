import { describe, expect, test } from 'bun:test'
import {
  CUSTOM_CLAIMS_CLAIM,
  checkCustomClaims,
  customClaimsBytes,
  isCustomClaimKey,
  MAX_CUSTOM_CLAIM_KEY_LENGTH,
  MAX_CUSTOM_CLAIMS_BYTES,
  MAX_ORGANIZATION_CLAIMS_BYTES,
  MAX_ORGANIZATION_PERMISSIONS_CLAIM,
  ORGANIZATION_ID_CLAIM,
  ORGANIZATION_PERMISSIONS_CLAIM,
  ORGANIZATION_ROLE_CLAIM,
  organizationClaimsBytes,
  RESERVED_CLAIM_NAMES,
  readCustomClaims,
  readOrganizationClaims,
} from './custom-claims'
import {
  BUILT_IN_ROLES,
  MAX_PERMISSIONS_PER_ROLE,
  PERMISSION_KEY_PATTERN,
  ROLE_KEY_PATTERN,
} from './organization'
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

describe('checking claims a source outside the settings hands over', () => {
  test('a plain object of scalars is the claims, as a copy with own keys only', () => {
    const given = { role: 'admin', seats: 3, staff: false }
    const checked = checkCustomClaims(given)
    expect(checked).toEqual({ claims: { role: 'admin', seats: 3, staff: false } })
    given.role = 'owner'
    expect(checked).toEqual({ claims: { role: 'admin', seats: 3, staff: false } })
  })

  test('no claims is an answer too: an empty object', () => {
    expect(checkCustomClaims({})).toEqual({ claims: {} })
  })

  test.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'role=admin'],
    ['a list', [{ role: 'admin' }]],
    ['an instance of a class', new Date(0)],
    ['a nested object', { role: { name: 'admin' } }],
    ['a list value', { roles: ['admin'] }],
    ['a null value', { role: null }],
    ['a number JSON cannot hold', { n: Number.NaN }],
    ['a key outside the grammar', { 'my-claim': 1 }],
    ['an empty key', { '': 1 }],
    ['a key that is too long', { ['k'.repeat(MAX_CUSTOM_CLAIM_KEY_LENGTH + 1)]: 1 }],
    ['a `__proto__` key', JSON.parse('{"__proto__":{"admin":true}}')],
    ['a `__proto__` key beside a good one', JSON.parse('{"role":"a","__proto__":"x"}')],
    ['a `constructor` key', JSON.parse('{"constructor":"x"}')],
    ['a `prototype` key', { prototype: 'x' }],
  ])('%s is invalid, whole', (_label, value) => {
    expect(checkCustomClaims(value)).toEqual({ problem: 'invalid' })
  })

  test.each(RESERVED_CLAIM_NAMES.map((name) => [name]))(
    'the reserved name %s is invalid, also beside good claims',
    (name) => {
      expect(checkCustomClaims({ [name]: 'x' })).toEqual({ problem: 'invalid' })
      expect(checkCustomClaims({ role: 'admin', [name]: 'x' })).toEqual({ problem: 'invalid' })
    }
  )

  test('the cap is the namespace claim’s: at it is fine, one byte over is too large', () => {
    // {"a":"…"} is 8 bytes around the string.
    const at = { a: 'x'.repeat(1016) }
    expect(customClaimsBytes(at)).toBe(1024)
    expect(checkCustomClaims(at)).toEqual({ claims: at })
    expect(checkCustomClaims({ a: 'x'.repeat(1017) })).toEqual({ problem: 'too_large' })
  })

  test('invalid is said before too large: nothing of a bad answer is measured', () => {
    expect(checkCustomClaims({ sub: 'x'.repeat(4096) })).toEqual({ problem: 'invalid' })
  })
})

describe('the organization claims (ADR 0065)', () => {
  const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

  test.each([ORGANIZATION_ID_CLAIM, ORGANIZATION_ROLE_CLAIM, ORGANIZATION_PERMISSIONS_CLAIM])(
    '%s is a top-level name no custom claim, template or hook may set',
    (name) => {
      expect(RESERVED_CLAIM_NAMES as readonly string[]).toContain(name)
      expect(isCustomClaimKey(name)).toBe(false)
      expect(checkCustomClaims({ [name]: 'x' })).toEqual({ problem: 'invalid' })
    }
  )

  test('are named org_id, org_role and org_perms', () => {
    expect([
      ORGANIZATION_ID_CLAIM,
      ORGANIZATION_ROLE_CLAIM,
      ORGANIZATION_PERMISSIONS_CLAIM,
    ]).toEqual(['org_id', 'org_role', 'org_perms'])
  })

  // The longest value the grammars allow: a UUID, a 32-character role key and as many
  // permissions as a role holds, each of the longest key.
  const longest = {
    orgId: ID,
    orgRole: `r${'x'.repeat(31)}`,
    orgPermissions: Array.from(
      { length: MAX_PERMISSIONS_PER_ROLE },
      (_, index) => `org:sys:${'f'.repeat(31)}${index % 10}:${'a'.repeat(31)}${index % 10}`
    ),
  }

  test('the maximal claims are made of keys the grammars accept', () => {
    expect(ROLE_KEY_PATTERN.test(longest.orgRole)).toBe(true)
    expect(longest.orgPermissions).toHaveLength(MAX_ORGANIZATION_PERMISSIONS_CLAIM)
    for (const permission of longest.orgPermissions) {
      expect(PERMISSION_KEY_PATTERN.test(permission)).toBe(true)
      expect(permission).toHaveLength(73)
    }
  })

  test('the cap covers the maximal role with a little room, and no more', () => {
    const bytes = organizationClaimsBytes(longest)
    expect(bytes).toBe(2541)
    expect(bytes).toBeLessThanOrEqual(MAX_ORGANIZATION_CLAIMS_BYTES)
    expect(MAX_ORGANIZATION_CLAIMS_BYTES - bytes).toBeLessThan(64)
    expect(MAX_PERMISSIONS_PER_ROLE).toBe(MAX_ORGANIZATION_PERMISSIONS_CLAIM)
  })

  test('the cap is its own: the custom claims keep their 1,024 bytes', () => {
    expect(MAX_CUSTOM_CLAIMS_BYTES).toBe(1024)
    expect(MAX_ORGANIZATION_CLAIMS_BYTES).not.toBe(MAX_CUSTOM_CLAIMS_BYTES)
  })

  test('the built-in roles fit', () => {
    for (const role of BUILT_IN_ROLES) {
      expect(
        organizationClaimsBytes({
          orgId: ID,
          orgRole: role.key,
          orgPermissions: role.permissions,
        })
      ).toBeLessThan(MAX_ORGANIZATION_CLAIMS_BYTES)
    }
  })

  describe('read from verified claims', () => {
    const claims = { org_id: ID, org_role: 'admin', org_perms: ['org:sys:memberships:read'] }

    test('returns the three together, frozen and copied', () => {
      const read = readOrganizationClaims({ sub: 'u', ...claims })
      expect(read).toEqual({
        orgId: ID,
        orgRole: 'admin',
        orgPermissions: ['org:sys:memberships:read'],
      })
      expect(Object.isFrozen(read)).toBe(true)
      expect(Object.isFrozen(read?.orgPermissions)).toBe(true)
    })

    test('a role with no permission is still an organization', () => {
      expect(readOrganizationClaims({ ...claims, org_perms: [] })?.orgPermissions).toEqual([])
    })

    test('the maximal claims are read, and one more permission is not', () => {
      const token = {
        org_id: longest.orgId,
        org_role: longest.orgRole,
        org_perms: longest.orgPermissions,
      }
      expect(readOrganizationClaims(token)?.orgPermissions).toHaveLength(32)
      expect(
        readOrganizationClaims({ ...token, org_perms: [...longest.orgPermissions, 'org:a:b'] })
      ).toBeNull()
    })

    test('claims over the cap are no organization, whole', () => {
      expect(
        readOrganizationClaims({
          ...claims,
          org_perms: ['x'.repeat(MAX_ORGANIZATION_CLAIMS_BYTES)],
        })
      ).toBeNull()
    })

    test.each([
      ['no claims', {}],
      ['not an object', 'org_id'],
      ['null', null],
      ['only the id', { org_id: ID }],
      ['no id', { org_role: 'admin', org_perms: [] }],
      ['no role', { org_id: ID, org_perms: [] }],
      ['no permissions', { org_id: ID, org_role: 'admin' }],
      ['an empty id', { ...claims, org_id: '' }],
      ['an empty role', { ...claims, org_role: '' }],
      ['an id that is not a string', { ...claims, org_id: 7 }],
      ['a role that is not a string', { ...claims, org_role: ['admin'] }],
      ['permissions that are a string', { ...claims, org_perms: 'org:sys:memberships:read' }],
      ['a permission that is not a string', { ...claims, org_perms: ['org:a:b', 7] }],
      ['permissions that are an object', { ...claims, org_perms: { 0: 'org:a:b' } }],
    ])('%s is no organization', (_name, value) => {
      expect(readOrganizationClaims(value)).toBeNull()
    })

    test('the custom claims namespace is no way to carry them', () => {
      expect(readOrganizationClaims({ ext: claims })).toBeNull()
    })
  })
})
