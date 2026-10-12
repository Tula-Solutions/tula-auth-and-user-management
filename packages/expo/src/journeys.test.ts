import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { throwawayP256PrivateKey, VirtualAuthenticator } from '@tula/conformance'
import { androidApkKeyHashOrigin, DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import { jwkThumbprint } from '@tula/contract/device-binding'
import {
  type DeviceKey,
  type IdTokenProvider,
  isStepUpRequired,
  stepUpMethods,
  type TokenStorage,
  type TulaClient,
} from '@tula/core'
import { issueMockIdToken } from '../../../apps/api/src/adapters/oauth/mock'
import { base32Decode, totp } from '../../../apps/api/src/lib/totp'
import { TEST_TENANT } from '../../../apps/api/src/testing'
import {
  type Browse,
  JOURNEY_STORAGE_KEY,
  type JourneySheet,
  PASSWORD,
  PUBLISHABLE_KEY,
  type Server,
  sdkJourneys,
} from '../../../apps/api/src/testing/sdk-journeys'
import { createExpoClient } from './client'
import { DEVICE_KEY_ALIAS, type DeviceKeyStore } from './device-key-store'
import { isEmailLink, openEmailLink, requestEmailLink } from './email-link'
import { hostOf, type IdTokenCredential, waysOf } from './host'
import { idTokenProviders, signInWithIdToken } from './id-token-sign-in'
import { linkProvider, type ProviderSignInInput, signInWithProvider } from './provider-sign-in'
import { flowScreen } from './screens'
import {
  SECURE_REWRITE_DELAYS_MS,
  SECURE_WRITE_RETRY_DELAYS_MS,
  secureStoreKey,
  secureStoreStorage,
} from './secure-storage'
import { BROWSER_GLOBALS, hideDom } from './testing/dom'
import { fakeDeviceKeys } from './testing/fake-device-keys'
import { type FakeSchedule, fakeSchedule } from './testing/fake-schedule'
import { type FakeSecureStore, fakeSecureStore } from './testing/fake-secure-store'

// `@tula/expo`'s suite: the journeys `@tula/core`'s own suite runs, for the client this
// package builds (an `ios` client whose refresh token is in the secure store), against the
// real API in process. `expo`'s column of `conformance/client-journeys.json` says which
// scenarios it covers; the guard inside the journeys fails when the list and these tests
// disagree. No simulator and no device: what that leaves unshown is in
// `docs/plans/phase-2-unverified.md`.

// An app has no DOM. The hooks' tests register one for their renderer; here it is gone, so a
// client that reached for `document`, `localStorage` or `window` would fail these tests.
let showDom = () => {}
beforeAll(() => {
  showDom = hideDom()
})
afterAll(() => {
  showDom()
})

/** A phone as a journey has it: its secure store, and the time its adapter waits in. */
interface Device {
  store: FakeSecureStore
  /** The adapter's short waits run by themselves; a later try runs when a journey says. */
  time: FakeSchedule
  /** The phone's key store, for a test that gives it one; a shared journey brings a key. */
  keys?: DeviceKeyStore
  /** The app link the app's emailed links lead to, for a test whose app has one. */
  emailLinkUrl?: string
}

/** The device behind each storage a journey asked for. */
const devices = new WeakMap<TokenStorage, Device>()

/** A new device and the storage a journey reads its secure store through. */
function device(): Device & {
  storage: TokenStorage
  withKeys<Keys extends DeviceKeyStore>(keys: Keys): Keys
  withEmailLink(url: string): void
} {
  const store = fakeSecureStore()
  const time = fakeSchedule(Math.max(...SECURE_WRITE_RETRY_DELAYS_MS))
  const entry = secureStoreStorage(store, {}, time.schedule)
  // What a journey reads and copies is the refresh token. A bound session's entry also says
  // which key the session is bound to, after a line break (ADR 0052): that is the package's
  // own note, which somebody who copies a token does not copy with it.
  const storage: TokenStorage = {
    async get(key) {
      const value = await entry.get(key)
      return value === null ? null : (value.split('\n')[0] as string)
    },
    set: (key, value) => entry.set(key, value),
    remove: (key) => entry.remove(key),
  }
  const phone: Device = { store, time }
  devices.set(storage, phone)
  return {
    store,
    time,
    storage,
    /** Give the phone a key store: clients made for it afterwards bind their sessions. */
    withKeys<Keys extends DeviceKeyStore>(keys: Keys): Keys {
      phone.keys = keys
      return keys
    },
    /** Give the phone's app an app link: clients made for it afterwards can ask for a link. */
    withEmailLink(url: string) {
      phone.emailLinkUrl = url
    },
  }
}

/** A key a shared journey made, behind the interface a phone's key store has. */
function keyStoreOf(key: DeviceKey): DeviceKeyStore {
  return {
    isAvailable: () => true,
    obtain: async () => ({ publicJwk: key.publicJwk, created: false }),
    sign: (_alias, data) => key.sign(data),
  }
}

/** What a provider's sheet answers, as a journey says it: the user, at the sheet. */
type AtSheet = (provider: IdTokenProvider, nonce: string) => Promise<IdTokenCredential | null>

/**
 * The provider sheets of each client: a journey says, call by call, what the user does at
 * one. With nothing said a client that shows a sheet fails its test.
 */
const sheets = new WeakMap<TulaClient, { answer: AtSheet | null }>()

/** Run one of the package's calls with `answer` as the user at the provider's sheet. */
async function atSheet<T>(tula: TulaClient, answer: AtSheet, call: () => Promise<T>): Promise<T> {
  const shown = sheets.get(tula)
  if (!shown) {
    throw new Error('a client this suite did not make')
  }
  shown.answer = answer
  try {
    return await call()
  } finally {
    shown.answer = null
  }
}

/**
 * The system browser of each client: a journey says, call by call, where the browser ends
 * up. With nothing said a client that opens one fails its test.
 */
const browsers = new WeakMap<TulaClient, { browse: Browse | null }>()

/** Run one of the package's provider calls with `browse` as the system browser. */
async function browsing<T>(tula: TulaClient, browse: Browse, call: () => Promise<T>): Promise<T> {
  const browser = browsers.get(tula)
  if (!browser) {
    throw new Error('a client this suite did not make')
  }
  browser.browse = browse
  try {
    return await call()
  } finally {
    browser.browse = null
  }
}

/**
 * What is behind the passkey sheet of every client of the run: a journey's authenticator, or
 * `null` for a device that has no passkeys. One for the process, as a phone has one sheet.
 */
let passkeySheet: JourneySheet | null = null

function sheet(): JourneySheet {
  if (!passkeySheet) {
    throw new Error('the passkey sheet was asked on a device that has none')
  }
  return passkeySheet
}

/** The iOS app the journeys run as. Its passkeys carry the relying party's own origin. */
const IOS_APP = { platform: 'ios', teamId: 'ABCDE12345', bundleId: 'com.example.journeys' }

const {
  journey,
  behaviour,
  server,
  freshEmail,
  signUp,
  caught,
  refreshes,
  oauthServer,
  atProvider,
} = sdkJourneys({
  client: 'expo',
  native: 'ios',
  create({ client, storage, deviceKey, ...options }) {
    const phone = storage && devices.get(storage)
    if (!phone || !client) {
      // A journey that needs a browser is not declared for this client.
      throw new Error(`@tula/expo has no ${client} client for this journey`)
    }
    const browser: { browse: Browse | null } = { browse: null }
    const shown: { answer: AtSheet | null } = { answer: null }
    const sheetOf = (provider: IdTokenProvider) => ({
      isAvailable: () => true,
      signIn({ nonce }: { nonce: string }) {
        if (!shown.answer) {
          throw new Error('a provider’s sheet was shown by a call no journey scripted')
        }
        return shown.answer(provider, nonce)
      },
    })
    // A journey brings a key (software, as `@tula/core`'s suite makes one); the package
    // takes a key store, so the key is put behind one. A test of this file gives the phone
    // a store of its own.
    const deviceKeys = deviceKey ? keyStoreOf(deviceKey) : phone.keys
    const tula = createExpoClient(
      {
        ...options,
        ...(deviceKeys && { deviceKeys }),
        ...(phone.emailLinkUrl !== undefined && { emailLinkUrl: phone.emailLinkUrl }),
        google: sheetOf('google'),
        apple: sheetOf('apple'),
        // The things an app hands the package, injected as the secure store is: a browser
        // session a journey scripts, a passkey sheet over its authenticator, the two
        // providers' sheets a journey answers, and a key store.
        browser: {
          open(authorizationUrl, redirectUrl) {
            if (!browser.browse) {
              throw new Error('the browser was opened by a call no journey scripted')
            }
            return browser.browse(authorizationUrl, redirectUrl)
          },
        },
        passkeys: {
          isSupported: () => passkeySheet !== null,
          create: (creation) => sheet().create(creation),
          get: (request) => sheet().get(request),
        },
      },
      { platform: client, secureStore: phone.store, schedule: phone.time.schedule }
    )
    browsers.set(tula, browser)
    sheets.set(tula, shown)
    return tula
  },
  storage: () => device().storage,
  // The client writes through an adapter of its own over the phone's secure store, so the
  // store is what is watched.
  watchWrites(storage) {
    const phone = devices.get(storage)
    if (!phone) {
      throw new Error('a storage this suite did not make')
    }
    const written: string[] = []
    const keep = phone.store.setItemAsync.bind(phone.store)
    phone.store.setItemAsync = async (key, value, options) => {
      written.push(value)
      await keep(key, value, options)
    }
    return written
  },
  browser: false,
  // The package's own calls, with the journey as the system browser.
  oauth: {
    signIn: (tula, input, browse) =>
      browsing(tula, browse, () => signInWithProvider(tula, input as ProviderSignInInput)),
    link: (tula, input, browse) =>
      browsing(tula, browse, () => linkProvider(tula, input as ProviderSignInInput)),
    kept: (tula) => hostOf(tula)?.kept() ?? Number.NaN,
  },
  // `signIn.withIdToken` is `@tula/core`'s and the client this package builds has it: the
  // shared journeys mint the token as `core`'s do. The package's own call, with a sheet
  // between the start and the exchange, has its journeys further down.
  idToken: true,
  // The sheet of an iOS app: the origin Apple's API is taken to write is the relying party's
  // own (ADR 0027; never seen from a device).
  passkeys: {
    origin: 'https://localhost',
    app: IOS_APP,
    plugIn(next) {
      passkeySheet = next
    },
  },
  // A session bound to a key the phone's key store keeps (ADR 0052). The journeys' keys are
  // software keys behind the key store's interface: no secure hardware was ever asked.
  deviceKey: true,
  // Nothing an app can reach is left unbuilt: the emailed link, the last entry (TULA-48), is
  // a journey of this file since TULA-73. A scenario this package cannot run yet goes here
  // with its ticket, in the change that says `not_built` in the list.
  notBuilt: {},
  sources: [import.meta.path],
})

/** The claims of an access token, unverified: these tests read what the client was handed. */
function claimsOf(token: string | null): Record<string, unknown> {
  const payload = (token ?? '').split('.')[1] ?? ''
  return JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))) as Record<
    string,
    unknown
  >
}

