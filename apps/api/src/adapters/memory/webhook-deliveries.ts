import { MemoryActivityLog, type OutboxRow } from '~/adapters/memory/activity-log'
import { MemoryWebhookEndpointStore } from '~/adapters/memory/webhook-endpoints'
import type {
  DeliveryListQuery,
  DeliveryTransition,
  NewWebhookAttempt,
  NewWebhookDelivery,
  OutboxEvent,
  WebhookAttemptRecord,
  WebhookDeliveryRecord,
  WebhookDeliveryStore,
  WebhookFailureReason,
} from '~/ports/webhook-delivery-store'

/** Oldest first; the id breaks ties of one instant. */
function byAge(a: { at: Date; id: string }, b: { at: Date; id: string }): number {
  return a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function toEvent({ deliveredAt: _deliveredAt, ...event }: OutboxRow): OutboxEvent {
  return structuredClone(event)
}

/**
 * In-memory webhook deliveries for tests, over the memory activity log's outbox.
 *
 * Mirrors what the Postgres constraints do: a delivery of an endpoint that does not exist is
 * not recorded, the rows of a deleted endpoint are gone with their attempts, and there is one
 * row per endpoint and event.
 */
export class MemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  readonly #activityLog: MemoryActivityLog
  readonly #endpoints: MemoryWebhookEndpointStore
  #rows: WebhookDeliveryRecord[]
  readonly #attempts: Map<string, WebhookAttemptRecord[]>

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(
    activityLog: MemoryActivityLog = new MemoryActivityLog(),
    endpoints: MemoryWebhookEndpointStore = new MemoryWebhookEndpointStore(activityLog)
  ) {
    this.#activityLog = activityLog
    this.#endpoints = endpoints
    this.#rows = []
    this.#attempts = new Map()
  }

  /** Drop the rows of endpoints that were deleted: the cascade of the Postgres foreign key. */
  #cascade(): WebhookDeliveryRecord[] {
    this.#rows = this.#rows.filter((row) => this.#endpoints.has(row.environmentId, row.endpointId))
    const kept = new Set(this.#rows.map((row) => row.id))
    for (const id of this.#attempts.keys()) {
      if (!kept.has(id)) {
        this.#attempts.delete(id)
      }
    }
    return this.#rows
  }

  /**
   * Every delivery row there is, in the order written: for a test's assertions. Copies.
   *
   * @returns The rows.
   */
  get rows(): WebhookDeliveryRecord[] {
    return this.#cascade().map((row) => structuredClone(row))
  }

  /**
   * The requests recorded for one delivery, oldest first: for a test's assertions. Copies.
   *
   * @param deliveryId - The delivery.
   * @returns Its attempts.
   */
  attemptsOf(deliveryId: string): WebhookAttemptRecord[] {
    this.#cascade()
    return (this.#attempts.get(deliveryId) ?? []).map((attempt) => structuredClone(attempt))
  }

  /** The pending rows among `deliveryIds`, of one environment. */
  #pending(environmentId: string, deliveryIds: readonly string[]): WebhookDeliveryRecord[] {
    return this.#cascade().filter(
      (row) =>
        row.environmentId === environmentId &&
        row.state === 'pending' &&
        deliveryIds.includes(row.id)
    )
  }

  /** @inheritdoc */
  async pendingEvents(environmentId: string, limit: number): Promise<OutboxEvent[]> {
    return this.#activityLog.outbox
      .filter((row) => row.environmentId === environmentId && row.deliveredAt === null)
      .sort((a, b) => byAge({ at: a.occurredAt, id: a.id }, { at: b.occurredAt, id: b.id }))
      .slice(0, limit)
      .map(toEvent)
  }

  /** @inheritdoc */
  async eventsById(environmentId: string, eventIds: readonly string[]): Promise<OutboxEvent[]> {
    return this.#activityLog.outbox
      .filter((row) => row.environmentId === environmentId && eventIds.includes(row.id))
      .map(toEvent)
  }

  /** @inheritdoc */
  async enqueue(deliveries: readonly NewWebhookDelivery[]): Promise<number> {
    const rows = this.#cascade()
    let written = 0
    for (const delivery of deliveries) {
      if (
        !this.#endpoints.has(delivery.environmentId, delivery.endpointId) ||
        rows.some(
          (row) => row.endpointId === delivery.endpointId && row.eventId === delivery.eventId
        )
      ) {
        continue
      }
      const { at, ...identity } = delivery
      rows.push({
        ...identity,
        test: false,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(at),
        lastAttemptAt: null,
        statusCode: null,
        failureReason: null,
        completedAt: null,
        createdAt: new Date(at),
      })
      written += 1
    }
    return written
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
      .sort((a, b) => byAge({ at: a.occurredAt, id: a.id }, { at: b.occurredAt, id: b.id }))
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

  /** @inheritdoc */
  async due(
    environmentId: string,
    endpointId: string,
    now: Date,
    limit: number
  ): Promise<WebhookDeliveryRecord[]> {
    return this.#cascade()
      .filter(
        (row) =>
          row.environmentId === environmentId &&
          row.endpointId === endpointId &&
          row.state === 'pending' &&
          row.nextAttemptAt !== null &&
          row.nextAttemptAt.getTime() <= now.getTime()
      )
      .sort((a, b) =>
        byAge({ at: a.nextAttemptAt as Date, id: a.id }, { at: b.nextAttemptAt as Date, id: b.id })
      )
      .slice(0, limit)
      .map((row) => structuredClone(row))
  }

  /** @inheritdoc */
  async recordAttempt(
    environmentId: string,
    deliveryId: string,
    attempt: NewWebhookAttempt,
    next: DeliveryTransition | null,
    from: 'pending' | 'ended'
  ): Promise<number | null> {
    const row = this.#cascade().find(
      (one) => one.id === deliveryId && one.environmentId === environmentId
    )
    if (!row || (row.state === 'pending') !== (from === 'pending')) {
      return null
    }
    row.attempts += 1
    row.lastAttemptAt = new Date(attempt.attemptedAt)
    row.statusCode = attempt.statusCode
    row.failureReason = attempt.failureReason
    if (next) {
      row.state = next.state
      row.nextAttemptAt = next.nextAttemptAt
      row.completedAt = next.completedAt
    }
    const log = this.#attempts.get(deliveryId) ?? []
    log.push({ ...structuredClone(attempt), attempt: row.attempts })
    this.#attempts.set(deliveryId, log)
    return row.attempts
  }

  /** @inheritdoc */
  async recordTest(
    delivery: WebhookDeliveryRecord,
    attempt: NewWebhookAttempt | null
  ): Promise<boolean> {
    const rows = this.#cascade()
    if (!this.#endpoints.has(delivery.environmentId, delivery.endpointId)) {
      return false
    }
    rows.push({ ...structuredClone(delivery), eventId: null, test: true })
    if (attempt) {
      this.#attempts.set(delivery.id, [{ ...structuredClone(attempt), attempt: 1 }])
    }
    return true
  }

  /** @inheritdoc */
  async defer(
    environmentId: string,
    deliveryIds: readonly string[],
    reason: WebhookFailureReason,
    nextAttemptAt: Date,
    _at: Date
  ): Promise<number> {
    const rows = this.#pending(environmentId, deliveryIds)
    for (const row of rows) {
      row.failureReason = reason
      row.statusCode = null
      row.nextAttemptAt = new Date(nextAttemptAt)
    }
    return rows.length
  }

  /** @inheritdoc */
  async giveUp(
    environmentId: string,
    deliveryIds: readonly string[],
    reason: WebhookFailureReason,
    at: Date
  ): Promise<number> {
    const rows = this.#pending(environmentId, deliveryIds)
    for (const row of rows) {
      row.state = 'failed'
      row.failureReason = reason
      row.statusCode = null
      row.nextAttemptAt = null
      row.completedAt = new Date(at)
    }
    return rows.length
  }

  /** @inheritdoc */
  async expire(
    environmentId: string,
    createdBefore: Date,
    at: Date,
    limit: number
  ): Promise<number> {
    const batch = this.#cascade()
      .filter(
        (row) =>
          row.environmentId === environmentId &&
          row.state === 'pending' &&
          row.createdAt.getTime() < createdBefore.getTime()
      )
      .sort((a, b) => byAge({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }))
      .slice(0, limit)
    return this.giveUp(
      environmentId,
      batch.map((row) => row.id),
      'expired',
      at
    )
  }

  /** @inheritdoc */
  async list(
    environmentId: string,
    endpointId: string,
    query: DeliveryListQuery
  ): Promise<{ deliveries: WebhookDeliveryRecord[]; totalCount: number }> {
    const matching = this.#cascade()
      .filter(
        (row) =>
          row.environmentId === environmentId &&
          row.endpointId === endpointId &&
          (query.state === undefined || row.state === query.state) &&
          (query.eventType === undefined || row.eventType === query.eventType)
      )
      // Newest first.
      .sort((a, b) => byAge({ at: b.createdAt, id: b.id }, { at: a.createdAt, id: a.id }))
    const start = (query.page - 1) * query.perPage
    return {
      deliveries: matching.slice(start, start + query.perPage).map((row) => structuredClone(row)),
      totalCount: matching.length,
    }
  }

  /** @inheritdoc */
  async find(
    environmentId: string,
    endpointId: string,
    id: string
  ): Promise<{ delivery: WebhookDeliveryRecord; attempts: WebhookAttemptRecord[] } | null> {
    const row = this.#cascade().find(
      (one) => one.id === id && one.environmentId === environmentId && one.endpointId === endpointId
    )
    return row ? { delivery: structuredClone(row), attempts: this.attemptsOf(id) } : null
  }

  /** @inheritdoc */
  async deleteSettledEvents(environmentId: string, before: Date, limit: number): Promise<number> {
    const waited = new Set(
      this.#cascade()
        .filter((row) => row.environmentId === environmentId && row.state === 'pending')
        .map((row) => row.eventId)
    )
    const { outbox } = this.#activityLog
    const batch = new Set(
      outbox
        .filter(
          (row) =>
            row.environmentId === environmentId &&
            row.deliveredAt !== null &&
            row.deliveredAt.getTime() < before.getTime() &&
            !waited.has(row.id)
        )
        .sort((a, b) =>
          byAge({ at: a.deliveredAt as Date, id: a.id }, { at: b.deliveredAt as Date, id: b.id })
        )
        .slice(0, limit)
        .map((row) => row.id)
    )
    this.#activityLog.dropEvents(batch)
    return batch.size
  }

  /** @inheritdoc */
  async deleteEndedBefore(environmentId: string, before: Date, limit: number): Promise<number> {
    const batch = new Set(
      this.#cascade()
        .filter(
          (row) =>
            row.environmentId === environmentId &&
            row.state !== 'pending' &&
            row.createdAt.getTime() < before.getTime()
        )
        .sort((a, b) => byAge({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }))
        .slice(0, limit)
        .map((row) => row.id)
    )
    this.#rows = this.#rows.filter((row) => !batch.has(row.id))
    for (const id of batch) {
      this.#attempts.delete(id)
    }
    return batch.size
  }
}
