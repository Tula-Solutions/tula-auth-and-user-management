import { afterAll, afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type FlowAttempt,
  HOOK_QUESTION_SCHEMAS,
  type OAuthStart,
} from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Flows from '~/modules/flow/service'
import * as Hooks from '~/modules/hook/service'
import * as OAuth from '~/modules/oauth/service'
import * as Users from '~/modules/user/service'
import * as Verification from '~/modules/verification/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// Where the `before_sign_up` hook is asked, on every way an account comes to exist, and what
// a denial and a failure leave behind (ADR 0035). The receiver is a listener in this process.

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }

const EMAIL = 'Maya@Northline.app'
const NORMALIZED = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const REDIRECT = 'https://app.northline.app/oauth/callback'
const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'

const web: Flows.ClientContext = {
  client: 'web',
  userAgent: 'Mozilla/5.0 (Macintosh) Canary-UA/1',
  ipAddress: '203.0.113.7',
  originAllowed: true,
}

let asked: { data: Record<string, unknown>; raw: string }[] = []
let respond: () => Response | Promise<Response>
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const raw = await req.text()
    asked.push({ data: (JSON.parse(raw) as { data: Record<string, unknown> }).data, raw })
    return respond()
  },
})
afterAll(() => listener.stop(true))

const answers =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status })
const allow = answers({ decision: 'allow' })
const deny = answers({ decision: 'deny', code: 'disposable_email' })
const broken = answers({ error: 'boom' }, 500)

let deps: TestDeps
let app: ReturnType<typeof createApp>
let spies: Mock<(...args: never[]) => unknown>[] = []

beforeEach(async () => {
  asked = []
  respond = allow
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => undefined))
  }
})

afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

function hook(input: Partial<Parameters<typeof Hooks.create>[2]> = {}, scope: Tenant = tenant) {
  return Hooks.create(
    deps,
    scope,
    {
      point: 'before_sign_up',
      url: `http://127.0.0.1:${listener.port}/tula/before-sign-up`,
      enabled: true,
      deadlineMs: 100,
      failureMode: 'deny',
      ...input,
    },
    TEST_ACTOR
  )
}

function configure(signUpPassword: 'required' | 'optional' = 'required') {
  deps.environmentSettings.seed(tenant.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      signIn: {
        methods: {
          password: { enabled: true },
          emailCode: { enabled: true },
          emailLink: { enabled: false },
          passkey: { enabled: false },
        },
      },
      signUp: { password: signUpPassword },
      urls: { allowedOrigins: [], allowedRedirectUrls: [REDIRECT] },
    },
  })
}

async function rejection(work: Promise<unknown>): Promise<ServiceException> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  )
  if (!(error instanceof ServiceException)) {
    throw new Error(`expected a ServiceException, got ${String(error)}`)
  }
  return error
}

const ref = (attempt: Pick<FlowAttempt, 'id' | 'attemptSecret'>): Flows.AttemptRef => ({
  id: attempt.id,
  secret: attempt.attemptSecret,
})

/** The 6-digit code in the most recent email. */
function sentCode(): string {
  const code = /\b(\d{6})\b/.exec(deps.mailer.last().text)?.[1]
  if (!code) {
    throw new Error('no code in the last email')
  }
  return code
}

/** Start a sign-up; `null` for the password is a sign-up without one. */
const start = (password: string | null = PASSWORD, email = EMAIL) =>
  Flows.signUp(deps, tenant, { email, ...(password !== null && { password }) }, web)

const verify = (attempt: Pick<FlowAttempt, 'id' | 'attemptSecret'>, code: string) =>
  Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), code, web)

const userCount = () =>
  deps.users
    .list(tenant.environmentId, { page: 1, size: 50, sort: '-createdAt' })
    .then((page) => page.totalCount)
/** Sessions that were ever created: each is recorded as it is stored. */
const sessionCount = () =>
  deps.activityLog.entries.filter((entry) => entry.type === 'session.created').length
const created = () => deps.activityLog.entries.filter((entry) => entry.type === 'user.created')