/** Sign up on a device whose secure store the test can read, losing refresh answers on demand. */
async function signedInDevice(s: Server) {
  let lose = 0
  const { store, storage, time } = device()
  const context = s.client('ios', {
    storage,
    loseResponse: (request) => request.url.endsWith('/v1/client/sessions/refresh') && lose-- > 0,
  })
  const email = freshEmail()
  const flow = await context.tula.signUp.start({ email, password: PASSWORD })
  await flow.verifyEmail({ code: s.code(email) })
  expect(context.tula.state.status).toBe('signed-in')
  return {
    ...context,
    email,
    store,
    storage,
    time,
    /** The refresh token as the secure store holds it. */
    stored: () => [...store.entries.values()],
    loseNext(count: number) {
      lose = count
    },
  }
}

describe('Expo journeys: where the session is kept', () => {
  test('there is no DOM while the journeys run', () => {
    for (const name of BROWSER_GLOBALS) {
      expect(name in globalThis, name).toBe(false)
    }
  })

  test('after a sign-up the refresh token is in the secure store, under one key, and nowhere else the client can write', async () => {
    const s = await server()
    const { tula, store, storage, stored } = await signedInDevice(s)
    const [token] = stored()
    expect(stored()).toHaveLength(1)
    expect(token).toStartWith('tula_rt_')
    expect([...store.entries.keys()]).toEqual([`/${secureStoreKey(JOURNEY_STORAGE_KEY)}`])
    // The access token is in memory only: nothing stored is, or holds, it.
    const access = (await tula.session.getToken()) ?? ''
    expect(access.split('.')).toHaveLength(3)
    expect(JSON.stringify([...store.entries])).not.toContain(access)
    // And no token ever travelled in an address.
    for (const exchange of s.exchanges) {
      expect(exchange.path).not.toContain('tula_rt_')
    }

    // A restart of the app: a new client finds the session in the store.
    s.advance(61_000)
    const { tula: restarted } = s.client('ios', { storage })
    expect(await restarted.load()).toMatchObject({ status: 'signed-in' })
    expect(stored()).toHaveLength(1)
    expect(stored()[0]).not.toBe(token)

    await restarted.session.signOut()
    expect(stored()).toEqual([])
  })
})

describe('Expo journeys: a refresh whose response is lost (the reuse grace period)', () => {
  behaviour(
    'refresh_without_answer',
    'one lost response: getToken() alone ends with a working session, the family intact and the next token in the secure store',
    async () => {
      const s = await server()
      const { tula, states, loseNext, stored } = await signedInDevice(s)
      const [before] = stored()
      s.advance(61_000)

      // The server rotates the token; the answer never arrives. The SDK asks again at once
      // with the token the secure store still holds, and is given the same next token.
      loseNext(1)
      expect(await tula.session.getToken()).toBeString()
      expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200, 200])
      expect(refreshes(s)[0]?.requestBody).toBe(refreshes(s)[1]?.requestBody as string)
      expect(refreshes(s)[0]?.requestBody).toContain(before as string)
      expect(refreshes(s)[0]?.responseBody).toBe(refreshes(s)[1]?.responseBody as string)
      expect(tula.state.status).toBe('signed-in')
      expect(await tula.session.list()).toHaveLength(1)
      expect(stored()).toHaveLength(1)
      expect(stored()[0]).not.toBe(before)

      // The family was not revoked: the next rotation works, with one request.
      s.advance(61_000)
      expect(await tula.session.getToken()).toBeString()
      expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200, 200, 200])
      expect(states.map((state) => state.status)).toEqual(['signed-in'])
    }
  )

  behaviour(
    'refresh_without_answer',
    'both tries lost, then asked again inside the grace period: the stored token is still the old one, and it still works',
    async () => {
      const s = await server()
      const { tula, states, loseNext, stored } = await signedInDevice(s)
      const [before] = stored()
      s.advance(61_000)

      loseNext(2)
      expect(await caught(tula.session.getToken())).toMatchObject({ code: 'network.failed' })
      // Two tries, no third; the session and its stored token are kept.
      expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200, 200])
      expect(tula.state.status).toBe('signed-in')
      expect(stored()).toEqual([before as string])

      s.advance(3_000)
      expect(await tula.session.getToken()).toBeString()
      expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200, 200, 200])
      expect(stored()[0]).not.toBe(before)
      s.advance(61_000)
      expect(await tula.session.getToken()).toBeString()
      expect(states.map((state) => state.status)).toEqual(['signed-in'])
    }
  )

  test('both tries lost, then asked again after the grace period: the server sees reuse, the client signs out once and the secure store is emptied', async () => {
    const s = await server()
    const { tula, states, loseNext, stored } = await signedInDevice(s)
    s.advance(61_000)
    loseNext(2)
    await caught(tula.session.getToken())

    s.advance(11_000)
    expect(await tula.session.getToken()).toBeNull()
    expect(refreshes(s).at(-1)).toMatchObject({ status: 401 })
    expect(refreshes(s).at(-1)?.responseBody).toContain('session.reuse_detected')
    expect(states.map((state) => state.status)).toEqual(['signed-in', 'signed-out'])
    expect(stored()).toEqual([])
    // No retry loop.
    expect(await tula.session.getToken()).toBeNull()
    expect(refreshes(s)).toHaveLength(3)
  })
})

describe('Expo journeys: a secure store that refuses the next refresh token', () => {
  // The server has replaced the token by the time the client stores the next one, so the
  // store then holds a token that is no longer the newest. These say what follows.
  const refused = new Error('The keychain is busy.')
  const writes = (store: FakeSecureStore) =>
    store.calls.filter((call) => call.operation === 'set').length

  test('refused twice, then taken: the refresh succeeds, nothing is reported and the store holds the new token', async () => {
    const s = await server()
    const { tula, states, store, storage, stored } = await signedInDevice(s)
    const [before] = stored()
    const written = writes(store)
    s.advance(61_000)

    store.fail('set', refused, 2)
    expect(await tula.session.getToken()).toBeString()
    expect(writes(store) - written).toBe(3)
    expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200])
    expect(stored()).toHaveLength(1)
    expect(stored()[0]).not.toBe(before)
    expect(states.map((state) => state.status)).toEqual(['signed-in'])

    // What the store holds is the newest token: an app ended now and started long after the
    // grace period is still signed in.
    s.advance(3_600_000)
    const { tula: restarted } = s.client('ios', { storage })
    expect(await restarted.load()).toMatchObject({ status: 'signed-in' })
  })

  test('refused every time: getToken() still hands out a token that works, refresh() says storage.failed, and the store catches up at the next refresh', async () => {
    const s = await server()
    const { tula, states, store, storage, stored } = await signedInDevice(s)
    const [before] = stored()
    const written = writes(store)
    s.advance(61_000)

    store.fail('set', refused)
    // `getToken()` is asked for a token and has one that works: it does not fail the request
    // it is for. Three tries and no more; the store still holds the token the server replaced.
    expect(await tula.session.getToken()).toBeString()
    expect(writes(store) - written).toBe(3)
    expect(stored()).toEqual([before as string])
    // Asked outright, the client says what happened. It is signed in and its token works.
    expect(await caught(tula.session.refresh())).toMatchObject({ code: 'storage.failed' })
    expect(writes(store) - written).toBe(6)
    expect(stored()).toEqual([before as string])
    expect(tula.state.status).toBe('signed-in')
    expect(await tula.session.list()).toHaveLength(1)

    // The store works again: the next refresh writes the token of that refresh.
    store.fail('set', null)
    s.advance(61_000)
    expect(await tula.session.getToken()).toBeString()
    expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200, 200, 200])
    expect(stored()[0]).not.toBe(before)
    expect(states.map((state) => state.status)).toEqual(['signed-in'])
    s.advance(3_600_000)
    const { tula: restarted } = s.client('ios', { storage })
    expect(await restarted.load()).toMatchObject({ status: 'signed-in' })
  })

  test('refused every time, and then the store works again: a later try stores the newest token, with no refresh and nobody asking', async () => {
    const s = await server()
    const { tula, states, store, storage, stored, time } = await signedInDevice(s)
    const [before] = stored()
    s.advance(61_000)
    store.fail('set', refused)
    expect(await tula.session.getToken()).toBeString()
    const written = writes(store)
    expect(stored()).toEqual([before as string])
    expect(time.pending()).toBe(1)

    // The store works again a moment later. Nothing asks the client for anything.
    store.fail('set', null)
    await time.advance(SECURE_REWRITE_DELAYS_MS[0] as number)
    expect(writes(store) - written).toBe(1)
    expect(stored()).toHaveLength(1)
    expect(stored()[0]).not.toBe(before)
    expect(time.pending()).toBe(0)
    expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200])
    expect(states.map((state) => state.status)).toEqual(['signed-in'])

    // What it stored is the token of that refresh: an app ended now and started long after
    // the grace period is signed in, and the server saw no reuse.
    s.advance(3_600_000)
    const { tula: restarted } = s.client('ios', { storage })
    expect(await restarted.load()).toMatchObject({ status: 'signed-in' })
    expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200, 200])
  })

  test('refused every time, and the user signs out while a later try waits: the store stays empty and the next start is signed out', async () => {
    const s = await server()
    const { tula, store, storage, stored, time } = await signedInDevice(s)
    s.advance(61_000)
    store.fail('set', refused)
    expect(await tula.session.getToken()).toBeString()
    expect(time.pending()).toBe(1)

    store.fail('set', null)
    await tula.session.signOut()
    expect(time.pending()).toBe(0)
    const written = writes(store)
    await time.advance(60_000)
    expect(writes(store)).toBe(written)
    expect(stored()).toEqual([])
    const { tula: restarted } = s.client('ios', { storage })
    expect(await restarted.load()).toMatchObject({ status: 'signed-out' })
  })

  test('refused every time, and a newer refresh is stored while a later try waits: the newer token stays', async () => {
    const s = await server()
    const { tula, store, storage, stored, time } = await signedInDevice(s)
    s.advance(61_000)
    store.fail('set', refused)
    expect(await tula.session.getToken()).toBeString()
    expect(time.pending()).toBe(1)

    store.fail('set', null)
    s.advance(61_000)
    expect(await tula.session.getToken()).toBeString()
    const [newest] = stored()
    expect(time.pending()).toBe(0)
    const written = writes(store)
    await time.advance(60_000)
    expect(writes(store)).toBe(written)
    expect(stored()).toEqual([newest as string])
    s.advance(3_600_000)
    const { tula: restarted } = s.client('ios', { storage })
    expect(await restarted.load()).toMatchObject({ status: 'signed-in' })
  })

  test('refused every time, and the app is ended inside the grace period: the next start presents the replaced token and is still signed in', async () => {
    const s = await server()
    const { tula, store, storage, stored } = await signedInDevice(s)
    const [before] = stored()
    s.advance(61_000)
    store.fail('set', refused)
    expect(await caught(tula.session.refresh())).toMatchObject({ code: 'storage.failed' })
    expect(stored()).toEqual([before as string])

    // The app is ended and started again three seconds later, with a store that works.
    store.fail('set', null)
    s.advance(3_000)
    const { tula: restarted } = s.client('ios', { storage })
    expect(await restarted.load()).toMatchObject({ status: 'signed-in' })
    expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200, 200])
    expect(refreshes(s)[1]?.requestBody).toContain(before as string)
    expect(stored()[0]).not.toBe(before)
  })

  test('refused every time, and the app is ended before a later refresh is stored: started after the grace period it presents a replaced token, the server sees reuse and the user is signed out', async () => {
    const s = await server()
    const { tula, store, storage, stored } = await signedInDevice(s)
    const [before] = stored()
    const written = writes(store)
    s.advance(61_000)
    store.fail('set', refused)
    expect(await caught(tula.session.refresh())).toMatchObject({ code: 'storage.failed' })
    expect(writes(store) - written).toBe(3)
    expect(stored()).toEqual([before as string])
    expect(tula.state.status).toBe('signed-in')

    // The app is ended here. Its memory, which held the only copy of the newest token, is
    // gone; the next start is past the grace period (10 seconds by default).
    s.advance(11_000)
    const { tula: restarted, states } = s.client('ios', { storage })
    expect(await restarted.load()).toMatchObject({ status: 'signed-out' })
    expect(refreshes(s).at(-1)).toMatchObject({ status: 401 })
    expect(refreshes(s).at(-1)?.requestBody).toContain(before as string)
    expect(refreshes(s).at(-1)?.responseBody).toContain('session.reuse_detected')
    // The family is revoked and the store emptied: the user signs in again.
    expect(stored()).toEqual([])
    expect(await restarted.session.getToken()).toBeNull()
    expect(states.filter((state) => state.status === 'signed-in')).toEqual([])
  })

  test('a store that answers "nothing" where it holds a token (what a locked read would be if it did not reject): signed out for that client, the entry untouched, and the next start signed in', async () => {
    // Not observed on a device: whether a read of a locked Keychain rejects or resolves
    // `null`. This pins what the client does with the second, so that the docs can say it.
    const s = await server()
    const { store, storage, stored } = await signedInDevice(s)
    const [before] = stored()
    const calls = store.calls.length
    const refreshed = refreshes(s).length
    s.advance(61_000)

    const read = store.getItemAsync
    store.getItemAsync = async () => null
    const { tula: locked } = s.client('ios', { storage })
    expect(await locked.load()).toMatchObject({ status: 'signed-out' })
    expect(await locked.session.getToken()).toBeNull()
    store.getItemAsync = read
    // Nothing was asked of the server and nothing written to or removed from the store.
    expect(refreshes(s)).toHaveLength(refreshed)
    expect(store.calls).toHaveLength(calls)
    expect(stored()).toEqual([before as string])

    const { tula: restarted } = s.client('ios', { storage })
    expect(await restarted.load()).toMatchObject({ status: 'signed-in' })
  })
})

