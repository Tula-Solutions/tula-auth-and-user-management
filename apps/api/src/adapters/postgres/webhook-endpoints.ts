import { type Database, webhookEndpoints, withTenant } from '@tula/db'
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  WebhookDisabledReason,
  WebhookEndpointChanges,
  WebhookEndpointHealth,
  WebhookEndpointRecord,
  WebhookEndpointStore,
  WebhookSecretRotation,
} from '~/ports/webhook-endpoint-store'

const columns = {
  id: webhookEndpoints.id,
  projectId: webhookEndpoints.projectId,
  environmentId: webhookEndpoints.environmentId,
  url: webhookEndpoints.url,
  eventTypes: webhookEndpoints.eventTypes,
  secret: webhookEndpoints.secret,
  previousSecret: webhookEndpoints.previousSecret,
  previousSecretExpiresAt: webhookEndpoints.previousSecretExpiresAt,
  enabled: webhookEndpoints.enabled,
  disabledReason: webhookEndpoints.disabledReason,
  failingSince: webhookEndpoints.failingSince,
  lastFailedAt: webhookEndpoints.lastFailedAt,
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
          ...(changes.resetHealth
            ? { disabledReason: null, failingSince: null, lastFailedAt: null }
            : {}),
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

  /** @inheritdoc */
  async setHealth(
    environmentId: string,
    id: string,
    expected: WebhookEndpointHealth | null,
    next: WebhookEndpointHealth
  ): Promise<boolean> {
    // `IS NOT DISTINCT FROM`: equal, or both NULL. Plain `=` is never true of a NULL.
    const still = (
      column: typeof webhookEndpoints.failingSince | typeof webhookEndpoints.lastFailedAt,
      value: Date | null
    ) => (value === null ? isNull(column) : eq(column, value))
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(webhookEndpoints)
        // `updated_at` is set to itself: the column updates itself on every write otherwise,
        // and no administrator changed the endpoint.
        .set({
          failingSince: next.failingSince,
          lastFailedAt: next.lastFailedAt,
          updatedAt: sql`${webhookEndpoints.updatedAt}`,
        })
        .where(
          and(
            eq(webhookEndpoints.environmentId, environmentId),
            eq(webhookEndpoints.id, id),
            // The compare of the compare-and-set: in the statement itself, so it is judged
            // against the row as it is when the update takes its lock.
            expected ? still(webhookEndpoints.failingSince, expected.failingSince) : undefined,
            expected ? still(webhookEndpoints.lastFailedAt, expected.lastFailedAt) : undefined
          )
        )
        .returning({ id: webhookEndpoints.id })
    )
    return rows.length === 1
  }

  /** @inheritdoc */
  async rotateSecret(
    environmentId: string,
    id: string,
    rotation: WebhookSecretRotation,
    at: Date,
    recorded: Recorded
  ): Promise<WebhookEndpointRecord | null> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const [row] = await tx
        .update(webhookEndpoints)
        .set({
          secret: rotation.secret,
          previousSecret: rotation.previousSecret,
          previousSecretExpiresAt: rotation.previousSecretExpiresAt,
          updatedAt: at,
        })
        .where(
          and(
            eq(webhookEndpoints.environmentId, environmentId),
            eq(webhookEndpoints.id, id),
            // Both compares are in the statement itself, so they are judged against the row
            // as it is when the update takes its lock: of two rotations at once the second
            // sees the first one's secret and its overlap, and writes nothing.
            eq(webhookEndpoints.secret, rotation.expectedSecret),
            or(
              isNull(webhookEndpoints.previousSecretExpiresAt),
              lte(webhookEndpoints.previousSecretExpiresAt, at)
            )
          )
        )
        .returning(columns)
      await recordActivity(tx, row && activity ? [activity] : [])
      return row ?? null
    })
  }

  /** @inheritdoc */
  async revokePreviousSecret(
    environmentId: string,
    id: string,
    at: Date,
    recorded: Recorded
  ): Promise<WebhookEndpointRecord | null> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const [row] = await tx
        .update(webhookEndpoints)
        .set({ previousSecret: null, previousSecretExpiresAt: null, updatedAt: at })
        .where(
          and(
            eq(webhookEndpoints.environmentId, environmentId),
            eq(webhookEndpoints.id, id),
            // Guarded: only a previous secret that still signs is revoked (and recorded).
            gt(webhookEndpoints.previousSecretExpiresAt, at)
          )
        )
        .returning(columns)
      await recordActivity(tx, row && activity ? [activity] : [])
      return row ?? null
    })
  }

  /** @inheritdoc */
  async clearExpiredPreviousSecrets(
    environmentId: string,
    at: Date,
    limit: number
  ): Promise<number> {
    const expired = and(
      eq(webhookEndpoints.environmentId, environmentId),
      lte(webhookEndpoints.previousSecretExpiresAt, at)
    )
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(webhookEndpoints)
        .set({
          previousSecret: null,
          previousSecretExpiresAt: null,
          // Set to itself, as in `setHealth`: no administrator changed the endpoint.
          updatedAt: sql`${webhookEndpoints.updatedAt}`,
        })
        .where(
          and(
            // Said again on the update itself: the batch is chosen from a snapshot, and a
            // rotation committed since then has put a secret there that still signs.
            expired,
            inArray(
              webhookEndpoints.id,
              tx
                .select({ id: webhookEndpoints.id })
                .from(webhookEndpoints)
                .where(expired)
                .orderBy(asc(webhookEndpoints.previousSecretExpiresAt), asc(webhookEndpoints.id))
                .limit(limit)
            )
          )
        )
        .returning({ id: webhookEndpoints.id })
    )
    return rows.length
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
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .update(webhookEndpoints)
        .set({ enabled: false, disabledReason: reason, updatedAt: at })
        .where(
          and(
            eq(webhookEndpoints.environmentId, environmentId),
            eq(webhookEndpoints.id, id),
            // Guarded: an endpoint an administrator has just switched off is left as they left it.
            eq(webhookEndpoints.enabled, true)
          )
        )
        .returning({ id: webhookEndpoints.id })
      const disabled = rows.length === 1
      await recordActivity(tx, disabled && activity ? [activity] : [])
      return disabled
    })
  }
}
