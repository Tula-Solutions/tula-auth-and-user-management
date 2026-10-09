import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type AccessTokenClaims,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  FLOW_ATTEMPT_HEADER,
  type FlowAttempt,
  type FlowKind,
  type TotpEnrolment,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import { createApp } from '~/index'
import { base32Decode, totp } from '~/lib/totp'
import * as Audit from '~/modules/audit/service'
import * as Flows from '~/modules/flow/router'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import { refreshCookieName } from '~/modules/session/cookies'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a brand new passphrase 42'
// One argon2 hash for the whole file: hashing per test would dominate its run time.
const PASSWORD_HASH = await Passwords.hash(PASSWORD)
const COOKIE = refreshCookieName(TEST_CONFIG, TEST_TENANT.environmentId)
const ALLOWED = 'https://app.northline.app'
const FOREIGN = 'https://evil.example'
const tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const NOT_FOUND = {
  status: 404,
  code: 'flow.not_found',
  detail: 'This attempt does not exist or has expired.',
}
const REFUSED = {
  status: 403,
  code: 'request.origin_not_allowed',
  detail: 'This origin is not allowed to sign in to this app.',
}

let deps: TestDeps
let app: ReturnType<typeof createApp>
/** The secret of every attempt started through {@link post}, by attempt id: what a client keeps. */
let secrets: Map<string, string>
const spies: ReturnType<typeof spyOn>[] = []

type Policy = EnvironmentSettings['mfa']['policy']

function configure(policy: Policy) {
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      urls: { ...DEFAULT_ENVIRONMENT_SETTINGS.urls, allowedOrigins: [ALLOWED] },
      mfa: { policy, smsCode: { enabled: false } },
    },
  })
}

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
  configure('optional')
  app = createApp(deps)
})

afterEach(async () => {
  await Notices.settled()
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

interface Options {
  client?: string
  key?: string | null
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
const setCookie = (res: Response) => res.headers.get('set-cookie') ?? ''
const claimsOf = (token: string) => decodeJwt(token) as unknown as AccessTokenClaims
const codeFor = (secret: string) => totp(base32Decode(secret), deps.clock.now())

/** The 6-digit code in the most recent email whose subject leads with one. */
function sentCode(): string {
  const message = deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))
  return (message ? /^(\d{6}) /.exec(message.subject)?.[1] : undefined) ?? ''
}

async function seedUser() {
  const id = deps.ids.next()
  await deps.users.create(
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: EMAIL,
      emailNormalized: EMAIL,
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

/** A user who has turned two-step verification on. */
async function seedEnrolledUser() {
  const userId = await seedUser()
  const { secret } = await Mfa.startTotp(deps, tenant, userId)
  const { codes } = await Mfa.confirmTotp(deps, tenant, { userId }, codeFor(secret), {
    type: 'user',
    id: userId,
    ipAddress: null,
    userAgent: null,
  })
  await Notices.settled()
  // The confirming code's step is spent: the next use needs the next step's.
  deps.clock.advance('30s')
  return { userId, secret, codes }
}

const PATHS: Record<FlowKind, string> = {
  sign_in: '/sign-ins',
  sign_up: '/sign-ups',
  password_reset: '/password-resets',
}

/** Take an attempt of `kind` past its last proof before any second factor, over HTTP. */
async function lastProof(kind: FlowKind, options: Options = {}): Promise<FlowAttempt> {
  if (kind === 'sign_in') {
    const started = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }, options))
    return json<FlowAttempt>(
      await post(`/sign-ins/${started.id}/password`, { password: PASSWORD }, options)
    )
  }
  if (kind === 'sign_up') {
    const started = await json<FlowAttempt>(
      await post('/sign-ups', { email: EMAIL, password: PASSWORD }, options)
    )
    return json<FlowAttempt>(
      await post(`/sign-ups/${started.id}/verify-email`, { code: sentCode() }, options)
    )
  }
  const started = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }, options))
  return json<FlowAttempt>(
    await post(
      `/password-resets/${started.id}/password`,
      { code: sentCode(), password: NEW_PASSWORD },
      options
    )
  )
}

