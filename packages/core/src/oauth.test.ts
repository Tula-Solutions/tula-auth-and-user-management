import { describe, expect, test } from 'bun:test'
import { createClient } from './client'
import { isTulaError, type TulaError } from './errors'
import {
  createOAuthStore,
  OAUTH_BINDING_TTL_MS,
  OAUTH_STORAGE_PREFIX,
  readOAuthFragment,
} from './oauth'
import {
  type FakeApi,
  type FakeLinkStorage,
  type FakePage,
  failure,
  fakeApi,
  fakeEnvironment,
  fakeLinkStorage,
  fakePage,
  json,
  type ManualClock,
  manualClock,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
} from './testing/fakes'
import type { FlowStep } from './types'

const ATTEMPT = '0190d7a0-0000-7000-8000-000000000001'
const BINDING = 'tula_ob_b1nd1ng-of-the-tab'
const TICKET = 'tula_ot_t1ck3t'
const SECRET = 'tula_at_fresh-secret-after-exchange'
const APP = 'https://app.test/oauth/callback'
const PROVIDER_URL = 'https://accounts.google.com/o/oauth2/v2/auth?state=s&client_id=c'
const SCOPE = `${TEST_BASE_URL}|${TEST_KEY}`
const KEY = `${OAUTH_STORAGE_PREFIX}${ATTEMPT}`
const START = 'POST /v1/client/sign-ins/oauth'
const EXCHANGE = 'POST /v1/client/sign-ins/oauth/exchange'
const LINK_START = 'POST /v1/client/me/identities/oauth'
const LINK_EXCHANGE = 'POST /v1/client/me/identities/oauth/exchange'
const IDENTITY = { id: 'identity_1', provider: 'google', createdAt: '2026-01-01T00:00:00.000Z' }

interface Browser {
  api: FakeApi
  clock: ManualClock
  /** The tab's `sessionStorage`: it survives the navigation to the provider and back. */
  storage: FakeLinkStorage
}

function browser(): Browser {
  const api = fakeApi()
  api.on('GET /v1/client/me', () => json(200, TEST_USER))
  return { api, clock: manualClock(), storage: fakeLinkStorage() }
}

/** A page of the tab: the one that starts, or the one the provider's round trip ends on. */
function page(shared: Browser, url: string, options: { storage?: boolean; page?: boolean } = {}) {
  const current: FakePage | undefined = options.page === false ? undefined : fakePage(url)
  const tula = createClient(
    { publishableKey: TEST_KEY, baseUrl: TEST_BASE_URL, client: 'web', fetch: shared.api.fetch },
    fakeEnvironment(shared.clock, {
      tabStorage: options.storage === false ? undefined : shared.storage,
      page: current,
    })
  )
  return { tula, page: current as FakePage }
}

const expiry = (clock: ManualClock) => new Date(clock.now() + 600_000).toISOString()
const attempt = (shared: Browser, step: object, extra: object = {}) => ({
  id: ATTEMPT,
  kind: 'sign_in',
  expiresAt: expiry(shared.clock),
  step,
  ...extra,
})
const started = (shared: Browser) => ({
  attempt: attempt(
    shared,
    { status: 'needs_first_factor', strategies: ['oauth_google'] },
    { attemptSecret: 'tula_at_lost-with-the-navigation' }
  ),
  authorizationUrl: PROVIDER_URL,
  binding: BINDING,
})

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

/** Start a sign-in on one page; return the page the round trip ends on. */
async function roundTrip(
  shared: Browser,
  fragment = `tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`
) {
  shared.api.on(START, () => json(200, started(shared)))
  const first = page(shared, 'https://app.test/sign-in')
  await first.tula.signIn.withOAuth({ provider: 'google', redirectUrl: APP })
  return { first, landing: page(shared, `${APP}#${fragment}`) }
}

