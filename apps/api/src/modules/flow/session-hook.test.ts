import { afterAll, afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  type AccessTokenClaims,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  FLOW_ATTEMPT_HEADER,
  type FlowAttempt,
  HOOK_QUESTION_SCHEMAS,
  type OAuthStart,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import { base32Decode, totp } from '~/lib/totp'
import * as Audit from '~/modules/audit/service'
import * as Flows from '~/modules/flow/service'
import * as Hooks from '~/modules/hook/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// Where the `before_session` hook is asked (ADR 0035, "Hooks before a session and before a
// token"): in the flow engine's `finish`, once every factor is proven and immediately before
// the session is created, and nowhere else. And what a denial and a failure leave behind.
// The receiver is a listener in this process; each point has a path of its own on it.

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a brand new passphrase 42'
// One argon2 hash for the whole file: hashing per test would dominate its run time.
const PASSWORD_HASH = await Passwords.hash(PASSWORD)
const REDIRECT = 'https://app.northline.app/oauth/callback'
const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const CANARY = 'Canary-UA-9f3e'
const web: Flows.ClientContext = {
  client: 'web',
  userAgent: `Mozilla/5.0 ${CANARY}`,
  ipAddress: '203.0.113.7',
  originAllowed: true,
}

type Point = 'before_sign_up' | 'before_session' | 'before_token'
interface Asked {
  point: Point
  data: Record<string, unknown>
  raw: string
}

let asked: Asked[] = []
const allow = () => Response.json({ decision: 'allow' })
const deny = () => Response.json({ decision: 'deny', code: 'not_on_the_list' })
const hang = () => new Promise<Response>(() => undefined)
let respond: Record<Point, () => Response | Promise<Response>>
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const point = new URL(req.url).pathname.slice(1) as Point
    const raw = await req.text()
    asked.push({ point, data: (JSON.parse(raw) as { data: Record<string, unknown> }).data, raw })
    return respond[point]()
  },
})
afterAll(() => listener.stop(true))

let deps: TestDeps
let spies: Mock<(...args: never[]) => unknown>[] = []
let revision = 0

function configure(
  switches: {
    policy?: EnvironmentSettings['mfa']['policy']
    sessions?: Partial<EnvironmentSettings['sessions']>
  } = {}
) {
  revision += 1
  deps.environmentSettings.seed(tenant.environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      urls: { allowedOrigins: [], allowedRedirectUrls: [REDIRECT] },
      mfa: { policy: switches.policy ?? 'optional', smsCode: { enabled: false } },
      sessions: { ...DEFAULT_ENVIRONMENT_SETTINGS.sessions, ...switches.sessions },
    },
  })
}

beforeEach(() => {
  asked = []
  revision = 0
  respond = {
    before_sign_up: allow,
    before_session: allow,
    before_token: () => Response.json({ claims: { plan: 'pro' } }),
  }
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => undefined))
  }
})

afterEach(async () => {
  await Notices.settled()
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

const logged = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))

function hook(
  point: Point = 'before_session',
  input: Partial<Parameters<typeof Hooks.create>[2]> = {}
) {
  return Hooks.create(
    deps,
    tenant,
    {
      point,
      url: `http://127.0.0.1:${listener.port}/${point}`,
      enabled: true,
      deadlineMs: 100,
      failureMode: 'deny',
      ...input,
    },
    TEST_ACTOR
  )
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

async function seedUser(options: { email?: string } = {}) {
  const id = deps.ids.next()
  const email = options.email ?? EMAIL
  await deps.users.create(
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email,
      emailNormalized: email,
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: PASSWORD_HASH,
    },
    Audit.none('fixture')
  )
  return id
}

type Presented = Pick<FlowAttempt, 'id' | 'attemptSecret'>
const ref = (attempt: Presented): Flows.AttemptRef => ({
  id: attempt.id,
  secret: attempt.attemptSecret,
})
const codeFor = (secret: string) => totp(base32Decode(secret), deps.clock.now())