describe('Expo journeys: a step this version does not know', () => {
  // The shared journeys show the client hands the step on unchanged. This package also says
  // which screen to draw for it, and that is "not supported": never a guess.
  behaviour(
    'unknown_step_not_supported',
    'a step from a newer server is the screen `not_supported`, and so is a known step that offers only what this client cannot do',
    async () => {
      const s = await server()
      const { email } = await signUp(s)
      const steps: object[] = [
        { status: 'needs_retina_scan', prompt: 'look into the camera' },
        // An emailed link is never a way here, and this device has no passkey sheet up.
        { status: 'needs_first_factor', strategies: ['passkey', 'email_link'] },
      ]
      for (const newer of steps) {
        const { tula, states } = s.client('ios', {
          storage: device().storage,
          async answer(request, response) {
            if (!request.url.endsWith('/v1/client/sign-ins') || response.status !== 200) {
              return response
            }
            const body = (await response.json()) as Record<string, unknown>
            return Response.json({ ...body, step: newer }, { status: 200 })
          },
        })
        const before = s.exchanges.length
        const flow = await tula.signIn.start({ identifier: email })
        expect(flowScreen(flow.step, waysOf(tula))).toBe('not_supported')
        // The step itself is untouched, for an app that knows more than this package.
        expect(flow.step as unknown).toEqual(newer)
        expect(s.exchanges.slice(before).map((exchange) => exchange.path)).toEqual([
          '/v1/client/sign-ins',
        ])
        expect(states).toEqual([])
        flow.discard()
      }
    }
  )
})

describe('Expo journeys: what the shared journeys reach through a browser', () => {
  journey(
    'step-up by emailed code',
    'step-up by email: a user with no password asks for a code, proves it and repeats the sensitive call; with a second factor the code is gone',
    async () => {
      const s = await server()
      const saved = await s.admin(
        'PUT',
        '/v1/admin/settings',
        { signIn: { methods: { password: { enabled: true }, emailCode: { enabled: true } } } },
        { 'if-match': '"0"' }
      )
      expect(saved.status).toBe(200)
      // An account an administrator made, with no password: it signs in with an emailed code.
      const email = freshEmail()
      expect((await s.admin('POST', '/v1/admin/users', { email })).status).toBe(201)
      const { tula } = s.client('ios', { storage: device().storage })
      const flow = await tula.signIn.start({ identifier: email })
      await flow.prepareFirstFactor({ strategy: 'email_code' })
      const step = await flow.attemptFirstFactor({ strategy: 'email_code', code: s.code(email) })
      expect(step.status).toBe('complete')
      expect((await tula.user.get()).hasPassword).toBe(false)
      const sessionId = tula.state.status === 'signed-in' ? tula.state.sessionId : ''
      const sends = () =>
        s.exchanges.filter((sent) => sent.path === '/v1/client/sessions/step-up/email-code')

      // Eleven minutes on, a sensitive call says what this user can prove: only an emailed code.
      s.advance(11 * 60_000)
      const refused = await caught(tula.mfa.startTotp())
      expect(isStepUpRequired(refused)).toBe(true)
      expect(stepUpMethods(refused)).toEqual(['email_code'])
      // The SDK sent no email by itself.
      expect(sends()).toHaveLength(0)

      const receipt = await tula.session.prepareStepUp({ method: 'email_code' })
      expect(receipt).toEqual({
        method: 'email_code',
        destination: expect.stringMatching(/^.\*\*\*@/),
        expiresAt: expect.any(String),
      })
      const code = s.code(email)
      expect(sends().at(-1)?.responseBody).not.toContain(code)
      expect(await caught(tula.session.prepareStepUp({ method: 'email_code' }))).toMatchObject({
        code: 'rate_limited',
        status: 429,
        retryAfterMs: expect.any(Number),
      })

      expect(
        await caught(
          tula.session.stepUp({
            method: 'email_code',
            code: code === '000000' ? '111111' : '000000',
          })
        )
      ).toMatchObject({ code: 'verification.invalid_code', status: 422 })
      const refreshed = refreshes(s).length
      await tula.session.stepUp({ method: 'email_code', code })
      // The same session and a token that says the mailbox was proven, with no refresh made.
      expect(tula.state).toMatchObject({ status: 'signed-in', sessionId })
      expect(claimsOf(await tula.session.getToken()).amr).toContain('email')
      expect(refreshes(s)).toHaveLength(refreshed)
      expect(await caught(tula.session.stepUp({ method: 'email_code', code }))).toMatchObject({
        code: 'verification.expired',
        status: 410,
      })

      // The repeated call succeeds; once the factor is on, the emailed code is no longer a way.
      const { secret } = await tula.mfa.startTotp()
      await tula.mfa.confirmTotp({ code: totp(base32Decode(secret), s.deps.clock.now()) })
      const gone = await caught(tula.session.prepareStepUp({ method: 'email_code' }))
      expect(stepUpMethods(gone)).toEqual(['totp', 'backup_code'])
      expect(
        stepUpMethods(await caught(tula.session.stepUp({ method: 'email_code', code })))
      ).toEqual(['totp', 'backup_code'])
    }
  )

  journey(
    'a session that is not bound behaves as before',
    'device binding: a client created without a key store sends no proof and its session carries no key; a key handed over as an object is refused',
    async () => {
      const s = await server()
      const { tula } = await signUp(s)
      expect(claimsOf(await tula.session.getToken()).cnf).toBeUndefined()
      s.advance(1_000)
      await tula.session.refresh()
      expect(s.exchanges.length).toBeGreaterThan(2)
      for (const exchange of s.exchanges) {
        expect(exchange.headers.get('dpop')).toBeNull()
      }
      expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200])
      expect(() =>
        createExpoClient(
          {
            publishableKey: PUBLISHABLE_KEY,
            baseUrl: s.deps.config.publicUrl,
            deviceKey: {},
          } as never,
          { platform: 'ios', secureStore: fakeSecureStore() }
        )
      ).toThrow(TypeError)
    }
  )
})

// ---------------------------------------------------------------------------------------------
// What only an app does: a provider's round trip through the system browser, back into the app
// by a custom scheme or an app link, and a passkey from the platform's sheet. The shared
// journeys above run the providers' and the passkeys' own rules through the same calls; these
// are the scenarios about the way back and about which app is asking.
// ---------------------------------------------------------------------------------------------

/** The app's custom scheme, as an operator lists it. */
const SCHEME_REDIRECT = 'com.example.journeys:/oauth/callback'
/** An app link: an `https` URL the operating system hands to the app. */
const APP_LINK = 'https://app.example.com/oauth/callback'
/** A loopback page, which the `local` tier allows unlisted. */
const LOOPBACK = 'http://localhost:5173/oauth/callback'

/** A server with the mock provider, and the app's two ways back listed. */
async function appServer(): Promise<Server> {
  const s = await oauthServer()
  s.deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      urls: {
        allowedOrigins: ['http://localhost:5173'],
        allowedRedirectUrls: [SCHEME_REDIRECT, APP_LINK],
      },
    },
  })
  return s
}

/** A client on a device of its own, with what its secure store ever held in view. */
function phone(s: Server, kind: 'ios' | 'android' = 'ios') {
  const { store, storage } = device()
  return { ...s.client(kind, { storage }), store }
}

/** Sign in with a provider through the package's own call; the journey is the browser. */
function withProvider(
  s: Server,
  tula: TulaClient,
  input: { provider: string; redirectUrl: string },
  consent: Record<string, string> | Browse
) {
  const browse: Browse =
    typeof consent === 'function' ? consent : (url) => atProvider(s, url, consent)
  return browsing(tula, browse, () => signInWithProvider(tula, input as ProviderSignInInput))
}

/** The requests a server has seen for the exchange of a ticket. */
const exchanges = (s: Server) =>
  s.exchanges.filter((sent) => sent.path.endsWith('/sign-ins/oauth/exchange'))

