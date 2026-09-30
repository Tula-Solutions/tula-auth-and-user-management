import type { Deps, Tenant } from '~/dependencies'
import { AuthError } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import type { ApiKeyKind } from '~/ports/api-key-repository'

/** Longer values are rejected before hashing so huge headers cost nothing. */
const MAX_KEY_LENGTH = 256

/**
 * Resolve a presented API key to its tenant.
 *
 * Every failure (missing, wrong prefix, unknown, wrong kind, revoked) raises the same
 * `auth.invalid_key`, so responses reveal nothing about which keys exist. Lookup is by SHA-256
 * hash: the database never sees the key and a timing difference would only leak hash prefixes.
 *
 * @param deps - Key repository.
 * @param presented - The raw key from the request, if any.
 * @param kind - The kind this route requires.
 * @param prefix - The prefix keys of that kind start with.
 * @returns The resolved tenant.
 * @throws AuthError `auth.invalid_key`.
 */
export async function resolveApiKey(
  deps: Pick<Deps, 'apiKeys'>,
  presented: string | undefined,
  kind: ApiKeyKind,
  prefix: string
): Promise<Tenant> {
  if (!presented || presented.length > MAX_KEY_LENGTH || !presented.startsWith(prefix)) {
    throw new AuthError('auth.invalid_key')
  }
  const key = await deps.apiKeys.findByHash(sha256Hex(presented))
  // The kind check stops a publishable key (public by design) from unlocking admin routes even
  // if prefixes were ever mis-assigned.
  if (!key || key.kind !== kind || key.revokedAt !== null) {
    throw new AuthError('auth.invalid_key')
  }
  return { projectId: key.projectId, environmentId: key.environmentId, apiKeyId: key.id }
}

/**
 * Extract the credential from an `Authorization: Bearer <value>` header.
 *
 * @param header - The header value, if present.
 * @returns The credential, or `undefined` for a missing or non-Bearer header.
 */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? '')
  return match?.[1]
}
