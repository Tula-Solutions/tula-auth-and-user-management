import { describe, expect, test } from 'bun:test'
import { createClient } from './client'
import {
  createLinkStore,
  EMAIL_LINK_POLL_INTERVAL_MS,
  EMAIL_LINK_SESSION_WAIT_MS,
  LINK_BINDING_TTL_MS,
  LINK_STORAGE_PREFIX,
  readLinkFragment,
} from './email-link'
import { runtimeEnvironment } from './environment'
import { isTulaError, type TulaError } from './errors'
import {
  type FakeApi,
  type FakeChannelHub,
  type FakeLinkStorage,
  type FakePage,
  type FakeTimers,
  failure,
  fakeApi,
  fakeChannelHub,
  fakeEnvironment,
  fakeLinkStorage,
  fakePage,
  fakeTimers,
  json,
  type ManualClock,
  manualClock,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
} from './testing/fakes'
import type { FlowStep } from './types'

const SECRET = 'tula_at_s3cr3t-of-the-attempt'
const BINDING = 'tula_lb_b1nd1ng-of-the-link'
const TOKEN = 'l1nk-t0k3n'
const ATTEMPT = 'attempt_1'
const REDIRECT = 'https://app.test/auth/link'
const SCOPE = `${TEST_BASE_URL}|${TEST_KEY}`
const KEY = `${LINK_STORAGE_PREFIX}${ATTEMPT}`

const CHOICE: FlowStep = {
  status: 'needs_first_factor',
  strategies: ['password', 'email_code', 'email_link'],
}
const prepared = (strategy: 'email_code' | 'email_link'): FlowStep => ({
  ...CHOICE,
  prepared: { strategy, destination: 'm***@northline.app' },
})
const COMPLETE: FlowStep = { status: 'complete', userId: 'user_1', sessionId: 'session_1' }

/** A moment before the clock's start, and one after it, as the API would send them. */
function expiry(clock: ManualClock, offsetMs = 600_000): string {
  return new Date(clock.now() + offsetMs).toISOString()
}

interface Browser {
  api: FakeApi
  clock: ManualClock
  storage: FakeLinkStorage
  hub: FakeChannelHub
}

function browser(): Browser {
  const api = fakeApi()
  api.on('GET /v1/client/me', () => json(200, TEST_USER))
  return { api, clock: manualClock(), storage: fakeLinkStorage(), hub: fakeChannelHub() }
}

function tab(
  shared: Browser,
  options: { url?: string; storage?: boolean; hub?: boolean; timers?: FakeTimers } = {}
) {
  const page: FakePage | undefined = options.url === undefined ? undefined : fakePage(options.url)
  const timers = options.timers ?? fakeTimers()
  const tula = createClient(
    { publishableKey: TEST_KEY, baseUrl: TEST_BASE_URL, client: 'web', fetch: shared.api.fetch },
    fakeEnvironment(shared.clock, {
      hub: options.hub === false ? undefined : shared.hub,
      linkStorage: options.storage === false ? undefined : shared.storage,
      page,
      timers,
    })
  )
  return { tula, page, timers }
}

function attempt(shared: Browser, step: FlowStep, extra: Record<string, unknown> = {}) {
  return { id: ATTEMPT, kind: 'sign_in', expiresAt: expiry(shared.clock), step, ...extra }
}

/** Register the routes of an email sign-in and start one, in a fresh tab. */
async function started(shared: Browser, options: Parameters<typeof tab>[1] = {}) {
  shared.api.on('POST /v1/client/sign-ins', () =>
    json(200, attempt(shared, CHOICE, { attemptSecret: SECRET }))
  )
  shared.api.on(`POST /v1/client/sign-ins/${ATTEMPT}/first-factor/prepare`, (request) => {
    const { strategy } = request.body as { strategy: 'email_code' | 'email_link' }
    return json(
      200,
      attempt(shared, prepared(strategy), strategy === 'email_link' ? { linkBinding: BINDING } : {})
    )
  })
  const opened = tab(shared, options)
  const flow = await opened.tula.signIn.start({ identifier: 'maya@northline.app' })
  return { ...opened, flow }
}

const ATTEMPT_ROUTE = `POST /v1/client/sign-ins/${ATTEMPT}/first-factor/attempt`
const LINK_ROUTE = 'POST /v1/client/sign-ins/link'

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

