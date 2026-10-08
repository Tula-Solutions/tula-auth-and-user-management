import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import * as schema from './schema'
import { withTenant } from './tenant'
import {
  createTestDatabase,
  createTestTenant,
  queryRows,
  type TestDatabase,
  type TestTenant,
} from './testing'

let testDb: TestDatabase
let a: TestTenant
let b: TestTenant
let userB: string
let sessionB: string

async function settle<T>(query: PromiseLike<T>): Promise<T> {
  return await query
}

/**
 * Await something that must fail and return the database's own message. Drizzle wraps driver
 * errors as "Failed query: …" and keeps the Postgres error in `cause`, so assert on the cause to
 * prove *why* it failed, not merely that it threw.
 */
async function failureReason(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query
  } catch (error) {
    let current: unknown = error
    const messages: string[] = []
    while (current instanceof Error) {
      messages.push(current.message)
      current = current.cause
    }
    return messages.join(' <- ')
  }
  throw new Error('expected the query to fail, but it succeeded')
}

/** Insert as environment A (the referenced parent belongs to environment B). */
function insertAsA(table: PgTable, values: Record<string, unknown>) {
  return withTenant(testDb.db, a.environmentId, (tx) => settle(tx.insert(table).values(values)))
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  a = await createTestTenant(testDb.db)
  b = await createTestTenant(testDb.db)
  await withTenant(testDb.db, b.environmentId, async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({ ...b, email: 'b@b.test', emailNormalized: 'b@b.test' })
      .returning()
    const now = new Date()
    const [session] = await tx
      .insert(schema.sessions)
      .values({
        ...b,
        userId: user!.id,
        profile: 'web',
        client: 'web',
        lastActiveAt: now,
        idleExpiresAt: now,
      })
      .returning()
    userB = user!.id
    sessionB = session!.id
  })
})

afterAll(() => testDb.close())

describe('child rows cannot reference another environment’s parents (F2)', () => {
  const now = new Date()
  test.each<[string, () => [PgTable, Record<string, unknown>]]>([
    [
      'session → user',
      () => [
        schema.sessions,
        {
          ...a,
          userId: userB,
          profile: 'web',
          client: 'web',
          lastActiveAt: now,
          idleExpiresAt: now,
        },
      ],
    ],
    [
      'credential → user',
      () => [schema.credentials, { ...a, userId: userB, type: 'password', secret: 'x' }],
    ],
    [
      'identity → user',
      () => [schema.identities, { ...a, userId: userB, provider: 'email', providerSubject: 'x' }],
    ],
    [
      'refresh token → session',
      () => [schema.refreshTokens, { ...a, sessionId: sessionB, tokenHash: 'h', expiresAt: now }],
    ],
    [
      'flow attempt → user',
      () => [
        schema.flowAttempts,
        {
          ...a,
          userId: userB,
          kind: 'sign_in',
          status: 'needs_password',
          identifier: 'x',
          expiresAt: now,
        },
      ],
    ],
    [
      'verification token → user',
      () => [
        schema.verificationTokens,
        {
          ...a,
          userId: userB,
          purpose: 'email_verification',
          destination: 'x',
          codeHash: 'h',
          expiresAt: now,
        },
      ],
    ],
  ])('%s is rejected', async (_, build) => {
    const [table, values] = build()
    expect(await failureReason(insertAsA(table, values))).toMatch(/violates foreign key constraint/)
  })
})

