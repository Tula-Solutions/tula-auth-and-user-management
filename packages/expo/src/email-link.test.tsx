import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test'
import { act } from '@testing-library/react'
import { isTulaError, type SignInFlow, type TulaError } from '@tula-tech/core'
import { EMAIL_LINK_ATTEMPT_PARAM, EMAIL_LINK_TOKEN_PARAM } from '../../contract/src/headers'
import { LINK_BINDING_TTL_MS, LINK_STORAGE_PREFIX } from '../../core/src/email-link'
import { createExpoClient } from './client'
import { EMAIL_LINK_PARAMS, isEmailLink, openEmailLink, requestEmailLink } from './email-link'
import { useSignIn } from './hooks/use-flows'
import { type BrowserSession, EMAIL_LINK_BINDING_TTL_MS, hostOf, waysOf } from './host'
import { signInWithProvider } from './provider-sign-in'
import { type FlowScreen, flowScreen } from './screens'
import {
  attempt,
  completed,
  failure,
  json,
  ROUTE,
  started,
  TEST_BASE_URL,
  type World,
  world,
} from './testing/world'

// An emailed sign-in link opened in the app (ADR 0055), against a fake API: which URLs are
// worth a request at all, what a link opened anywhere but in the client that asked comes to,
// and that nothing of a link (its token, its binding) is kept or said anywhere. The journey
// (`journeys.test.ts`) runs the same calls against the real API.

const APP_LINK = 'https://app.example.com/sign-in/link'
const TOKEN = 'tula_el_canary-t0k3n'
const BINDING = 'tula_lb_canary-b1nd1ng'
const LINK = `${APP_LINK}#tula_link=${TOKEN}&tula_attempt=attempt_1`
const VERIFY = 'POST /v1/client/sign-ins/link'
const OFFERED = { status: 'needs_first_factor', strategies: ['email_code', 'email_link'] }
const START = new Date('2026-03-01T12:00:00.000Z').getTime()

/** Everything that must never be found in storage, an error, a log line or a request's URL. */
const CANARIES = [TOKEN, BINDING, 'tula_at_test_secret']

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
  setSystemTime(new Date(START))
  logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    spyOn(console, method).mockImplementation(() => {})
  )
})

afterEach(() => {
  setSystemTime()
  for (const spy of logged) {
    spy.mockRestore()
  }
})

/** A phone whose app has an app link for emailed links, and an API that takes one. */
function linked(options: Parameters<typeof world>[0] = {}): World {
  const w = world({ ...options, client: { emailLinkUrl: APP_LINK, ...options.client } })
  w.api.on(ROUTE.signIn, () => started('sign_in', OFFERED))
  w.api.on(ROUTE.signInPrepare, () =>
    attempt(
      'sign_in',
      { ...OFFERED, prepared: { strategy: 'email_link', destination: 'm***@example.com' } },
      { linkBinding: BINDING }
    )
  )
  w.api.on(VERIFY, () => json(200, { status: 'verified' }))
  w.api.on(ROUTE.signInAttempt, () => completed('sign_in'))
  return w
}

/** A sign-in of `w`'s client that has asked for its emailed link. */
async function asked(w: World): Promise<SignInFlow> {
  const flow = await w.client.signIn.start({ identifier: 'maya@example.com' })
  await requestEmailLink(w.client, flow)
  return flow
}

/**
 * Nothing of a link was written to the secure store, a request's URL or header, or a log
 * line; `said` is whatever the test was told (errors, outcomes, hook state).
 */
