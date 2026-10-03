import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDatabase } from './client'
import * as schema from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

let testDb: TestDatabase
let tenant: TestTenant
let other: TestTenant

// Drizzle builders are thenables, not Promises; `expect().rejects` needs a real Promise.
async function settle<T>(query: PromiseLike<T>): Promise<T> {
  return await query
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  tenant = await createTestTenant(testDb.db)
  other = await createTestTenant(testDb.db)
})

afterAll(() => testDb.close())

describe('schema integrity', () => {
  test('ids are UUID v7 and timestamps are set by default', async () => {
    const [workspace] = await testDb.db.insert(schema.workspaces).values({ name: 'W' }).returning()
    expect(workspace!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(workspace!.createdAt).toBeInstanceOf(Date)
  })

  test('a row cannot pair an environment with a different project', async () => {
    const attempt = withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.insert(schema.users).values({
        environmentId: tenant.environmentId,
        projectId: other.projectId,
        email: 'mix@t.test',
        emailNormalized: 'mix@t.test',
      })
    )
    await expect(attempt).rejects.toThrow()
  })

  test('email is unique per environment, but the same email can exist in another environment', async () => {
    const add = (t: TestTenant) =>
      withTenant(testDb.db, t.environmentId, (tx) =>
        tx
          .insert(schema.users)
          .values({ ...t, email: 'Same@x.test', emailNormalized: 'same@x.test' })
      )
    await add(tenant)
    await add(other)
    await expect(add(tenant)).rejects.toThrow()
  })

  test('one environment per kind per project', async () => {
    await expect(
      settle(
        testDb.db
          .insert(schema.environments)
          .values({ projectId: tenant.projectId, kind: 'development' })
      )
    ).rejects.toThrow()
  })

  test('deleting an environment cascades to its tenant data', async () => {
    const doomed = await createTestTenant(testDb.db)
    await withTenant(testDb.db, doomed.environmentId, (tx) =>
      tx.insert(schema.users).values({ ...doomed, email: 'd@t.test', emailNormalized: 'd@t.test' })
    )
    // Deleting control-plane rows is owner-only: the runtime role has no DELETE there (0003).
    await testDb.setRole('postgres')
    await testDb.db
      .delete(schema.environments)
      .where(eq(schema.environments.id, doomed.environmentId))
    const orphans = await testDb.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.environmentId, doomed.environmentId))
    await testDb.setRole('tula_app')
    expect(orphans).toEqual([])
  })

  test('api keys are resolvable without a tenant (key lookup determines the tenant)', async () => {
    await testDb.db.insert(schema.apiKeys).values({
      ...tenant,
      kind: 'publishable',
      name: 'Default',
      keyHash: 'hash-1',
      lastFour: '8f2a',
    })
    const found = await testDb.db.query.apiKeys.findFirst({
      where: eq(schema.apiKeys.keyHash, 'hash-1'),
    })
    expect(found?.environmentId).toBe(tenant.environmentId)
  })

  test('refresh tokens chain parent → child within a session', async () => {
    await withTenant(testDb.db, tenant.environmentId, async (tx) => {
      const [user] = await tx
        .insert(schema.users)
        .values({ ...tenant, email: 'r@t.test', emailNormalized: 'r@t.test' })
        .returning()
      const now = new Date()
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
      const [parent] = await tx
        .insert(schema.refreshTokens)
        .values({ ...tenant, sessionId: session!.id, tokenHash: 'p', expiresAt: now })
        .returning()
      const [child] = await tx
        .insert(schema.refreshTokens)
        .values({
          ...tenant,
          sessionId: session!.id,
          tokenHash: 'c',
          parentId: parent!.id,
          expiresAt: now,
        })
        .returning()
      expect(child!.parentId).toBe(parent!.id)
      await expect(
        settle(
          tx
            .insert(schema.refreshTokens)
            .values({ ...tenant, sessionId: session!.id, tokenHash: 'p', expiresAt: now })
        )
      ).rejects.toThrow()
    })
  })
})

describe('createDatabase', () => {
  test('builds a pooled client lazily and closes cleanly', async () => {
    const handle = createDatabase('postgres://nobody@127.0.0.1:1/none', { max: 1 })
    expect(typeof handle.db.select).toBe('function')
    // The advisory lock takes its own connection from the same pool: nothing listens here.
    await expect(handle.withAdvisoryLock([1, 1], async () => 'unreachable')).rejects.toThrow()
    await handle.close()
  })
})
