import type { ApiKeyRepository, StoredApiKey } from '~/ports/api-key-repository'

/** In-memory API keys keyed by hash. Tests seed it with {@link MemoryApiKeyRepository.insert}. */
export class MemoryApiKeyRepository implements ApiKeyRepository {
  readonly #byHash: Map<string, StoredApiKey>

  // Assigned in the constructor, not as a field initializer: Bun's coverage counts a class with
  // initializers but no constructor as having an uncalled function, failing the per-file threshold.
  constructor() {
    this.#byHash = new Map()
  }

  /**
   * Store a key.
   *
   * @param keyHash - SHA-256 hex of the full key.
   * @param key - The stored key.
   */
  insert(keyHash: string, key: StoredApiKey): void {
    this.#byHash.set(keyHash, { ...key })
  }

  /**
   * Mark a key revoked.
   *
   * @param keyHash - SHA-256 hex of the full key.
   * @param at - Revocation time.
   */
  revoke(keyHash: string, at: Date): void {
    const key = this.#byHash.get(keyHash)
    if (key) {
      key.revokedAt = at
    }
  }

  /** @inheritdoc */
  async findByHash(keyHash: string): Promise<StoredApiKey | null> {
    const key = this.#byHash.get(keyHash)
    return key ? { ...key } : null
  }
}
