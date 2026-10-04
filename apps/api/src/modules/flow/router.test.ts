import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, FLOW_ATTEMPT_HEADER, type FlowAttempt } from '@tula/contract'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Factors from '~/modules/factor/service'
import * as Flows from '~/modules/flow/router'
import { ENVIRONMENT_RATE_LIMITS } from '~/modules/flow/service'
import { refreshCookieName } from '~/modules/session/cookies'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const COOKIE = refreshCookieName(TEST_CONFIG, TEST_TENANT.environmentId)
let deps: TestDeps
let app: ReturnType<typeof createApp>
/** The secret of every attempt started through {@link post}, by attempt id: what a client keeps. */
let secrets: Map<string, string>

beforeEach(async () => {
  secrets = new Map()
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
  /** The `Origin` header a browser would send. */
  origin?: string
  /**
   * The value of `x-tula-attempt`. Left out, a call on an attempt carries the secret its start
   * returned, as a client would; `null` sends no header.
   */
  attempt?: string | null
}

const ATTEMPT_PATH = /^\/(?:sign-ups|sign-ins|password-resets)\/([^/]+)\//

/** A minimal client: it remembers each attempt's secret and presents it on later calls. */
async function post(path: string, body: unknown = {}, options: Options = {}) {
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
  if (options.origin) {
    headers.origin = options.origin
  }
  const secret =
    options.attempt === undefined
      ? secrets.get(ATTEMPT_PATH.exec(path)?.[1] ?? '')
      : (options.attempt ?? undefined)
  if (secret !== undefined) {
    headers[FLOW_ATTEMPT_HEADER] = secret
  }
  const res = await app.request(`/v1/client${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const started = (await res
    .clone()
    .json()
    .catch(() => null)) as Partial<FlowAttempt> | null
  if (started?.id && started.attemptSecret) {
    secrets.set(started.id, started.attemptSecret)
  }
  return res
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
    expect(done.session?.accessToken?.split('.')).toHaveLength(3)
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
    await deps.users.create({
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

  test('malformed requests from many IPs cannot use up an environment’s ceiling', async () => {
    deps = createTestDeps({ config: { ...TEST_CONFIG, trustProxy: true } })
    deps.environments.add({
      id: TEST_TENANT.environmentId,
      projectId: TEST_TENANT.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
    await seedApiKey(deps, PK)
    app = createApp(deps)
    const signUp = (i: number, body: unknown) =>
      app.request('/v1/client/sign-ups', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tula-publishable-key': PK,
          // A different address every time, so the per-IP limits never trigger.
          'x-forwarded-for': `203.0.${Math.floor(i / 250)}.${i % 250}`,
        },
        body: JSON.stringify(body),
      })
    for (let i = 0; i <= ENVIRONMENT_RATE_LIMITS.signUp; i++) {
      // Fails validation: no password, so nothing is hashed and no email is sent.
      expect((await signUp(i, { email: EMAIL })).status).toBe(422)
    }
    const real = await signUp(60_000, { email: EMAIL, password: PASSWORD })
    expect(real.status).toBe(200)
  })
})

describe('password reset over HTTP', () => {
  const NEW_PASSWORD = 'a brand new passphrase 42'

  test('a browser resets its password and receives the refresh token only as a cookie', async () => {
    await register()
    deps.clock.advance('1m')
    const started = await post('/password-resets', { email: EMAIL })
    expect(started.status).toBe(200)
    expect(started.headers.get('cache-control')).toBe('no-store')
    const attempt = await json<FlowAttempt>(started)
    expect(attempt).toMatchObject({
      kind: 'password_reset',
      step: { status: 'needs_new_password', destination: 'm***@northline.app' },
    })

    const done = await post(`/password-resets/${attempt.id}/password`, {
      code: sentCode(),
      password: NEW_PASSWORD,
    })
    expect(done.status).toBe(200)
    const body = await json<FlowAttempt>(done)
    expect(body.step.status).toBe('complete')
    expect(body.session?.accessToken).toBeString()
    expect(body.session?.refreshToken).toBeUndefined()
    expect(setCookie(done)).toContain(`${COOKIE}=tula_rt_`)
    expect(setCookie(done)).toContain('HttpOnly')
  })

  test('a native client receives the refresh token in the body', async () => {
    await register()
    deps.clock.advance('1m')
    const attempt = await json<FlowAttempt>(
      await post('/password-resets', { email: EMAIL }, { client: 'ios' })
    )
    const done = await post(`/password-resets/${attempt.id}/password`, {
      code: sentCode(),
      password: NEW_PASSWORD,
    })
    expect((await json<FlowAttempt>(done)).session?.refreshToken).toMatch(/^tula_rt_/)
    expect(setCookie(done)).toBe('')
  })

  test('an unknown address gets the same response', async () => {
    const res = await post('/password-resets', { email: 'nobody@northline.app' })
    expect(res.status).toBe(200)
    expect(await json<FlowAttempt>(res)).toMatchObject({
      kind: 'password_reset',
      step: { status: 'needs_new_password', strategies: ['email_code'] },
    })
  })

  test('requires a publishable key and well-formed bodies', async () => {
    expect((await post('/password-resets', { email: EMAIL }, { key: null })).status).toBe(401)
    expect((await post('/password-resets', {})).status).toBe(422)
    expect(await code(await post('/password-resets', { email: 'nope' }))).toBe('email.invalid')
    const attempt = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }))
    const submit = (body: unknown) => post(`/password-resets/${attempt.id}/password`, body)
    expect((await submit({ code: '12345', password: NEW_PASSWORD })).status).toBe(422)
    expect((await submit({ code: '123456' })).status).toBe(422)
    expect((await post('/password-resets/not-a-uuid/password', {})).status).toBe(422)
    expect(
      await code(
        await post(`/password-resets/${crypto.randomUUID()}/password`, {
          code: '123456',
          password: NEW_PASSWORD,
        })
      )
    ).toBe('flow.not_found')
  })

  test('a wrong code is a 422 with the guesses left, and a weak password names the rule', async () => {
    await register()
    deps.clock.advance('1m')
    const attempt = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }))
    const right = sentCode()
    const wrong = right === '000000' ? '000001' : '000000'
    const guess = await post(`/password-resets/${attempt.id}/password`, {
      code: wrong,
      password: NEW_PASSWORD,
    })
    expect(guess.status).toBe(422)
    expect(await json(guess)).toMatchObject({
      code: 'verification.invalid_code',
      params: { attemptsRemaining: 4 },
    })
    const weak = await post(`/password-resets/${attempt.id}/password`, {
      code: right,
      password: 'short',
    })
    expect(weak.status).toBe(422)
    expect(await code(weak)).toBe('password.too_short')
  })

  test('resending is limited like any other email', async () => {
    const attempt = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }))
    expect((await post(`/password-resets/${attempt.id}/resend-code`)).status).toBe(429)
    deps.clock.advance('1m')
    const resent = await post(`/password-resets/${attempt.id}/resend-code`)
    expect(resent.status).toBe(200)
    expect((await json<FlowAttempt>(resent)).step.status).toBe('needs_new_password')
  })

  test('starting a reset is rate limited per IP', async () => {
    for (let i = 0; i < Flows.SIGN_UP_RATE_LIMIT; i++) {
      await post('/password-resets', {})
    }
    expect((await post('/password-resets', { email: EMAIL })).status).toBe(429)
  })

  test('submissions are rate limited per IP', async () => {
    const attempt = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }))
    for (let i = 0; i < Flows.CREDENTIAL_RATE_LIMIT; i++) {
      await post(`/password-resets/${attempt.id}/password`, {})
    }
    expect(
      (
        await post(`/password-resets/${attempt.id}/password`, {
          code: '123456',
          password: NEW_PASSWORD,
        })
      ).status
    ).toBe(429)
  })
})

describe('password sign-in switched off for the environment', () => {
  test.each<[string, string, object]>([
    ['sign-up', '/sign-ups', { email: EMAIL, password: PASSWORD }],
    ['sign-in', '/sign-ins', { identifier: EMAIL }],
    ['password reset', '/password-resets', { email: EMAIL }],
  ])('starting a %s answers 403 auth.method_disabled', async (_, path, body) => {
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        signIn: {
          methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, password: { enabled: false } },
        },
      },
    })
    const res = await post(path, body)
    expect(res.status).toBe(403)
    expect(await json<unknown>(res)).toEqual({
      status: 403,
      code: 'auth.method_disabled',
      detail: 'This sign-in method is not available.',
      // A sign-in start names no method: it is refused because none is enabled at all.
      ...(path !== '/sign-ins' && { params: { method: 'password' } }),
    })
    expect(deps.mailer.outbox).toEqual([])
  })
})

describe('attempt binding over HTTP', () => {
  const NEW_PASSWORD = 'a brand new passphrase 42'
  const NOT_FOUND = {
    status: 404,
    code: 'flow.not_found',
    detail: 'This attempt does not exist or has expired.',
  }

  test('every start returns attemptSecret once; no later response repeats it', async () => {
    const signUp = await json<FlowAttempt>(
      await post('/sign-ups', { email: EMAIL, password: PASSWORD })
    )
    expect(signUp.attemptSecret).toMatch(/^tula_at_[A-Za-z0-9_-]{43}$/)
    deps.clock.advance('1m')
    const resent = await post(`/sign-ups/${signUp.id}/resend-code`)
    expect(resent.status).toBe(200)
    expect(await resent.text()).not.toContain('tula_at_')
    const verified = await post(`/sign-ups/${signUp.id}/verify-email`, { code: sentCode() })
    expect(verified.status).toBe(200)
    expect(await verified.text()).not.toContain('tula_at_')

    const signIn = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    expect(signIn.attemptSecret).toMatch(/^tula_at_/)
    const wrong = await post(`/sign-ins/${signIn.id}/password`, { password: 'not the password' })
    expect(await wrong.text()).not.toContain('tula_at_')
    const done = await post(`/sign-ins/${signIn.id}/password`, { password: PASSWORD })
    expect(done.status).toBe(200)
    expect(await done.text()).not.toContain('tula_at_')

    deps.clock.advance('1m')
    const reset = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }))
    expect(reset.attemptSecret).toMatch(/^tula_at_/)
    expect(new Set([signUp.attemptSecret, signIn.attemptSecret, reset.attemptSecret]).size).toBe(3)
  })

  test('every step answers the same 404 without the header, with a wrong one and with another attempt’s', async () => {
    await register()
    deps.clock.advance('1m')
    const signIn = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    const other = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    const signUp = await json<FlowAttempt>(
      await post('/sign-ups', { email: 'new@northline.app', password: PASSWORD })
    )
    const signUpCode = sentCode()
    const reset = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }))
    const resetCode = sentCode()
    deps.clock.advance('1m')
    const sent = deps.mailer.outbox.length

    const steps: [string, FlowAttempt, unknown][] = [
      [`/sign-ins/${signIn.id}/password`, signIn, { password: PASSWORD }],
      [`/sign-ins/${signIn.id}/verify-email`, signIn, { code: '123456' }],
      [`/sign-ins/${signIn.id}/resend-code`, signIn, {}],
      [`/sign-ups/${signUp.id}/verify-email`, signUp, { code: signUpCode }],
      [`/sign-ups/${signUp.id}/resend-code`, signUp, {}],
      [`/password-resets/${reset.id}/password`, reset, { code: resetCode, password: NEW_PASSWORD }],
      [`/password-resets/${reset.id}/resend-code`, reset, {}],
    ]
    const unknown = await post(
      `/sign-ins/${crypto.randomUUID()}/password`,
      { password: PASSWORD },
      { attempt: 'tula_at_made-up' }
    )
    expect(unknown.status).toBe(404)
    expect(await json<unknown>(unknown)).toEqual(NOT_FOUND)

    for (const [path, attempt, body] of steps) {
      const foreign = attempt.id === other.id ? signIn : other
      for (const presented of [
        null,
        '',
        'tula_at_made-up',
        `${attempt.attemptSecret}x`,
        foreign.attemptSecret as string,
      ]) {
        const res = await post(path, body, { attempt: presented })
        expect({ path, presented, status: res.status, body: await json<unknown>(res) }).toEqual({
          path,
          presented,
          status: 404,
          body: NOT_FOUND,
        })
        expect(setCookie(res)).toBe('')
      }
    }
    // Nothing was sent, and the right secret still completes each attempt.
    expect(deps.mailer.outbox).toHaveLength(sent)
    const done = await post(`/sign-ins/${signIn.id}/password`, { password: PASSWORD })
    expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
    const verified = await post(`/sign-ups/${signUp.id}/verify-email`, { code: signUpCode })
    expect((await json<FlowAttempt>(verified)).step.status).toBe('complete')
    const changed = await post(`/password-resets/${reset.id}/password`, {
      code: resetCode,
      password: NEW_PASSWORD,
    })
    expect((await json<FlowAttempt>(changed)).step.status).toBe('complete')
  })

  test('nothing the server logs contains a secret, on success or on any refusal', async () => {
    const levels = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      spyOn(logger, level)
    )
    try {
      await register()
      const attempt = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
      const path = `/sign-ins/${attempt.id}/password`
      await post(path, { password: PASSWORD }, { attempt: null })
      await post(path, { password: PASSWORD }, { attempt: `${attempt.attemptSecret}x` })
      await post(path, { password: PASSWORD }, { attempt: 'a'.repeat(300) })
      await post(path, { password: 'not the password' })
      await post(path, { password: PASSWORD }, { origin: 'https://evil.example' })
      expect((await post(path, { password: PASSWORD })).status).toBe(200)

      const lines = levels.flatMap((level) => level.mock.calls.map((call) => JSON.stringify(call)))
      // One request line per call at least, so the check is not vacuous.
      expect(lines.length).toBeGreaterThan(7)
      for (const line of lines) {
        expect(line).not.toContain('tula_at_')
        expect(line).not.toContain(FLOW_ATTEMPT_HEADER)
        expect(line).not.toContain('a'.repeat(300))
      }
    } finally {
      for (const level of levels) {
        level.mockRestore()
      }
    }
  })

  test('an overlong header is a validation error, whatever the attempt', async () => {
    const attempt = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    for (const id of [attempt.id, crypto.randomUUID()]) {
      const res = await post(
        `/sign-ins/${id}/password`,
        { password: PASSWORD },
        { attempt: 'a'.repeat(257) }
      )
      expect(res.status).toBe(422)
    }
  })

  test('a browser may send the header: the preflight allows it', async () => {
    const res = await app.request('/v1/client/sign-ins', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': `content-type,${FLOW_ATTEMPT_HEADER}`,
      },
    })
    expect(res.headers.get('access-control-allow-headers')?.split(',')).toContain(
      FLOW_ATTEMPT_HEADER
    )
  })
})

describe('a browser flow and the page’s origin', () => {
  const NEW_PASSWORD = 'a brand new passphrase 42'
  const ALLOWED = 'https://app.northline.app'
  const FOREIGN = 'https://evil.example'
  const REFUSED = {
    status: 403,
    code: 'request.origin_not_allowed',
    detail: 'This origin is not allowed to sign in to this app.',
  }

  beforeEach(() => {
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        urls: { ...DEFAULT_ENVIRONMENT_SETTINGS.urls, allowedOrigins: [ALLOWED] },
      },
    })
  })

  const sessions = async () =>
    (await deps.users
      .findByEmail(TEST_TENANT.environmentId, EMAIL)
      .then((user) =>
        user
          ? deps.sessions.listActiveByUser(TEST_TENANT.environmentId, user.id, deps.clock.now())
          : []
      )) ?? []

  test.each<[string, string, object]>([
    ['sign-up', '/sign-ups', { email: EMAIL, password: PASSWORD }],
    ['sign-in', '/sign-ins', { identifier: EMAIL }],
    ['password reset', '/password-resets', { email: EMAIL }],
  ])('a %s cannot be started from an origin that is not allowed', async (_, path, body) => {
    const create = spyOn(deps.flowAttempts, 'create')
    try {
      const res = await post(path, body, { origin: FOREIGN })
      expect(res.status).toBe(403)
      expect(await json<unknown>(res)).toEqual(REFUSED)
      expect(setCookie(res)).toBe('')
      // The response is not readable by that page either.
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      expect(create).not.toHaveBeenCalled()
      expect(deps.mailer.outbox).toEqual([])

      // Allowed origins, the API's own origin and requests with no Origin all start one.
      for (const origin of [ALLOWED, TEST_CONFIG.publicUrl, undefined]) {
        deps.clock.advance('1m')
        expect((await post(path, body, { origin })).status).toBe(200)
      }
    } finally {
      create.mockRestore()
    }
  })

  test('a sign-in started elsewhere cannot be completed from a page that is not allowed: no session, no cookie', async () => {
    await register()
    // The attacker starts the attempt outside a browser, then has the victim's browser finish it.
    const attempt = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    const before = (await sessions()).length
    const res = await post(
      `/sign-ins/${attempt.id}/password`,
      { password: PASSWORD },
      { origin: FOREIGN }
    )
    expect(res.status).toBe(403)
    expect(await json<unknown>(res)).toEqual(REFUSED)
    expect(setCookie(res)).toBe('')
    expect(await sessions()).toHaveLength(before)
    expect(deps.activityLog.ofType('session.created')).toHaveLength(before)

    // The attempt is untouched: the app's own page completes it and gets the cookie.
    const done = await post(
      `/sign-ins/${attempt.id}/password`,
      { password: PASSWORD },
      { origin: ALLOWED }
    )
    expect(done.status).toBe(200)
    expect(setCookie(done).startsWith(`${COOKIE}=tula_rt_`)).toBe(true)
    expect(done.headers.get('access-control-allow-origin')).toBe(ALLOWED)
  })

  test('a sign-up cannot be completed from such a page: the code is not consumed and no account is created', async () => {
    const attempt = await json<FlowAttempt>(
      await post('/sign-ups', { email: EMAIL, password: PASSWORD })
    )
    const code = sentCode()
    const path = `/sign-ups/${attempt.id}/verify-email`
    const res = await post(path, { code }, { origin: FOREIGN })
    expect(res.status).toBe(403)
    expect(await json<unknown>(res)).toEqual(REFUSED)
    expect(setCookie(res)).toBe('')
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toBeNull()

    const done = await post(path, { code }, { origin: ALLOWED })
    expect(done.status).toBe(200)
    expect(setCookie(done).startsWith(`${COOKIE}=tula_rt_`)).toBe(true)
  })

  test('a password reset cannot be completed from such a page: the password is unchanged and the code unspent', async () => {
    await register()
    deps.clock.advance('1m')
    const attempt = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }))
    const body = { code: sentCode(), password: NEW_PASSWORD }
    const path = `/password-resets/${attempt.id}/password`
    const res = await post(path, body, { origin: FOREIGN })
    expect(res.status).toBe(403)
    expect(await json<unknown>(res)).toEqual(REFUSED)
    expect(setCookie(res)).toBe('')
    expect(deps.activityLog.ofType('user.password_changed')).toEqual([])
    expect(await sessions()).toHaveLength(1)

    const done = await post(path, body, { origin: ALLOWED })
    expect(done.status).toBe(200)
    expect(setCookie(done)).toContain(`${COOKIE}=tula_rt_`)
  })

  test('a code cannot be resent from such a page', async () => {
    const attempt = await json<FlowAttempt>(
      await post('/sign-ups', { email: EMAIL, password: PASSWORD })
    )
    deps.clock.advance('1m')
    const res = await post(`/sign-ups/${attempt.id}/resend-code`, {}, { origin: FOREIGN })
    expect(await json<unknown>(res)).toEqual(REFUSED)
    expect(deps.mailer.outbox).toHaveLength(1)
  })

  test('without the attempt’s secret the origin is never mentioned', async () => {
    const attempt = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    const res = await post(
      `/sign-ins/${attempt.id}/password`,
      { password: PASSWORD },
      { origin: FOREIGN, attempt: null }
    )
    expect(await code(res)).toBe('flow.not_found')
  })

  test('a native attempt is not bound to an origin: its tokens travel in the body and no cookie is set', async () => {
    await register({ client: 'ios' })
    const attempt = await json<FlowAttempt>(
      await post('/sign-ins', { identifier: EMAIL }, { client: 'ios', origin: FOREIGN })
    )
    const done = await post(
      `/sign-ins/${attempt.id}/password`,
      { password: PASSWORD },
      { origin: FOREIGN }
    )
    expect(done.status).toBe(200)
    expect((await json<FlowAttempt>(done)).session?.refreshToken).toMatch(/^tula_rt_/)
    expect(setCookie(done)).toBe('')
    // The foreign page still cannot read the response.
    expect(done.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('a later request cannot escape the rule by claiming another client kind', async () => {
    await register()
    const attempt = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    const res = await post(
      `/sign-ins/${attempt.id}/password`,
      { password: PASSWORD },
      { origin: FOREIGN, client: 'ios' }
    )
    expect(await json<unknown>(res)).toEqual(REFUSED)
  })
})

describe('first-factor choice and second factor over HTTP', () => {
  const spies: ReturnType<typeof spyOn>[] = []
  afterEach(() => {
    for (const spy of spies.splice(0)) {
      spy.mockRestore()
    }
  })

  test('a sign-in start lists the strategies when more than one method is enabled', async () => {
    await register()
    spies.push(spyOn(Factors, 'firstFactors').mockReturnValue(['password', 'email_code']))
    const answers = []
    for (const identifier of [EMAIL, 'nobody@northline.app']) {
      const res = await post('/sign-ins', { identifier })
      expect(res.status).toBe(200)
      const attempt = await json<FlowAttempt>(res)
      answers.push(attempt.step)
      expect(attempt.attemptSecret).toMatch(/^tula_at_/)
    }
    expect(answers).toEqual([
      { status: 'needs_first_factor', strategies: ['password', 'email_code'] },
      { status: 'needs_first_factor', strategies: ['password', 'email_code'] },
    ])
    // The password route completes an attempt that offered the password.
    const attempt = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    const done = await post(`/sign-ins/${attempt.id}/password`, { password: PASSWORD })
    expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
  })

  test('a user with a second factor gets needs_second_factor: no tokens in the body and no cookie', async () => {
    await register()
    spies.push(spyOn(Factors, 'requiredFor').mockResolvedValue(['totp']))
    const attempt = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    const res = await post(`/sign-ins/${attempt.id}/password`, { password: PASSWORD })
    expect(res.status).toBe(200)
    expect(await json<unknown>(res)).toEqual({
      id: attempt.id,
      kind: 'sign_in',
      expiresAt: attempt.expiresAt,
      step: { status: 'needs_second_factor', options: ['totp'] },
    })
    expect(setCookie(res)).toBe('')
    expect(res.headers.get('cache-control')).toBe('no-store')
    // No route accepts the first factor again, so the attempt cannot be finished without one.
    const again = await post(`/sign-ins/${attempt.id}/password`, { password: PASSWORD })
    expect(await code(again)).toBe('flow.invalid_step')
    expect(setCookie(again)).toBe('')
  })

  test('a password reset for a user with a second factor does not sign them in', async () => {
    await register()
    deps.clock.advance('1m')
    spies.push(spyOn(Factors, 'requiredFor').mockResolvedValue(['totp']))
    const attempt = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }))
    const res = await post(`/password-resets/${attempt.id}/password`, {
      code: sentCode(),
      password: 'a brand new passphrase 42',
    })
    expect(res.status).toBe(200)
    const body = await json<FlowAttempt>(res)
    expect(body.step).toEqual({ status: 'needs_second_factor', options: ['totp'] })
    expect(body).not.toHaveProperty('session')
    expect(setCookie(res)).toBe('')
  })
})