/** One request to a new route, on an attempt that is waiting for exactly that request. */
interface Ready {
  path: string
  /** The body that the route accepts for this attempt. */
  body: unknown
  userId: string
  /** Whether a successful call completes the attempt (and so delivers tokens). */
  completes: boolean
}

async function secondFactorCase(
  kind: 'sign_in' | 'password_reset',
  method: 'totp' | 'backup_code',
  options: Options = {}
): Promise<Ready> {
  const { userId, secret, codes } = await seedEnrolledUser()
  const waiting = await lastProof(kind, options)
  expect(waiting.step.status).toBe('needs_second_factor')
  expect(waiting).not.toHaveProperty('session')
  return {
    path: `${PATHS[kind]}/${waiting.id}/second-factor`,
    body: { method, code: method === 'totp' ? codeFor(secret) : codes[0] },
    userId,
    completes: true,
  }
}

async function enrolmentCase(
  kind: FlowKind,
  step: 'start' | 'confirm',
  options: Options = {}
): Promise<Ready> {
  configure('required')
  if (kind !== 'sign_up') {
    await seedUser()
  }
  const waiting = await lastProof(kind, options)
  expect(waiting.step).toEqual({ status: 'needs_factor_enrolment', methods: ['totp'] })
  expect(waiting).not.toHaveProperty('session')
  const user = await deps.users.findByEmail(tenant.environmentId, EMAIL)
  const base = `${PATHS[kind]}/${waiting.id}/factor-enrolment/totp`
  if (step === 'start') {
    return { path: base, body: {}, userId: user?.id as string, completes: false }
  }
  const enrolment = await json<TotpEnrolment>(await post(base, {}, options))
  return {
    path: `${base}/confirm`,
    body: { code: codeFor(enrolment.secret) },
    userId: user?.id as string,
    completes: true,
  }
}

/** Every new route, each with an attempt waiting on it. */
const ROUTES: [string, (options?: Options) => Promise<Ready>][] = [
  ['sign-in second factor (totp)', (options) => secondFactorCase('sign_in', 'totp', options)],
  [
    'sign-in second factor (backup code)',
    (options) => secondFactorCase('sign_in', 'backup_code', options),
  ],
  [
    'password-reset second factor (totp)',
    (options) => secondFactorCase('password_reset', 'totp', options),
  ],
  [
    'password-reset second factor (backup code)',
    (options) => secondFactorCase('password_reset', 'backup_code', options),
  ],
  ['sign-up enrolment start', (options) => enrolmentCase('sign_up', 'start', options)],
  ['sign-up enrolment confirm', (options) => enrolmentCase('sign_up', 'confirm', options)],
  ['sign-in enrolment start', (options) => enrolmentCase('sign_in', 'start', options)],
  ['sign-in enrolment confirm', (options) => enrolmentCase('sign_in', 'confirm', options)],
  [
    'password-reset enrolment start',
    (options) => enrolmentCase('password_reset', 'start', options),
  ],
  [
    'password-reset enrolment confirm',
    (options) => enrolmentCase('password_reset', 'confirm', options),
  ],
]

/** Everything a refused request must not have touched. */
function watch() {
  const watched = [
    spyOn(deps.lockout, 'attempt'),
    spyOn(deps.rateLimiter, 'hit'),
    spyOn(deps.factors, 'useTotpStep'),
    spyOn(deps.factors, 'consumeBackupCode'),
    spyOn(deps.factors, 'startTotp'),
    spyOn(deps.factors, 'confirmTotp'),
    spyOn(deps.sessions, 'create'),
    spyOn(deps.flowAttempts, 'transition'),
  ]
  spies.push(...watched)
  const [lockout, limiter] = watched
  return {
    /** Nothing was counted against the user, checked, stored or created. */
    expectUntouched() {
      for (const spy of watched) {
        if (spy !== limiter) {
          expect(spy).not.toHaveBeenCalled()
        }
      }
      expect(lockout).not.toHaveBeenCalled()
      // The per-IP limiter runs, as for any request; the environment's ceiling was not charged.
      const charged = (limiter?.mock.calls ?? []).map((call) => String(call[0]))
      expect(charged.filter((key) => key.startsWith('environment_'))).toEqual([])
    },
    release() {
      for (const spy of watched) {
        spy.mockRestore()
      }
    },
  }
}

