import { describe, expect, test } from 'bun:test'
import { createClient } from './client'
import { isTulaError, type TulaError } from './errors'
import {
  type FakeApi,
  failure,
  fakeApi,
  fakeEnvironment,
  json,
  manualClock,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
} from './testing/fakes'

// `signIn.withIdToken` (ADR 0045): a native app's sign-in with the ID token its provider's
// own SDK hands it. Against the fake API; the real one is `apps/api/src/sdk-journeys.test.ts`.

const ATTEMPT = '0190d7a0-0000-7000-8000-000000000001'
const SECRET = 'tula_at_the-attempts-secret'
const NONCE = 'q3Yx0mJ0b0Jr9mJ9mW9a8mW3rJcV2bT7yP1eK5uH6sA'
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'
const START = 'POST /v1/client/sign-ins/id-token'
const EXCHANGE = `POST /v1/client/sign-ins/${ATTEMPT}/id-token`
const SECOND_FACTOR = `POST /v1/client/sign-ins/${ATTEMPT}/second-factor`

const attempt = (step: object, extra: object = {}) => ({
  id: ATTEMPT,
  kind: 'sign_in',
  expiresAt: '2030-01-01T00:10:00.000Z',
  step,
  ...extra,
})

const started = (extra: object = {}) => ({
  attempt: attempt(
    { status: 'needs_first_factor', strategies: ['oauth_google'] },
    { attemptSecret: SECRET }
  ),
  nonce: NONCE,
  ...extra,
})

const complete = () =>
  attempt(
    { status: 'complete', userId: 'user_1', sessionId: 'session_1' },
    { session: sessionTokens('native', { refreshToken: 'tula_rt_native' }) }
  )

function app(prepare?: (api: FakeApi) => void) {
  const api = fakeApi()
  api.on('GET /v1/client/me', () => json(200, TEST_USER))
  api.on(START, () => json(200, started()))
  api.on(EXCHANGE, () => json(200, complete()))
  prepare?.(api)
  const tula = createClient(
    { publishableKey: TEST_KEY, baseUrl: TEST_BASE_URL, client: 'android', fetch: api.fetch },
    fakeEnvironment(manualClock())
  )
  return { api, tula }
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

describe('signIn.withIdToken', () => {
  test('the start names the provider and nothing else, and answers the server’s nonce', async () => {
    const { api, tula } = app()
    const pending = await tula.signIn.withIdToken({ provider: 'google' })
    expect(pending.nonce).toBe(NONCE)
    const [request] = api.calls(START)
    expect(request?.body).toEqual({ provider: 'google' })
    expect(request?.headers.get('x-tula-client')).toBe('android')
    expect(request?.headers.get('x-tula-attempt')).toBeNull()
    // No exchange yet: the app has to ask the provider's SDK first.
    expect(api.calls(EXCHANGE)).toHaveLength(0)
  })

  test('what the app holds shows the nonce and never the attempt’s secret', async () => {
    const { tula } = app()
    const pending = await tula.signIn.withIdToken({ provider: 'google' })
    expect(Object.keys(pending).sort()).toEqual(['exchange', 'nonce'])
    expect(JSON.stringify(pending)).toBe(JSON.stringify({ nonce: NONCE }))
    expect(JSON.stringify(pending)).not.toContain(SECRET)
  })

  test('the exchange sends the token in a JSON body with the attempt’s secret, and signs in', async () => {
    const { api, tula } = app()
    const pending = await tula.signIn.withIdToken({ provider: 'google' })
    const flow = await pending.exchange(ID_TOKEN)
    expect(flow.step.status).toBe('complete')
    expect(tula.state.status).toBe('signed-in')
    const [request] = api.calls(EXCHANGE)
    expect(request?.body).toEqual({ idToken: ID_TOKEN })
    expect(request?.headers.get('x-tula-attempt')).toBe(SECRET)
    // Not in the address of any request, and not in what the flow shows.
    expect(api.requests.map((sent) => sent.path).join()).not.toContain(ID_TOKEN)
    expect(JSON.stringify(flow)).not.toContain(ID_TOKEN)
    expect(JSON.stringify(flow)).not.toContain(SECRET)
  })

  test('a second factor still stands before the session, on the same attempt', async () => {
    const { api, tula } = app((fake) => {
      fake.on(EXCHANGE, () =>
        json(200, attempt({ status: 'needs_second_factor', options: ['totp'] }))
      )
      fake.on(SECOND_FACTOR, () => json(200, complete()))
    })
    const pending = await tula.signIn.withIdToken({ provider: 'google' })
    const flow = await pending.exchange(ID_TOKEN)
    expect(flow.step.status).toBe('needs_second_factor')
    expect(tula.state.status).not.toBe('signed-in')
    const done = await flow.submitSecondFactor({ method: 'totp', code: '123456' })
    expect(done.step.status).toBe('complete')
    expect(api.calls(SECOND_FACTOR)[0]?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(tula.state.status).toBe('signed-in')
  })

  test.each([
    ['auth.invalid_credentials', 401],
    ['oauth.account_exists', 409],
    ['oauth.email_unverified', 403],
    ['auth.method_disabled', 403],
  ] as const)('a refused exchange throws %s and signs nobody in', async (code, status) => {
    const { tula } = app((fake) => fake.on(EXCHANGE, () => failure(status, code)))
    const pending = await tula.signIn.withIdToken({ provider: 'google' })
    const error = await caught(pending.exchange(ID_TOKEN))
    expect(error).toMatchObject({ code, status })
    expect(JSON.stringify(error)).not.toContain(ID_TOKEN)
    expect(error.message).not.toContain(ID_TOKEN)
    expect(tula.state.status).not.toBe('signed-in')
  })

  test('a refused start throws what the API answered and exchanges nothing', async () => {
    const { api, tula } = app((fake) => fake.on(START, () => failure(403, 'auth.method_disabled')))
    expect(await caught(tula.signIn.withIdToken({ provider: 'google' }))).toMatchObject({
      code: 'auth.method_disabled',
    })
    expect(api.calls(EXCHANGE)).toHaveLength(0)
  })

  test.each([
    ['not an object', 'ok'],
    ['no nonce', started({ nonce: undefined })],
    ['a nonce that is not a string', started({ nonce: 7 })],
    ['no attempt', { nonce: NONCE }],
    [
      'an attempt with no id',
      { nonce: NONCE, attempt: { step: { status: 'needs_first_factor' } } },
    ],
    ['an attempt with no step', { nonce: NONCE, attempt: { id: ATTEMPT } }],
  ])('a 200 that is not a start is response.invalid: %s', async (_name, body) => {
    const { api, tula } = app((fake) => fake.on(START, () => json(200, body)))
    expect(await caught(tula.signIn.withIdToken({ provider: 'google' }))).toMatchObject({
      code: 'response.invalid',
      status: 0,
    })
    expect(api.calls(EXCHANGE)).toHaveLength(0)
  })

  test('a start that came back without the attempt’s secret cannot exchange', async () => {
    const { api, tula } = app((fake) =>
      fake.on(START, () =>
        json(200, {
          nonce: NONCE,
          attempt: attempt({ status: 'needs_first_factor', strategies: ['oauth_google'] }),
        })
      )
    )
    const pending = await tula.signIn.withIdToken({ provider: 'google' })
    expect(await caught(pending.exchange(ID_TOKEN))).toMatchObject({ code: 'response.invalid' })
    expect(api.calls(EXCHANGE)).toHaveLength(0)
  })
})
