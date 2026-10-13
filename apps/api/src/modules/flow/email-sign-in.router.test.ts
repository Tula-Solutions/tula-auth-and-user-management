import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  ClientConfigSchema,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  FLOW_ATTEMPT_HEADER,
  type FlowAttempt,
} from '@tula/contract'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Flows from '~/modules/flow/router'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import { refreshCookieName } from '~/modules/session/cookies'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const REDIRECT = 'https://app.northline.test/auth/link'
const APP_ORIGIN = 'https://app.northline.test'
const COOKIE = refreshCookieName(TEST_CONFIG, TEST_TENANT.environmentId)

let deps: TestDeps
let app: ReturnType<typeof createApp>
let secrets: Map<string, string>

function settings(overrides: Partial<EnvironmentSettings> = {}): EnvironmentSettings {
  return {
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    signIn: {
      methods: {
        password: { enabled: true },
        emailCode: { enabled: true },
        emailLink: { enabled: true },
        passkey: { enabled: false },
        smsCode: { enabled: false },
      },
    },
    urls: { allowedOrigins: [APP_ORIGIN], allowedRedirectUrls: [REDIRECT] },
    ...overrides,
  }
}

async function build(config = TEST_CONFIG, document = settings()) {
  secrets = new Map()
  deps = createTestDeps({ config })
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  deps.environmentSettings.seed(TEST_TENANT.environmentId, { revision: 1, settings: document })
  await seedApiKey(deps, PK)
  await deps.users.create(
    {
      id: deps.ids.next(),
      projectId: TEST_TENANT.projectId,
      environmentId: TEST_TENANT.environmentId,
      email: EMAIL,
      emailNormalized: EMAIL,
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: await Passwords.hash(PASSWORD),
    },
    Audit.none('fixture')
  )
  app = createApp(deps)
}

beforeEach(() => build())
afterEach(() => Notices.settled())

interface Options {
  origin?: string
  client?: string
  /** `null` sends no `x-tula-attempt`; left out, the attempt's own secret is sent. */
  attempt?: string | null
  key?: string | null
}

const ATTEMPT_PATH = /^\/sign-(?:ups|ins)\/([^/]+)\//

async function post(path: string, body: unknown = {}, options: Options = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.key !== null) {
    headers['x-tula-publishable-key'] = options.key ?? PK
  }
  if (options.client) {
    headers['x-tula-client'] = options.client
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

async function startSignIn(options: Options = {}, identifier = EMAIL) {
  const res = await post('/sign-ins', { identifier }, options)
  expect(res.status).toBe(200)
  return json<FlowAttempt>(res)
}

function sentCode(): string {
  const message = deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))
  return message?.subject.slice(0, 6) ?? ''
}

function sentLink(): { token: string; attemptId: string } {
  const url = /https?:\/\/\S+#\S+/.exec(deps.mailer.last().text)?.[0] ?? 'http://none/#'
  const fragment = new URLSearchParams(new URL(url).hash.slice(1))
  return { token: fragment.get('tula_link') ?? '', attemptId: fragment.get('tula_attempt') ?? '' }
}

async function askForLink(options: Options = {}) {
  const attempt = await startSignIn(options)
  const res = await post(
    `/sign-ins/${attempt.id}/first-factor/prepare`,
    { strategy: 'email_link', redirectUrl: REDIRECT },
    options
  )
  expect(res.status).toBe(200)
  const prepared = await json<FlowAttempt>(res)
  return { attempt, binding: prepared.linkBinding ?? '', response: res }
}

describe('what the environment offers', () => {
  test('the client config lists the email methods and the sign-up mode', async () => {
    await build(TEST_CONFIG, settings({ signUp: { password: 'optional' } }))
    const res = await app.request('/v1/client/config', {
      headers: { 'x-tula-publishable-key': PK },
    })
    expect(ClientConfigSchema.parse(await res.json())).toMatchObject({
      signIn: { methods: ['password', 'emailCode', 'emailLink'] },
      signUp: { password: 'optional' },
    })
  })
})