/** Nothing of an account exists: no user, no identity, no session, no `user.created`. */
async function expectNothingLeft(): Promise<void> {
  expect(await deps.users.findByEmail(tenant.environmentId, NORMALIZED)).toBeNull()
  expect(await userCount()).toBe(0)
  expect(sessionCount()).toBe(0)
  expect(created()).toEqual([])
  expect(deps.activityLog.outbox.filter((event) => event.type === 'user.created')).toEqual([])
}

describe.each([
  ['with a password', 'required', PASSWORD, 'password'],
  ['without a password', 'optional', null, 'passwordless'],
] as const)('a sign-up %s', (_name, mode, password, method) => {
  beforeEach(() => configure(mode))

  test('the start asks nothing, for a new address and for one that has an account', async () => {
    await hook()
    await start(password)
    expect(asked).toEqual([])
    const code = sentCode()
    const first = await start(password, 'second@northline.app')
    await verify(first.attempt, sentCode())
    asked = []
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    // The address now has an account: the start still answers the same and asks nothing.
    const again = await start(password, 'second@northline.app')
    expect(again.attempt.step.status).toBe('needs_email_verification')
    expect(asked).toEqual([])
    expect(code).toHaveLength(6)
  })

  test('a wrong code asks nothing; the right one asks once, before the account exists', async () => {
    await hook()
    const { attempt } = await start(password)
    const code = sentCode()
    const wrong = code === '000000' ? '000001' : '000000'
    expect((await rejection(verify(attempt, wrong))).code).toBe('verification.invalid_code')
    expect(asked).toEqual([])
    respond = async () => {
      // Asked before anything is created.
      await expectNothingLeft()
      return allow()
    }
    const done = await verify(attempt, code)
    expect(done.attempt.step.status).toBe('complete')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.data).toEqual({
      email: NORMALIZED,
      method,
      client: 'web',
      ipAddress: '203.0.113.7',
    })
    expect(
      HOOK_QUESTION_SCHEMAS.before_sign_up.safeParse(JSON.parse(asked[0]?.raw ?? '')).success
    ).toBe(true)
    expect(created()[0]?.data).not.toHaveProperty('hookBypassed')
  })

  test('the question never holds the password, the code, the attempt or the user agent', async () => {
    await hook()
    const { attempt } = await start(password)
    const code = sentCode()
    const state = JSON.stringify(
      (await deps.flowAttempts.findById(tenant.environmentId, attempt.id))?.state
    )
    await verify(attempt, code)
    const raw = asked[0]?.raw ?? ''
    for (const secret of [
      PASSWORD,
      code,
      attempt.id,
      attempt.attemptSecret ?? 'none',
      'Canary-UA',
      'argon2',
    ]) {
      expect(raw).not.toContain(secret)
    }
    if (password !== null) {
      expect(state).toContain('argon2')
    }
  })

  test('a decoy attempt (the address has an account) never asks, whatever code is tried', async () => {
    const first = await start(password)
    await verify(first.attempt, sentCode())
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await hook()
    respond = deny
    const { attempt } = await start(password)
    for (const code of ['000000', '123456', '999999']) {
      expect((await rejection(verify(attempt, code))).code).toBe('verification.invalid_code')
    }
    expect(asked).toEqual([])
  })

  test('a denial tells the client the operator’s code and leaves nothing behind', async () => {
    await hook()
    respond = deny
    const { attempt } = await start(password)
    const code = sentCode()
    const error = await rejection(verify(attempt, code))
    expect(error.code).toBe('hook.denied')
    expect(error.status).toBe(403)
    expect(error.params).toEqual({ code: 'disposable_email' })
    await expectNothingLeft()
    // The attempt has ended: the same code, or any other call, finds nothing to continue.
    expect(await deps.flowAttempts.findById(tenant.environmentId, attempt.id)).toBeNull()
    respond = allow
    expect((await rejection(verify(attempt, code))).code).toBe('flow.not_found')
    expect(
      (await rejection(Flows.resendCode(deps, tenant, 'sign_up', ref(attempt), web))).code
    ).toBe('flow.not_found')
    expect(asked).toHaveLength(1)
    await expectNothingLeft()
  })

  test('after a denial the same person can start again and be asked again', async () => {
    await hook()
    respond = deny
    const first = await start(password)
    await rejection(verify(first.attempt, sentCode()))
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    respond = allow
    const second = await start(password)
    expect((await verify(second.attempt, sentCode())).attempt.step.status).toBe('complete')
    expect(asked).toHaveLength(2)
    expect(await userCount()).toBe(1)
  })

  test.each([
    ['a failing endpoint', broken],
    ['an endpoint that hangs', () => new Promise<Response>(() => undefined)],
    [
      'an answer that tries to mark the address verified',
      answers({ decision: 'allow', emailVerified: true }),
    ],
  ])(
    '%s refuses the sign-up as unavailable, and leaves nothing behind',
    async (_case, responder) => {
      await hook()
      respond = responder
      const { attempt } = await start(password)
      const started = performance.now()
      const error = await rejection(verify(attempt, sentCode()))
      expect(performance.now() - started).toBeLessThan(1500)
      expect(error.code).toBe('hook.unavailable')
      expect(error.status).toBe(503)
      await expectNothingLeft()
      expect(await deps.flowAttempts.findById(tenant.environmentId, attempt.id)).toBeNull()
    }
  )

  test('a hook that allows on failure lets the sign-up through, and the account says so', async () => {
    const { id } = await hook({ failureMode: 'allow' })
    respond = broken
    const { attempt } = await start(password)
    const done = await verify(attempt, sentCode())
    expect(done.attempt.step.status).toBe('complete')
    expect(created()).toHaveLength(1)
    expect(created()[0]?.data).toMatchObject({ method: 'sign_up', hookBypassed: true })
    const [event] = deps.activityLog.outbox.filter((one) => one.type === 'user.created')
    expect(event?.payload).toMatchObject({ data: { hookBypassed: true } })
    expect((await Hooks.get(deps, tenant, id)).lastFailureReason).toBe('status_not_ok')
  })
})