/** Turn two-step verification on for a user, outside any attempt. */
async function enrol(userId: string) {
  const { secret } = await Mfa.startTotp(deps, tenant, userId)
  await Mfa.confirmTotp(deps, tenant, { userId }, codeFor(secret), {
    type: 'user',
    id: userId,
    ipAddress: null,
    userAgent: null,
  })
  await Notices.settled()
  // The confirming code's step is spent: the next use needs the next step's.
  deps.clock.advance('30s')
  return secret
}

/** The 6-digit code in the most recent email whose subject leads with one. */
function sentCode(): string {
  const message = deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))
  const code = message ? /^(\d{6}) /.exec(message.subject)?.[1] : undefined
  if (!code) {
    throw new Error('no code was emailed')
  }
  return code
}

const startSignIn = async (identifier = EMAIL) =>
  (await Flows.signIn(deps, tenant, { identifier }, web)).attempt
const password = (attempt: Presented, value = PASSWORD) =>
  Flows.submitPassword(deps, tenant, ref(attempt), value, web)
const signIn = async (value = PASSWORD) => password(await startSignIn(), value)

const sessions = () => deps.activityLog.ofType('session.created')
const liveSessions = (userId: string) =>
  deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
const points = () => asked.map((one) => one.point)
const claimsOf = (result: Flows.FlowResult) =>
  decodeJwt<AccessTokenClaims>(result.tokens?.accessToken ?? '')
const newSignInNotices = () =>
  deps.mailer.outbox.filter((mail) => /new sign-in/i.test(mail.subject))

/** A refused sign-in left nothing a completed one has. */
async function expectNoSession(userId: string) {
  await Notices.settled()
  expect(await liveSessions(userId)).toEqual([])
  expect(sessions()).toEqual([])
  expect(newSignInNotices()).toEqual([])
  expect((await deps.users.findById(tenant.environmentId, userId))?.lastSignInAt ?? null).toBeNull()
}

