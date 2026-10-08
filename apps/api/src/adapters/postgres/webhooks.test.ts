import { afterAll, beforeAll, expect, test } from 'bun:test'
import { events, webhookDeliveries, webhookEndpoints, withTenant } from '@tula/db'
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
    enabled: true,
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
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

test('row-level security hides another environment’s endpoints and deliveries even from a direct query', async () => {
  const { a, b } = await tenants()
  const endpoints = new PostgresWebhookEndpointStore(testDb.db)
  const deliveries = new PostgresWebhookDeliveryStore(testDb.db)
  const record = endpoint(a)
  await endpoints.insert(record, Audit.none('fixture'))
  const eventId = await seedEvent(a, {
    type: 'user.created',
    payload: {},
    occurredAt: new Date(),
  })
  await deliveries.insert({
    id: Bun.randomUUIDv7(),
    projectId: a.projectId,
    environmentId: a.environmentId,
    endpointId: record.id,
    eventId,
    attemptedAt: new Date(),
    outcome: 'delivered',
    statusCode: 200,
    durationMs: 3,
    failureReason: null,
  })
  const seenFromB = await withTenant(testDb.db, b.environmentId, async (tx) => ({
    endpoints: await tx.select({ id: webhookEndpoints.id }).from(webhookEndpoints),
    deliveries: await tx.select({ id: webhookDeliveries.id }).from(webhookDeliveries),
  }))
  expect(seenFromB).toEqual({ endpoints: [], deliveries: [] })
  expect(await testDb.db.select({ id: webhookEndpoints.id }).from(webhookEndpoints)).toEqual([])
  expect(await testDb.db.select({ id: webhookDeliveries.id }).from(webhookDeliveries)).toEqual([])
})

test('the runtime role cannot rewrite or remove a delivery row', async () => {
  const { a } = await tenants()
  const attempt = (statement: string) =>
    withTenant(testDb.db, a.environmentId, (tx) => tx.execute(sql.raw(statement))).then(
      () => 'allowed',
      (error: unknown) => String((error as Error).cause ?? error)
    )
  expect(await attempt("update tula.webhook_deliveries set outcome = 'delivered'")).toContain(
    'permission denied'
  )
  expect(await attempt('delete from tula.webhook_deliveries')).toContain('permission denied')
})

test('a delivery row has no column that could hold anything of the receiver’s answer but its status', async () => {
  await testDb.setRole('postgres')
  const result = (await testDb.db.execute(
    sql`select column_name from information_schema.columns
        where table_schema = 'tula' and table_name = 'webhook_deliveries' order by column_name`
  )) as unknown as { rows: { column_name: string }[] }
  await testDb.setRole('tula_app')
  expect(result.rows.map((row) => row.column_name)).toEqual([
    'attempted_at',
    'created_at',
    'duration_ms',
    'endpoint_id',
    'environment_id',
    'event_id',
    'failure_reason',
    'id',
    'outcome',
    'project_id',
    'status_code',
    'updated_at',
  ])
})

test('only a foreign-key violation is read as "gone"; any other failure of an insert is thrown', async () => {
  const { a } = await tenants()
  const deliveries = new PostgresWebhookDeliveryStore(testDb.db)
  const record = endpoint(a)
  await new PostgresWebhookEndpointStore(testDb.db).insert(record, Audit.none('fixture'))
  const eventId = await seedEvent(a, { type: 'user.created', payload: {}, occurredAt: new Date() })
  const broken = deliveries.insert({
    id: 'not-a-uuid',
    projectId: a.projectId,
    environmentId: a.environmentId,
    endpointId: record.id,
    eventId,
    attemptedAt: new Date(),
    outcome: 'delivered',
    statusCode: 200,
    durationMs: 3,
    failureReason: null,
  })
  const error = await broken.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).not.toBeNull()
  expect(isForeignKeyViolation(error)).toBe(false)
  expect(
    isForeignKeyViolation(Object.assign(new Error('wrapped'), { cause: { code: '23503' } }))
  ).toBe(true)
})