/** Let promise callbacks that are already queued run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('the link binding store', () => {
  test('keeps a binding under the attempt id until it is removed', () => {
    const clock = manualClock()
    const storage = fakeLinkStorage()
    const store = createLinkStore({ linkStorage: storage, now: clock.now }, SCOPE)
    expect(store.available()).toBe(true)
    expect(store.read(ATTEMPT)).toBeNull()
    expect(store.save(ATTEMPT, BINDING)).toBe(true)
    expect([...storage.entries.keys()]).toEqual([KEY])
    expect(store.read(ATTEMPT)).toBe(BINDING)
    store.remove(ATTEMPT)
    expect(storage.entries.size).toBe(0)
    expect(store.read(ATTEMPT)).toBeNull()
  })

  test('an entry outlives its attempt by a little, on the device clock, and is then swept', () => {
    const clock = manualClock()
    const storage = fakeLinkStorage()
    const store = createLinkStore({ linkStorage: storage, now: clock.now }, SCOPE)
    store.save(ATTEMPT, BINDING)
    clock.advance(60_000)
    store.save('attempt_2', 'tula_lb_other')
    clock.advance(LINK_BINDING_TTL_MS - 60_000 - 1)
    expect(store.read(ATTEMPT)).toBe(BINDING)
    clock.advance(1)
    expect(store.read(ATTEMPT)).toBeNull()
    expect([...storage.entries.keys()]).toEqual([`${LINK_STORAGE_PREFIX}attempt_2`])
    expect(store.read('attempt_2')).toBe('tula_lb_other')
  })

  test("another app's entry is not read, and other keys are never touched", () => {
    const clock = manualClock()
    const storage = fakeLinkStorage()
    const theirs = createLinkStore({ linkStorage: storage, now: clock.now }, 'https://other|key')
    theirs.save(ATTEMPT, BINDING)
    storage.setItem('theme', 'dark')
    storage.setItem('tula.linked', 'not ours')
    const store = createLinkStore({ linkStorage: storage, now: clock.now }, SCOPE)
    expect(store.read(ATTEMPT)).toBeNull()
    clock.advance(LINK_BINDING_TTL_MS)
    store.read(ATTEMPT)
    expect([...storage.entries.keys()].sort()).toEqual(['theme', 'tula.linked'])
  })

  test.each([
    ['not JSON', '{'],
    ['a JSON string', '"x"'],
    ['null', 'null'],
    ['an entry with no expiry', JSON.stringify({ b: BINDING, s: SCOPE })],
    ['an entry with no binding', JSON.stringify({ e: 9_999_999_999_999, s: SCOPE })],
  ])('%s under an attempt key yields no binding', (_, raw) => {
    const clock = manualClock()
    const storage = fakeLinkStorage()
    storage.setItem(KEY, raw)
    const store = createLinkStore({ linkStorage: storage, now: clock.now }, SCOPE)
    expect(store.read(ATTEMPT)).toBeNull()
  })

  test('storage that refuses access is treated as no storage, without throwing', () => {
    const clock = manualClock()
    const storage = fakeLinkStorage()
    storage.failing = true
    const store = createLinkStore({ linkStorage: storage, now: clock.now }, SCOPE)
    expect(store.available()).toBe(false)
    expect(store.save(ATTEMPT, BINDING)).toBe(false)
    expect(store.read(ATTEMPT)).toBeNull()
    expect(() => store.remove(ATTEMPT)).not.toThrow()
  })

  test('with no storage at all there is nothing to keep a binding in', () => {
    const clock = manualClock()
    const store = createLinkStore({ linkStorage: undefined, now: clock.now }, SCOPE)
    expect(store.available()).toBe(false)
    expect(store.save(ATTEMPT, BINDING)).toBe(false)
    expect(store.read(ATTEMPT)).toBeNull()
    expect(() => store.remove(ATTEMPT)).not.toThrow()
  })
})

describe('reading a link out of a page address', () => {
  test.each<[string, string, { token: string; attemptId: string; cleanUrl: string } | null]>([
    [
      'the two parameters',
      `${REDIRECT}#tula_link=${TOKEN}&tula_attempt=${ATTEMPT}`,
      { token: TOKEN, attemptId: ATTEMPT, cleanUrl: REDIRECT },
    ],
    [
      'a query is kept, and so is the rest of the fragment',
      `${REDIRECT}?tab=1#section=2&tula_attempt=${ATTEMPT}&tula_link=${TOKEN}`,
      { token: TOKEN, attemptId: ATTEMPT, cleanUrl: `${REDIRECT}?tab=1#section=2` },
    ],
    [
      'an encoded token is decoded',
      `${REDIRECT}#tula_link=a%2Bb&tula_attempt=${ATTEMPT}`,
      { token: 'a+b', attemptId: ATTEMPT, cleanUrl: REDIRECT },
    ],
    ['no fragment', REDIRECT, null],
    ['an empty fragment', `${REDIRECT}#`, null],
    ['only the token', `${REDIRECT}#tula_link=${TOKEN}`, null],
    ['only the attempt', `${REDIRECT}#tula_attempt=${ATTEMPT}`, null],
    ['an empty token', `${REDIRECT}#tula_link=&tula_attempt=${ATTEMPT}`, null],
    [
      'the parameters in the query, not the fragment',
      `${REDIRECT}?tula_link=${TOKEN}&tula_attempt=${ATTEMPT}`,
      null,
    ],
  ])('%s', (_, url, expected) => {
    expect(readLinkFragment(url)).toEqual(expected)
  })
})

describe('the runtime environment', () => {
  test('reads storage, the page address and timers from the globals it is given', async () => {
    const storage = fakeLinkStorage()
    const calls: unknown[][] = []
    const environment = runtimeEnvironment({
      localStorage: storage,
      location: { href: `${REDIRECT}#x` },
      history: {
        state: { kept: true },
        replaceState: (...args) => {
          calls.push(args)
        },
      },
    })
    expect(environment.linkStorage).toBe(storage)
    expect(environment.page?.url()).toBe(`${REDIRECT}#x`)
    environment.page?.replaceUrl(REDIRECT)
    expect(calls).toEqual([[{ kept: true }, '', REDIRECT]])

    let fired = 0
    const cancel = environment.setTimer(() => {
      fired += 1
    }, 1)
    cancel()
    environment.setTimer(() => {
      fired += 10
    }, 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fired).toBe(10)
  })

  test('has no page outside a browser, and survives storage that throws on access', () => {
    expect(runtimeEnvironment({}).page).toBeUndefined()
    expect(runtimeEnvironment({}).linkStorage).toBeUndefined()
    const hostile = Object.defineProperty({}, 'localStorage', {
      get() {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    expect(runtimeEnvironment(hostile).linkStorage).toBeUndefined()
  })
})

describe('asking for an email', () => {
  test('a code: sends the strategy with the attempt secret and shows where it went', async () => {
    const shared = browser()
    const { flow } = await started(shared)
    const step = await flow.prepareFirstFactor({ strategy: 'email_code' })
    expect(step).toEqual(prepared('email_code'))
    expect(flow.step).toEqual(prepared('email_code'))
    const [request] = shared.api.calls(`POST /v1/client/sign-ins/${ATTEMPT}/first-factor/prepare`)
    expect(request?.body).toEqual({ strategy: 'email_code' })
    expect(request?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(shared.storage.entries.size).toBe(0)
  })

  test('a link: the binding goes to shared storage under the attempt id, and nowhere else', async () => {
    const shared = browser()
    const { flow, tula } = await started(shared)
    expect(tula.signIn.canUseEmailLink()).toBe(true)
    await flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: REDIRECT })
    const [request] = shared.api.calls(`POST /v1/client/sign-ins/${ATTEMPT}/first-factor/prepare`)
    expect(request?.body).toEqual({ strategy: 'email_link', redirectUrl: REDIRECT })
    expect([...shared.storage.entries.keys()]).toEqual([KEY])
    expect(JSON.parse(shared.storage.entries.get(KEY) ?? '{}')).toEqual({
      b: BINDING,
      e: shared.clock.now() + LINK_BINDING_TTL_MS,
      s: SCOPE,
    })
    // The attempt's secret is never stored, and the binding is not part of the flow object.
    expect(JSON.stringify([...shared.storage.entries])).not.toContain(SECRET)
    expect(JSON.stringify(flow)).not.toContain(BINDING)
    expect(Bun.inspect(flow)).not.toContain(BINDING)
  })

  test('a link without usable storage is refused before any email is sent', async () => {
    for (const mode of ['missing', 'failing'] as const) {
      const shared = browser()
      shared.storage.failing = mode === 'failing'
      const { flow, tula } = await started(shared, { storage: mode !== 'missing' })
      expect(tula.signIn.canUseEmailLink()).toBe(false)
      const error = await caught(
        flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: REDIRECT })
      )
      expect(error).toMatchObject({ code: 'storage.failed', status: 0 })
      expect(
        shared.api.calls(`POST /v1/client/sign-ins/${ATTEMPT}/first-factor/prepare`)
      ).toHaveLength(0)
      // The code path is untouched.
      expect(await flow.prepareFirstFactor({ strategy: 'email_code' })).toEqual(
        prepared('email_code')
      )
    }
  })

  test('a link to another origin is refused before anything is sent: the binding could never be read there', async () => {
    const shared = browser()
    const { flow } = await started(shared, { url: 'https://app.test/sign-in' })
    for (const redirectUrl of [
      'https://other.test/auth/link',
      'http://app.test/auth/link',
      'https://app.test:8443/auth/link',
      'https://app.test.evil.test/auth/link',
    ]) {
      const error = await caught(flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl }))
      expect(error).toMatchObject({ code: 'link.cross_origin', status: 0 })
      expect(error.message).toBe(
        'A sign-in link has to lead to a page on the site where the sign-in was started.'
      )
    }
    expect(
      shared.api.calls(`POST /v1/client/sign-ins/${ATTEMPT}/first-factor/prepare`)
    ).toHaveLength(0)
    expect(shared.storage.entries.size).toBe(0)
    // The same origin, any path or query, goes through; so does the code.
    expect(
      await flow.prepareFirstFactor({
        strategy: 'email_link',
        redirectUrl: 'https://app.test/auth/link?from=sign-in',
      })
    ).toEqual(prepared('email_link'))
    expect(await flow.prepareFirstFactor({ strategy: 'email_code' })).toEqual(
      prepared('email_code')
    )
  })

  test('where no page address is known (not a browser), the origin is not checked', async () => {
    const shared = browser()
    const { flow } = await started(shared)
    expect(
      await flow.prepareFirstFactor({
        strategy: 'email_link',
        redirectUrl: 'https://anywhere.test/auth/link',
      })
    ).toEqual(prepared('email_link'))
  })

  test('a redirect URL that is not a URL is left for the server to refuse', async () => {
    const shared = browser()
    const { flow } = await started(shared, { url: 'https://app.test/sign-in' })
    shared.api.on(`POST /v1/client/sign-ins/${ATTEMPT}/first-factor/prepare`, () =>
      failure(400, 'request.redirect_not_allowed')
    )
    const error = await caught(
      flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: 'auth/link' })
    )
    expect(error.code).toBe('request.redirect_not_allowed')
  })

  test('a refused redirect URL surfaces the contract error', async () => {
    const shared = browser()
    const { flow } = await started(shared)
    shared.api.on(`POST /v1/client/sign-ins/${ATTEMPT}/first-factor/prepare`, () =>
      failure(400, 'request.redirect_not_allowed')
    )
    const error = await caught(
      flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: 'https://evil.test/' })
    )
    expect(error).toMatchObject({ code: 'request.redirect_not_allowed', status: 400 })
    expect(shared.storage.entries.size).toBe(0)
    expect(flow.step).toEqual(CHOICE)
  })
})

describe('submitting an emailed code', () => {
  test('completes the flow, signs the client in and clears a stored binding', async () => {
    const shared = browser()
    const { flow, tula } = await started(shared)
    await flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: REDIRECT })
    shared.api.on(ATTEMPT_ROUTE, () =>
      json(200, attempt(shared, COMPLETE, { session: sessionTokens('code') }))
    )
    const step = await flow.attemptFirstFactor({ strategy: 'email_code', code: '123456' })
    expect(step).toEqual(COMPLETE)
    const [request] = shared.api.calls(ATTEMPT_ROUTE)
    expect(request?.body).toEqual({ strategy: 'email_code', code: '123456' })
    expect(request?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(tula.state).toMatchObject({ status: 'signed-in', sessionId: 'session_1' })
    expect(shared.storage.entries.size).toBe(0)
  })

  test('a wrong code throws and leaves the flow ready for another', async () => {
    const shared = browser()
    const { flow } = await started(shared)
    await flow.prepareFirstFactor({ strategy: 'email_code' })
    shared.api.on(ATTEMPT_ROUTE, () =>
      failure(422, 'verification.invalid_code', { params: { attemptsRemaining: 4 } })
    )
    const error = await caught(flow.attemptFirstFactor({ strategy: 'email_code', code: '000000' }))
    expect(error).toMatchObject({
      code: 'verification.invalid_code',
      params: { attemptsRemaining: 4 },
    })
    expect(flow.step).toEqual(prepared('email_code'))
  })
})

describe('waiting for an emailed link', () => {
  async function waitingFlow(shared: Browser, options: Parameters<typeof tab>[1] = {}) {
    const opened = await started(shared, options)
    await opened.flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: REDIRECT })
    shared.api.on(ATTEMPT_ROUTE, () => json(200, attempt(shared, prepared('email_link'))))
    return opened
  }
  const complete = (shared: Browser) =>
    shared.api.on(ATTEMPT_ROUTE, () =>
      json(200, attempt(shared, COMPLETE, { session: sessionTokens('link') }))
    )

  test('asks every few seconds until the link was opened, then signs in and leaves nothing running', async () => {
    const shared = browser()
    const { flow, tula, timers } = await waitingFlow(shared)
    const waiting = flow.waitForEmailLink()
    await settle()
    // Nothing is asked before the first interval has passed.
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(0)
    expect(timers.pending()).toEqual([EMAIL_LINK_POLL_INTERVAL_MS])

    timers.fire()
    await settle()
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(1)
    expect(shared.api.calls(ATTEMPT_ROUTE)[0]?.body).toEqual({ strategy: 'email_link' })
    expect(shared.api.calls(ATTEMPT_ROUTE)[0]?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(timers.pending()).toEqual([EMAIL_LINK_POLL_INTERVAL_MS])

    complete(shared)
    timers.fire()
    expect(await waiting).toEqual(COMPLETE)
    expect(flow.step).toEqual(COMPLETE)
    expect(tula.state).toMatchObject({ status: 'signed-in' })
    expect(timers.pending()).toEqual([])
    expect(shared.storage.entries.size).toBe(0)
  })

  test('another tab saying the link was accepted makes it ask at once', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    const waiting = flow.waitForEmailLink()
    await settle()
    complete(shared)
    const other = shared.hub.createChannel(`tula-link:${SCOPE}`)
    // A message about another attempt, or a malformed one, changes nothing.
    other.postMessage({ v: 1, type: 'link-accepted', attemptId: 'attempt_other' })
    other.postMessage({ v: 2, type: 'link-accepted', attemptId: ATTEMPT })
    other.postMessage('link-accepted')
    await settle()
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(0)

    other.postMessage({ v: 1, type: 'link-accepted', attemptId: ATTEMPT })
    expect(await waiting).toEqual(COMPLETE)
    expect(timers.pending()).toEqual([])
    // The timer that was running was cancelled, not left to fire into nothing.
    expect(timers.cancelled).toBe(1)
  })

  test('aborting stops the wait: the step as it stands, no timer, no further request', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    const abort = new AbortController()
    const waiting = flow.waitForEmailLink({ signal: abort.signal })
    await settle()
    abort.abort()
    expect(await waiting).toEqual(prepared('email_link'))
    expect(timers.pending()).toEqual([])
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(0)
    // Messages after the wait are ignored: the channel listener is gone.
    shared.hub
      .createChannel(`tula-link:${SCOPE}`)
      .postMessage({ v: 1, type: 'link-accepted', attemptId: ATTEMPT })
    await settle()
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(0)
  })

  test('a signal that is already aborted never sets a timer', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    const abort = new AbortController()
    abort.abort()
    expect(await flow.waitForEmailLink({ signal: abort.signal })).toEqual(prepared('email_link'))
    expect(timers.pending()).toEqual([])
  })

  test('discard stops the wait and forgets the binding', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    const waiting = flow.waitForEmailLink()
    await settle()
    expect(shared.storage.entries.size).toBe(1)
    flow.discard()
    expect(await waiting).toEqual(prepared('email_link'))
    expect(timers.pending()).toEqual([])
    expect(shared.storage.entries.size).toBe(0)
    // A new wait can be started afterwards.
    const again = flow.waitForEmailLink()
    await settle()
    expect(timers.pending()).toEqual([EMAIL_LINK_POLL_INTERVAL_MS])
    flow.discard()
    await again
  })

  test('a wait its caller stopped and asked for again at once keeps asking the server', async () => {
    // What React does to an effect under StrictMode, on Fast Refresh and around <Activity>:
    // clean up (abort) and set up again in the same tick. The second wait must not die with
    // the first one's signal.
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    const first = new AbortController()
    const stopped = flow.waitForEmailLink({ signal: first.signal })
    first.abort()
    const kept = flow.waitForEmailLink()
    expect(await stopped).toEqual(prepared('email_link'))
    await settle()
    // One timer, still running, and no request was made just for changing hands.
    expect(timers.pending()).toEqual([EMAIL_LINK_POLL_INTERVAL_MS])
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(0)

    timers.fire()
    await settle()
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(1)
    complete(shared)
    timers.fire()
    expect(await kept).toEqual(COMPLETE)
    expect(timers.pending()).toEqual([])
  })

  test('each caller stops with its own signal; the wait goes on while anyone is left', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    const one = new AbortController()
    const two = new AbortController()
    const first = flow.waitForEmailLink({ signal: one.signal })
    const second = flow.waitForEmailLink({ signal: two.signal })
    await settle()
    one.abort()
    expect(await first).toEqual(prepared('email_link'))
    await settle()
    expect(timers.pending()).toEqual([EMAIL_LINK_POLL_INTERVAL_MS])
    two.abort()
    expect(await second).toEqual(prepared('email_link'))
    await settle()
    expect(timers.pending()).toEqual([])
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(0)
  })

  test('discard ends the wait for every caller', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    const first = flow.waitForEmailLink()
    const second = flow.waitForEmailLink({ signal: new AbortController().signal })
    await settle()
    flow.discard()
    expect(await first).toEqual(prepared('email_link'))
    expect(await second).toEqual(prepared('email_link'))
    await settle()
    expect(timers.pending()).toEqual([])
  })

  test('discarding a flow that never waited does not slow down a later wait', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    flow.discard()
    const waiting = flow.waitForEmailLink()
    await settle()
    expect(timers.pending()).toEqual([EMAIL_LINK_POLL_INTERVAL_MS])
    timers.fire()
    await settle()
    // The first interval leads to the first question: no round is skipped.
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(1)
    flow.discard()
    await waiting
  })

  test('a second call joins the wait already running', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    const first = flow.waitForEmailLink()
    const second = flow.waitForEmailLink()
    await settle()
    expect(timers.pending()).toHaveLength(1)
    complete(shared)
    timers.fire()
    expect(await first).toEqual(COMPLETE)
    expect(await second).toEqual(COMPLETE)
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(1)
  })

  test('a rate limit is obeyed: the next round waits as long as the server said', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    shared.api.on(ATTEMPT_ROUTE, () => failure(429, 'rate_limited', {}, { 'retry-after': '20' }))
    const waiting = flow.waitForEmailLink()
    await settle()
    timers.fire()
    await settle()
    expect(timers.pending()).toEqual([20_000])
    // Back to the usual interval after an answer.
    shared.api.on(ATTEMPT_ROUTE, () => json(200, attempt(shared, prepared('email_link'))))
    timers.fire()
    await settle()
    expect(timers.pending()).toEqual([EMAIL_LINK_POLL_INTERVAL_MS])
    flow.discard()
    await waiting
  })

  test('a rate limit with no Retry-After keeps the usual interval', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    shared.api.on(ATTEMPT_ROUTE, () => failure(429, 'rate_limited'))
    const waiting = flow.waitForEmailLink()
    await settle()
    timers.fire()
    await settle()
    expect(timers.pending()).toEqual([EMAIL_LINK_POLL_INTERVAL_MS])
    flow.discard()
    await waiting
  })

  test('a round that gets no answer is simply tried again', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    shared.api.on(ATTEMPT_ROUTE, () => {
      throw new TypeError('offline')
    })
    const waiting = flow.waitForEmailLink()
    await settle()
    timers.fire()
    await settle()
    expect(timers.pending()).toEqual([EMAIL_LINK_POLL_INTERVAL_MS])
    complete(shared)
    timers.fire()
    expect(await waiting).toEqual(COMPLETE)
  })

  test('an expired attempt, or any other refusal, ends the wait with that error and no timer', async () => {
    for (const [status, code] of [
      [404, 'flow.not_found'],
      [403, 'auth.method_disabled'],
      [403, 'auth.user_banned'],
    ] as const) {
      const shared = browser()
      const { flow, timers } = await waitingFlow(shared)
      shared.api.on(ATTEMPT_ROUTE, () => failure(status, code))
      const waiting = caught(flow.waitForEmailLink())
      await settle()
      timers.fire()
      expect((await waiting).code).toBe(code)
      expect(timers.pending()).toEqual([])
    }
  })

  test('an answer that is not this API ends the wait', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    shared.api.on(ATTEMPT_ROUTE, () => json(200, { hello: 'world' }))
    const waiting = caught(flow.waitForEmailLink())
    await settle()
    timers.fire()
    expect((await waiting).code).toBe('response.invalid')
    expect(timers.pending()).toEqual([])
  })

  test('while another action is being sent the round is skipped, not failed', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    let release: (response: Response) => void = () => undefined
    shared.api.on(`POST /v1/client/sign-ins/${ATTEMPT}/password`, () => {
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    })
    const waiting = flow.waitForEmailLink()
    await settle()
    const submitting = caught(flow.submitPassword({ password: 'pw' }))
    await settle()
    timers.fire()
    await settle()
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(0)
    expect(timers.pending()).toEqual([EMAIL_LINK_POLL_INTERVAL_MS])
    release(failure(401, 'auth.invalid_credentials'))
    await submitting
    flow.discard()
    await waiting
  })

  test('when another action completes the sign-in, the wait ends with it', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared)
    const waiting = flow.waitForEmailLink()
    await settle()
    complete(shared)
    await flow.attemptFirstFactor({ strategy: 'email_code', code: '123456' })
    timers.fire()
    expect(await waiting).toEqual(COMPLETE)
    expect(timers.pending()).toEqual([])
    expect(shared.api.calls(ATTEMPT_ROUTE)).toHaveLength(1)
  })

  test('signing out stops the wait', async () => {
    const shared = browser()
    shared.api.on('POST /v1/client/sessions/refresh', () => json(200, sessionTokens('old')))
    shared.api.on('POST /v1/client/sessions/sign-out', () => new Response(null, { status: 204 }))
    const { flow, tula, timers } = await waitingFlow(shared)
    await tula.load()
    expect(tula.state.status).toBe('signed-in')
    const waiting = flow.waitForEmailLink()
    await settle()
    await tula.session.signOut()
    expect(await waiting).toEqual(prepared('email_link'))
    expect(timers.pending()).toEqual([])
  })

  test('a completed flow refuses to wait', async () => {
    const shared = browser()
    const { flow } = await waitingFlow(shared)
    complete(shared)
    await flow.attemptFirstFactor({ strategy: 'email_link' })
    const error = await caught(flow.waitForEmailLink())
    expect(error).toMatchObject({ code: 'flow.invalid_step', status: 0 })
  })

  test('works without a channel: the timer alone finds out', async () => {
    const shared = browser()
    const { flow, timers } = await waitingFlow(shared, { hub: false })
    const waiting = flow.waitForEmailLink()
    await settle()
    complete(shared)
    timers.fire()
    expect(await waiting).toEqual(COMPLETE)
  })
})

describe('the page an emailed link leads to', () => {
  const LINK_URL = `${REDIRECT}#tula_link=${TOKEN}&tula_attempt=${ATTEMPT}`

  test('with no page at all, or no link in the address, nothing is sent', async () => {
    const shared = browser()
    for (const url of [undefined, REDIRECT, `${REDIRECT}#other=1`]) {
      const { tula, page } = tab(shared, { url })
      expect(await tula.signIn.handleEmailLink()).toEqual({ status: 'none' })
      expect(page?.replaced ?? []).toEqual([])
    }
    expect(shared.api.requests).toHaveLength(0)
  })

  test('same browser: the token and the stored binding are sent, the fragment is gone first, and the starting tab finishes', async () => {
    const shared = browser()
    shared.api.on('POST /v1/client/sessions/refresh', () => failure(401, 'session.invalid_token'))
    const original = await started(shared)
    await original.flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: REDIRECT })
    shared.api.on(ATTEMPT_ROUTE, () =>
      json(200, attempt(shared, COMPLETE, { session: sessionTokens('link') }))
    )
    const waiting = original.flow.waitForEmailLink()
    await settle()

    const landing = tab(shared, { url: LINK_URL })
    // As an app does on every page: find out whether someone is signed in.
    await landing.tula.load()
    expect(landing.tula.state.status).toBe('signed-out')
    let addressWhenSent = ''
    shared.api.on(LINK_ROUTE, () => {
      addressWhenSent = landing.page?.current ?? ''
      return json(200, { status: 'verified' })
    })

    const outcome = await landing.tula.signIn.handleEmailLink()
    expect(outcome).toEqual({ status: 'signed_in' })
    const [request] = shared.api.calls(LINK_ROUTE)
    expect(request?.body).toEqual({ token: TOKEN, attemptId: ATTEMPT, binding: BINDING })
    // No attempt secret travels with a link: this tab never had one.
    expect(request?.headers.get('x-tula-attempt')).toBeNull()
    expect(request?.path).toBe('/v1/client/sign-ins/link')
    expect(addressWhenSent).toBe(REDIRECT)
    expect(landing.page?.current).toBe(REDIRECT)

    expect(await waiting).toEqual(COMPLETE)
    expect(original.tula.state).toMatchObject({ status: 'signed-in', sessionId: 'session_1' })
    expect(landing.tula.state).toMatchObject({ status: 'signed-in', sessionId: 'session_1' })
    // Nothing is left behind in storage or on a timer.
    expect(shared.storage.entries.size).toBe(0)
    expect(original.timers.pending()).toEqual([])
    expect(landing.timers.pending()).toEqual([])
  })

  test('when the starting tab is gone, the link is accepted but nobody is signed in', async () => {
    const shared = browser()
    shared.api.on('POST /v1/client/sessions/refresh', () => failure(401, 'session.invalid_token'))
    shared.storage.setItem(
      KEY,
      JSON.stringify({ b: BINDING, e: shared.clock.now() + 60_000, s: SCOPE })
    )
    shared.api.on(LINK_ROUTE, () => json(200, { status: 'verified' }))
    const landing = tab(shared, { url: LINK_URL })
    const handling = landing.tula.signIn.handleEmailLink()
    await settle()
    expect(landing.timers.pending()).toEqual([EMAIL_LINK_SESSION_WAIT_MS])
    landing.timers.fire()
    expect(await handling).toEqual({ status: 'verified' })
    expect(landing.tula.state.status).toBe('signed-out')
    expect(shared.storage.entries.size).toBe(0)
    expect(landing.timers.pending()).toEqual([])
  })

  test('without a channel, the session is picked up from the cookie when the wait is over', async () => {
    const shared = browser()
    shared.storage.setItem(
      KEY,
      JSON.stringify({ b: BINDING, e: shared.clock.now() + 60_000, s: SCOPE })
    )
    shared.api.on(LINK_ROUTE, () => json(200, { status: 'verified' }))
    shared.api.on('POST /v1/client/sessions/refresh', () => json(200, sessionTokens('cookie')))
    const landing = tab(shared, { url: LINK_URL, hub: false })
    const handling = landing.tula.signIn.handleEmailLink({ waitMs: 250 })
    await settle()
    expect(landing.timers.pending()).toEqual([250])
    landing.timers.fire()
    expect(await handling).toEqual({ status: 'signed_in' })
  })

  test('a refresh that cannot be made at the end of the wait is not an error', async () => {
    const shared = browser()
    shared.storage.setItem(
      KEY,
      JSON.stringify({ b: BINDING, e: shared.clock.now() + 60_000, s: SCOPE })
    )
    shared.api.on(LINK_ROUTE, () => json(200, { status: 'verified' }))
    shared.api.on('POST /v1/client/sessions/refresh', () => failure(503, 'service.unavailable'))
    const landing = tab(shared, { url: LINK_URL })
    const handling = landing.tula.signIn.handleEmailLink()
    await settle()
    landing.timers.fire()
    expect(await handling).toEqual({ status: 'verified' })
  })

  test('a tab that is already signed in says so at once', async () => {
    const shared = browser()
    shared.api.on('POST /v1/client/sessions/refresh', () => json(200, sessionTokens('have')))
    shared.api.on(LINK_ROUTE, () => json(200, { status: 'verified' }))
    const landing = tab(shared, { url: LINK_URL })
    await landing.tula.load()
    expect(await landing.tula.signIn.handleEmailLink()).toEqual({ status: 'signed_in' })
    expect(landing.timers.pending()).toEqual([])
  })

  test('another browser: no binding is sent, the answer is different_browser, and nothing is spent here', async () => {
    const shared = browser()
    shared.api.on(LINK_ROUTE, () => failure(409, 'verification.different_browser'))
    const landing = tab(shared, { url: LINK_URL })
    expect(await landing.tula.signIn.handleEmailLink()).toEqual({ status: 'different_browser' })
    const [request] = shared.api.calls(LINK_ROUTE)
    expect(request?.body).toEqual({ token: TOKEN, attemptId: ATTEMPT })
    // The token is still removed from the address: it must not linger in a URL.
    expect(landing.page?.current).toBe(REDIRECT)
    expect(landing.tula.state.status).toBe('loading')
  })

  test('a browser that refuses storage behaves like another browser', async () => {
    const shared = browser()
    shared.storage.failing = true
    shared.api.on(LINK_ROUTE, () => failure(409, 'verification.different_browser'))
    const landing = tab(shared, { url: LINK_URL })
    expect(await landing.tula.signIn.handleEmailLink()).toEqual({ status: 'different_browser' })
    expect(shared.api.calls(LINK_ROUTE)[0]?.body).toEqual({ token: TOKEN, attemptId: ATTEMPT })
  })

  test('a dead link is expired, and leaves this browser’s binding alone', async () => {
    const shared = browser()
    const entry = JSON.stringify({ b: BINDING, e: shared.clock.now() + 60_000, s: SCOPE })
    shared.storage.setItem(KEY, entry)
    shared.api.on(LINK_ROUTE, () => failure(410, 'verification.expired'))
    const landing = tab(shared, { url: LINK_URL })
    expect(await landing.tula.signIn.handleEmailLink()).toEqual({ status: 'expired' })
    // An expired answer says nothing about the binding: it may belong to a newer email.
    expect(shared.storage.entries.get(KEY)).toBe(entry)
  })

  test('the link of an email that was replaced does not undo the newer one', async () => {
    const shared = browser()
    shared.api.on('POST /v1/client/sessions/refresh', () => failure(401, 'session.invalid_token'))
    const original = await started(shared)
    // Asked twice (a resend): the binding in storage is the second email's.
    let sent = 0
    shared.api.on(`POST /v1/client/sign-ins/${ATTEMPT}/first-factor/prepare`, () => {
      sent += 1
      return json(
        200,
        attempt(shared, prepared('email_link'), { linkBinding: `${BINDING}-${sent}` })
      )
    })
    await original.flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: REDIRECT })
    await original.flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: REDIRECT })
    // The server knows only the newest token.
    shared.api.on(LINK_ROUTE, (request) => {
      const body = request.body as { token: string; binding?: string }
      return body.token === 'new-token' && body.binding === `${BINDING}-2`
        ? json(200, { status: 'verified' })
        : failure(410, 'verification.expired')
    })

    // The user opens the first email's link by mistake…
    const stale = tab(shared, { url: `${REDIRECT}#tula_link=old-token&tula_attempt=${ATTEMPT}` })
    expect(await stale.tula.signIn.handleEmailLink()).toEqual({ status: 'expired' })
    expect(JSON.parse(shared.storage.entries.get(KEY) ?? '{}').b).toBe(`${BINDING}-2`)

    // …and the second email's link still works.
    const landing = tab(shared, { url: `${REDIRECT}#tula_link=new-token&tula_attempt=${ATTEMPT}` })
    const handling = landing.tula.signIn.handleEmailLink()
    await settle()
    expect(shared.api.calls(LINK_ROUTE).at(-1)?.body).toEqual({
      token: 'new-token',
      attemptId: ATTEMPT,
      binding: `${BINDING}-2`,
    })
    landing.timers.fire()
    expect(await handling).toEqual({ status: 'verified' })
    original.flow.discard()
  })

  test('any other failure is thrown, with the token already out of the address', async () => {
    const shared = browser()
    shared.api.on(LINK_ROUTE, () => failure(429, 'rate_limited', {}, { 'retry-after': '5' }))
    const landing = tab(shared, { url: LINK_URL })
    const error = await caught(landing.tula.signIn.handleEmailLink())
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterMs: 5_000 })
    expect(landing.page?.current).toBe(REDIRECT)
    expect(error.message).not.toContain(TOKEN)
    expect(JSON.stringify(error)).not.toContain(TOKEN)
  })

  test('calls made while one is in flight share it: one request, one outcome', async () => {
    const shared = browser()
    shared.api.on(LINK_ROUTE, () => failure(410, 'verification.expired'))
    const landing = tab(shared, { url: LINK_URL })
    const [first, second] = await Promise.all([
      landing.tula.signIn.handleEmailLink(),
      landing.tula.signIn.handleEmailLink(),
    ])
    expect(first).toEqual({ status: 'expired' })
    expect(second).toBe(first)
    expect(shared.api.calls(LINK_ROUTE)).toHaveLength(1)
    // Afterwards the address carries no link any more.
    expect(await landing.tula.signIn.handleEmailLink()).toEqual({ status: 'none' })
  })

  test('an address that cannot be rewritten does not stop the link from being used', async () => {
    const shared = browser()
    shared.api.on(LINK_ROUTE, () => failure(410, 'verification.expired'))
    const landing = tab(shared, { url: LINK_URL })
    if (landing.page) {
      landing.page.replaceUrl = () => {
        throw new DOMException('denied', 'SecurityError')
      }
    }
    expect(await landing.tula.signIn.handleEmailLink()).toEqual({ status: 'expired' })
  })

  test('a channel that cannot be opened or posted to is not an error', async () => {
    const shared = browser()
    shared.storage.setItem(
      KEY,
      JSON.stringify({ b: BINDING, e: shared.clock.now() + 60_000, s: SCOPE })
    )
    shared.api.on(LINK_ROUTE, () => json(200, { status: 'verified' }))
    shared.api.on('POST /v1/client/sessions/refresh', () => failure(401, 'session.invalid_token'))
    for (const broken of ['create', 'post'] as const) {
      const timers = fakeTimers()
      const page = fakePage(LINK_URL)
      const tula = createClient(
        {
          publishableKey: TEST_KEY,
          baseUrl: TEST_BASE_URL,
          client: 'web',
          fetch: shared.api.fetch,
        },
        {
          ...fakeEnvironment(shared.clock, { linkStorage: shared.storage, page, timers }),
          createChannel(name) {
            if (broken === 'create' && name.startsWith('tula-link:')) {
              throw new DOMException('denied', 'SecurityError')
            }
            return {
              onmessage: null,
              postMessage() {
                if (name.startsWith('tula-link:')) {
                  throw new DOMException('closed', 'InvalidStateError')
                }
              },
              close() {
                // Nothing to release in this stand-in.
              },
            }
          },
        }
      )
      const handling = tula.signIn.handleEmailLink()
      await settle()
      timers.fire()
      expect(await handling).toEqual({ status: 'verified' })
      shared.storage.setItem(
        KEY,
        JSON.stringify({ b: BINDING, e: shared.clock.now() + 60_000, s: SCOPE })
      )
    }
  })
})

describe('sign-up without a password', () => {
  test('sends only what was given', async () => {
    const shared = browser()
    shared.api.on('POST /v1/client/sign-ups', () =>
      json(200, {
        id: ATTEMPT,
        kind: 'sign_up',
        expiresAt: expiry(shared.clock),
        attemptSecret: SECRET,
        step: {
          status: 'needs_email_verification',
          destination: 'm***@northline.app',
          strategies: ['email_code'],
        },
      })
    )
    const { tula } = tab(shared)
    const flow = await tula.signUp.start({ email: 'maya@northline.app' })
    expect(shared.api.requests[0]?.body).toEqual({ email: 'maya@northline.app' })
    expect(flow.step.status).toBe('needs_email_verification')
  })
})