/** What the one session of a user says it was authenticated with. */
async function authMethodsOf(userId: string | undefined): Promise<string[] | undefined> {
  const [session] = await deps.sessions.listActiveByUser(
    tenant.environmentId,
    userId ?? '',
    deps.clock.now()
  )
  return session?.authMethods
}

describe('a hook is not an authority', () => {
  beforeEach(() => configure('required'))

  // With `failureMode: 'allow'` the account is created even though the answer was refused
  // as an answer: so if anything of it leaked into the account, this is where it would show.
  test.each([
    [{ decision: 'allow', emailVerified: false }],
    [{ decision: 'allow', userId: '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01' }],
    [
      {
        decision: 'allow',
        email: 'attacker@evil.example',
        user: { email: 'attacker@evil.example' },
      },
    ],
    [{ decision: 'allow', skipSecondFactor: true, amr: ['mfa'], authMethods: ['mfa', 'otp'] }],
    [{ decision: 'allow', firstName: 'Mallory', bannedAt: null, claims: { role: 'admin' } }],
  ])('an answer carrying %p changes nothing about the account or its session', async (answer) => {
    // The account an untouched sign-up makes, with no hook at all.
    const plain = await start()
    const plainDone = await verify(plain.attempt, sentCode())
    const expected = await deps.users.findByEmail(tenant.environmentId, NORMALIZED)
    const expectedMethods = await authMethodsOf(expected?.id)

    deps = createTestDeps()
    deps.environments.add({
      id: tenant.environmentId,
      projectId: tenant.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
    configure('required')
    await hook({ failureMode: 'allow' })
    respond = answers(answer)
    const { attempt } = await start()
    const done = await verify(attempt, sentCode())
    const user = await deps.users.findByEmail(tenant.environmentId, NORMALIZED)
    const methods = await authMethodsOf(user?.id)

    const shape = (one: typeof user) => ({
      email: one?.email,
      emailNormalized: one?.emailNormalized,
      verified: one?.emailVerifiedAt !== null,
      firstName: one?.firstName,
      lastName: one?.lastName,
      banned: one?.bannedAt,
    })
    expect(shape(user)).toEqual(shape(expected))
    expect(user?.id).not.toBe('0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01')
    expect(methods).toEqual(expectedMethods)
    expect(methods).toEqual(['email'])
    expect(done.attempt.step.status).toBe(plainDone.attempt.step.status)
    expect(await deps.users.findByEmail(tenant.environmentId, 'attacker@evil.example')).toBeNull()
  })

  test('with two-step verification required, an allow still ends at enrolment and no session', async () => {
    deps.environmentSettings.seed(tenant.environmentId, {
      revision: 2,
      settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, mfa: { policy: 'required' } },
    })
    await hook()
    respond = answers({ decision: 'allow' })
    const { attempt } = await start()
    const done = await verify(attempt, sentCode())
    expect(done.attempt.step.status).toBe('needs_factor_enrolment')
    expect(done.tokens).toBeUndefined()
    expect(sessionCount()).toBe(0)
  })
})

describe('the hook as it is when the account is about to be created', () => {
  beforeEach(() => configure('required'))

  test('registered after the attempt started: asked', async () => {
    const { attempt } = await start()
    const code = sentCode()
    await hook()
    respond = deny
    expect((await rejection(verify(attempt, code))).code).toBe('hook.denied')
  })

  test('removed mid-attempt: not asked', async () => {
    const { id } = await hook()
    respond = deny
    const { attempt } = await start()
    await Hooks.remove(deps, tenant, id, TEST_ACTOR)
    expect((await verify(attempt, sentCode())).attempt.step.status).toBe('complete')
    expect(asked).toEqual([])
  })

  test('switched off mid-attempt: not asked; switched to allow on failure: let through', async () => {
    const { id } = await hook()
    respond = broken
    const first = await start()
    const firstCode = sentCode()
    await Hooks.update(deps, tenant, id, { failureMode: 'allow' }, TEST_ACTOR)
    expect((await verify(first.attempt, firstCode)).attempt.step.status).toBe('complete')
    expect(created()[0]?.data).toMatchObject({ hookBypassed: true })
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const second = await start(PASSWORD, 'second@northline.app')
    const secondCode = sentCode()
    await Hooks.update(deps, tenant, id, { enabled: false }, TEST_ACTOR)
    asked = []
    expect((await verify(second.attempt, secondCode)).attempt.step.status).toBe('complete')
    expect(asked).toEqual([])
    expect(created()[1]?.data).not.toHaveProperty('hookBypassed')
  })

  test('another environment’s hook is never asked about this one’s sign-ups', async () => {
    await hook({}, otherTenant)
    respond = deny
    const { attempt } = await start()
    expect((await verify(attempt, sentCode())).attempt.step.status).toBe('complete')
    expect(asked).toEqual([])
  })

  test('the attempt’s own checks come first: without its secret nothing is asked', async () => {
    await hook()
    const { attempt } = await start()
    const code = sentCode()
    const foreign = { ...web, originAllowed: false }
    for (const work of [
      Flows.verifyEmail(deps, tenant, 'sign_up', { id: attempt.id, secret: undefined }, code, web),
      Flows.verifyEmail(
        deps,
        tenant,
        'sign_up',
        { id: attempt.id, secret: 'tula_at_wrong' },
        code,
        web
      ),
      Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), code, foreign),
      Flows.verifyEmail(deps, otherTenant, 'sign_up', ref(attempt), code, web),
    ]) {
      await rejection(work)
    }
    expect(asked).toEqual([])
  })

  test('the environment’s cap on hook calls refuses the request and keeps the attempt', async () => {
    await hook()
    const { attempt } = await start()
    const code = sentCode()
    const hit = deps.rateLimiter.hit.bind(deps.rateLimiter)
    spies.push(
      spyOn(deps.rateLimiter, 'hit').mockImplementation((key, limit, windowMs) =>
        key === Hooks.hookCallsKey(tenant)
          ? Promise.resolve({ allowed: false, remaining: 0, retryAfterMs: 1000 })
          : hit(key, limit, windowMs)
      )
    )
    expect((await rejection(verify(attempt, code))).code).toBe('rate_limited')
    expect(asked).toEqual([])
    await expectNothingLeft()
    expect(await deps.flowAttempts.findById(tenant.environmentId, attempt.id)).not.toBeNull()
  })
})

