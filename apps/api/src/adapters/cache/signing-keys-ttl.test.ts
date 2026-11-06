import { describe, expect, test } from 'bun:test'
import { cacheSigningKeys } from '~/adapters/cache/signing-keys'
import { FixedClock } from '~/adapters/memory/clock'
import { SIGNING_KEY_CACHE_TTL_MS } from '~/container'
import { RETIRED_KEY_RETENTION_MS, type SigningKeyStore } from '~/ports/signing-key-store'

const store: SigningKeyStore = {
  verificationKeys: async () => [],
  list: async () => [],
  insert: async () => true,
  rotate: async () => true,
}

// H-228: a cache hit cannot tell a key has left its verification window, so the TTL must stay
// below the retention window or a retired key would outlive it.
describe('cacheSigningKeys TTL bound', () => {
  test('refuses a TTL that reaches the retired-key retention window', () => {
    expect(() => cacheSigningKeys(store, new FixedClock(), RETIRED_KEY_RETENTION_MS)).toThrow()
  })

  test('the container TTL is below the retention window', () => {
    expect(SIGNING_KEY_CACHE_TTL_MS).toBeLessThan(RETIRED_KEY_RETENTION_MS)
  })
})
