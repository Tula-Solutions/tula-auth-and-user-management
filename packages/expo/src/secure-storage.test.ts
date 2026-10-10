import { describe, expect, test } from 'bun:test'
import {
  MAX_SECURE_VALUE_BYTES,
  SECURE_WRITE_RETRY_DELAYS_MS,
  secureStoreKey,
  secureStoreStorage,
} from './secure-storage'
import {
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  fakeSecureStore,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY,
} from './testing/fake-secure-store'

/** The key `@tula/core` names its refresh token's entry with. */
const CORE_KEY = 'tula.refresh.https://auth.example.com|tula_pk_dev_unit00000000000000000000000000'

describe('the secure-store key', () => {
  test('is one the secure store accepts, whatever the client named its entry', () => {
    for (const key of [
      CORE_KEY,
      'tula.refresh.http://localhost:3003|tula_pk_dev_x',
      'tula.refresh.https://auth.example.com/tenant a/ü|k',
      '_',
      'a b',
      '😀',
    ]) {
      expect(secureStoreKey(key)).toMatch(/^[A-Za-z0-9._-]+$/)
    }
  })

  test('is written out: every other character as its UTF-8 bytes', () => {
    expect(secureStoreKey('tula.refresh.https://auth.example.com')).toBe(
      'tula.refresh.https_3a_2f_2fauth.example.com'
    )
    expect(secureStoreKey('a_b')).toBe('a_5fb')
    expect(secureStoreKey('é')).toBe('_c3_a9')
    expect(secureStoreKey('€')).toBe('_e2_82_ac')
    expect(secureStoreKey('😀')).toBe('_f0_9f_98_80')
    expect(secureStoreKey('plain-Key.9')).toBe('plain-Key.9')
  })

  test('two different keys never share an entry', () => {
    // Pairs a careless encoding would fold together: the escape character itself, an escape
    // written out by hand, two separators, case.
    const keys = [
      'a_b',
      'a_5fb',
      'a:b',
      'a_3ab',
      'a/b',
      'a|b',
      'a b',
      'ab',
      'A_b',
      'a__b',
      'a_5f_5fb',
    ]
    expect(new Set(keys.map(secureStoreKey)).size).toBe(keys.length)
  })
})