function expectNothingKept(w: World, ...said: unknown[]) {
  const places = [
    JSON.stringify([...w.store.entries]),
    JSON.stringify(w.store.calls),
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

describe('what this package mirrors of the contract and the client', () => {
  test('the fragment’s two names are the contract’s', () => {
    expect(EMAIL_LINK_PARAMS).toEqual({
      token: EMAIL_LINK_TOKEN_PARAM,
      attempt: EMAIL_LINK_ATTEMPT_PARAM,
    })
  })

  test('a binding is kept as long as the client itself would honour it', () => {
    expect(EMAIL_LINK_BINDING_TTL_MS).toBe(LINK_BINDING_TTL_MS)
  })

  test('the host looks for a binding under the name the client keeps it under', async () => {
    // Held by behaviour: were the two prefixes apart, the host would see no binding.
    const w = linked()
    const flow = await asked(w)
    expect(LINK_STORAGE_PREFIX).toBe('tula.link.')
    expect(hostOf(w.client)?.linkKept(flow.id)).toBe(true)
    expect(hostOf(w.client)?.linkKept('attempt_2')).toBe(false)
  })
})

describe('createTulaExpoClient, emailLinkUrl', () => {
  const runtime = () => ({ platform: 'ios', secureStore: world().store })
  const base = { publishableKey: `tula_pk_dev_${'0'.repeat(30)}`, baseUrl: TEST_BASE_URL }

  test.each<[string, unknown]>([
    ['a custom scheme', 'com.example.app:/sign-in/link'],
    ['plain http', 'http://app.example.com/sign-in/link'],
    ['a fragment', `${APP_LINK}#x`],
    ['a query', 'https://a.example/p?x=1'],
    ['an empty query', 'https://a.example/p?'],
    ['a user name', 'https://u@a.example/p'],
    ['an at sign in the path', 'https://a.example/p@q'],
    ['a backslash', 'https://a.example\\p'],
    ['an empty fragment', `${APP_LINK}#`],
    ['white space', 'https://app.example.com/sign in'],
    ['a line break', `${APP_LINK}\n`],
    ['upper-case scheme', 'HTTPS://app.example.com/sign-in/link'],
    ['no host', 'https://'],
    ['an empty string', ''],
    ['a number', 7],
    ['null', null],
    ['an object', { href: APP_LINK }],
  ])('%s is refused when the client is made, in words that repeat nothing', (_name, value) => {
    let thrown: unknown
    try {
      createExpoClient({ ...base, emailLinkUrl: value as never }, runtime())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TypeError)
    const { message } = thrown as TypeError
    expect(message).toContain('`emailLinkUrl`')
    // (A value that is only the scheme is in the sentence as the scheme.)
    if (typeof value === 'string' && value.length > 'https://'.length) {
      expect(message).not.toContain(value)
    }
  })

  test('with the option a client says an emailed link is a way; without it nothing changes', () => {
    const w = linked()
    expect(w.client.signIn.canUseEmailLink()).toBe(true)
    expect(waysOf(w.client).emailLink).toBe(true)
    const plain = world()
    expect(plain.client.signIn.canUseEmailLink()).toBe(false)
    expect(waysOf(plain.client).emailLink).toBe(false)
    // Asking whether a link can be kept keeps nothing, and reads no secure store.
    expect(hostOf(w.client)?.linksKept()).toBe(0)
    expect(w.store.calls).toEqual([])
  })
})

describe('flowScreen, with an emailed link', () => {
  const cases: [object, { emailLink?: boolean; passkey?: boolean }, FlowScreen][] = [
    [{ status: 'needs_first_factor', strategies: ['email_link'] }, {}, 'not_supported'],
    [
      { status: 'needs_first_factor', strategies: ['email_link'] },
      { emailLink: false, passkey: true },
      'not_supported',
    ],
    [
      { status: 'needs_first_factor', strategies: ['email_link'] },
      { emailLink: true },
      'needs_first_factor',
    ],
    // A value that is merely truthy is not a yes.
    [
      { status: 'needs_first_factor', strategies: ['email_link'] },
      { emailLink: 'yes' as never },
      'not_supported',
    ],
    // A link proves a first factor only.
    [
      { status: 'needs_second_factor', options: ['email_link'] },
      { emailLink: true },
      'not_supported',
    ],
  ]

  test.each(cases)('%j with %j is %s', (step, ways, screen) => {
    expect(flowScreen(step as never, ways)).toBe(screen)
  })
})

describe('requestEmailLink', () => {
  test('asks with the client’s app link and nothing else, and keeps the binding in memory only', async () => {
    const w = linked()
    const flow = await w.client.signIn.start({ identifier: 'maya@example.com' })
    const step = await requestEmailLink(w.client, flow)
    expect(step).toMatchObject({ prepared: { strategy: 'email_link' } })
    expect(w.api.calls(ROUTE.signInPrepare).map((request) => request.body)).toEqual([
      { strategy: 'email_link', redirectUrl: APP_LINK },
    ])
    expect(hostOf(w.client)?.linksKept()).toBe(1)
    expect(hostOf(w.client)?.linkKept(flow.id)).toBe(true)
    // No write to the secure store, of anything.
    expect(w.store.calls.filter((call) => call.operation === 'set')).toEqual([])
    expectNothingKept(w, step)
  })

  test('a client without the option is refused before any request', async () => {
    const w = world()
    w.api.on(ROUTE.signIn, () => started('sign_in', OFFERED))
    const flow = await w.client.signIn.start({ identifier: 'maya@example.com' })
    const requests = w.api.requests.length
    expect(await caught(requestEmailLink(w.client, flow))).toMatchObject({
      code: 'storage.failed',
      status: 0,
    })
    expect(
      await caught(flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: APP_LINK }))
    ).toMatchObject({ code: 'storage.failed' })
    expect(await caught(openEmailLink(w.client, flow, LINK))).toMatchObject({
      code: 'storage.failed',
    })
    expect(isEmailLink(w.client, LINK)).toBe(false)
    expect(isEmailLink({} as never, LINK)).toBe(false)
    expect(w.api.requests).toHaveLength(requests)
  })

  test('the server’s refusal of the app link is thrown as it is, and nothing is kept', async () => {
    const w = linked()
    w.api.on(ROUTE.signInPrepare, () => failure(403, 'request.redirect_not_allowed'))
    const flow = await w.client.signIn.start({ identifier: 'maya@example.com' })
    expect(await caught(requestEmailLink(w.client, flow))).toMatchObject({
      code: 'request.redirect_not_allowed',
      status: 403,
    })
    expect(hostOf(w.client)?.linksKept()).toBe(0)
  })
})