describe('a sign-in whose every factor is proven', () => {
  beforeEach(() => configure())

  test('asks the hook once, with the allow-listed facts, and then creates the session', async () => {
    const userId = await seedUser()
    await hook()
    respond.before_session = async () => {
      // Asked before the session exists, not after.
      expect(await liveSessions(userId)).toEqual([])
      expect(sessions()).toEqual([])
      return allow()
    }
    const result = await signIn()
    expect(result.attempt.step.status).toBe('complete')
    expect(asked).toHaveLength(1)
    expect(
      HOOK_QUESTION_SCHEMAS.before_session.safeParse(JSON.parse(asked[0]?.raw ?? '')).success
    ).toBe(true)
    expect(asked[0]?.data).toEqual({
      userId,
      client: 'web',
      profile: 'web',
      amr: ['pwd'],
      signUp: false,
      ipAddress: '203.0.113.7',
    })
    expect(asked[0]?.raw).not.toContain(CANARY)
    expect(asked[0]?.raw).not.toContain('northline')
    expect(asked[0]?.raw).not.toContain(result.attempt.id)
    expect(sessions()[0]?.data).toEqual({ userId, client: 'web' })
    expect(await liveSessions(userId)).toHaveLength(1)
  })

  test('a denial answers the operator’s code and leaves no session, token, record or notice', async () => {
    const userId = await seedUser()
    await hook()
    respond.before_session = deny
    const attempt = await startSignIn()
    const refused = await rejection(password(attempt))
    expect(refused.code).toBe('hook.denied')
    expect(refused.status).toBe(403)
    expect(refused.params).toEqual({ code: 'not_on_the_list' })
    await expectNoSession(userId)
    // The attempt is spent: its proof is not kept for a second answer.
    respond.before_session = allow
    expect((await rejection(password(attempt))).code).toBe('flow.not_found')
    expect(asked).toHaveLength(1)
    await expectNoSession(userId)
    // And the same user signs in with a new attempt once the hook lets them.
    expect((await signIn()).attempt.step.status).toBe('complete')
  })

  test('a denied sign-in from a device the account has not been seen on sends no notice', async () => {
    const userId = await seedUser()
    // An earlier session from another device: the next sign-in from a browser is "new".
    await Sessions.create(deps, tenant, { userId, client: 'ios', userAgent: 'TulaExample/1 iOS' })
    await hook()
    respond.before_session = deny
    await rejection(signIn())
    await Notices.settled()
    expect(newSignInNotices()).toEqual([])
    expect(sessions()).toHaveLength(1)
    // The same sign-in, allowed, is announced: the silence above is the denial's.
    respond.before_session = allow
    await signIn()
    await Notices.settled()
    expect(newSignInNotices()).toHaveLength(1)
  })

  test('a wrong password and a denied right one answer differently, and only the right one reaches the receiver', async () => {
    await seedUser()
    await hook()
    respond.before_session = deny
    const wrong = await rejection(signIn('not the password at all'))
    const unknown = await rejection(password(await startSignIn('nobody@northline.app')))
    expect(wrong.code).toBe('auth.invalid_credentials')
    expect(unknown.code).toBe('auth.invalid_credentials')
    expect(asked).toEqual([])
    const right = await rejection(signIn())
    expect(right.code).toBe('hook.denied')
    expect(asked).toHaveLength(1)
  })

  test('a denial is not a failed guess: any number of them locks nobody out', async () => {
    const userId = await seedUser()
    await hook()
    respond.before_session = deny
    for (let denied = 0; denied < CREDENTIAL_LOCKOUT.freeAttempts + 3; denied++) {
      expect((await rejection(signIn())).code).toBe('hook.denied')
    }
    respond.before_session = allow
    expect((await rejection(signIn('not the password at all'))).code).toBe(
      'auth.invalid_credentials'
    )
    expect((await signIn()).attempt.step.status).toBe('complete')
    expect(await liveSessions(userId)).toHaveLength(1)
  })

  test('a denial does not clear the guesses someone else has made', async () => {
    await seedUser()
    await hook()
    respond.before_session = deny
    const counted = spyOn(deps.lockout, 'attempt')
    const cleared = spyOn(deps.lockout, 'clear')
    spies.push(counted, cleared)
    await rejection(signIn())
    // One count and one clear: the password's own, as without a hook. The denial adds neither.
    expect(counted).toHaveBeenCalledTimes(1)
    expect(cleared).toHaveBeenCalledTimes(1)
  })

  test('a hook that hangs fails the sign-in within its deadline, and the failure shows on the hook', async () => {
    const userId = await seedUser()
    const registered = await hook()
    respond.before_session = hang
    const started = performance.now()
    const refused = await rejection(signIn())
    expect(performance.now() - started).toBeLessThan(1500)
    expect(refused.code).toBe('hook.unavailable')
    expect(refused.status).toBe(503)
    await expectNoSession(userId)
    const noted = await Hooks.get(deps, tenant, registered.id)
    expect(noted.lastFailureReason).toBe('timeout')
    expect(noted.lastFailedAt).toBe(deps.clock.now().toISOString())
  })

  test.each([
    ['an error status', () => Response.json({ decision: 'allow' }, { status: 500 })],
    ['an unknown key', () => Response.json({ decision: 'allow', emailVerified: true })],
    ['claims instead of a decision', () => Response.json({ claims: { plan: 'pro' } })],
    ['a body that is not JSON', () => new Response('allow')],
  ])(
    '%s is a failure: refused by default, let through and recorded under “allow”',
    async (_name, answer) => {
      const userId = await seedUser()
      const registered = await hook()
      respond.before_session = answer
      expect((await rejection(signIn())).code).toBe('hook.unavailable')
      await expectNoSession(userId)

      await Hooks.update(deps, tenant, registered.id, { failureMode: 'allow' }, TEST_ACTOR)
      const result = await signIn()
      expect(result.attempt.step.status).toBe('complete')
      expect(sessions()[0]?.data).toEqual({ userId, client: 'web', hookBypassed: true })
    }
  )

  test('an answer that says more than a decision changes nothing about the session or its token', async () => {
    const userId = await seedUser()
    const plain = claimsOf(await signIn())
    await Sessions.revokeAllForUser(deps, tenant, userId, 'revoked_by_user', TEST_ACTOR)
    await hook('before_session', { failureMode: 'allow' })
    respond.before_session = () =>
      new Response(
        '{"decision":"allow","sub":"00000000-0000-7000-8000-0000000000ff","userId":"x","amr":["pwd","otp","mfa"],"emailVerified":true,"__proto__":{"admin":true}}',
        { headers: { 'content-type': 'application/json' } }
      )
    const result = await signIn()
    const { sid: _sid, ...through } = claimsOf(result)
    const { sid: _plain, ...expected } = plain
    expect(through).toEqual(expected)
    const [session] = await liveSessions(userId)
    expect(session?.userId).toBe(userId)
    expect(session?.authMethods).toEqual(['pwd'])
    expect(session?.hookClaims).toBeNull()
  })

  test('no log line holds the address of the request or the user agent', async () => {
    await seedUser()
    await hook()
    respond.before_session = deny
    await rejection(signIn())
    respond.before_session = hang
    await rejection(signIn())
    expect(logged()).not.toContain('203.0.113.7')
    expect(logged()).not.toContain(CANARY)
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain('not_on_the_list')
  })
})

