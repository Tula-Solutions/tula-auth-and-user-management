import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { environments, signingKeys, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { eq } from 'drizzle-orm'
import { PostgresApiKeyRepository } from '~/adapters/postgres/api-keys'
import { PostgresEnvironmentRepository } from '~/adapters/postgres/environments'
import { databaseProbe } from '~/adapters/postgres/health'
import { PostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import * as Audit from '~/modules/audit/service'
import { RETIRED_KEY_RETENTION_MS } from '~/ports/signing-key-store'

// PGlite is real Postgres (WASM) with every migration applied, connected as the runtime role, so
// these tests exercise the actual SQL, grants and row-level security without Docker.
let testDb: TestDatabase
let a: TestTenant
let b: TestTenant
const now = new Date('2026-01-01T00:00:00Z')

function publicJwk(x: string) {
  return { kty: 'OKP', crv: 'Ed25519', x, alg: 'EdDSA', use: 'sig', kid: 'stale-kid' }
}

async function insertKey(
  tenant: TestTenant,
  values: { status: 'next' | 'active' | 'retired'; retiredAt?: Date; x?: string; jwk?: object }
) {
  return withTenant(testDb.db, tenant.environmentId, async (tx) => {
    const [row] = await tx
      .insert(signingKeys)
      .values({
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        publicJwk: (values.jwk ?? publicJwk(values.x ?? 'x')) as Record<string, string>,
        privateKeyCiphertext: 'ciphertext',
        status: values.status,
        retiredAt: values.retiredAt,
      })
      .returning({ id: signingKeys.id })
    if (!row) {
      throw new Error('signing key insert returned no row')
    }
    return row.id
  })
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  a = await createTestTenant(testDb.db)
  b = await createTestTenant(testDb.db, 'production')
})

afterAll(() => testDb.close())

describe('PostgresApiKeyRepository', () => {
  const repo = () => new PostgresApiKeyRepository(testDb.db)
  let counter = 0
  function newKey(tenant: TestTenant, createdAt: Date) {
    counter += 1
    return {
      id: Bun.randomUUIDv7(),
      kind: 'secret' as const,
      name: `Server ${counter}`,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      lastFour: 'abcd',
      createdAt,
      keyHash: counter.toString(16).padStart(64, '0'),
    }
  }

  test('inserts and finds a key by hash without returning the hash', async () => {
    const input = newKey(a, now)
    const stored = await repo().insert(input, Audit.none('fixture'))
    const { keyHash: _hash, ...expected } = input
    expect(stored).toEqual({ ...expected, lastUsedAt: null, revokedAt: null })
    expect(await repo().findByHash(input.keyHash)).toEqual(stored)
    expect(await repo().findByHash('f'.repeat(64))).toBeNull()
  })

  test('rejects a duplicate hash', async () => {
    const input = newKey(a, now)
    await repo().insert(input, Audit.none('fixture'))
    await expect(
      repo().insert({ ...input, id: Bun.randomUUIDv7() }, Audit.none('fixture'))
    ).rejects.toThrow()
  })

  test('lists only the given environment, newest first', async () => {
    const tenant = await createTestTenant(testDb.db)
    const older = await repo().insert(newKey(tenant, now), Audit.none('fixture'))
    const newer = await repo().insert(
      newKey(tenant, new Date(now.getTime() + 1000)),
      Audit.none('fixture')
    )
    await repo().insert(newKey(b, new Date(now.getTime() + 2000)), Audit.none('fixture'))
    expect((await repo().listByEnvironment(tenant.environmentId)).map((key) => key.id)).toEqual([
      newer.id,
      older.id,
    ])
  })

  test('revokes only inside the given environment, keeping the first revocation time', async () => {
    const key = await repo().insert(newKey(a, now), Audit.none('fixture'))
    expect(await repo().revoke(b.environmentId, key.id, now, Audit.none('fixture'))).toBeNull()
    expect((await repo().findByHash(newKey(a, now).keyHash))?.revokedAt ?? null).toBeNull()

    const first = await repo().revoke(a.environmentId, key.id, now, Audit.none('fixture'))
    expect(first?.revokedAt).toEqual(now)
    const again = await repo().revoke(
      a.environmentId,
      key.id,
      new Date(now.getTime() + 5000),
      Audit.none('fixture')
    )
    expect(again?.revokedAt).toEqual(now)
    expect(
      await repo().revoke(a.environmentId, Bun.randomUUIDv7(), now, Audit.none('fixture'))
    ).toBeNull()
  })
})

describe('PostgresApiKeyRepository.touch', () => {
  test('records the last use time', async () => {
    const repo = new PostgresApiKeyRepository(testDb.db)
    const key = await repo.insert(
      {
        id: Bun.randomUUIDv7(),
        kind: 'publishable',
        name: 'touched',
        projectId: a.projectId,
        environmentId: a.environmentId,
        lastFour: 'abcd',
        createdAt: now,
        keyHash: 'e'.repeat(64),
      },
      Audit.none('fixture')
    )
    const used = new Date(now.getTime() + 60_000)
    await repo.touch(key.id, used)
    expect((await repo.findByHash('e'.repeat(64)))?.lastUsedAt).toEqual(used)
  })
})

describe('PostgresEnvironmentRepository', () => {
  test('finds by id and lists a project development-first', async () => {
    const tenant = await createTestTenant(testDb.db)
    const [prod] = await testDb.db
      .insert(environments)
      .values({ projectId: tenant.projectId, kind: 'production' })
      .returning({ id: environments.id })
    const repo = new PostgresEnvironmentRepository(testDb.db)
    expect(await repo.findById(tenant.environmentId)).toMatchObject({
      id: tenant.environmentId,
      projectId: tenant.projectId,
      kind: 'development',
    })
    expect(await repo.findById(Bun.randomUUIDv7())).toBeNull()
    expect((await repo.listByProject(tenant.projectId)).map((env) => env.id)).toEqual([
      tenant.environmentId,
      prod?.id ?? 'missing',
    ])
  })
})

describe('PostgresSigningKeyStore', () => {
  test('returns verifiable keys with the row id as kid, scoped to the environment', async () => {
    const active = await insertKey(a, { status: 'active', x: 'active' })
    const next = await insertKey(a, { status: 'next', x: 'next' })
    await insertKey(a, {
      status: 'retired',
      retiredAt: new Date(now.getTime() - RETIRED_KEY_RETENTION_MS),
    })
    await insertKey(b, { status: 'active', x: 'other-environment' })

    const keys = await new PostgresSigningKeyStore(testDb.db).verificationKeys(a.environmentId, now)
    expect(keys.map((key) => key.kid).sort()).toEqual([active, next].sort())
    expect(keys.find((key) => key.kid === active)).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'active',
      alg: 'EdDSA',
      use: 'sig',
      kid: active,
    })
  })

  test('skips malformed stored keys instead of failing every request', async () => {
    const tenant = await createTestTenant(testDb.db)
    await insertKey(tenant, { status: 'active', jwk: { kty: 'RSA', n: 'x', e: 'AQAB' } })
    const good = await insertKey(tenant, { status: 'next', x: 'good' })
    const keys = await new PostgresSigningKeyStore(testDb.db).verificationKeys(
      tenant.environmentId,
      now
    )
    expect(keys.map((key) => key.kid)).toEqual([good])
  })
})

