import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryProposalStore } from '~/adapters/memory/proposals'
import { describeProposalStore } from '~/adapters/proposal-store.suite'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})

describeProposalStore('Memory', async () => {
  const log = new MemoryActivityLog()
  const a = tenant('00000000-0000-7000-8000-00000000e001')
  return {
    store: new MemoryProposalStore(log),
    recorded: async () =>
      log.entries
        .filter((entry) => entry.environmentId === a.environmentId)
        .map((entry) => entry.type),
    a,
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
