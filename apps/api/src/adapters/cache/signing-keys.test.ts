import { describe, expect, test } from 'bun:test'
import type { Jwk } from '@tula/contract'
import { cacheSigningKeys } from '~/adapters/cache/signing-keys'
import { FixedClock } from '~/adapters/memory/clock'
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