describe('a second factor stands before the hook', () => {
  test('nothing is asked after the password; the hook is asked once the factor is proven', async () => {
    configure()
    const userId = await seedUser()
    const secret = await enrol(userId)
    await hook()
    const attempt = await startSignIn()
    const parked = await password(attempt)
    expect(parked.attempt.step.status).toBe('needs_second_factor')
    expect(asked).toEqual([])
    const wrong = await rejection(
      Flows.submitSecondFactor(
        deps,
        tenant,
        'sign_in',
        ref(attempt),
        { method: 'totp', response: '000000' },
        web
      )
    )
    expect(wrong.code).not.toBe('hook.denied')
    expect(asked).toEqual([])
    const done = await Flows.submitSecondFactor(
      deps,
      tenant,
      'sign_in',
      ref(attempt),
      { method: 'totp', response: codeFor(secret) },
      web
    )
    expect(done.attempt.step.status).toBe('complete')
    expect(asked.map((one) => one.data.amr)).toEqual([['pwd', 'otp', 'mfa']])
  })

  test('a denial after the second factor leaves no session; the proof is spent', async () => {
    configure()
    const userId = await seedUser()
    const secret = await enrol(userId)
    await hook()
    respond.before_session = deny
    const attempt = await startSignIn()
    await password(attempt)
    const submit = () =>
      Flows.submitSecondFactor(
        deps,
        tenant,
        'sign_in',
        ref(attempt),
        { method: 'totp', response: codeFor(secret) },
        web
      )
    expect((await rejection(submit())).code).toBe('hook.denied')
    expect(await liveSessions(userId)).toEqual([])
    expect(sessions()).toEqual([])
    expect((await rejection(submit())).code).not.toBe('hook.denied')
    expect(asked).toHaveLength(1)
  })

  test('an enrolment the environment requires comes first too', async () => {
    configure({ policy: 'required' })
    await seedUser()
    await hook()
    const attempt = await startSignIn()
    const parked = await password(attempt)
    expect(parked.attempt.step.status).toBe('needs_factor_enrolment')
    expect(asked).toEqual([])
    const enrolment = await Flows.startFactorEnrolment(deps, tenant, 'sign_in', ref(attempt), web)
    expect(asked).toEqual([])
    const done = await Flows.confirmFactorEnrolment(
      deps,
      tenant,
      'sign_in',
      ref(attempt),
      codeFor(enrolment.secret),
      web
    )
    expect(done.attempt.step.status).toBe('complete')
    expect(asked.map((one) => one.data.amr)).toEqual([['pwd', 'otp', 'mfa']])
  })
})