const liveSessions = (userId: string) =>
  deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())

describe('attempt binding on the second-factor and enrolment routes', () => {
  test.each(ROUTES)(
    '%s: without the secret, with a wrong one or another attempt’s it is flow.not_found, and nothing is counted or spent',
    async (_, setup) => {
      const { path, body, userId } = await setup()
      const id = ATTEMPT_PATH.exec(path)?.[1] as string
      const other = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
      const before = (await liveSessions(userId)).length
      const untouched = watch()

      for (const presented of [
        null,
        '',
        'tula_at_made-up',
        `${secrets.get(id)}x`,
        other.attemptSecret as string,
      ]) {
        const res = await post(path, body, { attempt: presented })
        expect({ presented, status: res.status, body: await json<unknown>(res) }).toEqual({
          presented,
          status: 404,
          body: NOT_FOUND,
        })
        expect(setCookie(res)).toBe('')
      }
      untouched.expectUntouched()
      untouched.release()
      expect(await liveSessions(userId)).toHaveLength(before)

      // Nothing was spent: the very same request, with the attempt's secret, succeeds.
      const done = await post(path, body)
      expect(done.status).toBe(200)
    }
  )

  test('an unknown attempt id answers the same 404 on every new route', async () => {
    for (const path of [
      '/sign-ins/x/second-factor',
      '/password-resets/x/second-factor',
      '/sign-ups/x/factor-enrolment/totp',
      '/sign-ins/x/factor-enrolment/totp',
      '/password-resets/x/factor-enrolment/totp',
      '/sign-ups/x/factor-enrolment/totp/confirm',
      '/sign-ins/x/factor-enrolment/totp/confirm',
      '/password-resets/x/factor-enrolment/totp/confirm',
    ]) {
      const res = await post(
        path.replace('/x/', `/${crypto.randomUUID()}/`),
        { method: 'totp', code: '123456' },
        { attempt: 'tula_at_made-up' }
      )
      expect([path, res.status, await json<unknown>(res)]).toEqual([path, 404, NOT_FOUND])
    }
  })

  test('no response of these routes repeats the attempt’s secret', async () => {
    const { path, body } = await secondFactorCase('sign_in', 'totp')
    const wrong = await post(path, { method: 'totp', code: '000000' })
    expect(await wrong.text()).not.toContain('tula_at_')
    const done = await post(path, body)
    expect(done.status).toBe(200)
    expect(await done.text()).not.toContain('tula_at_')
  })
})

