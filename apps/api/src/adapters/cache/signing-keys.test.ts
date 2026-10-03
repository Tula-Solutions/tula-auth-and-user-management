import { describe, expect, spyOn, test } from 'bun:test'
import type { Jwk } from '@tula/contract'
import { cacheSigningKeys, type SigningKeyVersions } from '~/adapters/cache/signing-keys'
import { FixedClock } from '~/adapters/memory/clock'
import { FakeRedis } from '~/adapters/redis/fake'
import { RedisSigningKeyVersions } from '~/adapters/redis/signing-key-versions'
import * as logger from '~/lib/logger'
import type { SigningKeyStore } from '~/ports/signing-key-store'

const key: Jwk = { kty: 'OKP', crv: 'Ed25519', x: 'x', kid: 'k1', alg: 'EdDSA', use: 'sig' }

function countingStore(impl: () => Promise<Jwk[]> = async () => [key]) {
  const calls: string[] = []
  const store: SigningKeyStore = {
    verificationKeys(environmentId) {
      calls.push(environmentId)
      return impl()
    },
    list: async () => [],
    insert: async () => true,
    rotate: async () => true,
  }
  return { store, calls }
}

describe('cacheSigningKeys', () => {
  test('serves repeat lookups from cache until the TTL passes', async () => {
    const clock = new FixedClock()
    const { store, calls } = countingStore()
    const cached = cacheSigningKeys(store, clock, 60_000)
    const first = await cached.verificationKeys('e1', clock.now())
    clock.advance(59_999)
    expect(await cached.verificationKeys('e1', clock.now())).toBe(first)
    expect(calls).toEqual(['e1'])
    clock.advance(1)
    await cached.verificationKeys('e1', clock.now())
    expect(calls).toEqual(['e1', 'e1'])
  })

  test('caches each environment separately', async () => {
    const clock = new FixedClock()
    const { store, calls } = countingStore()
    const cached = cacheSigningKeys(store, clock, 60_000)
    await cached.verificationKeys('e1', clock.now())
    await cached.verificationKeys('e2', clock.now())
    expect(calls).toEqual(['e1', 'e2'])
  })

  test('shares one fetch between concurrent misses', async () => {
    const clock = new FixedClock()
    const { store, calls } = countingStore()
    const cached = cacheSigningKeys(store, clock, 60_000)
    await Promise.all([
      cached.verificationKeys('e1', clock.now()),
      cached.verificationKeys('e1', clock.now()),
    ])
    expect(calls).toHaveLength(1)
  })

  test('does not cache a failed fetch', async () => {
    const clock = new FixedClock()
    let fail = true
    const { store, calls } = countingStore(async () => {
      if (fail) {
        throw new Error('database down')
      }
      return [key]
    })
    const cached = cacheSigningKeys(store, clock, 60_000)
    await expect(cached.verificationKeys('e1', clock.now())).rejects.toThrow('database down')
    fail = false
    expect(await cached.verificationKeys('e1', clock.now())).toEqual([key])
    expect(calls).toHaveLength(2)
  })

  test('writes pass through and drop the environment’s cached keys', async () => {
    const clock = new FixedClock()
    const { store, calls } = countingStore()
    const cached = cacheSigningKeys(store, clock, 60_000)
    await cached.verificationKeys('e1', clock.now())
    await cached.verificationKeys('e2', clock.now())
    expect(await cached.list('e1')).toEqual([])
    expect(await cached.insert('e1', [])).toBe(true)
    await cached.verificationKeys('e1', clock.now())
    await cached.verificationKeys('e2', clock.now())
    expect(calls).toEqual(['e1', 'e2', 'e1'])
    const plan = { retireId: 'a', activateId: 'b', next: {} as never }
    expect(await cached.rotate('e2', plan, clock.now())).toBe(true)
    await cached.verificationKeys('e2', clock.now())
    expect(calls).toEqual(['e1', 'e2', 'e1', 'e2'])
  })

  test('never caches an empty key set, which only exists before bootstrap', async () => {
    const clock = new FixedClock()
    let keys: Jwk[] = []
    const { store, calls } = countingStore(async () => keys)
    const cached = cacheSigningKeys(store, clock, 60_000)
    expect(await cached.verificationKeys('e1', clock.now())).toEqual([])
    keys = [key]
    // Another instance bootstrapped: the very next lookup must see the key.
    expect(await cached.verificationKeys('e1', clock.now())).toEqual([key])
    await cached.verificationKeys('e1', clock.now())
    expect(calls).toHaveLength(2)
  })
})

