import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type ClientConfig,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  type Factors,
  type FlowAttempt,
  type HybridSessionTokens as SessionTokens,
  type SmsFactorCode,
} from '@tula/contract'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import { base32Decode, totp } from '~/lib/totp'
import * as Audit from '~/modules/audit/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Phone from '~/modules/phone/service'
import * as Sessions from '~/modules/session/service'
import * as Sms from '~/modules/sms/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// A texted code as the second factor (ADR 0025, "A texted code as the second factor"; TULA-46).
//
// What these hold, beyond the path that works: a texted code is the weakest second factor and
// is listed alone or not at all; it never records `mfa`; one phone is never two steps; every
// code is of a purpose of its own and bound to what asked for it; every guess is counted under
// the user's second-factor key before the code is looked at; a step that sends or accepts one
// is refused, with nothing used up, once the environment's switch or text messages are off;
// and the factor goes with the number it is texted to.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const ORIGIN = 'https://app.northline.test'
const SCOPE = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const NUMBER = '+14155550142'
const OTHER_NUMBER = '+14155550177'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let revision = 0
let serial = 0
const spies: { mockRestore: () => void }[] = []

interface Switches {
  smsFactor?: boolean
  policy?: EnvironmentSettings['mfa']['policy']
  smsCode?: boolean
  passkey?: boolean
  sms?: Partial<EnvironmentSettings['sms']>
}

function configure(switches: Switches = {}) {
  revision += 1
  deps.environmentSettings.seed(SCOPE.environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      signIn: {
        methods: {
          password: { enabled: true },
          emailCode: { enabled: true },
          emailLink: { enabled: false },
          passkey: { enabled: switches.passkey ?? false },
          smsCode: { enabled: switches.smsCode ?? false },
        },
      },
      passkeys: { ...DEFAULT_ENVIRONMENT_SETTINGS.passkeys, rpId: 'app.northline.test' },
      mfa: {
        policy: switches.policy ?? 'optional',
        smsCode: { enabled: switches.smsFactor ?? true },
      },
      urls: { allowedOrigins: [ORIGIN], allowedRedirectUrls: [] },
      sms: { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 500, ...switches.sms },
    },
  })
}