describe('the OAuth binding store', () => {
  test('keeps a binding and its intent under the attempt id until it is removed', () => {
    const clock = manualClock()
    const storage = fakeLinkStorage()
    const store = createOAuthStore({ tabStorage: storage, now: clock.now }, SCOPE)
    expect(store.available()).toBe(true)
    expect(store.read(ATTEMPT)).toBeNull()
    expect(store.save(ATTEMPT, BINDING, 'link')).toBe(true)
    expect([...storage.entries.keys()]).toEqual([KEY])
    expect(store.read(ATTEMPT)).toEqual({ binding: BINDING, intent: 'link' })
    store.remove(ATTEMPT)
    expect(storage.entries.size).toBe(0)
  })

  test('holds the binding and nothing token-like', () => {
    const clock = manualClock()
    const storage = fakeLinkStorage()
    createOAuthStore({ tabStorage: storage, now: clock.now }, SCOPE).save(
      ATTEMPT,
      BINDING,
      'sign_in'
    )
    expect(JSON.parse(storage.entries.get(KEY) ?? '')).toEqual({
      b: BINDING,
      e: clock.now() + OAUTH_BINDING_TTL_MS,
      s: SCOPE,
      k: 'sign_in',
    })
  })

  test('an entry expires on the device’s clock, and expired or unreadable entries are pruned', () => {
    const clock = manualClock()
    const storage = fakeLinkStorage()
    const store = createOAuthStore({ tabStorage: storage, now: clock.now }, SCOPE)
    store.save(ATTEMPT, BINDING, 'sign_in')
    storage.entries.set(`${OAUTH_STORAGE_PREFIX}junk`, '{not json')
    storage.entries.set('someone-elses-key', 'kept')
    clock.advance(OAUTH_BINDING_TTL_MS - 1)
    expect(store.read(ATTEMPT)?.binding).toBe(BINDING)
    clock.advance(1)
    expect(store.read(ATTEMPT)).toBeNull()
    expect([...storage.entries.keys()]).toEqual(['someone-elses-key'])
  })

  test('another client’s entry, or one of an unknown intent, is not read', () => {
    const clock = manualClock()
    const storage = fakeLinkStorage()
    createOAuthStore({ tabStorage: storage, now: clock.now }, 'another|scope').save(
      ATTEMPT,
      BINDING,
      'sign_in'
    )
    const store = createOAuthStore({ tabStorage: storage, now: clock.now }, SCOPE)
    expect(store.read(ATTEMPT)).toBeNull()
    storage.entries.set(
      KEY,
      JSON.stringify({ b: BINDING, e: clock.now() + 1000, s: SCOPE, k: 'x' })
    )
    expect(store.read(ATTEMPT)).toBeNull()
  })

  test('without storage, or with storage that throws, nothing is available and nothing throws', () => {
    const clock = manualClock()
    const none = createOAuthStore({ tabStorage: undefined, now: clock.now }, SCOPE)
    expect(none.available()).toBe(false)
    expect(none.save(ATTEMPT, BINDING, 'sign_in')).toBe(false)
    expect(none.read(ATTEMPT)).toBeNull()
    none.remove(ATTEMPT)
    const storage = fakeLinkStorage()
    storage.failing = true
    const failing = createOAuthStore({ tabStorage: storage, now: clock.now }, SCOPE)
    expect(failing.available()).toBe(false)
    expect(failing.save(ATTEMPT, BINDING, 'sign_in')).toBe(false)
    expect(failing.read(ATTEMPT)).toBeNull()
    failing.remove(ATTEMPT)
  })
})

