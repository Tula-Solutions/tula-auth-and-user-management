import { describe, expect, test } from 'bun:test'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryFactorStore } from '~/adapters/memory/factors'
import { MemoryPasskeyStore } from '~/adapters/memory/passkeys'
import { MemoryUserRepository } from '~/adapters/memory/users'
import * as Audit from '~/modules/audit/service'
import type { StrongerFactorsHeld } from '~/ports/user-repository'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

const NUMBER = '+14155550100'
const AT = new Date('2026-01-01T00:00:00Z')
const nothingStronger = (held: StrongerFactorsHeld) => !held.confirmedTotp && held.passkeys === 0

/** A user with a proven number and a confirmed authenticator app, through the deps' own stores. */
async function userWithAuthenticator(deps: TestDeps): Promise<string> {
  const id = Bun.randomUUIDv7()
  await deps.users.create(
    {
      id,
      ...TEST_TENANT,
      email: `${id}@northline.app`,
      emailNormalized: `${id}@northline.app`,
      emailVerifiedAt: AT,
      firstName: null,
      lastName: null,
      createdAt: AT,
      identityId: Bun.randomUUIDv7(),
      credentialId: Bun.randomUUIDv7(),
      passwordHash: null,
    },
    Audit.none('fixture')
  )
  await deps.users.setPhoneNumber(
    TEST_TENANT.environmentId,
    id,
    NUMBER,
    AT,
    Audit.none('fixture'),
    Audit.none('fixture')
  )
  const factorId = Bun.randomUUIDv7()
  await deps.factors.startTotp({
    id: factorId,
    ...TEST_TENANT,
    userId: id,
    type: 'totp',
    secret: 'sealed',
    expiresAt: new Date(AT.getTime() + 600_000),
    createdAt: AT,
  })
  expect(
    await deps.factors.confirmTotp(TEST_TENANT.environmentId, factorId, {
      step: 1,
      at: AT,
      backupCodes: [],
      activity: Audit.none('fixture'),
    })
  ).toBe(true)
  return id
}

const enable = (deps: TestDeps, id: string) =>
  deps.users.enableSmsFactor(
    TEST_TENANT.environmentId,
    id,
    NUMBER,
    AT,
    nothingStronger,
    Audit.none('fixture')
  )

describe('createTestDeps keeps the user repository and the stores that report to it together', () => {
  test('the stores it builds itself are wired: a confirmed authenticator is seen by the write', async () => {
    const deps = createTestDeps()
    expect(await enable(deps, await userWithAuthenticator(deps))).toBe('stronger_factor')
  })

  test('a `users` override alone gets a factor store and a passkey store built on it', async () => {
    const users = new MemoryUserRepository(new MemoryActivityLog())
    const deps = createTestDeps({ users })
    expect(deps.users).toBe(users)
    expect(deps.factors.belongsTo(users)).toBe(true)
    expect(deps.passkeys.belongsTo(users)).toBe(true)
    expect(await enable(deps, await userWithAuthenticator(deps))).toBe('stronger_factor')
  })

  test('a `factors` override built on other users is refused, and the message says how', () => {
    const log = new MemoryActivityLog()
    const factors = new MemoryFactorStore(log, new MemoryUserRepository(log))
    expect(() => createTestDeps({ factors })).toThrow(
      /`factors`.*new MemoryFactorStore\(activityLog, users\).*pass that `users` too/s
    )
  })

  test('a `passkeys` override built on other users, or on none, is refused the same way', () => {
    const log = new MemoryActivityLog()
    const message =
      /`passkeys`.*new MemoryPasskeyStore\(activityLog, users\).*pass that `users` too/s
    expect(() =>
      createTestDeps({ passkeys: new MemoryPasskeyStore(log, new MemoryUserRepository(log)) })
    ).toThrow(message)
    expect(() => createTestDeps({ passkeys: new MemoryPasskeyStore(log) })).toThrow(message)
  })

  test('the three given together, built on one repository, are taken as they are', async () => {
    const activityLog = new MemoryActivityLog()
    const users = new MemoryUserRepository(activityLog)
    const factors = new MemoryFactorStore(activityLog, users)
    const passkeys = new MemoryPasskeyStore(activityLog, users)
    const deps = createTestDeps({ activityLog, users, factors, passkeys })
    expect(deps.factors).toBe(factors)
    expect(deps.passkeys).toBe(passkeys)
    expect(await enable(deps, await userWithAuthenticator(deps))).toBe('stronger_factor')
  })
})

describe('a memory user repository that nobody reports to', () => {
  test('a factor store of another adapter is taken as given, and the write then throws', async () => {
    const foreign = { findTotp: async () => null } as never
    const deps = createTestDeps({ factors: foreign })
    expect(deps.factors).toBe(foreign)
    await expect(enable(deps, Bun.randomUUIDv7())).rejects.toThrow(/no factor store/)
  })

  test('refuses to turn a texted code on: it throws, and never answers enabled', async () => {
    const users = new MemoryUserRepository(new MemoryActivityLog())
    const asked: StrongerFactorsHeld[] = []
    const call = users.enableSmsFactor(
      TEST_TENANT.environmentId,
      Bun.randomUUIDv7(),
      NUMBER,
      AT,
      (held) => {
        asked.push(held)
        return !held.confirmedTotp
      },
      Audit.none('fixture')
    )
    await expect(call).rejects.toThrow(
      /no factor store.*new MemoryFactorStore\(activityLog, users\)/s
    )
    expect(asked).toEqual([])
  })

  test('with a factor store and no passkey store it throws as well', async () => {
    const log = new MemoryActivityLog()
    const users = new MemoryUserRepository(log)
    new MemoryFactorStore(log, users)
    await expect(
      users.enableSmsFactor(
        TEST_TENANT.environmentId,
        Bun.randomUUIDv7(),
        NUMBER,
        AT,
        nothingStronger,
        Audit.none('fixture')
      )
    ).rejects.toThrow(/no passkey store.*new MemoryPasskeyStore\(activityLog, users\)/s)
  })
})
