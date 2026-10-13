import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  events,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEndpoints,
  withTenant,
} from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { eq, sql } from 'drizzle-orm'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { isForeignKeyViolation } from '~/adapters/postgres/errors'
import { PostgresWebhookDeliveryStore } from '~/adapters/postgres/webhook-deliveries'
import { PostgresWebhookEndpointStore } from '~/adapters/postgres/webhook-endpoints'
import { describeWebhookStores } from '~/adapters/webhook-store.suite'
import * as Audit from '~/modules/audit/service'
import type { WebhookEndpointRecord } from '~/ports/webhook-endpoint-store'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

/** Fresh tenants per test: the suite counts rows per environment. */
async function tenants(): Promise<{ a: TestTenant; b: TestTenant }> {
  return {
    a: await createTestTenant(testDb.db),
    b: await createTestTenant(testDb.db, 'production'),
  }
}

async function seedEvent(
  tenant: { projectId: string; environmentId: string },
  event: { type: string; payload: Record<string, unknown>; occurredAt: Date }
): Promise<string> {
  const id = Bun.randomUUIDv7()
  await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx.insert(events).values({ id, ...tenant, ...event })
  )
  return id
}

function endpoint(tenant: TestTenant): WebhookEndpointRecord {
  return {
    id: Bun.randomUUIDv7(),
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    url: 'https://hooks.example.com/tula',
    eventTypes: ['user.created'],
    secret: 'v1.sealed.secret',
    previousSecret: null,
    previousSecretExpiresAt: null,
    enabled: true,
    disabledReason: null,
    failingSince: null,
    lastFailedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

describeWebhookStores('Postgres', async () => {
  const { a, b } = await tenants()
  const log = new PostgresActivityLog(testDb.db)
  return {
    endpoints: new PostgresWebhookEndpointStore(testDb.db),
    deliveries: new PostgresWebhookDeliveryStore(testDb.db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    seedEvent,
    deliveredAt: async (tenant, eventId) => {
      const [row] = await withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx.select({ deliveredAt: events.deliveredAt }).from(events).where(eq(events.id, eventId))
      )
      return row?.deliveredAt ?? null
    },
    eventExists: async (tenant, eventId) =>
      (
        await withTenant(testDb.db, tenant.environmentId, (tx) =>
          tx.select({ id: events.id }).from(events).where(eq(events.id, eventId))
        )
      ).length === 1,
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

/** A request that was made. */
const attempt = () => ({
  id: Bun.randomUUIDv7(),
  attemptedAt: new Date(),
  statusCode: 500,
  durationMs: 3,
  failureReason: null,
})

/** An endpoint with one queued delivery of a new event. */
async function queued(tenant: TestTenant, at = new Date()) {
  const endpoints = new PostgresWebhookEndpointStore(testDb.db)
  const deliveries = new PostgresWebhookDeliveryStore(testDb.db)
  const record = endpoint(tenant)
  await endpoints.insert(record, Audit.none('fixture'))
  const eventId = await seedEvent(tenant, { type: 'user.created', payload: {}, occurredAt: at })
  const id = Bun.randomUUIDv7()
  await deliveries.enqueue([
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      endpointId: record.id,
      eventId,
      eventType: 'user.created',
      at,
    },
  ])
  return { endpoints, deliveries, record, eventId, id }
}

test('row-level security hides another environment’s endpoints, deliveries and attempts even from a direct query', async () => {
  const { a, b } = await tenants()
  const { deliveries, id } = await queued(a)
  await deliveries.recordAttempt(
    a.environmentId,
    id,
    attempt(),
    { state: 'failed', nextAttemptAt: null, completedAt: new Date() },
    'pending'
  )
  const seenFromB = await withTenant(testDb.db, b.environmentId, async (tx) => ({
    endpoints: await tx.select({ id: webhookEndpoints.id }).from(webhookEndpoints),
    deliveries: await tx.select({ id: webhookDeliveries.id }).from(webhookDeliveries),
    attempts: await tx.select({ id: webhookDeliveryAttempts.id }).from(webhookDeliveryAttempts),
  }))
  expect(seenFromB).toEqual({ endpoints: [], deliveries: [], attempts: [] })
  expect(await testDb.db.select({ id: webhookEndpoints.id }).from(webhookEndpoints)).toEqual([])
  expect(await testDb.db.select({ id: webhookDeliveries.id }).from(webhookDeliveries)).toEqual([])
  expect(
    await testDb.db.select({ id: webhookDeliveryAttempts.id }).from(webhookDeliveryAttempts)
  ).toEqual([])
})

test('the runtime role moves a delivery’s state and nothing else of it, and never rewrites an attempt', async () => {
  const { a } = await tenants()
  const { deliveries, id } = await queued(a)
  await deliveries.recordAttempt(a.environmentId, id, attempt(), null, 'pending')
  const run = (statement: string) =>
    withTenant(testDb.db, a.environmentId, (tx) => tx.execute(sql.raw(statement))).then(
      () => 'allowed',
      (error: unknown) => String((error as Error).cause ?? error)
    )
  expect(await run("update tula.webhook_deliveries set state = 'failed'")).toBe('allowed')
  for (const statement of [
    'update tula.webhook_deliveries set endpoint_id = endpoint_id',
    'update tula.webhook_deliveries set event_id = null',
    "update tula.webhook_deliveries set created_at = now() - interval '1 year'",
    'update tula.webhook_deliveries set test = true',
    'update tula.webhook_delivery_attempts set status_code = 200',
    'delete from tula.webhook_delivery_attempts',
  ]) {
    expect(await run(statement)).toContain('permission denied')
  }
})

test('the database keeps a recent delivery, a pending one and a recent or unsettled event from being deleted, whatever is asked', async () => {
  const { a } = await tenants()
  const { deliveries, id, eventId, record } = await queued(a)
  const far = new Date(Date.now() + 365 * 86_400_000)
  // Pending, and made today.
  expect(await deliveries.deleteEndedBefore(a.environmentId, far, 10)).toBe(0)
  await deliveries.giveUp(a.environmentId, [id], 'expired', new Date())
  // Ended, but made today: the floor is seven days, in the database's own time.
  expect(await deliveries.deleteEndedBefore(a.environmentId, far, 10)).toBe(0)
  expect(await deliveries.find(a.environmentId, record.id, id)).not.toBeNull()
  // The event: settled, but it happened today.
  await deliveries.markDelivered(a.environmentId, [eventId], new Date(0))
  expect(await deliveries.deleteSettledEvents(a.environmentId, far, 10)).toBe(0)
  expect(await deliveries.eventsById(a.environmentId, [eventId])).toHaveLength(1)
})

test('neither a delivery nor an attempt has a column that could hold anything of the receiver’s answer but its status', async () => {
  await testDb.setRole('postgres')
  const result = (await testDb.db.execute(
    sql`select table_name, column_name from information_schema.columns
        where table_schema = 'tula'
          and table_name in ('webhook_deliveries', 'webhook_delivery_attempts')
        order by table_name, column_name`
  )) as unknown as { rows: { table_name: string; column_name: string }[] }
  await testDb.setRole('tula_app')
  const columns = (table: string) =>
    result.rows.filter((row) => row.table_name === table).map((row) => row.column_name)
  expect(columns('webhook_deliveries')).toEqual([
    'attempts',
    'completed_at',
    'created_at',
    'endpoint_id',
    'environment_id',
    'event_id',
    'event_type',
    'failure_reason',
    'id',
    'last_attempt_at',
    'next_attempt_at',
    'project_id',
    'state',
    'status_code',
    'test',
    'updated_at',
  ])
  expect(columns('webhook_delivery_attempts')).toEqual([
    'attempt',
    'attempted_at',
    'delivery_id',
    'duration_ms',
    'environment_id',
    'failure_reason',
    'id',
    'project_id',
    'status_code',
  ])
})

test('only a foreign-key violation is read as "the endpoint is gone"; any other failure of a write is thrown', async () => {
  const { a } = await tenants()
  const { deliveries, record, eventId } = await queued(a)
  const row = {
    id: 'not-a-uuid',
    projectId: a.projectId,
    environmentId: a.environmentId,
    endpointId: record.id,
    eventId,
    eventType: 'user.created',
    at: new Date(),
  }
  const failure = async (work: Promise<unknown>) =>
    work.then(
      () => null,
      (caught: unknown) => caught
    )
  const queueing = await failure(deliveries.enqueue([{ ...row, eventId: Bun.randomUUIDv7() }]))
  expect(queueing).not.toBeNull()
  expect(isForeignKeyViolation(queueing)).toBe(false)
  const testing = await failure(
    deliveries.recordTest(
      {
        ...row,
        eventId: null,
        test: true,
        state: 'failed',
        attempts: 0,
        nextAttemptAt: null,
        lastAttemptAt: null,
        statusCode: null,
        failureReason: null,
        completedAt: new Date(),
        createdAt: new Date(),
      },
      null
    )
  )
  expect(testing).not.toBeNull()
  expect(isForeignKeyViolation(testing)).toBe(false)
  expect(
    isForeignKeyViolation(Object.assign(new Error('wrapped'), { cause: { code: '23503' } }))
  ).toBe(true)
})

test('a failure while the batch is retried row by row is thrown too', async () => {
  const { a } = await tenants()
  const { deliveries, record, eventId } = await queued(a)
  const row = (id: string, endpointId: string) => ({
    id,
    projectId: a.projectId,
    environmentId: a.environmentId,
    endpointId,
    eventId: Bun.randomUUIDv7(),
    eventType: 'user.created',
    at: new Date(),
  })
  // The first row's endpoint is gone (a foreign-key violation: the batch is retried one at a
  // time); the second is not a row at all.
  const error = await deliveries
    .enqueue([row(Bun.randomUUIDv7(), Bun.randomUUIDv7()), row('not-a-uuid', record.id)])
    .then(
      () => null,
      (caught: unknown) => caught
    )
  expect(error).not.toBeNull()
  expect(isForeignKeyViolation(error)).toBe(false)
  expect(eventId).toBeString()
})