describe('a browser attempt and the page’s origin, on the second-factor and enrolment routes', () => {
  test.each(ROUTES)(
    '%s: a page that is not allowed is refused before anything changes: no guess, no code spent, no cookie',
    async (_, setup) => {
      // Started as a browser (`web` is the default client), from the app's own page.
      const { path, body, userId, completes } = await setup({ origin: ALLOWED })
      const untouched = watch()
      const res = await post(path, body, { origin: FOREIGN })
      expect(res.status).toBe(403)
      expect(await json<unknown>(res)).toEqual(REFUSED)
      expect(setCookie(res)).toBe('')
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      untouched.expectUntouched()
      // Claiming to be another kind of client changes nothing: the attempt is a browser's.
      const disguised = await post(path, body, { origin: FOREIGN, client: 'ios' })
      expect(await json<unknown>(disguised)).toEqual(REFUSED)
      untouched.expectUntouched()
      untouched.release()
      expect(await liveSessions(userId)).toEqual([])
      expect(deps.activityLog.ofType('session.created')).toEqual([])

      // The attempt is untouched: the app's own page makes the same request and it succeeds.
      const done = await post(path, body, { origin: ALLOWED })
      expect(done.status).toBe(200)
      expect(done.headers.get('cache-control')).toBe('no-store')
      expect(done.headers.get('access-control-allow-origin')).toBe(ALLOWED)
      if (completes) {
        // A browser gets the refresh token only as a cookie.
        expect(setCookie(done).startsWith(`${COOKIE}=tula_rt_`)).toBe(true)
        expect(setCookie(done)).toContain('HttpOnly')
        const attempt = await json<FlowAttempt>(done)
        expect(attempt.step.status).toBe('complete')
        expect(attempt.session?.accessToken).toBeString()
        expect(attempt.session).not.toHaveProperty('refreshToken')
        expect(JSON.stringify(attempt)).not.toContain('tula_rt_')
        expect(await liveSessions(userId)).toHaveLength(1)
      } else {
        expect(setCookie(done)).toBe('')
        expect(await liveSessions(userId)).toEqual([])
      }
    }
  )

  test('without the attempt’s secret the origin is never mentioned', async () => {
    const { path, body } = await secondFactorCase('sign_in', 'totp')
    const res = await post(path, body, { origin: FOREIGN, attempt: null })
    expect(await json<unknown>(res)).toEqual(NOT_FOUND)
  })

  test('a native attempt is not bound to an origin: tokens in the body, no cookie', async () => {
    const { path, body } = await secondFactorCase('sign_in', 'backup_code', { client: 'ios' })
    const done = await post(path, body, { origin: FOREIGN })
    expect(done.status).toBe(200)
    const attempt = await json<FlowAttempt>(done)
    expect(attempt.session?.refreshToken).toMatch(/^tula_rt_/)
    expect(attempt.backupCodesRemaining).toBe(9)
    expect(setCookie(done)).toBe('')
    expect(done.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('what the second-factor and enrolment routes return', () => {
  test('a wrong code is 422 mfa.invalid_code: no tokens and no cookie', async () => {
    const { path, userId } = await secondFactorCase('sign_in', 'totp')
    for (const body of [
      { method: 'totp', code: '000000' },
      { method: 'backup_code', code: 'zzzzz-zzzzz' },
    ]) {
      const res = await post(path, body)
      expect(await json<unknown>(res)).toEqual({
        status: 422,
        code: 'mfa.invalid_code',
        detail: 'That code is incorrect.',
      })
      expect(setCookie(res)).toBe('')
    }
    expect(await liveSessions(userId)).toEqual([])
  })

  test('a browser completing with a backup code is told how many are left', async () => {
    const { path, body } = await secondFactorCase('password_reset', 'backup_code')
    const done = await post(path, body)
    const attempt = await json<FlowAttempt>(done)
    expect(attempt).toMatchObject({
      kind: 'password_reset',
      step: { status: 'complete' },
      backupCodesRemaining: 9,
    })
    expect(attempt).not.toHaveProperty('backupCodes')
    expect(claimsOf(attempt.session?.accessToken as string).amr).toEqual([
      'email',
      'backup_code',
      'mfa',
    ])
    expect(setCookie(done)).toContain(`${COOKIE}=tula_rt_`)
  })

  test('starting an enrolment returns the secret and its URI, uncacheable, and no session', async () => {
    const { path } = await enrolmentCase('sign_in', 'start')
    const res = await post(path)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(setCookie(res)).toBe('')
    const enrolment = await json<TotpEnrolment>(res)
    expect(Object.keys(enrolment).sort()).toEqual(['secret', 'uri'])
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(enrolment.uri).toBe(
      `otpauth://totp/Tula:maya%40northline.app?secret=${enrolment.secret}` +
        '&issuer=Tula&algorithm=SHA1&digits=6&period=30'
    )
  })

  test.each<[FlowKind, string]>([
    ['sign_up', 'email'],
    ['sign_in', 'pwd'],
    ['password_reset', 'email'],
  ])(
    'confirming an enrolment in a %s completes it with the backup codes and a session',
    async (kind, first) => {
      const { path, body, userId } = await enrolmentCase(kind, 'confirm', { client: 'ios' })
      const wrong = await post(path, { code: '000000' })
      expect(await json<unknown>(wrong)).toMatchObject({ status: 422, code: 'mfa.invalid_code' })
      const done = await post(path, body)
      expect(done.status).toBe(200)
      expect(done.headers.get('cache-control')).toBe('no-store')
      const attempt = await json<FlowAttempt>(done)
      expect(attempt.kind).toBe(kind)
      expect(attempt.step).toMatchObject({ status: 'complete', userId })
      expect(attempt.backupCodes).toHaveLength(10)
      expect(attempt.session?.refreshToken).toMatch(/^tula_rt_/)
      expect(claimsOf(attempt.session?.accessToken as string).amr).toEqual([first, 'otp', 'mfa'])
      // Shown once: the attempt is finished and answers nothing more.
      expect((await post(path, body)).status).toBe(404)
    }
  )

  test('a lapsed or missing enrolment is 410 mfa.enrolment_expired', async () => {
    const { path } = await enrolmentCase('sign_in', 'start')
    const res = await post(`${path}/confirm`, { code: '123456' })
    expect(await json<unknown>(res)).toMatchObject({ status: 410, code: 'mfa.enrolment_expired' })
    expect(setCookie(res)).toBe('')
  })

  test('the routes of another step answer 409 flow.invalid_step', async () => {
    const enrolling = await enrolmentCase('sign_in', 'start')
    const id = ATTEMPT_PATH.exec(enrolling.path)?.[1] as string
    const res = await post(`/sign-ins/${id}/second-factor`, { method: 'totp', code: '123456' })
    expect(await json<unknown>(res)).toMatchObject({ status: 409, code: 'flow.invalid_step' })

    const open = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    for (const [path, body] of [
      [`/sign-ins/${open.id}/second-factor`, { method: 'totp', code: '123456' }],
      [`/sign-ins/${open.id}/factor-enrolment/totp`, {}],
      [`/sign-ins/${open.id}/factor-enrolment/totp/confirm`, { code: '123456' }],
    ] as const) {
      const refused = await post(path, body)
      expect([path, (await json<{ code: string }>(refused)).code]).toEqual([
        path,
        'flow.invalid_step',
      ])
    }
  })

  test('the policy switched off mid-attempt is 403 mfa.not_available', async () => {
    const { path } = await enrolmentCase('sign_in', 'start')
    configure('off')
    expect(await json<unknown>(await post(path))).toMatchObject({
      status: 403,
      code: 'mfa.not_available',
    })
  })

  test('a sign-up has no second-factor route', async () => {
    const res = await post(`/sign-ups/${crypto.randomUUID()}/second-factor`, {
      method: 'totp',
      code: '123456',
    })
    expect(res.status).toBe(404)
  })

  test('wrong codes lock the user out: 429 with Retry-After, even for the right code', async () => {
    const { path, body, userId } = await secondFactorCase('sign_in', 'totp')
    for (let index = 0; index <= CREDENTIAL_LOCKOUT.freeAttempts; index++) {
      const res = await post(path, { method: 'totp', code: '000000' })
      expect(res.status).toBe(422)
    }
    const locked = await post(path, body)
    expect(locked.status).toBe(429)
    expect(await json<unknown>(locked)).toMatchObject({ code: 'rate_limited' })
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(setCookie(locked)).toBe('')
    expect(await liveSessions(userId)).toEqual([])
  })
})

describe('validation on the second-factor and enrolment routes', () => {
  test.each<[string, unknown]>([
    ['a five-digit TOTP code', { method: 'totp', code: '12345' }],
    ['a seven-digit TOTP code', { method: 'totp', code: '1234567' }],
    ['letters as a TOTP code', { method: 'totp', code: 'abcdef' }],
    ['a TOTP code with a space', { method: 'totp', code: '123 456' }],
    ['a number as a TOTP code', { method: 'totp', code: 123456 }],
    ['a TOTP proof with no code', { method: 'totp' }],
    ['an empty backup code', { method: 'backup_code', code: '' }],
    ['an overlong backup code', { method: 'backup_code', code: 'a'.repeat(65) }],
    ['a method that cannot be submitted here', { method: 'passkey', code: '123456' }],
    ['a texted code that is not six digits', { method: 'sms_code', code: '12345' }],
    ['a texted code with a credential in place of a code', { method: 'sms_code', credential: {} }],
    ['a password in place of a code', { method: 'password', password: PASSWORD }],
    ['no method', { code: '123456' }],
    ['an empty body', {}],
  ])('the second-factor route refuses %s with 422, counting nothing', async (_, body) => {
    const { path } = await secondFactorCase('sign_in', 'totp')
    const untouched = watch()
    const res = await post(path, body)
    expect(res.status).toBe(422)
    expect(await json<unknown>(res)).toMatchObject({ code: 'validation.failed' })
    untouched.expectUntouched()
  })

  test.each<[string, unknown]>([
    ['a five-digit code', { code: '12345' }],
    ['a seven-digit code', { code: '1234567' }],
    ['letters', { code: 'abcdef' }],
    ['a number', { code: 123456 }],
    ['an empty body', {}],
  ])('the confirm route refuses %s with 422, counting nothing', async (_, body) => {
    const { path } = await enrolmentCase('sign_in', 'confirm')
    const untouched = watch()
    const res = await post(path, body)
    expect(res.status).toBe(422)
    untouched.expectUntouched()
  })

  test('a malformed attempt id, an overlong secret and a missing key are refused on every route', async () => {
    for (const suffix of [
      'second-factor',
      'factor-enrolment/totp',
      'factor-enrolment/totp/confirm',
    ]) {
      const body = { method: 'totp', code: '123456' }
      const malformed = await post(`/sign-ins/not-a-uuid/${suffix}`, body, { attempt: 'x' })
      expect([suffix, malformed.status]).toEqual([suffix, 422])
      const path = `/sign-ins/${crypto.randomUUID()}/${suffix}`
      expect([suffix, (await post(path, body, { attempt: 'a'.repeat(257) })).status]).toEqual([
        suffix,
        422,
      ])
      const keyless = await post(path, body, { key: null, attempt: 'x' })
      expect([suffix, keyless.status]).toEqual([suffix, 401])
    }
  })
})

describe('per-IP rate limits on the second-factor and enrolment routes', () => {
  test.each<[string, number]>([
    ['/sign-ins/:id/second-factor', Flows.CREDENTIAL_RATE_LIMIT],
    ['/password-resets/:id/second-factor', Flows.CREDENTIAL_RATE_LIMIT],
    ['/sign-ups/:id/factor-enrolment/totp', Flows.SIGN_UP_RATE_LIMIT],
    ['/sign-ins/:id/factor-enrolment/totp', Flows.SIGN_UP_RATE_LIMIT],
    ['/password-resets/:id/factor-enrolment/totp', Flows.SIGN_UP_RATE_LIMIT],
    ['/sign-ups/:id/factor-enrolment/totp/confirm', Flows.CREDENTIAL_RATE_LIMIT],
    ['/sign-ins/:id/factor-enrolment/totp/confirm', Flows.CREDENTIAL_RATE_LIMIT],
    ['/password-resets/:id/factor-enrolment/totp/confirm', Flows.CREDENTIAL_RATE_LIMIT],
  ])('%s allows %d requests a minute from one address, then answers 429', async (route, limit) => {
    const path = route.replace(':id', crypto.randomUUID())
    const body = { method: 'totp', code: '123456' }
    for (let index = 0; index < limit; index++) {
      expect((await post(path, body, { attempt: 'x' })).status).toBe(404)
    }
    const limited = await post(path, body, { attempt: 'x' })
    expect(limited.status).toBe(429)
    expect(await json<unknown>(limited)).toMatchObject({ code: 'rate_limited' })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // A minute later the allowance is back.
    deps.clock.advance('1m')
    expect((await post(path, body, { attempt: 'x' })).status).toBe(404)
  })

  test('the limit is reached before the attempt or the code is looked at', async () => {
    const { path, body, userId } = await secondFactorCase('sign_in', 'totp')
    for (let index = 0; index < Flows.CREDENTIAL_RATE_LIMIT; index++) {
      await post(path, body, { attempt: 'x' })
    }
    const untouched = watch()
    const limited = await post(path, body)
    expect(limited.status).toBe(429)
    expect(setCookie(limited)).toBe('')
    untouched.expectUntouched()
    untouched.release()
    expect(await liveSessions(userId)).toEqual([])
  })
})
