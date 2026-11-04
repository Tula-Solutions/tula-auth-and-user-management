import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemorySsoConnectionStore } from '~/adapters/memory/sso-connections'
import { describeSsoConnectionStore } from '~/adapters/sso-connection-store.suite'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})

describeSsoConnectionStore('Memory', async () => {
  const log = new MemoryActivityLog()
  const a = tenant('00000000-0000-7000-8000-00000000e001')
  return {
    store: new MemorySsoConnectionStore(log),
    recorded: async () =>
      log.entries
        .filter((entry) => entry.environmentId === a.environmentId)
        .map((entry) => entry.type),
    organization: async () => Bun.randomUUIDv7(),
    user: async () => Bun.randomUUIDv7(),
    a,
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
