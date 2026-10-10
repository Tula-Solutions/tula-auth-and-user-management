import { describe, expect, test } from 'bun:test'
import { isTulaError, type TulaError } from '@tula/core'
import { createExpoClient } from './client'
import { MAX_SECURE_VALUE_BYTES } from './secure-storage'
import { fakeSecureStore } from './testing/fake-secure-store'
import {
  attempt,
  completed,
  failure,
  json,
  ROUTE,
  sessionTokens,
  started,
  TEST_BASE_URL,
  TEST_USER,
  world,
} from './testing/world'

const KEY = 'tula_pk_dev_expoclient0000000000000000000000'

async function caught(promise: Promise<unknown>): Promise<TulaError> {
  try {
    await promise
  } catch (error) {
    if (isTulaError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the call to throw a TulaError')
}

describe('creating the client', () => {
  test('says which platform it is: an iOS app is `ios`, an Android app `android`', async () => {
    for (const platform of ['ios', 'android']) {
      const w = world({ platform })
      w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
      await w.client.signIn.start({ identifier: 'maya@northline.app' })
      expect(w.api.requests.at(-1)?.headers.get('x-tula-client')).toBe(platform)
      // A native client sends no cookie and asks for none.
      expect(w.api.requests.at(-1)?.headers.get('cookie')).toBeNull()
    }
  })

  test('refuses to be created anywhere else, Expo web included, before anything is read or sent', () => {
    for (const platform of ['web', 'windows', 'macos', '', 'IOS', undefined]) {
      const store = fakeSecureStore()
      expect(() =>
        createExpoClient(
          { publishableKey: KEY, baseUrl: TEST_BASE_URL },
          { platform: platform as string, secureStore: store }
        )
      ).toThrow(/iOS and Android/)
      expect(store.calls).toEqual([])
    }
  })

  test('takes no client kind, no storage of the caller’s and no device key', () => {
    const runtime = { platform: 'ios', secureStore: fakeSecureStore() }
    const base = { publishableKey: KEY, baseUrl: TEST_BASE_URL }
    for (const [name, value] of [
      ['client', 'server'],
      ['storage', { get: async () => null, set: async () => {}, remove: async () => {} }],
      ['deviceKey', {}],
      // Present and empty is still an option this package does not take.
      ['storage', undefined],
    ] as const) {
      expect(() => createExpoClient({ ...base, [name]: value } as never, runtime)).toThrow(
        new RegExp(`\`${name}\` is not an option`)
      )
    }
    // What `@tula/core` refuses is refused here too.
    expect(() => createExpoClient({ ...base, publishableKey: 'tula_sk_dev_x' }, runtime)).toThrow(
      TypeError
    )
    expect(() => createExpoClient({ ...base, baseUrl: '/relative' }, runtime)).toThrow(TypeError)
  })

  test('no refusal repeats what it was given: every message the constructor can throw, with a value that would be seen', () => {
    // An app shows these on a setup screen (the example does), and a wrong value may be a
    // secret key pasted into the wrong place.
    const CANARY = 'canary7f3a'
    const good = { publishableKey: KEY, baseUrl: TEST_BASE_URL }
    const ios = () => ({ platform: 'ios', secureStore: fakeSecureStore() })
    const refusals: [string, () => unknown][] = [
      ['a platform that is neither', () => createExpoClient(good, { ...ios(), platform: CANARY })],
      ['client', () => createExpoClient({ ...good, client: CANARY } as never, ios())],
      ['storage', () => createExpoClient({ ...good, storage: CANARY } as never, ios())],
      ['deviceKey', () => createExpoClient({ ...good, deviceKey: CANARY } as never, ios())],
      [
        'keychainAccess',
        () =>
          createExpoClient({ ...good, secureStore: { keychainAccess: CANARY as never } }, ios()),
      ],
      [
        'keychainService',
        () =>
          createExpoClient(
            { ...good, secureStore: { keychainService: { [CANARY]: CANARY } as never } },
            ios()
          ),
      ],
      [
        'an empty keychainService',
        () => createExpoClient({ ...good, secureStore: { keychainService: '' } }, ios()),
      ],
      // What `@tula/core` refuses, reached through this constructor.
      [
        'a secret key',
        () => createExpoClient({ ...good, publishableKey: `tula_sk_dev_${CANARY}` }, ios()),
      ],
      ['a key that is no key', () => createExpoClient({ ...good, publishableKey: CANARY }, ios())],
      ['an address that is no URL', () => createExpoClient({ ...good, baseUrl: CANARY }, ios())],
      [
        'an address of another scheme',
        () => createExpoClient({ ...good, baseUrl: `ftp://${CANARY}` }, ios()),
      ],
      [
        'a timeout that is no number',
        () => createExpoClient({ ...good, timeoutMs: CANARY as never }, ios()),
      ],
      [
        'a session profile that is no name',
        () => createExpoClient({ ...good, sessionProfile: `${CANARY} !` }, ios()),
      ],
    ]
    const messages = new Set<string>()
    for (const [name, create] of refusals) {
      let thrown: unknown
      try {
        create()
      } catch (error) {
        thrown = error
      }
      expect(thrown, name).toBeInstanceOf(TypeError)
      const { message, cause } = thrown as TypeError
      expect(message, name).not.toContain(CANARY)
      expect(cause, name).toBeUndefined()
      messages.add(message)
    }
    // Every sentence the two constructors have for a caller's mistake was reached: the
    // four of this file (a platform, and one per option it decides itself), the two of the
    // adapter and the six of core's that a native client can reach.
    expect(messages.size).toBe(12)
  })

  test('creating a client reads nothing and sends nothing', () => {
    const w = world({ signedIn: true })
    expect(w.store.calls).toEqual([])
    expect(w.api.requests).toEqual([])
    expect(w.client.state).toEqual({ status: 'loading' })
  })
})

describe('where the tokens are', () => {
  test('a sign-in puts the refresh token in the secure store and nowhere else; the access token stays in memory', async () => {
    const w = world()
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    w.api.on(ROUTE.signInPassword, () => completed('sign_in'))
    const flow = await w.client.signIn.start({ identifier: 'maya@northline.app' })
    await flow.submitPassword({ password: 'sturdy-Otter-plays-42-chess' })

    expect(w.client.state).toMatchObject({ status: 'signed-in', user: TEST_USER })
    expect(w.storedToken()).toBe('rt_signed_in')
    // One entry, and it is the refresh token: no access token, password or attempt secret.
    expect([...w.store.entries.values()]).toEqual(['rt_signed_in'])
    const access = await w.client.session.getToken()
    expect(access).toBeString()
    expect(JSON.stringify([...w.store.entries])).not.toContain(access as string)
    // No token in an address: the refresh token travels in a body, the access token in a header.
    for (const request of w.api.requests) {
      expect(request.path).not.toContain('rt_')
      expect(request.path).not.toContain(access as string)
    }
    // Nothing of a token in what a developer might log.
    expect(JSON.stringify(w.client.state)).not.toContain('rt_')
    expect(JSON.stringify(w.client)).not.toContain('rt_')
  })

  test('a restart restores the session from the secure store and stores the rotated token', async () => {
    const w = world({ signedIn: true })
    expect((await w.client.load()).status).toBe('signed-in')
    expect(w.api.calls(ROUTE.refresh)[0]?.body).toEqual({ refreshToken: 'rt_0' })
    expect(w.storedToken()).toBe('rt_1')
  })

  test('nothing stored: signed out after one read and no request', async () => {
    const w = world()
    expect((await w.client.load()).status).toBe('signed-out')
    expect(w.store.calls.map((call) => call.operation)).toEqual(['get'])
    expect(w.api.requests).toEqual([])
  })

  test('sign-out deletes the stored token and tells the server', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.signOut, () => new Response(null, { status: 204 }))
    await w.client.load()
    await w.client.session.signOut()
    expect(w.client.state).toEqual({ status: 'signed-out' })
    expect(w.storedToken()).toBeUndefined()
    expect(w.api.calls(ROUTE.signOut)[0]?.body).toEqual({ refreshToken: 'rt_1' })
  })
})

