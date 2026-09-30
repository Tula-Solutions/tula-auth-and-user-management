import { describe, expect, test } from 'bun:test'
import type { Jwk } from '@tula/contract'
import { MemoryApiKeyRepository } from '~/adapters/memory/api-keys'
import { FixedClock, TEST_EPOCH } from '~/adapters/memory/clock'
import { MemoryEnvironmentRepository } from '~/adapters/memory/environments'
import { SequentialIds } from '~/adapters/memory/ids'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MemorySigningKeyStore } from '~/adapters/memory/signing-keys'
import { systemClock } from '~/adapters/system/clock'
import { uuidV7Ids } from '~/adapters/system/ids'
import { RETIRED_KEY_RETENTION_MS } from '~/ports/signing-key-store'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function jwk(kid: string): Jwk {
  return { kty: 'OKP', crv: 'Ed25519', x: 'x', kid, alg: 'EdDSA', use: 'sig' }
}

describe('FixedClock', () => {
  test('starts at the test epoch and returns copies', () => {
    const clock = new FixedClock()
    const now = clock.now()
    now.setFullYear(2000)
    expect(clock.now()).toEqual(TEST_EPOCH)
  })

  test('advances by durations or milliseconds and can be set', () => {
    const clock = new FixedClock()
    clock.advance('10m')
    clock.advance(500)
    expect(clock.now().getTime() - TEST_EPOCH.getTime()).toBe(600_500)
    clock.set(new Date('2030-01-01T00:00:00Z'))
    expect(clock.now().toISOString()).toBe('2030-01-01T00:00:00.000Z')
  })
})

describe('id generators', () => {
  test('SequentialIds yields valid, ordered UUIDs', () => {
    const ids = new SequentialIds()
    expect(ids.next()).toBe('00000000-0000-7000-8000-000000000001')
    expect(ids.next()).toMatch(UUID)
  })

  test('uuidV7Ids yields v7 UUIDs', () => {
    expect(uuidV7Ids.next()).toMatch(UUID)
  })

  test('systemClock reads the wall clock', () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000)
  })
})

function newKey(id: string, environmentId: string, createdAt: Date, keyHash = `hash-${id}`) {
  return {
    id,
    kind: 'publishable' as const,
    name: id,
    projectId: 'p1',
    environmentId,
    lastFour: 'abcd',
    createdAt,
    keyHash,
  }
}

describe('MemoryApiKeyRepository', () => {
  test('finds by hash without exposing the hash', async () => {
    const repo = new MemoryApiKeyRepository()
    const stored = await repo.insert(newKey('k1', 'e1', TEST_EPOCH))
    expect(stored).not.toHaveProperty('keyHash')
    expect(stored).toMatchObject({ id: 'k1', lastUsedAt: null, revokedAt: null })
    expect(await repo.findByHash('hash-k1')).toEqual(stored)
    expect(await repo.findByHash('other')).toBeNull()
  })

  test('rejects a duplicate hash like the unique index does', async () => {
    const repo = new MemoryApiKeyRepository()
    await repo.insert(newKey('k1', 'e1', TEST_EPOCH, 'same'))
    await expect(repo.insert(newKey('k2', 'e1', TEST_EPOCH, 'same'))).rejects.toThrow()
  })

  test('lists one environment newest first', async () => {
    const repo = new MemoryApiKeyRepository()
    const later = new Date(TEST_EPOCH.getTime() + 1000)
    await repo.insert(newKey('old', 'e1', TEST_EPOCH))
    await repo.insert(newKey('new', 'e1', later))
    await repo.insert(newKey('tie', 'e1', TEST_EPOCH))
    await repo.insert(newKey('elsewhere', 'e2', later))
    expect((await repo.listByEnvironment('e1')).map((key) => key.id)).toEqual(['new', 'tie', 'old'])
  })

  test('revokes only within the given environment and keeps the first time', async () => {
    const repo = new MemoryApiKeyRepository()
    await repo.insert(newKey('k1', 'e1', TEST_EPOCH))
    expect(await repo.revoke('e2', 'k1', TEST_EPOCH)).toBeNull()
    expect((await repo.revoke('e1', 'k1', TEST_EPOCH))?.revokedAt).toEqual(TEST_EPOCH)
    const later = new Date(TEST_EPOCH.getTime() + 5000)
    expect((await repo.revoke('e1', 'k1', later))?.revokedAt).toEqual(TEST_EPOCH)
  })
})