describe('runtime role privileges are least-privilege (F3)', () => {
  test.each([
    'delete from tula.workspaces',
    'delete from tula.projects',
    'delete from tula.environments',
    'delete from tula.api_keys',
    'update tula.audit_logs set action = action',
    'truncate tula.audit_logs',
    'truncate tula.events',
    // The outbox: the one column the runtime role may update is `delivered_at` (0019).
    "update tula.events set type = 'user.created'",
    "update tula.events set payload = '{}'::jsonb",
    'update tula.events set occurred_at = now()',
    // A delivery's identity and age are not the runtime role's to change (0019).
    'update tula.webhook_deliveries set endpoint_id = endpoint_id',
    'update tula.webhook_deliveries set event_id = event_id',
    "update tula.webhook_deliveries set event_type = 'user.created'",
    'update tula.webhook_deliveries set test = true',
    'update tula.webhook_deliveries set created_at = now()',
    // The log of attempts is append-only.
    'update tula.webhook_delivery_attempts set status_code = 200',
    'delete from tula.webhook_delivery_attempts',
    'truncate tula.webhook_delivery_attempts',
    'truncate tula.webhook_deliveries',
  ])('tula_app cannot run: %s', async (statement) => {
    expect(await failureReason(testDb.db.execute(sql.raw(statement)))).toMatch(/permission denied/)
  })

  test('tables created later get no privileges by default', async () => {
    await testDb.setRole('postgres')
    await testDb.db.execute(sql`create table tula.zz_probe (id int)`)
    await testDb.setRole('tula_app')
    const probe = testDb.db.execute(sql`select * from tula.zz_probe`)
    expect(await failureReason(probe)).toMatch(/permission denied/)
    await testDb.setRole('postgres')
    await testDb.db.execute(sql`drop table tula.zz_probe`)
    await testDb.setRole('tula_app')
  })

  test('no default privileges exist for tula_app, whoever ran the migrations (F7)', async () => {
    await testDb.setRole('postgres')
    const rows = await queryRows<{ acl: string }>(
      testDb.db,
      sql`select defaclacl::text as acl from pg_default_acl where defaclacl::text like '%tula_app%'`
    )
    await testDb.setRole('tula_app')
    expect(rows).toEqual([])
  })

  test('every tula table has an explicit runtime grant (no table ships unreachable or ungranted)', async () => {
    const rows = await queryRows<{ table: string }>(
      testDb.db,
      sql`
        select c.relname as table from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'tula'
        where c.relkind = 'r' and not has_table_privilege('tula_app', c.oid, 'select')
      `
    )
    expect(rows).toEqual([])
  })

  test('both audit logs can be purged by the runtime role, and neither can be rewritten or emptied', async () => {
    const rows = await queryRows<{ table: string; privilege: string; held: boolean }>(
      testDb.db,
      sql`
        select t.name as table, p.name as privilege,
               has_table_privilege('tula_app', 'tula.' || t.name, p.name) as held
        from (values ('instance_audit_logs'), ('audit_logs')) as t(name),
             (values ('DELETE'), ('UPDATE'), ('TRUNCATE')) as p(name)
        order by t.name, p.name
      `
    )
    expect(rows).toEqual([
      // The retention job's purge of entries past `audit.retentionDays` (migration 0017).
      { table: 'audit_logs', privilege: 'DELETE', held: true },
      { table: 'audit_logs', privilege: 'TRUNCATE', held: false },
      { table: 'audit_logs', privilege: 'UPDATE', held: false },
      // The retention job's purge (migration 0016).
      { table: 'instance_audit_logs', privilege: 'DELETE', held: true },
      { table: 'instance_audit_logs', privilege: 'TRUNCATE', held: false },
      { table: 'instance_audit_logs', privilege: 'UPDATE', held: false },
    ])
  })

  test('the webhook tables and the outbox: what the runtime role holds on each', async () => {
    const rows = await queryRows<{ table: string; privilege: string; held: boolean }>(
      testDb.db,
      sql`
        select t.name as table, p.name as privilege,
               has_table_privilege('tula_app', 'tula.' || t.name, p.name) as held
        from (values ('webhook_deliveries'), ('webhook_delivery_attempts'), ('webhook_endpoints'),
                     ('events')) as t(name),
             (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(name)
        order by t.name, p.name
      `
    )
    expect(rows).toEqual([
      // The retention job deletes settled events (0019), inside `events_retention_floor`.
      { table: 'events', privilege: 'DELETE', held: true },
      { table: 'events', privilege: 'INSERT', held: true },
      { table: 'events', privilege: 'TRUNCATE', held: false },
      // Not on the table any more: on `delivered_at` alone (below).
      { table: 'events', privilege: 'UPDATE', held: false },
      // The retention job deletes old rows (0019), inside `webhook_deliveries_retention_floor`.
      { table: 'webhook_deliveries', privilege: 'DELETE', held: true },
      { table: 'webhook_deliveries', privilege: 'INSERT', held: true },
      { table: 'webhook_deliveries', privilege: 'TRUNCATE', held: false },
      // Not on the table: on the state columns alone (below).
      { table: 'webhook_deliveries', privilege: 'UPDATE', held: false },
      // One row per request, written once.
      { table: 'webhook_delivery_attempts', privilege: 'DELETE', held: false },
      { table: 'webhook_delivery_attempts', privilege: 'INSERT', held: true },
      { table: 'webhook_delivery_attempts', privilege: 'TRUNCATE', held: false },
      { table: 'webhook_delivery_attempts', privilege: 'UPDATE', held: false },
      // An administrator removes an endpoint on the request path.
      { table: 'webhook_endpoints', privilege: 'DELETE', held: true },
      { table: 'webhook_endpoints', privilege: 'INSERT', held: true },
      { table: 'webhook_endpoints', privilege: 'TRUNCATE', held: false },
      { table: 'webhook_endpoints', privilege: 'UPDATE', held: true },
    ])
  })

  test('the columns the runtime role may update on the outbox and on a delivery, and no others', async () => {
    const rows = await queryRows<{ table: string; column: string }>(
      testDb.db,
      sql`
        select c.relname as table, a.attname as column
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'tula'
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where c.relname in ('events', 'webhook_deliveries', 'webhook_delivery_attempts')
          and has_column_privilege('tula_app', c.oid, a.attname, 'UPDATE')
        order by c.relname, a.attname
      `
    )
    expect(rows).toEqual([
      { table: 'events', column: 'delivered_at' },
      { table: 'webhook_deliveries', column: 'attempts' },
      { table: 'webhook_deliveries', column: 'completed_at' },
      { table: 'webhook_deliveries', column: 'failure_reason' },
      { table: 'webhook_deliveries', column: 'last_attempt_at' },
      { table: 'webhook_deliveries', column: 'next_attempt_at' },
      { table: 'webhook_deliveries', column: 'state' },
      { table: 'webhook_deliveries', column: 'status_code' },
      { table: 'webhook_deliveries', column: 'updated_at' },
    ])
  })

  test('neither a delivery nor an attempt has a column that could hold a receiver’s answer', async () => {
    const rows = await queryRows<{ table: string; column: string }>(
      testDb.db,
      sql`
        select table_name as table, column_name as column from information_schema.columns
        where table_schema = 'tula'
          and table_name in ('webhook_deliveries', 'webhook_delivery_attempts')
        order by table_name, column_name
      `
    )
    expect(rows.map((row) => `${row.table}.${row.column}`)).toEqual([
      'webhook_deliveries.attempts',
      'webhook_deliveries.completed_at',
      'webhook_deliveries.created_at',
      'webhook_deliveries.endpoint_id',
      'webhook_deliveries.environment_id',
      'webhook_deliveries.event_id',
      'webhook_deliveries.event_type',
      'webhook_deliveries.failure_reason',
      'webhook_deliveries.id',
      'webhook_deliveries.last_attempt_at',
      'webhook_deliveries.next_attempt_at',
      'webhook_deliveries.project_id',
      'webhook_deliveries.state',
      'webhook_deliveries.status_code',
      'webhook_deliveries.test',
      'webhook_deliveries.updated_at',
      'webhook_delivery_attempts.attempt',
      'webhook_delivery_attempts.attempted_at',
      'webhook_delivery_attempts.delivery_id',
      'webhook_delivery_attempts.duration_ms',
      'webhook_delivery_attempts.environment_id',
      'webhook_delivery_attempts.failure_reason',
      'webhook_delivery_attempts.id',
      'webhook_delivery_attempts.project_id',
      'webhook_delivery_attempts.status_code',
    ])
  })

  describe('what the runtime role may delete from the outbox', () => {
    const DAY = 86_400_000
    const write = async (tenant: TestTenant, occurredAt: Date, deliveredAt: Date | null) => {
      const id = Bun.randomUUIDv7()
      await withTenant(testDb.db, tenant.environmentId, (tx) =>
        settle(
          tx.insert(schema.events).values({
            id,
            projectId: tenant.projectId,
            environmentId: tenant.environmentId,
            type: 'user.created',
            payload: {},
            occurredAt,
            deliveredAt,
          })
        )
      )
      return id
    }
    const exists = async (tenant: TestTenant, id: string) =>
      (
        await withTenant(testDb.db, tenant.environmentId, (tx) =>
          tx.select().from(schema.events).where(eq(schema.events.id, id))
        )
      ).length === 1
    const old = () => new Date(Date.now() - 40 * DAY)
    const sweep = (tenant: TestTenant) =>
      withTenant(testDb.db, tenant.environmentId, (tx) => tx.delete(schema.events).returning())

    test('a settled event of its own environment that is more than a day old', async () => {
      const id = await write(a, old(), old())
      expect((await sweep(a)).map((row) => row.id)).toContain(id)
      expect(await exists(a, id)).toBe(false)
    })

    test('never an event no worker has settled, however old', async () => {
      const id = await write(a, old(), null)
      expect((await sweep(a)).map((row) => row.id)).not.toContain(id)
      expect(await exists(a, id)).toBe(true)
    })

    test('never an event of the last day, settled or not', async () => {
      const id = await write(a, new Date(Date.now() - DAY + 3_600_000), new Date())
      expect((await sweep(a)).map((row) => row.id)).not.toContain(id)
      expect(await exists(a, id)).toBe(true)
    })

    test('never another environment’s event', async () => {
      const id = await write(b, old(), old())
      expect((await sweep(a)).map((row) => row.id)).not.toContain(id)
      expect(await exists(b, id)).toBe(true)
    })

    test('nothing at all outside a tenant scope (fail closed)', async () => {
      const id = await write(a, old(), old())
      expect(await queryRows(testDb.db, sql`delete from tula.events returning id`)).toEqual([])
      expect(await exists(a, id)).toBe(true)
    })

    test('and it can settle an event but not backdate one to get past the floor', async () => {
      const id = await write(a, new Date(), null)
      const settled = await withTenant(testDb.db, a.environmentId, (tx) =>
        tx
          .update(schema.events)
          .set({ deliveredAt: old() })
          .where(eq(schema.events.id, id))
          .returning()
      )
      expect(settled).toHaveLength(1)
      // Settled long ago, as far as the row says; it still happened today.
      expect((await sweep(a)).map((row) => row.id)).not.toContain(id)
      const backdate = withTenant(testDb.db, a.environmentId, (tx) =>
        settle(tx.update(schema.events).set({ occurredAt: old() }).where(eq(schema.events.id, id)))
      )
      expect(await failureReason(backdate)).toMatch(/permission denied/)
    })
  })

  describe('what the runtime role may delete from the delivery log', () => {
    const DAY = 86_400_000
    const endpoint = async (tenant: TestTenant) => {
      const id = Bun.randomUUIDv7()
      await withTenant(testDb.db, tenant.environmentId, (tx) =>
        settle(
          tx.insert(schema.webhookEndpoints).values({
            id,
            projectId: tenant.projectId,
            environmentId: tenant.environmentId,
            url: 'https://hooks.example.com/tula',
            eventTypes: ['user.created'],
            secret: 'sealed',
          })
        )
      )
      return id
    }
    const write = async (
      tenant: TestTenant,
      endpointId: string,
      state: 'pending' | 'delivered' | 'failed',
      createdAt: Date
    ) => {
      const id = Bun.randomUUIDv7()
      await withTenant(testDb.db, tenant.environmentId, async (tx) => {
        await tx.insert(schema.webhookDeliveries).values({
          id,
          projectId: tenant.projectId,
          environmentId: tenant.environmentId,
          endpointId,
          eventId: Bun.randomUUIDv7(),
          eventType: 'user.created',
          state,
          attempts: 1,
          createdAt,
        })
        await tx.insert(schema.webhookDeliveryAttempts).values({
          id: Bun.randomUUIDv7(),
          projectId: tenant.projectId,
          environmentId: tenant.environmentId,
          deliveryId: id,
          attempt: 1,
          attemptedAt: createdAt,
          statusCode: 500,
          durationMs: 1,
        })
      })
      return id
    }
    const attemptsOf = (tenant: TestTenant, deliveryId: string) =>
      withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx
          .select()
          .from(schema.webhookDeliveryAttempts)
          .where(eq(schema.webhookDeliveryAttempts.deliveryId, deliveryId))
      )
    const old = () => new Date(Date.now() - 100 * DAY)
    const sweep = (tenant: TestTenant) =>
      withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx.delete(schema.webhookDeliveries).returning()
      )

    test('an old finished delivery of its own environment, and its attempts go with it', async () => {
      const at = await endpoint(a)
      const delivered = await write(a, at, 'delivered', old())
      const failed = await write(a, at, 'failed', old())
      const ids = (await sweep(a)).map((row) => row.id)
      expect(ids).toContain(delivered)
      expect(ids).toContain(failed)
      expect(await attemptsOf(a, delivered)).toEqual([])
    })

    test('never a delivery that is still pending, however old', async () => {
      const id = await write(a, await endpoint(a), 'pending', old())
      expect((await sweep(a)).map((row) => row.id)).not.toContain(id)
      expect(await attemptsOf(a, id)).toHaveLength(1)
    })

    test('never a delivery of the last week', async () => {
      const id = await write(a, await endpoint(a), 'failed', new Date(Date.now() - 6 * DAY))
      expect((await sweep(a)).map((row) => row.id)).not.toContain(id)
    })

    test('never another environment’s, and nothing outside a tenant scope', async () => {
      const id = await write(b, await endpoint(b), 'failed', old())
      expect((await sweep(a)).map((row) => row.id)).not.toContain(id)
      expect(
        await queryRows(testDb.db, sql`delete from tula.webhook_deliveries returning id`)
      ).toEqual([])
      expect(await attemptsOf(b, id)).toHaveLength(1)
    })

    test('removing an endpoint still removes its deliveries, pending and recent ones too', async () => {
      const at = await endpoint(a)
      const pending = await write(a, at, 'pending', new Date())
      const recent = await write(a, at, 'failed', new Date())
      await withTenant(testDb.db, a.environmentId, (tx) =>
        settle(tx.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, at)))
      )
      const left = await withTenant(testDb.db, a.environmentId, (tx) =>
        tx
          .select()
          .from(schema.webhookDeliveries)
          .where(eq(schema.webhookDeliveries.endpointId, at))
      )
      expect(left).toEqual([])
      expect(await attemptsOf(a, pending)).toEqual([])
      expect(await attemptsOf(a, recent)).toEqual([])
    })

    test('an attempt cannot be written for another environment’s delivery', async () => {
      const foreign = await write(b, await endpoint(b), 'failed', new Date())
      const insert = withTenant(testDb.db, a.environmentId, (tx) =>
        settle(
          tx.insert(schema.webhookDeliveryAttempts).values({
            id: Bun.randomUUIDv7(),
            projectId: a.projectId,
            environmentId: a.environmentId,
            deliveryId: foreign,
            attempt: 2,
            attemptedAt: new Date(),
            durationMs: 1,
          })
        )
      )
      expect(await failureReason(insert)).toMatch(/violates foreign key constraint/)
    })
  })

  describe('what the runtime role may delete from an environment’s audit log', () => {
    const DAY = 86_400_000
    const entry = (tenant: TestTenant, occurredAt: Date) => ({
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      actorType: 'system' as const,
      action: 'user.created',
      occurredAt,
    })
    const write = async (tenant: TestTenant, occurredAt: Date) => {
      const row = entry(tenant, occurredAt)
      await withTenant(testDb.db, tenant.environmentId, (tx) =>
        settle(tx.insert(schema.auditLogs).values(row))
      )
      return row.id
    }
    const exists = async (tenant: TestTenant, id: string) =>
      (
        await withTenant(testDb.db, tenant.environmentId, (tx) =>
          tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.id, id))
        )
      ).length === 1
    const old = () => new Date(Date.now() - 400 * DAY)

    test('an old entry of its own environment', async () => {
      const id = await write(a, old())
      const deleted = await withTenant(testDb.db, a.environmentId, (tx) =>
        tx.delete(schema.auditLogs).where(eq(schema.auditLogs.id, id)).returning()
      )
      expect(deleted).toHaveLength(1)
      expect(await exists(a, id)).toBe(false)
    })

    test('never another environment’s entry, however old', async () => {
      const id = await write(b, old())
      const deleted = await withTenant(testDb.db, a.environmentId, (tx) =>
        tx.delete(schema.auditLogs).returning()
      )
      expect(deleted.map((row) => row.id)).not.toContain(id)
      expect(await exists(b, id)).toBe(true)
    })

    test('nothing at all outside a tenant scope (fail closed)', async () => {
      const id = await write(a, old())
      const deleted = await queryRows(testDb.db, sql`delete from tula.audit_logs returning id`)
      expect(deleted).toEqual([])
      expect(await exists(a, id)).toBe(true)
    })

    test('never an entry of the last day: the shortest period that can be set is one day', async () => {
      const fresh = await write(a, new Date(Date.now() - DAY + 3_600_000))
      const justNow = await write(a, new Date())
      const past = await write(a, new Date(Date.now() - DAY - 3_600_000))
      const deleted = await withTenant(testDb.db, a.environmentId, (tx) =>
        tx
          .delete(schema.auditLogs)
          .where(eq(schema.auditLogs.environmentId, a.environmentId))
          .returning()
      )
      const ids = deleted.map((row) => row.id)
      expect(ids).toContain(past)
      expect(ids).not.toContain(fresh)
      expect(ids).not.toContain(justNow)
      expect(await exists(a, fresh)).toBe(true)
      expect(await exists(a, justNow)).toBe(true)
    })

    test('and it cannot backdate an entry to get past that floor', async () => {
      const id = await write(a, new Date())
      const backdate = withTenant(testDb.db, a.environmentId, (tx) =>
        settle(
          tx.update(schema.auditLogs).set({ occurredAt: old() }).where(eq(schema.auditLogs.id, id))
        )
      )
      expect(await failureReason(backdate)).toMatch(/permission denied/)
    })
  })

  test('tenant data can still be deleted through RLS (e.g. revoking sessions)', async () => {
    const deleted = await withTenant(testDb.db, b.environmentId, (tx) =>
      tx.delete(schema.sessions).where(eq(schema.sessions.id, sessionB)).returning()
    )
    expect(deleted).toHaveLength(1)
  })
})

