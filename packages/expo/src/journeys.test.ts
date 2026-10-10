import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { isStepUpRequired, stepUpMethods, type TokenStorage } from '@tula/core'
import { base32Decode, totp } from '../../../apps/api/src/lib/totp'
import {
  JOURNEY_STORAGE_KEY,
  PASSWORD,
  PUBLISHABLE_KEY,
  type Server,
  sdkJourneys,
} from '../../../apps/api/src/testing/sdk-journeys'
import { createExpoClient } from './client'
import { flowScreen } from './screens'
import {
  SECURE_REWRITE_DELAYS_MS,
  SECURE_WRITE_RETRY_DELAYS_MS,
  secureStoreKey,
  secureStoreStorage,
} from './secure-storage'
import { BROWSER_GLOBALS, hideDom } from './testing/dom'
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
}

/** The device behind each storage a journey asked for. */
const devices = new WeakMap<TokenStorage, Device>()

/** A new device and the storage a journey reads its secure store through. */
function device(): Device & { storage: TokenStorage } {
  const store = fakeSecureStore()
  const time = fakeSchedule(Math.max(...SECURE_WRITE_RETRY_DELAYS_MS))
  const storage = secureStoreStorage(store, {}, time.schedule)
  devices.set(storage, { store, time })
  return { store, time, storage }
}

const { journey, behaviour, server, freshEmail, signUp, caught, refreshes } = sdkJourneys({
  client: 'expo',
  native: 'ios',
  create({ client, storage, deviceKey, ...options }) {
    const phone = storage && devices.get(storage)
    if (!phone || !client || deviceKey) {
      // A journey that needs a browser or a device key is not declared for this client.
      throw new Error(`@tula/expo has no ${client} client for this journey`)
    }
    return createExpoClient(options, {
      platform: client,
      secureStore: phone.store,
      schedule: phone.time.schedule,
    })
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
  oauth: false,
  // `signIn.withIdToken` is `@tula/core`'s and the client this package builds has it. The
  // package wraps no provider's sheet: the journeys mint the token as `core`'s do.
  idToken: true,
  passkeys: false,
  deviceKey: false,
  // What an app does and this package cannot yet: providers, passkeys, the emailed link and
  // the redirects into an app (TULA-48); device binding (TULA-55). A feature that arrives
  // turns its capability on above and lowers its number here, in the same change.
  notBuilt: { 'TULA-48': 30, 'TULA-55': 8 },
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
    'a step from a newer server is the screen `not_supported`, and so is a known step that offers only what this version cannot do',
    async () => {
      const s = await server()
      const { email } = await signUp(s)
      const steps: object[] = [
        { status: 'needs_retina_scan', prompt: 'look into the camera' },
        { status: 'needs_first_factor', strategies: ['passkey', 'google', 'email_link'] },
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
        expect(flowScreen(flow.step)).toBe('not_supported')
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
    'device binding: this package has no device key, so it sends no proof and its session carries no key; it refuses to be given one',
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
