import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { backupCodes, userFactors, users, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  queryRows,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { eq, sql } from 'drizzle-orm'
import { describeFactorStore, type FactorSuiteTenant } from '~/adapters/factor-store.suite'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresFactorStore } from '~/adapters/postgres/factors'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type { NewBackupCode, NewFactor } from '~/ports/factor-store'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase
let a: TestTenant
let b: TestTenant
const now = new Date('2026-01-01T00:00:00.000Z')
const later = (ms: number) => new Date(now.getTime() + ms)

beforeAll(async () => {
  testDb = await createTestDatabase()
  a = await createTestTenant(testDb.db)
  b = await createTestTenant(testDb.db, 'production')
})

afterAll(() => testDb.close())

function suiteTenant(tenant: TestTenant): FactorSuiteTenant {
  const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
  return {
    ...scope,
    user: () =>
      withTenant(testDb.db, tenant.environmentId, async (tx) => {
        const id = Bun.randomUUIDv7()
        await tx.insert(users).values({
          id,
          ...scope,
          email: `${id}@northline.app`,
          emailNormalized: `${id}@northline.app`,
        })
        return id
      }),
  }
}

describeFactorStore('PostgresFactorStore', async () => ({
  store: new PostgresFactorStore(testDb.db),
  log: new PostgresActivityLog(testDb.db),
  a: suiteTenant(a),
  b: suiteTenant(b),
}))

