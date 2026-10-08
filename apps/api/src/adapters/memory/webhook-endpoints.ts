import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  WebhookDisabledReason,
  WebhookEndpointChanges,
  WebhookEndpointHealth,
  WebhookEndpointRecord,
  WebhookEndpointStore,
} from '~/ports/webhook-endpoint-store'

/** In-memory webhook endpoints for tests. */
export class MemoryWebhookEndpointStore implements WebhookEndpointStore {
  readonly #records: Map<string, WebhookEndpointRecord>
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#records = new Map()
    this.#activityLog = activityLog
  }

  /**
   * Whether an endpoint exists: what the foreign key of a delivery row checks in Postgres.
   *
   * @param environmentId - The environment.
   * @param id - The endpoint.
   * @returns `true` when the environment has it.
   */
  has(environmentId: string, id: string): boolean {
    return this.#records.get(id)?.environmentId === environmentId
  }

  /** @inheritdoc */
  async list(environmentId: string): Promise<WebhookEndpointRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.environmentId === environmentId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((record) => structuredClone(record))
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<WebhookEndpointRecord | null> {
    const record = this.#records.get(id)
    return record && record.environmentId === environmentId ? structuredClone(record) : null
  }

  /** @inheritdoc */
  async insert(record: WebhookEndpointRecord, recorded: Recorded): Promise<WebhookEndpointRecord> {
    const activity = activityOf(recorded)
    if (this.#records.has(record.id)) {
      // The primary key, as Postgres would say it.
      throw new Error('duplicate key value violates unique constraint "webhook_endpoints_pkey"')
    }
    this.#records.set(record.id, structuredClone(record))
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(record)
  }

  /** @inheritdoc */
  async update(
    environmentId: string,
    id: string,
    changes: WebhookEndpointChanges,
    updatedAt: Date,
    recorded: Recorded
  ): Promise<WebhookEndpointRecord | null> {
    const activity = activityOf(recorded)
    const record = this.#records.get(id)
    if (!record || record.environmentId !== environmentId) {
      return null
    }
    const next: WebhookEndpointRecord = {
      ...record,
      url: changes.url ?? record.url,
      eventTypes: changes.eventTypes ? [...changes.eventTypes] : record.eventTypes,
      enabled: changes.enabled ?? record.enabled,
      disabledReason: changes.resetHealth ? null : record.disabledReason,
      failingSince: changes.resetHealth ? null : record.failingSince,
      lastFailedAt: changes.resetHealth ? null : record.lastFailedAt,
      updatedAt,
    }
    this.#records.set(id, next)
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(next)
  }

  /** @inheritdoc */
  async delete(environmentId: string, id: string, recorded: Recorded): Promise<boolean> {
    const activity = activityOf(recorded)
    const deleted = this.has(environmentId, id) && this.#records.delete(id)
    this.#activityLog.record(deleted && activity ? [activity] : [])
    return deleted
  }

  /** @inheritdoc */
  async setHealth(
    environmentId: string,
    id: string,
    expected: WebhookEndpointHealth | null,
    next: WebhookEndpointHealth
  ): Promise<boolean> {
    const record = this.#records.get(id)
    if (!record || record.environmentId !== environmentId) {
      return false
    }
    const same = (a: Date | null, b: Date | null) => a?.getTime() === b?.getTime()
    if (
      expected &&
      !(
        same(record.failingSince, expected.failingSince) &&
        same(record.lastFailedAt, expected.lastFailedAt)
      )
    ) {
      return false
    }
    record.failingSince = next.failingSince && new Date(next.failingSince)
    record.lastFailedAt = next.lastFailedAt && new Date(next.lastFailedAt)
    return true
  }

  /** @inheritdoc */
  async disable(
    environmentId: string,
    id: string,
    reason: WebhookDisabledReason,
    at: Date,
    recorded: Recorded
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    const record = this.#records.get(id)
    if (!record || record.environmentId !== environmentId || !record.enabled) {
      return false
    }
    this.#records.set(id, { ...record, enabled: false, disabledReason: reason, updatedAt: at })
    this.#activityLog.record(activity ? [activity] : [])
    return true
  }
}