describe('a secure store that fails is never "signed out and fine"', () => {
  test('a store that cannot be read (a locked device): storage.failed, still loading, nothing sent, and it works once unlocked', async () => {
    const w = world({ signedIn: true })
    w.store.fail('get', new Error('User interaction is not allowed.'))
    const error = await caught(w.client.load())
    expect(error).toMatchObject({ code: 'storage.failed', status: 0 })
    expect(w.client.state).toEqual({ status: 'loading' })
    expect(w.states).toEqual([])
    expect(w.api.requests).toEqual([])
    // The token is still there for when the device is unlocked.
    expect(w.storedToken()).toBe('rt_0')

    w.store.fail('get', null)
    expect((await w.client.load()).status).toBe('signed-in')
  })

  test('a store that cannot be written: the failure is reported, the session is kept in memory, and the next refresh presents the newest token', async () => {
    const w = world({ signedIn: true })
    w.store.fail('set', new Error('disk full'))
    const error = await caught(w.client.load())
    expect(error).toMatchObject({ code: 'storage.failed' })
    expect(w.client.state).toMatchObject({ status: 'signed-in' })
    expect(await w.client.session.getToken()).toBeString()

    w.store.fail('set', null)
    w.api.on(ROUTE.refresh, () => json(200, sessionTokens('again', { refreshToken: 'rt_2' })))
    await w.client.session.refresh()
    expect(w.api.calls(ROUTE.refresh)[1]?.body).toEqual({ refreshToken: 'rt_1' })
    expect(w.storedToken()).toBe('rt_2')
  })

  test('a sign-in whose token cannot be stored says so and is signed in for this run', async () => {
    const w = world()
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    w.api.on(ROUTE.signInPassword, () => completed('sign_in'))
    w.store.fail('set', new Error('disk full'))
    const flow = await w.client.signIn.start({ identifier: 'maya@northline.app' })
    const error = await caught(flow.submitPassword({ password: 'x' }))
    expect(error).toMatchObject({ code: 'storage.failed' })
    expect(error.message).not.toContain('rt_signed_in')
    expect(w.client.state.status).toBe('signed-in')
    expect(w.storedToken()).toBeUndefined()
  })

  test('a refresh token too large for the secure store is a storage failure, not a silent drop', async () => {
    const w = world({ signedIn: true })
    const huge = `rt_${'x'.repeat(MAX_SECURE_VALUE_BYTES)}`
    w.api.on(ROUTE.refresh, () => json(200, sessionTokens('big', { refreshToken: huge })))
    const error = await caught(w.client.load())
    expect(error).toMatchObject({ code: 'storage.failed' })
    expect(error.message).not.toContain('xxxx')
    // The store was never asked to hold it, and what it held is untouched.
    expect(w.store.calls.filter((call) => call.operation === 'set')).toEqual([])
    expect(w.storedToken()).toBe('rt_0')
    expect(w.client.state.status).toBe('signed-in')
  })

  test('a sign-out whose stored token cannot be deleted is signed out here and says what failed', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.signOut, () => new Response(null, { status: 204 }))
    await w.client.load()
    w.store.fail('delete', new Error('locked'))
    expect(await caught(w.client.session.signOut())).toMatchObject({ code: 'storage.failed' })
    expect(w.client.state).toEqual({ status: 'signed-out' })
    // The server was told, so what is left in the store signs nobody in.
    expect(w.api.calls(ROUTE.signOut)).toHaveLength(1)
  })
})

describe('a refresh the server refuses, and one it never answers', () => {
  test('refused for the session: signed out once, and the stored token is deleted', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.refresh, () => failure(401, 'session.revoked'))
    expect((await w.client.load()).status).toBe('signed-out')
    expect(w.storedToken()).toBeUndefined()
    expect(w.states).toEqual([{ status: 'signed-out' }])
  })

  test('offline: the load fails, nobody is signed out, and the stored token is kept', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.refresh, () => {
      throw new TypeError('Network request failed')
    })
    expect(await caught(w.client.load())).toMatchObject({ code: 'network.failed' })
    expect(w.client.state).toEqual({ status: 'loading' })
    expect(w.storedToken()).toBe('rt_0')
  })

  test('an answer that is not a session is not stored', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.refresh, () => attempt('sign_in', { status: 'needs_password' }))
    await caught(w.client.load())
    expect(w.storedToken()).toBe('rt_0')
  })
})