/** Whether anything of a round trip (a ticket, a binding, the provider's code) is in `text`. */
const ROUND_TRIP = /tula_ot_|tula_ob_|tula_ticket|[?&#](code|state)=/

describe('Expo journeys: signing in with a provider from the app', () => {
  journey(
    'OAuth sign-up and sign-in',
    'a provider sign-in from the app: started as an ios client, the browser comes back, the app is signed in, and nothing of the round trip is in the secure store, an error or a URL the client built',
    async () => {
      const s = await appServer()
      const email = freshEmail()
      const { tula, store, states } = phone(s)
      expect((await tula.config.get()).signIn.oauth).toEqual(['google'])
      let opened = ''
      let returned = ''
      const outcome = await withProvider(
        s,
        tula,
        { provider: 'google', redirectUrl: LOOPBACK },
        async (url, redirectUrl) => {
          opened = url
          expect(redirectUrl).toBe(LOOPBACK)
          // While the browser is open the binding is kept, in memory, and nobody is signed in.
          expect(hostOf(tula)?.kept()).toBe(1)
          expect(tula.state.status).not.toBe('signed-in')
          expect([...store.entries.values()].join()).not.toMatch(ROUND_TRIP)
          returned = await atProvider(s, url, { email })
          return returned
        }
      )
      expect(outcome.status).toBe('complete')
      expect(returned).toStartWith(`${LOOPBACK}#tula_ticket=`)
      expect(tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      expect(states.map((state) => state.status)).toEqual(['signed-in'])

      // The attempt was the app's: an ios client, with no Origin and no cookie.
      const start = s.exchanges.find((sent) => sent.path === '/v1/client/sign-ins/oauth')
      expect(start?.headers.get('x-tula-client')).toBe('ios')
      expect(start?.headers.get('origin')).toBeNull()
      expect(JSON.parse(start?.requestBody ?? '{}')).toEqual({
        provider: 'google',
        redirectUrl: LOOPBACK,
      })
      // The ticket and the binding went in one JSON body, once.
      const [exchange] = exchanges(s)
      expect(exchanges(s)).toHaveLength(1)
      const sent = JSON.parse(exchange?.requestBody ?? '{}') as Record<string, string>
      expect(returned).toContain(sent.ticket as string)
      expect(sent.binding).toStartWith('tula_ob_')

      // Nothing of the round trip is kept or was ever written: not in memory, not in the
      // secure store (which holds the refresh token and nothing else), not in an address a
      // request went to, and not in what the client or the outcome serialize to.
      expect(hostOf(tula)?.kept()).toBe(0)
      expect([...store.entries.values()]).toEqual([expect.stringMatching(/^tula_rt_/)])
      for (const call of store.calls) {
        expect(JSON.stringify(call)).not.toMatch(ROUND_TRIP)
      }
      for (const request of s.exchanges) {
        expect(request.path).not.toMatch(ROUND_TRIP)
      }
      expect(JSON.stringify([tula, outcome])).not.toMatch(ROUND_TRIP)
      expect(JSON.stringify([tula, outcome])).not.toContain(sent.binding as string)
      // The page the provider showed was the API's own URL, opened as it was handed over.
      expect(opened).toStartWith(`${new URL(opened).origin}/v1/dev/oauth/authorize?`)

      // Signing in again finds the same account.
      const userId = tula.state.status === 'signed-in' ? (tula.state.user?.id ?? '') : ''
      await tula.session.signOut()
      const again = phone(s)
      expect(
        (
          await withProvider(
            s,
            again.tula,
            { provider: 'google', redirectUrl: LOOPBACK },
            { email }
          )
        ).status
      ).toBe('complete')
      expect(again.tula.state).toMatchObject({ status: 'signed-in', user: { id: userId } })
    }
  )

  journey(
    'OAuth sign-up and sign-in',
    'what the browser comes back with is exchanged only when it is the redirect URL that was asked for and this client started the round trip; a closed browser, a refusal at the provider and an unverified address are outcomes',
    async () => {
      const s = await appServer()
      const input = { provider: 'google', redirectUrl: LOOPBACK }

      // Someone else's round trip, stopped before their app: its ticket is real.
      let stolen = ''
      const attacker = phone(s)
      expect(
        await withProvider(s, attacker.tula, input, async (url) => {
          stolen = await atProvider(s, url, { email: freshEmail() })
          return null
        })
      ).toEqual({ status: 'cancelled' })
      expect(stolen).toStartWith(`${LOOPBACK}#tula_ticket=`)
      expect(hostOf(attacker.tula)?.kept()).toBe(0)

      // The victim's app is handed that URL by its own browser session: no binding of this
      // client belongs to it, so it is refused without a request.
      const victim = phone(s)
      const before = exchanges(s).length
      expect(await withProvider(s, victim.tula, input, async () => stolen)).toEqual({
        status: 'refused',
        reason: 'not_started_here',
      })
      expect(victim.tula.state.status).not.toBe('signed-in')
      expect([...victim.store.entries.values()]).toEqual([])
      expect(hostOf(victim.tula)?.kept()).toBe(0)

      // What a platform may hand back although it is not the redirect URL (iOS matches a
      // custom scheme by scheme, Android by prefix), with a ticket this client's own round
      // trip earned: never exchanged.
      for (const bend of [
        (url: string) => url.replace(LOOPBACK, `${LOOPBACK}/more`),
        (url: string) => url.replace(LOOPBACK, `${LOOPBACK}?next=1`),
        (url: string) => url.replace(LOOPBACK, 'http://localhost:5173/other'),
        (url: string) => url.replace('http://localhost:5173', 'https://evil.example'),
        (url: string) => url.replace('#', '?'),
        (url: string) => url.slice(0, url.indexOf('#')),
        () => '',
      ]) {
        const app = phone(s)
        const refused = await withProvider(s, app.tula, input, async (url) =>
          bend(await atProvider(s, url, { email: freshEmail() }))
        )
        expect(refused.status).toBe('refused')
        expect(app.tula.state.status).not.toBe('signed-in')
        expect(hostOf(app.tula)?.kept()).toBe(0)
      }
      // The right URL with nothing in its fragment that the API wrote.
      const empty = phone(s)
      expect(await withProvider(s, empty.tula, input, async () => `${LOOPBACK}#hello=1`)).toEqual({
        status: 'refused',
        reason: 'no_answer',
      })
      expect(exchanges(s)).toHaveLength(before)

      // The user closes the browser: neither an error nor a sign-in.
      const closed = phone(s)
      expect(await withProvider(s, closed.tula, input, async () => null)).toEqual({
        status: 'cancelled',
      })
      expect(closed.tula.state.status).not.toBe('signed-in')
      expect(hostOf(closed.tula)?.kept()).toBe(0)
      // And the same client signs in at the next try.
      expect((await withProvider(s, closed.tula, input, { email: freshEmail() })).status).toBe(
        'complete'
      )

      const denied = phone(s)
      expect(await withProvider(s, denied.tula, input, { action: 'deny' })).toMatchObject({
        status: 'error',
        code: 'oauth.access_denied',
      })
      expect(hostOf(denied.tula)?.kept()).toBe(0)
      const unverified = phone(s)
      expect(
        await withProvider(s, unverified.tula, input, { email: freshEmail(), unverified: '1' })
      ).toMatchObject({ status: 'error', code: 'oauth.email_unverified' })
      expect(unverified.tula.state.status).not.toBe('signed-in')

      // The client's own page-shaped calls do nothing here: an app has no page.
      const direct = phone(s)
      const requests = s.exchanges.length
      expect(
        (
          await caught(
            direct.tula.signIn.withOAuth({ provider: 'google', redirectUrl: SCHEME_REDIRECT })
          )
        ).code
      ).toBe('link.cross_origin')
      expect(await direct.tula.signIn.handleOAuthCallback()).toEqual({ status: 'none' })
      expect(s.exchanges).toHaveLength(requests)
    }
  )

  journey(
    'provider sign-in returned to a custom scheme',
    'a provider sign-in comes back to the app’s custom scheme: the listed entry, character for character, and only for the app',
    async () => {
      const s = await appServer()
      const email = freshEmail()
      for (const kind of ['ios', 'android'] as const) {
        const app = phone(s, kind)
        let returned = ''
        const outcome = await withProvider(
          s,
          app.tula,
          { provider: 'google', redirectUrl: SCHEME_REDIRECT },
          async (url) => {
            returned = await atProvider(s, url, { email })
            return returned
          }
        )
        expect(returned).toStartWith(`${SCHEME_REDIRECT}#tula_ticket=`)
        expect(outcome.status).toBe('complete')
        expect(app.tula.state).toMatchObject({ status: 'signed-in', user: { email } })
        expect([...app.store.entries.values()]).toEqual([expect.stringMatching(/^tula_rt_/)])
        expect(hostOf(app.tula)?.kept()).toBe(0)
      }

      // Another app's URL of the same scheme (iOS hands back whatever has the scheme), and a
      // longer one (Android matches by prefix), with a real ticket: never exchanged.
      const before = exchanges(s).length
      for (const bend of [
        (url: string) => url.replace(SCHEME_REDIRECT, 'com.example.journeys:/elsewhere'),
        (url: string) => url.replace(SCHEME_REDIRECT, `${SCHEME_REDIRECT}/more`),
        (url: string) => url.replace(SCHEME_REDIRECT, 'com.example.journeys://oauth/callback'),
      ]) {
        const app = phone(s)
        expect(
          await withProvider(
            s,
            app.tula,
            { provider: 'google', redirectUrl: SCHEME_REDIRECT },
            async (url) => bend(await atProvider(s, url, { email }))
          )
        ).toEqual({ status: 'refused', reason: 'unexpected_return' })
        expect(app.tula.state.status).not.toBe('signed-in')
      }
      expect(exchanges(s)).toHaveLength(before)

      // Connecting an account from a profile is a browser's attempt on the server: the
      // scheme is refused for it, with the server's own reason, and no browser is opened.
      const member = phone(s)
      await withProvider(s, member.tula, { provider: 'google', redirectUrl: LOOPBACK }, { email })
      const refused = await caught(
        browsing(
          member.tula,
          async () => {
            throw new Error('the browser was opened for a redirect the server refused')
          },
          () => linkProvider(member.tula, { provider: 'google', redirectUrl: SCHEME_REDIRECT })
        )
      )
      expect(refused).toMatchObject({
        code: 'request.redirect_not_allowed',
        params: { reason: 'client_not_native' },
      })
      expect(hostOf(member.tula)?.kept()).toBe(0)
    }
  )

  journey(
    'provider sign-in returned to an app link',
    'a provider sign-in comes back to an app link, an https entry matched exactly; a profile connects an account the same way',
    async () => {
      const s = await appServer()
      const email = freshEmail()
      const app = phone(s)
      let returned = ''
      const outcome = await withProvider(
        s,
        app.tula,
        { provider: 'google', redirectUrl: APP_LINK },
        async (url, redirectUrl) => {
          expect(redirectUrl).toBe(APP_LINK)
          returned = await atProvider(s, url, { email })
          return returned
        }
      )
      expect(returned).toStartWith(`${APP_LINK}#tula_ticket=`)
      expect(outcome.status).toBe('complete')
      expect(app.tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      expect(hostOf(app.tula)?.kept()).toBe(0)

      // The same host with another path is somebody else's page, not this app's link.
      const before = exchanges(s).length
      const other = phone(s)
      expect(
        await withProvider(
          s,
          other.tula,
          { provider: 'google', redirectUrl: APP_LINK },
          async (url) =>
            (await atProvider(s, url, { email })).replace(APP_LINK, 'https://app.example.com/')
        )
      ).toEqual({ status: 'refused', reason: 'unexpected_return' })
      expect(exchanges(s)).toHaveLength(before)

      // From the profile: the session is the proof, and the way back is the app link.
      const member = await signUp(s)
      const linked = await browsing(
        member.tula,
        (url) => atProvider(s, url, { email: freshEmail(), subject: 'second-account' }),
        () => linkProvider(member.tula, { provider: 'google', redirectUrl: APP_LINK })
      )
      expect(linked).toMatchObject({ status: 'linked', identity: { provider: 'google' } })
      expect(await member.tula.user.identities.list()).toHaveLength(1)
      expect(hostOf(member.tula)?.kept()).toBe(0)
    }
  )

  journey(
    'custom scheme refused for a provider without PKCE',
    'a provider that binds its code with nothing but the client secret is refused the custom scheme, with the server’s reason and no browser opened; an app link serves it',
    async () => {
      const s = await appServer()
      for (const provider of ['linkedin', 'facebook']) {
        const saved = await s.admin('PUT', `/v1/admin/oauth-providers/${provider}`, {
          clientId: `journey-${provider}-client`,
          clientSecret: `journey-${provider}-secret`,
        })
        expect(saved.status).toBe(200)
        const app = phone(s)
        const refused = await caught(
          withProvider(s, app.tula, { provider, redirectUrl: SCHEME_REDIRECT }, async () => {
            throw new Error('the browser was opened for a redirect the server refused')
          })
        )
        expect(refused).toMatchObject({
          code: 'request.redirect_not_allowed',
          status: 400,
          params: { reason: 'provider_without_pkce' },
        })
        expect(app.tula.state.status).not.toBe('signed-in')
        expect(hostOf(app.tula)?.kept()).toBe(0)

        // The same provider, back by the app link: allowed.
        const linked = await withProvider(
          s,
          app.tula,
          { provider, redirectUrl: APP_LINK },
          provider === 'facebook'
            ? { subject: '10203040506070809' }
            : { email: freshEmail(), subject: `li-${crypto.randomUUID()}` }
        )
        expect(linked.status).toBe('complete')
      }
      // Google sends PKCE and is served the scheme.
      expect(
        (
          await withProvider(
            s,
            phone(s).tula,
            { provider: 'google', redirectUrl: SCHEME_REDIRECT },
            { email: freshEmail() }
          )
        ).status
      ).toBe('complete')
    }
  )

  journey(
    'app link or custom scheme that is not listed',
    'a redirect URL that is not, character for character, a listed entry is refused at the start: no browser is opened and nothing is kept',
    async () => {
      const s = await appServer()
      // Outside the `local` tier a loopback page needs listing too: the exact match decides.
      s.deps.config = { ...s.deps.config, tier: 'dev' }
      for (const redirectUrl of [
        'com.example.other:/oauth/callback',
        `${SCHEME_REDIRECT}/`,
        `${SCHEME_REDIRECT}/more`,
        'com.example.journeys:/oauth/Callback',
        'com.example.journeys://oauth/callback',
        `${APP_LINK}/`,
        `${APP_LINK}?next=1`,
        'https://app.example.com/oauth/Callback',
        'https://other.example.com/oauth/callback',
        LOOPBACK,
      ]) {
        const app = phone(s)
        const refused = await caught(
          withProvider(s, app.tula, { provider: 'google', redirectUrl }, async () => {
            throw new Error(`the browser was opened for ${redirectUrl}`)
          })
        )
        expect(refused.code, redirectUrl).toBe('request.redirect_not_allowed')
        // An unlisted URL is given no reason: the reasons are for a listed custom scheme.
        expect(refused.params?.reason, redirectUrl).toBeUndefined()
        expect(hostOf(app.tula)?.kept()).toBe(0)
        expect([...app.store.entries.values()]).toEqual([])
      }
      // The listed entries, as they are written, start the round trip: the browser is opened
      // on the provider's page. (The mock provider has no page outside the `local` tier, so
      // the user closes it here; the journeys above go all the way.)
      for (const redirectUrl of [SCHEME_REDIRECT, APP_LINK]) {
        const opened: string[] = []
        expect(
          await withProvider(
            s,
            phone(s).tula,
            { provider: 'google', redirectUrl },
            async (url, back) => {
              opened.push(url, back)
              return null
            }
          )
        ).toEqual({ status: 'cancelled' })
        expect(opened).toEqual([expect.stringContaining('/v1/dev/oauth/authorize?'), redirectUrl])
      }
    }
  )
})

describe('Expo journeys: a passkey from the app, and which app is asking', () => {
  const RP_ID = 'localhost'
  /** The signing certificates of two builds of the Android app, and of somebody else's app. */
  const FIRST_BUILD = fingerprintOf(1)
  const SECOND_BUILD = fingerprintOf(2)
  const STRANGER = fingerprintOf(3)
  const ANDROID_APP = { platform: 'android', packageName: 'com.example.journeys' }

  function fingerprintOf(seed: number): string {
    return Array.from({ length: 32 }, (_, index) =>
      ((seed * 37 + index * 11) % 256).toString(16).padStart(2, '0').toUpperCase()
    ).join(':')
  }

  /** The origin Credential Manager is taken to write for a build signed with `fingerprint`. */
  function originOf(fingerprint: string): string {
    const origin = androidApkKeyHashOrigin(fingerprint)
    if (!origin) {
      throw new Error('not a fingerprint')
    }
    return origin
  }

  /** Passkeys on, with a relying party; `allowRelyingParty` lists its own origin as a page's. */
  function passkeysOn(s: Server, allowRelyingParty = false) {
    s.deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        signIn: {
          methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, passkey: { enabled: true } },
        },
        urls: {
          allowedOrigins: [
            'http://localhost:5173',
            ...(allowRelyingParty ? [`https://${RP_ID}`] : []),
          ],
          allowedRedirectUrls: [],
        },
        passkeys: { rpId: RP_ID },
      },
    })
  }

  /** Put an authenticator behind the sheet, as the build whose responses carry `origin`. */
  function sheetOf(authenticator: VirtualAuthenticator, origin: string) {
    passkeySheet = {
      create: (options) => authenticator.create(options, { origin }),
      get: (options) => authenticator.get(options, { origin }),
    }
  }

  afterEach(() => {
    passkeySheet = null
  })

  journey(
    ['passkey registration from a native app', 'passkey sign-in from a native app'],
    'an Android app and an iOS app each add a passkey and sign in with it, once the operator has registered them; before that there is no ceremony',
    async () => {
      const s = await server()
      passkeysOn(s)
      const authenticator = new VirtualAuthenticator()

      // Android: nothing registered, so a request with no Origin has no ceremony at all.
      const android = await signUp(s, 'android')
      sheetOf(authenticator, originOf(FIRST_BUILD))
      expect(android.tula.signIn.canUsePasskey()).toBe(true)
      expect(await caught(android.tula.user.passkeys.add())).toMatchObject({
        code: 'request.origin_not_allowed',
        status: 403,
      })
      expect(await caught(s.client('android').tula.signIn.withPasskey())).toMatchObject({
        code: 'request.origin_not_allowed',
      })
      const registered = await s.admin('POST', '/v1/admin/native-apps', {
        ...ANDROID_APP,
        sha256CertFingerprints: [FIRST_BUILD],
      })
      expect(registered.status).toBe(201)
      const added = await android.tula.user.passkeys.add({ name: 'Pixel' })
      expect(added).toMatchObject({ name: 'Pixel', lastUsedAt: null })
      // Every passkey request of the app went out as an android client with no Origin.
      for (const sent of s.exchanges.filter((exchange) => exchange.path.includes('passkey'))) {
        expect(sent.headers.get('x-tula-client')).toBe('android')
        expect(sent.headers.get('origin')).toBeNull()
      }

      const visitor = s.client('android')
      const flow = await visitor.tula.signIn.withPasskey()
      expect(flow.step.status).toBe('complete')
      expect(visitor.tula.state).toMatchObject({
        status: 'signed-in',
        user: { email: android.email },
      })
      expect(new Set(claimsOf(await visitor.tula.session.getToken()).amr as string[])).toEqual(
        new Set(['hwk', 'user', 'mfa'])
      )

      // iOS: the app is registered, but its origin is the relying party's own, a page's
      // origin too, and the operator has not allowed it: no ceremony, as with no app.
      const ios = await signUp(s, 'ios')
      const iphone = new VirtualAuthenticator()
      sheetOf(iphone, `https://${RP_ID}`)
      expect((await s.admin('POST', '/v1/admin/native-apps', IOS_APP)).status).toBe(201)
      expect(await caught(ios.tula.user.passkeys.add())).toMatchObject({
        code: 'request.origin_not_allowed',
      })
      passkeysOn(s, true)
      expect(await ios.tula.user.passkeys.add({ name: 'iPhone' })).toMatchObject({ name: 'iPhone' })
      const again = s.client('ios')
      expect((await again.tula.signIn.withPasskey()).step.status).toBe('complete')
      expect(again.tula.state).toMatchObject({ status: 'signed-in', user: { email: ios.email } })

      // An Android build's response is not an iOS app's: one platform's origin is never
      // accepted under the other's name.
      sheetOf(authenticator, originOf(FIRST_BUILD))
      expect(await caught(s.client('ios').tula.signIn.withPasskey())).toMatchObject({
        code: 'auth.invalid_credentials',
        status: 401,
      })
    }
  )

  journey(
    'passkey sign-in from an unregistered app',
    'an app the operator has not registered gets the one generic answer for a passkey it holds, and cannot add one',
    async () => {
      const s = await server()
      passkeysOn(s)
      const registered = await s.admin('POST', '/v1/admin/native-apps', {
        ...ANDROID_APP,
        sha256CertFingerprints: [FIRST_BUILD],
      })
      const appId = ((await registered.json()) as { id: string }).id
      const owner = await signUp(s, 'android')
      const authenticator = new VirtualAuthenticator()
      sheetOf(authenticator, originOf(FIRST_BUILD))
      await owner.tula.user.passkeys.add()

      // Another app holds the same passkey (a synced one, say) and presents its own origin.
      sheetOf(authenticator, originOf(STRANGER))
      const stranger = s.client('android')
      const refused = await caught(stranger.tula.signIn.withPasskey())
      expect(refused).toMatchObject({ code: 'auth.invalid_credentials', status: 401 })
      expect(stranger.tula.state.status).not.toBe('signed-in')
      expect(stranger.states).toEqual([])
      // Nor can it add one: a new authenticator, so that nothing but the origin is in the way.
      sheetOf(new VirtualAuthenticator(), originOf(STRANGER))
      expect(await caught(owner.tula.user.passkeys.add())).toMatchObject({
        code: 'passkey.registration_failed',
        status: 422,
      })

      // The operator removes the app: its own build is answered as any unregistered one.
      expect((await s.admin('DELETE', `/v1/admin/native-apps/${appId}`)).status).toBe(204)
      sheetOf(authenticator, originOf(FIRST_BUILD))
      expect(await caught(s.client('android').tula.signIn.withPasskey())).toMatchObject({
        code: 'request.origin_not_allowed',
      })
      // The passkey stayed on the account.
      expect(await owner.tula.user.passkeys.list()).toHaveLength(1)
    }
  )

  journey(
    'passkey sign-in with a fingerprint that is not the registered one',
    'a build whose certificate the operator takes away is refused from then on; the passkey stays and the other build signs in with it',
    async () => {
      const s = await server()
      passkeysOn(s)
      const registered = await s.admin('POST', '/v1/admin/native-apps', {
        ...ANDROID_APP,
        sha256CertFingerprints: [FIRST_BUILD, SECOND_BUILD],
      })
      const appId = ((await registered.json()) as { id: string }).id
      const owner = await signUp(s, 'android')
      const authenticator = new VirtualAuthenticator()
      sheetOf(authenticator, originOf(FIRST_BUILD))
      await owner.tula.user.passkeys.add()
      expect((await s.client('android').tula.signIn.withPasskey()).step.status).toBe('complete')

      const narrowed = await s.admin('PATCH', `/v1/admin/native-apps/${appId}`, {
        sha256CertFingerprints: [SECOND_BUILD],
      })
      expect(narrowed.status).toBe(200)
      const old = s.client('android')
      expect(await caught(old.tula.signIn.withPasskey())).toMatchObject({
        code: 'auth.invalid_credentials',
        status: 401,
      })
      expect(old.tula.state.status).not.toBe('signed-in')
      sheetOf(new VirtualAuthenticator(), originOf(FIRST_BUILD))
      expect(await caught(owner.tula.user.passkeys.add())).toMatchObject({
        code: 'passkey.registration_failed',
      })

      sheetOf(authenticator, originOf(SECOND_BUILD))
      const current = s.client('android')
      expect((await current.tula.signIn.withPasskey()).step.status).toBe('complete')
      expect(current.tula.state).toMatchObject({ user: { email: owner.email } })
    }
  )
})

