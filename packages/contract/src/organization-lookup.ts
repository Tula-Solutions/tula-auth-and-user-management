// How a verifier handles a role whose permissions a token names by version and hash instead of
// carrying them (`org_rv`, `org_ph`): the hash, the reading of the claims and the size rule.
// Zod-free like `custom-claims`: `@tula-tech/contract/organization-lookup`.

import {
  MAX_ORGANIZATION_CLAIMS_BYTES,
  MAX_ORGANIZATION_PERMISSIONS_CLAIM,
  ORGANIZATION_ID_CLAIM,
  ORGANIZATION_ID_PATTERN,
  ORGANIZATION_PERMISSIONS_CLAIM,
  ORGANIZATION_PERMISSIONS_HASH_CLAIM,
  ORGANIZATION_ROLE_CLAIM,
  ORGANIZATION_ROLE_VERSION_CLAIM,
  type OrganizationClaims,
  organizationClaimsBytes,
  readOrganizationClaims,
} from './custom-claims'
import { ROLE_KEY_PATTERN } from './organization-permissions'

/** The scheme prefix of a permissions hash; a verifier refuses any other. */
const PERMISSIONS_HASH_PATTERN = /^1\.[A-Za-z0-9_-]{43}$/

/**
 * The hash of a role's permission keys: `1.` and the base64url (no
 * padding) of SHA-256 over the JSON of the keys, deduplicated and sorted by code point.
 *
 * Web Crypto, so it is the same in Bun, Node, browsers and edge runtimes.
 *
 * @param keys - The role's permission keys, in any order, duplicates allowed.
 * @returns The hash, 45 characters.
 *
 * @example
 * ```ts
 * await permissionsHash([]) // '1.T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU'
 * ```
 */
export async function permissionsHash(keys: readonly string[]): Promise<string> {
  const set = [...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(set))
  )
  let binary = ''
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte)
  }
  return `1.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

/**
 * Whether permission keys hash to the given value: how a verifier checks that `org_perms`
 * and `org_ph` agree, or that a fetched list is the one a token named.
 *
 * @param keys - The permission keys.
 * @param hash - The hash a token carries.
 * @returns `true` only for an exact match; an unknown scheme prefix is `false`.
 *
 * @example
 * ```ts
 * await verifyPermissionsHash([], '1.T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU') // true
 * ```
 */
export async function verifyPermissionsHash(
  keys: readonly string[],
  hash: string
): Promise<boolean> {
  return (await permissionsHash(keys)) === hash
}

/** What {@link readOrganizationTokenClaims} found in a session's claims. */
export type OrganizationTokenClaims =
  | { readonly kind: 'inline'; readonly claims: OrganizationClaims }
  | {
      readonly kind: 'lookup'
      readonly orgId: string
      readonly orgRole: string
      readonly roleVersion: number
      readonly permissionsHash: string
    }
  | { readonly kind: 'none' }

/**
 * Tell apart the three shapes an organization token takes: permissions
 * `inline` (`org_perms`), absent and to be fetched by version and hash (`lookup`), or no
 * organization (`none`).
 *
 * Fail closed: a partial or malformed claim set is `none`, and a malformed `org_perms` is never
 * read as a lookup. Call it only with verified claims.
 *
 * @param claims - A session's verified claims.
 * @returns The shape found.
 *
 * @example
 * ```ts
 * const found = readOrganizationTokenClaims(payload)
 * if (found.kind === 'lookup') {
 *   // fetch the list for found.roleVersion, then verifyPermissionsHash(list, found.permissionsHash)
 * }
 * ```
 */
export function readOrganizationTokenClaims(claims: unknown): OrganizationTokenClaims {
  if (typeof claims !== 'object' || claims === null) {
    return { kind: 'none' }
  }
  const record = claims as Record<string, unknown>
  if (ORGANIZATION_PERMISSIONS_CLAIM in record) {
    const inline = readOrganizationClaims(claims)
    return inline ? { kind: 'inline', claims: inline } : { kind: 'none' }
  }
  const [id, role, version, hash] = [
    record[ORGANIZATION_ID_CLAIM],
    record[ORGANIZATION_ROLE_CLAIM],
    record[ORGANIZATION_ROLE_VERSION_CLAIM],
    record[ORGANIZATION_PERMISSIONS_HASH_CLAIM],
  ]
  if (
    typeof id !== 'string' ||
    !ORGANIZATION_ID_PATTERN.test(id) ||
    typeof role !== 'string' ||
    !ROLE_KEY_PATTERN.test(role) ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof hash !== 'string' ||
    !PERMISSIONS_HASH_PATTERN.test(hash)
  ) {
    return { kind: 'none' }
  }
  return { kind: 'lookup', orgId: id, orgRole: role, roleVersion: version, permissionsHash: hash }
}

/**
 * Whether a role's permissions can ride in a token as `org_perms`: at most
 * {@link MAX_ORGANIZATION_PERMISSIONS_CLAIM} of them, and the claims within
 * {@link MAX_ORGANIZATION_CLAIMS_BYTES} for an id, a version and a hash of their longest.
 * The longest case is used so that the answer holds for every organization and every version of
 * the role: saving a role is judged once, a token is issued later.
 *
 * @param roleKey - The role's key.
 * @param permissions - The role's permission keys.
 * @returns `true` when a token can carry the list.
 *
 * @example
 * ```ts
 * roleFitsInline('admin', ['org:billing:read']) // true
 * ```
 */
export function roleFitsInline(roleKey: string, permissions: readonly string[]): boolean {
  return (
    permissions.length <= MAX_ORGANIZATION_PERMISSIONS_CLAIM &&
    organizationClaimsBytes({
      orgId: '0'.repeat(36),
      orgRole: roleKey,
      orgPermissions: permissions,
      roleVersion: 2147483647,
      permissionsHash: `1.${'A'.repeat(43)}`,
    }) <= MAX_ORGANIZATION_CLAIMS_BYTES
  )
}