describe('openEmailLink', () => {
  test('the link, opened in the client that asked, is presented with its binding and the sign-in finishes', async () => {
    const w = linked()
    const flow = await asked(w)
    expect(isEmailLink(w.client, LINK)).toBe(true)
    const outcome = await openEmailLink(w.client, flow, LINK)
    expect(outcome).toMatchObject({ status: 'accepted', step: { status: 'complete' } })
    expect('failure' in outcome).toBe(false)
    // The token travels in a body, to one route, with the binding; the attempt's secret
    // does not travel with it.
    expect(w.api.calls(VERIFY).map((request) => request.body)).toEqual([
      { token: TOKEN, attemptId: 'attempt_1', binding: BINDING },
    ])
    expect(w.api.calls(VERIFY)[0]?.headers.get('x-tula-attempt')).toBeNull()
    expect(w.api.calls(ROUTE.signInAttempt).map((request) => request.body)).toEqual([
      { strategy: 'email_link' },
    ])
    expect(w.api.calls(ROUTE.signInAttempt)[0]?.headers.get('x-tula-attempt')).toBe(
      'tula_at_test_secret'
    )
    expect(w.client.state.status).toBe('signed-in')
    expect(w.storedToken()).toBe('rt_signed_in')
    // Nothing is left: no binding, no address.
    expect(hostOf(w.client)?.linksKept()).toBe(0)
    expect(hostOf(w.client)?.roundTrip).toBe(false)
    expect(await w.client.signIn.handleEmailLink()).toEqual({ status: 'none' })
    expectNothingKept(w, outcome)
  })

  // Every row is refused with no request: what a platform may hand an app is whatever
  // matched its association (a host, a path prefix), and only one URL is this client's.
  const refused: [string, unknown, 'unexpected_url' | 'no_link'][] = [
    ['another host', LINK.replace('app.example.com', 'evil.example.com'), 'unexpected_url'],
    ['a subdomain', LINK.replace('app.example.com', 'www.app.example.com'), 'unexpected_url'],
    [
      'a longer host',
      LINK.replace('app.example.com', 'app.example.com.evil.test'),
      'unexpected_url',
    ],
    ['another path', LINK.replace('/sign-in/link', '/sign-in/other'), 'unexpected_url'],
    ['a longer path', LINK.replace('/sign-in/link', '/sign-in/link/more'), 'unexpected_url'],
    ['a trailing slash', LINK.replace('/sign-in/link', '/sign-in/link/'), 'unexpected_url'],
    ['a shorter path', LINK.replace('/sign-in/link', '/sign-in'), 'unexpected_url'],
    ['a query before the fragment', LINK.replace('#', '?x=1#'), 'unexpected_url'],
    ['the link in a query', LINK.replace('#', '?'), 'unexpected_url'],
    ['an upper-case host', LINK.replace('app.example.com', 'APP.example.com'), 'unexpected_url'],
    ['an upper-case scheme', LINK.replace('https://', 'HTTPS://'), 'unexpected_url'],
    [
      'a default port written out',
      LINK.replace('app.example.com', 'app.example.com:443'),
      'unexpected_url',
    ],
    ['a user name', LINK.replace('https://', 'https://app.example.com@'), 'unexpected_url'],
    ['plain http', LINK.replace('https://', 'http://'), 'unexpected_url'],
    [
      'a custom scheme',
      LINK.replace('https://app.example.com', 'com.example.app:'),
      'unexpected_url',
    ],
    ['a dot segment', LINK.replace('/sign-in/link', '/sign-in/./link'), 'unexpected_url'],
    [
      'a percent-encoded letter',
      LINK.replace('/sign-in/link', '/sign-in/lin%6B'),
      'unexpected_url',
    ],
    ['a leading space', ` ${LINK}`, 'unexpected_url'],
    ['the app link alone', APP_LINK, 'unexpected_url'],
    ['an empty string', '', 'unexpected_url'],
    ['no string at all', undefined, 'unexpected_url'],
    ['an object with the link in it', { url: LINK }, 'unexpected_url'],
    ['an empty fragment', `${APP_LINK}#`, 'no_link'],
    ['a fragment with no token', `${APP_LINK}#tula_attempt=attempt_1`, 'no_link'],
    ['a fragment with no attempt', `${APP_LINK}#tula_link=${TOKEN}`, 'no_link'],
    ['an empty token', `${APP_LINK}#tula_link=&tula_attempt=attempt_1`, 'no_link'],
    ['an empty attempt', `${APP_LINK}#tula_link=${TOKEN}&tula_attempt=`, 'no_link'],
    ['a provider’s ticket', `${APP_LINK}#tula_ticket=${TOKEN}&tula_attempt=attempt_1`, 'no_link'],
  ]

  test.each(refused)(
    '%s is refused without a request, and spends nothing',
    async (_name, url, reason) => {
      const w = linked()
      const flow = await asked(w)
      const requests = w.api.requests.length
      expect(isEmailLink(w.client, url)).toBe(false)
      const outcome = await openEmailLink(w.client, flow, url as string)
      expect(outcome).toEqual({ status: 'refused', reason })
      expect(w.api.requests).toHaveLength(requests)
      expect(w.client.state.status).not.toBe('signed-in')
      // The binding is where it was: the real link still works.
      expect(hostOf(w.client)?.linkKept(flow.id)).toBe(true)
      expect(await openEmailLink(w.client, flow, LINK)).toMatchObject({
        status: 'accepted',
        step: { status: 'complete' },
      })
      expectNothingKept(w, outcome)
    }
  )

  test('a fragment that names the attempt twice is judged by the one the client would send', async () => {
    const w = linked()
    const flow = await asked(w)
    const requests = w.api.requests.length
    const twice = `${APP_LINK}#tula_attempt=attempt_2&tula_link=${TOKEN}&tula_attempt=attempt_1`
    expect(await openEmailLink(w.client, flow, twice)).toEqual({
      status: 'refused',
      reason: 'not_started_here',
    })
    expect(w.api.requests).toHaveLength(requests)
  })

  test('a link opened on another phone, or in another app, proves nothing and spends nothing', async () => {
    const w = linked()
    const flow = await asked(w)
    // The other phone: the same app, its own sign-in for the same address under way.
    const other = linked()
    const theirs = await asked(other)
    const requests = other.api.requests.length
    // The fake API names every attempt alike; a real one would not, and the id alone is
    // not what refuses: the other phone holds no binding the first one's server gave.
    const foreign = LINK.replace('attempt_1', 'attempt_9')
    expect(isEmailLink(other.client, foreign)).toBe(true)
    expect(await openEmailLink(other.client, theirs, foreign)).toEqual({
      status: 'refused',
      reason: 'not_started_here',
    })
    expect(other.api.requests).toHaveLength(requests)
    expect(other.client.state.status).not.toBe('signed-in')
    // A phone that asked for nothing at all.
    const idle = linked()
    const none = await idle.client.signIn.start({ identifier: 'maya@example.com' })
    const before = idle.api.requests.length
    expect(await openEmailLink(idle.client, none, LINK)).toEqual({
      status: 'refused',
      reason: 'not_started_here',
    })
    expect(idle.api.requests).toHaveLength(before)
    // Where it was asked for, the link still works.
    expect(await openEmailLink(w.client, flow, LINK)).toMatchObject({
      status: 'accepted',
      step: { status: 'complete' },
    })
  })

  test('a link of another sign-in of the same client is refused for the sign-in it is not', async () => {
    const w = linked()
    const flow = await asked(w)
    // A second sign-in in the same app, which the fake API gives another id.
    w.api.on(ROUTE.signIn, () =>
      json(200, {
        id: 'attempt_2',
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: OFFERED,
        attemptSecret: 'tula_at_second',
      })
    )
    const second = await w.client.signIn.start({ identifier: 'maya@example.com' })
    const requests = w.api.requests.length
    expect(await openEmailLink(w.client, second, LINK)).toEqual({
      status: 'refused',
      reason: 'not_started_here',
    })
    expect(w.api.requests).toHaveLength(requests)
    expect(hostOf(w.client)?.linkKept(flow.id)).toBe(true)
  })

  test('after the app is ended and started again the link is refused without a request: nothing was kept', async () => {
    const w = linked()
    await asked(w)
    // The same phone and secure store, a new process: a new client.
    const again = createExpoClient(
      {
        publishableKey: `tula_pk_dev_${'9'.repeat(30)}`,
        baseUrl: TEST_BASE_URL,
        fetch: w.api.fetch,
        emailLinkUrl: APP_LINK,
      },
      { platform: 'ios', secureStore: w.store }
    )
    w.api.on(ROUTE.signIn, () => started('sign_in', OFFERED))
    const flow = await again.signIn.start({ identifier: 'maya@example.com' })
    const requests = w.api.requests.length
    expect(hostOf(again)?.linksKept()).toBe(0)
    expect(await openEmailLink(again, flow, LINK)).toEqual({
      status: 'refused',
      reason: 'not_started_here',
    })
    expect(w.api.requests).toHaveLength(requests)
    // And the secure store never held anything of the link for the new process to find.
    expectNothingKept(w)
  })

  test('a binding is kept for fifteen minutes and not a moment longer, also when the clock is set back', async () => {
    const w = linked()
    const flow = await asked(w)
    setSystemTime(new Date(START + EMAIL_LINK_BINDING_TTL_MS - 1))
    expect(hostOf(w.client)?.linkKept(flow.id)).toBe(true)
    setSystemTime(new Date(START + EMAIL_LINK_BINDING_TTL_MS))
    const requests = w.api.requests.length
    expect(hostOf(w.client)?.linkKept(flow.id)).toBe(false)
    expect(hostOf(w.client)?.linksKept()).toBe(0)
    expect(await openEmailLink(w.client, flow, LINK)).toEqual({
      status: 'refused',
      reason: 'not_started_here',
    })
    expect(w.api.requests).toHaveLength(requests)

    const back = linked()
    const earlier = await asked(back)
    setSystemTime(new Date(START - EMAIL_LINK_BINDING_TTL_MS))
    expect(hostOf(back.client)?.linkKept(earlier.id)).toBe(false)
  })

  test('a link the server calls expired is `expired`, and the binding stays for the newer email’s link', async () => {
    const w = linked()
    const flow = await asked(w)
    w.api.on(VERIFY, () => failure(400, 'verification.expired'))
    const outcome = await openEmailLink(w.client, flow, LINK)
    expect(outcome).toEqual({ status: 'expired' })
    expect(w.api.calls(ROUTE.signInAttempt)).toEqual([])
    expect(w.client.state.status).not.toBe('signed-in')
    expect(hostOf(w.client)?.linkKept(flow.id)).toBe(true)
    expectNothingKept(w, outcome)
  })

  test('a link opened twice: the second time it is the server’s `expired`, or refused here once the sign-in is over', async () => {
    const w = linked()
    const flow = await asked(w)
    // Taken, with the sign-in not finished yet (the completing call got no answer).
    w.api.on(ROUTE.signInAttempt, () => failure(503, 'service.unavailable'))
    const first = await openEmailLink(w.client, flow, LINK)
    expect(first).toMatchObject({ status: 'accepted', failure: { code: 'service.unavailable' } })
    const requests = w.api.requests.length
    // The binding went with the acceptance: the same URL is no longer worth a request.
    expect(await openEmailLink(w.client, flow, LINK)).toEqual({
      status: 'refused',
      reason: 'not_started_here',
    })
    expect(w.api.requests).toHaveLength(requests)
  })

  test('a link the server says another client asked for is `not_started_here`, and nothing is finished', async () => {
    const w = linked()
    const flow = await asked(w)
    w.api.on(VERIFY, () => failure(403, 'verification.different_browser'))
    const outcome = await openEmailLink(w.client, flow, LINK)
    expect(outcome).toEqual({ status: 'refused', reason: 'not_started_here' })
    expect(w.api.calls(ROUTE.signInAttempt)).toEqual([])
    expect(w.client.state.status).not.toBe('signed-in')
  })

  test.each<[string, () => Response | Promise<Response>, string]>([
    ['no network', () => Promise.reject(new TypeError('Network request failed')), 'network.failed'],
    [
      'a rate limit',
      () => failure(429, 'rate_limited', {}, { 'retry-after': '30' }),
      'rate_limited',
    ],
    ['the method switched off', () => failure(403, 'auth.method_disabled'), 'auth.method_disabled'],
    ['a server error', () => failure(500, 'internal'), 'internal'],
  ])(
    '%s while the link is presented is thrown, and where the server did not take the link the same URL works again',
    async (_name, answer, code) => {
      const w = linked()
      const flow = await asked(w)
      w.api.on(VERIFY, answer)
      const thrown = await caught(openEmailLink(w.client, flow, LINK))
      expect(thrown.code).toBe(code)
      expect(w.api.calls(ROUTE.signInAttempt)).toEqual([])
      expect(hostOf(w.client)?.linkKept(flow.id)).toBe(true)
      expect(hostOf(w.client)?.roundTrip).toBe(false)
      // The address was cleared: the client has no link lying about.
      expect(await w.client.signIn.handleEmailLink()).toEqual({ status: 'none' })
      w.api.on(VERIFY, () => json(200, { status: 'verified' }))
      expect(await openEmailLink(w.client, flow, LINK)).toMatchObject({
        status: 'accepted',
        step: { status: 'complete' },
      })
      expectNothingKept(w, thrown)
    }
  )

  test('accepting a link signs nobody in: a sign-in that then asks for a second factor stays there', async () => {
    const w = linked()
    const flow = await asked(w)
    w.api.on(ROUTE.signInAttempt, () =>
      attempt('sign_in', { status: 'needs_second_factor', options: ['totp'] })
    )
    const outcome = await openEmailLink(w.client, flow, LINK)
    expect(outcome).toMatchObject({ status: 'accepted', step: { status: 'needs_second_factor' } })
    expect(w.client.state.status).not.toBe('signed-in')
    expect(w.storedToken()).toBeUndefined()
  })

  test('a link taken while the finishing call got no answer says so, and asking again finishes', async () => {
    const w = linked()
    const flow = await asked(w)
    w.api.on(ROUTE.signInAttempt, () => Promise.reject(new TypeError('Network request failed')))
    const outcome = await openEmailLink(w.client, flow, LINK)
    expect(outcome).toMatchObject({
      status: 'accepted',
      step: { status: 'needs_first_factor' },
      failure: { code: 'network.failed' },
    })
    expect(w.client.state.status).not.toBe('signed-in')
    w.api.on(ROUTE.signInAttempt, () => completed('sign_in'))
    expect(await flow.attemptFirstFactor({ strategy: 'email_link' })).toMatchObject({
      status: 'complete',
    })
    expect(w.client.state.status).toBe('signed-in')
    expect(w.api.calls(VERIFY)).toHaveLength(1)
    expectNothingKept(w, outcome)
  })

  test('a sign-in that is left takes its binding with it', async () => {
    const w = linked()
    const flow = await asked(w)
    flow.discard()
    const requests = w.api.requests.length
    expect(hostOf(w.client)?.linksKept()).toBe(0)
    expect(await openEmailLink(w.client, flow, LINK)).toEqual({
      status: 'refused',
      reason: 'not_started_here',
    })
    expect(w.api.requests).toHaveLength(requests)
  })

  test('one at a time: a link is not opened while a provider’s round trip or another link has the client’s address', async () => {
    // A browser that stays open until the test closes it, and says when it was opened.
    let opened = () => {}
    const isOpen = new Promise<void>((resolve) => {
      opened = resolve
    })
    let close = () => {}
    const closed = new Promise<null>((resolve) => {
      close = () => resolve(null)
    })
    const browser: BrowserSession = {
      open() {
        opened()
        return closed
      },
    }
    const w = linked({ client: { browser } })
    w.api.on('POST /v1/client/sign-ins/oauth', () =>
      json(200, {
        attempt: {
          id: 'attempt_o',
          kind: 'sign_in',
          expiresAt: '2030-01-01T00:10:00.000Z',
          step: { status: 'needs_first_factor', strategies: ['oauth_google'] },
          attemptSecret: 'tula_at_oauth',
        },
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s',
        binding: 'tula_ob_round-trip',
      })
    )
    const flow = await asked(w)
    const trip = signInWithProvider(w.client, {
      provider: 'google',
      redirectUrl: 'com.example.app:/oauth/callback',
    })
    await isOpen
    expect(await caught(openEmailLink(w.client, flow, LINK))).toMatchObject({ code: 'flow.busy' })
    expect(w.api.calls(VERIFY)).toEqual([])
    expect(hostOf(w.client)?.linkKept(flow.id)).toBe(true)
    close()
    expect(await trip).toMatchObject({ status: 'cancelled' })

    // Two openings of one link at once: one has the address, the other is told to wait.
    const both = await Promise.allSettled([
      openEmailLink(w.client, flow, LINK),
      openEmailLink(w.client, flow, LINK),
    ])
    expect(both[0]).toMatchObject({ status: 'fulfilled', value: { status: 'accepted' } })
    expect(both[1]).toMatchObject({ status: 'rejected', reason: { code: 'flow.busy' } })
    expect(w.api.calls(VERIFY)).toHaveLength(1)
    expect(hostOf(w.client)?.roundTrip).toBe(false)
  })

  test('a secure store that fails is not a signed-out phone, and has no part in a link', async () => {
    const w = linked({ signedIn: true })
    w.store.fail('get', new Error('the keychain is locked'))
    const flow = await asked(w)
    w.api.on(ROUTE.signInAttempt, () =>
      attempt('sign_in', { status: 'needs_second_factor', options: ['totp'] })
    )
    const outcome = await openEmailLink(w.client, flow, LINK)
    // The link was presented and taken although the store cannot be read.
    expect(outcome).toMatchObject({ status: 'accepted', step: { status: 'needs_second_factor' } })
    // The stored session is not written off for it: the token is where it was.
    expect(w.client.state.status).not.toBe('signed-out')
    expect(w.storedToken()).toBe('rt_0')
    expect(w.store.calls.filter((call) => call.operation !== 'get')).toEqual([])
  })
})

