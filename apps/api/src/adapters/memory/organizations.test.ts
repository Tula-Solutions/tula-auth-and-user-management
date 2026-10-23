import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryOrganizationStore } from '~/adapters/memory/organizations'
import { MemoryUserRepository } from '~/adapters/memory/users'
import { describeOrganizationStore } from '~/adapters/organization-store.suite'
import * as Audit from '~/modules/audit/service'

const PROJECT = '00000000-0000-7000-8000-00000000a001'

const tenant = (environmentId: string) => ({ projectId: PROJECT, environmentId })

describeOrganizationStore('Memory', async () => {
  const log = new MemoryActivityLog()
  const users = new MemoryUserRepository(log)
  const a = tenant('00000000-0000-7000-8000-00000000e001')
  return {
    store: new MemoryOrganizationStore(log, users),
    recorded: async () =>
      log.entries
        .filter((entry) => entry.environmentId === a.environmentId)
        .map((entry) => entry.type),
    user: async (of) => {
      const id = Bun.randomUUIDv7()
      await users.create(
        {
          id,
          projectId: of.projectId,
          environmentId: of.environmentId,
          email: `${id}@northline.app`,
          emailNormalized: `${id}@northline.app`,
          emailVerifiedAt: null,
          firstName: null,
          lastName: null,
          createdAt: new Date(0),
          identityId: Bun.randomUUIDv7(),
          credentialId: Bun.randomUUIDv7(),
          passwordHash: null,
        },
        Audit.none('fixture')
      )
      return id
    },
    deleteUser: async (of, userId) => {
      await users.delete(of.environmentId, userId, Audit.none('fixture'))
    },
    a,
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
