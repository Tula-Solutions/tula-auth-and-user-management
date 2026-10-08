import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, getTableName, is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable)
)
const tenantTables = tables.filter((table) =>
  getTableConfig(table).columns.some((column) => column.name === 'environment_id')
)

describe('declared schema', () => {
  test('every table lives in the tula schema', () => {
    expect(tables.map((table) => getTableConfig(table).schema)).toEqual(tables.map(() => 'tula'))
  })

  test('every foreign key resolves to a real table', () => {
    for (const table of tables) {
      for (const fk of getTableConfig(table).foreignKeys) {
        const reference = fk.reference()
        expect(getTableName(reference.foreignTable)).toBeString()
        expect(reference.foreignColumns.length).toBe(reference.columns.length)
      }
    }
  })

  test.each(tenantTables.filter((table) => getTableName(table) !== 'api_keys').map(getTableName))(
    '%s has the composite environment/project FK and the isolation policy',
    (name) => {
      const table = tenantTables.find((candidate) => getTableName(candidate) === name)!
      const config = getTableConfig(table)
      const composite = config.foreignKeys.find(
        (fk) => fk.getName() === `${name}_environment_project_fk`
      )
      expect(composite?.reference().columns.map((column) => column.name)).toEqual([
        'environment_id',
        'project_id',
      ])
      // The audit log has one more, restrictive: it narrows what the retention job may delete.
      const extra = name === 'audit_logs' ? ['audit_logs_retention_floor'] : []
      expect(config.policies.map((policy) => policy.name)).toEqual([
        `${name}_tenant_isolation`,
        ...extra,
      ])
      expect(config.policies.filter((policy) => policy.as !== 'restrictive')).toHaveLength(1)
    }
  )
})

describe('api_keys', () => {
  let testDb: TestDatabase
  let a: TestTenant
  let b: TestTenant

  beforeAll(async () => {
    testDb = await createTestDatabase()
    a = await createTestTenant(testDb.db)
    b = await createTestTenant(testDb.db)
  })

  afterAll(() => testDb.close())

  const key = (projectId: string, environmentId: string) => ({
    projectId,
    environmentId,
    kind: 'secret' as const,
    name: 'Server',
    keyHash: Bun.randomUUIDv7(),
    lastFour: 'abcd',
  })

  test('declares the composite environment/project FK but no isolation policy', () => {
    const config = getTableConfig(schema.apiKeys)
    const composite = config.foreignKeys.find(
      (fk) => fk.getName() === 'api_keys_environment_project_fk'
    )
    expect(composite?.reference().columns.map((column) => column.name)).toEqual([
      'environment_id',
      'project_id',
    ])
    expect(composite?.onDelete).toBe('cascade')
    // Deliberately outside row-level security: resolving a key is what determines the tenant.
    expect(config.policies).toEqual([])
  })

  test('a key whose project does not own its environment is rejected (C5)', async () => {
    // Each id exists on its own, so only the composite key can refuse the pair.
    const mismatched = testDb.db.insert(schema.apiKeys).values(key(a.projectId, b.environmentId))
    const error = await Promise.resolve(mismatched).then(
      () => null,
      (thrown: unknown) => thrown
    )
    expect(String((error as { cause?: unknown } | null)?.cause ?? error)).toContain(
      'api_keys_environment_project_fk'
    )
    const stored = await testDb.db
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.environmentId, b.environmentId))
    expect(stored).toEqual([])
  })

  test('a key whose project owns its environment is stored', async () => {
    const [stored] = await testDb.db
      .insert(schema.apiKeys)
      .values(key(a.projectId, a.environmentId))
      .returning({ id: schema.apiKeys.id })
    expect(stored?.id).toBeString()
  })
})

describe('timestamps', () => {
  let testDb: TestDatabase
  let tenant: TestTenant

  beforeAll(async () => {
    testDb = await createTestDatabase()
    tenant = await createTestTenant(testDb.db)
  })

  afterAll(() => testDb.close())

  test('updated_at moves forward on update, created_at does not', async () => {
    await withTenant(testDb.db, tenant.environmentId, async (tx) => {
      const [user] = await tx
        .insert(schema.users)
        .values({ ...tenant, email: 't@t.test', emailNormalized: 't@t.test' })
        .returning()
      await Bun.sleep(5)
      const [updated] = await tx
        .update(schema.users)
        .set({ firstName: 'Maya' })
        .where(eq(schema.users.id, user!.id))
        .returning()
      expect(updated!.createdAt).toEqual(user!.createdAt)
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(user!.updatedAt.getTime())
    })
  })
})
