import { expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import { describeEnvironmentSettingsStore } from '~/adapters/environment-settings-store.suite'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryEnvironmentSettingsStore } from '~/adapters/memory/environment-settings'

describeEnvironmentSettingsStore('MemoryEnvironmentSettingsStore', async () => {
  const log = new MemoryActivityLog()
  return {
    store: new MemoryEnvironmentSettingsStore(log),
    log,
    freshTenant: async () => ({
      projectId: '00000000-0000-7000-8000-00000000a001',
      environmentId: Bun.randomUUIDv7(),
    }),
  }
})

test('a seeded document is stored as given, and callers cannot change it through what they read', async () => {
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