describe('readOAuthFragment', () => {
  test.each([
    ['no fragment', APP],
    ['an unrelated fragment', `${APP}#section-2`],
    ['an emailed link’s fragment', `${APP}#tula_link=abc&tula_attempt=${ATTEMPT}`],
    ['an empty ticket', `${APP}#tula_ticket=&tula_attempt=${ATTEMPT}`],
  ])('%s is not an OAuth answer', (_name, url) => {
    expect(readOAuthFragment(url)).toBeNull()
  })

  test('reads a ticket or an error, and leaves the rest of the URL as it was', () => {
    expect(
      readOAuthFragment(`${APP}?tab=1#keep=1&tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`)
    ).toEqual({
      attemptId: ATTEMPT,
      ticket: TICKET,
      error: null,
      cleanUrl: `${APP}?tab=1#keep=1`,
    })
    expect(
      readOAuthFragment(`${APP}#tula_error=oauth.access_denied&tula_attempt=${ATTEMPT}`)
    ).toEqual({
      attemptId: ATTEMPT,
      ticket: null,
      error: 'oauth.access_denied',
      cleanUrl: APP,
    })
    // A ticket wins over an error, and a missing attempt id is empty, not a crash.
    expect(readOAuthFragment(`${APP}#tula_error=x&tula_ticket=t`)).toMatchObject({
      ticket: 't',
      error: null,
      attemptId: '',
    })
  })
})

describe('signIn.withOAuth', () => {
  test('asks for the provider URL, keeps only the binding for the tab, and navigates there', async () => {
    const shared = browser()
    shared.api.on(START, () => json(200, started(shared)))
    const { tula, page: current } = page(shared, 'https://app.test/sign-in')
    expect(tula.signIn.canUseOAuth()).toBe(true)
    const result = await tula.signIn.withOAuth({ provider: 'google', redirectUrl: APP })
    expect(result).toEqual({ url: PROVIDER_URL })
    expect(current.assigned).toEqual([PROVIDER_URL])
    expect(shared.api.calls(START)[0]?.body).toEqual({ provider: 'google', redirectUrl: APP })
    expect([...shared.storage.entries.keys()]).toEqual([KEY])
    const kept = shared.storage.entries.get(KEY) ?? ''
    expect(kept).toContain(BINDING)
    // The attempt's secret is not kept anywhere: it is lost with the navigation, by design.
    expect(kept).not.toContain('tula_at_')
    expect(tula.state.status).not.toBe('signed-in')
  })

  test('`navigate: false` hands the URL back and goes nowhere', async () => {
    const shared = browser()
    shared.api.on(START, () => json(200, started(shared)))
    const { tula, page: current } = page(shared, 'https://app.test/sign-in')
    expect(
      await tula.signIn.withOAuth({ provider: 'google', redirectUrl: APP, navigate: false })
    ).toEqual({ url: PROVIDER_URL })
    expect(current.assigned).toEqual([])
    expect(shared.storage.entries.has(KEY)).toBe(true)
  })

  test('is refused before any request when the tab cannot keep the binding', async () => {
    const shared = browser()
    const { tula } = page(shared, 'https://app.test/sign-in', { storage: false })
    expect(tula.signIn.canUseOAuth()).toBe(false)
    const error = await caught(tula.signIn.withOAuth({ provider: 'google', redirectUrl: APP }))
    expect(error.code).toBe('storage.failed')
    expect(shared.api.requests).toHaveLength(0)
  })

  test('is refused before any request for a page on another origin', async () => {
    const shared = browser()
    const { tula } = page(shared, 'https://app.test/sign-in')
    for (const redirectUrl of [
      'https://other.test/oauth/callback',
      'http://app.test/oauth/callback',
      'not a url',
    ]) {
      const error = await caught(tula.signIn.withOAuth({ provider: 'google', redirectUrl }))
      expect(error.code).toBe('link.cross_origin')
    }
    expect(shared.api.requests).toHaveLength(0)
    expect(shared.storage.entries.size).toBe(0)
  })

  test('where there is no page nothing is checked or navigated: the caller gets the URL', async () => {
    const shared = browser()
    shared.api.on(START, () => json(200, started(shared)))
    const { tula } = page(shared, '', { page: false })
    expect(await tula.signIn.withOAuth({ provider: 'google', redirectUrl: APP })).toEqual({
      url: PROVIDER_URL,
    })
  })

  test.each([
    ['no binding', { binding: undefined }],
    ['no attempt', { attempt: undefined }],
    ['an attempt without an id', { attempt: {} }],
    ['a URL that is not http(s)', { authorizationUrl: 'javascript:alert(1)' }],
    ['no URL', { authorizationUrl: undefined }],
  ] as [string, object][])(
    'an answer with %s is not used: nothing is kept and the page stays',
    async (_name, broken) => {
      const shared = browser()
      shared.api.on(START, () => json(200, { ...started(shared), ...broken }))
      const { tula, page: current } = page(shared, 'https://app.test/sign-in')
      const error = await caught(tula.signIn.withOAuth({ provider: 'google', redirectUrl: APP }))
      expect(error.code).toBe('response.invalid')
      expect(current.assigned).toEqual([])
      expect(shared.storage.entries.size).toBe(0)
    }
  )

  test('the API’s refusal is the caller’s, and nothing is kept', async () => {
    const shared = browser()
    shared.api.on(START, () => failure(403, 'auth.method_disabled'))
    const { tula, page: current } = page(shared, 'https://app.test/sign-in')
    const error = await caught(tula.signIn.withOAuth({ provider: 'github', redirectUrl: APP }))
    expect(error.code).toBe('auth.method_disabled')
    expect(current.assigned).toEqual([])
    expect(shared.storage.entries.size).toBe(0)
  })

  test('storage that fails between the check and the save refuses the round trip', async () => {
    const shared = browser()
    shared.api.on(START, () => {
      shared.storage.failing = true
      return json(200, started(shared))
    })
    const { tula, page: current } = page(shared, 'https://app.test/sign-in')
    const error = await caught(tula.signIn.withOAuth({ provider: 'google', redirectUrl: APP }))
    expect(error.code).toBe('storage.failed')
    expect(current.assigned).toEqual([])
  })
})

