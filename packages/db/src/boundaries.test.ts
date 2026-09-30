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
    'delete from tula.audit_logs',
    'delete from tula.events',
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
  test('one policy per RLS table, keyed on the tenant setting for reads and writes', async () => {
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
        where c.relkind = 'r' and c.relrowsecurity
        group by c.relname order by c.relname
      `
    )
    await testDb.setRole('tula_app')
    expect(rows.length).toBeGreaterThanOrEqual(10)
    expect(rows.filter((row) => row.policies !== 1 || row.tenantScoped !== 1)).toEqual([])
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