describe('refresh-token pruning is by whole session (F6)', () => {
  async function sessionWithChain(tenant: TestTenant, tag: string) {
    return withTenant(testDb.db, tenant.environmentId, async (tx) => {
      const now = new Date()
      const [user] = await tx
        .insert(schema.users)
        .values({ ...tenant, email: `${tag}@x.test`, emailNormalized: `${tag}@x.test` })
        .returning()
      const [session] = await tx
        .insert(schema.sessions)
        .values({
          ...tenant,
          userId: user!.id,
          profile: 'web',
          client: 'web',
          lastActiveAt: now,
          idleExpiresAt: now,
        })
        .returning()
      const ids: string[] = []
      let parentId: string | null = null
      for (const hash of [`${tag}-1`, `${tag}-2`, `${tag}-3`]) {
        const inserted: { id: string }[] = await tx
          .insert(schema.refreshTokens)
          .values({ ...tenant, sessionId: session!.id, tokenHash: hash, parentId, expiresAt: now })
          .returning({ id: schema.refreshTokens.id })
        if (parentId) {
          await tx
            .update(schema.refreshTokens)
            .set({ replacedById: inserted[0]!.id, usedAt: now })
            .where(eq(schema.refreshTokens.id, parentId))
        }
        parentId = inserted[0]!.id
        ids.push(parentId)
      }
      return { sessionId: session!.id, tokenIds: ids }
    })
  }

  test('deleting a session removes its whole token chain', async () => {
    const { sessionId } = await sessionWithChain(a, 'chain')
    const remaining = await withTenant(testDb.db, a.environmentId, async (tx) => {
      await tx.delete(schema.sessions).where(eq(schema.sessions.id, sessionId))
      return tx
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.sessionId, sessionId))
    })
    expect(remaining).toEqual([])
  })

  test('deleting a single token out of a chain is rejected (prune sessions, not tokens)', async () => {
    const { tokenIds } = await sessionWithChain(a, 'partial')
    const partial = withTenant(testDb.db, a.environmentId, (tx) =>
      settle(tx.delete(schema.refreshTokens).where(eq(schema.refreshTokens.id, tokenIds[1]!)))
    )
    expect(await failureReason(partial)).toMatch(/violates foreign key constraint/)
  })
})