describe('when ending the attempt fails', () => {
  beforeEach(() => configure('required'))

  test.each([
    ['a denial', deny, 'hook.denied'],
    ['a failed hook', broken, 'hook.unavailable'],
  ] as const)(
    '%s is still what the client hears, and nothing of an account exists',
    async (_name, responder, code) => {
      await hook()
      respond = responder
      const { attempt } = await start()
      const sent = sentCode()
      spies.push(
        spyOn(deps.flowAttempts, 'delete').mockRejectedValue(
          new Error('connection to postgres://tula:canary-password@db lost')
        )
      )
      const error = await rejection(verify(attempt, sent))
      expect(error.code).toBe(code)
      await expectNothingLeft()
      const lines = JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
      expect(lines).toContain(attempt.id)
      expect(lines).not.toContain('canary-password')
    }
  )
})

describe('the cap on hook calls and a spent code', () => {
  beforeEach(() => configure('required'))

  // Accepted and documented (docs/hooks.md, ADR 0035): the cap is counted after the code is
  // spent, so that nobody without the inbox can use it up.
  test('over the cap the code is already spent: the same code is refused, a new one works', async () => {
    await hook()
    const { attempt } = await start()
    const code = sentCode()
    const hit = deps.rateLimiter.hit.bind(deps.rateLimiter)
    const capped = spyOn(deps.rateLimiter, 'hit').mockImplementation((key, limit, windowMs) =>
      key === Hooks.hookCallsKey(tenant)
        ? Promise.resolve({ allowed: false, remaining: 0, retryAfterMs: 1000 })
        : hit(key, limit, windowMs)
    )
    expect((await rejection(verify(attempt, code))).code).toBe('rate_limited')
    capped.mockRestore()
    expect((await rejection(verify(attempt, code))).code).toMatch(/^verification\./)
    expect(asked).toEqual([])
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await Flows.resendCode(deps, tenant, 'sign_up', ref(attempt), web)
    expect((await verify(attempt, sentCode())).attempt.step.status).toBe('complete')
    expect(asked).toHaveLength(1)
  })

  test('a wrong code never reaches the cap: it cannot be used up without the inbox', async () => {
    await hook()
    const { attempt } = await start()
    const code = sentCode()
    const counted = spyOn(deps.rateLimiter, 'hit')
    spies.push(counted)
    await rejection(verify(attempt, code === '000000' ? '000001' : '000000'))
    expect(counted.mock.calls.map(([key]) => key)).not.toContain(Hooks.hookCallsKey(tenant))
  })
})

