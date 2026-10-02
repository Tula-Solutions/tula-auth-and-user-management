import { beforeEach, describe, expect, test } from 'bun:test'
import type { FlowAttempt } from '@tula/contract'
import { createApp } from '~/index'
import * as Flows from '~/modules/flow/router'
import { refreshCookieName } from '~/modules/session/cookies'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const COOKIE = refreshCookieName(TEST_CONFIG, TEST_TENANT.environmentId)
let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  app = createApp(deps)
})

interface Options {
  client?: string
  key?: string | null
  cookie?: string
  accessToken?: string
}

function post(path: string, body: unknown = {}, options: Options = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.key !== null) {
    headers['x-tula-publishable-key'] = options.key ?? PK
  }
  if (options.client) {
    headers['x-tula-client'] = options.client
  }
  if (options.cookie) {
    headers.cookie = options.cookie
  }
  return app.request(`/v1/client${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

const json = async <T>(res: Response) => (await res.json()) as T
const code = async (res: Response) => (await json<{ code: string }>(res)).code
const sentCode = () => /\b(\d{6})\b/.exec(deps.mailer.last().text)?.[1] ?? ''
const setCookie = (res: Response) => res.headers.get('set-cookie') ?? ''

async function register(options: Options = {}) {
  const started = await json<FlowAttempt>(
    await post('/sign-ups', { email: EMAIL, password: PASSWORD, firstName: 'Maya' }, options)
  )
  return post(`/sign-ups/${started.id}/verify-email`, { code: sentCode() }, options)
}

describe('sign-up over HTTP', () => {
  test('a browser signs up, verifies and receives its refresh token only as a cookie', async () => {
    const started = await post('/sign-ups', { email: EMAIL, password: PASSWORD })
    expect(started.status).toBe(200)
    expect(started.headers.get('cache-control')).toBe('no-store')
    const attempt = await json<FlowAttempt>(started)
    expect(attempt).toMatchObject({
      kind: 'sign_up',
      step: { status: 'needs_email_verification', destination: 'm***@northline.app' },
    })
    expect(attempt).not.toHaveProperty('session')

    const verified = await post(`/sign-ups/${attempt.id}/verify-email`, { code: sentCode() })
    expect(verified.status).toBe(200)
    const done = await json<FlowAttempt>(verified)
    expect(done.step.status).toBe('complete')
    expect(done.session?.accessToken.split('.')).toHaveLength(3)
    expect(done.session).not.toHaveProperty('refreshToken')
    const cookie = setCookie(verified)
    expect(cookie.startsWith(`${COOKIE}=tula_rt_`)).toBe(true)
    expect(cookie).toContain('HttpOnly')
    expect(JSON.stringify(done)).not.toContain('tula_rt_')

    // The cookie refreshes the session and the access token opens session routes.
    const token = /=([^;]+)/.exec(cookie)?.[1]
    expect((await post('/sessions/refresh', {}, { cookie: `${COOKIE}=${token}` })).status).toBe(200)
    const sessions = await app.request('/v1/client/sessions', {
      headers: {
        'x-tula-publishable-key': PK,
        authorization: `Bearer ${done.session?.accessToken}`,
      },
    })
    expect(sessions.status).toBe(200)
  })

  test('a native client gets the refresh token in the body and no cookie', async () => {
    const verified = await register({ client: 'ios' })
    const done = await json<FlowAttempt>(verified)
    expect(done.session?.refreshToken?.startsWith('tula_rt_')).toBe(true)
    expect(setCookie(verified)).toBe('')
    const session = await deps.sessions.findById(
      TEST_TENANT.environmentId,
      done.session?.sessionId ?? ''
    )
    expect(session?.client).toBe('ios')
  })

  test('reports field errors for a weak password and a bad email', async () => {
    const weak = await post('/sign-ups', { email: EMAIL, password: 'short' })
    expect(weak.status).toBe(422)
    expect(await json(weak)).toMatchObject({
      code: 'password.too_short',
      errors: [{ field: 'password', code: 'password.too_short' }],
    })
    const bad = await post('/sign-ups', { email: 'nope', password: PASSWORD })
    expect(await code(bad)).toBe('email.invalid')
  })

  test('validates the body, the code format, the attempt id and the client header', async () => {
    expect((await post('/sign-ups', { email: EMAIL })).status).toBe(422)
    const started = await json<FlowAttempt>(
      await post('/sign-ups', { email: EMAIL, password: PASSWORD })
    )
    expect((await post(`/sign-ups/${started.id}/verify-email`, { code: '12ab' })).status).toBe(422)
    expect((await post('/sign-ups/not-a-uuid/verify-email', { code: '123456' })).status).toBe(422)
    expect(
      (
        await post(
          '/sign-ups',
          { email: 'x@northline.app', password: PASSWORD },
          { client: 'toaster' }
        )
      ).status
    ).toBe(422)
  })

  test('a wrong code is rejected with the attempts remaining', async () => {
    const started = await json<FlowAttempt>(
      await post('/sign-ups', { email: EMAIL, password: PASSWORD })
    )
    const wrong = sentCode() === '000000' ? '000001' : '000000'
    const res = await post(`/sign-ups/${started.id}/verify-email`, { code: wrong })
    expect(res.status).toBe(422)
    expect(await json(res)).toMatchObject({
      code: 'verification.invalid_code',
      params: { attemptsRemaining: 4 },
    })
  })

  test('resending is limited, then sends a new code', async () => {
    const started = await json<FlowAttempt>(
      await post('/sign-ups', { email: EMAIL, password: PASSWORD })
    )
    expect((await post(`/sign-ups/${started.id}/resend-code`)).status).toBe(429)
    deps.clock.advance('1m')
    const resent = await post(`/sign-ups/${started.id}/resend-code`)
    expect(resent.status).toBe(200)
    expect((await json<FlowAttempt>(resent)).step.status).toBe('needs_email_verification')
    expect(deps.mailer.outbox).toHaveLength(2)
  })

  test('requires a publishable key', async () => {
    const res = await post('/sign-ups', { email: EMAIL, password: PASSWORD }, { key: null })
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('auth.invalid_key')
  })

  test('is rate limited per IP', async () => {
    for (let i = 0; i < Flows.SIGN_UP_RATE_LIMIT; i++) {
      await post('/sign-ups', { email: 'nope', password: PASSWORD })
    }
    const res = await post('/sign-ups', { email: EMAIL, password: PASSWORD })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).not.toBeNull()
  })
})

describe('sign-in over HTTP', () => {
  test('identifier, then password, then tokens', async () => {
    await register()
    const started = await post('/sign-ins', { identifier: EMAIL })
    expect(started.status).toBe(200)
    expect(started.headers.get('cache-control')).toBe('no-store')
    const attempt = await json<FlowAttempt>(started)
    expect(attempt.step).toEqual({ status: 'needs_password' })

    const signedIn = await post(`/sign-ins/${attempt.id}/password`, { password: PASSWORD })
    expect(signedIn.status).toBe(200)
    const done = await json<FlowAttempt>(signedIn)
    expect(done.step.status).toBe('complete')
    expect(done.session).not.toHaveProperty('refreshToken')
    expect(setCookie(signedIn).startsWith(`${COOKIE}=tula_rt_`)).toBe(true)
  })

  test('known and unknown identifiers fail with the same response', async () => {
    await register()
    const fail = async (identifier: string) => {
      const attempt = await json<FlowAttempt>(await post('/sign-ins', { identifier }))
      const res = await post(`/sign-ins/${attempt.id}/password`, { password: 'not the password' })
      return { status: res.status, body: await json(res), cookie: setCookie(res) }
    }
    const known = await fail(EMAIL)
    expect(known).toEqual({
      status: 401,
      body: { status: 401, code: 'auth.invalid_credentials', detail: expect.any(String) },
      cookie: '',
    })
    expect(await fail('nobody@northline.app')).toEqual(known)
  })

  test('an unverified user is sent a code and completes through the sign-in routes', async () => {
    await deps.users.createWithPassword({
      id: '00000000-0000-7000-8000-0000000000a1',
      projectId: TEST_TENANT.projectId,
      environmentId: TEST_TENANT.environmentId,
      email: EMAIL,
      emailNormalized: EMAIL,
      emailVerifiedAt: null,
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: 'i1',
      credentialId: 'c1',
      passwordHash: await Bun.password.hash(PASSWORD, {
        algorithm: 'argon2id',
        memoryCost: 65_536,
        timeCost: 2,
      }),
    })
    const attempt = await json<FlowAttempt>(
      await post('/sign-ins', { identifier: EMAIL }, { client: 'android' })
    )
    const pending = await json<FlowAttempt>(
      await post(`/sign-ins/${attempt.id}/password`, { password: PASSWORD })
    )
    expect(pending.step.status).toBe('needs_email_verification')
    expect(pending).not.toHaveProperty('session')

    deps.clock.advance('1m')
    expect((await post(`/sign-ins/${attempt.id}/resend-code`)).status).toBe(200)
    const done = await json<FlowAttempt>(
      await post(`/sign-ins/${attempt.id}/verify-email`, { code: sentCode() })
    )
    expect(done.step.status).toBe('complete')
    // The attempt was started from Android, so the token comes back in the body.
    expect(done.session?.refreshToken?.startsWith('tula_rt_')).toBe(true)
  })

  test('a sign-up attempt id is not accepted by the sign-in routes', async () => {
    const started = await json<FlowAttempt>(
      await post('/sign-ups', { email: EMAIL, password: PASSWORD })
    )
    const res = await post(`/sign-ins/${started.id}/password`, { password: PASSWORD })
    expect(res.status).toBe(404)
    expect(await code(res)).toBe('flow.not_found')
  })

  test('validates bodies and requires a publishable key', async () => {
    expect((await post('/sign-ins', {})).status).toBe(422)
    const attempt = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    expect((await post(`/sign-ins/${attempt.id}/password`, {})).status).toBe(422)
    expect(await code(await post('/sign-ins', { identifier: EMAIL }, { key: null }))).toBe(
      'auth.invalid_key'
    )
  })

  test('password submissions are rate limited per IP', async () => {
    const attempt = await json<FlowAttempt>(await post('/sign-ins', { identifier: 'x' }))
    for (let i = 0; i < Flows.CREDENTIAL_RATE_LIMIT; i++) {
      await post(`/sign-ins/${attempt.id}/password`, {})
    }
    expect((await post(`/sign-ins/${attempt.id}/password`, { password: PASSWORD })).status).toBe(
      429
    )
  })

  test('each environment has a ceiling across all IPs on the expensive steps', async () => {
    deps = createTestDeps({ config: { ...TEST_CONFIG, trustProxy: true } })
    deps.environments.add({
      id: TEST_TENANT.environmentId,
      projectId: TEST_TENANT.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
    await seedApiKey(deps, PK)
    app = createApp(deps)
    const signUp = (i: number) =>
      app.request('/v1/client/sign-ups', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tula-publishable-key': PK,
          // A different address every time, so the per-IP limits never trigger.
          'x-forwarded-for': `203.0.${Math.floor(i / 250)}.${i % 250}`,
        },
        body: JSON.stringify({ email: 'nope', password: PASSWORD }),
      })
    for (let i = 0; i < Flows.ENVIRONMENT_RATE_LIMITS.signUp; i++) {
      await signUp(i)
    }
    const res = await signUp(Flows.ENVIRONMENT_RATE_LIMITS.signUp)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).not.toBeNull()
  })
})
