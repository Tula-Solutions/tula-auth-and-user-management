import { describe, expect, spyOn, test } from 'bun:test'
import { generateSoftwareDeviceKey, memoryStorage, type TokenStorage } from '@tula/core'
import { createDeviceBinding } from './device-binding'
import { DEVICE_KEY_ALIAS } from './device-key-store'
import { type FakeDeviceKeys, fakeDeviceKeys, KEY_STORE_CANARY } from './testing/fake-device-keys'

// What binds an Expo client's sessions to the device's key (ADR 0051), without a client:
// which key the transport is handed, and what the storage does with a stored session whose
// key is there, gone, another one, or out of reach.

const ENTRY = 'tula.refresh.test'

/** A binding over a plain storage a test can read, and the key store behind it. */
function bound(given: FakeDeviceKeys | null = fakeDeviceKeys()) {
  const store = given ?? undefined
  const inner = memoryStorage()
  const removed: string[] = []
  const watched: TokenStorage = {
    get: (key) => inner.get(key),
    set: (key, value) => inner.set(key, value),
    async remove(key) {
      removed.push(key)
      await inner.remove(key)
    },
  }
  const binding = createDeviceBinding({ store, storage: watched })
  return { ...binding, inner, removed, store }
}

/** The key the binding hands the transport for a request, as far as a test reads it. */
async function keyFor(source: ReturnType<typeof bound>['source'], operation: string) {
  return (await source?.(operation)) ?? null
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('where the client’s key comes from', () => {
  test('without a key store there is no source, and the storage is the secure store’s own', async () => {
    const { source, storage, inner } = bound(null)
    expect(source).toBeUndefined()
    await storage.set(ENTRY, 'rt_1')
    expect(await inner.get(ENTRY)).toBe('rt_1')
    expect(await storage.get(ENTRY)).toBe('rt_1')
  })

  test('creating the binding asks the key store nothing', () => {
    const { store } = bound()
    expect(store?.calls).toEqual([])
  })

  test('a start is handed the device’s key, made when there is none, and found once', async () => {
    const store = fakeDeviceKeys()
    const { source } = bound(store)
    const first = await keyFor(source, 'startSignIn')
    expect(first?.publicJwk).toEqual(store.keys.get(DEVICE_KEY_ALIAS)?.publicJwk as never)
    const second = await keyFor(source, 'startSignUp')
    expect(second).toBe(first)
    // Asked whether there is a key store each time; the key itself is looked for once.
    expect(store.calls.filter((call) => call.startsWith('obtain'))).toHaveLength(1)
    expect(store.calls.filter((call) => call === 'isAvailable')).toHaveLength(2)
  })

  test('two requests at once make one key', async () => {
    const store = fakeDeviceKeys()
    const { source } = bound(store)
    const [a, b] = await Promise.all([keyFor(source, 'startSignIn'), keyFor(source, 'startSignIn')])
    expect(a).toBe(b)
    expect(store.calls.filter((call) => call.startsWith('obtain'))).toHaveLength(1)
  })

  test('the key is the four members of a P-256 key and nothing the store sent with them', async () => {
    const key = await generateSoftwareDeviceKey()
    const store = fakeDeviceKeys()
    store.obtain = async () => ({
      publicJwk: { ...key.publicJwk, d: 'private', kid: 'k' } as never,
      created: false,
    })
    const handed = await keyFor(bound(store).source, 'startSignIn')
    expect(handed?.publicJwk).toEqual(key.publicJwk)
    expect(Object.keys(handed?.publicJwk ?? {}).sort()).toEqual(['crv', 'kty', 'x', 'y'])
  })

  test.each([
    ['an RSA key', { kty: 'RSA', n: 'x', e: 'AQAB' }],
    ['another curve', { kty: 'EC', crv: 'P-384', x: 'a'.repeat(43), y: 'b'.repeat(43) }],
    ['a short coordinate', { kty: 'EC', crv: 'P-256', x: 'a'.repeat(42), y: 'b'.repeat(43) }],
    [
      'a padded coordinate',
      { kty: 'EC', crv: 'P-256', x: `${'a'.repeat(43)}=`, y: 'b'.repeat(43) },
    ],
    ['nothing', null],
  ])('a key store that answers %s is a failure, not a key', async (_name, publicJwk) => {
    const store = fakeDeviceKeys()
    store.obtain = async () => ({ publicJwk: publicJwk as never, created: true })
    expect(await rejection(keyFor(bound(store).source, 'startSignIn'))).toBeInstanceOf(Error)
  })

  test('no key store in this build: a start goes without a proof, and nothing is looked for', async () => {
    const store = fakeDeviceKeys()
    store.available = false
    const { source } = bound(store)
    expect(await keyFor(source, 'startSignIn')).toBeNull()
    expect(await keyFor(source, 'refreshSession')).toBeNull()
    expect(store.calls).toEqual(['isAvailable', 'isAvailable'])
  })

  test('a key store that cannot say, or cannot be reached, fails the request and is asked again', async () => {
    const store = fakeDeviceKeys()
    const { source } = bound(store)
    store.available = 'throws'
    await rejection(keyFor(source, 'startSignIn'))
    store.available = true
    store.locked = true
    await rejection(keyFor(source, 'startSignIn'))
    store.locked = false
    expect(await keyFor(source, 'startSignIn')).not.toBeNull()
  })

  test('a device that turns out to keep no such key: the start that found out goes without a proof, and the session it ends in is not marked', async () => {
    const store = fakeDeviceKeys()
    // What the hardware adapter does where a key cannot be made: the look rejects, and the
    // store says it is not there from then on.
    store.obtain = async () => {
      store.calls.push('obtain')
      store.available = false
      throw new Error(KEY_STORE_CANARY)
    }
    const { source, storage, inner } = bound(store)
    expect(await keyFor(source, 'startSignIn')).toBeNull()
    await storage.set(ENTRY, 'rt_1')
    expect(await inner.get(ENTRY)).toBe('rt_1')
    // Not looked for again: the store is asked whether it is there, and says no.
    expect(await keyFor(source, 'startSignIn')).toBeNull()
    expect(store.calls.filter((call) => call === 'obtain')).toHaveLength(1)
  })

  test('a key store that failed and still says it is there fails the start: never an unbound sign-in on a guess', async () => {
    const store = fakeDeviceKeys()
    store.locked = true
    const { source } = bound(store)
    const error = await rejection(keyFor(source, 'startSignIn'))
    expect(error.message).toBe(KEY_STORE_CANARY)
    expect(store.calls).toEqual(['isAvailable', `obtain ${DEVICE_KEY_ALIAS}`, 'isAvailable'])
  })

  test('a bound session’s refresh is never sent without a proof because the key store went away', async () => {
    const store = fakeDeviceKeys()
    const { source, storage } = bound(store)
    await keyFor(source, 'startSignIn')
    await storage.set(ENTRY, 'rt_1')
    // The key stops signing, so the next request looks for it again; the look fails and
    // the store then says it is not there.
    store.failSigning = true
    await rejection((await source?.('refreshSession'))?.sign(new Uint8Array(1)) as Promise<unknown>)
    store.obtain = async () => {
      store.available = false
      throw new Error(KEY_STORE_CANARY)
    }
    await rejection(keyFor(source, 'refreshSession'))
  })

  test('a signature that is not 64 bytes is a failure, and the key is looked for again', async () => {
    const store = fakeDeviceKeys()
    const { source } = bound(store)
    const key = await keyFor(source, 'startSignIn')
    const data = new Uint8Array([1, 2, 3])
    expect(await key?.sign(data)).toHaveLength(64)
    const sign = spyOn(store, 'sign').mockResolvedValueOnce(new Uint8Array(70))
    await rejection(key?.sign(data) as Promise<unknown>)
    sign.mockRestore()
    store.failSigning = true
    await rejection(key?.sign(data) as Promise<unknown>)
    store.failSigning = false
    const before = store.calls.filter((call) => call.startsWith('obtain')).length
    await keyFor(source, 'startSignIn')
    expect(store.calls.filter((call) => call.startsWith('obtain'))).toHaveLength(before + 1)
  })

  test('a proof’s id is new every time, of the shape the server takes, with or without a random source', async () => {
    const key = await keyFor(bound().source, 'startSignIn')
    const ids = new Set<string>()
    for (let at = 0; at < 50; at += 1) {
      ids.add(key?.proofId?.() as string)
    }
    const random = spyOn(crypto, 'getRandomValues')
    const before = random.mock.calls.length
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    // An engine with no `crypto` at all.
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
    try {
      for (let at = 0; at < 50; at += 1) {
        ids.add(key?.proofId?.() as string)
      }
    } finally {
      Object.defineProperty(globalThis, 'crypto', descriptor as PropertyDescriptor)
      random.mockRestore()
    }
    expect(random.mock.calls.length).toBe(before)
    expect(ids.size).toBe(100)
    for (const id of ids) {
      // `lib/dpop.ts`: 16 to 128 characters of the unreserved set.
      expect(id).toMatch(/^[A-Za-z0-9._~-]{16,128}$/)
    }
  })
})

describe('a stored session and its key', () => {
  /** A device signed in with a bound session: the entry is marked with its key. */
  async function signedIn() {
    const store = fakeDeviceKeys()
    const first = bound(store)
    await keyFor(first.source, 'startSignIn')
    await first.storage.set(ENTRY, 'rt_1')
    const x = store.keys.get(DEVICE_KEY_ALIAS)?.publicJwk.x as string
    expect(await first.inner.get(ENTRY)).toBe(`rt_1\n${x}`)
    /** The app started again: a new binding over the same secure store and key store. */
    const restart = (keys: FakeDeviceKeys | undefined = store) => {
      const removed: string[] = []
      const storage: TokenStorage = {
        get: (key) => first.inner.get(key),
        set: (key, value) => first.inner.set(key, value),
        async remove(key) {
          removed.push(key)
          await first.inner.remove(key)
        },
      }
      return { ...createDeviceBinding({ store: keys, storage }), removed }
    }
    return { store, first, x, restart }
  }

  test('a session that started without a proof is stored as the token alone', async () => {
    const store = fakeDeviceKeys()
    store.available = false
    const { source, storage, inner } = bound(store)
    await keyFor(source, 'startSignIn')
    await storage.set(ENTRY, 'rt_1')
    expect(await inner.get(ENTRY)).toBe('rt_1')
  })

  test('the same key is there: the token is handed on, its refresh is proved by that key, and a rotation keeps the mark', async () => {
    const { store, x, restart, first } = await signedIn()
    const next = restart()
    expect(await next.storage.get(ENTRY)).toBe('rt_1')
    expect(next.removed).toEqual([])
    const key = await keyFor(next.source, 'refreshSession')
    expect(key?.publicJwk.x).toBe(x)
    await next.storage.set(ENTRY, 'rt_2')
    expect(await first.inner.get(ENTRY)).toBe(`rt_2\n${x}`)
    expect(store.calls.filter((call) => call.startsWith('obtain'))).toHaveLength(2)
  })

  test('the key is gone: the entry is deleted and the client starts signed out, with a new key for the next sign-in', async () => {
    const { store, x, restart, first } = await signedIn()
    store.keys.clear()
    const next = restart()
    expect(await next.storage.get(ENTRY)).toBeNull()
    expect(next.removed).toEqual([ENTRY])
    expect(await first.inner.get(ENTRY)).toBeNull()
    const key = await keyFor(next.source, 'startSignIn')
    expect(key?.publicJwk.x).not.toBe(x)
    await next.storage.set(ENTRY, 'rt_new')
    expect(await first.inner.get(ENTRY)).toBe(`rt_new\n${key?.publicJwk.x}`)
  })

  test('another key is there: the session is not this device’s any more', async () => {
    const { store, restart } = await signedIn()
    store.keys.set(DEVICE_KEY_ALIAS, await generateSoftwareDeviceKey())
    const next = restart()
    expect(await next.storage.get(ENTRY)).toBeNull()
    expect(next.removed).toEqual([ENTRY])
  })

  test('no key store any more (the option removed, or a build without the module): signed out, nothing looked for', async () => {
    const { store, first } = await signedIn()
    const calls = store.calls.length
    const bare = createDeviceBinding({ store: undefined, storage: first.inner })
    expect(await bare.storage.get(ENTRY)).toBeNull()
    expect(await first.inner.get(ENTRY)).toBeNull()
    expect(store.calls.length).toBe(calls)

    const other = await signedIn()
    other.store.available = false
    const unlinked = other.restart()
    expect(await unlinked.storage.get(ENTRY)).toBeNull()
    expect(unlinked.removed).toEqual([ENTRY])
    expect(other.store.calls.filter((call) => call.startsWith('obtain'))).toHaveLength(1)
  })

  test('a key store that cannot be reached is not a key that is gone: the read fails and the entry stays', async () => {
    for (const fail of ['locked', 'cannot say'] as const) {
      const { store, x, restart, first } = await signedIn()
      const next = restart()
      if (fail === 'locked') {
        store.locked = true
      } else {
        store.available = 'throws'
      }
      const error = await rejection(next.storage.get(ENTRY))
      expect(error.message).toBe(KEY_STORE_CANARY)
      expect(next.removed).toEqual([])
      expect(await first.inner.get(ENTRY)).toBe(`rt_1\n${x}`)
      // The device is unlocked: the same read finds the session.
      store.locked = false
      store.available = true
      expect(await next.storage.get(ENTRY)).toBe('rt_1')
    }
  })

  test('an entry that could not be deleted is still not handed on, and is found lost again the next time', async () => {
    const { store, first } = await signedIn()
    store.keys.clear()
    const stubborn: TokenStorage = {
      get: (key) => first.inner.get(key),
      set: (key, value) => first.inner.set(key, value),
      remove: async () => {
        throw new Error('the secure store refused')
      },
    }
    expect(await createDeviceBinding({ store, storage: stubborn }).storage.get(ENTRY)).toBeNull()
    // The store made a key the first time: it is there now, and it is not the session's.
    expect(await createDeviceBinding({ store, storage: stubborn }).storage.get(ENTRY)).toBeNull()
  })

  test('a bound session’s refresh is never proved by another key', async () => {
    const { store, restart } = await signedIn()
    const next = restart()
    expect(await next.storage.get(ENTRY)).toBe('rt_1')
    // The key is replaced while the app runs, and the old one fails to sign.
    const key = await keyFor(next.source, 'refreshSession')
    store.keys.set(DEVICE_KEY_ALIAS, await generateSoftwareDeviceKey())
    store.failSigning = true
    await rejection(key?.sign(new Uint8Array([1])) as Promise<unknown>)
    store.failSigning = false
    await rejection(keyFor(next.source, 'refreshSession'))
    // A new sign-in is another matter: it starts with the key the device has now.
    expect(await keyFor(next.source, 'startSignIn')).not.toBeNull()
  })

  test('sign-out forgets the mark: the next unbound session is stored alone', async () => {
    const { store, restart, first } = await signedIn()
    const next = restart()
    await next.storage.get(ENTRY)
    await next.storage.remove(ENTRY)
    expect(await first.inner.get(ENTRY)).toBeNull()
    store.available = false
    await next.storage.set(ENTRY, 'rt_unbound')
    expect(await first.inner.get(ENTRY)).toBe('rt_unbound')
  })

  test.each([
    ['a token alone', 'rt_plain'],
    ['a line break and something that is no mark', 'rt_plain\nnot-a-mark'],
    ['a mark of the wrong length', `rt_plain\n${'a'.repeat(44)}`],
  ])('%s is handed on as it is, and the key store is not asked', async (_name, value) => {
    const store = fakeDeviceKeys()
    const { storage, inner } = bound(store)
    await inner.set(ENTRY, value)
    expect(await storage.get(ENTRY)).toBe(value)
    expect(store.calls).toEqual([])
  })
})