describe('signing in with an emailed code over HTTP', () => {
  test('start, ask for the code, submit it: a browser gets a cookie and no refresh token', async () => {
    const attempt = await startSignIn()
    expect(attempt.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'email_link'],
    })

    const prepared = await post(`/sign-ins/${attempt.id}/first-factor/prepare`, {
      strategy: 'email_code',
    })
    expect(prepared.status).toBe(200)
    expect(prepared.headers.get('cache-control')).toBe('no-store')
    expect(prepared.headers.get('set-cookie')).toBeNull()
    const waiting = await json<FlowAttempt>(prepared)
    expect(waiting.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'email_link'],
      prepared: { strategy: 'email_code', destination: 'm***@northline.app' },
    })
    expect(waiting.attemptSecret).toBeUndefined()
    expect(waiting.linkBinding).toBeUndefined()

    const done = await post(`/sign-ins/${attempt.id}/first-factor/attempt`, {
      strategy: 'email_code',
      code: sentCode(),
    })
    expect(done.status).toBe(200)
    expect(done.headers.get('cache-control')).toBe('no-store')
    expect(done.headers.get('set-cookie')).toContain(`${COOKIE}=`)
    expect(done.headers.get('set-cookie')).toContain('HttpOnly')
    const completed = await json<FlowAttempt>(done)
    expect(completed.step.status).toBe('complete')
    expect(completed.session?.accessToken).toBeString()
    expect(completed.session?.refreshToken).toBeUndefined()
  })

  test('a native client gets the refresh token in the body and no cookie', async () => {
    const attempt = await startSignIn({ client: 'ios' })
    await post(`/sign-ins/${attempt.id}/first-factor/prepare`, { strategy: 'email_code' })
    const done = await post(`/sign-ins/${attempt.id}/first-factor/attempt`, {
      strategy: 'email_code',
      code: sentCode(),
    })
    expect(done.headers.get('set-cookie')).toBeNull()
    expect((await json<FlowAttempt>(done)).session?.refreshToken).toBeString()
  })

  test('a wrong code is 422 in the contract envelope', async () => {
    const attempt = await startSignIn()
    await post(`/sign-ins/${attempt.id}/first-factor/prepare`, { strategy: 'email_code' })
    const res = await post(`/sign-ins/${attempt.id}/first-factor/attempt`, {
      strategy: 'email_code',
      code: sentCode() === '000000' ? '000001' : '000000',
    })
    expect(res.status).toBe(422)
    expect(await json<unknown>(res)).toMatchObject({
      status: 422,
      code: 'verification.invalid_code',
      params: { attemptsRemaining: 4 },
    })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test.each<[string, string, object]>([
    ['an unknown strategy', 'prepare', { strategy: 'carrier_pigeon' }],
    ['the password strategy', 'prepare', { strategy: 'password' }],
    ['no strategy', 'prepare', {}],
    ['a code that is not six digits', 'attempt', { strategy: 'email_code', code: '12345' }],
    ['a code with letters', 'attempt', { strategy: 'email_code', code: '12a456' }],
    ['no code', 'attempt', { strategy: 'email_code' }],
    ['an unknown strategy', 'attempt', { strategy: 'passkey' }],
  ])('%s to %s is a validation error', async (_, action, body) => {
    const attempt = await startSignIn()
    const res = await post(`/sign-ins/${attempt.id}/first-factor/${action}`, body)
    expect(res.status).toBe(422)
    expect((await json<{ code: string }>(res)).code).toBe('validation.failed')
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test.each(['prepare', 'attempt'])(
    '%s without the attempt secret is 404 flow.not_found',
    async (action) => {
      const attempt = await startSignIn()
      const body = action === 'prepare' ? { strategy: 'email_code' } : { strategy: 'email_link' }
      for (const presented of [null, 'tula_at_wrong']) {
        const res = await post(`/sign-ins/${attempt.id}/first-factor/${action}`, body, {
          attempt: presented,
        })
        expect(res.status).toBe(404)
        expect((await json<{ code: string }>(res)).code).toBe('flow.not_found')
      }
      expect(deps.mailer.outbox).toHaveLength(0)
    }
  )

  test.each([
    [
      '/sign-ins/00000000-0000-7000-8000-00000000dead/first-factor/prepare',
      { strategy: 'email_code' },
    ],
    [
      '/sign-ins/00000000-0000-7000-8000-00000000dead/first-factor/attempt',
      { strategy: 'email_link' },
    ],
    ['/sign-ins/link', { token: 'x', attemptId: '00000000-0000-7000-8000-00000000dead' }],
  ])('%s needs a publishable key', async (path, body) => {
    const res = await post(path, body, { key: null })
    expect(res.status).toBe(401)
    expect((await json<{ code: string }>(res)).code).toBe('auth.invalid_key')
  })
})

describe('signing in with an emailed link over HTTP', () => {
  test('the asking browser is given a binding once; the link is accepted with it; the starting client completes', async () => {
    const { attempt, binding, response } = await askForLink()
    expect(binding).toMatch(/^tula_lb_/)
    expect(response.headers.get('cache-control')).toBe('no-store')

    const pending = await post(`/sign-ins/${attempt.id}/first-factor/attempt`, {
      strategy: 'email_link',
    })
    expect(pending.status).toBe(200)
    const still = await json<FlowAttempt>(pending)
    expect(still.step.status).toBe('needs_first_factor')
    expect(still.session).toBeUndefined()
    expect(still.linkBinding).toBeUndefined()
    expect(pending.headers.get('set-cookie')).toBeNull()

    const opened = await post('/sign-ins/link', { ...sentLink(), binding })
    expect(opened.status).toBe(200)
    expect(opened.headers.get('cache-control')).toBe('no-store')
    // Opening the link signs nobody in: no cookie, no tokens.
    expect(opened.headers.get('set-cookie')).toBeNull()
    expect(await json<unknown>(opened)).toEqual({ status: 'verified' })

    const done = await post(`/sign-ins/${attempt.id}/first-factor/attempt`, {
      strategy: 'email_link',
    })
    expect(done.headers.get('set-cookie')).toContain(`${COOKIE}=`)
    expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
  })

  test('without the binding the link is 409 different_browser and sets nothing', async () => {
    await askForLink()
    const res = await post('/sign-ins/link', sentLink())
    expect(res.status).toBe(409)
    expect(await json<unknown>(res)).toMatchObject({
      status: 409,
      code: 'verification.different_browser',
    })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('a dead link is 410 verification.expired', async () => {
    const { binding } = await askForLink()
    const res = await post('/sign-ins/link', { ...sentLink(), token: 'y'.repeat(43), binding })
    expect(res.status).toBe(410)
    expect((await json<{ code: string }>(res)).code).toBe('verification.expired')
  })

  test('a redirect URL that is not on the allow-list is 400 and sends nothing', async () => {
    await build({ ...TEST_CONFIG, tier: 'prod' })
    const attempt = await startSignIn({ origin: APP_ORIGIN })
    const res = await post(
      `/sign-ins/${attempt.id}/first-factor/prepare`,
      { strategy: 'email_link', redirectUrl: `${REDIRECT}?next=https://evil.test` },
      { origin: APP_ORIGIN }
    )
    expect(res.status).toBe(400)
    expect(await json<unknown>(res)).toMatchObject({
      status: 400,
      code: 'request.redirect_not_allowed',
    })
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test.each(['ios', 'web'])(
    'a listed custom scheme is never an emailed link’s page, for a %s attempt: 400, a fixed reason, nothing sent',
    async (client) => {
      // An emailed link is opened by whatever the mail app hands it to, and its token would
      // arrive at whichever app claimed the scheme (ADR 0044).
      const custom = 'test.northline.app:/auth/link'
      await build(
        { ...TEST_CONFIG, tier: 'prod' },
        settings({
          urls: { allowedOrigins: [APP_ORIGIN], allowedRedirectUrls: [REDIRECT, custom] },
        })
      )
      const attempt = await startSignIn({ origin: APP_ORIGIN, client })
      const res = await post(
        `/sign-ins/${attempt.id}/first-factor/prepare`,
        { strategy: 'email_link', redirectUrl: custom },
        { origin: APP_ORIGIN, client }
      )
      expect(res.status).toBe(400)
      expect(await json<unknown>(res)).toMatchObject({
        code: 'request.redirect_not_allowed',
        params: { reason: 'not_a_provider_sign_in' },
      })
      expect(deps.mailer.outbox).toHaveLength(0)
      // The attempt is not spent: the same step with the web page goes through.
      const again = await post(
        `/sign-ins/${attempt.id}/first-factor/prepare`,
        { strategy: 'email_link', redirectUrl: REDIRECT },
        { origin: APP_ORIGIN, client }
      )
      expect(again.status).toBe(200)
    }
  )

  test.each<[string, object]>([
    ['no token', { attemptId: '00000000-0000-7000-8000-00000000dead' }],
    ['an empty token', { token: '', attemptId: '00000000-0000-7000-8000-00000000dead' }],
    ['no attempt id', { token: 'x' }],
    ['an attempt id that is not a uuid', { token: 'x', attemptId: 'nope' }],
    [
      'an oversized token',
      { token: 'x'.repeat(5000), attemptId: '00000000-0000-7000-8000-00000000dead' },
    ],
  ])('%s is a validation error', async (_, body) => {
    const res = await post('/sign-ins/link', body)
    expect(res.status).toBe(422)
  })

  test('neither the link token nor the binding reaches a log line', async () => {
    const lines: string[] = []
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
      spyOn(logger, level).mockImplementation((message, context) => {
        lines.push(JSON.stringify([message, context]))
      })
    )
    try {
      const { attempt, binding } = await askForLink()
      const link = sentLink()
      await post('/sign-ins/link', link)
      await post('/sign-ins/link', { ...link, binding })
      await post(`/sign-ins/${attempt.id}/first-factor/attempt`, { strategy: 'email_link' })
      const logged = lines.join('\n')
      expect(lines.length).toBeGreaterThan(0)
      expect(logged).not.toContain(link.token)
      expect(logged).not.toContain(binding)
      expect(logged).not.toContain(secrets.get(attempt.id) ?? 'no secret')
      expect(JSON.stringify(deps.activityLog.entries)).not.toContain(link.token)
      expect(JSON.stringify(deps.activityLog.entries)).not.toContain(binding)
    } finally {
      for (const spy of spies) {
        spy.mockRestore()
      }
    }
  })

  test('the redaction list names the link token and the binding', () => {
    expect(logger.REDACTED_KEYS).toEqual(
      expect.arrayContaining(['linkToken', 'linkBinding', 'binding', 'tula_link'])
    )
  })
})

describe('a browser attempt and the page’s origin', () => {
  beforeEach(() => build({ ...TEST_CONFIG, tier: 'prod' }))
  const EVIL = 'https://evil.test'
  const refused = { status: 403, code: 'request.origin_not_allowed' }

  test('asking for a code from a foreign origin is refused and sends nothing', async () => {
    const attempt = await startSignIn({ origin: APP_ORIGIN })
    const res = await post(
      `/sign-ins/${attempt.id}/first-factor/prepare`,
      { strategy: 'email_code' },
      { origin: EVIL }
    )
    expect(res.status).toBe(403)
    expect(await json<unknown>(res)).toMatchObject(refused)
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('the right code from a foreign origin is refused: no session, no cookie, the code unspent', async () => {
    const attempt = await startSignIn({ origin: APP_ORIGIN })
    await post(
      `/sign-ins/${attempt.id}/first-factor/prepare`,
      { strategy: 'email_code' },
      { origin: APP_ORIGIN }
    )
    const body = { strategy: 'email_code', code: sentCode() }
    const foreign = await post(`/sign-ins/${attempt.id}/first-factor/attempt`, body, {
      origin: EVIL,
    })
    expect(foreign.status).toBe(403)
    expect(await json<unknown>(foreign)).toMatchObject(refused)
    expect(foreign.headers.get('set-cookie')).toBeNull()
    expect(deps.activityLog.ofType('session.created')).toHaveLength(0)
    const own = await post(`/sign-ins/${attempt.id}/first-factor/attempt`, body, {
      origin: APP_ORIGIN,
    })
    expect((await json<FlowAttempt>(own)).step.status).toBe('complete')
  })

  test('a link opened on a foreign origin is refused and stays usable; the poll is refused too', async () => {
    const { attempt, binding } = await askForLink({ origin: APP_ORIGIN })
    const link = { ...sentLink(), binding }
    const foreign = await post('/sign-ins/link', link, { origin: EVIL })
    expect(foreign.status).toBe(403)
    expect(await json<unknown>(foreign)).toMatchObject(refused)

    expect((await post('/sign-ins/link', link, { origin: APP_ORIGIN })).status).toBe(200)
    const poll = await post(
      `/sign-ins/${attempt.id}/first-factor/attempt`,
      { strategy: 'email_link' },
      { origin: EVIL }
    )
    expect(poll.status).toBe(403)
    expect(poll.headers.get('set-cookie')).toBeNull()
    expect(deps.activityLog.ofType('session.created')).toHaveLength(0)
  })
})

describe('rate limits per IP', () => {
  test('asking for emails is limited like sign-up', async () => {
    const attempt = await startSignIn()
    const path = `/sign-ins/${attempt.id}/first-factor/prepare`
    for (let sent = 0; sent < Flows.SIGN_UP_RATE_LIMIT; sent++) {
      await post(path, { strategy: 'email_code' })
    }
    const res = await post(path, { strategy: 'email_code' })
    expect(res.status).toBe(429)
    expect((await json<{ code: string }>(res)).code).toBe('rate_limited')
    expect(res.headers.get('retry-after')).toBeString()
  })

  test('people waiting for links do not lock the same IP out of entering codes', async () => {
    const waiting = await askForLink()
    const poll = `/sign-ins/${waiting.attempt.id}/first-factor/attempt`
    // More polls than a code step allows in a minute, as a few waiting tabs behind one NAT make.
    for (let asked = 0; asked < Flows.CREDENTIAL_RATE_LIMIT * 3; asked++) {
      expect((await post(poll, { strategy: 'email_link' })).status).toBe(200)
    }
    // Someone else at that address can still submit a code.
    const other = await startSignIn({}, 'ines@northline.app')
    const res = await post(`/sign-ins/${other.id}/first-factor/attempt`, {
      strategy: 'email_code',
      code: '123456',
    })
    expect(res.status).toBe(410)
    expect((await json<{ code: string }>(res)).code).toBe('verification.expired')
  })

  test('code attempts keep the tight credential limit, whatever the polls did', async () => {
    const attempt = await startSignIn()
    const path = `/sign-ins/${attempt.id}/first-factor/attempt`
    await post(path, { strategy: 'email_link' })
    const body = { strategy: 'email_code', code: '123456' }
    // Without the attempt's secret each one answers 404 before the identifier's lockout is
    // touched, so what refuses the last one can only be the per-IP limit.
    for (let guess = 0; guess < Flows.CREDENTIAL_RATE_LIMIT; guess++) {
      expect((await post(path, body, { attempt: null })).status).toBe(404)
    }
    const res = await post(path, body, { attempt: null })
    expect(res.status).toBe(429)
    expect((await json<{ code: string }>(res)).code).toBe('rate_limited')
    // Polls have their own bucket and still get through.
    expect((await post(path, { strategy: 'email_link' })).status).not.toBe(429)
  })

  test('polls have a limit of their own, sized for a shared address', async () => {
    const { attempt } = await askForLink()
    const path = `/sign-ins/${attempt.id}/first-factor/attempt`
    for (let asked = 0; asked < Flows.EMAIL_LINK_POLL_RATE_LIMIT; asked++) {
      expect((await post(path, { strategy: 'email_link' })).status).toBe(200)
    }
    const res = await post(path, { strategy: 'email_link' })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeString()
    // Room for at least ten tabs asking every three seconds.
    expect(Flows.EMAIL_LINK_POLL_RATE_LIMIT).toBeGreaterThanOrEqual(200)
  })

  test('opening links is limited like any credential step', async () => {
    const body = { token: 'x', attemptId: '00000000-0000-7000-8000-00000000dead' }
    for (let opened = 0; opened < Flows.CREDENTIAL_RATE_LIMIT; opened++) {
      expect((await post('/sign-ins/link', body)).status).toBe(410)
    }
    expect((await post('/sign-ins/link', body)).status).toBe(429)
  })
})

describe('sign-up without a password over HTTP', () => {
  const NEW = 'ines@northline.app'

  test('is refused with a field error where a password is required', async () => {
    const res = await post('/sign-ups', { email: NEW })
    expect(res.status).toBe(422)
    expect(await json<unknown>(res)).toMatchObject({
      code: 'validation.failed',
      errors: [{ field: 'password', code: 'validation.failed' }],
    })
  })

  test('creates the account and signs it in where the environment makes it optional', async () => {
    await build(TEST_CONFIG, settings({ signUp: { password: 'optional' } }))
    const started = await json<FlowAttempt>(await post('/sign-ups', { email: NEW }))
    expect(started.step.status).toBe('needs_email_verification')
    const done = await post(`/sign-ups/${started.id}/verify-email`, { code: sentCode() })
    expect(done.status).toBe(200)
    expect(done.headers.get('set-cookie')).toContain(`${COOKIE}=`)
    expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
    const found = await deps.users.findByEmailWithPassword(TEST_TENANT.environmentId, NEW)
    expect(found?.passwordHash).toBeNull()
  })
})