describe('MemoryApiKeyRepository.touch', () => {
  test('sets the last used time of an existing key', async () => {
    const repo = new MemoryApiKeyRepository()
    await repo.insert(newKey('k1', 'e1', TEST_EPOCH))
    await repo.touch('k1', TEST_EPOCH)
    await repo.touch('missing', TEST_EPOCH)
    expect((await repo.findByHash('hash-k1'))?.lastUsedAt).toEqual(TEST_EPOCH)
  })
})

describe('MemoryEnvironmentRepository', () => {
  test('finds by id and lists a project development-first', async () => {
    const repo = new MemoryEnvironmentRepository()
    repo.add({ id: 'prod', projectId: 'p1', kind: 'production', createdAt: TEST_EPOCH })
    repo.add({ id: 'dev', projectId: 'p1', kind: 'development', createdAt: TEST_EPOCH })
    repo.add({ id: 'other', projectId: 'p2', kind: 'development', createdAt: TEST_EPOCH })
    expect((await repo.findById('prod'))?.kind).toBe('production')
    expect(await repo.findById('missing')).toBeNull()
    expect((await repo.listByProject('p1')).map((env) => env.id)).toEqual(['dev', 'prod'])
  })
})

describe('MemorySigningKeyStore', () => {
  test('returns an environment’s next, active and recently retired keys', async () => {
    const store = new MemorySigningKeyStore()
    const now = TEST_EPOCH
    const justRetired = new Date(now.getTime() - RETIRED_KEY_RETENTION_MS + 1)
    const longRetired = new Date(now.getTime() - RETIRED_KEY_RETENTION_MS)
    store.add({ environmentId: 'e1', jwk: jwk('active'), status: 'active' })
    store.add({ environmentId: 'e1', jwk: jwk('next'), status: 'next' })
    store.add({
      environmentId: 'e1',
      jwk: jwk('recent'),
      status: 'retired',
      retiredAt: justRetired,
    })
    store.add({ environmentId: 'e1', jwk: jwk('old'), status: 'retired', retiredAt: longRetired })
    store.add({ environmentId: 'e1', jwk: jwk('undated'), status: 'retired' })
    store.add({ environmentId: 'e2', jwk: jwk('other-env'), status: 'active' })
    const kids = (await store.verificationKeys('e1', now)).map((key) => key.kid)
    expect(kids).toEqual(['active', 'next', 'recent'])
  })
})

describe('MemoryRateLimiter', () => {
  test('allows up to the limit per window, then reports time to reset', async () => {
    const clock = new FixedClock()
    const limiter = new MemoryRateLimiter(clock)
    expect(await limiter.hit('k', 2, 60_000)).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterMs: 60_000,
    })
    await limiter.hit('k', 2, 60_000)
    clock.advance('15s')
    expect(await limiter.hit('k', 2, 60_000)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 45_000,
    })
    expect((await limiter.hit('other', 2, 60_000)).allowed).toBe(true)
  })

  test('starts a new window once the old one ends', async () => {
    const clock = new FixedClock()
    const limiter = new MemoryRateLimiter(clock)
    await limiter.hit('k', 1, 1_000)
    expect((await limiter.hit('k', 1, 1_000)).allowed).toBe(false)
    clock.advance(1_000)
    expect((await limiter.hit('k', 1, 1_000)).allowed).toBe(true)
  })

  test('sweeps expired buckets so key churn cannot grow memory forever', async () => {
    const clock = new FixedClock()
    const limiter = new MemoryRateLimiter(clock)
    for (let i = 0; i < 999; i++) {
      await limiter.hit(`old-${i}`, 1, 1_000)
    }
    clock.advance(1_000)
    await limiter.hit('trigger', 1, 1_000)
    expect(limiter.size).toBe(1)
  })
})