// ---------------------------------------------------------------------------------------------
// What TULA-73 added (ADR 0055): an emailed sign-in link that opens the app. The journey hands
// the package the URL as an app would be handed it by the operating system; no deep link was
// ever opened on a simulator or a device, and no association file was ever fetched by one.
// ---------------------------------------------------------------------------------------------

describe('Expo journeys: an emailed sign-in link', () => {
  /** The app link the app's emailed links lead to: an `https` URL the environment lists. */
  const EMAIL_APP_LINK = 'https://app.example.com/sign-in/link'
  /** An emailed link, as the server writes it into an email's text. */
  const EMAILED_LINK = /https:\/\/\S+#\S*tula_link=\S+/

  /** A server where an emailed link signs in, with the app's link listed (or another). */
  async function linkServer(redirectUrls: string[] = [EMAIL_APP_LINK]): Promise<Server> {
    const s = await server()
    const saved = await s.admin(
      'PUT',
      '/v1/admin/settings',
      {
        signIn: {
          methods: {
            password: { enabled: true },
            emailCode: { enabled: true },
            emailLink: { enabled: true },
          },
        },
        urls: { allowedRedirectUrls: redirectUrls },
      },
      { 'if-match': '"0"' }
    )
    expect(saved.status).toBe(200)
    return s
  }

  /** A phone whose app has the app link, with what its secure store ever held in view. */
  function linkPhone(
    s: Server,
    url = EMAIL_APP_LINK,
    loseResponse?: (request: Request) => boolean
  ) {
    const made = device()
    made.withEmailLink(url)
    return {
      ...s.client('ios', { storage: made.storage, ...(loseResponse && { loseResponse }) }),
      store: made.store,
    }
  }

  /** Present a link to the API as a client that kept no binding would. No SDK does this. */
  function presentWithoutBinding(s: Server, link: string) {
    const fragment = new URLSearchParams(link.slice(link.indexOf('#') + 1))
    return s.navigate('/v1/client/sign-ins/link', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tula-publishable-key': PUBLISHABLE_KEY,
        'x-tula-client': 'ios',
      },
      body: JSON.stringify({
        token: fragment.get('tula_link'),
        attemptId: fragment.get('tula_attempt'),
      }),
    })
  }

  const linkCalls = (s: Server) =>
    s.exchanges.filter((exchange) => exchange.path === '/v1/client/sign-ins/link')

  journey(
    'email link sign-in',
    'email link: refused on another phone without a request, refused by the server without the binding, accepted in the app that asked, which is the one signed in',
    async () => {
      const s = await linkServer()
      const { email } = await signUp(s)
      // A minute after the sign-up's own email: the next one may be sent.
      s.advance(61_000)

      // The phone the user starts on.
      const mine = linkPhone(s)
      expect(mine.tula.signIn.canUseEmailLink()).toBe(true)
      expect(waysOf(mine.tula).emailLink).toBe(true)
      const flow = await mine.tula.signIn.start({ identifier: email })
      expect((flow.step as { strategies: string[] }).strategies).toContain('email_link')
      const mails = s.deps.mailer.outbox.length
      const prepared = await requestEmailLink(mine.tula, flow)
      expect(prepared).toMatchObject({ prepared: { strategy: 'email_link' } })
      expect(s.deps.mailer.outbox).toHaveLength(mails + 1)
      const link = EMAILED_LINK.exec(s.deps.mailer.last().text)?.[0] ?? ''
      expect(link).toStartWith(`${EMAIL_APP_LINK}#tula_link=`)
      const token = new URLSearchParams(link.slice(link.indexOf('#') + 1)).get('tula_link') ?? ''
      expect(token.length).toBeGreaterThan(20)
      // The binding is kept by the client, in memory: the secure store was written nothing.
      expect(hostOf(mine.tula)?.linksKept()).toBe(1)
      expect(mine.store.calls.filter((call) => call.operation === 'set')).toEqual([])
      expect(mine.store.entries.size).toBe(0)

      // Somebody else's phone, with the same app and a sign-in of its own for the address:
      // the link is not worth a request there.
      const theirs = linkPhone(s)
      const other = await theirs.tula.signIn.start({ identifier: email })
      const before = s.exchanges.length
      expect(isEmailLink(theirs.tula, link)).toBe(true)
      expect(await openEmailLink(theirs.tula, other, link)).toEqual({
        status: 'refused',
        reason: 'not_started_here',
      })
      expect(s.exchanges).toHaveLength(before)
      expect(theirs.tula.state.status).not.toBe('signed-in')

      // A client that sent it anyway, with no binding: the server's own refusal, and
      // nothing is spent by it.
      const unbound = await presentWithoutBinding(s, link)
      expect(unbound.status).toBe(409)
      expect(await unbound.json()).toMatchObject({ code: 'verification.different_browser' })
      expect(unbound.headers.get('set-cookie')).toBeNull()

      // What else the operating system might hand the app: neither a longer path nor
      // another host is this app's link.
      for (const near of [
        link.replace(EMAIL_APP_LINK, `${EMAIL_APP_LINK}/`),
        link.replace('app.example.com', 'evil.example.com'),
      ]) {
        expect(await openEmailLink(mine.tula, flow, near)).toEqual({
          status: 'refused',
          reason: 'unexpected_url',
        })
      }
      expect(linkCalls(s)).toHaveLength(0)

      // The phone that asked.
      const outcome = await openEmailLink(mine.tula, flow, link)
      expect(outcome).toMatchObject({ status: 'accepted', step: { status: 'complete' } })
      expect(mine.tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      expect([...mine.store.entries.values()]).toHaveLength(1)
      expect([...mine.store.entries.values()][0]).toStartWith('tula_rt_')
      expect(hostOf(mine.tula)?.linksKept()).toBe(0)
      // The other phone is where it was.
      expect(theirs.tula.state.status).not.toBe('signed-in')

      // The link's token only ever travelled in a request body, to one route, once.
      const carried = s.exchanges.filter((exchange) => exchange.requestBody.includes(token))
      expect(carried.map((exchange) => exchange.path)).toEqual(['/v1/client/sign-ins/link'])
      expect(s.exchanges.some((exchange) => exchange.path.includes(token))).toBe(false)
      for (const exchange of s.exchanges) {
        for (const [name, value] of exchange.headers) {
          expect(value, name).not.toContain(token)
        }
      }
      // Accepting the link returned no tokens and set no cookie: only the completing call,
      // made by the sign-in that holds the attempt's secret, did.
      expect(carried[0]?.responseBody).toBe('{"status":"verified"}')
      expect(carried[0]?.setCookie).toBeNull()
      expect(carried[0]?.headers.get('x-tula-attempt')).toBeNull()
      // The binding travelled the same way and no other: in that one body.
      const binding =
        (JSON.parse(carried[0]?.requestBody ?? '{}') as { binding?: string }).binding ?? ''
      expect(binding).toStartWith('tula_lb_')
      for (const exchange of s.exchanges) {
        expect(exchange.path).not.toContain(binding)
        if (exchange !== carried[0]) {
          expect(exchange.requestBody).not.toContain(binding)
        }
      }
      // Nothing of the link was ever given to the secure store.
      for (const call of mine.store.calls) {
        expect(JSON.stringify(call)).not.toContain(token)
        expect(JSON.stringify(call)).not.toContain(binding)
      }
      expect([...mine.store.entries.values()].join()).not.toContain('tula_lb_')

      // The same link again: not worth a request in the app (its sign-in is over), and
      // dead on the server whoever presents it.
      const requests = s.exchanges.length
      expect(await openEmailLink(mine.tula, flow, link)).toEqual({
        status: 'refused',
        reason: 'not_started_here',
      })
      expect(s.exchanges).toHaveLength(requests)
      const replayed = await presentWithoutBinding(s, link)
      expect(await replayed.json()).toMatchObject({ code: 'verification.expired' })
    }
  )

  test('a link the server took while its answer was lost: the open says no answer, the same URL is then `expired`, and the sign-in that asked still finishes', async () => {
    for (const finish of ['openEmailLink again, then the flow', 'the flow at once'] as const) {
      const s = await linkServer()
      const { email } = await signUp(s)
      s.advance(61_000)
      let lose = true
      const mine = linkPhone(
        s,
        EMAIL_APP_LINK,
        (request) => lose && new URL(request.url).pathname === '/v1/client/sign-ins/link'
      )
      const flow = await mine.tula.signIn.start({ identifier: email })
      await requestEmailLink(mine.tula, flow)
      const link = EMAILED_LINK.exec(s.deps.mailer.last().text)?.[0] ?? ''

      // The server takes the link (the real route ran), and the answer never arrives.
      const thrown = await caught(openEmailLink(mine.tula, flow, link))
      expect(thrown).toMatchObject({ code: 'network.failed', status: 0 })
      expect(linkCalls(s).map((exchange) => exchange.status)).toEqual([200])
      expect(mine.tula.state.status).not.toBe('signed-in')
      // The client cannot know the link was taken: it still keeps the binding.
      expect(hostOf(mine.tula)?.linkKept(flow.id)).toBe(true)
      lose = false

      if (finish === 'openEmailLink again, then the flow') {
        // The same URL again reaches the server, which has spent it: `expired`, and nothing
        // more is spent or counted by asking.
        expect(await openEmailLink(mine.tula, flow, link)).toEqual({ status: 'expired' })
        expect(linkCalls(s).map((exchange) => exchange.status)).toEqual([200, 410])
        expect(mine.tula.state.status).not.toBe('signed-in')
      }
      // The sign-in that asked holds the attempt's secret, and the attempt is proven: asking
      // it to finish is what signs in. No second link, no code.
      expect((await flow.attemptFirstFactor({ strategy: 'email_link' })).status).toBe('complete')
      expect(mine.tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      expect([...mine.store.entries.values()].join()).not.toContain('tula_lb_')
      expect(JSON.stringify({ ...thrown, message: thrown.message })).not.toContain('tula_')
    }
  })

  test('asking a sign-in to finish whose link nobody opened costs nothing: the same step, as often as it is asked', async () => {
    const s = await linkServer()
    const { email } = await signUp(s)
    s.advance(61_000)
    const mine = linkPhone(s)
    const flow = await mine.tula.signIn.start({ identifier: email })
    const asked = await requestEmailLink(mine.tula, flow)
    const link = EMAILED_LINK.exec(s.deps.mailer.last().text)?.[0] ?? ''
    // More often than a guessed code could be tried: nothing is counted against the attempt.
    for (let round = 0; round < 12; round += 1) {
      expect(await flow.attemptFirstFactor({ strategy: 'email_link' })).toEqual(asked)
    }
    expect(mine.tula.state.status).not.toBe('signed-in')
    // The link is as good as it was.
    expect(await openEmailLink(mine.tula, flow, link)).toMatchObject({
      status: 'accepted',
      step: { status: 'complete' },
    })
  })

  test('after the app is ended and started again the link opens nothing, without a request, and signs nobody in', async () => {
    const s = await linkServer()
    const { email } = await signUp(s)
    s.advance(61_000)
    // One phone, one secure store; the app is started twice.
    const made = device()
    made.withEmailLink(EMAIL_APP_LINK)
    const first = s.client('ios', { storage: made.storage })
    const flow = await first.tula.signIn.start({ identifier: email })
    await requestEmailLink(first.tula, flow)
    const link = EMAILED_LINK.exec(s.deps.mailer.last().text)?.[0] ?? ''

    const second = s.client('ios', { storage: made.storage })
    await second.tula.load()
    expect(second.tula.state.status).toBe('signed-out')
    expect(hostOf(second.tula)?.linksKept()).toBe(0)
    const again = await second.tula.signIn.start({ identifier: email })
    const requests = s.exchanges.length
    expect(await openEmailLink(second.tula, again, link)).toEqual({
      status: 'refused',
      reason: 'not_started_here',
    })
    expect(s.exchanges).toHaveLength(requests)
    expect(second.tula.state.status).toBe('signed-out')
    // What is left to the user is to ask again, in the app as it runs now: here, the code
    // of a new email.
    s.advance(61_000)
    await again.prepareFirstFactor({ strategy: 'email_code' })
    expect(
      (await again.attemptFirstFactor({ strategy: 'email_code', code: s.code(email) })).status
    ).toBe('complete')
  })

  test('an app link the environment does not list is the server’s refusal, and no email is sent', async () => {
    const s = await linkServer(['https://app.example.com/somewhere/else'])
    const { email } = await signUp(s)
    s.advance(61_000)
    const { tula } = linkPhone(s)
    const flow = await tula.signIn.start({ identifier: email })
    const mails = s.deps.mailer.outbox.length
    expect(await caught(requestEmailLink(tula, flow))).toMatchObject({
      code: 'request.redirect_not_allowed',
    })
    expect(s.deps.mailer.outbox).toHaveLength(mails)
    expect(hostOf(tula)?.linksKept()).toBe(0)
  })

  test('without the app link asking for an emailed link is refused before any request, and the code in the same email signs in', async () => {
    const s = await linkServer()
    const { email } = await signUp(s)
    const { tula } = phone(s)
    expect(tula.signIn.canUseEmailLink()).toBe(false)
    expect(waysOf(tula).emailLink).toBe(false)
    const flow = await tula.signIn.start({ identifier: email })
    expect(flow.step).toMatchObject({ status: 'needs_first_factor' })
    expect((flow.step as { strategies: string[] }).strategies).toContain('email_link')
    const mails = s.deps.mailer.outbox.length
    const requests = s.exchanges.length
    for (const refused of [
      await caught(
        flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: EMAIL_APP_LINK })
      ),
      await caught(requestEmailLink(tula, flow)),
    ]) {
      expect(refused).toMatchObject({ code: 'storage.failed', status: 0 })
    }
    expect(s.exchanges).toHaveLength(requests)
    expect(s.deps.mailer.outbox).toHaveLength(mails)
    // A link somebody else's client asked for, opened in the app: nothing to handle it.
    expect(await tula.signIn.handleEmailLink()).toMatchObject({ status: 'none' })
    expect(s.exchanges).toHaveLength(requests)

    // The stated path: the code (a minute after the sign-up's own email).
    s.advance(61_000)
    await flow.prepareFirstFactor({ strategy: 'email_code' })
    const step = await flow.attemptFirstFactor({ strategy: 'email_code', code: s.code(email) })
    expect(step.status).toBe('complete')
    expect(tula.state.status).toBe('signed-in')
  })
})