describe('every tenant table has exactly the isolation policy (F5)', () => {
  test('one permissive policy per RLS table, keyed on the tenant setting for reads and writes', async () => {
    await testDb.setRole('postgres')
    const rows = await queryRows<{ table: string; policies: number; tenantScoped: number }>(
      testDb.db,
      sql`
        select c.relname as table,
               count(p.policyname)::int as policies,
               (count(p.policyname) filter (
                 where p.qual like '%tula.environment_id%' and p.with_check like '%tula.environment_id%'
               ))::int as "tenantScoped"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'tula'
        left join pg_policies p on p.schemaname = 'tula' and p.tablename = c.relname
          and p.permissive = 'PERMISSIVE'
        where c.relkind = 'r' and c.relrowsecurity
        group by c.relname order by c.relname
      `
    )
    await testDb.setRole('tula_app')
    expect(rows.length).toBeGreaterThanOrEqual(10)
    expect(rows.filter((row) => row.policies !== 1 || row.tenantScoped !== 1)).toEqual([])
  })

  test('the only other policies narrow what the retention job may delete; none widens anything', async () => {
    await testDb.setRole('postgres')
    const rows = await queryRows<{
      table: string
      name: string
      command: string
      roles: string
      using: string
    }>(
      testDb.db,
      sql`
        select tablename as table, policyname as name, cmd as command, roles::text as roles,
               qual as using
        from pg_policies where schemaname = 'tula' and permissive <> 'PERMISSIVE'
        order by tablename
      `
    )
    await testDb.setRole('tula_app')
    // A restrictive policy is ANDed with the tenant policy: it can only take rows away.
    expect(rows).toEqual([
      {
        table: 'audit_logs',
        name: 'audit_logs_retention_floor',
        command: 'DELETE',
        roles: '{public}',
        using: expect.stringMatching(/occurred_at < \(now\(\) - '1 day'::interval\)/),
      },
      {
        table: 'events',
        name: 'events_retention_floor',
        command: 'DELETE',
        roles: '{public}',
        using: expect.stringMatching(
          /delivered_at IS NOT NULL.*occurred_at < \(now\(\) - '1 day'::interval\)/
        ),
      },
      {
        table: 'webhook_deliveries',
        name: 'webhook_deliveries_retention_floor',
        command: 'DELETE',
        roles: '{public}',
        using: expect.stringMatching(
          /state <> 'pending'.*created_at < \(now\(\) - '7 days'::interval\)/
        ),
      },
    ])
  })

  test('api_keys is the only table with environment_id and no RLS', async () => {
    await testDb.setRole('postgres')
    const rows = await queryRows<{ table: string }>(
      testDb.db,
      sql`
        select c.relname as table from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'tula'
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'environment_id'
        where c.relkind = 'r' and not c.relrowsecurity
      `
    )
    await testDb.setRole('tula_app')
    expect(rows).toEqual([{ table: 'api_keys' }])
  })
})
