import { type Database, webhookEndpoints, withTenant } from '@tula/db'
import { and, asc, eq } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  WebhookEndpointChanges,
  WebhookEndpointRecord,
  WebhookEndpointStore,
} from '~/ports/webhook-endpoint-store'

const columns = {
  id: webhookEndpoints.id,
  projectId: webhookEndpoints.projectId,
  environmentId: webhookEndpoints.environmentId,
  url: webhookEndpoints.url,
  eventTypes: webhookEndpoints.eventTypes,
  secret: webhookEndpoints.secret,
  enabled: webhookEndpoints.enabled,
  createdAt: webhookEndpoints.createdAt,
  updatedAt: webhookEndpoints.updatedAt,
}

/** Webhook endpoints in Postgres, behind row-level security. */
export class PostgresWebhookEndpointStore implements WebhookEndpointStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async list(environmentId: string): Promise<WebhookEndpointRecord[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.environmentId, environmentId))
        // The id breaks ties between endpoints of the same instant, so the order is stable.
        .orderBy(asc(webhookEndpoints.createdAt), asc(webhookEndpoints.id))
    )
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<WebhookEndpointRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.environmentId, environmentId), eq(webhookEndpoints.id, id)))
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async insert(record: WebhookEndpointRecord, recorded: Recorded): Promise<WebhookEndpointRecord> {
    const activity = activityOf(recorded)
    return withTenant(this.db, record.environmentId, async (tx) => {
      const [row] = await tx.insert(webhookEndpoints).values(record).returning(columns)
      await recordActivity(tx, activity ? [activity] : [])
      // An insert that did not throw returns its row.
      return row as WebhookEndpointRecord
    })
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
    return withTenant(this.db, environmentId, async (tx) => {
      const [row] = await tx
        .update(webhookEndpoints)
        .set({
          // A field left out is `undefined`, which Drizzle leaves out of the statement.
          url: changes.url,
          eventTypes: changes.eventTypes,
          enabled: changes.enabled,
          updatedAt,
        })
        .where(and(eq(webhookEndpoints.environmentId, environmentId), eq(webhookEndpoints.id, id)))
        .returning(columns)
      await recordActivity(tx, row && activity ? [activity] : [])
      return row ?? null
    })
  }

  /** @inheritdoc */
  async delete(environmentId: string, id: string, recorded: Recorded): Promise<boolean> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      // The endpoint's delivery rows go with it: the foreign key cascades.
      const rows = await tx
        .delete(webhookEndpoints)
        .where(and(eq(webhookEndpoints.environmentId, environmentId), eq(webhookEndpoints.id, id)))
        .returning({ id: webhookEndpoints.id })
      const deleted = rows.length === 1
      await recordActivity(tx, deleted && activity ? [activity] : [])
      return deleted
    })
  }
}