describe('PostgresFactorStore', () => {
  const store = () => new PostgresFactorStore(testDb.db)

  const codes = (count: number): NewBackupCode[] =>
    Array.from({ length: count }, () => ({
      id: Bun.randomUUIDv7(),
      codeHash: `hash-${Bun.randomUUIDv7()}`,
    }))

  function activity(userId: string, overrides: Partial<Activity> = {}): Activity {
    return {
      id: Bun.randomUUIDv7(),
      projectId: a.projectId,
      environmentId: a.environmentId,
      type: 'user.mfa_enabled',
      actor: { type: 'user', id: userId },
      target: { type: 'user', id: userId },
      ipAddress: '203.0.113.7',
      userAgent: 'suite/1.0',
      data: { method: 'totp' },
      occurredAt: now,
      ...overrides,
    }
  }

  async function started() {
    const userId = await suiteTenant(a).user()
    const factor: NewFactor = {
      id: Bun.randomUUIDv7(),
      projectId: a.projectId,
      environmentId: a.environmentId,
      userId,
      type: 'totp',
      secret: `sealed-${userId}`,
      createdAt: now,
      expiresAt: later(600_000),
    }
    expect(await store().startTotp(factor)).toBe(true)
    return { userId, factor }
  }

  async function confirmed() {
    const { userId, factor } = await started()
    const backup = codes(3)
    expect(
      await store().confirmTotp(a.environmentId, factor.id, {
        activity: Audit.none('fixture'),
        step: 100,
        at: later(1_000),
        backupCodes: backup,
      })
    ).toBe(true)
    return { userId, factor, backup }
  }

  /** Audit entries and outbox events about one user, read as the owner across tenants. */
  async function onRecord(userId: string) {
    await testDb.setRole('postgres')
    try {
      const audit = await queryRows<{ action: string; id: string }>(
        testDb.db,
        sql`select id, action from tula.audit_logs where target_id = ${userId}`
      )
      const outbox = await queryRows<{ type: string; id: string }>(
        testDb.db,
        sql`select id, type from tula.events where payload->'target'->>'id' = ${userId}`
      )
      return { audit, outbox }
    } finally {
      await testDb.setRole('tula_app')
    }
  }

  /** Rows of one user in both tables, read as the owner across tenants. */
  async function rowsOf(userId: string) {
    await testDb.setRole('postgres')
    try {
      const [factors] = await queryRows<{ count: number }>(
        testDb.db,
        sql`select count(*)::int as count from tula.user_factors where user_id = ${userId}`
      )
      const [stored] = await queryRows<{ count: number }>(
        testDb.db,
        sql`select count(*)::int as count from tula.backup_codes where user_id = ${userId}`
      )
      return { factors: factors?.count ?? -1, codes: stored?.count ?? -1 }
    } finally {
      await testDb.setRole('tula_app')
    }
  }

  // An `inet` column rejects this, which makes the activity insert fail after the real write.
  const BROKEN = { ipAddress: 'not-an-ip' }

  describe('a change and its audit entry are one transaction', () => {
    test('confirming writes the audit entry and the outbox event with the factor', async () => {
      const { userId, factor } = await started()
      const entry = activity(userId)
      expect(
        await store().confirmTotp(a.environmentId, factor.id, {
          step: 7,
          at: later(1_000),
          backupCodes: codes(10),
          activity: entry,
        })
      ).toBe(true)
      expect(await onRecord(userId)).toEqual({
        audit: [{ id: entry.id, action: 'user.mfa_enabled' }],
        outbox: [{ id: entry.id, type: 'user.mfa_enabled' }],
      })
      expect(await rowsOf(userId)).toEqual({ factors: 1, codes: 10 })
    })

    test('a confirmation whose audit entry cannot be written confirms nothing and stores no codes', async () => {
      const { userId, factor } = await started()
      await expect(
        store().confirmTotp(a.environmentId, factor.id, {
          step: 7,
          at: later(1_000),
          backupCodes: codes(10),
          activity: activity(userId, BROKEN),
        })
      ).rejects.toThrow()
      expect(await store().findTotp(a.environmentId, userId)).toMatchObject({
        confirmedAt: null,
        lastUsedStep: null,
        expiresAt: later(600_000),
      })
      expect(await rowsOf(userId)).toEqual({ factors: 1, codes: 0 })
      expect(await onRecord(userId)).toEqual({ audit: [], outbox: [] })
    })

    test('a removal whose audit entry cannot be written removes nothing', async () => {
      const { userId } = await confirmed()
      await expect(
        store().removeForUser(
          a.environmentId,
          userId,
          activity(userId, { ...BROKEN, type: 'user.mfa_disabled' })
        )
      ).rejects.toThrow()
      expect(await rowsOf(userId)).toEqual({ factors: 1, codes: 3 })
      expect(await onRecord(userId)).toEqual({ audit: [], outbox: [] })
    })

    test('a replacement whose audit entry cannot be written keeps the earlier codes', async () => {
      const { userId, backup } = await confirmed()
      await expect(
        store().replaceBackupCodes(
          a.environmentId,
          userId,
          { projectId: a.projectId },
          codes(10),
          later(2_000),
          activity(userId, { ...BROKEN, type: 'user.backup_codes_regenerated' })
        )
      ).rejects.toThrow()
      expect(await rowsOf(userId)).toEqual({ factors: 1, codes: 3 })
      expect(
        await store().consumeBackupCode(
          a.environmentId,
          userId,
          backup[0]?.codeHash as string,
          later(3_000),
          Audit.none('fixture')
        )
      ).toBe(2)
    })

    test('a backup code whose audit entry cannot be written is not spent', async () => {
      const { userId, backup } = await confirmed()
      const hash = backup[0]?.codeHash as string
      await expect(
        store().consumeBackupCode(
          a.environmentId,
          userId,
          hash,
          later(2_000),
          activity(userId, { ...BROKEN, type: 'user.backup_code_used' })
        )
      ).rejects.toThrow()
      expect(await store().countBackupCodes(a.environmentId, userId)).toBe(3)
      const entry = activity(userId, { type: 'user.backup_code_used' })
      expect(
        await store().consumeBackupCode(a.environmentId, userId, hash, later(3_000), entry)
      ).toBe(2)
      expect((await onRecord(userId)).audit).toEqual([
        { id: entry.id, action: 'user.backup_code_used' },
      ])
    })
  })

  test('deleting a user removes their factor and their backup codes', async () => {
    const { userId } = await confirmed()
    const kept = await confirmed()
    expect(await rowsOf(userId)).toEqual({ factors: 1, codes: 3 })
    await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.delete(users).where(eq(users.id, userId))
    )
    expect(await rowsOf(userId)).toEqual({ factors: 0, codes: 0 })
    expect(await rowsOf(kept.userId)).toEqual({ factors: 1, codes: 3 })
  })

  test('the rows hold what the store was given and nothing else about the secret', async () => {
    const { userId, factor, backup } = await confirmed()
    const [row] = await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.select().from(userFactors).where(eq(userFactors.userId, userId))
    )
    expect(row).toMatchObject({
      id: factor.id,
      projectId: a.projectId,
      environmentId: a.environmentId,
      type: 'totp',
      secret: factor.secret,
      name: null,
      confirmedAt: later(1_000),
      expiresAt: null,
      lastUsedStep: 100,
      updatedAt: later(1_000),
    })
    const stored = await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.select().from(backupCodes).where(eq(backupCodes.userId, userId))
    )
    expect(stored.map((code) => code.codeHash).sort()).toEqual(
      backup.map((code) => code.codeHash).sort()
    )
    for (const code of stored) {
      expect(code).toMatchObject({
        projectId: a.projectId,
        environmentId: a.environmentId,
        usedAt: null,
        createdAt: later(1_000),
      })
    }
  })

  test('a time step past 32 bits is stored exactly', async () => {
    // 20,000,000,000 seconds (RFC 6238's last vector) is step 666,666,666; a bigint column
    // must not lose anything well beyond that.
    const { userId, factor } = await confirmed()
    const step = 2 ** 40 + 1
    expect(await store().useTotpStep(a.environmentId, factor.id, step, later(2_000))).toBe(true)
    expect((await store().findTotp(a.environmentId, userId))?.lastUsedStep).toBe(step)
    expect(await store().useTotpStep(a.environmentId, factor.id, step, later(2_000))).toBe(false)
  })

  test('without a tenant scope the runtime role sees no factor and no code', async () => {
    const { userId } = await confirmed()
    expect(
      await testDb.db.select().from(userFactors).where(eq(userFactors.userId, userId))
    ).toEqual([])
    expect(
      await testDb.db.select().from(backupCodes).where(eq(backupCodes.userId, userId))
    ).toEqual([])
    // Inside the other tenant's scope they are hidden too, whatever the query filters by.
    expect(
      await withTenant(testDb.db, b.environmentId, (tx) =>
        tx.select().from(userFactors).where(eq(userFactors.userId, userId))
      )
    ).toEqual([])
  })
})
