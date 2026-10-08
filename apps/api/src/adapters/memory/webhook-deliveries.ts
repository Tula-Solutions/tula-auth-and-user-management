import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryWebhookEndpointStore } from '~/adapters/memory/webhook-endpoints'
import type {
  DeliveryInsertOutcome,
  PendingEvent,
  WebhookDeliveryRecord,
  WebhookDeliveryStore,
} from '~/ports/webhook-delivery-store'

/**
 * In-memory webhook deliveries for tests, over the memory activity log's outbox.
 *
 * Mirrors what the Postgres foreign keys do: a delivery of an endpoint or an event that does
 * not exist is not recorded, and the rows of a deleted endpoint are gone.
 */
export class MemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  readonly #activityLog: MemoryActivityLog
  readonly #endpoints: MemoryWebhookEndpointStore
  #rows: WebhookDeliveryRecord[]

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(
    activityLog: MemoryActivityLog = new MemoryActivityLog(),
    endpoints: MemoryWebhookEndpointStore = new MemoryWebhookEndpointStore(activityLog)
  ) {
    this.#activityLog = activityLog
    this.#endpoints = endpoints
    this.#rows = []
  }

  /** Drop the rows of endpoints that were deleted: the cascade of the Postgres foreign key. */
  #cascade(): WebhookDeliveryRecord[] {
    this.#rows = this.#rows.filter((row) => this.#endpoints.has(row.environmentId, row.endpointId))
    return this.#rows
  }

  /** @inheritdoc */
  async pendingEvents(environmentId: string, limit: number): Promise<PendingEvent[]> {
    return this.#activityLog.outbox
      .filter((row) => row.environmentId === environmentId && row.deliveredAt === null)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map(({ deliveredAt: _deliveredAt, ...event }) => structuredClone(event))
  }

  /** @inheritdoc */
  async listForEvents(
    environmentId: string,
    eventIds: readonly string[]
  ): Promise<WebhookDeliveryRecord[]> {
    return this.#cascade()
      .filter((row) => row.environmentId === environmentId && eventIds.includes(row.eventId))
      .map((row) => structuredClone(row))
  }

  /** @inheritdoc */
  async insert(delivery: WebhookDeliveryRecord): Promise<DeliveryInsertOutcome> {
    const rows = this.#cascade()
    const event = this.#activityLog.outbox.some(
      (row) => row.id === delivery.eventId && row.environmentId === delivery.environmentId
    )
    if (!event || !this.#endpoints.has(delivery.environmentId, delivery.endpointId)) {
      return 'gone'
    }
    if (
      rows.some((row) => row.endpointId === delivery.endpointId && row.eventId === delivery.eventId)
    ) {
      return 'duplicate'
    }
    rows.push(structuredClone(delivery))
    return 'recorded'
  }

  /** @inheritdoc */
  async settleBefore(
    environmentId: string,
    before: Date,
    at: Date,
    limit: number
  ): Promise<number> {
    const batch = this.#activityLog.outbox
      .filter(
        (row) =>
          row.environmentId === environmentId &&
          row.deliveredAt === null &&
          row.occurredAt.getTime() < before.getTime()
      )
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
    for (const row of batch) {
      row.deliveredAt = new Date(at)
    }
    return batch.length
  }

  /** @inheritdoc */
  async markDelivered(
    environmentId: string,
    eventIds: readonly string[],
    at: Date
  ): Promise<number> {
    let marked = 0
    for (const row of this.#activityLog.outbox) {
      if (
        row.environmentId === environmentId &&
        row.deliveredAt === null &&
        eventIds.includes(row.id)
      ) {
        row.deliveredAt = new Date(at)
        marked += 1
      }
    }
    return marked
  }
}
