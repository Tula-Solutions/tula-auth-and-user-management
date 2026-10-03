import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
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

async function insertUser(tenant: TestTenant, email: string) {
  return withTenant(testDb.db, tenant.environmentId, async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({ ...tenant, email, emailNormalized: email })
      .returning()
    return user!
  })
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  a = await createTestTenant(testDb.db)
  b = await createTestTenant(testDb.db)
  await insertUser(a, 'maya@a.test')
  await insertUser(b, 'maya@b.test')
})

afterAll(() => testDb.close())

describe('row-level security guardrail', () => {
  test('every tula table with environment_id has RLS enabled AND forced, except api_keys', async () => {
    await testDb.setRole('postgres')
    const rows = await queryRows<{ table: string; enabled: boolean; forced: boolean }>(
      testDb.db,
      sql`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'tula' and c.relkind = 'r'
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'environment_id' and not a.attisdropped
        )
      order by c.relname
    `
    )
    await testDb.setRole('tula_app')
    // api_keys is the documented exception: resolving a key is what determines the tenant.
    const tenantTables = rows.filter((row) => row.table !== 'api_keys')
    expect(tenantTables.length).toBeGreaterThanOrEqual(10)
    expect(
      tenantTables.filter((row) => !row.enabled || !row.forced).map((row) => row.table)
    ).toEqual([])
  })
})

describe('tenant isolation (as the tula_app runtime role)', () => {
  test('an environment only sees its own rows', async () => {
    const emails = await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.select({ email: schema.users.email }).from(schema.users)
    )
    expect(emails).toEqual([{ email: 'maya@a.test' }])
  })

  test('outside withTenant nothing is visible (fails closed)', async () => {
    expect(await testDb.db.select().from(schema.users)).toEqual([])
  })

  test('cannot insert a row into another environment', async () => {
    const attempt = withTenant(testDb.db, a.environmentId, (tx) =>
      tx.insert(schema.users).values({ ...b, email: 'x@b.test', emailNormalized: 'x@b.test' })
    )
    await expect(attempt).rejects.toThrow()
  })

  test('cannot update or delete another environment’s rows', async () => {
    const updated = await withTenant(testDb.db, a.environmentId, (tx) =>
      tx
        .update(schema.users)
        .set({ firstName: 'Hacked' })
        .where(eq(schema.users.emailNormalized, 'maya@b.test'))
        .returning()
    )
    const deleted = await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.delete(schema.users).where(eq(schema.users.emailNormalized, 'maya@b.test')).returning()
    )
    expect(updated).toEqual([])
    expect(deleted).toEqual([])
    const stillThere = await withTenant(testDb.db, b.environmentId, (tx) =>
      tx.select({ firstName: schema.users.firstName }).from(schema.users)
    )
    expect(stillThere).toEqual([{ firstName: null }])
  })

  test('cannot move a row to another environment by updating environment_id', async () => {
    const attempt = withTenant(testDb.db, a.environmentId, (tx) =>
      tx.update(schema.users).set({ environmentId: b.environmentId, projectId: b.projectId })
    )
    await expect(attempt).rejects.toThrow()
  })

  test('the tenant setting does not outlive the transaction', async () => {
    await withTenant(testDb.db, a.environmentId, async () => undefined)
    const [row] = await queryRows<{ value: string | null }>(
      testDb.db,
      sql`select current_setting('tula.environment_id', true) as value`
    )
    expect(row?.value ?? '').toBe('')
  })

  test('the runtime role cannot read the migration history', async () => {
    await expect(
      (async () => await testDb.db.execute(sql`select * from drizzle.__drizzle_migrations`))()
    ).rejects.toThrow()
  })
})

