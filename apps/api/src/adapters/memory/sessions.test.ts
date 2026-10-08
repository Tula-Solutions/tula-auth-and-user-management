import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemorySessionStore } from '~/adapters/memory/sessions'
import { describeSessionStore } from '~/adapters/session-store.suite'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
  user: async () => Bun.randomUUIDv7(),
})

describeSessionStore('MemorySessionStore', async () => {
  const log = new MemoryActivityLog()
  return {
    store: new MemorySessionStore(log),
    log,
    a: tenant('00000000-0000-7000-8000-00000000e001'),
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
