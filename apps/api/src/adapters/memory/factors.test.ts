import { expect, test } from 'bun:test'
import { describeFactorStore } from '~/adapters/factor-store.suite'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryFactorStore } from '~/adapters/memory/factors'
import { MemoryUserRepository } from '~/adapters/memory/users'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
  user: async () => Bun.randomUUIDv7(),
})

describeFactorStore('MemoryFactorStore', async () => {
  const log = new MemoryActivityLog()
  return {
    store: new MemoryFactorStore(log, new MemoryUserRepository(log)),
    log,
    a: tenant('00000000-0000-7000-8000-00000000e001'),
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})

test('a store says which user repository it reports to, and no other', () => {
  const log = new MemoryActivityLog()
  const users = new MemoryUserRepository(log)
  const store = new MemoryFactorStore(log, users)
  expect(store.belongsTo(users)).toBe(true)
  expect(store.belongsTo(new MemoryUserRepository(log))).toBe(false)
})

test('a record read from the store is a copy: changing it changes nothing stored', async () => {
  const log = new MemoryActivityLog()
  const store = new MemoryFactorStore(log, new MemoryUserRepository(log))
  const environmentId = '00000000-0000-7000-8000-00000000e001'
  const userId = Bun.randomUUIDv7()
  await store.startTotp({
    id: Bun.randomUUIDv7(),
    projectId: '00000000-0000-7000-8000-00000000a001',
    environmentId,
    userId,
    type: 'totp',
    secret: 'sealed',
    createdAt: new Date(0),
    expiresAt: new Date(600_000),
  })
  const read = await store.findTotp(environmentId, userId)
  if (read) {
    read.confirmedAt = new Date(1)
    read.secret = 'changed'
  }
  expect(await store.findTotp(environmentId, userId)).toMatchObject({
    confirmedAt: null,
    secret: 'sealed',
  })
})
