import type { OAuthProvider } from '@tula/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import type { Activity } from '~/ports/activity-log'
import type { OAuthProviderRecord, OAuthProviderStore } from '~/ports/oauth-provider-store'

/** In-memory OAuth provider credentials for tests. Mirrors the Postgres store's unique key. */
export class MemoryOAuthProviderStore implements OAuthProviderStore {
  readonly #records: Map<string, OAuthProviderRecord>
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#records = new Map()
    this.#activityLog = activityLog
  }

  async list(environmentId: string): Promise<OAuthProviderRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.environmentId === environmentId)
      .sort((a, b) => (a.provider < b.provider ? -1 : 1))
      .map((record) => structuredClone(record))
  }

  async find(environmentId: string, provider: OAuthProvider): Promise<OAuthProviderRecord | null> {
    const record = this.#records.get(`${environmentId}:${provider}`)
    return record ? structuredClone(record) : null
  }

  async upsert(record: OAuthProviderRecord, activity?: Activity): Promise<OAuthProviderRecord> {
    const key = `${record.environmentId}:${record.provider}`
    const existing = this.#records.get(key)
    const stored = structuredClone({
      ...record,
      id: existing?.id ?? record.id,
      createdAt: existing?.createdAt ?? record.createdAt,
    })
    this.#records.set(key, stored)
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(stored)
  }

  async delete(
    environmentId: string,
    provider: OAuthProvider,
    activity?: Activity
  ): Promise<boolean> {
    const deleted = this.#records.delete(`${environmentId}:${provider}`)
    this.#activityLog.record(deleted && activity ? [activity] : [])
    return deleted
  }
}
