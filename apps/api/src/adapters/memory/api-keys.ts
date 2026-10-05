import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { activityOf, type Recorded } from '~/ports/activity-log'
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
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor, not as a field initializer: Bun's coverage counts a class with
  // initializers but no constructor as having an uncalled function, failing the per-file threshold.
  /** @param activityLog - Where activity is recorded; shared with the other memory stores. */
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#keys = []
    this.#activityLog = activityLog
  }

  /** @inheritdoc */
  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const key = this.#keys.find((candidate) => candidate.keyHash === keyHash)
    return key ? toRecord(key) : null
  }

  /** @inheritdoc */
  async insert(key: NewApiKey, recorded: Recorded): Promise<ApiKeyRecord> {
    const activity = activityOf(recorded)
    if (this.#keys.some((existing) => existing.keyHash === key.keyHash)) {
      throw new Error('api_keys_key_hash_key: duplicate key hash')
    }
    const stored: Stored = { ...key, lastUsedAt: null, revokedAt: null }
    this.#keys.push(stored)
    this.#activityLog.record(activity ? [activity] : [])
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
  async countByEnvironment(environmentId: string): Promise<{ active: number; total: number }> {
    const keys = this.#keys.filter((key) => key.environmentId === environmentId)
    return { active: keys.filter((key) => key.revokedAt === null).length, total: keys.length }
  }

  /** @inheritdoc */
  async touch(id: string, at: Date): Promise<void> {
    const key = this.#keys.find((candidate) => candidate.id === id)
    if (key) {
      key.lastUsedAt = at
    }
  }

  /** @inheritdoc */
  async revoke(
    environmentId: string,
    id: string,
    at: Date,
    recorded: Recorded
  ): Promise<ApiKeyRecord | null> {
    const activity = activityOf(recorded)
    const key = this.#keys.find(
      (candidate) => candidate.id === id && candidate.environmentId === environmentId
    )
    if (!key) {
      return null
    }
    if (key.revokedAt === null) {
      key.revokedAt = at
      this.#activityLog.record(activity ? [activity] : [])
    }
    return toRecord(key)
  }
}
