import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryOrganizationDomainStore } from '~/adapters/memory/organization-domains'
import { MemoryOrganizationStore } from '~/adapters/memory/organizations'
import { MemorySsoConnectionStore } from '~/adapters/memory/sso-connections'
import {
  connectionRecord,
  describeOrganizationDomainStore,
} from '~/adapters/organization-domain-store.suite'
import * as Audit from '~/modules/audit/service'

const PROJECT = '00000000-0000-7000-8000-00000000a001'

const tenant = (environmentId: string) => ({ projectId: PROJECT, environmentId })

describeOrganizationDomainStore('Memory', async () => {
  const log = new MemoryActivityLog()
  const organizations = new MemoryOrganizationStore(log)
  const connections = new MemorySsoConnectionStore(log)
  const a = tenant('00000000-0000-7000-8000-00000000e001')
  return {
    store: new MemoryOrganizationDomainStore(log, organizations, connections),
    recorded: async () =>
      log.entries
        .filter((entry) => entry.environmentId === a.environmentId)
        .map((entry) => entry.type),
    organization: async (of) => {
      const id = Bun.randomUUIDv7()
      const at = new Date(0)
      await organizations.insert(
        {
          id,
          projectId: of.projectId,
          environmentId: of.environmentId,
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
    deleteOrganization: async (of, id) => {
      await organizations.delete(of.environmentId, id, Audit.none('fixture'))
    },
    connect: async (tenant, organizationId, domains) => {
      const record = connectionRecord(tenant, organizationId, domains)
      await connections.insert(record, Audit.none('fixture'))
      return record.id
    },
    connectionDomains: async (of, id) =>
      (await connections.find(of.environmentId, id))?.domains ?? [],
    a,
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
