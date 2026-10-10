import { describe, expect, test } from 'bun:test'
import {
  MAX_SECURE_VALUE_BYTES,
  SECURE_REWRITE_DELAYS_MS,
  SECURE_WRITE_RETRY_DELAYS_MS,
  secureStoreKey,
  secureStoreStorage,
} from './secure-storage'
import { fakeSchedule } from './testing/fake-schedule'
import {
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  fakeSecureStore,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY,
} from './testing/fake-secure-store'

/** The longest of the waits inside a write: a fake schedule runs those by itself. */
const SHORT = Math.max(...SECURE_WRITE_RETRY_DELAYS_MS)

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
    const time = fakeSchedule(SHORT)
    const storage = secureStoreStorage(store, {}, time.schedule)
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
    // It waited for exactly what the list says, twice over, and then for the first later try.
    expect(time.asked).toEqual([
      ...SECURE_WRITE_RETRY_DELAYS_MS,
      ...SECURE_WRITE_RETRY_DELAYS_MS,
      SECURE_REWRITE_DELAYS_MS[0] as number,
    ])

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
    const storage = secureStoreStorage(store, {}, fakeSchedule(SHORT).schedule)
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
    const storage = secureStoreStorage(store, {}, fakeSchedule(SHORT).schedule)
    const busy = new Error('The keychain is busy.')
    store.fail('set', busy, 1)
    const older = storage.set(CORE_KEY, 'rt_2').catch((error: unknown) => error)
    await storage.set(CORE_KEY, 'rt_3')
    expect(await older).toBe(busy)
    expect(await storage.get(CORE_KEY)).toBe('rt_3')
  })

  test('with nothing passed the waits are real timers: a refused write is taken a moment later', async () => {
    // The one test on the runtime's own timers (one wait of 50 ms).
    const store = fakeSecureStore()
    const storage = secureStoreStorage(store)
    store.fail('set', new Error('The keychain is busy.'), 1)
    const started = performance.now()
    await storage.set(CORE_KEY, 'rt_1')
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      (SECURE_WRITE_RETRY_DELAYS_MS[0] as number) - 5
    )
    expect(await storage.get(CORE_KEY)).toBe('rt_1')
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

describe('a write the store refused three times is offered again, later', () => {
  const busy = new Error('The keychain is busy.')
  const sets = (store: ReturnType<typeof fakeSecureStore>) =>
    store.calls.filter((call) => call.operation === 'set').length
  const [first, second] = SECURE_REWRITE_DELAYS_MS as [number, number]

  /** A store holding `rt_1` whose write of `rt_2` has just been refused three times. */
  async function refused(schedule = fakeSchedule(SHORT)) {
    const store = fakeSecureStore()
    const storage = secureStoreStorage(store, {}, schedule.schedule)
    await storage.set(CORE_KEY, 'rt_1')
    store.fail('set', busy)
    expect(await storage.set(CORE_KEY, 'rt_2').catch((error: unknown) => error)).toBe(busy)
    expect(await storage.get(CORE_KEY)).toBe('rt_1')
    expect(schedule.pending()).toBe(1)
    return { store, storage, time: schedule }
  }

  test('the store works again: the next try stores the newest value, with nobody asking, and nothing waits after', async () => {
    const { store, storage, time } = await refused()
    const before = sets(store)
    store.fail('set', null)
    await time.advance(first - 1)
    expect(sets(store)).toBe(before)
    await time.advance(1)
    expect(sets(store) - before).toBe(1)
    expect(await storage.get(CORE_KEY)).toBe('rt_2')
    expect(time.pending()).toBe(0)
    await time.advance(60_000)
    expect(sets(store) - before).toBe(1)
  })

  test('the store keeps refusing: two later tries and no more, and no timer is left', async () => {
    const { store, storage, time } = await refused()
    const before = sets(store)
    await time.advance(first)
    expect(sets(store) - before).toBe(1)
    expect(time.pending()).toBe(1)
    await time.advance(second)
    expect(sets(store) - before).toBe(2)
    expect(time.pending()).toBe(0)
    await time.advance(3_600_000)
    expect(sets(store) - before).toBe(SECURE_REWRITE_DELAYS_MS.length)
    expect(await storage.get(CORE_KEY)).toBe('rt_1')
    // Few, and soon over: the list is the bound.
    expect(SECURE_REWRITE_DELAYS_MS.length).toBeLessThanOrEqual(2)
    expect(first + second).toBeLessThanOrEqual(10_000)
  })

  test('refused at the first later try and taken at the second', async () => {
    const { store, storage, time } = await refused()
    await time.advance(first)
    store.fail('set', null)
    await time.advance(second)
    expect(await storage.get(CORE_KEY)).toBe('rt_2')
    expect(time.pending()).toBe(0)
  })

  test('a sign-out while a later try waits calls it off: the store stays empty', async () => {
    const { store, storage, time } = await refused()
    store.fail('set', null)
    const before = sets(store)
    await storage.remove(CORE_KEY)
    expect(time.pending()).toBe(0)
    await time.advance(60_000)
    expect(sets(store)).toBe(before)
    expect([...store.entries]).toEqual([])
  })

  test('a newer write while a later try waits calls it off: the newer value stays', async () => {
    const { store, storage, time } = await refused()
    store.fail('set', null)
    await storage.set(CORE_KEY, 'rt_3')
    expect(time.pending()).toBe(0)
    const before = sets(store)
    await time.advance(60_000)
    expect(sets(store)).toBe(before)
    expect(await storage.get(CORE_KEY)).toBe('rt_3')
  })

  test('a newer write that is refused too takes the later tries over: the older value is never written', async () => {
    const { store, storage, time } = await refused()
    expect(await storage.set(CORE_KEY, 'rt_3').catch((error: unknown) => error)).toBe(busy)
    expect(time.pending()).toBe(1)
    store.fail('set', null)
    await time.advance(first)
    expect(await storage.get(CORE_KEY)).toBe('rt_3')
    expect(time.pending()).toBe(0)
  })

  /** Hold the store's next write open until the test lets it go; later writes go straight through. */
  function holdNextWrite(store: ReturnType<typeof fakeSecureStore>) {
    const real = store.setItemAsync.bind(store)
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    store.setItemAsync = async (key, value, options) => {
      if (first) {
        first = false
        await held
      }
      return real(key, value, options)
    }
    return () => release()
  }
  const deletes = (store: ReturnType<typeof fakeSecureStore>) =>
    store.calls.filter((call) => call.operation === 'delete').length

  test('a sign-out while a later try is already in the store’s hands: the value it lands is deleted again', async () => {
    const { store, storage, time } = await refused()
    store.fail('set', null)
    const release = holdNextWrite(store)
    await time.advance(first)
    // The later try is inside the store now: no timer waits, and nothing can call it off.
    expect(time.pending()).toBe(0)
    await storage.remove(CORE_KEY)
    expect([...store.entries]).toEqual([])
    release()
    await time.advance(0)
    expect([...store.entries]).toEqual([])
    // The sign-out's own delete, and one more for what landed after it. One, not a loop.
    expect(deletes(store)).toBe(2)
    await time.advance(60_000)
    expect(deletes(store)).toBe(2)
    expect(time.pending()).toBe(0)
  })

  test('the delete after a late landing is asked once: refused, nothing is thrown and nothing is tried again', async () => {
    const { store, storage, time } = await refused()
    store.fail('set', null)
    const release = holdNextWrite(store)
    await time.advance(first)
    await storage.remove(CORE_KEY)
    store.fail('delete', busy)
    release()
    await time.advance(60_000)
    expect(deletes(store)).toBe(2)
    expect(time.pending()).toBe(0)
    // Said as it is: the store refused the delete, so what landed is still there.
    expect([...store.entries].map(([, value]) => value)).toEqual(['rt_2'])
  })

  test('the delete after a late landing may throw at the call itself: nothing escapes', async () => {
    const { store, storage, time } = await refused()
    store.fail('set', null)
    const release = holdNextWrite(store)
    await time.advance(first)
    await storage.remove(CORE_KEY)
    store.deleteItemAsync = () => {
      throw busy
    }
    release()
    await time.advance(60_000)
    expect(time.pending()).toBe(0)
  })

  test('a newer write after a sign-out, both while a later try is in the store’s hands: no delete is added', async () => {
    const { store, storage, time } = await refused()
    store.fail('set', null)
    const release = holdNextWrite(store)
    await time.advance(first)
    await storage.remove(CORE_KEY)
    await storage.set(CORE_KEY, 'rt_3')
    release()
    await time.advance(60_000)
    // The newest thing asked is a write: deleting now would take a signed-in user's token.
    expect(deletes(store)).toBe(1)
  })

  test('this pins the fake store’s order, not a platform’s: a later try already in the store’s hands is not recalled by a newer write, and here it completes last', async () => {
    const { store, storage, time } = await refused()
    store.fail('set', null)
    const release = holdNextWrite(store)
    await time.advance(first)
    await storage.set(CORE_KEY, 'rt_3')
    expect(await storage.get(CORE_KEY)).toBe('rt_3')
    release()
    await time.advance(60_000)
    // The adapter asked for rt_2 first and rt_3 second and adds nothing: no delete, no
    // third write. This fake completes the held call last, so the older value is what stays.
    // Which of two writes in flight a Keychain or a Keystore completes last was not observed.
    expect(await storage.get(CORE_KEY)).toBe('rt_2')
    expect(deletes(store)).toBe(0)
    expect(time.pending()).toBe(0)
  })

  test('a store that throws at the call itself, at a later try: nothing escapes the timer and the next try is scheduled', async () => {
    const { store, storage, time } = await refused()
    const real = store.setItemAsync.bind(store)
    store.fail('set', null)
    store.setItemAsync = () => {
      throw busy
    }
    await time.advance(first)
    expect(time.pending()).toBe(1)
    store.setItemAsync = real
    await time.advance(second)
    expect(await storage.get(CORE_KEY)).toBe('rt_2')
    expect(time.pending()).toBe(0)
  })
})

describe('two adapters over one secure store', () => {
  // Two clients, or a client made again, write the same entry: each has to see the other's
  // newer write and sign-out.
  const busy = new Error('The keychain is busy.')

  test('a write that waits in one never lands on a newer write of the other', async () => {
    const store = fakeSecureStore()
    const time = fakeSchedule()
    const one = secureStoreStorage(store, {}, time.schedule)
    const other = secureStoreStorage(store, {}, time.schedule)
    store.fail('set', busy, 1)
    const older = one.set(CORE_KEY, 'rt_2').catch((error: unknown) => error)
    await time.advance(0)
    await other.set(CORE_KEY, 'rt_3')
    await time.advance(60_000)
    expect(await older).toBe(busy)
    expect(await other.get(CORE_KEY)).toBe('rt_3')
  })

  test('a write that waits in one never undoes a sign-out through the other', async () => {
    const store = fakeSecureStore()
    const time = fakeSchedule()
    const one = secureStoreStorage(store, {}, time.schedule)
    const other = secureStoreStorage(store, {}, time.schedule)
    await one.set(CORE_KEY, 'rt_1')
    store.fail('set', busy, 1)
    const older = one.set(CORE_KEY, 'rt_2').catch((error: unknown) => error)
    await time.advance(0)
    await other.remove(CORE_KEY)
    await time.advance(60_000)
    expect(await older).toBe(busy)
    expect([...store.entries]).toEqual([])
  })

  test('a later try of one is called off by a write or a sign-out of the other', async () => {
    for (const act of ['write', 'sign out'] as const) {
      const store = fakeSecureStore()
      const time = fakeSchedule(SHORT)
      const one = secureStoreStorage(store, {}, time.schedule)
      const other = secureStoreStorage(store, {}, time.schedule)
      store.fail('set', busy)
      expect(await one.set(CORE_KEY, 'rt_2').catch((error: unknown) => error)).toBe(busy)
      expect(time.pending()).toBe(1)
      store.fail('set', null)
      if (act === 'write') {
        await other.set(CORE_KEY, 'rt_3')
      } else {
        await other.remove(CORE_KEY)
      }
      expect(time.pending()).toBe(0)
      await time.advance(60_000)
      expect([...store.entries.values()]).toEqual(act === 'write' ? ['rt_3'] : [])
    }
  })

  test('the same key under another service, and another store, are other entries: neither is called off', async () => {
    const store = fakeSecureStore()
    const time = fakeSchedule(SHORT)
    const one = secureStoreStorage(store, {}, time.schedule)
    const service = secureStoreStorage(
      store,
      { keychainService: 'com.example.other' },
      time.schedule
    )
    const elsewhere = secureStoreStorage(fakeSecureStore(), {}, time.schedule)
    store.fail('set', busy)
    expect(await one.set(CORE_KEY, 'rt_2').catch((error: unknown) => error)).toBe(busy)
    store.fail('set', null)
    await service.set(CORE_KEY, 'rt_s')
    await elsewhere.set(CORE_KEY, 'rt_e')
    expect(time.pending()).toBe(1)
    await time.advance(60_000)
    expect(await one.get(CORE_KEY)).toBe('rt_2')
    expect(await service.get(CORE_KEY)).toBe('rt_s')
  })
})
