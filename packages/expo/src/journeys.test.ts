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
import { secureStoreKey, secureStoreStorage } from './secure-storage'
import { BROWSER_GLOBALS, hideDom } from './testing/dom'
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

/** The secure store behind each storage a journey asked for. */
const stores = new WeakMap<TokenStorage, FakeSecureStore>()

/** A new secure store and the storage a journey reads it through. */
function device(): { store: FakeSecureStore; storage: TokenStorage } {
  const store = fakeSecureStore()
  const storage = secureStoreStorage(store)
  stores.set(storage, store)
  return { store, storage }
}

const { journey, behaviour, server, freshEmail, signUp, caught, refreshes } = sdkJourneys({
  client: 'expo',
  native: 'ios',
  create({ client, storage, deviceKey, ...options }) {
    const secureStore = storage && stores.get(storage)
    if (!secureStore || !client || deviceKey) {
      // A journey that needs a browser or a device key is not declared for this client.
      throw new Error(`@tula/expo has no ${client} client for this journey`)
    }
    return createExpoClient(options, { platform: client, secureStore })
  },
  storage: () => device().storage,
  browser: false,
  oauth: false,
  passkeys: false,
  deviceKey: false,
  // What an app does and this package cannot yet: providers, passkeys, the emailed link and
  // the redirects into an app (TULA-48); device binding (TULA-55). A feature that arrives
  // turns its capability on above and lowers its number here, in the same change.
  notBuilt: { 'TULA-48': 30, 'TULA-55': 6 },
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
  const { store, storage } = device()
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
