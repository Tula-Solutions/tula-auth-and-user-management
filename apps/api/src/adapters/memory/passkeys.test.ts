import { expect, test } from 'bun:test'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryPasskeyStore } from '~/adapters/memory/passkeys'
import { MemoryUserRepository } from '~/adapters/memory/users'
import { describePasskeyStore } from '~/adapters/passkey-store.suite'

const PROJECT = '00000000-0000-7000-8000-00000000a001'
const ENVIRONMENT = '00000000-0000-7000-8000-00000000e001'

describePasskeyStore('MemoryPasskeyStore', async () => {
  const log = new MemoryActivityLog()
  const users = new MemoryUserRepository(log)
  const tenant = (environmentId: string) => ({
    projectId: PROJECT,
    environmentId,
    user: async () => {
      const id = Bun.randomUUIDv7()
      await users.create({
        id,
        projectId: PROJECT,
        environmentId,
        email: `${id}@northline.app`,
        emailNormalized: `${id}@northline.app`,
        emailVerifiedAt: null,
        firstName: null,
        lastName: null,
        createdAt: new Date(0),
        identityId: Bun.randomUUIDv7(),
        credentialId: Bun.randomUUIDv7(),
        passwordHash: null,
      })
      return id
    },
  })
  return {
    store: new MemoryPasskeyStore(log, users),
    log,
    a: tenant(ENVIRONMENT),
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})

const record = (userId: string) => ({
  id: Bun.randomUUIDv7(),
  projectId: PROJECT,
  environmentId: ENVIRONMENT,
  userId,
  credentialId: `credential-${Bun.randomUUIDv7()}`,
  publicKey: new Uint8Array([1, 2, 3]),
  signCount: 0,
  transports: ['internal'],
  aaguid: '00000000-0000-0000-0000-000000000000',
  backupEligible: false,
  backedUp: false,
  userHandle: 'handle',
  name: 'Passkey',
  lastUsedAt: null,
  createdAt: new Date(0),
})

test('a store built without users treats a removal as leaving nothing but passkeys', async () => {
  const store = new MemoryPasskeyStore()
  const userId = Bun.randomUUIDv7()
  const passkey = record(userId)
  await store.create(passkey, 10)
  let seen: unknown
  expect(
    await store.remove(ENVIRONMENT, userId, passkey.id, (remaining) => {
      seen = remaining
      return true
    })
  ).toBe('removed')
  expect(seen).toEqual({ hasPassword: false, emailVerified: false, providers: [], passkeys: 0 })
})

test('a record read from the store is a copy: changing it changes nothing stored', async () => {
  const store = new MemoryPasskeyStore()
  const userId = Bun.randomUUIDv7()
  const passkey = record(userId)
  await store.create(passkey, 10)
  const [read] = await store.listForUser(ENVIRONMENT, userId)
  if (read) {
    read.publicKey[0] = 99
    read.transports.push('usb')
    read.name = 'changed'
  }
  expect(await store.findByCredentialId(ENVIRONMENT, passkey.credentialId)).toEqual(passkey)
})

test('the users repository counts passkeys once the store is attached to it', async () => {
  const log = new MemoryActivityLog()
  const users = new MemoryUserRepository(log)
  const userId = Bun.randomUUIDv7()
  await users.create({
    id: userId,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    email: 'maya@northline.app',
    emailNormalized: 'maya@northline.app',
    emailVerifiedAt: new Date(0),
    firstName: null,
    lastName: null,
    createdAt: new Date(0),
    identityId: Bun.randomUUIDv7(),
    credentialId: Bun.randomUUIDv7(),
    passwordHash: null,
  })
  expect(users.signInMeans(ENVIRONMENT, userId)).toEqual({
    hasPassword: false,
    emailVerified: true,
    providers: [],
    passkeys: 0,
  })
  const store = new MemoryPasskeyStore(log, users)
  await store.create(record(userId), 10)
  expect(users.signInMeans(ENVIRONMENT, userId)?.passkeys).toBe(1)
  expect(users.signInMeans(ENVIRONMENT, Bun.randomUUIDv7())).toBeNull()
})
