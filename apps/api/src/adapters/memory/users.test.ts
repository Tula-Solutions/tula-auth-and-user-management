import { MemoryUserRepository } from '~/adapters/memory/users'
import { describeUserRepository } from '~/adapters/user-repository.suite'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})
const a = tenant('00000000-0000-7000-8000-00000000e001')

describeUserRepository('MemoryUserRepository', async () => ({
  users: new MemoryUserRepository(),
  a,
  b: tenant('00000000-0000-7000-8000-00000000e002'),
}))
