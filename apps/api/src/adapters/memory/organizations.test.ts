import { testAddress } from '@tula-tech/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryOrganizationStore } from '~/adapters/memory/organizations'
import { MemoryUserRepository } from '~/adapters/memory/users'
import { describeOrganizationStore, userDeletion } from '~/adapters/organization-store.suite'
import * as Audit from '~/modules/audit/service'

const PROJECT = '00000000-0000-7000-8000-00000000a001'

const tenant = (environmentId: string) => ({ projectId: PROJECT, environmentId })

describeOrganizationStore('Memory', async () => {
  const log = new MemoryActivityLog()
  const users = new MemoryUserRepository(log)
  const a = tenant('00000000-0000-7000-8000-00000000e001')

  async function makeUser(of: { projectId: string; environmentId: string }, test = false) {
    const id = Bun.randomUUIDv7()
    const address = test ? testAddress(id.replaceAll('-', '')) : `${id}@northline.app`
    await users.create(
      {
        id,
        projectId: of.projectId,
        environmentId: of.environmentId,
        email: address,
        emailNormalized: address,
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
  }

  return {
    store: new MemoryOrganizationStore(log, users),
    recorded: async () =>
      log.entries
        .filter((entry) => entry.environmentId === a.environmentId)
        .map((entry) => entry.type),
    user: (of) => makeUser(of),
    testUser: (of) => makeUser(of, true),
    purgeTestUsers: (of, limit = 100) =>
      users.deleteTestUsersBefore(of.environmentId, new Date(), limit, (userId) =>
        userDeletion(of, userId)
      ),
    deleteUser: (of, userId) => users.delete(of.environmentId, userId, Audit.none('fixture')),
    a,
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