// ---------------------------------------------------------------------------------------------
// What TULA-55 added (ADR 0052): Google's and Apple's own sheets through the package's call,
// and a session bound to a key the phone's key store keeps. The sheets are a journey's answers
// and the keys are software keys behind the key store's interface: no sheet was ever shown
// and no secure hardware was ever asked, on a simulator or a device.
// ---------------------------------------------------------------------------------------------

describe('Expo journeys: Google’s and Apple’s own sheets', () => {
  const WEB_CLIENT = '1234567890-expoweb.apps.googleusercontent.com'
  const IOS_CLIENT = '1234567890-expoios.apps.googleusercontent.com'
  const APPLE_BUNDLE = 'app.tula.journey.expo'
  const APPLE_TEAM = 'J0URNEYTEA'

  const idTokenCalls = (s: Server) =>
    s.exchanges.filter((exchange) => exchange.path.endsWith('/id-token'))

  /** Google's sheet as the mock provider answers for it: a token with the nonce it was given. */
  const google =
    (s: Server, email: string): AtSheet =>
    async (provider, nonce) => ({
      idToken: await issueMockIdToken(s.deps.secretBox, s.deps.clock, provider as 'google', {
        aud: IOS_CLIENT,
        sub: `google-${email}`,
        nonce,
        email,
        email_verified: true,
      }),
    })

  /** Apple's sheet: the token's nonce is what the sheet was handed, and the name is beside it. */
  const apple =
    (s: Server, email: string, name?: { givenName: string; familyName: string }): AtSheet =>
    async (provider, nonce) => ({
      idToken: await issueMockIdToken(s.deps.secretBox, s.deps.clock, provider as 'apple', {
        aud: APPLE_BUNDLE,
        sub: `apple-${email}`,
        nonce,
        nonce_supported: true,
        email,
        email_verified: 'true',
        is_private_email: 'false',
      }),
      ...name,
    })

  async function googleServer(): Promise<Server> {
    const s = await oauthServer()
    const saved = await s.admin('PUT', '/v1/admin/oauth-providers/google', {
      clientId: WEB_CLIENT,
      additionalClientIds: [IOS_CLIENT],
    })
    expect(saved.status).toBe(200)
    return s
  }

  async function appleServer(): Promise<Server> {
    const s = await oauthServer()
    const saved = await s.admin('PUT', '/v1/admin/oauth-providers/apple', {
      clientId: 'app.tula.journey.signin',
      teamId: APPLE_TEAM,
      keyId: 'J0URNEYKEY',
      privateKey: await throwawayP256PrivateKey(),
    })
    expect(saved.status).toBe(200)
    const app = await s.admin('POST', '/v1/admin/native-apps', {
      platform: 'ios',
      teamId: APPLE_TEAM,
      bundleId: APPLE_BUNDLE,
    })
    expect(app.status).toBe(201)
    return s
  }

  journey(
    'native Google sign-up and sign-in',
    'Google’s sheet through the package: the sheet is handed the server’s nonce as it is, its token is exchanged once, and a dismissed sheet is neither an error nor a sign-in',
    async () => {
      const s = await googleServer()
      const email = freshEmail()
      const { tula, store } = phone(s)
      expect(await idTokenProviders(tula)).toEqual(['google', 'apple'])

      // The user closes the sheet: nothing was sent to prove anything.
      const nonces: string[] = []
      const dismissed = await atSheet(
        tula,
        async (_provider, nonce) => {
          nonces.push(nonce)
          return null
        },
        () => signInWithIdToken(tula, { provider: 'google' })
      )
      expect(dismissed).toEqual({ status: 'cancelled' })
      expect(idTokenCalls(s).map((exchange) => exchange.path)).toEqual([
        '/v1/client/sign-ins/id-token',
      ])
      expect(tula.state.status).not.toBe('signed-in')
      expect([...store.entries]).toEqual([])

      // The action works again, with an attempt and a nonce of its own.
      const outcome = await atSheet(
        tula,
        (provider, nonce) => {
          nonces.push(nonce)
          return google(s, email)(provider, nonce)
        },
        () => signInWithIdToken(tula, { provider: 'google' })
      )
      expect(outcome.status).toBe('complete')
      expect(tula.state.status).toBe('signed-in')
      expect(nonces).toHaveLength(2)
      expect(nonces[0]).not.toBe(nonces[1])
      // The nonce the sheet was handed is the server's own, unhashed.
      const started = JSON.parse(idTokenCalls(s)[1]?.responseBody ?? '{}') as { nonce: string }
      expect(nonces[1]).toBe(started.nonce)
      expect(await tula.user.get()).toMatchObject({ email, hasPassword: false })
      expect(claimsOf(await tula.session.getToken()).amr).toEqual(['fed'])
      // The token went once, in a body; the secure store holds the refresh token and no ID token.
      const exchanged = idTokenCalls(s).at(-1)
      expect(Object.keys(JSON.parse(exchanged?.requestBody ?? '{}'))).toEqual(['idToken'])
      const idToken = (JSON.parse(exchanged?.requestBody ?? '{}') as { idToken: string }).idToken
      expect(JSON.stringify([...store.entries])).not.toContain(idToken)
      for (const exchange of s.exchanges) {
        expect(exchange.path).not.toContain(idToken)
      }

      // The same Google account on another phone signs in to the same user.
      const other = phone(s)
      const again = await atSheet(other.tula, google(s, email), () =>
        signInWithIdToken(other.tula, { provider: 'google' })
      )
      expect(again.status).toBe('complete')
      expect(other.tula.state).toMatchObject({ user: { email } })
    }
  )

  journey(
    'native Apple sign-up and sign-in',
    'Apple’s sheet through the package: the package hashes the server’s nonce for the sheet, the token is accepted, and the name the sheet gave goes beside it',
    async () => {
      const s = await appleServer()
      const email = freshEmail()
      const { tula } = phone(s)
      const handed: string[] = []
      const outcome = await atSheet(
        tula,
        (provider, nonce) => {
          handed.push(nonce)
          return apple(s, email, { givenName: 'Maya', familyName: 'Okafor' })(provider, nonce)
        },
        () => signInWithIdToken(tula, { provider: 'apple' })
      )
      // The mock writes into the token whatever the sheet was handed, and the server accepts
      // one form only (the lowercase hexadecimal SHA-256 of its nonce): a sign-in is the proof
      // that the package took the hash.
      expect(outcome.status).toBe('complete')
      const started = JSON.parse(idTokenCalls(s)[0]?.responseBody ?? '{}') as { nonce: string }
      expect(handed).toHaveLength(1)
      expect(handed[0]).toMatch(/^[0-9a-f]{64}$/)
      expect(handed[0]).not.toBe(started.nonce)
      expect(await tula.user.get()).toMatchObject({
        email,
        firstName: 'Maya',
        lastName: 'Okafor',
        hasPassword: false,
      })
      const sent = JSON.parse(idTokenCalls(s).at(-1)?.requestBody ?? '{}') as object
      expect(Object.keys(sent).sort()).toEqual(['familyName', 'givenName', 'idToken'])
      // The hash is in no request: the server works it out from its own nonce.
      for (const exchange of s.exchanges) {
        expect(exchange.requestBody).not.toContain(handed[0] as string)
      }

      // A sheet that hands the token the raw nonce's worth (an app's own sheet that undid
      // the hash) is refused by the server as any wrong token is, and nobody is signed in.
      const wrong = phone(s)
      const refused = await caught(
        atSheet(
          wrong.tula,
          (provider) => apple(s, email)(provider, started.nonce),
          () => signInWithIdToken(wrong.tula, { provider: 'apple' })
        )
      )
      expect(refused).toMatchObject({ code: 'auth.invalid_credentials', status: 401 })
      expect(wrong.tula.state.status).not.toBe('signed-in')
    }
  )

  test('Apple’s sheet on an Android phone: the server refuses the start, and no sheet is shown', async () => {
    const s = await appleServer()
    const { tula } = phone(s, 'android')
    let shown = 0
    const refused = await caught(
      atSheet(
        tula,
        async () => {
          shown += 1
          return null
        },
        () => signInWithIdToken(tula, { provider: 'apple' })
      )
    )
    expect(refused).toMatchObject({ code: 'validation.failed', status: 422 })
    expect(shown).toBe(0)
  })
})

