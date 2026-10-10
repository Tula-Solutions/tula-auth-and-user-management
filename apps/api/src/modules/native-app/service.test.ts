import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { MAX_NATIVE_APPS } from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { ConflictError, NotFoundError, ServiceException } from '~/exceptions'
import * as Audit from '~/modules/audit/service'
import * as NativeApps from '~/modules/native-app/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }

const fingerprint = (byte: string) => Array.from({ length: 32 }, () => byte).join(':')
const AA = fingerprint('AA')
const BB = fingerprint('BB')
const CC = fingerprint('CC')
const ios = (bundleId = 'com.example.app') =>
  ({ platform: 'ios', teamId: 'A1B2C3D4E5', bundleId }) as const
const android = (packageName = 'com.example.app', sha256CertFingerprints = [AA]) =>
  ({ platform: 'android', packageName, sha256CertFingerprints }) as const

let deps: TestDeps

beforeEach(() => {
  deps = createTestDeps()
  for (const id of [tenant.environmentId, otherTenant.environmentId]) {
    deps.environments.add({
      id,
      projectId: tenant.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
  }
})

/** The outcome of work that is expected to throw one of the service's own errors. */
async function thrown(work: Promise<unknown>): Promise<ServiceException> {
  try {
    await work
  } catch (error) {
    if (error instanceof ServiceException) {
      return error
    }
    throw error
  }
  throw new Error('nothing was thrown')
}

describe('the cap on an environment’s apps', () => {
  test('registrations that arrive together cannot each see room for one more', async () => {
    for (let n = 0; n < MAX_NATIVE_APPS - 1; n += 1) {
      await NativeApps.create(deps, tenant, ios(`com.example.app${n}`), TEST_ACTOR)
    }
    const outcomes = await Promise.allSettled(
      ['one', 'two', 'three'].map((name) =>
        NativeApps.create(deps, tenant, android(`com.example.${name}`), TEST_ACTOR)
      )
    )
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(ConflictError)
        expect(outcome.reason.params).toEqual({ max: MAX_NATIVE_APPS })
      }
    }
    expect(await deps.nativeApps.list(tenant.environmentId)).toHaveLength(MAX_NATIVE_APPS)
    expect(deps.activityLog.entries).toHaveLength(MAX_NATIVE_APPS)
  })

  test('the count and the insert are made under the environment’s lock for native apps', async () => {
    const lock = spyOn(deps.environmentLock, 'runExclusive')
    await NativeApps.create(deps, tenant, ios(), TEST_ACTOR)
    expect(lock).toHaveBeenCalledTimes(1)
    expect(lock.mock.calls[0]?.slice(0, 2)).toEqual([tenant.environmentId, 'native_apps'])
  })

  test('a full environment does not stop another from registering', async () => {
    for (let n = 0; n < MAX_NATIVE_APPS; n += 1) {
      await NativeApps.create(deps, tenant, ios(`com.example.app${n}`), TEST_ACTOR)
    }
    expect(await NativeApps.create(deps, otherTenant, ios(), TEST_ACTOR)).toMatchObject(ios())
  })
})

