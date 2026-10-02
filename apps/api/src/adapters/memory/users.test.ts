import { expect, test } from 'bun:test'
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

test('setBanned bans and unbans a user for tests', async () => {
  const users = new MemoryUserRepository()
  const now = new Date('2026-01-01T00:00:00Z')
  await users.createWithPassword({
    id: 'u1',
    ...a,
    email: 'a@b.test',
    emailNormalized: 'a@b.test',
    emailVerifiedAt: now,
    firstName: null,
    lastName: null,
    createdAt: now,
    identityId: 'i1',
    credentialId: 'c1',
    passwordHash: 'hash',
  })
  users.setBanned('u1', now)
  expect((await users.findById(a.environmentId, 'u1'))?.bannedAt).toEqual(now)
  users.setBanned('u1', null)
  users.setBanned('missing', now)
  expect((await users.findById(a.environmentId, 'u1'))?.bannedAt).toBeNull()
})
