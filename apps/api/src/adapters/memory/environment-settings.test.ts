import { describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import { describeEnvironmentSettingsStore } from '~/adapters/environment-settings-store.suite'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryEnvironmentSettingsStore } from '~/adapters/memory/environment-settings'
import * as logger from '~/lib/logger'

describeEnvironmentSettingsStore('MemoryEnvironmentSettingsStore', async () => {
  const log = new MemoryActivityLog()
  const store = new MemoryEnvironmentSettingsStore(log)
  return {
    store,
    log,
    storeManager: async (tenant, manager) => store.seedManager(tenant.environmentId, manager),
    storeDocument: async (tenant, settings) =>
      store.seedStored(tenant.environmentId, { revision: 1, settings }),
    freshTenant: async () => ({
      projectId: '00000000-0000-7000-8000-00000000a001',
      environmentId: Bun.randomUUIDv7(),
    }),
  }
})

test('a seeded document is kept apart from what was seeded and from what callers read', async () => {
  const store = new MemoryEnvironmentSettingsStore()
  const seeded = { revision: 4, settings: structuredClone(DEFAULT_ENVIRONMENT_SETTINGS) }
  store.seed('e1', seeded)
  seeded.settings.app.name = 'Changed after seeding'
  const read = await store.get('e1')
  expect(read).toEqual({ revision: 4, settings: DEFAULT_ENVIRONMENT_SETTINGS })
  if (read) {
    read.settings.app.name = 'Changed after reading'
  }
  expect((await store.get('e1'))?.settings.app.name).toBe(DEFAULT_ENVIRONMENT_SETTINGS.app.name)
})

test('`seed` takes a settings document and nothing else: a misspelled key does not compile', async () => {
  const store = new MemoryEnvironmentSettingsStore()
  // The tolerant read drops a key it does not know, so a misspelled section seeded through an
  // untyped `seed` would be lost in silence and its test would pass for the wrong reason. The
  // compiler is what catches it: this line fails the typecheck if `seed` is loosened again.
  store.seed('e1', {
    revision: 1,
    // @ts-expect-error `audt` is no section of the settings: a free-form document goes through `seedStored`.
    settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, audt: { retentionDays: 30 } },
  })
  expect((await store.get('e1'))?.settings).toEqual(DEFAULT_ENVIRONMENT_SETTINGS)
})

test('a stored document is kept as a JSON column would keep it', async () => {
  const store = new MemoryEnvironmentSettingsStore()
  // `NaN` is `null` in JSON, and `null` is no audit period; a key that is `undefined` is gone.
  store.seedStored('e1', {
    revision: 1,
    settings: {
      audit: { retentionDays: Number.NaN },
      app: { name: 'Acme', supportEmail: undefined },
    },
  })
  expect((await store.get('e1'))?.settings).toEqual({
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    app: { name: 'Acme', supportEmail: null },
  })
})

describe('seedUnread, the one way past the tolerant read', () => {
  // A wording no save and no read of a real store lets through: `seedStored` loses it, as
  // Postgres would, and only `seedUnread` hands it on, for a test of the renderer's own
  // fallback.
  const unusable = {
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    emails: { templates: { step_up: { body: 'no code here' } } },
  }

  test('`seedStored` reads the document as a real store would', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const store = new MemoryEnvironmentSettingsStore()
      store.seedStored('e1', { revision: 1, settings: unusable })
      expect((await store.get('e1'))?.settings.emails).toEqual({ templates: {} })
    } finally {
      warn.mockRestore()
    }
  })

  test('`seedUnread` hands the same document on as it is, as a copy', async () => {
    const store = new MemoryEnvironmentSettingsStore()
    store.seedUnread('e1', { revision: 1, settings: unusable })
    const read = await store.get('e1')
    expect(read).toEqual({ revision: 1, settings: unusable })
    if (read) {
      read.settings.app.name = 'Changed after reading'
    }
    expect((await store.get('e1'))?.settings.app.name).toBe(DEFAULT_ENVIRONMENT_SETTINGS.app.name)
    // Its origins are listed, and a manager's record is still read by the one rule.
    expect(await store.allowedOrigins()).toEqual(DEFAULT_ENVIRONMENT_SETTINGS.urls.allowedOrigins)
    store.seedManager('e1', 'not a record')
    expect((await store.get('e1'))?.managedBy).toBeUndefined()
  })

  test('a replace over it is read like any other document again', async () => {
    const log = new MemoryActivityLog()
    const store = new MemoryEnvironmentSettingsStore(log)
    store.seedUnread('e1', { revision: 1, settings: unusable })
    const at = new Date('2026-01-01T00:00:00.000Z')
    const saved = await store.replace('e1', 1, DEFAULT_ENVIRONMENT_SETTINGS, at, {
      id: Bun.randomUUIDv7(),
      projectId: 'p1',
      environmentId: 'e1',
      type: 'environment.settings_updated',
      actor: { type: 'admin', id: 'key_1' },
      target: { type: 'environment', id: 'e1' },
      ipAddress: null,
      userAgent: null,
      data: { revision: 2, changed: ['emails.templates.step_up.body'] },
      occurredAt: at,
    })
    expect(saved).toEqual({ revision: 2, settings: DEFAULT_ENVIRONMENT_SETTINGS })
    store.seedManager('e1', undefined)
    expect(await store.get('e1')).toEqual(saved)
  })
})
