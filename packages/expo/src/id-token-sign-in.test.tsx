import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { act, waitFor } from '@testing-library/react'
import { isTulaError, type TulaError } from '@tula/core'
import { useSignIn } from './hooks/use-flows'
import { useIdTokenProviders } from './hooks/use-id-token'
import type { BrowserSession, IdTokenCredential, IdTokenSheet, PasskeySheet } from './host'
import { waysOf } from './host'
import { ID_TOKEN_SHEET_CEILING_MS, idTokenProviders, signInWithIdToken } from './id-token-sign-in'
import { signInWithProvider } from './provider-sign-in'
import { sha256Hex } from './sha256'
import { fakeSchedule } from './testing/fake-schedule'
import { json, sessionTokens, TEST_USER, type World, world } from './testing/world'

// Signing in with Google's and Apple's own sheets against a fake API and fake sheets: what
// each sheet is handed, what is refused before any request, what a dismissed sheet leaves
// behind, and that the ID token is kept and said nowhere. The journeys (`journeys.test.ts`)
// run the same call against the real API. No sheet of either provider was ever shown.

const ATTEMPT = 'attempt_1'
const NONCE = 'q3Yx0mJ0b0Jr9mJ9mW9a8mW3rJcV2bT7yP1eK5uH6sA'
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.canary-1d-t0k3n.c2lnbmF0dXJl'
const SECRET = 'tula_at_test_secret'
const START = 'POST /v1/client/sign-ins/id-token'
const EXCHANGE = `POST /v1/client/sign-ins/${ATTEMPT}/id-token`
const SHEET_CANARY = 'sheet-canary-44e0'

/** Everything that must never be found in storage, an error, a log line or a request's URL. */
const CANARIES = [ID_TOKEN, NONCE, sha256Hex(NONCE), SECRET, SHEET_CANARY]

const attempt = (step: object, extra: object = {}) =>
  json(200, { id: ATTEMPT, kind: 'sign_in', expiresAt: '2030-01-01T00:10:00.000Z', step, ...extra })

function routes(w: World) {
  w.api.on(START, () =>
    json(200, {
      nonce: NONCE,
      attempt: {
        id: ATTEMPT,
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: { status: 'needs_first_factor', strategies: ['google'] },
        attemptSecret: SECRET,
      },
    })
  )
  w.api.on(EXCHANGE, () =>
    attempt(
      { status: 'complete', userId: TEST_USER.id, sessionId: 'session_1' },
      { session: sessionTokens('signed_in', { refreshToken: 'rt_signed_in' }) }
    )
  )
}

/** A sheet whose answer a test gives, and which records what it was asked with. */
function fakeSheet(
  answer: (nonce: string) => Promise<IdTokenCredential | null> | IdTokenCredential | null = () => ({
    idToken: ID_TOKEN,
  }),
  available: () => boolean | Promise<boolean> = () => true
) {
  const asked: string[] = []
  let availability = 0
  const sheet: IdTokenSheet = {
    isAvailable() {
      availability += 1
      return available()
    },
    async signIn({ nonce }) {
      asked.push(nonce)
      return answer(nonce)
    },
  }
  return { sheet, asked, availabilityAsked: () => availability }
}

function pending<T>() {
  let settle: { resolve(value: T): void; reject(error: unknown): void } | undefined
  const promise = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject }
  })
  return { promise, settle: settle as NonNullable<typeof settle> }
}

