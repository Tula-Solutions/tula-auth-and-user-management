import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryOrganizationStore } from '~/adapters/memory/organizations'
import { describeOrganizationStore } from '~/adapters/organization-store.suite'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})

describeOrganizationStore('Memory', async () => {
  const log = new MemoryActivityLog()
  const a = tenant('00000000-0000-7000-8000-00000000e001')
  return {
    store: new MemoryOrganizationStore(log),
    recorded: async () =>
      log.entries
        .filter((entry) => entry.environmentId === a.environmentId)
        .map((entry) => entry.type),
    user: async () => Bun.randomUUIDv7(),
    a,
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
