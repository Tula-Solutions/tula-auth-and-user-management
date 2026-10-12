import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryApiKeyRepository } from '~/adapters/memory/api-keys'
import { MemoryProposalStore } from '~/adapters/memory/proposals'
import { describeProposalStore } from '~/adapters/proposal-store.suite'
import * as Audit from '~/modules/audit/service'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})

describeProposalStore('Memory', async () => {
  const log = new MemoryActivityLog()
  const keys = new MemoryApiKeyRepository(new MemoryActivityLog())
  const a = tenant('00000000-0000-7000-8000-00000000e001')
  return {
    store: new MemoryProposalStore(log, keys),
    key: async (owner, kind) => {
      const id = Bun.randomUUIDv7()
      await keys.insert(
        {
          id,
          kind,
          name: 'suite',
          ...owner,
          keyHash: id,
          lastFour: '0000',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        Audit.none('fixture')
      )
      return id
    },
    revokeKey: async (owner, id) => {
      await keys.revoke(owner.environmentId, id, new Date(), Audit.none('fixture'))
    },
    recorded: async () =>
      log.entries
        .filter((entry) => entry.environmentId === a.environmentId)
        .map((entry) => entry.type),
    a,
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
