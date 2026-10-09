import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import { environmentSettings, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  queryRows,
  type TestDatabase,
} from '@tula/db/testing'
import { eq, sql } from 'drizzle-orm'
import { describeEnvironmentSettingsStore } from '~/adapters/environment-settings-store.suite'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresEnvironmentSettingsStore } from '~/adapters/postgres/environment-settings'
import * as logger from '~/lib/logger'
import type { Activity } from '~/ports/activity-log'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

const freshTenant = () => createTestTenant(testDb.db)

describeEnvironmentSettingsStore('PostgresEnvironmentSettingsStore', async () => ({
  store: new PostgresEnvironmentSettingsStore(testDb.db),
  log: new PostgresActivityLog(testDb.db),
  freshTenant,
  storeManager: async (tenant, manager) => {
    await withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx
        .update(environmentSettings)
        .set({ managedBy: manager as Record<string, unknown> })
        .where(eq(environmentSettings.environmentId, tenant.environmentId))
    )
  },
}))

describe('PostgresEnvironmentSettingsStore', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')

  function activity(tenant: { projectId: string; environmentId: string }): Activity {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      type: 'environment.settings_updated',
      actor: { type: 'admin', id: 'key_1' },
      target: { type: 'environment', id: tenant.environmentId },
      ipAddress: null,
      userAgent: null,
      data: { revision: 1, changed: ['app.name'] },
      occurredAt: now,
    }
  }

  async function storeRaw(settings: Record<string, unknown>) {
    const tenant = await freshTenant()
    await withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.insert(environmentSettings).values({
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        settings,
      })
    )
    return tenant
  }

  test('a document stored by another version reads back with today’s defaults filled in', async () => {
    const tenant = await storeRaw({
      app: { name: 'Acme', logoUrl: 'https://acme.test/logo.png' },
      futureSection: { enabled: true },
    })
    expect(await new PostgresEnvironmentSettingsStore(testDb.db).get(tenant.environmentId)).toEqual(
      {
        revision: 1,
        settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, app: { name: 'Acme', supportEmail: null } },
      }
    )
  })

  test('a document stored before two-step verification existed reads as `optional`, with its notice on', async () => {
    const { mfa: _mfa, notifications, ...before } = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
    const tenant = await storeRaw({
      ...before,
      notifications: { passwordChanged: false, newSignIn: notifications.newSignIn },
    })
    const read = await new PostgresEnvironmentSettingsStore(testDb.db).get(tenant.environmentId)
    expect(read?.settings.mfa).toEqual({ policy: 'optional' })
    expect(read?.settings.notifications).toEqual({
      passwordChanged: false,
      newSignIn: true,
      mfaChanged: true,
      identityChanged: true,
    })
  })

  test('a stored MFA policy is read back, and a key another version added under it is dropped', async () => {
    const tenant = await storeRaw({ mfa: { policy: 'required', methods: ['sms'] } })
    expect(
      (await new PostgresEnvironmentSettingsStore(testDb.db).get(tenant.environmentId))?.settings
        .mfa
    ).toEqual({ policy: 'required' })
  })

  test('the origin list survives documents of any shape', async () => {
    await storeRaw({ urls: { allowedOrigins: ['https://odd-shape.test', 7, null] } })
    await storeRaw({ urls: { allowedOrigins: 'https://not-a-list.test' } })
    await storeRaw({ urls: null })
    const origins = await new PostgresEnvironmentSettingsStore(testDb.db).allowedOrigins()
    expect(origins).toContain('https://odd-shape.test')
    expect(origins).not.toContain('https://not-a-list.test')
    expect(origins.every((origin) => typeof origin === 'string')).toBe(true)
  })

  test('a stored row holding an origin settings would refuse still reads, minus that entry', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const tenant = await storeRaw({
      app: { name: 'Acme' },
      urls: { allowedOrigins: ['http://app.lan', 'https://app.acme.test'] },
    })
    const store = new PostgresEnvironmentSettingsStore(testDb.db)
    expect(await store.get(tenant.environmentId)).toEqual({
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        app: { name: 'Acme', supportEmail: null },
        urls: { allowedOrigins: ['https://app.acme.test'], allowedRedirectUrls: [] },
      },
    })
    // Said once per read, with the environment and a count, never the entry itself.
    expect(warn.mock.calls).toEqual([
      [
        'stored environment settings held list entries that are not valid; they were ignored',
        { environmentId: tenant.environmentId, dropped: 1 },
      ],
    ])
    // The union for preflights leaves the entry out as well.
    expect(await store.allowedOrigins()).not.toContain('http://app.lan')
    expect(await store.allowedOrigins()).toContain('https://app.acme.test')
    warn.mockRestore()
  })

  test('a stored email template this version cannot use is left out, and said by kind', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const canary = 'canary-wording-2a6c'
    const tenant = await storeRaw({
      emails: {
        templates: {
          step_up: { subject: `${canary} kept`, body: '{{code}}' },
          // A placeholder a later version had, a notice with a link, and a kind not known here.
          password_reset: { body: `${canary} {{code}} {{firstName}}` },
          new_sign_in: { body: `${canary} https://evil.test` },
          later_kind: { body: canary },
        },
      },
    })
    const stored = await new PostgresEnvironmentSettingsStore(testDb.db).get(tenant.environmentId)
    expect(stored?.settings.emails).toEqual({
      templates: { step_up: { subject: `${canary} kept`, body: '{{code}}' } },
    })
    expect(warn.mock.calls).toEqual([
      [
        'stored email templates this version cannot use were ignored; the built-in copy is sent',
        {
          environmentId: tenant.environmentId,
          kinds: ['password_reset', 'new_sign_in'],
          unknownKinds: 1,
        },
      ],
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary)
    warn.mockRestore()
  })

  test('reading the origins of every environment leaves no tenant scope behind', async () => {
    await new PostgresEnvironmentSettingsStore(testDb.db).allowedOrigins()
    const [row] = await queryRows<{ value: string | null }>(
      testDb.db,
      sql`select current_setting('tula.environment_id', true) as value`
    )
    expect(row?.value ?? '').toBe('')
    // And outside a tenant scope the table still shows nothing.
    expect(await testDb.db.select().from(environmentSettings)).toEqual([])
  })

  test('a failed audit insert rolls the settings change back', async () => {
    const tenant = await freshTenant()
    const store = new PostgresEnvironmentSettingsStore(testDb.db)
    const bad = { ...activity(tenant), ipAddress: 'not-an-ip' }
    const attempt = store.replace(tenant.environmentId, 0, DEFAULT_ENVIRONMENT_SETTINGS, now, bad)
    await expect(attempt).rejects.toThrow()
    expect(await store.get(tenant.environmentId)).toBeNull()
  })

  test('the runtime role cannot delete settings', async () => {
    const tenant = await storeRaw({})
    const attempt = withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.delete(environmentSettings)
    )
    await expect(attempt).rejects.toThrow()
  })

  test('a row cannot be written for another environment', async () => {
    const [mine, theirs] = [await freshTenant(), await freshTenant()]
    const attempt = withTenant(testDb.db, mine.environmentId, (tx) =>
      tx.insert(environmentSettings).values({
        projectId: theirs.projectId,
        environmentId: theirs.environmentId,
        settings: {},
      })
    )
    await expect(attempt).rejects.toThrow()
  })
})
