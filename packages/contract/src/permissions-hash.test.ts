import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  hasOrganizationAccess,
  MAX_ORGANIZATION_CLAIMS_BYTES,
  ORGANIZATION_PERMISSIONS_HASH_CLAIM,
  ORGANIZATION_ROLE_VERSION_CLAIM,
  RESERVED_CLAIM_NAMES,
  readOrganizationClaims,
} from './custom-claims'
import {
  permissionsHash,
  readOrganizationTokenClaims,
  verifyPermissionsHash,
} from './organization-lookup'
import vectors from './permissions-hash-vectors.json'

/** The ADR's rule, written out independently with node:crypto. */
function expected(keys: string[]): string {
  const set = [...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return `1.${createHash('sha256').update(JSON.stringify(set)).digest('base64url')}`
}

describe('permissionsHash', () => {
  test.each(vectors.vectors.map((v) => [v.name, v.keys] as const))(
    'vector: %s',
    async (_n, keys) => {
      expect(await permissionsHash(keys)).toBe(expected([...keys]))
    }
  )

  test('the empty list has a known literal hash', async () => {
    expect(await permissionsHash([])).toBe('1.T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU')
  })

  test('order and duplicates do not change it', async () => {
    expect(await permissionsHash(['b', 'a', 'a'])).toBe(await permissionsHash(['a', 'b']))
  })

  test('verifyPermissionsHash accepts a match and refuses others', async () => {
    const h = await permissionsHash(['a'])
    expect(await verifyPermissionsHash(['a'], h)).toBe(true)
    expect(await verifyPermissionsHash(['a', 'b'], h)).toBe(false)
    expect(await verifyPermissionsHash(['a'], `2.${h.slice(2)}`)).toBe(false)
  })
})

describe('claim names', () => {
  test('org_rv and org_ph are reserved', () => {
    expect(ORGANIZATION_ROLE_VERSION_CLAIM).toBe('org_rv')
    expect(ORGANIZATION_PERMISSIONS_HASH_CLAIM).toBe('org_ph')
    expect(RESERVED_CLAIM_NAMES as readonly string[]).toContain('org_rv')
    expect(RESERVED_CLAIM_NAMES as readonly string[]).toContain('org_ph')
  })
})

const HASH = `1.${'A'.repeat(43)}`
const base = { org_id: 'o1', org_role: 'admin' }

describe('readOrganizationTokenClaims', () => {
  test('inline when org_perms is present', () => {
    const r = readOrganizationTokenClaims({
      ...base,
      org_perms: ['org:sys:memberships:read'],
      org_rv: 1,
      org_ph: HASH,
    })
    expect(r).toEqual({
      kind: 'inline',
      claims: {
        orgId: 'o1',
        orgRole: 'admin',
        orgPermissions: ['org:sys:memberships:read'],
        roleVersion: 1,
      },
    })
  })

  test('needs lookup when org_perms is absent', () => {
    expect(readOrganizationTokenClaims({ ...base, org_rv: 3, org_ph: HASH })).toEqual({
      kind: 'lookup',
      orgId: 'o1',
      orgRole: 'admin',
      roleVersion: 3,
      permissionsHash: HASH,
    })
  })

  test.each([
    ['not an object', null],
    ['no org', {}],
    ['id only', { org_id: 'o1' }],
    ['no version', { ...base, org_ph: HASH }],
    ['no hash', { ...base, org_rv: 1 }],
    ['version 0', { ...base, org_rv: 0, org_ph: HASH }],
    ['fractional version', { ...base, org_rv: 1.5, org_ph: HASH }],
    ['string version', { ...base, org_rv: '1', org_ph: HASH }],
    ['unknown scheme', { ...base, org_rv: 1, org_ph: `2.${'A'.repeat(43)}` }],
    ['short hash', { ...base, org_rv: 1, org_ph: '1.abc' }],
    ['bad role', { org_id: 'o1', org_role: 'A B', org_rv: 1, org_ph: HASH }],
    ['bad id', { org_id: 'o 1', org_role: 'admin', org_rv: 1, org_ph: HASH }],
    ['malformed org_perms is not a lookup', { ...base, org_perms: 'x', org_rv: 1, org_ph: HASH }],
    ['bad permission is not a lookup', { ...base, org_perms: ['BAD'], org_rv: 1, org_ph: HASH }],
  ])('none: %s', (_n, claims) => {
    expect(readOrganizationTokenClaims(claims)).toEqual({ kind: 'none' })
  })
})

describe('the old reader is unchanged', () => {
  test('a lookup token reads as no organization and no access', () => {
    const claims = { ...base, org_rv: 1, org_ph: HASH }
    expect(readOrganizationClaims(claims)).toBeNull()
    expect(
      hasOrganizationAccess(readOrganizationClaims(claims), {
        permission: 'org:sys:memberships:read',
      })
    ).toBe(false)
  })

  test('the budget', () => {
    expect(MAX_ORGANIZATION_CLAIMS_BYTES).toBe(2656)
  })
})