describe('PostgresSigningKeyStore writes', () => {
  function newKey(tenant: TestTenant, status: 'active' | 'next', createdAt = now) {
    const id = Bun.randomUUIDv7()
    return {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      status,
      publicJwk: {
        kty: 'OKP' as const,
        crv: 'Ed25519' as const,
        x: `x-${status}`,
        kid: id,
        alg: 'EdDSA' as const,
        use: 'sig' as const,
      },
      privateKeyCiphertext: 'v1.iv.ct',
      createdAt,
      activatedAt: status === 'active' ? createdAt : null,
    }
  }
  const store = () => new PostgresSigningKeyStore(testDb.db)

  test('bootstrap inserts atomically and reports a lost race instead of throwing', async () => {
    const tenant = await createTestTenant(testDb.db)
    expect(
      await store().insert(tenant.environmentId, [newKey(tenant, 'active'), newKey(tenant, 'next')])
    ).toBe(true)
    // A second instance racing to bootstrap: both slots are taken, nothing is inserted.
    const late = [newKey(tenant, 'active'), newKey(tenant, 'next')]
    expect(await store().insert(tenant.environmentId, late)).toBe(false)
    const keys = await store().list(tenant.environmentId)
    expect(keys.map((key) => key.status).sort()).toEqual(['active', 'next'])
    expect(keys.every((key) => key.publicJwk.kid === key.id)).toBe(true)
  })

  test('rotate applies all three steps, or none when the state moved on', async () => {
    const tenant = await createTestTenant(testDb.db)
    const active = newKey(tenant, 'active')
    const next = newKey(tenant, 'next', new Date(now.getTime() + 1))
    await store().insert(tenant.environmentId, [active, next])
    const at = new Date(now.getTime() + 60_000)
    const plan = { retireId: active.id, activateId: next.id, next: newKey(tenant, 'next', at) }
    expect(await store().rotate(tenant.environmentId, plan, at, Audit.none('fixture'))).toBe(true)
    const after = await store().list(tenant.environmentId)
    expect(after.map((key) => [key.id, key.status])).toEqual([
      [plan.next.id, 'next'],
      [next.id, 'active'],
      [active.id, 'retired'],
    ])
    expect(after.find((key) => key.id === active.id)?.retiredAt).toEqual(at)
    expect(after.find((key) => key.id === next.id)?.activatedAt).toEqual(at)

    // Replaying the same plan (a concurrent rotation that lost) changes nothing.
    const stale = { ...plan, next: newKey(tenant, 'next', at) }
    expect(await store().rotate(tenant.environmentId, stale, at, Audit.none('fixture'))).toBe(false)
    expect((await store().list(tenant.environmentId)).length).toBe(3)
  })

  test('a stale rotation cannot re-retire a key and extend its verification window', async () => {
    const tenant = await createTestTenant(testDb.db)
    const retiredAt = new Date(now.getTime() - 1000)
    const retired = { ...newKey(tenant, 'active'), status: 'retired' as const }
    const active = newKey(tenant, 'active')
    await store().insert(tenant.environmentId, [retired, active])
    await withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.update(signingKeys).set({ retiredAt }).where(eq(signingKeys.id, retired.id))
    )
    // The next slot is empty, so only the status guards stop this replay.
    const stale = { retireId: retired.id, activateId: active.id, next: newKey(tenant, 'next') }
    expect(await store().rotate(tenant.environmentId, stale, now, Audit.none('fixture'))).toBe(
      false
    )
    const after = await store().list(tenant.environmentId)
    expect(after.find((key) => key.id === retired.id)?.retiredAt).toEqual(retiredAt)
    expect(after.map((key) => key.status).sort()).toEqual(['active', 'retired'])
  })

  test('rotate cannot touch another environment’s keys', async () => {
    const mine = await createTestTenant(testDb.db)
    const theirs = await createTestTenant(testDb.db)
    const active = newKey(theirs, 'active')
    const next = newKey(theirs, 'next')
    await store().insert(theirs.environmentId, [active, next])
    const plan = { retireId: active.id, activateId: next.id, next: newKey(mine, 'next') }
    expect(await store().rotate(mine.environmentId, plan, now, Audit.none('fixture'))).toBe(false)
    expect((await store().list(theirs.environmentId)).map((key) => key.status).sort()).toEqual([
      'active',
      'next',
    ])
  })

  test('unexpected write errors still propagate', async () => {
    const tenant = await createTestTenant(testDb.db)
    const orphan = { ...newKey(tenant, 'active'), projectId: Bun.randomUUIDv7() }
    await expect(store().insert(tenant.environmentId, [orphan])).rejects.toThrow()
  })
})

describe('databaseProbe', () => {
  test('passes against a reachable database', async () => {
    const probe = databaseProbe(testDb.db)
    expect(probe.name).toBe('database')
    await expect(probe.check()).resolves.toBeUndefined()
  })
})
