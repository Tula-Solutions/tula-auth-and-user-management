import type { Recorded } from '~/ports/activity-log'

/** Publishable keys identify an environment from apps; secret keys authorize server calls. */
export type ApiKeyKind = 'publishable' | 'secret'

/** A stored API key. Never includes the key or its hash. */
export interface ApiKeyRecord {
  id: string
  kind: ApiKeyKind
  name: string
  projectId: string
  environmentId: string
  /** Last 4 characters of the key, for display. */
  lastFour: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

/** What {@link ApiKeyRepository.insert} stores: the record plus the key's SHA-256 hash. */
export interface NewApiKey extends Omit<ApiKeyRecord, 'lastUsedAt' | 'revokedAt'> {
  keyHash: string
}

/**
 * API key storage.
 *
 * `api_keys` has no row-level security (resolving a key is what determines the tenant), so every
 * method except {@link ApiKeyRepository.findByHash} takes the environment and **must** filter by
 * it: that filter is the only thing keeping one environment's keys away from another's.
 */
export interface ApiKeyRepository {
  /**
   * Find a key by the SHA-256 hex of its full value, across all environments.
   *
   * @param keyHash - `sha256Hex(presentedKey)`.
   * @returns The key, revoked or not, or `null` if no key has that hash.
   */
  findByHash(keyHash: string): Promise<ApiKeyRecord | null>

  /**
   * Store a new key.
   *
   * @param key - The record and the key's hash.
   * @param activity - Recorded in the same transaction.
   * @returns The stored record.
   */
  insert(key: NewApiKey, activity: Recorded): Promise<ApiKeyRecord>

  /**
   * List an environment's keys, newest first, including revoked ones.
   *
   * @param environmentId - The environment.
   * @returns Its keys.
   */
  listByEnvironment(environmentId: string): Promise<ApiKeyRecord[]>

  /**
   * How many keys an environment holds, without loading them.
   *
   * @param environmentId - The environment.
   * @returns The number of unrevoked keys and of all keys, revoked ones included.
   */
  countByEnvironment(environmentId: string): Promise<{ active: number; total: number }>

  /**
   * Record that a key was just used. Called after successful resolution, so the id comes from
   * `findByHash`, not from a client.
   *
   * @param id - The key id.
   * @param at - When it was used.
   */
  touch(id: string, at: Date): Promise<void>

  /**
   * Revoke a key in an environment. Revoking an already revoked key keeps its original time.
   *
   * @param environmentId - The environment the key must belong to.
   * @param id - The key id.
   * @param at - Revocation time.
   * @param activity - Recorded in the same transaction, only if the key was not revoked before.
   * @returns The revoked key, or `null` if no key with that id exists in the environment.
   */
  revoke(
    environmentId: string,
    id: string,
    at: Date,
    activity: Recorded
  ): Promise<ApiKeyRecord | null>
}