describe('an administrator creating a user', () => {
  test('does not ask the hook: it is the operator’s own act', async () => {
    await hook()
    respond = deny
    const user = await Users.create(deps, tenant, { email: EMAIL, password: PASSWORD }, TEST_ACTOR)
    expect(user.id).toBeDefined()
    expect(asked).toEqual([])
    expect(created()[0]?.data).toEqual({ method: 'admin', emailVerified: false })
  })
})

describe('a first sign-in with a provider', () => {
  const origin = { ipAddress: '198.51.100.9', userAgent: 'Canary-UA/1' }
  const profile = { subject: 'google-subject-1', email: 'Maya@Northline.app', emailVerified: true }
  const resolve = (answer: Parameters<typeof OAuth.resolveAccount>[3] = profile) =>
    OAuth.resolveAccount(deps, tenant, 'google', answer, origin, 'ios')

  test('asks before the account is created, with the provider as the method', async () => {
    await hook()
    respond = async () => {
      await expectNothingLeft()
      return allow()
    }
    const { created: isNew } = await resolve()
    expect(isNew).toBe(true)
    expect(asked.map((one) => one.data)).toEqual([
      { email: NORMALIZED, method: 'oauth_google', client: 'ios', ipAddress: '198.51.100.9' },
    ])
    expect(asked[0]?.raw).not.toContain('google-subject-1')
    expect(asked[0]?.raw).not.toContain('Canary-UA')
  })

  test('a denial creates no user and no identity', async () => {
    await hook()
    respond = deny
    const error = await rejection(resolve())
    expect(error.code).toBe('hook.denied')
    expect(error.params).toEqual({ code: 'disposable_email' })
    await expectNothingLeft()
    expect(
      await deps.users.findByIdentity(tenant.environmentId, 'google', 'google-subject-1')
    ).toBeNull()
  })

  test('a failure refuses by default and creates nothing; with allow on failure the account says so', async () => {
    const { id } = await hook()
    respond = broken
    expect((await rejection(resolve())).code).toBe('hook.unavailable')
    await expectNothingLeft()
    await Hooks.update(deps, tenant, id, { failureMode: 'allow' }, TEST_ACTOR)
    expect((await resolve()).created).toBe(true)
    expect(created()[0]?.data).toMatchObject({ method: 'oauth_google', hookBypassed: true })
  })

  test('an identity that is already a user’s signs in without asking', async () => {
    await resolve()
    await hook()
    respond = deny
    expect((await resolve()).created).toBe(false)
    expect(asked).toEqual([])
  })

  test('an address that already has an account is linked or refused as before, without asking', async () => {
    configure('required')
    const first = await start()
    await verify(first.attempt, sentCode())
    await hook()
    respond = deny
    const linked = await resolve()
    expect(linked).toMatchObject({ created: false, linked: true })
    expect(asked).toEqual([])
  })

  test.each([
    ['no address', { ...profile, email: null }, 'oauth.email_missing'],
    ['an unverified address', { ...profile, emailVerified: false }, 'oauth.email_unverified'],
  ] as const)(
    'a profile with %s is refused before anything is asked',
    async (_name, answer, code) => {
      await hook()
      expect((await rejection(resolve(answer))).code).toBe(code)
      expect(asked).toEqual([])
    }
  )

  test('the hook is asked once even when the insert loses a race and the account is looked at again', async () => {
    await hook()
    const create = deps.users.create.bind(deps.users)
    spies.push(
      spyOn(deps.users, 'create')
        .mockImplementationOnce(async () => false)
        .mockImplementation(create)
    )
    await resolve().catch(() => undefined)
    expect(asked).toHaveLength(1)
  })

  describe('over HTTP', () => {
    const headers = {
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
      'x-tula-client': 'ios',
    }
    const post = (path: string, body: unknown) =>
      app.request(`/v1/client${path}`, { method: 'POST', headers, body: JSON.stringify(body) })

    async function roundTrip() {
      const started = (await (
        await post('/sign-ins/oauth', { provider: 'google', redirectUrl: REDIRECT })
      ).json()) as OAuthStart
      const state = new URL(started.authorizationUrl).searchParams.get('state') ?? ''
      const back = await app.request(
        `/v1/oauth/callback/google?${new URLSearchParams({ state, code: 'c' })}`
      )
      const location = back.headers.get('location') ?? ''
      const params = new URLSearchParams(location.slice(location.indexOf('#') + 1))
      return {
        ticket: params.get('tula_ticket'),
        attemptId: params.get('tula_attempt'),
        binding: started.binding,
      }
    }

    beforeEach(async () => {
      configure('required')
      await seedApiKey(deps, PK)
      await seedApiKey(deps, SK)
      app = createApp(deps)
      const res = await app.request('/v1/admin/oauth-providers/google', {
        method: 'PUT',
        headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: 'google-client-id', clientSecret: 'GOCSPX-test-secret' }),
      })
      expect(res.status).toBe(200)
    })

    test('a denied first sign-in answers the denial, sets no cookie and creates nothing', async () => {
      await hook()
      respond = deny
      const res = await post('/sign-ins/oauth/exchange', await roundTrip())
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({
        code: 'hook.denied',
        params: { code: 'disposable_email' },
      })
      expect(res.headers.get('set-cookie')).toBeNull()
      await expectNothingLeft()
      expect(asked).toHaveLength(1)
    })

    test('an allowed one completes', async () => {
      await hook()
      const res = await post('/sign-ins/oauth/exchange', await roundTrip())
      expect(res.status).toBe(200)
      expect(((await res.json()) as FlowAttempt).step.status).toBe('complete')
      expect(asked[0]?.data).toMatchObject({ method: 'oauth_google', client: 'ios' })
    })
  })
})