beforeEach(async () => {
  deps = createTestDeps()
  serial = 0
  deps.clock.set(new Date('2026-10-08T09:00:00.000Z'))
  deps.environments.add({
    id: SCOPE.environmentId,
    projectId: SCOPE.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  configure()
  app = createApp(deps)
})

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

interface CallOptions {
  token?: string
  secret?: string
}

async function call(method: string, path: string, body?: unknown, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-client': 'ios',
    'x-tula-publishable-key': PK,
    origin: ORIGIN,
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  if (options.secret) {
    headers['x-tula-attempt'] = options.secret
  }
  return app.request(`/v1/client${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const post = (path: string, body: unknown = {}, options: CallOptions = {}) =>
  call('POST', path, body, options)
const json = async <T>(res: Response) => (await res.json()) as T
const errorOf = async (res: Response) =>
  json<{ code: string; params?: Record<string, unknown> }>(res)
const codeOf = async (res: Response) => (await errorOf(res)).code

/** The code in the newest text message to a number. */
const textedCode = (to: string = NUMBER) =>
  /code is (\d{6})\./.exec(deps.sms.messages(to).at(-1)?.text ?? '')?.[1] ?? ''
const emailedCode = () =>
  /^(\d{6}) /.exec(
    deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))?.subject ?? ''
  )?.[1] ?? ''
const wrong = (code: string) => (code === '000000' ? '000001' : '000000')
const eventTypes = () => deps.activityLog.events.map((event) => event.type)
const lockKey = (userId: string) => Mfa.secondFactorLockKey(SCOPE.environmentId, userId)

interface Seed {
  emailVerified?: boolean
  phoneNumber?: string | null
  /** A texted code is already the user's second factor. */
  smsFactor?: boolean
}

async function seedUser(seed: Seed = {}): Promise<string> {
  serial += 1
  const id = `0198c0de-0000-7000-8000-${String(serial).padStart(12, '0')}`
  const now = deps.clock.now()
  await deps.users.create(
    {
      id,
      projectId: SCOPE.projectId,
      environmentId: SCOPE.environmentId,
      email: serial === 1 ? EMAIL : `user${serial}@northline.app`,
      emailNormalized: serial === 1 ? EMAIL : `user${serial}@northline.app`,
      emailVerifiedAt: (seed.emailVerified ?? true) ? now : null,
      firstName: null,
      lastName: null,
      createdAt: now,
      identityId: `${id}-identity`,
      credentialId: `${id}-credential`,
      passwordHash: await Bun.password.hash(PASSWORD, {
        algorithm: 'argon2id',
        memoryCost: 8,
        timeCost: 1,
      }),
    } as Parameters<typeof deps.users.create>[0],
    Audit.none('fixture')
  )
  const phoneNumber = seed.phoneNumber === undefined ? NUMBER : seed.phoneNumber
  if (phoneNumber !== null) {
    await deps.users.setPhoneNumber(
      SCOPE.environmentId,
      id,
      phoneNumber,
      now,
      Audit.none('fixture'),
      Audit.none('fixture')
    )
    if (seed.smsFactor) {
      expect(
        await deps.users.enableSmsFactor(
          SCOPE.environmentId,
          id,
          phoneNumber,
          now,
          Audit.none('fixture')
        )
      ).toBe(true)
    }
  }
  return id
}

/** A session as a sign-in would have made it, with tokens issued now. */
const sessionFor = (userId: string, authMethods: string[] = ['pwd']) =>
  Sessions.create(deps, SCOPE, { userId, client: 'ios', userAgent: 'test', authMethods })

const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
    amr?: string[]
    sub: string
    auth_time?: number
  }

/** Give a user a confirmed authenticator app, without touching their sessions' claims. */
async function enrolTotp(userId: string): Promise<string> {
  const { secret } = await Mfa.startTotp(deps, SCOPE, userId)
  await Mfa.confirmTotp(
    deps,
    SCOPE,
    { userId },
    totp(base32Decode(secret), deps.clock.now()),
    { type: 'user', id: userId, ipAddress: null, userAgent: null },
    { notify: false }
  )
  deps.clock.advance('30s')
  return secret
}

async function addPasskey(userId: string) {
  expect(
    await deps.passkeys.create(
      {
        id: deps.ids.next(),
        ...SCOPE,
        userId,
        credentialId: `credential-${userId}`,
        publicKey: new TextEncoder().encode('key'),
        signCount: 0,
        transports: ['internal'],
        aaguid: '00000000-0000-0000-0000-000000000000',
        backupEligible: true,
        backedUp: true,
        userHandle: `handle-${userId}`,
        name: 'Laptop',
        lastUsedAt: null,
        createdAt: deps.clock.now(),
      },
      10,
      Audit.none('fixture')
    )
  ).toBe('created')
}

async function startSignIn(identifier: string = EMAIL): Promise<FlowAttempt> {
  const res = await post('/sign-ins', { identifier })
  expect(res.status).toBe(200)
  return json<FlowAttempt>(res)
}

const submitPassword = (attempt: FlowAttempt) =>
  post(
    `/sign-ins/${attempt.id}/password`,
    { password: PASSWORD },
    { secret: attempt.attemptSecret }
  )

/** A sign-in that has proven the password and waits on the second factor. */
async function parked(): Promise<FlowAttempt> {
  const attempt = await startSignIn()
  const res = await submitPassword(attempt)
  expect(res.status).toBe(200)
  const waiting = await json<FlowAttempt>(res)
  expect(waiting.step.status).toBe('needs_second_factor')
  return { ...waiting, attemptSecret: attempt.attemptSecret }
}

const prepare = (attempt: FlowAttempt, kind = 'sign-ins') =>
  post(
    `/${kind}/${attempt.id}/second-factor/prepare`,
    { method: 'sms_code' },
    { secret: attempt.attemptSecret }
  )

const submit = (attempt: FlowAttempt, code: string, kind = 'sign-ins') =>
  post(
    `/${kind}/${attempt.id}/second-factor`,
    { method: 'sms_code', code },
    { secret: attempt.attemptSecret }
  )

/** Record the order of the guess being counted and the code being looked at. */
function watchOrder(userId: string) {
  const order: string[] = []
  const count = deps.lockout.attempt.bind(deps.lockout)
  const look = deps.verificationTokens.recordAttempt.bind(deps.verificationTokens)
  spies.push(
    spyOn(deps.lockout, 'attempt').mockImplementation((key, ...rest) => {
      order.push(key === lockKey(userId) ? 'counted' : `counted:${key}`)
      return count(key, ...rest)
    }),
    spyOn(deps.verificationTokens, 'recordAttempt').mockImplementation((...args) => {
      order.push('looked')
      return look(...args)
    })
  )
  return order
}

describe('the order of second factors is one function', () => {
  test('a texted code is the only weak factor', () => {
    expect(Mfa.isStrongSecondFactor('totp')).toBe(true)
    expect(Mfa.isStrongSecondFactor('backup_code')).toBe(true)
    expect(Mfa.isStrongSecondFactor('passkey')).toBe(true)
    expect(Mfa.isStrongSecondFactor('sms_code')).toBe(false)
  })

  test.each<[string, string[], Parameters<typeof Mfa.meetsSecondFactor>[1], boolean]>([
    ['nothing in force', ['pwd'], [], true],
    ['nothing in force, a texted code alone', ['sms'], [], true],
    ['a strong factor proven', ['pwd', 'otp', 'mfa'], ['totp', 'backup_code'], true],
    ['a strong factor in force, only a password proven', ['pwd'], ['totp'], false],
    ['a texted code never stands in for an authenticator', ['pwd', 'sms'], ['totp'], false],
    ['a texted code never stands in for a passkey', ['pwd', 'sms'], ['passkey'], false],
    ['a texted code in force, password and code proven', ['pwd', 'sms'], ['sms_code'], true],
    ['a texted code in force, address and code proven', ['sms', 'email'], ['sms_code'], true],
    ['a texted code in force, only the password proven', ['pwd'], ['sms_code'], false],
    ['one phone is not two steps', ['sms'], ['sms_code'], false],
    ['nothing proven', [], ['sms_code'], false],
  ])('%s', (_name, amr, methods, expected) => {
    expect(Mfa.meetsSecondFactor(amr, methods)).toBe(expected)
  })
})

describe('the environment switches it on, and it is off by default', () => {
  test('the default settings have it off, and enrolment is then refused with nothing sent', async () => {
    expect(DEFAULT_ENVIRONMENT_SETTINGS.mfa.smsCode).toEqual({ enabled: false })
    configure({ smsFactor: false })
    const userId = await seedUser()
    const session = await sessionFor(userId)
    const res = await post('/me/factors/sms', {}, { token: session.accessToken })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('mfa.not_available')
    expect(deps.sms.outbox).toHaveLength(0)
    const config = await json<ClientConfig>(await call('GET', '/config'))
    expect(config.mfa).toEqual({ policy: 'optional', smsCode: false })
  })

  test.each<[string, Switches, boolean, boolean]>([
    ['on, with text messages and a sender', {}, true, true],
    ['the switch is off', { smsFactor: false }, true, false],
    ['two-step verification is off', { policy: 'off' }, true, false],
    ['text messages are off', { sms: { enabled: false } }, true, false],
    ['no country is allowed', { sms: { allowedCountries: [] } }, true, false],
    ['the deployment has no sender', {}, false, false],
  ])('the client config says whether it can be had: %s', async (_n, switches, sender, shown) => {
    configure(switches)
    deps.sms.configured = sender
    const config = await json<ClientConfig>(await call('GET', '/config'))
    expect(config.mfa?.smsCode).toBe(shown)
  })
})

describe('enrolling a texted code as the second factor', () => {
  test('a code goes to the account’s own number; confirming it turns the factor on', async () => {
    const userId = await seedUser()
    const session = await sessionFor(userId)
    const elsewhere = await sessionFor(userId)
    const before = await json<Factors>(
      await call('GET', '/me/factors', undefined, { token: session.accessToken })
    )
    expect(before.sms).toEqual({ enabled: false, enabledAt: null, inUse: false, available: true })

    // A number in the body is not read: the code goes to the account's number.
    const started = await post(
      '/me/factors/sms',
      { phoneNumber: OTHER_NUMBER },
      { token: session.accessToken }
    )
    expect(started.status).toBe(200)
    expect(started.headers.get('cache-control')).toBe('no-store')
    const receipt = await json<SmsFactorCode>(started)
    expect(receipt).toMatchObject({ method: 'sms_code', destination: '***42' })
    expect(JSON.stringify(receipt)).not.toContain(NUMBER)
    expect(deps.sms.messages(NUMBER)).toHaveLength(1)
    expect(deps.sms.messages(OTHER_NUMBER)).toHaveLength(0)
    const code = textedCode()
    expect(JSON.stringify(receipt)).not.toContain(code)
    // Nothing is on until the code is confirmed.
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual([])

    const confirmed = await post(
      '/me/factors/sms/confirm',
      { code },
      { token: session.accessToken }
    )
    expect(confirmed.status).toBe(200)
    expect(confirmed.headers.get('cache-control')).toBe('no-store')
    expect((await json<Factors>(confirmed)).sms).toEqual({
      enabled: true,
      enabledAt: deps.clock.now().toISOString(),
      inUse: true,
      available: false,
    })
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual(['sms_code'])
    expect(await Mfa.stepUpMethods(deps, SCOPE, userId)).toEqual(['sms_code'])

    // Recorded once, with no number; the owner is told; the other session is gone.
    const recorded = deps.activityLog.events.filter((e) => e.type === 'user.sms_factor_enabled')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ target: { type: 'user', id: userId }, data: {} })
    await Notices.settled()
    expect(deps.mailer.outbox.map((mail) => mail.subject)).toContain(
      'Texted codes were turned on as the second step for your Tula account'
    )
    expect(await deps.sessions.findById(SCOPE.environmentId, elsewhere.sessionId)).toMatchObject({
      revokeReason: 'mfa_changed',
    })
    // This session has proven it: `sms`, and never `mfa`.
    const kept = await deps.sessions.findById(SCOPE.environmentId, session.sessionId)
    expect(kept?.revokedAt).toBeNull()
    expect([...(kept?.authMethods ?? [])].sort()).toEqual(['pwd', 'sms'])
    expect(await deps.smsUsage.sentOn(SCOPE.environmentId, '2026-10-08')).toBe(1)
  })

  test('the code is single use, and a second confirmation finds the factor already on', async () => {
    const userId = await seedUser()
    const session = await sessionFor(userId)
    await post('/me/factors/sms', {}, { token: session.accessToken })
    const code = textedCode()
    const token = (await sessionFor(userId)).accessToken
    expect(
      (await post('/me/factors/sms/confirm', { code }, { token: session.accessToken })).status
    ).toBe(200)
    // (The other session was ended by the confirmation.)
    expect((await post('/me/factors/sms/confirm', { code }, { token })).status).toBe(401)
    const again = await sessionFor(userId, ['pwd', 'sms'])
    const res = await post('/me/factors/sms/confirm', { code }, { token: again.accessToken })
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('mfa.already_enabled')
    expect(eventTypes().filter((type) => type === 'user.sms_factor_enabled')).toHaveLength(1)
  })

  test.each<[string, () => Promise<{ userId: string; switches?: Switches }>, number, string]>([
    [
      'an account with no phone number',
      async () => ({ userId: await seedUser({ phoneNumber: null }) }),
      409,
      'mfa.phone_number_required',
    ],
    [
      'a user who has it already',
      async () => ({ userId: await seedUser({ smsFactor: true }) }),
      409,
      'mfa.already_enabled',
    ],
    [
      'a user with an authenticator app',
      async () => {
        const userId = await seedUser()
        await enrolTotp(userId)
        return { userId }
      },
      409,
      'mfa.sms_not_allowed',
    ],
    [
      'a user with a passkey',
      async () => {
        const userId = await seedUser()
        await addPasskey(userId)
        return { userId, switches: { passkey: true } }
      },
      409,
      'mfa.sms_not_allowed',
    ],
    [
      'an environment with two-step verification off',
      async () => ({ userId: await seedUser(), switches: { policy: 'off' } }),
      403,
      'mfa.not_available',
    ],
  ])('refused for %s, with nothing sent and nothing counted', async (_n, arrange, status, code) => {
    const { userId, switches } = await arrange()
    if (switches) {
      configure(switches)
    }
    // Proven strongly and just now, so that only the enrolment's own rule refuses.
    const session = await sessionFor(userId, ['pwd', 'otp', 'sms', 'mfa'])
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)
    for (const [path, body] of [
      ['/me/factors/sms', {}],
      ['/me/factors/sms/confirm', { code: '123456' }],
    ] as const) {
      const res = await post(path, body, { token: session.accessToken })
      expect([path, res.status, await codeOf(res)]).toEqual([path, status, code])
    }
    expect(deps.sms.outbox).toHaveLength(0)
    expect(counted).not.toHaveBeenCalled()
    expect(eventTypes()).not.toContain('user.sms_factor_enabled')
  })

  test('a passkey the environment has switched off does not stand in the way', async () => {
    const userId = await seedUser()
    await addPasskey(userId)
    configure({ passkey: false })
    const session = await sessionFor(userId)
    expect((await post('/me/factors/sms', {}, { token: session.accessToken })).status).toBe(200)
  })

  test('needs a recent authentication, and a texted sign-in alone is never one', async () => {
    const userId = await seedUser()
    const stale = await sessionFor(userId)
    const texted = await sessionFor(userId, ['sms'])
    for (const path of ['/me/factors/sms', '/me/factors/sms/confirm']) {
      const res = await post(path, { code: '123456' }, { token: texted.accessToken })
      expect([path, res.status, await codeOf(res)]).toEqual([path, 403, 'auth.step_up_required'])
    }
    await deps.sessions.recordAuthentication(
      SCOPE.environmentId,
      stale.sessionId,
      {
        at: new Date(deps.clock.now().getTime() - 11 * 60_000),
        methods: ['pwd'],
        hookClaims: { claims: null },
      },
      Audit.none('fixture')
    )
    const old = await Sessions.refresh(deps, SCOPE, stale.refreshToken as string)
    const res = await post('/me/factors/sms', {}, { token: old.accessToken })
    expect(res.status).toBe(403)
    expect((await errorOf(res)).params).toEqual({ methods: 'password,email_code' })
    const removal = await call('DELETE', '/me/factors/sms', undefined, { token: old.accessToken })
    expect(await codeOf(removal)).toBe('auth.step_up_required')
    expect(deps.sms.outbox).toHaveLength(0)
  })

  test('a wrong code is counted under the second-factor key before it is looked at', async () => {
    const userId = await seedUser()
    const session = await sessionFor(userId)
    await post('/me/factors/sms', {}, { token: session.accessToken })
    const code = textedCode()
    const order = watchOrder(userId)
    const res = await post(
      '/me/factors/sms/confirm',
      { code: wrong(code) },
      { token: session.accessToken }
    )
    expect(res.status).toBe(422)
    expect(await codeOf(res)).toBe('mfa.invalid_code')
    expect(order).toEqual(['counted', 'looked'])
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual([])
    expect(eventTypes()).not.toContain('user.sms_factor_enabled')
  })

  test('with nothing pending there is nothing to guess at, and nothing is counted', async () => {
    const userId = await seedUser()
    const session = await sessionFor(userId)
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)
    const res = await post(
      '/me/factors/sms/confirm',
      { code: '123456' },
      { token: session.accessToken }
    )
    expect(res.status).toBe(410)
    expect(await codeOf(res)).toBe('mfa.enrolment_expired')
    expect(counted).not.toHaveBeenCalled()
  })

  test('a locked-out user is refused even with the right code', async () => {
    const userId = await seedUser()
    const session = await sessionFor(userId)
    await post('/me/factors/sms', {}, { token: session.accessToken })
    const code = textedCode()
    for (let i = 0; i <= CREDENTIAL_LOCKOUT.freeAttempts; i += 1) {
      await deps.lockout.attempt(lockKey(userId), CREDENTIAL_LOCKOUT, deps.clock.now())
    }
    const res = await post('/me/factors/sms/confirm', { code }, { token: session.accessToken })
    expect(res.status).toBe(429)
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual([])
  })

  test('a code asked for by one session confirms nothing for another', async () => {
    const userId = await seedUser()
    const asking = await sessionFor(userId)
    const other = await sessionFor(userId)
    await post('/me/factors/sms', {}, { token: asking.accessToken })
    const res = await post(
      '/me/factors/sms/confirm',
      { code: textedCode() },
      { token: other.accessToken }
    )
    expect(await codeOf(res)).toBe('mfa.invalid_code')
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual([])
  })

  test('a code that adds a number to an account is not honoured for an enrolment', async () => {
    const userId = await seedUser()
    const session = await sessionFor(userId)
    // The same number, asked for again by the phone routes: a `phone_verification` code.
    expect(
      (await post('/me/phone', { phoneNumber: NUMBER }, { token: session.accessToken })).status
    ).toBe(200)
    const phoneCode = textedCode()
    const res = await post(
      '/me/factors/sms/confirm',
      { code: phoneCode },
      { token: session.accessToken }
    )
    // No enrolment code is pending at all.
    expect(await codeOf(res)).toBe('mfa.enrolment_expired')
    // And the other way round: an enrolment code proves no number.
    deps.clock.advance('61s')
    const fresh = await sessionFor(userId)
    await post('/me/factors/sms', {}, { token: fresh.accessToken })
    const enrolmentCode = textedCode()
    const phone = await post(
      '/me/phone/verify',
      { code: enrolmentCode },
      { token: fresh.accessToken }
    )
    expect(phone.status).toBe(enrolmentCode === phoneCode ? 200 : 422)
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual([])
  })

  test('a number replaced while its code was on its way enrols nothing', async () => {
    const userId = await seedUser()
    const session = await sessionFor(userId)
    await post('/me/factors/sms', {}, { token: session.accessToken })
    const code = textedCode()
    await deps.users.setPhoneNumber(
      SCOPE.environmentId,
      userId,
      OTHER_NUMBER,
      deps.clock.now(),
      Audit.none('fixture'),
      Audit.none('fixture')
    )
    const res = await post('/me/factors/sms/confirm', { code }, { token: session.accessToken })
    // The code's keyed hash covers the number it was texted to.
    expect(await codeOf(res)).toBe('mfa.invalid_code')
    expect((await deps.users.findById(SCOPE.environmentId, userId))?.smsFactorEnabledAt).toBeNull()
  })

  test('a message that could not be sent is said so, and the earlier code keeps working', async () => {
    const userId = await seedUser()
    const session = await sessionFor(userId)
    await post('/me/factors/sms', {}, { token: session.accessToken })
    const code = textedCode()
    deps.clock.advance('61s')
    const later = await sessionFor(userId)
    deps.sms.failing = true
    const failed = await post('/me/factors/sms', {}, { token: later.accessToken })
    expect(failed.status).toBe(503)
    expect(await codeOf(failed)).toBe('sms.unavailable')
    deps.sms.failing = false
    // The first session's token is past its minute; its refresh token gets a new one.
    const renewed = await Sessions.refresh(deps, SCOPE, session.refreshToken as string)
    const res = await post('/me/factors/sms/confirm', { code }, { token: renewed.accessToken })
    expect(res.status).toBe(200)
  })

  test.each<[string, Switches, boolean, number, string]>([
    ['the switch', { smsFactor: false }, true, 403, 'mfa.not_available'],
    ['text messages', { sms: { enabled: false } }, true, 403, 'sms.disabled'],
    [
      'the number’s country',
      { sms: { allowedCountries: ['DE'] } },
      true,
      422,
      'sms.country_not_allowed',
    ],
    ['the sender', {}, false, 503, 'sms.unavailable'],
  ])(
    '%s taken away after the code was sent: refused, nothing counted',
    async (_n, switches, sender, status, code) => {
      const userId = await seedUser()
      const session = await sessionFor(userId)
      await post('/me/factors/sms', {}, { token: session.accessToken })
      const texted = textedCode()
      configure(switches)
      deps.sms.configured = sender
      const counted = spyOn(deps.lockout, 'attempt')
      spies.push(counted)
      const res = await post(
        '/me/factors/sms/confirm',
        { code: texted },
        { token: session.accessToken }
      )
      expect([res.status, await codeOf(res)]).toEqual([status, code])
      expect(counted).not.toHaveBeenCalled()
      expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual([])
      // Back on, the same code still confirms: nothing was spent.
      configure()
      deps.sms.configured = true
      expect(
        (await post('/me/factors/sms/confirm', { code: texted }, { token: session.accessToken }))
          .status
      ).toBe(200)
    }
  )
})

describe('signing in with a texted code as the second factor', () => {
  test('nothing is sent until asked; the code completes the sign-in as `sms`, never `mfa`', async () => {
    const userId = await seedUser({ smsFactor: true })
    const attempt = await parked()
    expect(attempt.step).toEqual({ status: 'needs_second_factor', options: ['sms_code'] })
    expect(attempt.session).toBeUndefined()
    expect(deps.sms.outbox).toHaveLength(0)

    const asked = await prepare(attempt)
    expect(asked.status).toBe(200)
    const waiting = await json<FlowAttempt>(asked)
    expect(waiting.step).toEqual({
      status: 'needs_second_factor',
      options: ['sms_code'],
      prepared: { method: 'sms_code', destination: '***42' },
    })
    expect(waiting.session).toBeUndefined()
    expect(deps.sms.messages(NUMBER)).toHaveLength(1)
    expect(eventTypes()).not.toContain('session.created')
    // Only the masked number is kept on the attempt.
    const stored = await deps.flowAttempts.findById(SCOPE.environmentId, attempt.id)
    expect(JSON.stringify(stored?.state)).not.toContain(NUMBER)

    const done = await submit(attempt, textedCode())
    expect(done.status).toBe(200)
    const complete = await json<FlowAttempt>(done)
    expect(complete.step).toMatchObject({ status: 'complete', userId })
    const session = complete.session as SessionTokens
    expect([...(claims(session.accessToken).amr ?? [])].sort()).toEqual(['pwd', 'sms'])
    // The proof is a recent authentication for this user: their factor is the texted code.
    const removal = await call('DELETE', '/me/factors/sms', undefined, {
      token: session.accessToken,
    })
    expect(removal.status).toBe(204)
  })

  test('the code is a keyed hash of a purpose of its own, bound to the attempt', async () => {
    await seedUser({ smsFactor: true })
    const attempt = await parked()
    await prepare(attempt)
    const code = textedCode()
    const token = await deps.verificationTokens.findLatest(
      SCOPE.environmentId,
      'sms_second_factor',
      {
        flowAttemptId: attempt.id,
      }
    )
    expect(token).toMatchObject({ purpose: 'sms_second_factor', destination: NUMBER, userId: null })
    expect(token?.codeHash).not.toContain(code)
    for (const purpose of ['sms_sign_in', 'sms_step_up', 'sms_factor_enrolment'] as const) {
      expect(
        await deps.verificationTokens.findLatest(SCOPE.environmentId, purpose, {
          flowAttemptId: attempt.id,
        })
      ).toBeNull()
    }
  })

  test('a wrong code is counted under the second-factor key before it is looked at', async () => {
    const userId = await seedUser({ smsFactor: true })
    const attempt = await parked()
    await prepare(attempt)
    const code = textedCode()
    const order = watchOrder(userId)
    const res = await submit(attempt, wrong(code))
    expect(res.status).toBe(422)
    expect(await codeOf(res)).toBe('mfa.invalid_code')
    expect(order).toEqual(['counted', 'looked'])
    expect(eventTypes()).not.toContain('session.created')
    // The right code still works, and clears the count.
    expect((await submit(attempt, code)).status).toBe(200)
    expect(order.filter((entry) => entry === 'counted')).toHaveLength(2)
  })

  test('a code texted for one attempt is refused on another', async () => {
    await seedUser({ smsFactor: true })
    const first = await parked()
    await prepare(first)
    const code = textedCode()
    const second = await parked()
    const res = await submit(second, code)
    expect(await codeOf(res)).toBe('mfa.invalid_code')
    expect(eventTypes()).not.toContain('session.created')
  })

  test('a code of another purpose is not a second factor, and a second-factor code is nothing else', async () => {
    const userId = await seedUser({ smsFactor: true })
    // A step-up code, asked for by a session of the same user.
    const session = await sessionFor(userId, ['pwd', 'sms'])
    expect(
      (await post('/sessions/step-up/sms-code', {}, { token: session.accessToken })).status
    ).toBe(200)
    const stepUpCode = textedCode()
    const attempt = await parked()
    expect(await codeOf(await submit(attempt, stepUpCode))).toBe('mfa.invalid_code')
    // A second-factor code steps no session up.
    deps.clock.advance('61s')
    await prepare(attempt)
    const secondFactorCode = textedCode()
    const fresh = await sessionFor(userId, ['pwd', 'sms'])
    const res = await post(
      '/sessions/step-up',
      { method: 'sms_code', code: secondFactorCode },
      { token: fresh.accessToken }
    )
    expect(res.status).toBe(secondFactorCode === stepUpCode ? 200 : 422)
    if (secondFactorCode !== stepUpCode) {
      expect(await codeOf(res)).toBe('mfa.invalid_code')
    }
  })

  test('a used code does not work twice', async () => {
    await seedUser({ smsFactor: true })
    const attempt = await parked()
    await prepare(attempt)
    const code = textedCode()
    expect((await submit(attempt, code)).status).toBe(200)
    const again = await parked()
    expect(await codeOf(await submit(again, code))).toBe('mfa.invalid_code')
  })

  test('a message that could not be sent is said so; the attempt waits and an earlier code works', async () => {
    await seedUser({ smsFactor: true })
    const attempt = await parked()
    await prepare(attempt)
    const code = textedCode()
    deps.clock.advance('61s')
    deps.sms.failing = true
    const failed = await prepare(attempt)
    expect(failed.status).toBe(503)
    expect(await codeOf(failed)).toBe('sms.unavailable')
    deps.sms.failing = false
    expect((await submit(attempt, code)).status).toBe(200)
  })

  test('the send limits apply: a second code within the minute is refused', async () => {
    await seedUser({ smsFactor: true })
    const attempt = await parked()
    expect((await prepare(attempt)).status).toBe(200)
    const res = await prepare(attempt)
    expect(res.status).toBe(429)
    expect(deps.sms.outbox).toHaveLength(1)
  })

  test.each<[string, Switches, boolean, number, string]>([
    ['the switch', { smsFactor: false }, true, 403, 'auth.method_disabled'],
    ['text messages', { sms: { enabled: false } }, true, 403, 'sms.disabled'],
    [
      'the number’s country',
      { sms: { allowedCountries: ['DE'] } },
      true,
      422,
      'sms.country_not_allowed',
    ],
    ['the sender', {}, false, 503, 'sms.unavailable'],
  ])(
    '%s off: asking and submitting are refused, nothing is used up, and the account stays closed',
    async (_n, switches, sender, status, code) => {
      const userId = await seedUser({ smsFactor: true })
      const attempt = await parked()
      await prepare(attempt)
      const texted = textedCode()
      configure(switches)
      deps.sms.configured = sender
      const counted = spyOn(deps.lockout, 'attempt')
      spies.push(counted)
      deps.clock.advance('61s')
      const asked = await prepare(attempt)
      expect([asked.status, await codeOf(asked)]).toEqual([status, code])
      const res = await submit(attempt, texted)
      expect([res.status, await codeOf(res)]).toEqual([status, code])
      expect(counted).not.toHaveBeenCalledWith(
        lockKey(userId),
        expect.anything(),
        expect.anything()
      )
      expect(deps.sms.outbox).toHaveLength(1)
      expect(eventTypes()).not.toContain('session.created')
      // It never falls open: a new sign-in is still asked for the factor.
      counted.mockRestore()
      expect((await parked()).step).toMatchObject({ options: ['sms_code'] })
      // Back on, the code that was texted still completes the first attempt.
      configure()
      deps.sms.configured = true
      expect((await submit(attempt, texted)).status).toBe(200)
    }
  )

  test('a banned user is told so only after the code, and gets no session', async () => {
    const userId = await seedUser({ smsFactor: true })
    const attempt = await parked()
    await prepare(attempt)
    await deps.users.setBanned(
      SCOPE.environmentId,
      userId,
      deps.clock.now(),
      deps.clock.now(),
      Audit.none('fixture')
    )
    expect(await codeOf(await submit(attempt, wrong(textedCode())))).toBe('mfa.invalid_code')
    expect(await codeOf(await submit(attempt, textedCode()))).toBe('auth.user_banned')
    expect(eventTypes()).not.toContain('session.created')
  })

  test('without the attempt’s secret nothing is sent or checked', async () => {
    await seedUser({ smsFactor: true })
    const attempt = await parked()
    for (const secret of [undefined, 'tula_at_wrong']) {
      const asked = await prepare({ ...attempt, attemptSecret: secret })
      expect([asked.status, await codeOf(asked)]).toEqual([404, 'flow.not_found'])
    }
    expect(deps.sms.outbox).toHaveLength(0)
  })

  test('where two-step verification is required, a user with a texted code is asked for it, not to enrol', async () => {
    await seedUser({ smsFactor: true })
    configure({ policy: 'required' })
    const attempt = await parked()
    expect(attempt.step).toEqual({ status: 'needs_second_factor', options: ['sms_code'] })
  })

  test('with the policy off a texted code a user has is still asked for', async () => {
    await seedUser({ smsFactor: true })
    configure({ policy: 'off' })
    expect((await parked()).step).toMatchObject({ options: ['sms_code'] })
  })

  test('a password reset stops at the texted code and removes nothing', async () => {
    const userId = await seedUser({ smsFactor: true })
    const started = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }))
    const res = await post(
      `/password-resets/${started.id}/password`,
      { code: emailedCode(), password: 'a new and rather long passphrase' },
      { secret: started.attemptSecret }
    )
    const waiting = await json<FlowAttempt>(res)
    expect(waiting.step).toEqual({ status: 'needs_second_factor', options: ['sms_code'] })
    expect(waiting.session).toBeUndefined()
    expect(
      (await deps.users.findById(SCOPE.environmentId, userId))?.smsFactorEnabledAt
    ).not.toBeNull()
    const attempt = { ...waiting, attemptSecret: started.attemptSecret }
    expect((await prepare(attempt, 'password-resets')).status).toBe(200)
    const done = await json<FlowAttempt>(await submit(attempt, textedCode(), 'password-resets'))
    expect(done.step.status).toBe('complete')
    expect([...(claims((done.session as SessionTokens).accessToken).amr ?? [])].sort()).toEqual([
      'email',
      'sms',
    ])
  })
})

describe('a texted code is never used beside a stronger factor', () => {
  test('a user with an authenticator app is not offered it, sent it or let in by it', async () => {
    const userId = await seedUser({ smsFactor: true })
    const secret = await enrolTotp(userId)
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual(['totp', 'backup_code'])
    const status = await Mfa.status(deps, SCOPE, userId)
    expect(status.sms).toMatchObject({ enabled: true, inUse: false, available: false })

    const attempt = await parked()
    expect(attempt.step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code'],
    })
    const asked = await prepare(attempt)
    expect([asked.status, await codeOf(asked)]).toEqual([409, 'flow.invalid_step'])
    const res = await submit(attempt, '123456')
    expect([res.status, await codeOf(res)]).toEqual([409, 'flow.invalid_step'])
    expect(deps.sms.outbox).toHaveLength(0)
    // The authenticator still completes it, with `mfa`.
    const done = await json<FlowAttempt>(
      await post(
        `/sign-ins/${attempt.id}/second-factor`,
        { method: 'totp', code: totp(base32Decode(secret), deps.clock.now()) },
        { secret: attempt.attemptSecret }
      )
    )
    expect(claims((done.session as SessionTokens).accessToken).amr).toContain('mfa')
  })

  test('a user with a passkey is asked for the passkey', async () => {
    const userId = await seedUser({ smsFactor: true })
    await addPasskey(userId)
    configure({ passkey: true })
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual(['passkey'])
    expect(await Mfa.stepUpMethods(deps, SCOPE, userId)).toEqual(['passkey'])
    const attempt = await parked()
    expect(attempt.step).toEqual({ status: 'needs_second_factor', options: ['passkey'] })
    expect(await codeOf(await prepare(attempt))).toBe('flow.invalid_step')
    // With passkeys switched off the passkey cannot be used, and the texted code is what is left.
    configure({ passkey: false })
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual(['sms_code'])
  })

  test('an authenticator enrolled while the attempt waits: no text is sent, and a texted code is refused', async () => {
    const userId = await seedUser({ smsFactor: true })
    const attempt = await parked()
    await prepare(attempt)
    const code = textedCode()
    await enrolTotp(userId)
    deps.clock.advance('61s')
    const asked = await prepare(attempt)
    expect([asked.status, await codeOf(asked)]).toEqual([409, 'flow.invalid_step'])
    expect(deps.sms.outbox).toHaveLength(1)
    expect(await codeOf(await submit(attempt, code))).toBe('mfa.invalid_code')
    expect(eventTypes()).not.toContain('session.created')
  })

  test('a session that proved only a texted code is not recent for a user with an authenticator', async () => {
    const userId = await seedUser({ smsFactor: true })
    await enrolTotp(userId)
    const session = await sessionFor(userId, ['pwd', 'sms'])
    const res = await call('DELETE', '/me/factors/sms', undefined, { token: session.accessToken })
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toMatchObject({
      code: 'auth.step_up_required',
      params: { methods: 'totp,backup_code' },
    })
  })

  test('stepping up by texted code is refused, and nothing is sent', async () => {
    const userId = await seedUser({ smsFactor: true })
    await enrolTotp(userId)
    const session = await sessionFor(userId, ['pwd', 'otp', 'mfa'])
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)
    const asked = await post('/sessions/step-up/sms-code', {}, { token: session.accessToken })
    expect(asked.status).toBe(403)
    expect(await errorOf(asked)).toMatchObject({
      code: 'auth.step_up_required',
      params: { methods: 'totp,backup_code' },
    })
    const res = await post(
      '/sessions/step-up',
      { method: 'sms_code', code: '123456' },
      { token: session.accessToken }
    )
    expect(await codeOf(res)).toBe('auth.step_up_required')
    expect(deps.sms.outbox).toHaveLength(0)
    expect(counted).not.toHaveBeenCalled()
  })

  test('removing it beside an authenticator is allowed even where a second factor is required', async () => {
    const userId = await seedUser({ smsFactor: true })
    await enrolTotp(userId)
    configure({ policy: 'required' })
    const session = await sessionFor(userId, ['pwd', 'otp', 'mfa'])
    const res = await call('DELETE', '/me/factors/sms', undefined, { token: session.accessToken })
    expect(res.status).toBe(204)
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual(['totp', 'backup_code'])
  })
})

describe('one phone is not two steps', () => {
  /** A sign-in by texted code (the first factor), with its code asked for. */
  async function textedSignIn(): Promise<FlowAttempt> {
    const attempt = await startSignIn(NUMBER)
    const res = await post(
      `/sign-ins/${attempt.id}/first-factor/prepare`,
      { strategy: 'sms_code' },
      { secret: attempt.attemptSecret }
    )
    expect(res.status).toBe(200)
    await Sms.settled()
    return attempt
  }
  const firstFactor = (attempt: FlowAttempt, code: string) =>
    post(
      `/sign-ins/${attempt.id}/first-factor/attempt`,
      { strategy: 'sms_code', code },
      { secret: attempt.attemptSecret }
    )

  test('a texted sign-in cannot be completed by a texted second step', async () => {
    await seedUser({ smsFactor: true })
    configure({ smsCode: true })
    const attempt = await textedSignIn()
    const code = textedCode()
    const res = await firstFactor(attempt, code)
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('mfa.needs_other_sign_in')
    // Nothing was spent or moved: the attempt still waits on its first factor.
    const token = await deps.verificationTokens.findLatest(SCOPE.environmentId, 'sms_sign_in', {
      flowAttemptId: attempt.id,
    })
    expect(token).toMatchObject({ consumedAt: null })
    const stored = await deps.flowAttempts.findById(SCOPE.environmentId, attempt.id)
    expect(stored).toMatchObject({ status: 'needs_first_factor', userId: null })
    expect(eventTypes()).not.toContain('session.created')
    // No second-factor step opens for it either.
    expect(await codeOf(await prepare(attempt))).toBe('flow.invalid_step')
    // Signed in with the password, the texted code is the second step.
    expect((await parked()).step).toMatchObject({ options: ['sms_code'] })
  })

  test('a texted sign-in that also proves the address is two things, and is not texted again', async () => {
    const userId = await seedUser({ smsFactor: true, emailVerified: false })
    configure({ smsCode: true })
    const attempt = await textedSignIn()
    const waiting = await json<FlowAttempt>(await firstFactor(attempt, textedCode()))
    expect(waiting.step.status).toBe('needs_email_verification')
    const done = await json<FlowAttempt>(
      await post(
        `/sign-ins/${attempt.id}/verify-email`,
        { code: emailedCode() },
        { secret: attempt.attemptSecret }
      )
    )
    expect(done.step).toMatchObject({ status: 'complete', userId })
    expect([...(claims((done.session as SessionTokens).accessToken).amr ?? [])].sort()).toEqual([
      'email',
      'sms',
    ])
    expect(deps.sms.outbox).toHaveLength(1)
  })

  test('a texted sign-in still stops at an authenticator', async () => {
    const userId = await seedUser({ smsFactor: true })
    await enrolTotp(userId)
    configure({ smsCode: true })
    const attempt = await textedSignIn()
    const waiting = await json<FlowAttempt>(await firstFactor(attempt, textedCode()))
    expect(waiting.step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code'],
    })
  })

  test('where a second factor is required, a texted sign-in still cannot enrol one', async () => {
    await seedUser()
    configure({ smsCode: true, policy: 'required' })
    const attempt = await textedSignIn()
    expect(await codeOf(await firstFactor(attempt, textedCode()))).toBe(
      'mfa.enrolment_needs_other_sign_in'
    )
  })
})

describe('stepping up with a texted code', () => {
  test('only for a user whose only second factor it is; recorded as `sms`', async () => {
    const userId = await seedUser({ smsFactor: true })
    // Signed in properly, but long enough ago that a sensitive change needs a step-up.
    const session = await sessionFor(userId, ['pwd', 'sms'])
    await deps.sessions.recordAuthentication(
      SCOPE.environmentId,
      session.sessionId,
      {
        at: new Date(deps.clock.now().getTime() - 11 * 60_000),
        methods: ['pwd', 'sms'],
        hookClaims: { claims: null },
      },
      Audit.none('fixture')
    )
    const stale = await Sessions.refresh(deps, SCOPE, session.refreshToken as string)
    const refused = await call('DELETE', '/me/factors/sms', undefined, { token: stale.accessToken })
    expect(await errorOf(refused)).toMatchObject({
      code: 'auth.step_up_required',
      params: { methods: 'sms_code' },
    })

    const asked = await post('/sessions/step-up/sms-code', {}, { token: stale.accessToken })
    expect(asked.status).toBe(200)
    expect(asked.headers.get('cache-control')).toBe('no-store')
    expect(await json<SmsFactorCode>(asked)).toMatchObject({
      method: 'sms_code',
      destination: '***42',
    })
    const code = textedCode()
    const order = watchOrder(userId)
    const res = await post(
      '/sessions/step-up',
      { method: 'sms_code', code },
      { token: stale.accessToken }
    )
    expect(res.status).toBe(200)
    expect(order).toEqual(['counted', 'looked'])
    const stepped = await json<SessionTokens>(res)
    const proven = claims(stepped.accessToken)
    expect([...(proven.amr ?? [])].sort()).toEqual(['pwd', 'sms'])
    expect(proven.auth_time).toBe(Math.floor(deps.clock.now().getTime() / 1000))
    expect(
      (await call('DELETE', '/me/factors/sms', undefined, { token: stepped.accessToken })).status
    ).toBe(204)
  })

  test('a user with no second factor is never texted, and never steps up by phone', async () => {
    const userId = await seedUser()
    const session = await sessionFor(userId)
    const asked = await post('/sessions/step-up/sms-code', {}, { token: session.accessToken })
    expect(asked.status).toBe(403)
    expect(await errorOf(asked)).toMatchObject({
      code: 'auth.step_up_required',
      params: { methods: 'password,email_code' },
    })
    const res = await post(
      '/sessions/step-up',
      { method: 'sms_code', code: '123456' },
      { token: session.accessToken }
    )
    expect(await codeOf(res)).toBe('auth.step_up_required')
    expect(deps.sms.outbox).toHaveLength(0)
  })

  test('a wrong code is `mfa.invalid_code`, counted first; another session’s code steps nothing up', async () => {
    const userId = await seedUser({ smsFactor: true })
    const asking = await sessionFor(userId, ['pwd', 'sms'])
    const other = await sessionFor(userId, ['pwd', 'sms'])
    await post('/sessions/step-up/sms-code', {}, { token: asking.accessToken })
    const code = textedCode()
    const order = watchOrder(userId)
    const foreign = await post(
      '/sessions/step-up',
      { method: 'sms_code', code },
      { token: other.accessToken }
    )
    expect([foreign.status, await codeOf(foreign)]).toEqual([422, 'mfa.invalid_code'])
    expect(order).toEqual(['counted', 'looked'])
    const bad = await post(
      '/sessions/step-up',
      { method: 'sms_code', code: wrong(code) },
      { token: asking.accessToken }
    )
    expect(await codeOf(bad)).toBe('mfa.invalid_code')
  })

  test('a code texted to enrol the factor steps nothing up', async () => {
    const userId = await seedUser()
    const session = await sessionFor(userId)
    await post('/me/factors/sms', {}, { token: session.accessToken })
    const enrolmentCode = textedCode()
    // Turned on by other means, so that only the purpose stands between the code and a step-up.
    await deps.users.enableSmsFactor(
      SCOPE.environmentId,
      userId,
      NUMBER,
      deps.clock.now(),
      Audit.none('fixture')
    )
    const res = await post(
      '/sessions/step-up',
      { method: 'sms_code', code: enrolmentCode },
      { token: session.accessToken }
    )
    expect(await codeOf(res)).toBe('mfa.invalid_code')
  })

  test.each<[string, Switches, boolean, number, string]>([
    ['the switch', { smsFactor: false }, true, 403, 'auth.method_disabled'],
    ['text messages', { sms: { enabled: false } }, true, 403, 'sms.disabled'],
    ['the sender', {}, false, 503, 'sms.unavailable'],
  ])('%s off: nothing is sent, nothing is counted', async (_n, switches, sender, status, code) => {
    const userId = await seedUser({ smsFactor: true })
    const session = await sessionFor(userId, ['pwd', 'sms'])
    configure(switches)
    deps.sms.configured = sender
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)
    const asked = await post('/sessions/step-up/sms-code', {}, { token: session.accessToken })
    expect([asked.status, await codeOf(asked)]).toEqual([status, code])
    const res = await post(
      '/sessions/step-up',
      { method: 'sms_code', code: '123456' },
      { token: session.accessToken }
    )
    expect([res.status, await codeOf(res)]).toEqual([status, code])
    expect(deps.sms.outbox).toHaveLength(0)
    expect(counted).not.toHaveBeenCalled()
  })
})

describe('removing it', () => {
  test('the owner turns it off: recorded, announced, and the number stays', async () => {
    const userId = await seedUser({ smsFactor: true })
    const session = await sessionFor(userId, ['pwd', 'sms'])
    const res = await call('DELETE', '/me/factors/sms', undefined, { token: session.accessToken })
    expect(res.status).toBe(204)
    const user = await deps.users.findById(SCOPE.environmentId, userId)
    expect(user).toMatchObject({ phoneNumber: NUMBER, smsFactorEnabledAt: null })
    const removed = deps.activityLog.events.filter((e) => e.type === 'user.sms_factor_removed')
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatchObject({ data: { method: 'self' } })
    await Notices.settled()
    expect(deps.mailer.outbox.map((mail) => mail.subject)).toContain(
      'Texted codes are no longer the second step for your Tula account'
    )
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual([])
    const again = await call('DELETE', '/me/factors/sms', undefined, { token: session.accessToken })
    expect([again.status, await codeOf(again)]).toEqual([409, 'mfa.not_enabled'])
  })

  test('refused where a second factor is required and it is the one in use', async () => {
    const userId = await seedUser({ smsFactor: true })
    configure({ policy: 'required' })
    const session = await sessionFor(userId, ['pwd', 'sms'])
    const res = await call('DELETE', '/me/factors/sms', undefined, { token: session.accessToken })
    expect([res.status, await codeOf(res)]).toEqual([403, 'mfa.required_by_policy'])
    expect(eventTypes()).not.toContain('user.sms_factor_removed')
  })

  test('taking the number off the account takes the factor with it, in one write', async () => {
    const userId = await seedUser({ smsFactor: true })
    const session = await sessionFor(userId, ['pwd', 'sms'])
    const res = await call('DELETE', '/me/phone', undefined, { token: session.accessToken })
    expect(res.status).toBeLessThan(300)
    const user = await deps.users.findById(SCOPE.environmentId, userId)
    expect(user).toMatchObject({ phoneNumber: null, smsFactorEnabledAt: null })
    expect(
      deps.activityLog.events
        .filter((e) => e.type.startsWith('user.phone') || e.type.startsWith('user.sms'))
        .map((e) => [e.type, e.data])
    ).toEqual([
      ['user.phone_number_removed', {}],
      ['user.sms_factor_removed', { method: 'phone_number_removed' }],
    ])
    await Notices.settled()
    expect(deps.mailer.outbox.map((mail) => mail.subject)).toContain(
      'Texted codes are no longer the second step for your Tula account'
    )
    expect(await Mfa.secondFactors(deps, SCOPE, userId)).toEqual([])
  })

  test('a number without the factor is removed with one entry and no notice', async () => {
    const userId = await seedUser()
    const actor = { userId }
    expect(await Phone.remove(deps, SCOPE, actor)).toBe(true)
    expect(eventTypes()).toEqual(['user.phone_number_removed'])
    await Notices.settled()
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('another number replaces the factor’s number: the factor goes; the same number keeps it', async () => {
    const userId = await seedUser({ smsFactor: true })
    const session = await sessionFor(userId, ['pwd', 'sms'])
    // The same number proven again: nothing changes.
    await post('/me/phone', { phoneNumber: NUMBER }, { token: session.accessToken })
    expect(
      (await post('/me/phone/verify', { code: textedCode() }, { token: session.accessToken }))
        .status
    ).toBe(200)
    expect(
      (await deps.users.findById(SCOPE.environmentId, userId))?.smsFactorEnabledAt
    ).not.toBeNull()
    expect(eventTypes()).not.toContain('user.sms_factor_removed')

    // A minute on (the gap between two codes for one asker), with a token issued then.
    deps.clock.advance('61s')
    const later = await sessionFor(userId, ['pwd', 'sms'])
    await post('/me/phone', { phoneNumber: OTHER_NUMBER }, { token: later.accessToken })
    expect(
      (
        await post(
          '/me/phone/verify',
          { code: textedCode(OTHER_NUMBER) },
          { token: later.accessToken }
        )
      ).status
    ).toBe(200)
    const user = await deps.users.findById(SCOPE.environmentId, userId)
    expect(user).toMatchObject({ phoneNumber: OTHER_NUMBER, smsFactorEnabledAt: null })
    const removed = deps.activityLog.events.filter((e) => e.type === 'user.sms_factor_removed')
    expect(removed.map((e) => e.data)).toEqual([{ method: 'phone_number_changed' }])
    await Notices.settled()
    expect(deps.mailer.outbox.map((mail) => mail.subject)).toContain(
      'Texted codes are no longer the second step for your Tula account'
    )
  })

  test('an administrator’s reset removes it, keeps the number and ends every session', async () => {
    const userId = await seedUser({ smsFactor: true })
    const session = await sessionFor(userId, ['pwd', 'sms'])
    const res = await app.request(`/v1/admin/users/${userId}/factors`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('x-tula-can-still-sign-in')).toBe('true')
    const user = await deps.users.findById(SCOPE.environmentId, userId)
    expect(user).toMatchObject({ phoneNumber: NUMBER, smsFactorEnabledAt: null })
    const removed = deps.activityLog.events.filter((e) => e.type === 'user.sms_factor_removed')
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatchObject({
      data: { method: 'admin_reset' },
      actor: { type: 'admin' },
    })
    expect(
      (await deps.sessions.findById(SCOPE.environmentId, session.sessionId))?.revokedAt
    ).not.toBeNull()
    await Notices.settled()
    expect(deps.mailer.outbox.map((mail) => mail.subject)).toContain(
      'Two-step verification was reset for your Tula account'
    )
    // The next sign-in needs the password alone.
    const attempt = await startSignIn()
    expect((await json<FlowAttempt>(await submitPassword(attempt))).step.status).toBe('complete')
  })

  test('an administrator sees it among the user’s factors, without the number', async () => {
    const userId = await seedUser({ smsFactor: true })
    const res = await app.request(`/v1/admin/users/${userId}/authentication`, {
      headers: { authorization: `Bearer ${SK}` },
    })
    const body = await json<{ factors: { type: string; confirmedAt: string }[] }>(res)
    expect(body.factors).toEqual([{ type: 'sms', confirmedAt: deps.clock.now().toISOString() }])
    expect(JSON.stringify(body)).not.toContain(NUMBER.slice(1))
  })
})

describe('nothing of a number or a code travels', () => {
  test('no log line, event or audit entry of an enrolment, a sign-in and a step-up holds either', async () => {
    const lines: unknown[] = []
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      spies.push(
        spyOn(logger, level).mockImplementation((...args: unknown[]) => {
          lines.push(args)
        })
      )
    }
    const keys: string[] = []
    const hit = spyOn(deps.rateLimiter, 'hit')
    spies.push(hit)
    const userId = await seedUser()
    const session = await sessionFor(userId)
    await post('/me/factors/sms', {}, { token: session.accessToken })
    const codes = [textedCode()]
    await post('/me/factors/sms/confirm', { code: codes[0] }, { token: session.accessToken })
    deps.clock.advance('61s')
    const attempt = await parked()
    await prepare(attempt)
    codes.push(textedCode())
    await submit(attempt, wrong(textedCode()))
    const done = await json<FlowAttempt>(await submit(attempt, textedCode()))
    deps.clock.advance('61s')
    const fresh = await sessionFor(userId, ['pwd', 'sms'])
    await post('/sessions/step-up/sms-code', {}, { token: fresh.accessToken })
    codes.push(textedCode())
    await post(
      '/sessions/step-up',
      { method: 'sms_code', code: textedCode() },
      { token: fresh.accessToken }
    )
    await Notices.settled()
    expect(done.step.status).toBe('complete')
    for (const call of hit.mock.calls) {
      keys.push(String(call[0]))
    }
    const digits = NUMBER.slice(1)
    const everything = JSON.stringify([
      lines,
      deps.activityLog.events,
      deps.activityLog.entries,
      deps.mailer.outbox,
      keys,
    ])
    expect(everything).not.toContain(digits)
    expect(everything).not.toContain(digits.slice(-10))
    for (const code of codes) {
      expect(JSON.stringify([lines, deps.activityLog.events, deps.mailer.outbox])).not.toContain(
        code
      )
    }
    // The limits are counted for an asker of this use's own: the user's id.
    expect(keys.some((key) => key.includes(`:second_factor:${userId}`))).toBe(true)
    expect(keys.some((key) => key.includes(`:user:${userId}`))).toBe(false)
  })
})