describe('a sign-up', () => {
  beforeEach(() => configure())

  const signUp = async () => {
    const { attempt } = await Flows.signUp(deps, tenant, { email: EMAIL, password: PASSWORD }, web)
    return Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), sentCode(), web)
  }

  test('asks the sign-up hook, then the session hook, then the claims hook: three at most', async () => {
    await hook('before_sign_up')
    await hook('before_session')
    await hook('before_token')
    const result = await signUp()
    expect(result.attempt.step.status).toBe('complete')
    expect(points()).toEqual(['before_sign_up', 'before_session', 'before_token'])
    const user = await deps.users.findByEmail(tenant.environmentId, EMAIL)
    expect(asked[1]?.data).toEqual({
      userId: user?.id,
      client: 'web',
      profile: 'web',
      amr: ['email'],
      signUp: true,
      ipAddress: '203.0.113.7',
    })
    expect(claimsOf(result).ext).toEqual({ plan: 'pro' })
  })

  test('denied at the session hook, the account stays and has no session; it signs in later', async () => {
    await hook('before_session')
    respond.before_session = deny
    expect((await rejection(signUp())).code).toBe('hook.denied')
    const user = await deps.users.findByEmail(tenant.environmentId, EMAIL)
    expect(user?.emailVerifiedAt).toEqual(deps.clock.now())
    expect(deps.activityLog.ofType('user.created')).toHaveLength(1)
    expect(sessions()).toEqual([])
    expect(await liveSessions(user?.id ?? '')).toEqual([])
    respond.before_session = allow
    const later = await signIn()
    expect(later.attempt.step.status).toBe('complete')
    expect(asked.at(-1)?.data.signUp).toBe(false)
  })
})

describe('a password reset', () => {
  test('asks before its session like any sign-in', async () => {
    configure()
    const userId = await seedUser()
    await hook()
    const { attempt } = await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)
    expect(asked).toEqual([])
    const result = await Flows.resetPassword(
      deps,
      tenant,
      ref(attempt),
      { code: sentCode(), password: NEW_PASSWORD },
      web
    )
    expect(result.attempt.step.status).toBe('complete')
    expect(asked.map((one) => one.data)).toEqual([
      {
        userId,
        client: 'web',
        profile: 'web',
        amr: ['email'],
        signUp: false,
        ipAddress: '203.0.113.7',
      },
    ])
  })
})

describe('the two hooks of one sign-in', () => {
  beforeEach(() => configure())

  test('the session hook is asked first, and the claims hook as the session is created: two calls', async () => {
    const userId = await seedUser()
    await hook('before_session')
    await hook('before_token')
    const result = await signIn()
    expect(points()).toEqual(['before_session', 'before_token'])
    expect(asked[1]?.data).toEqual({
      userId,
      sessionId: result.tokens?.sessionId,
      client: 'web',
      profile: 'web',
      amr: ['pwd'],
    })
    expect(claimsOf(result).ext).toEqual({ plan: 'pro' })
  })

  test('a denied sign-in never reaches the claims hook', async () => {
    const userId = await seedUser()
    await hook('before_session')
    await hook('before_token')
    respond.before_session = deny
    await rejection(signIn())
    expect(points()).toEqual(['before_session'])
    await expectNoSession(userId)
  })

  test('a claims hook that fails after the session hook allowed leaves no session behind', async () => {
    const userId = await seedUser()
    await hook('before_session')
    await hook('before_token')
    respond.before_token = hang
    const attempt = await startSignIn()
    const refused = await rejection(password(attempt))
    expect(refused.code).toBe('hook.unavailable')
    expect(points()).toEqual(['before_session', 'before_token'])
    await expectNoSession(userId)
    expect((await rejection(password(attempt))).code).toBe('flow.not_found')
  })

  test('both bypassed are both recorded', async () => {
    const userId = await seedUser()
    await hook('before_session', { failureMode: 'allow' })
    await hook('before_token', { failureMode: 'allow' })
    respond.before_session = () => new Response('down', { status: 502 })
    respond.before_token = () => new Response('down', { status: 502 })
    const result = await signIn()
    expect(claimsOf(result)).not.toHaveProperty('ext')
    expect(sessions()[0]?.data).toEqual({
      userId,
      client: 'web',
      hookBypassed: true,
      claimsHookBypassed: true,
    })
  })

  test('the profile the session gets is the one both are asked about', async () => {
    configure({
      sessions: {
        profiles: {
          ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles,
          kiosk: { ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles.web, clientSelectable: true },
        } as EnvironmentSettings['sessions']['profiles'],
      },
    })
    await seedUser()
    await hook('before_session')
    await hook('before_token')
    const { attempt } = await Flows.signIn(
      deps,
      tenant,
      { identifier: EMAIL },
      { ...web, profile: 'kiosk' }
    )
    const result = await password(attempt)
    expect(asked.map((one) => one.data.profile)).toEqual(['kiosk', 'kiosk'])
    expect(claimsOf(result).sp).toBe('kiosk')
  })
})