describe('the storage adapter', () => {
  test('stores, reads and deletes under the encoded key, this device only, readable while unlocked', async () => {
    const store = fakeSecureStore()
    const storage = secureStoreStorage(store)
    expect(await storage.get(CORE_KEY)).toBeNull()
    await storage.set(CORE_KEY, 'rt_1')
    expect(await storage.get(CORE_KEY)).toBe('rt_1')
    await storage.remove(CORE_KEY)
    expect(await storage.get(CORE_KEY)).toBeNull()
    // Deleting what is not there is not an error.
    await storage.remove(CORE_KEY)

    expect(store.calls.map((call) => call.operation)).toEqual([
      'get',
      'set',
      'get',
      'delete',
      'get',
      'delete',
    ])
    for (const call of store.calls) {
      expect(call.key).toBe(secureStoreKey(CORE_KEY))
      expect(call.options).toEqual({ keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY })
    }
  })

  test('after_first_unlock and a service of the app’s own are passed with every call', async () => {
    const store = fakeSecureStore()
    const storage = secureStoreStorage(store, {
      keychainAccess: 'after_first_unlock',
      keychainService: 'northline.auth',
    })
    await storage.set(CORE_KEY, 'rt_1')
    await storage.get(CORE_KEY)
    await storage.remove(CORE_KEY)
    for (const call of store.calls) {
      expect(call.options).toEqual({
        keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        keychainService: 'northline.auth',
      })
    }
    // Never the option that asks for a face or a fingerprint on every refresh.
    expect(JSON.stringify(store.calls)).not.toContain('requireAuthentication')
  })

  test('a class that would let the token leave the device cannot be asked for', () => {
    const store = fakeSecureStore()
    for (const keychainAccess of ['always', 'when_unlocked_synced', '', 3, null]) {
      expect(() => secureStoreStorage(store, { keychainAccess } as never)).toThrow(TypeError)
    }
    for (const keychainService of ['', 7, null]) {
      expect(() => secureStoreStorage(store, { keychainService } as never)).toThrow(TypeError)
    }
    expect(store.calls).toEqual([])
  })

  test('a value at the limit is stored; one byte over is refused before the store is asked, and the error does not hold it', async () => {
    const store = fakeSecureStore()
    const storage = secureStoreStorage(store)
    await storage.set(CORE_KEY, 'a'.repeat(MAX_SECURE_VALUE_BYTES))
    expect(store.calls).toHaveLength(1)

    const secret = `canary-${'z'.repeat(MAX_SECURE_VALUE_BYTES)}`
    const refused = await storage.set(CORE_KEY, secret).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(RangeError)
    expect(String((refused as Error).message)).not.toContain('canary')
    expect(store.calls).toHaveLength(1)
    // Bytes, not characters: 1,024 two-byte letters fit, 1,025 do not.
    await storage.set(CORE_KEY, 'é'.repeat(MAX_SECURE_VALUE_BYTES / 2))
    expect(
      await storage.set(CORE_KEY, 'é'.repeat(MAX_SECURE_VALUE_BYTES / 2 + 1)).catch(() => 'refused')
    ).toBe('refused')
    expect(await storage.get(CORE_KEY)).toBe('é'.repeat(MAX_SECURE_VALUE_BYTES / 2))
  })

  test('a store that refuses rejects: a failure is never read as "nothing stored"', async () => {
    const store = fakeSecureStore()
    const storage = secureStoreStorage(store)
    await storage.set(CORE_KEY, 'rt_1')
    const locked = new Error('User interaction is not allowed.')
    for (const operation of ['get', 'set', 'delete'] as const) {
      store.fail(operation, locked)
    }
    expect(await storage.get(CORE_KEY).catch((error: unknown) => error)).toBe(locked)
    expect(await storage.set(CORE_KEY, 'rt_2').catch((error: unknown) => error)).toBe(locked)
    expect(await storage.remove(CORE_KEY).catch((error: unknown) => error)).toBe(locked)
    for (const operation of ['get', 'set', 'delete'] as const) {
      store.fail(operation, null)
    }
    expect(await storage.get(CORE_KEY)).toBe('rt_1')
  })

  test('a write the store refuses is asked again, a bounded number of times, and only a write', async () => {
    const store = fakeSecureStore()
    const storage = secureStoreStorage(store)
    await storage.set(CORE_KEY, 'rt_1')
    const busy = new Error('The keychain is busy.')
    const asked = (operation: string) =>
      store.calls.filter((call) => call.operation === operation).length

    // Refused as often as there are waits: the last try gets through.
    store.fail('set', busy, SECURE_WRITE_RETRY_DELAYS_MS.length)
    await storage.set(CORE_KEY, 'rt_2')
    expect(asked('set')).toBe(1 + SECURE_WRITE_RETRY_DELAYS_MS.length + 1)
    expect(await storage.get(CORE_KEY)).toBe('rt_2')

    // Refused once more than that: the failure is the store's own, and nothing more is asked.
    const before = asked('set')
    store.fail('set', busy, SECURE_WRITE_RETRY_DELAYS_MS.length + 1)
    expect(await storage.set(CORE_KEY, 'rt_3').catch((error: unknown) => error)).toBe(busy)
    expect(asked('set') - before).toBe(SECURE_WRITE_RETRY_DELAYS_MS.length + 1)
    expect(await storage.get(CORE_KEY)).toBe('rt_2')

    // A read and a delete are asked once: a read that waited would hold a locked phone's
    // first screen, and a delete has nothing a second try protects.
    store.fail('get', busy, 1)
    store.fail('delete', busy, 1)
    const reads = asked('get')
    expect(await storage.get(CORE_KEY).catch((error: unknown) => error)).toBe(busy)
    expect(await storage.remove(CORE_KEY).catch((error: unknown) => error)).toBe(busy)
    expect(asked('get') - reads).toBe(1)
    expect(asked('delete')).toBe(1)
    // The whole wait is far inside a refresh's own time limit.
    expect(SECURE_WRITE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(1_000)
  })

  test('a write that is waiting to be tried again never undoes a sign-out', async () => {
    const store = fakeSecureStore()
    const storage = secureStoreStorage(store)
    await storage.set(CORE_KEY, 'rt_1')
    const busy = new Error('The keychain is busy.')
    store.fail('set', busy, 1)
    const writing = storage.set(CORE_KEY, 'rt_2').catch((error: unknown) => error)
    // Signed out while the write waits for its second try.
    await storage.remove(CORE_KEY)
    expect(await writing).toBe(busy)
    expect([...store.entries]).toEqual([])
    expect(store.calls.filter((call) => call.operation === 'set')).toHaveLength(2)
  })

  test('a write that is waiting to be tried again never lands on a newer one', async () => {
    const store = fakeSecureStore()
    const storage = secureStoreStorage(store)
    const busy = new Error('The keychain is busy.')
    store.fail('set', busy, 1)
    const older = storage.set(CORE_KEY, 'rt_2').catch((error: unknown) => error)
    await storage.set(CORE_KEY, 'rt_3')
    expect(await older).toBe(busy)
    expect(await storage.get(CORE_KEY)).toBe('rt_3')
  })

  test('what the store hands back that is no token reads as none', async () => {
    const store = fakeSecureStore()
    const storage = secureStoreStorage(store)
    store.entries.set(`/${secureStoreKey(CORE_KEY)}`, '')
    expect(await storage.get(CORE_KEY)).toBeNull()
    store.getItemAsync = async () => 42 as never
    expect(await storage.get(CORE_KEY)).toBeNull()
  })
})