describe('cacheSigningKeys across instances', () => {
  const TTL = 60_000
  const CHECK = 5_000
  const plan = { retireId: 'a', activateId: 'b', next: {} as never }

  /** Two instances over one key store (Postgres) and one marker store (Redis). */
  function instances(impl?: () => Promise<Jwk[]>) {
    const clock = new FixedClock()
    const redis = new FakeRedis(clock)
    const { store, calls } = countingStore(impl)
    const instance = () =>
      cacheSigningKeys(store, clock, TTL, {
        versions: new RedisSigningKeyVersions(redis),
        checkEveryMs: CHECK,
      })
    return { clock, redis, store, calls, a: instance(), b: instance() }
  }

  test('a rotation on one instance reaches the other within the check interval', async () => {
    let current = [key]
    const { clock, calls, a, b } = instances(async () => current)
    const before = await b.verificationKeys('e1', clock.now())
    expect(calls).toHaveLength(1)

    current = [{ ...key, kid: 'k2' }]
    expect(await a.rotate('e1', plan, clock.now())).toBe(true)

    // Until its next check the other instance still serves what it has.
    clock.advance(CHECK - 1)
    expect(await b.verificationKeys('e1', clock.now())).toBe(before)
    expect(calls).toHaveLength(1)
    // At the check it sees the new marker and refetches, long before the TTL.
    clock.advance(1)
    expect(await b.verificationKeys('e1', clock.now())).toEqual([{ ...key, kid: 'k2' }])
    expect(calls).toHaveLength(2)
  })

  test('new keys inserted by one instance reach the other the same way', async () => {
    let current = [key]
    const { clock, calls, a, b } = instances(async () => current)
    await b.verificationKeys('e1', clock.now())
    current = [key, { ...key, kid: 'k2' }]
    expect(await a.insert('e1', [])).toBe(true)
    clock.advance(CHECK)
    expect(await b.verificationKeys('e1', clock.now())).toHaveLength(2)
    expect(calls).toHaveLength(2)
  })

  test('an unchanged marker costs no refetch, and the same array keeps being served', async () => {
    const { clock, calls, a } = instances()
    const first = await a.verificationKeys('e1', clock.now())
    for (let i = 0; i < 5; i++) {
      clock.advance(CHECK)
      expect(await a.verificationKeys('e1', clock.now())).toBe(first)
    }
    expect(calls).toHaveLength(1)
  })

  test('the marker is checked at most once per interval, whatever the traffic', async () => {
    const clock = new FixedClock()
    const reads: string[] = []
    const versions: SigningKeyVersions = {
      async current(environmentId) {
        reads.push(environmentId)
        return 'v1'
      },
      bump: async () => {},
    }
    const { store } = countingStore()
    const cached = cacheSigningKeys(store, clock, TTL, { versions, checkEveryMs: CHECK })
    await cached.verificationKeys('e1', clock.now())
    expect(reads).toHaveLength(1)
    clock.advance(CHECK)
    await Promise.all(Array.from({ length: 20 }, () => cached.verificationKeys('e1', clock.now())))
    clock.advance(CHECK - 1)
    await cached.verificationKeys('e1', clock.now())
    expect(reads).toHaveLength(2)
  })

  test('a write that changed nothing announces nothing', async () => {
    const clock = new FixedClock()
    const redis = new FakeRedis(clock)
    const store: SigningKeyStore = {
      verificationKeys: async () => [key],
      list: async () => [],
      insert: async () => false,
      rotate: async () => false,
    }
    const cached = cacheSigningKeys(store, clock, TTL, {
      versions: new RedisSigningKeyVersions(redis),
      checkEveryMs: CHECK,
    })
    expect(await cached.insert('e1', [])).toBe(false)
    expect(await cached.rotate('e1', plan, clock.now())).toBe(false)
    expect(redis.keys()).toEqual([])
  })

  test('when the marker cannot be read the cache is still served, until the TTL', async () => {
    let current = [key]
    const { clock, redis, calls, a, b } = instances(async () => current)
    const before = await b.verificationKeys('e1', clock.now())
    current = [{ ...key, kid: 'k2' }]
    await a.rotate('e1', plan, clock.now())
    redis.fail()
    clock.advance(CHECK)
    expect(await b.verificationKeys('e1', clock.now())).toBe(before)
    clock.advance(TTL - CHECK - 1)
    expect(await b.verificationKeys('e1', clock.now())).toBe(before)
    expect(calls).toHaveLength(1)
    // The TTL is the bound that never depends on the shared store.
    clock.advance(1)
    expect(await b.verificationKeys('e1', clock.now())).toEqual([{ ...key, kid: 'k2' }])
  })

  test('keys fetched while the marker was unreadable are refetched once it is readable', async () => {
    const { clock, redis, calls, b } = instances()
    redis.fail()
    await b.verificationKeys('e1', clock.now())
    redis.recover()
    clock.advance(CHECK)
    await b.verificationKeys('e1', clock.now())
    expect(calls).toHaveLength(2)
    // From then on the marker matches.
    clock.advance(CHECK)
    await b.verificationKeys('e1', clock.now())
    expect(calls).toHaveLength(2)
  })

  test('a rotation still succeeds when it cannot be announced, and says so in the log', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const { clock, redis, a } = instances()
    redis.fail()
    expect(await a.rotate('e1', plan, clock.now())).toBe(true)
    expect(warn.mock.calls).toEqual([
      [
        'could not announce new signing keys; other instances catch up at cache expiry',
        { environmentId: 'e1', reason: 'ServiceUnavailableError' },
      ],
    ])
    warn.mockRestore()
  })

  test('a failed announcement that is not an Error is still only logged', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const clock = new FixedClock()
    const { store } = countingStore()
    const versions: SigningKeyVersions = {
      current: async () => null,
      bump: () => Promise.reject('nope'),
    }
    const cached = cacheSigningKeys(store, clock, TTL, { versions, checkEveryMs: CHECK })
    expect(await cached.insert('e1', [])).toBe(true)
    expect(warn.mock.calls[0]?.[1]).toEqual({ environmentId: 'e1', reason: 'NonError' })
    warn.mockRestore()
  })

  test('two checks that both find a change share one refetch', async () => {
    let current = [key]
    const { clock, calls, a, b } = instances(async () => current)
    await b.verificationKeys('e1', clock.now())
    current = [{ ...key, kid: 'k2' }]
    await a.rotate('e1', plan, clock.now())
    clock.advance(CHECK)
    const stale = b.verificationKeys('e1', clock.now())
    // A later check, started before the first one finished refetching.
    clock.advance(CHECK)
    const [first, second] = await Promise.all([stale, b.verificationKeys('e1', clock.now())])
    expect(first).toEqual([{ ...key, kid: 'k2' }])
    expect(second).toBe(first)
    expect(calls).toHaveLength(2)
  })
})