describe('second factors and backup codes (as the tula_app runtime role)', () => {
  // Tenants of its own, so the tests above see exactly the rows they made.
  let a: TestTenant
  let b: TestTenant

  beforeAll(async () => {
    a = await createTestTenant(testDb.db)
    b = await createTestTenant(testDb.db)
  })

  const factorsOf = (tenant: TestTenant) =>
    withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.select({ secret: schema.userFactors.secret }).from(schema.userFactors)
    )
  const codesOf = (tenant: TestTenant) =>
    withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.select({ codeHash: schema.backupCodes.codeHash }).from(schema.backupCodes)
    )

  /** A user with a factor and one backup code, in `tenant`. */
  async function enrolled(tenant: TestTenant, label: string) {
    const user = await insertUser(tenant, `${label}-${Bun.randomUUIDv7()}@mfa.test`)
    const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
    await withTenant(testDb.db, tenant.environmentId, async (tx) => {
      await tx
        .insert(schema.userFactors)
        .values({ ...scope, userId: user.id, type: 'totp', secret: `sealed-${label}` })
      await tx
        .insert(schema.backupCodes)
        .values({ ...scope, userId: user.id, codeHash: `hash-${label}` })
    })
    return user
  }

  test('an environment sees only its own factors and backup codes, and nothing outside a scope', async () => {
    await enrolled(a, 'seen-a')
    await enrolled(b, 'seen-b')
    expect((await factorsOf(a)).map((row) => row.secret)).toContain('sealed-seen-a')
    expect((await factorsOf(a)).map((row) => row.secret)).not.toContain('sealed-seen-b')
    expect((await codesOf(b)).map((row) => row.codeHash)).toContain('hash-seen-b')
    expect((await codesOf(b)).map((row) => row.codeHash)).not.toContain('hash-seen-a')
    expect(await testDb.db.select().from(schema.userFactors)).toEqual([])
    expect(await testDb.db.select().from(schema.backupCodes)).toEqual([])
  })

  test('cannot write a factor or a backup code into another environment', async () => {
    const theirs = await enrolled(b, 'write-b')
    const foreign = { projectId: b.projectId, environmentId: b.environmentId, userId: theirs.id }
    await expect(
      withTenant(testDb.db, a.environmentId, (tx) =>
        tx.insert(schema.backupCodes).values({ ...foreign, codeHash: 'hash-planted' })
      )
    ).rejects.toThrow()
    // Nor for a user of another environment under this one's ids: the user is not there.
    await expect(
      withTenant(testDb.db, a.environmentId, (tx) =>
        tx.insert(schema.userFactors).values({
          projectId: a.projectId,
          environmentId: a.environmentId,
          userId: theirs.id,
          type: 'totp',
          secret: 'sealed-planted',
        })
      )
    ).rejects.toThrow()
    expect((await codesOf(b)).map((row) => row.codeHash)).not.toContain('hash-planted')
  })

  test('cannot read, change or delete another environment’s factors and backup codes', async () => {
    const theirs = await enrolled(b, 'touch-b')
    const touched = await withTenant(testDb.db, a.environmentId, async (tx) => ({
      factors: await tx
        .update(schema.userFactors)
        .set({ confirmedAt: new Date(), lastUsedStep: 0 })
        .where(eq(schema.userFactors.userId, theirs.id))
        .returning(),
      codes: await tx
        .update(schema.backupCodes)
        .set({ usedAt: new Date() })
        .where(eq(schema.backupCodes.userId, theirs.id))
        .returning(),
      deletedFactors: await tx
        .delete(schema.userFactors)
        .where(eq(schema.userFactors.userId, theirs.id))
        .returning(),
      deletedCodes: await tx
        .delete(schema.backupCodes)
        .where(eq(schema.backupCodes.userId, theirs.id))
        .returning(),
    }))
    expect(touched).toEqual({ factors: [], codes: [], deletedFactors: [], deletedCodes: [] })
    const [factor] = await withTenant(testDb.db, b.environmentId, (tx) =>
      tx.select().from(schema.userFactors).where(eq(schema.userFactors.userId, theirs.id))
    )
    expect(factor).toMatchObject({
      confirmedAt: null,
      lastUsedStep: null,
      secret: 'sealed-touch-b',
    })
    const [code] = await withTenant(testDb.db, b.environmentId, (tx) =>
      tx.select().from(schema.backupCodes).where(eq(schema.backupCodes.userId, theirs.id))
    )
    expect(code).toMatchObject({ usedAt: null })
  })

  test('the runtime role may delete its own environment’s factors and backup codes', async () => {
    const mine = await enrolled(a, 'delete-a')
    const deleted = await withTenant(testDb.db, a.environmentId, async (tx) => ({
      codes: await tx
        .delete(schema.backupCodes)
        .where(eq(schema.backupCodes.userId, mine.id))
        .returning({ codeHash: schema.backupCodes.codeHash }),
      factors: await tx
        .delete(schema.userFactors)
        .where(eq(schema.userFactors.userId, mine.id))
        .returning({ secret: schema.userFactors.secret }),
    }))
    expect(deleted).toEqual({
      codes: [{ codeHash: 'hash-delete-a' }],
      factors: [{ secret: 'sealed-delete-a' }],
    })
  })

  test('a user has one factor of a type, and a code hash once', async () => {
    const mine = await enrolled(a, 'unique-a')
    const scope = { projectId: a.projectId, environmentId: a.environmentId, userId: mine.id }
    await expect(
      withTenant(testDb.db, a.environmentId, (tx) =>
        tx.insert(schema.userFactors).values({ ...scope, type: 'totp', secret: 'sealed-second' })
      )
    ).rejects.toThrow()
    await expect(
      withTenant(testDb.db, a.environmentId, (tx) =>
        tx.insert(schema.backupCodes).values({ ...scope, codeHash: 'hash-unique-a' })
      )
    ).rejects.toThrow()
  })

  test('deleting a user removes their factor and their backup codes', async () => {
    const mine = await enrolled(a, 'cascade-a')
    await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.delete(schema.users).where(eq(schema.users.id, mine.id))
    )
    expect((await factorsOf(a)).map((row) => row.secret)).not.toContain('sealed-cascade-a')
    expect((await codesOf(a)).map((row) => row.codeHash)).not.toContain('hash-cascade-a')
  })
})
