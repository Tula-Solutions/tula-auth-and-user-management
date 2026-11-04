import { describe, expect, test } from 'bun:test'
import { createClient } from './client'
import { isTulaError, type TulaError } from './errors'
import { OAUTH_STORAGE_PREFIX } from './oauth'
import {
  failure,
  fakeApi,
  fakeEnvironment,
  fakeLinkStorage,
  fakePage,
  json,
  manualClock,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
} from './testing/fakes'

const ATTEMPT = '0190d7a0-0000-7000-8000-000000000002'
const SECRET = 'tula_at_the-sso-attempt'
const BINDING = 'tula_ob_sso-binding'
const TICKET = 'tula_ot_sso-ticket'
const APP = 'https://app.test/oauth/callback'
const IDP_URL = 'https://idp.example/authorize?state=s'
const START = 'POST /v1/client/sign-ins'
const SSO = `POST /v1/client/sign-ins/${ATTEMPT}/sso`
const EXCHANGE = 'POST /v1/client/sign-ins/oauth/exchange'
const OFFERING_SSO = { status: 'needs_first_factor', strategies: ['sso'] }

function setup(options: { storage?: boolean } = {}) {
  const api = fakeApi()
  const clock = manualClock()
  const storage = fakeLinkStorage()
  const page = fakePage('https://app.test/sign-in')
  const expiresAt = new Date(clock.now() + 600_000).toISOString()
  const attempt = (step: object, extra: object = {}) => ({
    id: ATTEMPT,
    kind: 'sign_in',
    expiresAt,
    step,
    ...extra,
  })
  api.on('GET /v1/client/me', () => json(200, TEST_USER))
  api.on(START, () => json(200, attempt(OFFERING_SSO, { attemptSecret: SECRET })))
  const started = () => ({
    attempt: attempt(OFFERING_SSO),
    authorizationUrl: IDP_URL,
    binding: BINDING,
  })
  const tula = createClient(
    { publishableKey: TEST_KEY, baseUrl: TEST_BASE_URL, client: 'web', fetch: api.fetch },
    fakeEnvironment(clock, { tabStorage: options.storage === false ? undefined : storage, page })
  )
  return { api, tula, storage, page, attempt, started }
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

const IDENTIFIER = { identifier: 'ada@acme.example' }

describe('single sign-on (the sso strategy)', () => {
  test('start sends the attempt secret and the redirect, keeps the binding and navigates', async () => {
    const t = setup()
    t.api.on(SSO, () => json(200, t.started()))
    const flow = await t.tula.signIn.start(IDENTIFIER)
    expect(await flow.startSso({ redirectUrl: APP })).toEqual({ url: IDP_URL })
    expect(t.page.assigned).toEqual([IDP_URL])
    const sent = t.api.calls(SSO)[0]
    expect(sent?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(sent?.body).toEqual({ redirectUrl: APP })
    expect([...t.storage.entries.keys()]).toEqual([`${OAUTH_STORAGE_PREFIX}${ATTEMPT}`])
  })

  test('navigate: false returns the URL and leaves the page alone', async () => {
    const t = setup()
    t.api.on(SSO, () => json(200, t.started()))
    const flow = await t.tula.signIn.start(IDENTIFIER)
    await flow.startSso({ redirectUrl: APP, navigate: false })
    expect(t.page.assigned).toEqual([])
  })

  test('the return is finished by handleOAuthCallback with the kept binding', async () => {
    const t = setup()
    t.api.on(SSO, () => json(200, t.started()))
    t.api.on(EXCHANGE, () =>
      json(
        200,
        t.attempt(
          { status: 'complete', userId: TEST_USER.id, sessionId: 's1' },
          { session: sessionTokens('sso') }
        )
      )
    )
    const flow = await t.tula.signIn.start(IDENTIFIER)
    await flow.startSso({ redirectUrl: APP })
    t.page.current = `${APP}#tula_ticket=${TICKET}&tula_attempt=${ATTEMPT}`
    const outcome = await t.tula.signIn.handleOAuthCallback()
    expect(outcome.status).toBe('complete')
    expect(t.api.calls(EXCHANGE)[0]?.body).toEqual({
      ticket: TICKET,
      attemptId: ATTEMPT,
      binding: BINDING,
    })
    expect(t.storage.entries.size).toBe(0)
  })

  test('a redirect on another origin is refused before any request', async () => {
    const t = setup()
    const flow = await t.tula.signIn.start(IDENTIFIER)
    const error = await caught(flow.startSso({ redirectUrl: 'https://evil.test/cb' }))
    expect(error.code).toBe('link.cross_origin')
    expect(t.api.calls(SSO)).toHaveLength(0)
  })

  test('without storage the start fails before any request', async () => {
    const t = setup({ storage: false })
    const flow = await t.tula.signIn.start(IDENTIFIER)
    expect((await caught(flow.startSso({ redirectUrl: APP }))).code).toBe('storage.failed')
    expect(t.api.calls(SSO)).toHaveLength(0)
  })

  test('an answer without a URL, or with a non-http URL, is refused and keeps nothing', async () => {
    for (const answer of [
      { binding: BINDING },
      { authorizationUrl: 'javascript:alert(1)', binding: BINDING },
    ]) {
      const t = setup()
      t.api.on(SSO, () => json(200, answer))
      const flow = await t.tula.signIn.start(IDENTIFIER)
      expect((await caught(flow.startSso({ redirectUrl: APP }))).code).toBe('response.invalid')
      expect(t.storage.entries.size).toBe(0)
      expect(t.page.assigned).toEqual([])
    }
  })

  test('the API’s refusal reaches the caller with its code', async () => {
    const t = setup()
    t.api.on(SSO, () => failure(409, 'sso.unavailable'))
    const flow = await t.tula.signIn.start(IDENTIFIER)
    expect((await caught(flow.startSso({ redirectUrl: APP }))).code).toBe('sso.unavailable')
  })
})