async function caught(promise: Promise<unknown>): Promise<TulaError> {
  try {
    await promise
  } catch (error) {
    if (isTulaError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the call to throw')
}

let logged: Mock<(...parts: unknown[]) => void>[] = []

beforeEach(() => {
  logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    spyOn(console, method).mockImplementation(() => {})
  )
})

afterEach(() => {
  for (const spy of logged) {
    spy.mockRestore()
  }
})

/**
 * Nothing of a native sign-in was written to the secure store, a request's URL or a log
 * line, or is in what the test was told (`said`: outcomes, errors, hook state).
 */
function expectNothingKept(w: World, ...said: unknown[]) {
  const places = [
    JSON.stringify([...w.store.entries]),
    JSON.stringify(w.api.requests.map((request) => request.path)),
    JSON.stringify(logged.flatMap((spy) => spy.mock.calls)),
    JSON.stringify(
      said.map((value) =>
        value instanceof Error
          ? { ...value, message: value.message, stack: value.stack, cause: String(value.cause) }
          : value
      )
    ),
    JSON.stringify(w.client),
  ]
  for (const canary of CANARIES) {
    for (const place of places) {
      expect(place).not.toContain(canary)
    }
  }
}

describe('signInWithIdToken', () => {
  test('Google’s sheet is handed the server’s nonce as it is, and its token is exchanged once, in a body', async () => {
    const { sheet, asked } = fakeSheet(() => ({
      idToken: ID_TOKEN,
      givenName: 'Maya',
      familyName: 'Okafor',
    }))
    const w = world({ platform: 'android', client: { google: sheet } })
    routes(w)
    const outcome = await signInWithIdToken(w.client, { provider: 'google' })
    expect(outcome.status).toBe('complete')
    expect(asked).toEqual([NONCE])
    expect(w.api.calls(START)[0]?.body).toEqual({ provider: 'google' })
    expect(w.api.calls(START)[0]?.headers.get('x-tula-client')).toBe('android')
    // Google's token carries its own names: none is sent beside it.
    expect(w.api.calls(EXCHANGE).map((call) => call.body)).toEqual([{ idToken: ID_TOKEN }])
    expect(w.client.state.status).toBe('signed-in')
    expect(w.storedToken()).toBe('rt_signed_in')
    expectNothingKept(w, outcome.status)
  })

  test('Apple’s sheet is handed the SHA-256 of the nonce, in lowercase hexadecimal, and its name goes beside the token', async () => {
    const { sheet, asked } = fakeSheet(() => ({
      idToken: ID_TOKEN,
      givenName: 'Maya',
      familyName: 'Okafor',
    }))
    const w = world({ client: { apple: sheet } })
    routes(w)
    const outcome = await signInWithIdToken(w.client, { provider: 'apple' })
    expect(outcome.status).toBe('complete')
    expect(asked).toEqual([sha256Hex(NONCE)])
    expect(asked[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(w.api.calls(START)[0]?.body).toEqual({ provider: 'apple' })
    expect(w.api.calls(EXCHANGE).map((call) => call.body)).toEqual([
      { idToken: ID_TOKEN, givenName: 'Maya', familyName: 'Okafor' },
    ])
    expectNothingKept(w, outcome.status)
  })

  test.each<[string, Partial<IdTokenCredential>, object]>([
    ['no name', {}, {}],
    ['a given name alone', { givenName: 'Maya' }, { givenName: 'Maya' }],
    ['an empty name', { givenName: '', familyName: '' }, {}],
    [
      'a name longer than the server takes',
      { givenName: 'a'.repeat(101), familyName: 'Okafor' },
      { familyName: 'Okafor' },
    ],
    ['a name that is no text', { givenName: 7 as never }, {}],
  ])('Apple with %s sends what is a name and nothing else', async (_name, names, sent) => {
    const { sheet } = fakeSheet(() => ({ idToken: ID_TOKEN, ...names }))
    const w = world({ client: { apple: sheet } })
    routes(w)
    await signInWithIdToken(w.client, { provider: 'apple' })
    expect(w.api.calls(EXCHANGE)[0]?.body).toEqual({ ...sent, idToken: ID_TOKEN })
  })

  test('a step the server asks for after the token is handed on, with nobody signed in', async () => {
    const { sheet } = fakeSheet()
    const w = world({ client: { apple: sheet } })
    routes(w)
    w.api.on(EXCHANGE, () => attempt({ status: 'needs_second_factor', options: ['totp'] }))
    const outcome = await signInWithIdToken(w.client, { provider: 'apple' })
    expect(outcome.status).toBe('needs_step')
    expect(outcome.status === 'needs_step' && outcome.flow.step).toMatchObject({
      status: 'needs_second_factor',
    })
    expect(w.client.state.status).not.toBe('signed-in')
  })

  test('a dismissed sheet is cancelled: no exchange, nobody signed in, and the next try starts again', async () => {
    let dismiss = true
    const { sheet, asked } = fakeSheet(() => (dismiss ? null : { idToken: ID_TOKEN }))
    const w = world({ client: { google: sheet } })
    routes(w)
    expect(await signInWithIdToken(w.client, { provider: 'google' })).toEqual({
      status: 'cancelled',
    })
    expect(w.api.calls(EXCHANGE)).toEqual([])
    expect(w.client.state.status).not.toBe('signed-in')
    expect(w.storedToken()).toBeUndefined()
    dismiss = false
    expect((await signInWithIdToken(w.client, { provider: 'google' })).status).toBe('complete')
    // An attempt is one token: the second try asked the server for a nonce of its own.
    expect(w.api.calls(START)).toHaveLength(2)
    expect(asked).toHaveLength(2)
    expectNothingKept(w)
  })

  test.each<[string, () => Promise<IdTokenCredential | null>]>([
    ['rejects', () => Promise.reject(new Error(SHEET_CANARY))],
    [
      'throws at the call',
      () => {
        throw new Error(SHEET_CANARY)
      },
    ],
    ['hands over no token', async () => ({ idToken: '' })],
    ['hands over something that is no credential', async () => ({}) as never],
    ['hands over a token that is no text', async () => ({ idToken: 7 }) as never],
  ])(
    'a sheet that %s is an error, never a dismissal, with none of its text and no exchange',
    async (_name, answer) => {
      const sheet: IdTokenSheet = { isAvailable: () => true, signIn: answer }
      const w = world({ client: { google: sheet } })
      routes(w)
      const error = await caught(signInWithIdToken(w.client, { provider: 'google' }))
      expect(error.code).toBe('internal')
      expect(error.message).not.toContain(SHEET_CANARY)
      expect(w.api.calls(EXCHANGE)).toEqual([])
      expect(w.client.state.status).not.toBe('signed-in')
      expectNothingKept(w, error)
      // The place is given back.
      sheet.signIn = async () => ({ idToken: ID_TOKEN })
      expect((await signInWithIdToken(w.client, { provider: 'google' })).status).toBe('complete')
    }
  )

  test('a token the server refuses is its own code, and the token is in no error', async () => {
    const { sheet } = fakeSheet()
    const w = world({ client: { google: sheet } })
    routes(w)
    w.api.on(EXCHANGE, () =>
      json(401, { status: 401, code: 'auth.invalid_credentials', detail: 'Invalid credentials.' })
    )
    const error = await caught(signInWithIdToken(w.client, { provider: 'google' }))
    expect(error.code).toBe('auth.invalid_credentials')
    expect(w.client.state.status).not.toBe('signed-in')
    expectNothingKept(w, error)
    w.api.on(START, () =>
      json(403, { status: 403, code: 'auth.method_disabled', detail: 'Not enabled.' })
    )
    const asked = w.api.calls(EXCHANGE).length
    expect((await caught(signInWithIdToken(w.client, { provider: 'google' }))).code).toBe(
      'auth.method_disabled'
    )
    // A start the server refuses shows no sheet.
    expect(w.api.calls(EXCHANGE)).toHaveLength(asked)
  })

  describe('refused before any request', () => {
    test('a client created without the sheet, and a client this package did not make', async () => {
      const w = world({ client: { apple: fakeSheet().sheet } })
      routes(w)
      expect((await caught(signInWithIdToken(w.client, { provider: 'google' }))).code).toBe(
        'storage.failed'
      )
      expect((await caught(signInWithIdToken({} as never, { provider: 'apple' }))).code).toBe(
        'storage.failed'
      )
      expect(w.api.requests).toEqual([])
    })

    test.each<[string, () => boolean | Promise<boolean>]>([
      ['says it is not available', () => false],
      ['says so later', async () => false],
      ['answers something that is not true', () => 'yes' as never],
      [
        'throws when asked (a module that is not in the build)',
        () => {
          throw new Error(SHEET_CANARY)
        },
      ],
      ['rejects when asked', () => Promise.reject(new Error(SHEET_CANARY))],
    ])('a sheet that %s is never shown', async (_name, available) => {
      const { sheet, asked } = fakeSheet(undefined, available)
      const w = world({ client: { google: sheet } })
      routes(w)
      const error = await caught(signInWithIdToken(w.client, { provider: 'google' }))
      expect(error.code).toBe('storage.failed')
      expect(asked).toEqual([])
      expect(w.api.requests).toEqual([])
      expectNothingKept(w, error)
      // And the place it took is given back: the next refusal is the same one, not `flow.busy`.
      expect((await caught(signInWithIdToken(w.client, { provider: 'google' }))).code).toBe(
        'storage.failed'
      )
    })

    test('availability is asked before every sign-in, never remembered from the last', async () => {
      let there = true
      const { sheet, availabilityAsked } = fakeSheet(undefined, () => there)
      const w = world({ client: { google: sheet } })
      routes(w)
      await signInWithIdToken(w.client, { provider: 'google' })
      there = false
      expect((await caught(signInWithIdToken(w.client, { provider: 'google' }))).code).toBe(
        'storage.failed'
      )
      expect(availabilityAsked()).toBe(2)
      expect(await idTokenProviders(w.client)).toEqual([])
    })

    test('one sheet at a time: a second while one is out is flow.busy, with no request and no second sheet', async () => {
      const held = pending<IdTokenCredential | null>()
      const google = fakeSheet(() => held.promise)
      const apple = fakeSheet()
      const w = world({ client: { google: google.sheet, apple: apple.sheet } })
      routes(w)
      const first = signInWithIdToken(w.client, { provider: 'google' })
      await waitFor(() => expect(google.asked).toHaveLength(1))
      const requests = w.api.requests.length
      expect((await caught(signInWithIdToken(w.client, { provider: 'google' }))).code).toBe(
        'flow.busy'
      )
      expect((await caught(signInWithIdToken(w.client, { provider: 'apple' }))).code).toBe(
        'flow.busy'
      )
      expect(w.api.requests).toHaveLength(requests)
      expect(apple.asked).toEqual([])
      held.settle.resolve({ idToken: ID_TOKEN })
      expect((await first).status).toBe('complete')
    })

    test('a provider’s browser and a provider’s sheet do not open over each other', async () => {
      const back = pending<string | null>()
      const browser: BrowserSession = { open: () => back.promise }
      const held = pending<IdTokenCredential | null>()
      const google = fakeSheet(() => held.promise)
      const w = world({ client: { google: google.sheet, browser } })
      routes(w)
      w.api.on('POST /v1/client/sign-ins/oauth', () =>
        json(200, {
          attempt: {
            id: '0190d7a0-0000-7000-8000-000000000001',
            kind: 'sign_in',
            expiresAt: '2030-01-01T00:10:00.000Z',
            step: { status: 'needs_first_factor', strategies: ['google'] },
            attemptSecret: SECRET,
          },
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s',
          binding: 'tula_ob_binding',
        })
      )
      const input = { provider: 'google' as const, redirectUrl: 'com.example.app:/oauth/callback' }
      // The browser is out: no sheet.
      const round = signInWithProvider(w.client, input)
      await waitFor(() => expect(w.api.calls('POST /v1/client/sign-ins/oauth')).toHaveLength(1))
      expect((await caught(signInWithIdToken(w.client, { provider: 'google' }))).code).toBe(
        'flow.busy'
      )
      expect(google.asked).toEqual([])
      back.settle.resolve(null)
      expect((await round).status).toBe('cancelled')
      // The sheet is out: no browser.
      const sheet = signInWithIdToken(w.client, { provider: 'google' })
      await waitFor(() => expect(google.asked).toHaveLength(1))
      const started = w.api.calls('POST /v1/client/sign-ins/oauth').length
      await expect(signInWithProvider(w.client, input)).rejects.toMatchObject({ code: 'flow.busy' })
      expect(w.api.calls('POST /v1/client/sign-ins/oauth')).toHaveLength(started)
      held.settle.resolve(null)
      expect((await sheet).status).toBe('cancelled')
    })

    test('a passkey sheet that is out refuses a provider’s sheet, and the other way round', async () => {
      const assertion = pending<unknown>()
      const passkeys: PasskeySheet = {
        isSupported: () => true,
        create: async () => ({}),
        get: () => assertion.promise,
      }
      const held = pending<IdTokenCredential | null>()
      const google = fakeSheet(() => held.promise)
      const w = world({ client: { google: google.sheet, passkeys } })
      routes(w)
      w.api.on('POST /v1/client/sign-ins/passkey', () =>
        json(200, {
          attempt: {
            id: ATTEMPT,
            kind: 'sign_in',
            expiresAt: '2030-01-01T00:10:00.000Z',
            step: { status: 'needs_first_factor', strategies: ['passkey'] },
            attemptSecret: SECRET,
          },
          options: {
            challenge: 'Y2hhbGxlbmdl',
            timeout: 300_000,
            rpId: 'example.com',
            userVerification: 'required',
          },
        })
      )
      const { result } = w.render(() => useSignIn())
      let passkey: Promise<unknown> = Promise.resolve()
      act(() => {
        passkey = result.current.withPasskey()
      })
      await waitFor(() => expect(w.api.calls('POST /v1/client/sign-ins/passkey')).toHaveLength(1))
      expect((await caught(signInWithIdToken(w.client, { provider: 'google' }))).code).toBe(
        'flow.busy'
      )
      expect(google.asked).toEqual([])
      await act(async () => {
        assertion.settle.reject(Object.assign(new Error('dismissed'), { name: 'NotAllowedError' }))
        await passkey
      })
      // The other way round: while Google's sheet is out, a passkey is flow.busy, an error.
      const sheet = signInWithIdToken(w.client, { provider: 'google' })
      await waitFor(() => expect(google.asked).toHaveLength(1))
      const asked = w.api.calls('POST /v1/client/sign-ins/passkey').length
      await act(async () => {
        await result.current.withPasskey()
      })
      expect(result.current.error?.code).toBe('flow.busy')
      expect(result.current.dismissed).toBe(false)
      expect(w.api.calls('POST /v1/client/sign-ins/passkey')).toHaveLength(asked)
      held.settle.resolve(null)
      await sheet
    })
  })

  describe('a sheet nobody answers', () => {
    test('gives its place up after the ceiling, as a sign-in nobody answered, and what it says later is dropped', async () => {
      const time = fakeSchedule()
      const held = pending<IdTokenCredential | null>()
      const { sheet, asked } = fakeSheet(() => held.promise)
      const w = world({ client: { google: sheet }, schedule: time.schedule })
      routes(w)
      const first = signInWithIdToken(w.client, { provider: 'google' })
      await waitFor(() => expect(asked).toHaveLength(1))
      expect(time.asked).toContain(ID_TOKEN_SHEET_CEILING_MS)
      await time.advance(ID_TOKEN_SHEET_CEILING_MS - 1)
      expect((await caught(signInWithIdToken(w.client, { provider: 'google' }))).code).toBe(
        'flow.busy'
      )
      await time.advance(1)
      expect(await first).toEqual({ status: 'cancelled' })
      // The abandoned sheet answers at last: no exchange is made with its token.
      held.settle.resolve({ idToken: ID_TOKEN })
      await time.advance(0)
      expect(w.api.calls(EXCHANGE)).toEqual([])
      expect(w.client.state.status).not.toBe('signed-in')
      expectNothingKept(w)
    })

    test('a sheet that answers leaves no wait behind', async () => {
      const time = fakeSchedule()
      const { sheet } = fakeSheet()
      const w = world({ client: { google: sheet }, schedule: time.schedule })
      routes(w)
      await signInWithIdToken(w.client, { provider: 'google' })
      expect(time.pending()).toBe(0)
      const failing = world({
        client: { google: { isAvailable: () => true, signIn: () => Promise.reject(new Error()) } },
        schedule: time.schedule,
      })
      routes(failing)
      await caught(signInWithIdToken(failing.client, { provider: 'google' }))
      expect(time.pending()).toBe(0)
    })

    test('the ceiling is five minutes: half the lifetime of the attempt the token is for', () => {
      expect(ID_TOKEN_SHEET_CEILING_MS).toBe(5 * 60_000)
    })
  })
})

describe('useSignIn().withIdToken', () => {
  test('signs in and says so', async () => {
    const { sheet } = fakeSheet()
    const w = world({ client: { apple: sheet } })
    routes(w)
    const { result } = w.render(() => useSignIn())
    let step: unknown
    await act(async () => {
      step = await result.current.withIdToken({ provider: 'apple' })
    })
    expect(step).toMatchObject({ status: 'complete' })
    expect(result.current).toMatchObject({ error: null, dismissed: false, screen: 'complete' })
    expect(w.client.state.status).toBe('signed-in')
    expectNothingKept(w, result.current.error, result.current.step)
  })

  test('a dismissed sheet is neither an error nor a sign-in, and the action works again', async () => {
    let dismiss = true
    const { sheet } = fakeSheet(() => (dismiss ? null : { idToken: ID_TOKEN }))
    const w = world({ client: { google: sheet } })
    routes(w)
    const { result } = w.render(() => useSignIn())
    let step: unknown = 'unset'
    await act(async () => {
      step = await result.current.withIdToken({ provider: 'google' })
    })
    expect(step).toBeNull()
    expect(result.current).toMatchObject({
      dismissed: true,
      error: null,
      isPending: false,
      step: null,
    })
    expect(w.api.calls(EXCHANGE)).toEqual([])
    expect(w.client.state.status).not.toBe('signed-in')
    dismiss = false
    await act(async () => {
      step = await result.current.withIdToken({ provider: 'google' })
    })
    expect(step).toMatchObject({ status: 'complete' })
    expect(result.current).toMatchObject({ dismissed: false, error: null })
  })

  test.each<[string, (w: World) => void, IdTokenSheet, string]>([
    [
      'a sheet that fails',
      () => undefined,
      { isAvailable: () => true, signIn: () => Promise.reject(new Error(SHEET_CANARY)) },
      'internal',
    ],
    [
      'a sheet that is not there',
      () => undefined,
      { isAvailable: () => false, signIn: async () => null },
      'storage.failed',
    ],
    [
      'a token the server refuses',
      (w) =>
        w.api.on(EXCHANGE, () =>
          json(401, { status: 401, code: 'auth.invalid_credentials', detail: 'Invalid.' })
        ),
      { isAvailable: () => true, signIn: async () => ({ idToken: ID_TOKEN }) },
      'auth.invalid_credentials',
    ],
  ])('%s is the error, never a dismissal', async (_name, prepare, sheet, code) => {
    const w = world({ client: { google: sheet } })
    routes(w)
    prepare(w)
    const { result } = w.render(() => useSignIn())
    await act(async () => {
      await result.current.withIdToken({ provider: 'google' })
    })
    expect(result.current.error?.code).toBe(code)
    expect(result.current.dismissed).toBe(false)
    expect(w.client.state.status).not.toBe('signed-in')
    expectNothingKept(w, result.current.error)
  })
})

describe('useIdTokenProviders', () => {
  test('a control is hidden until its sheet has said it can be shown', async () => {
    const google = pending<boolean>()
    const w = world({
      client: {
        google: fakeSheet(undefined, () => google.promise).sheet,
        apple: fakeSheet(undefined, () => false).sheet,
      },
    })
    const { result } = w.render(() => useIdTokenProviders())
    expect(result.current).toEqual({ google: false, apple: false })
    expect(waysOf(w.client).idToken).toEqual([])
    await act(async () => {
      google.settle.resolve(true)
      await google.promise
    })
    await waitFor(() => expect(result.current).toEqual({ google: true, apple: false }))
    expect(waysOf(w.client).idToken).toEqual(['google'])
  })

  test('a client created with neither sheet has neither, and asks nothing', async () => {
    const w = world()
    const { result } = w.render(() => useIdTokenProviders())
    await act(async () => {
      await idTokenProviders(w.client)
    })
    expect(result.current).toEqual({ google: false, apple: false })
    expect(await idTokenProviders({} as never)).toEqual([])
  })

  test.each<[string, () => boolean | Promise<boolean>]>([
    [
      'throws (Expo Go: the module is not in the build)',
      () => {
        throw new Error(SHEET_CANARY)
      },
    ],
    ['rejects', () => Promise.reject(new Error(SHEET_CANARY))],
  ])('a sheet that %s stays hidden', async (_name, available) => {
    const w = world({ client: { apple: fakeSheet(undefined, available).sheet } })
    const { result } = w.render(() => useIdTokenProviders())
    await act(async () => {
      await idTokenProviders(w.client)
    })
    expect(result.current).toEqual({ google: false, apple: false })
  })

  test('under StrictMode, where the effect runs twice, the answer still arrives', async () => {
    const { sheet, availabilityAsked } = fakeSheet()
    const w = world({ client: { apple: sheet } })
    const { result, unmount } = w.render(() => useIdTokenProviders(), true)
    await waitFor(() => expect(result.current).toEqual({ google: false, apple: true }))
    expect(availabilityAsked()).toBeGreaterThanOrEqual(1)
    unmount()
  })

  test('a sign-in screen offered only a provider is drawn once that provider’s sheet is known to be there', async () => {
    const { sheet } = fakeSheet()
    const w = world({ client: { apple: sheet } })
    w.api.on('POST /v1/client/sign-ins', () =>
      json(200, {
        id: ATTEMPT,
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: { status: 'needs_first_factor', strategies: ['apple'] },
        attemptSecret: SECRET,
      })
    )
    const { result } = w.render(() => useSignIn())
    await act(async () => {
      await result.current.start({ identifier: 'maya@example.com' })
    })
    await waitFor(() => expect(result.current.screen).toBe('needs_first_factor'))
    // Without the sheet the same step has nothing this app can do.
    const none = world()
    none.api.on('POST /v1/client/sign-ins', () =>
      json(200, {
        id: ATTEMPT,
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: { status: 'needs_first_factor', strategies: ['apple'] },
        attemptSecret: SECRET,
      })
    )
    const other = none.render(() => useSignIn())
    await act(async () => {
      await other.result.current.start({ identifier: 'maya@example.com' })
    })
    expect(other.result.current.screen).toBe('not_supported')
  })
})
