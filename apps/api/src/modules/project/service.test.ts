import { beforeEach, describe, expect, test } from 'bun:test'
import type { Tenant } from '~/dependencies'
import { ConflictError, NotFoundError } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import * as Audit from '~/modules/audit/service'
import * as Project from '~/modules/project/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

let deps: TestDeps
const dev: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: '00000000-0000-7000-8000-00000000c0de',
}
const prod: Tenant = { ...dev, environmentId: TEST_TENANT.productionEnvironmentId }

beforeEach(() => {
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  deps.environments.add({
    id: TEST_TENANT.productionEnvironmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'production',
    createdAt: deps.clock.now(),
  })
})

describe('listEnvironments', () => {
  test('lists the key’s project, development first', async () => {
    const envs = await Project.listEnvironments(deps, dev)
    expect(envs.map((env) => env.kind)).toEqual(['development', 'production'])
  })
})

describe('createApiKey', () => {
  test.each([
    ['publishable', dev, /^tula_pk_dev_[A-Za-z0-9_-]{43}$/],
    ['secret', dev, /^tula_sk_dev_[A-Za-z0-9_-]{43}$/],
    ['secret', prod, /^tula_sk_prod_[A-Za-z0-9_-]{43}$/],
  ] as const)('mints a %s key for the environment', async (kind, tenant, pattern) => {
    const created = await Project.createApiKey(deps, tenant, { kind, name: 'Backend' }, TEST_ACTOR)
    expect(created.key).toMatch(pattern)
    expect(created).toMatchObject({
      kind,
      name: 'Backend',
      environmentId: tenant.environmentId,
      lastFour: created.key.slice(-4),
      createdAt: deps.clock.now(),
      revokedAt: null,
    })
  })

  test('stores only the hash, so the key resolves but is never listed', async () => {
    const created = await Project.createApiKey(
      deps,
      dev,
      { kind: 'secret', name: 'Backend' },
      TEST_ACTOR
    )
    expect((await deps.apiKeys.findByHash(sha256Hex(created.key)))?.id).toBe(created.id)
    const listed = await Project.listApiKeys(deps, dev)
    expect(JSON.stringify(listed)).not.toContain(created.key)
  })

  test('mints a different key every time', async () => {
    const a = await Project.createApiKey(deps, dev, { kind: 'secret', name: 'A' }, TEST_ACTOR)
    const b = await Project.createApiKey(deps, dev, { kind: 'secret', name: 'B' }, TEST_ACTOR)
    expect(a.key).not.toBe(b.key)
  })

  test('refuses an environment outside the key’s project', async () => {
    const foreign = { ...dev, projectId: '00000000-0000-7000-8000-00000000a999' }
    await expect(
      Project.createApiKey(deps, foreign, { kind: 'secret', name: 'x' }, TEST_ACTOR)
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('active key cap', () => {
  test(`refuses more than ${Project.MAX_ACTIVE_KEYS} active keys per environment`, async () => {
    const keys = []
    for (let i = 0; i < Project.MAX_ACTIVE_KEYS; i++) {
      keys.push(
        await Project.createApiKey(deps, dev, { kind: 'publishable', name: `k${i}` }, TEST_ACTOR)
      )
    }
    const over = Project.createApiKey(
      deps,
      dev,
      { kind: 'publishable', name: 'one too many' },
      TEST_ACTOR
    )
    await expect(over).rejects.toBeInstanceOf(ConflictError)
    await expect(over).rejects.toMatchObject({ params: { max: Project.MAX_ACTIVE_KEYS } })

    // Revoked keys do not count, and other environments have their own allowance.
    await Project.revokeApiKey(deps, dev, keys[0]?.id ?? '', TEST_ACTOR)
    await Project.createApiKey(deps, dev, { kind: 'publishable', name: 'replacement' }, TEST_ACTOR)
    await Project.createApiKey(deps, prod, { kind: 'publishable', name: 'prod' }, TEST_ACTOR)
  })
})

describe('total key cap', () => {
  test('revoked keys cannot pile up without limit', async () => {
    // A leaked secret key could otherwise create and revoke in a loop forever.
    const createdAt = deps.clock.now()
    for (let index = 0; index < Project.MAX_KEYS; index++) {
      const key = await seedApiKey(deps, `tula_pk_dev_${index.toString().padStart(30, '0')}`, {
        createdAt,
      })
      await deps.apiKeys.revoke(dev.environmentId, key.id, createdAt, Audit.none('fixture'))
    }
    const over = Project.createApiKey(deps, dev, { kind: 'secret', name: 'one more' }, TEST_ACTOR)
    await expect(over).rejects.toBeInstanceOf(ConflictError)
    await expect(over).rejects.toMatchObject({ params: { max: Project.MAX_KEYS } })
    // Another environment is unaffected.
    await Project.createApiKey(deps, prod, { kind: 'secret', name: 'prod' }, TEST_ACTOR)
  })

  test('the cap is checked by counting, not by loading every key', async () => {
    const list = deps.apiKeys.listByEnvironment.bind(deps.apiKeys)
    let listed = 0
    deps.apiKeys.listByEnvironment = (environmentId) => {
      listed += 1
      return list(environmentId)
    }
    await Project.createApiKey(deps, dev, { kind: 'secret', name: 'Backend' }, TEST_ACTOR)
    expect(listed).toBe(0)
    expect(await deps.apiKeys.countByEnvironment(dev.environmentId)).toEqual({
      active: 1,
      total: 1,
    })
  })
})

describe('listApiKeys', () => {
  test('lists only the tenant’s environment, newest first', async () => {
    const first = await Project.createApiKey(
      deps,
      dev,
      { kind: 'secret', name: 'first' },
      TEST_ACTOR
    )
    deps.clock.advance('1m')
    const second = await Project.createApiKey(
      deps,
      dev,
      { kind: 'publishable', name: 'second' },
      TEST_ACTOR
    )
    await Project.createApiKey(deps, prod, { kind: 'secret', name: 'prod' }, TEST_ACTOR)
    const listed = await Project.listApiKeys(deps, dev)
    expect(listed.map((key) => key.id)).toEqual([second.id, first.id])
  })
})

describe('revokeApiKey', () => {
  test('revokes a key so it no longer resolves as active', async () => {
    const created = await Project.createApiKey(
      deps,
      dev,
      { kind: 'publishable', name: 'web' },
      TEST_ACTOR
    )
    deps.clock.advance('5m')
    const revoked = await Project.revokeApiKey(deps, dev, created.id, TEST_ACTOR)
    expect(revoked.revokedAt).toEqual(deps.clock.now())
    expect((await deps.apiKeys.findByHash(sha256Hex(created.key)))?.revokedAt).not.toBeNull()
  })

  test('is idempotent', async () => {
    const created = await Project.createApiKey(
      deps,
      dev,
      { kind: 'publishable', name: 'web' },
      TEST_ACTOR
    )
    const first = await Project.revokeApiKey(deps, dev, created.id, TEST_ACTOR)
    deps.clock.advance('1h')
    expect((await Project.revokeApiKey(deps, dev, created.id, TEST_ACTOR)).revokedAt).toEqual(
      first.revokedAt
    )
  })

  test('cannot revoke another environment’s key, even with its id', async () => {
    const prodKey = await Project.createApiKey(
      deps,
      prod,
      { kind: 'secret', name: 'prod' },
      TEST_ACTOR
    )
    await expect(Project.revokeApiKey(deps, dev, prodKey.id, TEST_ACTOR)).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect((await deps.apiKeys.findByHash(sha256Hex(prodKey.key)))?.revokedAt).toBeNull()
  })

  test('refuses to revoke the key making the request, so an admin cannot lock themselves out', async () => {
    const self = await Project.createApiKey(deps, dev, { kind: 'secret', name: 'self' }, TEST_ACTOR)
    await expect(
      Project.revokeApiKey(deps, { ...dev, apiKeyId: self.id }, self.id, TEST_ACTOR)
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('reports an unknown id as not found', async () => {
    await expect(
      Project.revokeApiKey(deps, dev, '00000000-0000-7000-8000-0000000000ff', TEST_ACTOR)
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('activity', () => {
  const recorded = () => deps.activityLog.entries.map((entry) => entry.type)

  test('creating a key records its kind and who made it, never the key', async () => {
    const created = await Project.createApiKey(
      deps,
      dev,
      { kind: 'secret', name: 'Backend' },
      TEST_ACTOR
    )
    expect(deps.activityLog.entries).toEqual([
      {
        id: expect.any(String),
        projectId: dev.projectId,
        environmentId: dev.environmentId,
        type: 'api_key.created',
        actor: { type: 'admin', id: TEST_ACTOR.id },
        target: { type: 'api_key', id: created.id },
        ipAddress: TEST_ACTOR.ipAddress,
        userAgent: TEST_ACTOR.userAgent,
        data: { kind: 'secret' },
        occurredAt: deps.clock.now(),
      },
    ])
    const written = JSON.stringify(deps.activityLog.entries)
    expect(written).not.toContain(created.key)
    expect(written).not.toContain(sha256Hex(created.key))
    expect(written).not.toContain(created.key.slice(-12))
  })

  test('revoking a key is recorded once; a refused revocation is not', async () => {
    const created = await Project.createApiKey(
      deps,
      dev,
      { kind: 'secret', name: 'Backend' },
      TEST_ACTOR
    )
    await expect(Project.revokeApiKey(deps, dev, dev.apiKeyId, TEST_ACTOR)).rejects.toBeInstanceOf(
      ConflictError
    )
    await expect(Project.revokeApiKey(deps, prod, created.id, TEST_ACTOR)).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(recorded()).toEqual(['api_key.created'])
    await Project.revokeApiKey(deps, dev, created.id, TEST_ACTOR)
    await Project.revokeApiKey(deps, dev, created.id, TEST_ACTOR)
    expect(recorded()).toEqual(['api_key.created', 'api_key.revoked'])
    expect(deps.activityLog.ofType('api_key.revoked')).toMatchObject([
      { actor: { type: 'admin', id: TEST_ACTOR.id }, target: { type: 'api_key', id: created.id } },
    ])
  })
})
