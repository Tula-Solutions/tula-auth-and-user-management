/** Publishable keys identify an environment from apps; secret keys authorize server calls. */
export type ApiKeyKind = 'publishable' | 'secret'

/** What key resolution needs to know about a stored key. Never includes the key itself. */
export interface StoredApiKey {
  id: string
  kind: ApiKeyKind
  projectId: string
  environmentId: string
  revokedAt: Date | null
}

/**
 * Looks up API keys by hash.
 *
 * Runs before any tenant is known (resolving the key is what determines the tenant), so it is the
 * one read that is not environment-scoped.
 */
export interface ApiKeyRepository {
  /**
   * Find a key by the SHA-256 hex of its full value.
   *
   * @param keyHash - `sha256Hex(presentedKey)`.
   * @returns The key, revoked or not, or `null` if no key has that hash.
   */
  findByHash(keyHash: string): Promise<StoredApiKey | null>
}
