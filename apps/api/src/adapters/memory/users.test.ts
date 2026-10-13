import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryFactorStore } from '~/adapters/memory/factors'
import { MemoryPasskeyStore } from '~/adapters/memory/passkeys'
import { MemoryUserRepository } from '~/adapters/memory/users'
import { describeUserRepository } from '~/adapters/user-repository.suite'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})
const a = tenant('00000000-0000-7000-8000-00000000e001')

describeUserRepository('MemoryUserRepository', async () => {
  const log = new MemoryActivityLog()
  const users = new MemoryUserRepository(log)
  return {
    users,
    // Each registers itself with the repository, as `createTestDeps` wires them.
    factors: new MemoryFactorStore(log, users),
    passkeys: new MemoryPasskeyStore(log, users),
    log,
    a,
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