describe('useSignIn, with an emailed link', () => {
  async function prepared(w: World) {
    const { result } = w.render(() => useSignIn())
    await act(async () => {
      await result.current.start({ identifier: 'maya@example.com' })
    })
    expect(result.current.screen).toBe('needs_first_factor')
    await act(async () => {
      await result.current.prepareFirstFactor({ strategy: 'email_link' })
    })
    expect(result.current.error).toBeNull()
    return result
  }

  test('asks for the link with the client’s app link, opens it and signs in', async () => {
    const w = linked()
    const result = await prepared(w)
    expect(w.api.calls(ROUTE.signInPrepare)[0]?.body).toEqual({
      strategy: 'email_link',
      redirectUrl: APP_LINK,
    })
    let step: unknown
    await act(async () => {
      step = await result.current.openEmailLink(LINK)
    })
    expect(step).toMatchObject({ status: 'complete' })
    expect(result.current).toMatchObject({ screen: 'complete', error: null, isPending: false })
    expect(w.client.state.status).toBe('signed-in')
    expectNothingKept(w, result.current.step, result.current.error)
  })

  test('a step that offers only a link is a screen for a client with the app link, and `not_supported` without', async () => {
    const only = { status: 'needs_first_factor', strategies: ['email_link'] }
    const w = linked()
    w.api.on(ROUTE.signIn, () => started('sign_in', only))
    const { result } = w.render(() => useSignIn())
    await act(async () => {
      await result.current.start({ identifier: 'maya@example.com' })
    })
    expect(result.current.screen).toBe('needs_first_factor')

    const plain = world()
    plain.api.on(ROUTE.signIn, () => started('sign_in', only))
    const without = plain.render(() => useSignIn())
    await act(async () => {
      await without.result.current.start({ identifier: 'maya@example.com' })
    })
    expect(without.result.current.screen).toBe('not_supported')
    const requests = plain.api.requests.length
    await act(async () => {
      await without.result.current.prepareFirstFactor({ strategy: 'email_link' })
    })
    expect(without.result.current.error).toMatchObject({ code: 'storage.failed' })
    expect(plain.api.requests).toHaveLength(requests)
  })

  test('a URL that is not an emailed link is none of the hook’s business: null, no error, no request', async () => {
    const w = linked()
    const result = await prepared(w)
    const requests = w.api.requests.length
    for (const url of ['https://app.example.com/products/7', `${APP_LINK}#tab=2`, APP_LINK, '']) {
      let step: unknown = 'unset'
      await act(async () => {
        step = await result.current.openEmailLink(url)
      })
      expect(step).toBeNull()
      expect(result.current).toMatchObject({ error: null, isPending: false, dismissed: false })
    }
    expect(w.api.requests).toHaveLength(requests)
  })

  test('a link nobody here asked for is `verification.different_browser` without a request: no sign-in under way, or another one', async () => {
    const w = linked()
    const { result } = w.render(() => useSignIn())
    let step: unknown = 'unset'
    await act(async () => {
      step = await result.current.openEmailLink(LINK)
    })
    expect(step).toBeNull()
    expect(result.current.error).toMatchObject({
      code: 'verification.different_browser',
      status: 0,
    })
    expect(w.api.requests).toEqual([])

    const other = linked()
    const theirs = await prepared(other)
    const requests = other.api.requests.length
    await act(async () => {
      await theirs.current.openEmailLink(LINK.replace('attempt_1', 'attempt_9'))
    })
    expect(theirs.current.error).toMatchObject({ code: 'verification.different_browser' })
    expect(theirs.current.screen).toBe('needs_first_factor')
    expect(other.api.requests).toHaveLength(requests)
    expectNothingKept(other, theirs.current.error)
  })

  test('an expired link is `verification.expired`, and the code field is still the way', async () => {
    const w = linked()
    const result = await prepared(w)
    w.api.on(VERIFY, () => failure(400, 'verification.expired'))
    await act(async () => {
      await result.current.openEmailLink(LINK)
    })
    expect(result.current.error).toMatchObject({ code: 'verification.expired' })
    expect(result.current.screen).toBe('needs_first_factor')
    w.api.on(ROUTE.signInAttempt, () => completed('sign_in'))
    await act(async () => {
      await result.current.attemptFirstFactor({ strategy: 'email_code', code: '123456' })
    })
    expect(result.current.screen).toBe('complete')
  })

  test('a link taken while the finishing call failed leaves that error, and finishEmailLink asks again', async () => {
    const w = linked()
    const result = await prepared(w)
    w.api.on(ROUTE.signInAttempt, () => Promise.reject(new TypeError('Network request failed')))
    await act(async () => {
      await result.current.openEmailLink(LINK)
    })
    expect(result.current.error).toMatchObject({ code: 'network.failed' })
    expect(result.current.screen).toBe('needs_first_factor')
    w.api.on(ROUTE.signInAttempt, () => completed('sign_in'))
    let step: unknown
    await act(async () => {
      step = await result.current.finishEmailLink()
    })
    expect(step).toMatchObject({ status: 'complete' })
    expect(w.api.calls(VERIFY)).toHaveLength(1)
    expect(w.client.state.status).toBe('signed-in')
  })

  test('a link the server took while its answer was lost is the hook’s `network.failed`, then `verification.expired`, and finishEmailLink signs in', async () => {
    const w = linked()
    const result = await prepared(w)
    // The fake API as the real one behaves: the link is spent by the request whose answer
    // is lost, and the attempt completes only once it was taken.
    let taken = false
    w.api.on(VERIFY, () => {
      if (taken) {
        return failure(410, 'verification.expired')
      }
      taken = true
      return Promise.reject(new TypeError('Network request failed'))
    })
    w.api.on(ROUTE.signInAttempt, () =>
      taken
        ? completed('sign_in')
        : attempt('sign_in', {
            ...OFFERED,
            prepared: { strategy: 'email_link', destination: 'm***@example.com' },
          })
    )
    await act(async () => {
      await result.current.openEmailLink(LINK)
    })
    expect(result.current.error).toMatchObject({ code: 'network.failed' })
    // Nothing was asked on a guess: the flow was not asked to finish.
    expect(w.api.calls(ROUTE.signInAttempt)).toEqual([])
    await act(async () => {
      await result.current.openEmailLink(LINK)
    })
    expect(result.current.error).toMatchObject({ code: 'verification.expired' })
    expect(result.current.screen).toBe('needs_first_factor')
    expect(w.api.calls(ROUTE.signInAttempt)).toEqual([])
    let step: unknown
    await act(async () => {
      step = await result.current.finishEmailLink()
    })
    expect(step).toMatchObject({ status: 'complete' })
    expect(result.current).toMatchObject({ screen: 'complete', error: null })
    expect(w.client.state.status).toBe('signed-in')
    expectNothingKept(w, result.current.error)
  })

  test('finishEmailLink for a link nobody opened changes nothing and is no error', async () => {
    const w = linked()
    const result = await prepared(w)
    const waiting = attempt('sign_in', {
      ...OFFERED,
      prepared: { strategy: 'email_link', destination: 'm***@example.com' },
    })
    w.api.on(ROUTE.signInAttempt, () => waiting.clone())
    let step: unknown
    await act(async () => {
      step = await result.current.finishEmailLink()
    })
    expect(step).toMatchObject({ status: 'needs_first_factor' })
    expect(result.current).toMatchObject({ screen: 'needs_first_factor', error: null })
    expect(w.api.calls(VERIFY)).toEqual([])
    expect(hostOf(w.client)?.linkKept('attempt_1')).toBe(true)
  })

  test('a failure while the link is presented is the hook’s error, and where the server did not take the link the same URL can be opened again', async () => {
    const w = linked()
    const result = await prepared(w)
    w.api.on(VERIFY, () => Promise.reject(new TypeError('Network request failed')))
    await act(async () => {
      await result.current.openEmailLink(LINK)
    })
    expect(result.current.error).toMatchObject({ code: 'network.failed' })
    w.api.on(VERIFY, () => json(200, { status: 'verified' }))
    await act(async () => {
      await result.current.openEmailLink(LINK)
    })
    expect(result.current).toMatchObject({ screen: 'complete', error: null })
  })

  test('reset leaves the sign-in, and its link is nobody’s after that', async () => {
    const w = linked()
    const result = await prepared(w)
    act(() => result.current.reset())
    const requests = w.api.requests.length
    await act(async () => {
      await result.current.openEmailLink(LINK)
    })
    expect(result.current.error).toMatchObject({ code: 'verification.different_browser' })
    expect(w.api.requests).toHaveLength(requests)
    expect(hostOf(w.client)?.linksKept()).toBe(0)
  })
})