describe('what does not ask the session hook', () => {
  test('a refresh, a step-up and an administrator’s acts', async () => {
    configure()
    const userId = await seedUser()
    await hook()
    const result = await signIn()
    expect(asked).toHaveLength(1)
    const refreshed = await Sessions.refresh(deps, tenant, result.tokens?.refreshToken ?? '')
    await Sessions.refresh(deps, tenant, refreshed.refreshToken ?? '')
    await Sessions.recordAuthentication(
      deps,
      tenant,
      { userId, sessionId: result.tokens?.sessionId ?? '' },
      ['pwd'],
      TEST_ACTOR
    )
    await Sessions.revokeAllForUser(deps, tenant, userId, 'revoked_by_user', TEST_ACTOR)
    expect(asked).toHaveLength(1)
  })
})

describe('over HTTP', () => {
  let app: ReturnType<typeof createApp>
  const secrets = new Map<string, string>()
  const post = async (path: string, body: unknown, client = 'web') => {
    const id = /^\/sign-ins\/([^/]+)\//.exec(path)?.[1]
    const res = await app.request(`/v1/client${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tula-publishable-key': PK,
        'x-tula-client': client,
        ...(id && { [FLOW_ATTEMPT_HEADER]: secrets.get(id) ?? '' }),
      },
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

  beforeEach(async () => {
    configure()
    await seedApiKey(deps, PK)
    await seedApiKey(deps, SK)
    app = createApp(deps)
  })

  test('a denied sign-in is a 403 with the operator’s code and sets no cookie', async () => {
    const userId = await seedUser()
    await hook()
    respond.before_session = deny
    const started = (await (await post('/sign-ins', { identifier: EMAIL })).json()) as FlowAttempt
    const res = await post(`/sign-ins/${started.id}/password`, { password: PASSWORD })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      status: 403,
      code: 'hook.denied',
      detail: 'This was not allowed.',
      params: { code: 'not_on_the_list' },
    })
    expect(res.headers.get('set-cookie')).toBeNull()
    await expectNoSession(userId)
  })

  test('a hook that fails is a 503 and sets no cookie', async () => {
    const userId = await seedUser()
    await hook()
    respond.before_session = hang
    const started = (await (await post('/sign-ins', { identifier: EMAIL })).json()) as FlowAttempt
    const res = await post(`/sign-ins/${started.id}/password`, { password: PASSWORD })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      status: 503,
      code: 'hook.unavailable',
      detail: 'This is unavailable right now. Try again later.',
    })
    expect(res.headers.get('set-cookie')).toBeNull()
    await expectNoSession(userId)
  })

  test('a first sign-in with a provider is asked about as a sign-up, a second one is not', async () => {
    const put = await app.request('/v1/admin/oauth-providers/google', {
      method: 'PUT',
      headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'google-client-id', clientSecret: 'GOCSPX-test-secret' }),
    })
    expect(put.status).toBe(200)
    await hook()
    const roundTrip = async () => {
      const started = (await (
        await post('/sign-ins/oauth', { provider: 'google', redirectUrl: REDIRECT }, 'ios')
      ).json()) as OAuthStart
      const state = new URL(started.authorizationUrl).searchParams.get('state') ?? ''
      const back = await app.request(
        `/v1/oauth/callback/google?${new URLSearchParams({ state, code: 'c' })}`
      )
      const location = back.headers.get('location') ?? ''
      const params = new URLSearchParams(location.slice(location.indexOf('#') + 1))
      return post(
        '/sign-ins/oauth/exchange',
        {
          ticket: params.get('tula_ticket'),
          attemptId: params.get('tula_attempt'),
          binding: started.binding,
        },
        'ios'
      )
    }
    expect((await roundTrip()).status).toBe(200)
    expect((await roundTrip()).status).toBe(200)
    expect(asked.map((one) => [one.data.signUp, one.data.amr, one.data.client])).toEqual([
      [true, ['fed'], 'ios'],
      [false, ['fed'], 'ios'],
    ])
  })
})

describe('an enrolment inside a sign-in that a hook then refuses', () => {
  // Decided, not overlooked (ADR 0035, "What a refusal costs that is easy to miss"): turning
  // a factor on ends the sessions that did not prove it **before anything else** (ADR 0025),
  // so a sign-in refused after that has already signed the user out elsewhere. These tests
  // pin that cost. A change here is a decision about ADR 0025's order, not a fix.
  //
  // The user has a session from before the environment required two-step verification, and
  // signs in again: the attempt stops at the enrolment.
  async function enrolling() {
    configure()
    const userId = await seedUser()
    const earlier = (await signIn()).tokens?.sessionId ?? ''
    await Notices.settled()
    configure({ policy: 'required' })
    const attempt = await startSignIn()
    expect((await password(attempt)).attempt.step.status).toBe('needs_factor_enrolment')
    const enrolment = await Flows.startFactorEnrolment(deps, tenant, 'sign_in', ref(attempt), web)
    const confirm = () =>
      Flows.confirmFactorEnrolment(
        deps,
        tenant,
        'sign_in',
        ref(attempt),
        codeFor(enrolment.secret),
        web
      )
    return { userId, earlier, confirm }
  }

  async function expectRefused(userId: string, earlier: string) {
    // The enrolment is undone: no factor, and none of the codes made for it.
    expect(await deps.factors.findTotp(tenant.environmentId, userId)).toBeNull()
    expect(await deps.factors.countBackupCodes(tenant.environmentId, userId)).toBe(0)
    // No new session: the one `session.created` is the earlier session's.
    expect(sessions()).toHaveLength(1)
    // The cost: the session the user already had is ended, and its access token refused.
    expect(await liveSessions(userId)).toEqual([])
    expect(await deps.revokedSessions.has(earlier, deps.clock.now())).toBe(true)
  }

  test('a denial undoes the enrolment, and the user’s earlier sessions are ended', async () => {
    const { userId, earlier, confirm } = await enrolling()
    await hook()
    respond.before_session = deny
    expect((await rejection(confirm())).code).toBe('hook.denied')
    await expectRefused(userId, earlier)
  })

  test('a session hook that hangs does the same', async () => {
    const { userId, earlier, confirm } = await enrolling()
    await hook()
    respond.before_session = hang
    expect((await rejection(confirm())).code).toBe('hook.unavailable')
    await expectRefused(userId, earlier)
  })

  test('so does a claims hook that hangs as the session is made', async () => {
    const { userId, earlier, confirm } = await enrolling()
    await hook('before_token')
    respond.before_token = hang
    expect((await rejection(confirm())).code).toBe('hook.unavailable')
    await expectRefused(userId, earlier)
  })

  test('an enrolment that completes has ended every other session before the hook is asked', async () => {
    const { userId, earlier, confirm } = await enrolling()
    await hook()
    let aliveWhenAsked: boolean | undefined
    respond.before_session = async () => {
      aliveWhenAsked = (await liveSessions(userId)).some((session) => session.id === earlier)
      return allow()
    }
    const done = await confirm()
    expect(done.attempt.step.status).toBe('complete')
    // No session that did not prove the factor is alive beside it, not even while a hook
    // is thinking.
    expect(aliveWhenAsked).toBe(false)
    expect((await liveSessions(userId)).map((session) => session.id)).toEqual([
      done.tokens?.sessionId ?? '',
    ])
    expect(await deps.revokedSessions.has(earlier, deps.clock.now())).toBe(true)
    expect(await deps.revokedSessions.has(done.tokens?.sessionId ?? '', deps.clock.now())).toBe(
      false
    )
    expect(await deps.factors.countBackupCodes(tenant.environmentId, userId)).toBe(10)
  })

  test('refused, and the factor cannot be removed again: it stays on, beside no session that did not prove it', async () => {
    const { userId, earlier, confirm } = await enrolling()
    await hook()
    respond.before_session = deny
    const remove = spyOn(deps.factors, 'removeForUser').mockRejectedValue(new Error('store down'))
    // The hook's answer is what the client hears, not the failed undo.
    expect((await rejection(confirm())).code).toBe('hook.denied')
    remove.mockRestore()
    expect((await deps.factors.findTotp(tenant.environmentId, userId))?.confirmedAt).toBeInstanceOf(
      Date
    )
    // Codes nobody saw: the user signs in with the authenticator and makes new ones.
    expect(await deps.factors.countBackupCodes(tenant.environmentId, userId)).toBe(10)
    expect(await liveSessions(userId)).toEqual([])
    expect(await deps.revokedSessions.has(earlier, deps.clock.now())).toBe(true)
    expect(sessions()).toHaveLength(1)
    expect(logged()).toContain('could not undo an enrolment whose attempt did not complete')
  })
})

describe('what a refused sign-in has already spent', () => {
  // Decided, not overlooked (ADR 0035, "What a refusal costs"): the proof comes before the
  // question, and a spent proof is never given back. A change here is a decision.
  test('a backup code used for a sign-in the hook refuses is spent: nine are left', async () => {
    configure()
    const userId = await seedUser()
    const { secret } = await Mfa.startTotp(deps, tenant, userId)
    const { codes } = await Mfa.confirmTotp(deps, tenant, { userId }, codeFor(secret), {
      type: 'user',
      id: userId,
      ipAddress: null,
      userAgent: null,
    })
    await Notices.settled()
    await hook()
    respond.before_session = deny
    const attempt = await startSignIn()
    await password(attempt)
    const withCode = (target: Presented) =>
      Flows.submitSecondFactor(
        deps,
        tenant,
        'sign_in',
        ref(target),
        { method: 'backup_code', response: codes[0] ?? '' },
        web
      )
    expect((await rejection(withCode(attempt))).code).toBe('hook.denied')
    expect(await deps.factors.countBackupCodes(tenant.environmentId, userId)).toBe(9)
    expect(await liveSessions(userId)).toEqual([])

    // The same code proves nothing a second time, also once the hook would allow.
    respond.before_session = allow
    const again = await startSignIn()
    await password(again)
    expect((await rejection(withCode(again))).code).not.toBe('hook.denied')
    expect(await deps.factors.countBackupCodes(tenant.environmentId, userId)).toBe(9)
    expect(await liveSessions(userId)).toEqual([])
  })
})

describe('an enrolling sign-in at the session limit', () => {
  test('completes where the newest session would be refused: the enrolment ended the others first', async () => {
    configure({ sessions: { maxPerUser: 1, onLimit: 'refuse_newest' } })
    const userId = await seedUser()
    const earlier = (await signIn()).tokens?.sessionId ?? ''
    await Notices.settled()
    // At the limit, a plain sign-in is refused.
    expect((await rejection(signIn())).code).toBe('session.limit_reached')
    configure({ policy: 'required', sessions: { maxPerUser: 1, onLimit: 'refuse_newest' } })
    await hook()
    const attempt = await startSignIn()
    await password(attempt)
    const enrolment = await Flows.startFactorEnrolment(deps, tenant, 'sign_in', ref(attempt), web)
    const done = await Flows.confirmFactorEnrolment(
      deps,
      tenant,
      'sign_in',
      ref(attempt),
      codeFor(enrolment.secret),
      web
    )
    expect(done.attempt.step.status).toBe('complete')
    expect((await liveSessions(userId)).map((session) => session.id)).toEqual([
      done.tokens?.sessionId ?? '',
    ])
    expect(await deps.revokedSessions.has(earlier, deps.clock.now())).toBe(true)
  })
})
