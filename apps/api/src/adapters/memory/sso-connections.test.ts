import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryOrganizationStore } from '~/adapters/memory/organizations'
import { MemorySsoConnectionStore } from '~/adapters/memory/sso-connections'
import { describeSsoConnectionStore } from '~/adapters/sso-connection-store.suite'
import * as Audit from '~/modules/audit/service'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})

describeSsoConnectionStore('Memory', async () => {
  const log = new MemoryActivityLog()
  const organizations = new MemoryOrganizationStore(log)
  const a = tenant('00000000-0000-7000-8000-00000000e001')
  return {
    store: new MemorySsoConnectionStore(log, undefined, organizations),
    recorded: async () =>
      log.entries
        .filter((entry) => entry.environmentId === a.environmentId)
        .map((entry) => entry.type),
    organization: async (t) => {
      const id = Bun.randomUUIDv7()
      const at = new Date(0)
      await organizations.insert(
        {
          id,
          projectId: t.projectId,
          environmentId: t.environmentId,
          name: 'Acme',
          slug: `acme-${id.slice(-8)}`,
          createdBy: null,
          createdAt: at,
          updatedAt: at,
        },
        Audit.none('fixture')
      )
      return id
    },
    deleteOrganization: async (t, id) => {
      await organizations.delete(t.environmentId, id, Audit.none('fixture'))
    },
    user: async () => Bun.randomUUIDv7(),
    a,
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