describe('Expo journeys: a session bound to the phone’s key', () => {
  /** Sign up on a phone with a key store; the process's clock is the server's, as a proof says when it was made. */
  async function boundPhone() {
    const s = await server()
    setSystemTime(s.deps.clock.now())
    const phoneOf = device()
    const keys = phoneOf.withKeys(fakeDeviceKeys())
    const { tula, states } = s.client('ios', { storage: phoneOf.storage })
    const email = freshEmail()
    const flow = await tula.signUp.start({ email, password: PASSWORD })
    await flow.verifyEmail({ code: s.code(email) })
    expect(tula.state.status).toBe('signed-in')
    const key = keys.keys.get(DEVICE_KEY_ALIAS) as DeviceKey
    return {
      s,
      tula,
      states,
      email,
      keys,
      jkt: await jwkThumbprint(key.publicJwk),
      store: phoneOf.store,
      storage: phoneOf.storage,
      /** What the secure store holds, as it holds it. */
      stored: () => [...phoneOf.store.entries.values()],
      /** The app, started again on the same phone. */
      restart: () => s.client('ios', { storage: phoneOf.storage }),
    }
  }

  journey(
    'a session bound to a device key is refreshed with a proof',
    'a phone with a key store: the key is made at the first sign-in, the session is bound to it, and the app started again refreshes with a proof by the same key',
    async () => {
      const { s, tula, keys, jkt, stored, restart } = await boundPhone()
      expect(keys.keys.size).toBe(1)
      expect(claimsOf(await tula.session.getToken()).cnf).toEqual({ jkt })
      // One entry: the refresh token, and after a line break which key the session is bound to.
      expect(stored()).toHaveLength(1)
      const [token, mark] = (stored()[0] as string).split('\n')
      expect(token).toStartWith('tula_rt_')
      expect(mark).toBe((keys.keys.get(DEVICE_KEY_ALIAS) as DeviceKey).publicJwk.x)
      // Only the refresh token travels: the note about the key is the phone's own.
      s.advance(61_000)
      setSystemTime(s.deps.clock.now())
      expect(await tula.session.getToken()).toBeString()
      expect(refreshes(s).at(-1)?.requestBody).toBe(JSON.stringify({ refreshToken: token }))
      expect(refreshes(s).at(-1)?.headers.get('dpop')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)

      // A restart: the key is found, not made, and the refresh carries a proof by it.
      s.advance(61_000)
      setSystemTime(s.deps.clock.now())
      const restarted = restart()
      expect(await restarted.tula.load()).toMatchObject({ status: 'signed-in' })
      expect(keys.keys.size).toBe(1)
      expect(claimsOf(await restarted.tula.session.getToken()).cnf).toEqual({ jkt })
      expect(refreshes(s).at(-1)).toMatchObject({ status: 200 })
      expect(refreshes(s).at(-1)?.headers.get('dpop')).toBeString()
      expect((stored()[0] as string).split('\n')[1]).toBe(mark as string)
      expect((await restarted.tula.session.list()).map((session) => session.deviceBound)).toEqual([
        true,
      ])
    }
  )

  test('the key is gone (a reinstall): the app starts signed out without asking the server, and the user signs in again under a new key', async () => {
    const { s, email, keys, jkt, store, restart } = await boundPhone()
    // What a reinstall leaves on a phone whose key store was emptied and whose stored token
    // was not: the token, and no key for it.
    keys.keys.clear()
    const requests = s.exchanges.length
    const restarted = restart()
    expect(await restarted.tula.load()).toMatchObject({ status: 'signed-out' })
    expect(await restarted.tula.session.getToken()).toBeNull()
    // Found out on the phone: no refresh was tried, so nothing was refused and nothing retried.
    expect(s.exchanges).toHaveLength(requests)
    expect([...store.entries]).toEqual([])
    expect(restarted.states.map((state) => state.status)).toEqual(['signed-out'])

    // Signing in again binds the new session to the phone's new key.
    const flow = await restarted.tula.signIn.start({ identifier: email })
    const step = await flow.submitPassword({ password: PASSWORD })
    expect(step.status).toBe('complete')
    const next = await jwkThumbprint((keys.keys.get(DEVICE_KEY_ALIAS) as DeviceKey).publicJwk)
    expect(next).not.toBe(jkt)
    expect(claimsOf(await restarted.tula.session.getToken()).cnf).toEqual({ jkt: next })
    // The session the lost key was bound to was not ended by any of this: the server was
    // never told. It ends by its profile, or when the user ends it from the list.
    expect((await restarted.tula.session.list()).map((session) => session.deviceBound)).toEqual([
      true,
      true,
    ])
  })

  test('a key store that cannot be reached is not a lost key: the load says storage.failed, the session is kept, and it is there once the store answers', async () => {
    const { s, keys, stored, restart } = await boundPhone()
    const before = stored()
    keys.locked = true
    const requests = s.exchanges.length
    const restarted = restart()
    expect(await caught(restarted.tula.load())).toMatchObject({ code: 'storage.failed', status: 0 })
    expect(stored()).toEqual(before)
    expect(s.exchanges).toHaveLength(requests)
    expect(keys.keys.size).toBe(1)

    keys.locked = false
    expect(await restarted.tula.load()).toMatchObject({ status: 'signed-in' })
    expect(keys.keys.size).toBe(1)
  })

  test('a build without the key store (Expo Go): a phone that never had one signs in unbound; one with a bound session starts signed out', async () => {
    const s = await server()
    setSystemTime(s.deps.clock.now())
    const bare = device()
    const missing = bare.withKeys(fakeDeviceKeys())
    missing.available = false
    const { tula } = s.client('ios', { storage: bare.storage })
    const email = freshEmail()
    const flow = await tula.signUp.start({ email, password: PASSWORD })
    await flow.verifyEmail({ code: s.code(email) })
    expect(tula.state.status).toBe('signed-in')
    expect(claimsOf(await tula.session.getToken()).cnf).toBeUndefined()
    expect(missing.keys.size).toBe(0)
    for (const exchange of s.exchanges) {
      expect(exchange.headers.get('dpop')).toBeNull()
    }

    const bound = await boundPhone()
    bound.keys.available = false
    const requests = bound.s.exchanges.length
    const restarted = bound.restart()
    expect(await restarted.tula.load()).toMatchObject({ status: 'signed-out' })
    expect(bound.s.exchanges).toHaveLength(requests)
    expect([...bound.store.entries]).toEqual([])
  })

  test('a key that stops signing while the app runs: the refresh says device.key_failed and the session is kept', async () => {
    const { s, tula, keys, stored } = await boundPhone()
    const before = stored()
    s.advance(61_000)
    setSystemTime(s.deps.clock.now())
    keys.failSigning = true
    const requests = refreshes(s).length
    expect(await caught(tula.session.refresh())).toMatchObject({ code: 'device.key_failed' })
    expect(refreshes(s)).toHaveLength(requests)
    expect(tula.state.status).toBe('signed-in')
    expect(stored()).toEqual(before)
    keys.failSigning = false
    expect(await tula.session.refresh()).toBeString()
  })

  test('a profile that binds nothing: a phone with a key store is refused at the start, as the server says', async () => {
    // The server's own rule (ADR 0043), not softened here: an app whose environment sets
    // `deviceBinding: 'none'` for its profile creates the client without `deviceKeys`.
    const s = await server()
    setSystemTime(s.deps.clock.now())
    s.deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        sessions: {
          ...DEFAULT_ENVIRONMENT_SETTINGS.sessions,
          profiles: {
            ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles,
            mobile: {
              ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles.mobile,
              deviceBinding: 'none',
            },
          },
        },
      },
    })
    const keyed = device()
    keyed.withKeys(fakeDeviceKeys())
    const { tula } = s.client('ios', { storage: keyed.storage })
    expect(
      await caught(tula.signUp.start({ email: freshEmail(), password: PASSWORD }))
    ).toMatchObject({ code: 'device.binding_not_supported', status: 400 })
    expect(tula.state.status).not.toBe('signed-in')
  })
})
