import type { ApiKeyRecord, ApiKeyRepository, NewApiKey } from '~/ports/api-key-repository'

interface Stored extends ApiKeyRecord {
  keyHash: string
}

function toRecord({ keyHash: _keyHash, ...record }: Stored): ApiKeyRecord {
  return { ...record }
}

/** In-memory API keys. */
export class MemoryApiKeyRepository implements ApiKeyRepository {
  readonly #keys: Stored[]

  // Assigned in the constructor, not as a field initializer: Bun's coverage counts a class with
  // initializers but no constructor as having an uncalled function, failing the per-file threshold.
  constructor() {
    this.#keys = []
  }

  /** @inheritdoc */
  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const key = this.#keys.find((candidate) => candidate.keyHash === keyHash)
    return key ? toRecord(key) : null
  }

  /** @inheritdoc */
  async insert(key: NewApiKey): Promise<ApiKeyRecord> {
    if (this.#keys.some((existing) => existing.keyHash === key.keyHash)) {
      throw new Error('api_keys_key_hash_key: duplicate key hash')
    }
    const stored: Stored = { ...key, lastUsedAt: null, revokedAt: null }
    this.#keys.push(stored)
    return toRecord(stored)
  }

  /** @inheritdoc */
  async listByEnvironment(environmentId: string): Promise<ApiKeyRecord[]> {
    return this.#keys
      .filter((key) => key.environmentId === environmentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map(toRecord)
  }

  /** @inheritdoc */
  async touch(id: string, at: Date): Promise<void> {
    const key = this.#keys.find((candidate) => candidate.id === id)
    if (key) {
      key.lastUsedAt = at
    }
  }

  /** @inheritdoc */
  async revoke(environmentId: string, id: string, at: Date): Promise<ApiKeyRecord | null> {
    const key = this.#keys.find(
      (candidate) => candidate.id === id && candidate.environmentId === environmentId
    )
    if (!key) {
      return null
    }
    key.revokedAt ??= at
    return toRecord(key)
  }
}
