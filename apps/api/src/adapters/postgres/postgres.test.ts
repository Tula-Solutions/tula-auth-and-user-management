import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { apiKeys, signingKeys, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { PostgresApiKeyRepository } from '~/adapters/postgres/api-keys'
import { databaseProbe } from '~/adapters/postgres/health'
import { PostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
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
  test('finds a key by hash, including revoked keys', async () => {
    const revokedAt = new Date('2026-01-02T00:00:00Z')
    const [row] = await testDb.db
      .insert(apiKeys)
      .values({
        projectId: a.projectId,
        environmentId: a.environmentId,
        kind: 'secret',
        name: 'Server',
        keyHash: 'h'.repeat(64),
        lastFour: 'abcd',
        revokedAt,
      })
      .returning({ id: apiKeys.id })
    if (!row) {
      throw new Error('api key insert returned no row')
    }
    const repo = new PostgresApiKeyRepository(testDb.db)
    expect(await repo.findByHash('h'.repeat(64))).toEqual({
      id: row.id,
      kind: 'secret',
      projectId: a.projectId,
      environmentId: a.environmentId,
      revokedAt,
    })
    expect(await repo.findByHash('0'.repeat(64))).toBeNull()
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
    const good = await insertKey(tenant, { status: 'active', x: 'good' })
    const keys = await new PostgresSigningKeyStore(testDb.db).verificationKeys(
      tenant.environmentId,
      now
    )
    expect(keys.map((key) => key.kid)).toEqual([good])
  })
})

describe('databaseProbe', () => {
  test('passes against a reachable database', async () => {
    const probe = databaseProbe(testDb.db)
    expect(probe.name).toBe('database')
    await expect(probe.check()).resolves.toBeUndefined()
  })
})
