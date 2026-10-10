import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { act, waitFor } from '@testing-library/react'
import { isTulaError, type TulaError } from '@tula/core'
import { browserSessionOver, passkeySheetOver } from './adapters'
import { useResetPassword, useSignIn } from './hooks/use-flows'
import { usePasskeys } from './hooks/use-passkeys'
import { type BrowserSession, oneAtATime, type PasskeySheet, waysOf } from './host'
import { linkProvider, retryProviderSignIn, signInWithProvider } from './provider-sign-in'
import { type FlowScreen, flowScreen } from './screens'
import {
  attempt,
  completed,
  failure,
  json,
  ROUTE,
  sessionTokens,
  started,
  TEST_USER,
  type World,
  world,
} from './testing/world'

// Passkeys and provider sign-in against a fake API, a fake passkey sheet and a fake browser
// session: what is refused before any request, what a dismissed sheet and a closed browser
// leave behind, and that nothing of a ceremony or a round trip is kept or said. The journeys
// (`journeys.test.ts`) run the same calls against the real API.

const ATTEMPT = '0190d7a0-0000-7000-8000-000000000001'
const BINDING = 'tula_ob_canary-b1nd1ng'
const TICKET = 'tula_ot_canary-t1ck3t'
const CHALLENGE = 'Y2FuYXJ5LWNoYWxsZW5nZQ'
const SIGNATURE = 'Y2FuYXJ5LXNpZ25hdHVyZQ'
const SCHEME = 'com.example.app:/oauth/callback'
const LINK = 'https://app.example.com/oauth/callback'
const PROVIDER_URL = 'https://accounts.google.com/o/oauth2/v2/auth?state=s&client_id=c'
const RETURNED = `${SCHEME}#tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`

const OAUTH_START = 'POST /v1/client/sign-ins/oauth'
const OAUTH_EXCHANGE = 'POST /v1/client/sign-ins/oauth/exchange'
const LINK_START = 'POST /v1/client/me/identities/oauth'
const LINK_EXCHANGE = 'POST /v1/client/me/identities/oauth/exchange'
const PASSKEY_START = 'POST /v1/client/sign-ins/passkey'
const PASSKEY_SUBMIT = 'POST /v1/client/sign-ins/attempt_1/passkey'
const PASSKEY_OPTIONS = 'POST /v1/client/me/passkeys/options'
const PASSKEY_ADD = 'POST /v1/client/me/passkeys'
const STEP_UP_OPTIONS = 'POST /v1/client/sessions/step-up/passkey'
const STEP_UP = 'POST /v1/client/sessions/step-up'

const REQUEST = {
  challenge: CHALLENGE,
  timeout: 300_000,
  rpId: 'example.com',
  userVerification: 'required',
}
const CREATION = {
  rp: { id: 'example.com', name: 'Example' },
  user: { id: 'dXNlcg', name: 'maya@example.com', displayName: 'Maya' },
  challenge: CHALLENGE,
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 300_000,
  excludeCredentials: [],
  authenticatorSelection: {
    residentKey: 'required',
    requireResidentKey: true,
    userVerification: 'required',
  },
  attestation: 'none',
}
const ASSERTION = {
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  response: {
    clientDataJSON: 'e30',
    authenticatorData: 'YXV0aA',
    signature: SIGNATURE,
    userHandle: 'dXNlcg',
  },
  clientExtensionResults: {},
}
const REGISTRATION = {
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: SIGNATURE, transports: ['internal'] },
  clientExtensionResults: {},
}
const PASSKEY = {
  id: 'passkey_1',
  name: 'iPhone',
  synced: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
}
const IDENTITY = { id: 'identity_1', provider: 'google', createdAt: '2026-01-01T00:00:00.000Z' }

/** Everything that must never be found in storage, an error, a log line or a request's URL. */
const CANARIES = [BINDING, TICKET, CHALLENGE, SIGNATURE, 'tula_at_test_secret', 'rt_signed_in']

const named = (name: string, message = 'the platform said something') =>
  Object.assign(new Error(message), { name })

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

/** A sheet whose answers a test gives, and which counts how it was asked. */
function fakeSheet(answers: { create?: () => Promise<unknown>; get?: () => Promise<unknown> }) {
  const asked = { create: [] as unknown[], get: [] as unknown[] }
  const sheet: PasskeySheet = {
    isSupported: () => true,
    create(options) {
      asked.create.push(options)
      return (answers.create ?? (async () => REGISTRATION))()
    },
    get(options) {
      asked.get.push(options)
      return (answers.get ?? (async () => ASSERTION))()
    },
  }
  return { sheet, asked }
}

/** A browser that comes back with what the test says, and records what it was opened with. */
function fakeBrowser(
  back: (url: string, redirectUrl: string) => Promise<string | null> | string | null
) {
  const opened: [string, string][] = []
  const browser: BrowserSession = {
    async open(url, redirectUrl) {
      opened.push([url, redirectUrl])
      return back(url, redirectUrl)
    },
  }
  return { browser, opened }
}

function oauthStarted(extra: object = {}) {
  return json(200, {
    attempt: {
      id: ATTEMPT,
      kind: 'sign_in',
      expiresAt: '2030-01-01T00:10:00.000Z',
      step: { status: 'needs_first_factor', strategies: ['oauth_google'] },
      attemptSecret: 'tula_at_test_secret',
    },
    authorizationUrl: PROVIDER_URL,
    binding: BINDING,
    ...extra,
  })
}

