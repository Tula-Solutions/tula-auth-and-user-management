import type { Deps, Tenant } from '~/dependencies'
import { AuthError } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import type { ApiKeyKind } from '~/ports/api-key-repository'

/** Longer values are rejected before hashing so huge headers cost nothing. */
const MAX_KEY_LENGTH = 256

/**
 * `last_used_at` precision. Writing it on every request would turn each authenticated read into
 * a database write; once a minute per key is plenty to spot stale keys.
 */
export const LAST_USED_PRECISION_MS = 60_000

/**
 * Resolve a presented API key to its tenant.
 *
 * Every failure (missing, wrong prefix, unknown, wrong kind, revoked) raises the same
 * `auth.invalid_key`, so responses reveal nothing about which keys exist. Lookup is by SHA-256
 * hash: the database never sees the key and a timing difference would only leak hash prefixes.
 *
 * @param deps - Key repository and clock (for `last_used_at`).
 * @param presented - The raw key from the request, if any.
 * @param kind - The kind this route requires.
 * @param prefix - The prefix keys of that kind start with.
 * @returns The resolved tenant.
 * @throws AuthError `auth.invalid_key`.
 */
export async function resolveApiKey(
  deps: Pick<Deps, 'apiKeys' | 'clock'>,
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
  const now = deps.clock.now()
  if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() >= LAST_USED_PRECISION_MS) {
    // Bookkeeping only: a failed write must never turn a valid key into a failed request.
    await deps.apiKeys.touch(key.id, now).catch((error: unknown) => {
      logger.warn('could not record api key usage', {
        apiKeyId: key.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    })
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