describe('a change made over an app that moved meanwhile', () => {
  test('is not written and not recorded: the caller reads again', async () => {
    const created = await NativeApps.create(deps, tenant, android(), TEST_ACTOR)
    const find = deps.nativeApps.find.bind(deps.nativeApps)
    // Someone else gives the app a fingerprint between this change's read and its write.
    const read = spyOn(deps.nativeApps, 'find').mockImplementationOnce(async (env, id) => {
      const record = await find(env, id)
      if (record) {
        await deps.nativeApps.update(
          env,
          id,
          record,
          { sha256CertFingerprints: [AA, CC] },
          deps.clock.now(),
          Audit.none('fixture')
        )
      }
      return record
    })
    const error = await thrown(
      NativeApps.update(deps, tenant, created.id, { sha256CertFingerprints: [AA, BB] }, TEST_ACTOR)
    )
    read.mockRestore()
    expect(error).toBeInstanceOf(ConflictError)
    expect(await NativeApps.get(deps, tenant, created.id)).toMatchObject({
      sha256CertFingerprints: [AA, CC],
    })
    expect(deps.activityLog.entries.map((entry) => entry.type)).toEqual(['native_app.created'])
  })

  test('an update judged against link paths that changed meanwhile is refused, and writes nothing', async () => {
    const created = await NativeApps.create(
      deps,
      tenant,
      { ...ios(), appLinkPaths: ['/link'] },
      TEST_ACTOR
    )
    const find = deps.nativeApps.find.bind(deps.nativeApps)
    const read = spyOn(deps.nativeApps, 'find').mockImplementationOnce(async (env, id) => {
      const record = await find(env, id)
      if (record) {
        await deps.nativeApps.update(
          env,
          id,
          record,
          { appLinkPaths: ['/admin', '/link'] },
          deps.clock.now(),
          Audit.none('fixture')
        )
      }
      return record
    })
    // Judged against one path, "none" takes a path away and is no weakening. Over the two the
    // app has by now it would be recorded as taking away what nobody saw given.
    const error = await thrown(
      NativeApps.update(deps, tenant, created.id, { appLinkPaths: [] }, TEST_ACTOR)
    )
    read.mockRestore()
    expect(error).toBeInstanceOf(ConflictError)
    expect(await NativeApps.get(deps, tenant, created.id)).toMatchObject({
      appLinkPaths: ['/admin', '/link'],
    })
    expect(deps.activityLog.entries.map((entry) => entry.type)).toEqual(['native_app.created'])
  })

  test.each([
    [
      'an update',
      (id: string) => NativeApps.update(deps, tenant, id, { teamId: 'ZZZZZZZZZZ' }, TEST_ACTOR),
    ],
    ['a removal', (id: string) => NativeApps.remove(deps, tenant, id, TEST_ACTOR)],
  ])(
    '%s of an app removed between its read and its write answers not found and records nothing',
    async (_name, act) => {
      const created = await NativeApps.create(deps, tenant, ios(), TEST_ACTOR)
      const find = deps.nativeApps.find.bind(deps.nativeApps)
      const read = spyOn(deps.nativeApps, 'find').mockImplementationOnce(async (env, id) => {
        const record = await find(env, id)
        await deps.nativeApps.delete(env, id, Audit.none('fixture'))
        return record
      })
      expect(await thrown(act(created.id))).toBeInstanceOf(NotFoundError)
      read.mockRestore()
      expect(deps.activityLog.entries.map((entry) => entry.type)).toEqual(['native_app.created'])
    }
  )
})

describe('the files of an environment', () => {
  test('are built from that environment’s rows and no other’s', async () => {
    await NativeApps.create(deps, tenant, ios('com.example.mine'), TEST_ACTOR)
    await NativeApps.create(deps, otherTenant, ios('com.example.theirs'), TEST_ACTOR)
    await NativeApps.create(deps, otherTenant, android('com.example.theirs'), TEST_ACTOR)
    expect(await NativeApps.appleAppSiteAssociation(deps, tenant.environmentId)).toEqual({
      webcredentials: { apps: ['A1B2C3D4E5.com.example.mine'] },
    })
    expect(await NativeApps.assetLinks(deps, tenant.environmentId)).toEqual([])
    const list = spyOn(deps.nativeApps, 'list')
    await NativeApps.assetLinks(deps, otherTenant.environmentId)
    expect(list.mock.calls).toEqual([[otherTenant.environmentId]])
  })

  test('an environment that does not exist has no file, and its rows are not looked for', async () => {
    const list = spyOn(deps.nativeApps, 'list')
    const unknown = Bun.randomUUIDv7()
    expect(await thrown(NativeApps.appleAppSiteAssociation(deps, unknown))).toBeInstanceOf(
      NotFoundError
    )
    expect(await thrown(NativeApps.assetLinks(deps, unknown))).toBeInstanceOf(NotFoundError)
    expect(list).not.toHaveBeenCalled()
  })
})