describe('signIn.handleOAuthCallback', () => {
  test('without an OAuth answer in the address it does nothing', async () => {
    const shared = browser()
    for (const url of [APP, `${APP}#tula_link=x&tula_attempt=${ATTEMPT}`]) {
      const { tula, page: current } = page(shared, url)
      expect(await tula.signIn.handleOAuthCallback()).toEqual({ status: 'none' })
      expect(current.replaced).toEqual([])
    }
    expect(await page(shared, '', { page: false }).tula.signIn.handleOAuthCallback()).toEqual({
      status: 'none',
    })
    expect(shared.api.requests).toHaveLength(0)
  })

  test('removes the ticket from the address before it sends anything, then signs in', async () => {
    const shared = browser()
    const { landing } = await roundTrip(shared)
    let addressWhenSent = ''
    shared.api.on(EXCHANGE, () => {
      addressWhenSent = landing.page.current
      return json(
        200,
        attempt(
          shared,
          { status: 'complete', userId: TEST_USER.id, sessionId: 'session_1' },
          { session: sessionTokens('one') }
        )
      )
    })
    const outcome = await landing.tula.signIn.handleOAuthCallback()
    expect(addressWhenSent).toBe(APP)
    expect(landing.page.current).toBe(APP)
    expect(outcome.status).toBe('complete')
    expect(outcome.status === 'complete' && outcome.flow.step.status).toBe('complete')
    expect(landing.tula.state.status).toBe('signed-in')
    const [request] = shared.api.calls(EXCHANGE)
    expect(request?.body).toEqual({ ticket: TICKET, attemptId: ATTEMPT, binding: BINDING })
    // The ticket travels in the body only.
    expect(shared.api.requests.every((sent) => !sent.path.includes(TICKET))).toBe(true)
    // Nothing is left in the tab's storage.
    expect(shared.storage.entries.size).toBe(0)
  })

  test('a user with a second factor gets a flow positioned on that step, with the new secret', async () => {
    const shared = browser()
    const { landing } = await roundTrip(shared)
    const step: FlowStep = { status: 'needs_second_factor', options: ['totp', 'backup_code'] }
    shared.api.on(EXCHANGE, () => json(200, attempt(shared, step, { attemptSecret: SECRET })))
    shared.api.on(`POST /v1/client/sign-ins/${ATTEMPT}/second-factor`, () =>
      json(
        200,
        attempt(
          shared,
          { status: 'complete', userId: TEST_USER.id, sessionId: 'session_1' },
          { session: sessionTokens('one') }
        )
      )
    )
    const outcome = await landing.tula.signIn.handleOAuthCallback()
    expect(outcome.status).toBe('needs_step')
    if (outcome.status !== 'needs_step') {
      throw new Error('expected a flow')
    }
    expect(outcome.flow.step).toEqual(step)
    expect(landing.tula.state.status).not.toBe('signed-in')
    // The flow never shows its secret.
    expect(JSON.stringify(outcome.flow)).not.toContain(SECRET)
    expect(
      (await outcome.flow.submitSecondFactor({ method: 'totp', code: '123456' })).step.status
    ).toBe('complete')
    const [sent] = shared.api.calls(`POST /v1/client/sign-ins/${ATTEMPT}/second-factor`)
    expect(sent?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(landing.tula.state.status).toBe('signed-in')
  })

  test('called twice at once (an effect run twice), the ticket is exchanged once', async () => {
    const shared = browser()
    const { landing } = await roundTrip(shared)
    shared.api.on(EXCHANGE, () =>
      json(
        200,
        attempt(
          shared,
          { status: 'complete', userId: TEST_USER.id, sessionId: 's' },
          { session: sessionTokens('one') }
        )
      )
    )
    const [first, second] = await Promise.all([
      landing.tula.signIn.handleOAuthCallback(),
      landing.tula.signIn.handleOAuthCallback(),
    ])
    expect(first).toBe(second)
    expect(shared.api.calls(EXCHANGE)).toHaveLength(1)
    // Afterwards the address is clean: a later call finds nothing.
    expect(await landing.tula.signIn.handleOAuthCallback()).toEqual({ status: 'none' })
  })

  test('a browser that did not start the sign-in sends nothing and completes nothing', async () => {
    const shared = browser()
    const stranger = page(shared, `${APP}#tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`)
    expect(await stranger.tula.signIn.handleOAuthCallback()).toEqual({
      status: 'different_browser',
    })
    expect(shared.api.requests).toHaveLength(0)
    expect(stranger.page.current).toBe(APP)
    expect(stranger.tula.state.status).not.toBe('signed-in')
  })

  test('the server’s “different browser” is reported as such, and what was kept is removed', async () => {
    const shared = browser()
    const { landing } = await roundTrip(shared)
    shared.api.on(EXCHANGE, () => failure(409, 'oauth.different_browser'))
    expect(await landing.tula.signIn.handleOAuthCallback()).toEqual({ status: 'different_browser' })
    expect(shared.storage.entries.size).toBe(0)
  })

  test.each([
    ['oauth.access_denied', 'oauth.access_denied'],
    ['oauth.provider_error', 'oauth.provider_error'],
    ['oauth.state_invalid', 'oauth.state_invalid'],
    // Anything the contract does not define is not passed on as it came.
    ['<img src=x onerror=alert(1)>', 'oauth.provider_error'],
    ['constructor', 'oauth.provider_error'],
  ])('an error %p in the address is reported as %p, without a request', async (inAddress, code) => {
    const shared = browser()
    const { landing } = await roundTrip(
      shared,
      `tula_error=${encodeURIComponent(inAddress)}&tula_attempt=${ATTEMPT}`
    )
    const requests = shared.api.requests.length
    const outcome = await landing.tula.signIn.handleOAuthCallback()
    expect(outcome).toMatchObject({ status: 'error', code })
    expect(outcome.status === 'error' && outcome.message.length).toBeGreaterThan(10)
    expect(shared.api.requests).toHaveLength(requests)
    expect(landing.page.current).toBe(APP)
    expect(shared.storage.entries.size).toBe(0)
  })

  test.each([
    [409, 'oauth.account_exists'],
    [403, 'oauth.email_unverified'],
    [410, 'oauth.ticket_invalid'],
    [403, 'auth.user_banned'],
  ] as [number, string][])(
    'a refusal (%p %p) is an outcome with its code and message',
    async (status, code) => {
      const shared = browser()
      const { landing } = await roundTrip(shared)
      shared.api.on(EXCHANGE, () => failure(status, code as never))
      const outcome = await landing.tula.signIn.handleOAuthCallback()
      expect(outcome).toMatchObject({ status: 'error', code })
      expect(landing.tula.state.status).not.toBe('signed-in')
      expect(shared.storage.entries.size).toBe(0)
    }
  )

  test('a request that got no answer, or a rate limit, is thrown; the binding is gone with the ticket', async () => {
    const shared = browser()
    const { landing } = await roundTrip(shared)
    shared.api.on(EXCHANGE, () => {
      throw new TypeError('fetch failed')
    })
    expect((await caught(landing.tula.signIn.handleOAuthCallback())).code).toBe('network.failed')
    expect(shared.storage.entries.size).toBe(0)

    const again = await roundTrip(shared)
    shared.api.on(EXCHANGE, () => failure(429, 'rate_limited'))
    expect((await caught(again.landing.tula.signIn.handleOAuthCallback())).code).toBe(
      'rate_limited'
    )
  })

  test('an answer that is not an attempt signs nobody in', async () => {
    const shared = browser()
    const { landing } = await roundTrip(shared)
    shared.api.on(EXCHANGE, () => json(200, { step: { status: 'complete' } }))
    expect((await caught(landing.tula.signIn.handleOAuthCallback())).code).toBe('response.invalid')
    expect(landing.tula.state.status).not.toBe('signed-in')
    const next = await roundTrip(shared)
    // A step that continues but carries no secret cannot be continued.
    shared.api.on(EXCHANGE, () =>
      json(200, attempt(shared, { status: 'needs_second_factor', options: ['totp'] }))
    )
    expect((await caught(next.landing.tula.signIn.handleOAuthCallback())).code).toBe(
      'response.invalid'
    )
  })

  test('an address that cannot be rewritten does not stop the exchange', async () => {
    const shared = browser()
    const { landing } = await roundTrip(shared)
    landing.page.replaceUrl = () => {
      throw new DOMException('sandboxed', 'SecurityError')
    }
    shared.api.on(EXCHANGE, () =>
      json(
        200,
        attempt(
          shared,
          { status: 'complete', userId: TEST_USER.id, sessionId: 's' },
          { session: sessionTokens('one') }
        )
      )
    )
    expect((await landing.tula.signIn.handleOAuthCallback()).status).toBe('complete')
  })
})

describe('user.identities', () => {
  /** A signed-in tab. */
  async function signedIn(shared: Browser, url: string) {
    shared.api.on('POST /v1/client/sign-ins', () =>
      json(
        200,
        attempt(
          shared,
          { status: 'complete', userId: TEST_USER.id, sessionId: 'session_1' },
          { session: sessionTokens('one'), attemptSecret: 'tula_at_x' }
        )
      )
    )
    const opened = page(shared, url)
    await opened.tula.signIn.start({ identifier: 'maya@northline.app' })
    expect(opened.tula.state.status).toBe('signed-in')
    return opened
  }
  const linkStarted = (shared: Browser) => ({
    attemptId: ATTEMPT,
    expiresAt: expiry(shared.clock),
    authorizationUrl: PROVIDER_URL,
    binding: BINDING,
  })

  test('lists the connected accounts with the access token', async () => {
    const shared = browser()
    shared.api.on('GET /v1/client/me/identities', () => json(200, { data: [IDENTITY] }))
    const { tula } = await signedIn(shared, 'https://app.test/account')
    expect(await tula.user.identities.list()).toEqual([IDENTITY])
    expect(
      shared.api.calls('GET /v1/client/me/identities')[0]?.headers.get('authorization')
    ).toMatch(/^Bearer /)
    shared.api.on('GET /v1/client/me/identities', () => json(200, { data: [{ id: 1 }] }))
    expect((await caught(tula.user.identities.list())).code).toBe('response.invalid')
  })

  test('link keeps the binding as a link and navigates; the callback connects the account', async () => {
    const shared = browser()
    shared.api.on(LINK_START, () => json(200, linkStarted(shared)))
    shared.api.on(LINK_EXCHANGE, () => json(200, IDENTITY))
    const profile = await signedIn(shared, 'https://app.test/account')
    expect(
      await profile.tula.user.identities.link({ provider: 'google', redirectUrl: APP })
    ).toEqual({ url: PROVIDER_URL })
    expect(profile.page.assigned).toEqual([PROVIDER_URL])
    expect(JSON.parse(shared.storage.entries.get(KEY) ?? '').k).toBe('link')

    const landing = await signedIn(shared, `${APP}#tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`)
    expect(await landing.tula.signIn.handleOAuthCallback()).toEqual({
      status: 'linked',
      identity: IDENTITY,
    })
    const [sent] = shared.api.calls(LINK_EXCHANGE)
    expect(sent?.body).toEqual({ ticket: TICKET, attemptId: ATTEMPT, binding: BINDING })
    expect(sent?.headers.get('authorization')).toMatch(/^Bearer /)
    // A link is never sent to the sign-in exchange.
    expect(shared.api.calls(EXCHANGE)).toHaveLength(0)
    expect(shared.storage.entries.size).toBe(0)
  })

  test('a link’s refusals are outcomes; an unusable answer is refused', async () => {
    const shared = browser()
    shared.api.on(LINK_START, () => json(200, linkStarted(shared)))
    const profile = await signedIn(shared, 'https://app.test/account')
    const land = async () => {
      await profile.tula.user.identities.link({
        provider: 'google',
        redirectUrl: APP,
        navigate: false,
      })
      return signedIn(shared, `${APP}#tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`)
    }
    shared.api.on(LINK_EXCHANGE, () => failure(409, 'oauth.identity_in_use' as never))
    expect(await (await land()).tula.signIn.handleOAuthCallback()).toMatchObject({
      status: 'error',
      code: 'oauth.identity_in_use',
    })
    shared.api.on(LINK_EXCHANGE, () => json(200, { provider: 'google' }))
    expect((await caught((await land()).tula.signIn.handleOAuthCallback())).code).toBe(
      'response.invalid'
    )
    shared.api.on(LINK_START, () => json(200, { ...linkStarted(shared), attemptId: '' }))
    expect(
      (await caught(profile.tula.user.identities.link({ provider: 'google', redirectUrl: APP })))
        .code
    ).toBe('response.invalid')
    shared.api.on(LINK_START, () => failure(403, 'auth.step_up_required'))
    expect(
      (await caught(profile.tula.user.identities.link({ provider: 'google', redirectUrl: APP })))
        .code
    ).toBe('auth.step_up_required')
  })

  test('unlink deletes the identity by id, and a refusal is thrown with its code', async () => {
    const shared = browser()
    const { tula } = await signedIn(shared, 'https://app.test/account')
    shared.api.on(
      'DELETE /v1/client/me/identities/identity_1',
      () => new Response(null, { status: 204 })
    )
    await tula.user.identities.unlink({ identityId: 'identity_1' })
    expect(shared.api.calls('DELETE /v1/client/me/identities/identity_1')).toHaveLength(1)
    shared.api.on('DELETE /v1/client/me/identities/identity_1', () =>
      failure(409, 'identity.last_sign_in_method' as never)
    )
    expect((await caught(tula.user.identities.unlink({ identityId: 'identity_1' }))).code).toBe(
      'identity.last_sign_in_method'
    )
  })
})
