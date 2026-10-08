import { type Database, events, webhookDeliveries, withTenant } from '@tula/db'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { isForeignKeyViolation } from '~/adapters/postgres/errors'
import type {
  DeliveryInsertOutcome,
  PendingEvent,
  WebhookDeliveryRecord,
  WebhookDeliveryStore,
  WebhookFailureReason,
} from '~/ports/webhook-delivery-store'

/** Webhook deliveries and the outbox's waiting events in Postgres, behind row-level security. */
export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async pendingEvents(environmentId: string, limit: number): Promise<PendingEvent[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select({
          id: events.id,
          projectId: events.projectId,
          environmentId: events.environmentId,
          type: events.type,
          payload: events.payload,
          occurredAt: events.occurredAt,
        })
        .from(events)
        .where(and(eq(events.environmentId, environmentId), isNull(events.deliveredAt)))
        // On `events_environment_undelivered_idx`; the id breaks ties of one instant.
        .orderBy(asc(events.occurredAt), asc(events.id))
        .limit(limit)
    )
  }

  /** @inheritdoc */
  async listForEvents(
    environmentId: string,
    eventIds: readonly string[]
  ): Promise<WebhookDeliveryRecord[]> {
    if (eventIds.length === 0) {
      return []
    }
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select({
          id: webhookDeliveries.id,
          projectId: webhookDeliveries.projectId,
          environmentId: webhookDeliveries.environmentId,
          endpointId: webhookDeliveries.endpointId,
          eventId: webhookDeliveries.eventId,
          attemptedAt: webhookDeliveries.attemptedAt,
          outcome: webhookDeliveries.outcome,
          statusCode: webhookDeliveries.statusCode,
          durationMs: webhookDeliveries.durationMs,
          failureReason: webhookDeliveries.failureReason,
        })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.environmentId, environmentId),
            inArray(webhookDeliveries.eventId, [...eventIds])
          )
        )
    )
    return rows.map((row) => ({
      ...row,
      // The column is text: only this server's fixed words are ever written to it.
      failureReason: row.failureReason as WebhookFailureReason | null,
    }))
  }

  /** @inheritdoc */
  async insert(delivery: WebhookDeliveryRecord): Promise<DeliveryInsertOutcome> {
    try {
      const rows = await withTenant(this.db, delivery.environmentId, (tx) =>
        tx
          .insert(webhookDeliveries)
          .values(delivery)
          // One row per endpoint and event: a worker that lost a race changes nothing.
          .onConflictDoNothing({
            target: [webhookDeliveries.endpointId, webhookDeliveries.eventId],
          })
          .returning({ id: webhookDeliveries.id })
      )
      return rows.length === 1 ? 'recorded' : 'duplicate'
    } catch (error) {
      // The endpoint was removed (or the event deleted) while its delivery was under way.
      if (isForeignKeyViolation(error)) {
        return 'gone'
      }
      throw error
    }
  }

  /** @inheritdoc */
  async markDelivered(
    environmentId: string,
    eventIds: readonly string[],
    at: Date
  ): Promise<number> {
    if (eventIds.length === 0) {
      return 0
    }
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(events)
        .set({ deliveredAt: at })
        .where(
          and(
            eq(events.environmentId, environmentId),
            inArray(events.id, [...eventIds]),
            // Never moved once set: the first settlement is the one on record.
            isNull(events.deliveredAt)
          )
        )
        .returning({ id: events.id })
    )
    return rows.length
  }
}