function oauthCompleted() {
  return json(200, {
    id: ATTEMPT,
    kind: 'sign_in',
    expiresAt: '2030-01-01T00:10:00.000Z',
    step: { status: 'complete', userId: TEST_USER.id, sessionId: 'session_1' },
    session: sessionTokens('signed_in', { refreshToken: 'rt_signed_in' }),
  })
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
 * Nothing of a ceremony or a round trip was written to the secure store, a request's URL or
 * a log line; `said` is whatever the test was told (errors, outcomes, hook state).
 */
function expectNothingKept(w: World, ...said: unknown[]) {
  const places = [
    JSON.stringify([...w.store.entries.keys()]),
    // The refresh token is what the store is for; everything else is not.
    JSON.stringify([...w.store.entries.values()].filter((value) => !value.startsWith('rt_'))),
    JSON.stringify(w.api.requests.map((request) => request.path)),
    JSON.stringify(logged.flatMap((spy) => spy.mock.calls)),
    JSON.stringify(
      said.map((value) =>
        value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value
      )
    ),
    JSON.stringify(w.client),
  ]
  for (const canary of CANARIES) {
    for (const place of places) {
      if (!(canary === 'rt_signed_in' && place === places[1])) {
        expect(place).not.toContain(canary)
      }
    }
  }
}

describe('oneAtATime', () => {
  function pending() {
    let settle: { resolve(value: unknown): void; reject(error: unknown): void } | undefined
    const promise = new Promise<unknown>((resolve, reject) => {
      settle = { resolve, reject }
    })
    return { promise, settle: settle as NonNullable<typeof settle> }
  }

  test('a second request while the sheet is open is refused as called off, never joined, and the sheet is asked once', async () => {
    const first = pending()
    const { sheet, asked } = fakeSheet({ get: () => first.promise })
    const provider = oneAtATime(sheet)
    const one = provider.get(REQUEST as never, {})
    // Neither the same call nor the other one gets a second sheet.
    await expect(provider.get(REQUEST as never, {})).rejects.toMatchObject({ name: 'AbortError' })
    await expect(provider.create(CREATION as never, {})).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(asked).toMatchObject({ get: [REQUEST], create: [] })
    first.settle.resolve(ASSERTION)
    expect(await one).toBe(ASSERTION)
    // The place is free again once the sheet has answered.
    expect(await provider.create(CREATION as never, {})).toBe(REGISTRATION)
  })

  test('the place is given back when the sheet rejects, and when the call itself throws', async () => {
    let fail: 'reject' | 'throw' | null = 'reject'
    const provider = oneAtATime({
      create: async () => REGISTRATION,
      get() {
        if (fail === 'throw') {
          throw named('TypeError')
        }
        return fail ? Promise.reject(named('NotAllowedError')) : Promise.resolve(ASSERTION)
      },
    })
    await expect(provider.get(REQUEST as never, {})).rejects.toMatchObject({
      name: 'NotAllowedError',
    })
    fail = 'throw'
    await expect(provider.get(REQUEST as never, {})).rejects.toMatchObject({ name: 'TypeError' })
    fail = null
    expect(await provider.get(REQUEST as never, {})).toBe(ASSERTION)
  })

  test('a signal that is already aborted asks nothing', async () => {
    const { sheet, asked } = fakeSheet({})
    const controller = new AbortController()
    controller.abort()
    await expect(
      oneAtATime(sheet).get(REQUEST as never, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(asked.get).toEqual([])
  })

  test('an aborted wait ends at once, its late answer is dropped, and the place stays taken until the sheet has answered', async () => {
    const first = pending()
    const { sheet, asked } = fakeSheet({ get: () => first.promise })
    const provider = oneAtATime(sheet)
    const controller = new AbortController()
    const waiting = provider.get(REQUEST as never, { signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    // The sheet may still be on screen: no second one over it.
    await expect(provider.get(REQUEST as never, {})).rejects.toMatchObject({ name: 'AbortError' })
    expect(asked.get).toHaveLength(1)
    first.settle.resolve(ASSERTION)
    await Promise.resolve()
    await Promise.resolve()
    expect(await provider.get(REQUEST as never, {})).toBe(ASSERTION)
  })

  test('a wait with a signal that is never aborted resolves and rejects as the sheet does', async () => {
    const { signal } = new AbortController()
    const { sheet } = fakeSheet({ create: () => Promise.reject(named('InvalidStateError')) })
    const provider = oneAtATime(sheet)
    expect(await provider.get(REQUEST as never, { signal })).toBe(ASSERTION)
    await expect(provider.create(CREATION as never, { signal })).rejects.toMatchObject({
      name: 'InvalidStateError',
    })
  })
})

describe('passkeySheetOver (react-native-passkey)', () => {
  const MODULE_MESSAGE = 'The operation couldn’t be completed. example.com canary-native-message'

  function moduleThat(rejection: unknown) {
    return {
      isSupported: () => true,
      create: () => Promise.reject(rejection),
      get: () => Promise.reject(rejection),
    }
  }

  test.each<[string, string]>([
    ['UserCancelled', 'NotAllowedError'],
    ['Interrupted', 'NotAllowedError'],
    ['TimedOut', 'NotAllowedError'],
    ['CredentialAlreadyExists', 'InvalidStateError'],
    ['NotSupported', 'NotSupportedError'],
    ['RequestFailed', 'UnknownError'],
    ['BadConfiguration', 'UnknownError'],
    ['NoCredentials', 'UnknownError'],
    ['InvalidChallenge', 'UnknownError'],
    // A word that is a member of every object must not be looked up as one of the table's.
    ['constructor', 'UnknownError'],
    ['toString', 'UnknownError'],
    ['', 'UnknownError'],
  ])(
    'the module’s %s is a rejection named %s, with nothing of the module’s message',
    async (word, name) => {
      const sheet = passkeySheetOver(moduleThat({ error: word, message: MODULE_MESSAGE }))
      for (const call of [sheet.create(CREATION as never), sheet.get(REQUEST as never)]) {
        const thrown = await call.then(
          () => null,
          (error: unknown) => error
        )
        expect(thrown).toBeInstanceOf(Error)
        expect((thrown as Error).name).toBe(name)
        expect(JSON.stringify([(thrown as Error).message, { ...(thrown as Error) }])).not.toContain(
          'canary-native-message'
        )
      }
    }
  )

  test.each<[string, unknown]>([
    ['an Error', new Error(MODULE_MESSAGE)],
    ['a string', MODULE_MESSAGE],
    ['nothing', undefined],
    ['null', null],
    ['an array', [{ error: 'UserCancelled' }]],
    ['a word that is not a string', { error: { toString: () => 'UserCancelled' } }],
    ['an inherited word', Object.create({ error: 'UserCancelled' })],
  ])(
    '%s thrown by the module is a failure with no name of its own, never a dismissal',
    async (_, rejection) => {
      const thrown = await passkeySheetOver(moduleThat(rejection))
        .get(REQUEST as never)
        .then(
          () => null,
          (error: unknown) => error
        )
      expect((thrown as Error).name).toBe('UnknownError')
      expect((thrown as Error).message).not.toContain('canary-native-message')
    }
  )

  test('hands the options over untouched, and fills in only a credential’s missing type', async () => {
    const seen: unknown[] = []
    const { type: _type, ...untyped } = ASSERTION
    const answers: unknown[] = [untyped, { ...ASSERTION, type: 'password' }, null, 'text']
    const sheet = passkeySheetOver({
      isSupported: () => true,
      create: async (request) => {
        seen.push(request)
        return REGISTRATION
      },
      get: async (request) => {
        seen.push(request)
        return answers.shift()
      },
    })
    expect(await sheet.create(CREATION as never)).toBe(REGISTRATION)
    expect(await sheet.get(REQUEST as never)).toEqual(ASSERTION)
    // Another type is left as it is: the client refuses it before it is sent.
    expect(await sheet.get(REQUEST as never)).toEqual({ ...ASSERTION, type: 'password' })
    expect(await sheet.get(REQUEST as never)).toBeNull()
    expect(await sheet.get(REQUEST as never)).toBe('text')
    expect(seen[0]).toBe(CREATION)
    expect(seen[1]).toBe(REQUEST)
  })

  test('supported is the module’s own true and nothing looser', () => {
    const says = (value: unknown) =>
      passkeySheetOver({
        isSupported: () => value as boolean,
        create: async () => null,
        get: async () => null,
      }).isSupported?.()
    expect(says(true)).toBe(true)
    expect(says(false)).toBe(false)
    expect(says('yes')).toBe(false)
    expect(says(undefined)).toBe(false)
  })
})

describe('browserSessionOver (expo-web-browser)', () => {
  function moduleThat(result: { type: string; url?: unknown }) {
    const calls: unknown[][] = []
    return {
      calls,
      module: {
        async openAuthSessionAsync(...parts: unknown[]) {
          calls.push(parts)
          return result
        },
      },
    }
  }

  test('a success is its URL; a custom scheme asks for no universal link', async () => {
    const { module, calls } = moduleThat({ type: 'success', url: RETURNED })
    expect(await browserSessionOver(module).open(PROVIDER_URL, SCHEME)).toBe(RETURNED)
    expect(calls).toEqual([[PROVIDER_URL, SCHEME, {}]])
  })

  test('an https redirect URL is asked for as a universal link, whatever its case', async () => {
    const { module, calls } = moduleThat({ type: 'success', url: `${LINK}#x=1` })
    await browserSessionOver(module).open(PROVIDER_URL, LINK)
    await browserSessionOver(module).open(PROVIDER_URL, 'HTTPS://app.example.com/cb')
    // A scheme that only starts like it is not one.
    await browserSessionOver(module).open(PROVIDER_URL, 'https.example.app:/cb')
    expect(calls.map((call) => call[2])).toEqual([
      { preferUniversalLinks: true },
      { preferUniversalLinks: true },
      {},
    ])
  })

  test.each<[string, { type: string; url?: unknown }]>([
    ['cancel', { type: 'cancel' }],
    ['dismiss', { type: 'dismiss' }],
    ['opened', { type: 'opened' }],
    ['locked', { type: 'locked' }],
    ['a type this version does not know, with a URL', { type: 'redirected', url: RETURNED }],
    ['a success with no URL', { type: 'success' }],
    ['a success whose URL is not a string', { type: 'success', url: { href: RETURNED } }],
  ])('%s is no URL', async (_, result) => {
    expect(
      await browserSessionOver(moduleThat(result).module).open(PROVIDER_URL, SCHEME)
    ).toBeNull()
  })
})

describe('flowScreen, with what the client can do', () => {
  const cases: [object, { passkey?: boolean; providers?: boolean }, FlowScreen][] = [
    [{ status: 'needs_first_factor', strategies: ['passkey'] }, {}, 'not_supported'],
    [
      { status: 'needs_first_factor', strategies: ['passkey'] },
      { passkey: false },
      'not_supported',
    ],
    [
      { status: 'needs_first_factor', strategies: ['passkey'] },
      { providers: true },
      'not_supported',
    ],
    [
      { status: 'needs_first_factor', strategies: ['passkey'] },
      { passkey: true },
      'needs_first_factor',
    ],
    [{ status: 'needs_first_factor', strategies: ['google'] }, { passkey: true }, 'not_supported'],
    [
      { status: 'needs_first_factor', strategies: ['google'] },
      { providers: true },
      'needs_first_factor',
    ],
    [
      { status: 'needs_first_factor', strategies: ['facebook'] },
      { providers: true },
      'needs_first_factor',
    ],
    // An emailed link is never a way, whatever else the client can do.
    [
      { status: 'needs_first_factor', strategies: ['email_link'] },
      { passkey: true, providers: true },
      'not_supported',
    ],
    // A provider this version does not know is not opened on a guess.
    [
      { status: 'needs_first_factor', strategies: ['myspace'] },
      { providers: true },
      'not_supported',
    ],
    [{ status: 'needs_second_factor', options: ['passkey'] }, {}, 'not_supported'],
    [{ status: 'needs_second_factor', options: ['passkey'] }, { providers: true }, 'not_supported'],
    [
      { status: 'needs_second_factor', options: ['passkey'] },
      { passkey: true },
      'needs_second_factor',
    ],
    // A provider is a first factor only.
    [{ status: 'needs_second_factor', options: ['google'] }, { providers: true }, 'not_supported'],
    // A passkey is not enrolled inside a sign-in.
    [
      { status: 'needs_factor_enrolment', methods: ['passkey'] },
      { passkey: true },
      'not_supported',
    ],
    // A value that is merely truthy is not a yes.
    [
      { status: 'needs_first_factor', strategies: ['passkey'] },
      { passkey: 'yes' as never },
      'not_supported',
    ],
  ]

  test.each(cases)('%j with %j is %s', (step, ways, screen) => {
    expect(flowScreen(step as never, ways)).toBe(screen)
  })
})

describe('what a client says it can do', () => {
  test('nothing without a sheet or a browser, and nothing for a client made some other way', () => {
    expect(waysOf(world().client)).toEqual({ passkey: false, providers: false })
    expect(waysOf({} as never)).toEqual({ passkey: false, providers: false })
  })

  test('creating a client asks the sheet nothing; the device is asked each time, and a module that throws cannot be asked', () => {
    let supported: boolean | 'throws' = true
    let asked = 0
    const w = world({
      client: {
        passkeys: {
          isSupported() {
            asked += 1
            if (supported === 'throws') {
              throw new Error('native module missing')
            }
            return supported
          },
          create: async () => REGISTRATION,
          get: async () => ASSERTION,
        },
        browser: fakeBrowser(() => null).browser,
      },
    })
    expect(asked).toBe(0)
    expect(waysOf(w.client)).toEqual({ passkey: true, providers: true })
    expect(w.client.signIn.canUsePasskey()).toBe(true)
    supported = false
    expect(waysOf(w.client).passkey).toBe(false)
    expect(w.client.signIn.canUsePasskey()).toBe(false)
    supported = 'throws'
    expect(waysOf(w.client).passkey).toBe(false)
    expect(w.client.signIn.canUsePasskey()).toBe(false)
  })

  test('a sheet that does not say whether it is supported is taken to be', () => {
    const w = world({
      client: { passkeys: { create: async () => REGISTRATION, get: async () => ASSERTION } },
    })
    expect(waysOf(w.client)).toEqual({ passkey: true, providers: false })
  })

  test('a passkey without a sheet is passkey.unsupported before any request, whatever the runtime has', async () => {
    const w = world()
    expect(w.client.signIn.canUsePasskey()).toBe(false)
    expect((await caught(w.client.signIn.withPasskey())).code).toBe('passkey.unsupported')
    expect(w.api.requests).toEqual([])
  })
})

describe('signInWithProvider', () => {
  function app(back: Parameters<typeof fakeBrowser>[0], signedIn = false) {
    const { browser, opened } = fakeBrowser(back)
    const w = world({ signedIn, client: { browser } })
    w.api.on(OAUTH_START, () => oauthStarted())
    w.api.on(OAUTH_EXCHANGE, () => oauthCompleted())
    return { w, opened }
  }

  test('starts as the app’s platform, opens the provider’s page, and exchanges the ticket with the binding it kept in memory', async () => {
    const { w, opened } = app(() => RETURNED)
    const outcome = await signInWithProvider(w.client, { provider: 'google', redirectUrl: SCHEME })
    expect(outcome.status).toBe('complete')
    expect(w.client.state.status).toBe('signed-in')
    expect(opened).toEqual([[PROVIDER_URL, SCHEME]])
    const [start] = w.api.calls(OAUTH_START)
    expect(start?.body).toEqual({ provider: 'google', redirectUrl: SCHEME })
    expect(start?.headers.get('x-tula-client')).toBe('ios')
    expect(w.api.calls(OAUTH_EXCHANGE)[0]?.body).toEqual({
      ticket: TICKET,
      attemptId: ATTEMPT,
      binding: BINDING,
    })
    await waitFor(() => expect(w.storedToken()).toBe('rt_signed_in'))
    // The store holds the refresh token and nothing of the round trip.
    expect([...w.store.entries.values()]).toEqual(['rt_signed_in'])
    expectNothingKept(w, outcome.status)
  })

  test('a client with no browser is refused before any request', async () => {
    const w = world()
    const input = { provider: 'google', redirectUrl: SCHEME } as const
    expect((await caught(signInWithProvider(w.client, input))).code).toBe('storage.failed')
    expect((await caught(linkProvider(w.client, input))).code).toBe('storage.failed')
    expect((await caught(retryProviderSignIn({} as never))).code).toBe('storage.failed')
    expect(w.api.requests).toEqual([])
  })

  test('one round trip at a time: a second while the browser is open is flow.busy, with no request and no second browser', async () => {
    let close: (url: string | null) => void = () => {}
    const { w, opened } = app(() => new Promise((resolve) => (close = resolve)))
    const input = { provider: 'google', redirectUrl: SCHEME } as const
    const first = signInWithProvider(w.client, input)
    await waitFor(() => expect(opened).toHaveLength(1))
    expect((await caught(signInWithProvider(w.client, input))).code).toBe('flow.busy')
    expect((await caught(linkProvider(w.client, input))).code).toBe('flow.busy')
    expect((await caught(retryProviderSignIn(w.client))).code).toBe('flow.busy')
    expect(w.api.calls(OAUTH_START)).toHaveLength(1)
    expect(opened).toHaveLength(1)
    close(null)
    expect(await first).toEqual({ status: 'cancelled' })
    // And the next one is let through.
    close = () => {}
    const again = signInWithProvider(w.client, input)
    await waitFor(() => expect(opened).toHaveLength(2))
    close(RETURNED)
    expect((await again).status).toBe('complete')
  })

  test('a closed browser is cancelled: nobody signed in, nothing exchanged, no binding kept', async () => {
    const { w } = app(() => null)
    expect(await signInWithProvider(w.client, { provider: 'google', redirectUrl: SCHEME })).toEqual(
      { status: 'cancelled' }
    )
    expect(w.client.state.status).not.toBe('signed-in')
    expect(w.api.calls(OAUTH_EXCHANGE)).toEqual([])
    // The binding went with the round trip: its ticket, arriving later, completes nothing.
    expect(await retryProviderSignIn(w.client)).toEqual({ status: 'refused', reason: 'no_answer' })
    expect(w.api.calls(OAUTH_EXCHANGE)).toEqual([])
    expectNothingKept(w)
  })

  test.each<[string, string | unknown, string]>([
    [
      'another scheme',
      `com.evil.app:/oauth/callback#tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`,
      'unexpected_return',
    ],
    [
      'the redirect URL as a prefix of a longer path',
      `${SCHEME}/more#tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`,
      'unexpected_return',
    ],
    [
      'a query before the fragment',
      `${SCHEME}?next=x#tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`,
      'unexpected_return',
    ],
    [
      'another case',
      `${SCHEME.toUpperCase()}#tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`,
      'unexpected_return',
    ],
    ['a space in front', ` ${RETURNED}`, 'unexpected_return'],
    [
      'the ticket in a query, not a fragment',
      `${SCHEME}?tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`,
      'no_answer',
    ],
    ['no fragment at all', SCHEME, 'no_answer'],
    ['an empty string', '', 'no_answer'],
    ['an empty fragment', `${SCHEME}#`, 'no_answer'],
    ['a fragment with neither a ticket nor an error', `${SCHEME}#state=1`, 'no_answer'],
    ['a ticket with no attempt', `${SCHEME}#tula_ticket=${TICKET}`, 'not_started_here'],
    [
      'a ticket for an attempt this client did not start',
      `${SCHEME}#tula_ticket=${TICKET}&tula_attempt=0190d7a0-0000-7000-8000-00000000ffff`,
      'not_started_here',
    ],
  ])(
    '%s is refused without a request to the server, and signs nobody in',
    async (_, returned, reason) => {
      const { w } = app(() => returned as string)
      const outcome = await signInWithProvider(w.client, {
        provider: 'google',
        redirectUrl: SCHEME,
      })
      expect(outcome).toEqual({ status: 'refused', reason } as never)
      expect(w.api.calls(OAUTH_EXCHANGE)).toEqual([])
      expect(w.api.requests).toHaveLength(1)
      expect(w.client.state.status).not.toBe('signed-in')
      // The round trip is over: nothing is left to try again.
      expect(await retryProviderSignIn(w.client)).toEqual({
        status: 'refused',
        reason: 'no_answer',
      })
      expect(w.api.calls(OAUTH_EXCHANGE)).toEqual([])
      expectNothingKept(w, outcome)
    }
  )

  test.each<[string, unknown]>([
    ['undefined', undefined],
    ['an object with the URL in it', { url: RETURNED }],
    ['a number', 7],
  ])('a browser that comes back with %s is a closed one', async (_, returned) => {
    const { w } = app(() => returned as never)
    expect(await signInWithProvider(w.client, { provider: 'google', redirectUrl: SCHEME })).toEqual(
      { status: 'cancelled' }
    )
    expect(w.api.calls(OAUTH_EXCHANGE)).toEqual([])
  })

  test('a ticket that arrives with no round trip of this client is refused without a request (a link someone sent)', async () => {
    // What an app that handed every incoming URL to the client would do; the package's own
    // calls never do. Nothing was started here, so there is no binding to send it with.
    const { w } = app(() => null)
    expect(
      (await caught(w.client.signIn.withOAuth({ provider: 'google', redirectUrl: SCHEME }))).code
    ).toBe('link.cross_origin')
    expect(await w.client.signIn.handleOAuthCallback()).toEqual({ status: 'none' })
    expect(w.api.requests).toEqual([])
  })

  test('a browser module that throws is `internal`, with nothing of what it said, and the next round trip works', async () => {
    let fail = true
    const { w } = app(() => {
      if (fail) {
        throw new Error(`could not open ${PROVIDER_URL} canary-browser-message ${BINDING}`)
      }
      return RETURNED
    })
    const input = { provider: 'google', redirectUrl: SCHEME } as const
    const error = await caught(signInWithProvider(w.client, input))
    expect(error.code).toBe('internal')
    expect(JSON.stringify([error.message, { ...error }])).not.toContain('canary-browser-message')
    expect(w.api.calls(OAUTH_EXCHANGE)).toEqual([])
    expectNothingKept(w, error)
    fail = false
    expect((await signInWithProvider(w.client, input)).status).toBe('complete')
  })

  test('what the start refuses is thrown as the server said it, reason included, and no browser is opened', async () => {
    const { w, opened } = app(() => RETURNED)
    w.api.on(OAUTH_START, () =>
      json(400, {
        status: 400,
        code: 'request.redirect_not_allowed',
        detail: 'That redirect URL is not allowed.',
        params: { reason: 'provider_without_pkce' },
      })
    )
    const error = await caught(
      signInWithProvider(w.client, { provider: 'linkedin', redirectUrl: SCHEME })
    )
    expect(error).toMatchObject({
      code: 'request.redirect_not_allowed',
      status: 400,
      params: { reason: 'provider_without_pkce' },
    })
    expect(opened).toEqual([])
    // And the client is not left believing it is on the redirect URL's page.
    expect(
      (await caught(w.client.signIn.withOAuth({ provider: 'google', redirectUrl: SCHEME }))).code
    ).toBe('link.cross_origin')
  })

  test('an authorization URL that is not http(s) is never opened', async () => {
    const { w, opened } = app(() => RETURNED)
    w.api.on(OAUTH_START, () => oauthStarted({ authorizationUrl: 'javascript:alert(1)' }))
    const error = await caught(
      signInWithProvider(w.client, { provider: 'google', redirectUrl: SCHEME })
    )
    expect(error.code).toBe('response.invalid')
    expect(opened).toEqual([])
  })

  test('the provider’s own refusal is an error outcome with a contract code, and no exchange', async () => {
    const { w } = app(() => `${SCHEME}#tula_error=oauth.access_denied`)
    const outcome = await signInWithProvider(w.client, { provider: 'google', redirectUrl: SCHEME })
    expect(outcome).toMatchObject({ status: 'error', code: 'oauth.access_denied' })
    expect(w.api.calls(OAUTH_EXCHANGE)).toEqual([])
    expect(w.client.state.status).not.toBe('signed-in')
  })

  test('a ticket the server says another client started is refused, and is not kept for a retry', async () => {
    const { w } = app(() => RETURNED)
    w.api.on(OAUTH_EXCHANGE, () => failure(409, 'oauth.different_browser' as never))
    expect(await signInWithProvider(w.client, { provider: 'google', redirectUrl: SCHEME })).toEqual(
      { status: 'refused', reason: 'not_started_here' }
    )
    expect(w.client.state.status).not.toBe('signed-in')
    expect(await retryProviderSignIn(w.client)).toEqual({ status: 'refused', reason: 'no_answer' })
    expect(w.api.calls(OAUTH_EXCHANGE)).toHaveLength(1)
  })

  test('an exchange that got no answer keeps the ticket and the binding in memory only, and a retry signs in', async () => {
    const { w } = app(() => RETURNED)
    w.api.on(OAUTH_EXCHANGE, () => {
      throw new TypeError('fetch failed')
    })
    const error = await caught(
      signInWithProvider(w.client, { provider: 'google', redirectUrl: SCHEME })
    )
    expect(error.code).toBe('network.failed')
    expect(w.client.state.status).not.toBe('signed-in')
    // Held for the retry, and in none of the places that last or travel.
    expectNothingKept(w, error)
    w.api.on(OAUTH_EXCHANGE, () => oauthCompleted())
    const outcome = await retryProviderSignIn(w.client)
    expect(outcome.status).toBe('complete')
    expect(w.api.calls(OAUTH_EXCHANGE).at(-1)?.body).toEqual({
      ticket: TICKET,
      attemptId: ATTEMPT,
      binding: BINDING,
    })
    // Spent: a second retry has nothing.
    expect(await retryProviderSignIn(w.client)).toEqual({ status: 'refused', reason: 'no_answer' })
  })

  test('an exchange the server refused for good is not kept: a retry sends nothing', async () => {
    const { w } = app(() => RETURNED)
    w.api.on(OAUTH_EXCHANGE, () => json(200, { id: 'not-an-attempt' }))
    expect(
      (await caught(signInWithProvider(w.client, { provider: 'google', redirectUrl: SCHEME }))).code
    ).toBe('response.invalid')
    expect(await retryProviderSignIn(w.client)).toEqual({ status: 'refused', reason: 'no_answer' })
    expect(w.api.calls(OAUTH_EXCHANGE)).toHaveLength(1)
  })

  test('a new round trip forgets the one that never came back', async () => {
    let returned: string | null = null
    const { w } = app(() => returned)
    const input = { provider: 'google', redirectUrl: SCHEME } as const
    expect((await signInWithProvider(w.client, input)).status).toBe('cancelled')
    returned = RETURNED
    expect((await signInWithProvider(w.client, input)).status).toBe('complete')
    expect(w.api.calls(OAUTH_EXCHANGE)).toHaveLength(1)
  })

  test('linkProvider connects an account to the signed-in user by the same round trip', async () => {
    const back = `${LINK}#tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`
    const { w, opened } = app(() => back, true)
    w.api.on(LINK_START, () =>
      json(200, { attemptId: ATTEMPT, authorizationUrl: PROVIDER_URL, binding: BINDING })
    )
    w.api.on(LINK_EXCHANGE, () => json(200, IDENTITY))
    await w.client.load()
    const outcome = await linkProvider(w.client, { provider: 'google', redirectUrl: LINK })
    expect(outcome).toEqual({ status: 'linked', identity: IDENTITY } as never)
    expect(opened).toEqual([[PROVIDER_URL, LINK]])
    expect(w.api.calls(LINK_EXCHANGE)[0]?.body).toEqual({
      ticket: TICKET,
      attemptId: ATTEMPT,
      binding: BINDING,
    })
    expect(w.api.calls(OAUTH_EXCHANGE)).toEqual([])
    expectNothingKept(w, outcome.status)
  })
})

describe('useSignIn, with a passkey and a provider', () => {
  function passkeyRoutes(w: World) {
    w.api.on(PASSKEY_START, () =>
      json(200, {
        attempt: {
          id: 'attempt_1',
          kind: 'sign_in',
          expiresAt: '2030-01-01T00:10:00.000Z',
          step: { status: 'needs_first_factor', strategies: ['passkey'] },
          attemptSecret: 'tula_at_test_secret',
        },
        options: REQUEST,
      })
    )
    w.api.on(PASSKEY_SUBMIT, () => completed('sign_in'))
  }

  test('withPasskey asks the sheet with the server’s options and signs in', async () => {
    const { sheet, asked } = fakeSheet({})
    const w = world({ client: { passkeys: sheet } })
    passkeyRoutes(w)
    const { result } = w.render(() => useSignIn())
    let step: unknown
    await act(async () => {
      step = await result.current.withPasskey()
    })
    expect(step).toMatchObject({ status: 'complete' })
    expect(asked.get).toEqual([REQUEST])
    expect(w.api.calls(PASSKEY_SUBMIT)[0]?.body).toEqual({ credential: ASSERTION })
    expect(w.api.calls(PASSKEY_START)[0]?.headers.get('x-tula-client')).toBe('ios')
    expect(w.api.calls(PASSKEY_START)[0]?.headers.get('origin')).toBeNull()
    expect(result.current).toMatchObject({ error: null, dismissed: false, screen: 'complete' })
    expect(w.client.state.status).toBe('signed-in')
    expectNothingKept(w, result.current.error, result.current.step)
  })

  test('a dismissed sheet is neither an error nor a sign-in, sends no assertion, and the action works again', async () => {
    let dismiss = true
    const { sheet } = fakeSheet({
      get: () => (dismiss ? Promise.reject(named('NotAllowedError')) : Promise.resolve(ASSERTION)),
    })
    const w = world({ client: { passkeys: sheet } })
    passkeyRoutes(w)
    const { result } = w.render(() => useSignIn())
    let step: unknown = 'unset'
    await act(async () => {
      step = await result.current.withPasskey()
    })
    expect(step).toBeNull()
    expect(result.current).toMatchObject({
      dismissed: true,
      error: null,
      isPending: false,
      step: null,
    })
    expect(w.api.calls(PASSKEY_SUBMIT)).toEqual([])
    expect(w.client.state.status).toBe('signed-out')
    expect(w.storedToken()).toBeUndefined()
    dismiss = false
    await act(async () => {
      step = await result.current.withPasskey()
    })
    expect(step).toMatchObject({ status: 'complete' })
    expect(result.current).toMatchObject({ dismissed: false, error: null })
    expect(w.client.state.status).toBe('signed-in')
  })

  test.each<[string, string]>([
    ['InvalidStateError', 'passkey.already_on_device'],
    ['NotSupportedError', 'passkey.unsupported'],
    ['UnknownError', 'passkey.failed'],
    ['SecurityError', 'passkey.failed'],
  ])(
    'a sheet that fails with %s is the error %s, with the client’s own message and not the platform’s',
    async (name, code) => {
      const { sheet } = fakeSheet({
        get: () => Promise.reject(named(name, 'canary-platform-message example.com')),
      })
      const w = world({ client: { passkeys: sheet } })
      passkeyRoutes(w)
      const { result } = w.render(() => useSignIn())
      await act(async () => {
        await result.current.withPasskey()
      })
      expect(result.current.error?.code).toBe(code)
      expect(result.current.dismissed).toBe(false)
      expect(
        JSON.stringify([result.current.error?.message, { ...result.current.error }])
      ).not.toContain('canary-platform-message')
      expect(w.api.calls(PASSKEY_SUBMIT)).toEqual([])
      expectNothingKept(w, result.current.error)
    }
  )

  test.each<[string, unknown]>([
    ['nothing', null],
    ['a credential of another type', { ...ASSERTION, type: 'password' }],
    ['a response with a field missing', { ...ASSERTION, response: {} }],
  ])('a sheet that resolves with %s is passkey.failed, and nothing is sent', async (_, answer) => {
    const { sheet } = fakeSheet({ get: async () => answer })
    const w = world({ client: { passkeys: sheet } })
    passkeyRoutes(w)
    const { result } = w.render(() => useSignIn())
    await act(async () => {
      await result.current.withPasskey()
    })
    expect(result.current.error?.code).toBe('passkey.failed')
    expect(w.api.calls(PASSKEY_SUBMIT)).toEqual([])
  })

  test('a second tap while the sheet is open starts no second attempt and asks no second sheet', async () => {
    let answer: (value: unknown) => void = () => {}
    const { sheet, asked } = fakeSheet({ get: () => new Promise((resolve) => (answer = resolve)) })
    const w = world({ client: { passkeys: sheet } })
    passkeyRoutes(w)
    const { result } = w.render(() => useSignIn())
    let first: Promise<unknown> = Promise.resolve()
    await act(async () => {
      first = result.current.withPasskey()
      await waitFor(() => expect(asked.get).toHaveLength(1))
    })
    expect(result.current.isPending).toBe(true)
    await act(async () => {
      expect(await result.current.withPasskey()).toBeNull()
    })
    // Also past the hook: the client itself is refused a second sheet, as called off.
    expect((await caught(w.client.signIn.withPasskey())).code).toBe('passkey.cancelled')
    expect(asked.get).toHaveLength(1)
    await act(async () => {
      answer(ASSERTION)
      await first
    })
    expect(w.client.state.status).toBe('signed-in')
    expect(w.api.calls(PASSKEY_SUBMIT)).toHaveLength(1)
  })

  test('the screen counts a passkey and a provider only for a client that can do them', async () => {
    const step = { status: 'needs_first_factor', strategies: ['passkey', 'google'] } as const
    const screenOf = async (client: object) => {
      const w = world({ client })
      w.api.on(ROUTE.signIn, () => started('sign_in', step))
      const { result } = w.render(() => useSignIn())
      await act(async () => {
        await result.current.start({ identifier: 'maya@example.com' })
      })
      return result.current.screen
    }
    expect(await screenOf({})).toBe('not_supported')
    expect(await screenOf({ passkeys: fakeSheet({}).sheet })).toBe('needs_first_factor')
    expect(await screenOf({ browser: fakeBrowser(() => null).browser })).toBe('needs_first_factor')
    expect(await screenOf({ passkeys: { ...fakeSheet({}).sheet, isSupported: () => false } })).toBe(
      'not_supported'
    )
  })

  test('a passkey as the second step: the sheet’s answer is submitted; dismissed, the step stays and works again', async () => {
    let dismiss = true
    const { sheet } = fakeSheet({
      get: () => (dismiss ? Promise.reject(named('NotAllowedError')) : Promise.resolve(ASSERTION)),
    })
    const w = world({ client: { passkeys: sheet } })
    const second = { status: 'needs_second_factor', options: ['passkey'] } as const
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    w.api.on(ROUTE.signInPassword, () => attempt('sign_in', second))
    w.api.on('POST /v1/client/sign-ins/attempt_1/second-factor/passkey/options', () =>
      json(200, REQUEST)
    )
    w.api.on(ROUTE.signInSecond, () => completed('sign_in'))
    const { result } = w.render(() => useSignIn())
    await act(async () => {
      await result.current.start({ identifier: 'maya@example.com' })
      await result.current.submitPassword({ password: 'correct horse battery staple' })
    })
    expect(result.current.screen).toBe('needs_second_factor')
    await act(async () => {
      expect(await result.current.submitSecondFactorWithPasskey()).toBeNull()
    })
    expect(result.current).toMatchObject({ dismissed: true, error: null, step: second })
    expect(w.api.calls(ROUTE.signInSecond)).toEqual([])
    dismiss = false
    await act(async () => {
      await result.current.submitSecondFactorWithPasskey()
    })
    expect(w.api.calls(ROUTE.signInSecond)[0]?.body).toEqual({
      method: 'passkey',
      credential: ASSERTION,
    })
    expect(result.current).toMatchObject({ dismissed: false, screen: 'complete' })
    expect(w.client.state.status).toBe('signed-in')
  })

  test('a reset that stops at a second factor takes a passkey too', async () => {
    const { sheet } = fakeSheet({})
    const w = world({ client: { passkeys: sheet } })
    w.api.on(ROUTE.reset, () =>
      started('password_reset', { status: 'needs_new_password', strategies: ['email_code'] })
    )
    w.api.on(ROUTE.resetSubmit, () =>
      attempt('password_reset', { status: 'needs_second_factor', options: ['passkey'] })
    )
    w.api.on('POST /v1/client/password-resets/attempt_1/second-factor/passkey/options', () =>
      json(200, REQUEST)
    )
    w.api.on(ROUTE.resetSecond, () => completed('password_reset'))
    const { result } = w.render(() => useResetPassword())
    await act(async () => {
      await result.current.start({ email: 'maya@example.com' })
      await result.current.submit({ code: '123456', password: 'a new long password' })
    })
    expect(result.current.screen).toBe('needs_second_factor')
    await act(async () => {
      await result.current.submitSecondFactorWithPasskey()
    })
    expect(w.api.calls(ROUTE.resetSecond)[0]?.body).toEqual({
      method: 'passkey',
      credential: ASSERTION,
    })
    expect(result.current.screen).toBe('complete')
  })

  function providerApp(back: Parameters<typeof fakeBrowser>[0]) {
    const { browser, opened } = fakeBrowser(back)
    const w = world({ client: { browser } })
    w.api.on(OAUTH_START, () => oauthStarted())
    w.api.on(OAUTH_EXCHANGE, () => oauthCompleted())
    return { w, opened, hook: w.render(() => useSignIn()) }
  }
  const GOOGLE = { provider: 'google', redirectUrl: SCHEME } as const

  test('withProvider signs in through the browser', async () => {
    const { w, hook } = providerApp(() => RETURNED)
    await act(async () => {
      expect(await hook.result.current.withProvider(GOOGLE)).toMatchObject({ status: 'complete' })
    })
    expect(hook.result.current).toMatchObject({ error: null, dismissed: false, screen: 'complete' })
    expect(w.client.state.status).toBe('signed-in')
    expectNothingKept(w, hook.result.current.step)
  })

  test('a closed browser is a dismissal, not an error, and the button works again', async () => {
    let returned: string | null = null
    const { w, hook } = providerApp(() => returned)
    await act(async () => {
      expect(await hook.result.current.withProvider(GOOGLE)).toBeNull()
    })
    expect(hook.result.current).toMatchObject({ dismissed: true, error: null, step: null })
    expect(w.client.state.status).toBe('signed-out')
    returned = RETURNED
    await act(async () => {
      await hook.result.current.withProvider(GOOGLE)
    })
    expect(hook.result.current).toMatchObject({ dismissed: false, error: null, screen: 'complete' })
  })

  test.each<[string, string, string]>([
    [
      'a return that is not the redirect URL',
      `com.evil.app:/cb#tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`,
      'oauth.ticket_invalid',
    ],
    ['a return with no answer in it', SCHEME, 'oauth.ticket_invalid'],
    [
      'a ticket this client did not start',
      `${SCHEME}#tula_ticket=${TICKET}&tula_attempt=0190d7a0-0000-7000-8000-00000000ffff`,
      'oauth.different_browser',
    ],
    ['the provider’s refusal', `${SCHEME}#tula_error=oauth.access_denied`, 'oauth.access_denied'],
  ])(
    '%s is an error with a contract code and its message, and signs nobody in',
    async (_, returned, code) => {
      const { w, hook } = providerApp(() => returned)
      await act(async () => {
        expect(await hook.result.current.withProvider(GOOGLE)).toBeNull()
      })
      expect(hook.result.current.error?.code).toBe(code)
      expect(hook.result.current.error?.message).not.toBe('')
      expect(hook.result.current.dismissed).toBe(false)
      expect(w.client.state.status).toBe('signed-out')
      expect(w.api.calls(OAUTH_EXCHANGE)).toEqual([])
      expectNothingKept(w, hook.result.current.error)
    }
  )

  test('what the server refuses at the start is the hook’s error, reason included', async () => {
    const { w, opened, hook } = providerApp(() => RETURNED)
    w.api.on(OAUTH_START, () =>
      json(400, {
        status: 400,
        code: 'request.redirect_not_allowed',
        detail: 'That redirect URL is not allowed.',
        params: { reason: 'client_not_native' },
      })
    )
    await act(async () => {
      await hook.result.current.withProvider(GOOGLE)
    })
    expect(hook.result.current.error).toMatchObject({
      code: 'request.redirect_not_allowed',
      params: { reason: 'client_not_native' },
    })
    expect(opened).toEqual([])
  })

  test('retryProvider sends again the exchange that got no answer', async () => {
    const { w, hook } = providerApp(() => RETURNED)
    w.api.on(OAUTH_EXCHANGE, () => {
      throw new TypeError('fetch failed')
    })
    await act(async () => {
      await hook.result.current.withProvider(GOOGLE)
    })
    expect(hook.result.current.error?.code).toBe('network.failed')
    w.api.on(OAUTH_EXCHANGE, () => oauthCompleted())
    await act(async () => {
      expect(await hook.result.current.retryProvider()).toMatchObject({ status: 'complete' })
    })
    expect(hook.result.current).toMatchObject({ error: null, screen: 'complete' })
    // With nothing waiting, a retry is an error to start again from, and no request.
    const sent = w.api.requests.length
    await act(async () => {
      expect(await hook.result.current.retryProvider()).toBeNull()
    })
    expect(hook.result.current.error?.code).toBe('oauth.ticket_invalid')
    expect(w.api.requests).toHaveLength(sent)
  })

  test('a provider that vouched and a server that asks for more leave the flow on that step', async () => {
    const { w, hook } = providerApp(() => RETURNED)
    w.api.on(OAUTH_EXCHANGE, () =>
      json(200, {
        id: ATTEMPT,
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: { status: 'needs_second_factor', options: ['totp'] },
        attemptSecret: 'tula_at_test_secret',
      })
    )
    await act(async () => {
      await hook.result.current.withProvider(GOOGLE)
    })
    expect(hook.result.current).toMatchObject({ screen: 'needs_second_factor', error: null })
    expect(w.client.state.status).toBe('signed-out')
  })
})

describe('usePasskeys', () => {
  function signedIn(answers: Parameters<typeof fakeSheet>[0] = {}) {
    const { sheet, asked } = fakeSheet(answers)
    const w = world({ signedIn: true, client: { passkeys: sheet } })
    w.api.on(PASSKEY_OPTIONS, () => json(200, CREATION))
    w.api.on(PASSKEY_ADD, () => json(201, PASSKEY))
    w.api.on(STEP_UP_OPTIONS, () => json(200, REQUEST))
    w.api.on(STEP_UP, () => {
      const fresh = sessionTokens('stepped')
      return json(200, {
        sessionId: fresh.sessionId,
        accessToken: fresh.accessToken,
        accessTokenExpiresAt: fresh.accessTokenExpiresAt,
      })
    })
    return { w, asked }
  }

  async function loaded(w: World) {
    const hook = w.render(() => usePasskeys())
    await waitFor(() => expect(w.client.state.status).toBe('signed-in'))
    return hook
  }

  test('is not supported without a sheet, and on a device that has no passkeys', () => {
    expect(world().render(() => usePasskeys()).result.current.supported).toBe(false)
    const off = world({
      client: { passkeys: { ...fakeSheet({}).sheet, isSupported: () => false } },
    })
    expect(off.render(() => usePasskeys()).result.current.supported).toBe(false)
  })

  test('add makes a passkey with the server’s options and saves what the sheet returned', async () => {
    const { w, asked } = signedIn()
    const { result } = await loaded(w)
    expect(result.current.supported).toBe(true)
    let added: unknown
    await act(async () => {
      added = await result.current.add({ name: 'iPhone' })
    })
    expect(added).toEqual(PASSKEY)
    expect(asked.create).toEqual([CREATION])
    expect(w.api.calls(PASSKEY_ADD)[0]?.body).toEqual({ credential: REGISTRATION, name: 'iPhone' })
    expect(result.current).toMatchObject({ error: null, dismissed: false, isPending: false })
    expectNothingKept(w, added)
  })

  test('a dismissed sheet adds nothing, is not an error, and add works again', async () => {
    let dismiss = true
    const { w } = signedIn({
      create: () =>
        dismiss ? Promise.reject(named('NotAllowedError')) : Promise.resolve(REGISTRATION),
    })
    const { result } = await loaded(w)
    await act(async () => {
      expect(await result.current.add()).toBeNull()
    })
    expect(result.current).toMatchObject({ dismissed: true, error: null, isPending: false })
    expect(w.api.calls(PASSKEY_ADD)).toEqual([])
    dismiss = false
    await act(async () => {
      expect(await result.current.add()).toEqual(PASSKEY)
    })
    expect(result.current).toMatchObject({ dismissed: false, error: null })
    await act(async () => {
      result.current.clearError()
    })
    expect(result.current).toMatchObject({ dismissed: false, error: null })
  })

  test('a device that already holds one, and a server that wants a recent authentication, are errors; clearError forgets them', async () => {
    const { w } = signedIn({ create: () => Promise.reject(named('InvalidStateError')) })
    const { result } = await loaded(w)
    await act(async () => {
      expect(await result.current.add()).toBeNull()
    })
    expect(result.current.error?.code).toBe('passkey.already_on_device')
    w.api.on(PASSKEY_OPTIONS, () =>
      json(403, {
        status: 403,
        code: 'auth.step_up_required',
        detail: 'Confirm it is you.',
        params: { methods: ['passkey'] },
      })
    )
    await act(async () => {
      await result.current.add()
    })
    expect(result.current.error).toMatchObject({ code: 'auth.step_up_required', status: 403 })
    await act(async () => {
      result.current.clearError()
    })
    expect(result.current.error).toBeNull()
  })

  test('stepUp proves a recent authentication with the sheet’s assertion; dismissed, it proves nothing', async () => {
    let dismiss = true
    const { w, asked } = signedIn({
      get: () => (dismiss ? Promise.reject(named('NotAllowedError')) : Promise.resolve(ASSERTION)),
    })
    const { result } = await loaded(w)
    await act(async () => {
      expect(await result.current.stepUp()).toBe(false)
    })
    expect(result.current).toMatchObject({ dismissed: true, error: null })
    expect(w.api.calls(STEP_UP)).toEqual([])
    dismiss = false
    await act(async () => {
      expect(await result.current.stepUp()).toBe(true)
    })
    expect(asked.get).toEqual([REQUEST, REQUEST])
    expect(w.api.calls(STEP_UP)[0]?.body).toEqual({ method: 'passkey', credential: ASSERTION })
    expectNothingKept(w, result.current.error)
  })

  test('one request at a time: an action while the sheet is open does nothing', async () => {
    let answer: (value: unknown) => void = () => {}
    const { w, asked } = signedIn({ create: () => new Promise((resolve) => (answer = resolve)) })
    const { result } = await loaded(w)
    let first: Promise<unknown> = Promise.resolve()
    await act(async () => {
      first = result.current.add()
      await waitFor(() => expect(asked.create).toHaveLength(1))
    })
    expect(result.current.isPending).toBe(true)
    await act(async () => {
      expect(await result.current.add()).toBeNull()
      expect(await result.current.stepUp()).toBe(false)
    })
    expect(asked).toMatchObject({ create: [CREATION], get: [] })
    expect(w.api.calls(STEP_UP_OPTIONS)).toEqual([])
    await act(async () => {
      answer(REGISTRATION)
      expect(await first).toEqual(PASSKEY)
    })
    expect(result.current.isPending).toBe(false)
  })

  test('an answer that arrives after the session ended is nobody’s: no state, no result', async () => {
    let answer: (value: unknown) => void = () => {}
    const { w, asked } = signedIn({ create: () => new Promise((resolve) => (answer = resolve)) })
    w.api.on(ROUTE.signOut, () => new Response(null, { status: 204 }))
    w.api.on(PASSKEY_ADD, () => failure(401, 'auth.unauthenticated'))
    const { result } = await loaded(w)
    let first: Promise<unknown> = Promise.resolve()
    await act(async () => {
      first = result.current.add()
      await waitFor(() => expect(asked.create).toHaveLength(1))
    })
    await act(async () => {
      await w.client.session.signOut()
    })
    await act(async () => {
      answer(REGISTRATION)
      expect(await first).toBeNull()
    })
    expect(result.current).toMatchObject({ error: null, dismissed: false, isPending: false })
  })
})
