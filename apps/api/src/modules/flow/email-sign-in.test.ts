import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  type FlowAttempt,
} from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { RateLimitError, ServiceException } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import * as Factors from '~/modules/factor/service'
import * as Flows from '~/modules/flow/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import * as Verification from '~/modules/verification/service'
import { CREDENTIAL_LOCKOUT, signInLockKey } from '~/ports/lockout'
import { createTestDeps, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const EMAIL = 'Maya@Northline.app'
const NORMALIZED = 'maya@northline.app'
const STRANGER = 'nobody@northline.app'
const PASSWORD = 'correct horse battery staple'
const REDIRECT = 'https://app.northline.test/auth/link'
const web: Flows.ClientContext = {
  client: 'web',
  userAgent: 'Mozilla/5.0',
  ipAddress: '203.0.113.7',
  originAllowed: true,
}
const foreign: Flows.ClientContext = { ...web, originAllowed: false }

type Presented = Pick<FlowAttempt, 'id' | 'attemptSecret'>
const ref = (attempt: Presented): Flows.AttemptRef => ({
  id: attempt.id,
  secret: attempt.attemptSecret,
})

let deps: TestDeps
const spies: ReturnType<typeof spyOn>[] = []

interface Switches {
  password?: boolean
  emailCode?: boolean
  emailLink?: boolean
  signUpPassword?: EnvironmentSettings['signUp']['password']
  redirects?: string[]
}

function settings(switches: Switches = {}): EnvironmentSettings {
  return {
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    signIn: {
      methods: {
        password: { enabled: switches.password ?? true },
        emailCode: { enabled: switches.emailCode ?? true },
        emailLink: { enabled: switches.emailLink ?? true },
      },
    },
    signUp: { password: switches.signUpPassword ?? 'required' },
    urls: { allowedOrigins: [], allowedRedirectUrls: switches.redirects ?? [REDIRECT] },
  }
}

let revision = 0
function configure(switches: Switches = {}, target: Tenant = tenant) {
  revision += 1
  deps.environmentSettings.seed(target.environmentId, { revision, settings: settings(switches) })
}

function build(overrides: Parameters<typeof createTestDeps>[0] = {}) {
  deps = createTestDeps(overrides)
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
  configure()
}

beforeEach(() => build())
afterEach(async () => {
  await Notices.settled()
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

async function rejection(promise: Promise<unknown>): Promise<ServiceException> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ServiceException) {
      return err
    }
    throw err
  }
  throw new Error('expected a rejection')
}

async function seedUser(
  options: { email?: string; verified?: boolean; password?: boolean; banned?: boolean } = {},
  target: Tenant = tenant
) {
  const id = deps.ids.next()
  const email = options.email ?? EMAIL
  await deps.users.create({
    id,
    projectId: target.projectId,
    environmentId: target.environmentId,
    email,
    emailNormalized: email.toLowerCase(),
    emailVerifiedAt: options.verified === false ? null : deps.clock.now(),
    firstName: null,
    lastName: null,
    createdAt: deps.clock.now(),
    identityId: deps.ids.next(),
    credentialId: deps.ids.next(),
    passwordHash: options.password === false ? null : await Passwords.hash(PASSWORD),
  })
  if (options.banned) {
    await deps.users.setBanned(target.environmentId, id, deps.clock.now(), deps.clock.now())
  }
  return id
}

const start = async (identifier = EMAIL, context = web, target = tenant) =>
  (await Flows.signIn(deps, target, { identifier }, context)).attempt

const prepare = (
  attempt: Presented,
  input: Parameters<typeof Flows.prepareFirstFactor>[3] = { strategy: 'email_code' },
  context = web,
  target = tenant
) => Flows.prepareFirstFactor(deps, target, ref(attempt), input, context)

const submitCode = (attempt: Presented, code: string, context = web, target = tenant) =>
  Flows.attemptFirstFactor(deps, target, ref(attempt), { strategy: 'email_code', code }, context)

const poll = (attempt: Presented, context = web, target = tenant) =>
  Flows.attemptFirstFactor(deps, target, ref(attempt), { strategy: 'email_link' }, context)

/** The 6-digit code in the most recent email whose subject leads with one. */
function sentCode(): string {
  const message = deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))
  const code = message ? /^(\d{6}) /.exec(message.subject)?.[1] : undefined
  if (!code) {
    throw new Error('no code was emailed')
  }
  return code
}
const wrong = (code: string) => (code === '000000' ? '000001' : '000000')

/** The link in the most recent email, split into the parts a landing page reads. */
function sentLink(): { url: string; token: string; attemptId: string } {
  const url = /https?:\/\/\S+#\S+/.exec(deps.mailer.last().text)?.[0]
  if (!url) {
    throw new Error('no link was emailed')
  }
  const fragment = new URLSearchParams(new URL(url).hash.slice(1))
  return {
    url,
    token: fragment.get('tula_link') ?? '',
    attemptId: fragment.get('tula_attempt') ?? '',
  }
}

async function askForLink(identifier = EMAIL) {
  const attempt = await start(identifier)
  const prepared = await prepare(attempt, { strategy: 'email_link', redirectUrl: REDIRECT })
  const binding = prepared.attempt.linkBinding
  if (!binding) {
    throw new Error('no link binding was returned')
  }
  return { attempt, prepared, binding }
}

const open = (
  input: { token: string; attemptId: string; binding?: string },
  context: Pick<Flows.ClientContext, 'originAllowed'> = web,
  target = tenant
) => Flows.verifyEmailLink(deps, target, input, context)

const sessionsOf = (userId: string) =>
  deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())

const stored = async (attempt: Presented) => {
  const record = await deps.flowAttempts.findById(tenant.environmentId, attempt.id)
  if (!record) {
    throw new Error('attempt not stored')
  }
  return record
}

describe('what a sign-in start offers', () => {
  test('lists the enabled methods in registry order, whoever asks', async () => {
    await seedUser()
    const known = await start(EMAIL)
    const unknown = await start(STRANGER)
    const step: FlowAttempt['step'] = {
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'email_link'],
    }
    expect(known.step).toEqual(step)
    expect(unknown.step).toEqual(step)
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('the email code alone is still a choice of one, and sends nothing by itself', async () => {
    configure({ password: false, emailLink: false })
    expect((await start()).step).toEqual({
      status: 'needs_first_factor',
      strategies: ['email_code'],
    })
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('a password-only environment still answers needs_password', async () => {
    configure({ emailCode: false, emailLink: false })
    expect((await start()).step).toEqual({ status: 'needs_password' })
  })
})

describe('asking for an email code', () => {
  test('emails a sign-in code and reports where it went, masked', async () => {
    const userId = await seedUser()
    const attempt = await start()
    const result = await prepare(attempt)
    expect(result.attempt.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'email_link'],
      prepared: { strategy: 'email_code', destination: 'm***@northline.app' },
    })
    expect(result.attempt.attemptSecret).toBeUndefined()
    expect(result.attempt.linkBinding).toBeUndefined()
    expect(result.tokens).toBeUndefined()
    expect(deps.mailer.outbox).toHaveLength(1)
    const mail = deps.mailer.last()
    expect(mail.to).toBe(NORMALIZED)
    expect(mail.subject).toMatch(/^\d{6} is your Tula sign-in code$/)
    expect(mail.text).not.toContain('http')
    const token = await deps.verificationTokens.findLatest(tenant.environmentId, 'sign_in', {
      flowAttemptId: attempt.id,
    })
    expect(token).toMatchObject({ purpose: 'sign_in', userId, linkTokenHash: null })
    expect(await sessionsOf(userId)).toHaveLength(0)
  })

  test('an address with no account gets the same answer and one email: a notice with no code', async () => {
    await seedUser()
    const known = await prepare(await start(EMAIL))
    const emailsForKnown = deps.mailer.outbox.length
    const unknown = await prepare(await start(STRANGER))
    expect(deps.mailer.outbox.length - emailsForKnown).toBe(emailsForKnown)
    expect(Object.keys(unknown.attempt).sort()).toEqual(Object.keys(known.attempt).sort())
    expect(unknown.attempt.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'email_link'],
      prepared: { strategy: 'email_code', destination: 'n***@northline.app' },
    })
    expect(known.attempt.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'email_link'],
      prepared: { strategy: 'email_code', destination: 'm***@northline.app' },
    })
    const notice = deps.mailer.last()
    expect(notice.to).toBe(STRANGER)
    expect(notice.subject).toBe('Tula sign-in requested')
    expect(notice.text).not.toMatch(/\d{6}/)
    expect(notice.text).not.toContain('http')
    expect(notice.html).not.toContain('<a ')
  })

  test('the send limits are the same for an address with and without an account', async () => {
    await seedUser()
    for (const identifier of [EMAIL, STRANGER]) {
      const attempt = await start(identifier)
      await prepare(attempt)
      const error = await rejection(prepare(attempt))
      expect(error).toBeInstanceOf(RateLimitError)
      expect(error.params).toEqual({ retryAfter: 60 })
    }
    expect(deps.mailer.outbox).toHaveLength(2)
  })

  test('asking again sends a fresh code and retires the previous one', async () => {
    await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const first = sentCode()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await prepare(attempt)
    const second = sentCode()
    if (first !== second) {
      expect((await rejection(submitCode(attempt, first))).code).toBe('verification.invalid_code')
    }
    expect((await submitCode(attempt, second)).attempt.step.status).toBe('complete')
  })

  test('a banned user is sent a code like anyone else', async () => {
    await seedUser({ banned: true })
    await prepare(await start())
    expect(deps.mailer.last().subject).toMatch(/^\d{6} /)
  })

  test('an identifier that is not an email address is refused before anything is sent', async () => {
    const attempt = await start('not an address')
    expect((await rejection(prepare(attempt))).code).toBe('email.invalid')
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('counts against the environment ceiling only when an email is really sent', async () => {
    await seedUser()
    const attempt = await start()
    await prepare(attempt)
    await rejection(prepare(attempt))
    const key = Flows.environmentKey('emailSignIn', tenant)
    const ceiling = Flows.ENVIRONMENT_RATE_LIMITS.emailSignIn
    // Two were asked for, one was sent: exactly one unit of the ceiling is used.
    for (let used = 1; used < ceiling; used++) {
      expect((await deps.rateLimiter.hit(key, ceiling, 60_000)).allowed).toBe(true)
    }
    expect((await deps.rateLimiter.hit(key, ceiling, 60_000)).allowed).toBe(false)
  })

  test('a relay failure is an internal error and leaves the attempt as it was', async () => {
    await seedUser()
    const attempt = await start()
    deps.mailer.failing = true
    expect((await rejection(prepare(attempt))).code).toBe('internal')
    expect((await stored(attempt)).state).toEqual({
      client: 'web',
      strategies: ['password', 'email_code', 'email_link'],
    })
  })
})

describe('signing in with an emailed code', () => {
  test('the right code completes the sign-in with tokens and a session', async () => {
    const userId = await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const result = await submitCode(attempt, sentCode())
    expect(result.attempt.step).toMatchObject({ status: 'complete', userId })
    expect(result.tokens?.accessToken).toBeString()
    expect(result.tokens?.refreshToken).toBeString()
    expect(await sessionsOf(userId)).toHaveLength(1)
    expect((await stored(attempt)).state).toEqual({ client: 'web' })
  })

  test('a user without a password can sign in with a code', async () => {
    const userId = await seedUser({ password: false })
    const attempt = await start()
    await prepare(attempt)
    expect((await submitCode(attempt, sentCode())).attempt.step).toMatchObject({
      status: 'complete',
      userId,
    })
  })

  test('the code proves the inbox: an unverified address is marked verified, with its audit entry', async () => {
    const userId = await seedUser({ verified: false })
    const attempt = await start()
    await prepare(attempt)
    const result = await submitCode(attempt, sentCode())
    // No detour through needs_email_verification: the code was the verification.
    expect(result.attempt.step.status).toBe('complete')
    expect(
      (await deps.users.findById(tenant.environmentId, userId))?.emailVerifiedAt
    ).not.toBeNull()
    expect(deps.activityLog.ofType('user.email_verified')).toMatchObject([
      { actor: { type: 'user', id: userId }, target: { type: 'user', id: userId } },
    ])
  })

  test('an address already verified writes no second verification entry', async () => {
    await seedUser()
    const attempt = await start()
    await prepare(attempt)
    await submitCode(attempt, sentCode())
    expect(deps.activityLog.ofType('user.email_verified')).toHaveLength(0)
  })

  test('a failure to mark the address verified does not strand the sign-in', async () => {
    const userId = await seedUser({ verified: false })
    const attempt = await start()
    await prepare(attempt)
    spies.push(spyOn(deps.users, 'markEmailVerified').mockRejectedValue(new Error('db down')))
    expect((await submitCode(attempt, sentCode())).attempt.step).toMatchObject({
      status: 'complete',
      userId,
    })
  })

  test('a sign-in by code is announced like any other sign-in', async () => {
    const userId = await seedUser()
    const announced = spyOn(Notices, 'newSignIn')
    spies.push(announced)
    const attempt = await start()
    await prepare(attempt)
    const result = await submitCode(attempt, sentCode())
    expect(announced).toHaveBeenCalledTimes(1)
    expect(announced.mock.calls[0]?.[2]).toMatchObject({ userId })
    expect(announced.mock.calls[0]?.[2].sessionId).toBe(result.tokens?.sessionId ?? '')
  })

  test('a wrong code says so, with the guesses left, and signs nobody in', async () => {
    const userId = await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const error = await rejection(submitCode(attempt, wrong(sentCode())))
    expect(error.toJSON()).toMatchObject({
      status: 422,
      code: 'verification.invalid_code',
      params: { attemptsRemaining: 4 },
    })
    expect(await sessionsOf(userId)).toHaveLength(0)
    // The code still works afterwards.
    expect((await submitCode(attempt, sentCode())).attempt.step.status).toBe('complete')
  })

  test('five wrong guesses use the code up; the right one is then refused too', async () => {
    await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const code = sentCode()
    for (let guess = 0; guess < Verification.MAX_ATTEMPTS; guess++) {
      expect((await rejection(submitCode(attempt, wrong(code)))).code).toBe(
        'verification.invalid_code'
      )
    }
    // The code is spent: even the right one is refused now.
    expect((await rejection(submitCode(attempt, code))).code).toBe('verification.too_many_attempts')
    // And that sixth failure has locked the identifier for a while.
    expect(await rejection(submitCode(attempt, code))).toBeInstanceOf(RateLimitError)
  })

  test('codes and passwords share one lockout budget per identifier', async () => {
    await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const code = sentCode()
    for (let guess = 0; guess < 3; guess++) {
      await rejection(Flows.submitPassword(deps, tenant, ref(attempt), 'wrong password', web))
    }
    for (let guess = 0; guess < CREDENTIAL_LOCKOUT.freeAttempts + 1 - 3; guess++) {
      await rejection(submitCode(attempt, wrong(code)))
    }
    expect(await rejection(submitCode(attempt, code))).toBeInstanceOf(RateLimitError)
    expect(
      await rejection(Flows.submitPassword(deps, tenant, ref(attempt), PASSWORD, web))
    ).toBeInstanceOf(RateLimitError)
  })

  test('a successful code clears the lockout count', async () => {
    await seedUser()
    const attempt = await start()
    await prepare(attempt)
    await rejection(submitCode(attempt, wrong(sentCode())))
    await submitCode(attempt, sentCode())
    const key = signInLockKey(tenant.environmentId, NORMALIZED)
    // A fresh budget: every free attempt is available again.
    for (let guess = 0; guess < CREDENTIAL_LOCKOUT.freeAttempts + 1; guess++) {
      expect((await deps.lockout.attempt(key, CREDENTIAL_LOCKOUT, deps.clock.now())).allowed).toBe(
        true
      )
    }
  })

  test('before any code was asked for, a code answers like an expired one', async () => {
    await seedUser()
    const attempt = await start()
    expect((await rejection(submitCode(attempt, '123456'))).code).toBe('verification.expired')
  })

  test('a code whose ten minutes are over is expired even while the attempt lives', async () => {
    await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const code = sentCode()
    const token = await deps.verificationTokens.findLatest(tenant.environmentId, 'sign_in', {
      flowAttemptId: attempt.id,
    })
    spies.push(
      spyOn(deps.verificationTokens, 'findLatest').mockResolvedValue(
        token ? { ...token, expiresAt: deps.clock.now() } : null
      )
    )
    expect((await rejection(submitCode(attempt, code))).code).toBe('verification.expired')
  })

  test('the right code of an attempt for an address with no account answers like a wrong one', async () => {
    const attempt = await start(STRANGER)
    await prepare(attempt)
    const decoy = await deps.verificationTokens.findLatest(tenant.environmentId, 'sign_in', {
      flowAttemptId: attempt.id,
    })
    expect(decoy?.userId).toBeNull()
    // Nobody knows the decoy's code; pretend someone guessed it.
    spies.push(spyOn(Verification, 'verifyCode').mockResolvedValue(decoy as never))
    const error = await rejection(submitCode(attempt, '123456'))
    expect(error.toJSON()).toMatchObject({
      code: 'verification.invalid_code',
      params: { attemptsRemaining: 0 },
    })
    expect(deps.activityLog.ofType('session.created')).toHaveLength(0)
  })

  test('a wrong guess looks the same for an address with and without an account', async () => {
    await seedUser()
    const errors = []
    for (const identifier of [EMAIL, STRANGER]) {
      const attempt = await start(identifier)
      await prepare(attempt)
      errors.push((await rejection(submitCode(attempt, '000000'))).toJSON())
    }
    // One of them could be the real code only with probability 10^-6; skip that run.
    if (sentCode() !== '000000') {
      expect(errors[1]).toEqual(errors[0])
    }
  })

  test('an account that moved to another address since the code was sent is not entered', async () => {
    const userId = await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const user = await deps.users.findById(tenant.environmentId, userId)
    spies.push(
      spyOn(deps.users, 'findById').mockResolvedValue(
        user ? { ...user, emailNormalized: 'moved@northline.app' } : null
      )
    )
    expect((await rejection(submitCode(attempt, sentCode()))).code).toBe(
      'verification.invalid_code'
    )
  })

  test('a ban is revealed only after the right code, and creates no session', async () => {
    const userId = await seedUser({ banned: true })
    const attempt = await start()
    await prepare(attempt)
    expect((await rejection(submitCode(attempt, wrong(sentCode())))).code).toBe(
      'verification.invalid_code'
    )
    expect((await rejection(submitCode(attempt, sentCode()))).code).toBe('auth.user_banned')
    expect(await sessionsOf(userId)).toHaveLength(0)
  })

  test('a user with a second factor gets needs_second_factor and no tokens', async () => {
    const userId = await seedUser()
    spies.push(spyOn(Factors, 'requiredFor').mockResolvedValue(['totp']))
    const attempt = await start()
    await prepare(attempt)
    const result = await submitCode(attempt, sentCode())
    expect(result.attempt.step).toEqual({ status: 'needs_second_factor', options: ['totp'] })
    expect(result.tokens).toBeUndefined()
    expect(await sessionsOf(userId)).toHaveLength(0)
    const record = await stored(attempt)
    expect(record.userId).toBe(userId)
    expect(record.state).toEqual({
      client: 'web',
      strategies: ['password', 'email_code', 'email_link'],
      secondFactors: ['totp'],
    })
  })

  test('a failure to read the second factors leaves the code usable', async () => {
    await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const failing = spyOn(Factors, 'requiredFor').mockRejectedValue(new Error('db down'))
    await expect(submitCode(attempt, sentCode())).rejects.toThrow('db down')
    failing.mockRestore()
    expect((await submitCode(attempt, sentCode())).attempt.step.status).toBe('complete')
  })

  test('of two requests with the same right code, exactly one signs in', async () => {
    const userId = await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const code = sentCode()
    const results = await Promise.allSettled([submitCode(attempt, code), submitCode(attempt, code)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await sessionsOf(userId)).toHaveLength(1)
  })

  test('a completed attempt accepts nothing more', async () => {
    await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const code = sentCode()
    await submitCode(attempt, code)
    expect((await rejection(submitCode(attempt, code))).code).toBe('flow.not_found')
    expect((await rejection(prepare(attempt))).code).toBe('flow.not_found')
  })
})

describe('a code is good for one purpose only', () => {
  test('a password-reset or verification code issued for the same attempt is not a sign-in code', async () => {
    const userId = await seedUser()
    const attempt = await start()
    for (const purpose of ['password_reset', 'email_verification'] as const) {
      await Verification.issue(deps, tenant, {
        purpose,
        destination: EMAIL,
        flowAttemptId: attempt.id,
        userId,
      })
      expect((await rejection(submitCode(attempt, sentCode()))).code).toBe('verification.expired')
      deps.clock.advance(Verification.RESEND_COOLDOWN)
    }
    expect(await sessionsOf(userId)).toHaveLength(0)
  })

  test('a sign-in code does not verify an email address or reset a password', async () => {
    const userId = await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const code = sentCode()
    for (const purpose of ['password_reset', 'email_verification'] as const) {
      const error = await rejection(
        Verification.verifyCode(deps, tenant, {
          purpose,
          subject: { flowAttemptId: attempt.id },
          code,
        })
      )
      expect(error.code).toBe('verification.expired')
    }
    // And the routes for those purposes refuse the attempt outright.
    expect(
      (await rejection(Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), code, web))).code
    ).toBe('flow.invalid_step')
    expect(
      (
        await rejection(
          Flows.resetPassword(deps, tenant, ref(attempt), { code, password: PASSWORD }, web)
        )
      ).code
    ).toBe('flow.not_found')
    expect(await sessionsOf(userId)).toHaveLength(0)
  })

  test('a sign-in link token is not honoured for another purpose', async () => {
    await seedUser()
    await askForLink()
    const { token } = sentLink()
    for (const purpose of ['password_reset', 'email_verification'] as const) {
      const error = await rejection(
        Verification.verifyLink(deps, tenant, { purpose, linkToken: token })
      )
      expect(error.code).toBe('verification.expired')
    }
  })
})

describe('every email step needs the attempt and its origin', () => {
  type Step = (
    attempt: Presented,
    context?: Flows.ClientContext,
    target?: Tenant
  ) => Promise<unknown>
  const steps: [string, Step][] = [
    ['prepare', (attempt, context, target) => prepare(attempt, undefined, context, target)],
    ['a code', (attempt, context, target) => submitCode(attempt, '123456', context, target)],
    ['a link poll', (attempt, context, target) => poll(attempt, context, target)],
  ]

  test.each(steps)(
    '%s without the secret is flow.not_found and changes nothing',
    async (_, step) => {
      await seedUser()
      const attempt = await start()
      const other = await start()
      await prepare(attempt)
      const emails = deps.mailer.outbox.length
      const before = structuredClone(await stored(attempt))
      for (const presented of [
        { id: attempt.id, attemptSecret: undefined },
        { id: attempt.id, attemptSecret: 'tula_at_wrong' },
        { id: attempt.id, attemptSecret: other.attemptSecret },
        { id: deps.ids.next(), attemptSecret: attempt.attemptSecret },
      ]) {
        expect((await rejection(step(presented, web))).code).toBe('flow.not_found')
      }
      expect(deps.mailer.outbox).toHaveLength(emails)
      expect(await stored(attempt)).toEqual(before)
      const token = await deps.verificationTokens.findLatest(tenant.environmentId, 'sign_in', {
        flowAttemptId: attempt.id,
      })
      expect(token?.attempts).toBe(0)
      expect(deps.lockout.size).toBe(0)
    }
  )

  test.each(steps)(
    '%s from an origin that is not allowed is refused before anything changes',
    async (_, step) => {
      await seedUser()
      const attempt = await start()
      await prepare(attempt)
      const emails = deps.mailer.outbox.length
      expect((await rejection(step(attempt, foreign))).code).toBe('request.origin_not_allowed')
      expect(deps.mailer.outbox).toHaveLength(emails)
      expect(deps.lockout.size).toBe(0)
      expect(deps.activityLog.ofType('session.created')).toHaveLength(0)
    }
  )

  test.each(steps)('%s in another environment does not find the attempt', async (_, step) => {
    configure({}, otherTenant)
    await seedUser()
    const attempt = await start()
    await prepare(attempt)
    expect((await rejection(step(attempt, web, otherTenant))).code).toBe('flow.not_found')
  })

  test.each(steps)('%s for an attempt that has expired is flow.not_found', async (_, step) => {
    await seedUser()
    const attempt = await start()
    deps.clock.advance(Flows.ATTEMPT_TTL)
    expect((await rejection(step(attempt, web))).code).toBe('flow.not_found')
  })

  test('a strategy the attempt was not offered is refused, whatever the settings say now', async () => {
    await seedUser()
    configure({ emailCode: false, emailLink: false })
    const passwordOnly = await start()
    configure()
    for (const call of [
      prepare(passwordOnly),
      submitCode(passwordOnly, '123456'),
      poll(passwordOnly),
      prepare(passwordOnly, { strategy: 'email_link', redirectUrl: REDIRECT }),
    ]) {
      expect((await rejection(call)).code).toBe('flow.invalid_step')
    }
    expect(deps.mailer.outbox).toHaveLength(0)
    expect(deps.lockout.size).toBe(0)
  })

  test('a method switched off after the attempt started stops working at once', async () => {
    await seedUser()
    const attempt = await start()
    await prepare(attempt)
    const code = sentCode()
    configure({ emailCode: false, emailLink: false })
    const disabled = (method: string) => ({
      status: 403,
      code: 'auth.method_disabled',
      params: { method },
    })
    expect((await rejection(submitCode(attempt, code))).toJSON()).toMatchObject(
      disabled('emailCode')
    )
    expect((await rejection(prepare(attempt))).toJSON()).toMatchObject(disabled('emailCode'))
    expect((await rejection(poll(attempt))).toJSON()).toMatchObject(disabled('emailLink'))
    expect(deps.lockout.size).toBe(0)
    expect(deps.activityLog.ofType('session.created')).toHaveLength(0)
  })
})

describe('asking for an emailed link', () => {
  test('emails the code and a link whose token is in the fragment, and returns a binding once', async () => {
    const userId = await seedUser()
    const { attempt, prepared, binding } = await askForLink()
    expect(prepared.attempt.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'email_link'],
      prepared: { strategy: 'email_link', destination: 'm***@northline.app' },
    })
    expect(binding).toMatch(/^tula_lb_[A-Za-z0-9_-]{43}$/)
    expect(prepared.tokens).toBeUndefined()

    const mail = deps.mailer.last()
    expect(mail.subject).toMatch(/^\d{6} is your Tula sign-in code$/)
    const link = sentLink()
    const url = new URL(link.url)
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT)
    // Nothing secret in the part of the URL a server, a proxy or `Referer` would see.
    expect(url.search).toBe('')
    expect(link.attemptId).toBe(attempt.id)
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(mail.html).toContain(`href="${link.url.replaceAll('&', '&amp;')}"`)
    expect(mail.text).toContain('in the browser where you asked to sign in')

    // Only hashes are kept: of the link token on its row, of the binding on the attempt.
    const token = await deps.verificationTokens.findLatest(tenant.environmentId, 'sign_in', {
      flowAttemptId: attempt.id,
    })
    expect(token).toMatchObject({ userId, linkTokenHash: sha256Hex(link.token) })
    const record = await stored(attempt)
    expect(record.state.linkBindingHash).toBe(sha256Hex(binding))
    const everything = JSON.stringify([record, token, deps.activityLog.entries])
    expect(everything).not.toContain(binding)
    expect(everything).not.toContain(link.token)
    // The email does not carry the binding or the attempt's secret.
    expect(`${mail.text}${mail.html}`).not.toContain(binding)
    expect(`${mail.text}${mail.html}`).not.toContain(attempt.attemptSecret ?? 'no secret')
  })

  test('an address with no account gets the same answer and a notice with no link and no code', async () => {
    await seedUser()
    const known = await askForLink(EMAIL)
    const unknown = await askForLink(STRANGER)
    expect(Object.keys(unknown.prepared.attempt).sort()).toEqual(
      Object.keys(known.prepared.attempt).sort()
    )
    expect(unknown.binding).toMatch(/^tula_lb_[A-Za-z0-9_-]{43}$/)
    expect(deps.mailer.outbox).toHaveLength(2)
    const notice = deps.mailer.last()
    expect(notice.subject).toBe('Tula sign-in requested')
    expect(`${notice.text}${notice.html}`).not.toContain('tula_link')
    expect(notice.text).not.toMatch(/\d{6}/)
    const decoy = await deps.verificationTokens.findLatest(tenant.environmentId, 'sign_in', {
      flowAttemptId: unknown.attempt.id,
    })
    expect(decoy).toMatchObject({ userId: null, linkTokenHash: null })
  })

  describe('the redirect URL must be on the allow-list, exactly', () => {
    beforeEach(() => {
      build({ config: { ...TEST_CONFIG, tier: 'prod' } })
    })

    test.each<[string, string | undefined]>([
      ['none at all', undefined],
      ['another site', 'https://evil.test/auth/link'],
      ['a longer path under an allowed URL', `${REDIRECT}/extra`],
      ['an allowed URL with a query', `${REDIRECT}?next=https://evil.test`],
      ['an allowed URL with a fragment', `${REDIRECT}#x`],
      ['an allowed URL with a trailing slash', `${REDIRECT}/`],
      ['an allowed URL in another case', REDIRECT.toUpperCase()],
      [
        'a host that only starts like an allowed one',
        'https://app.northline.test.evil.test/auth/link',
      ],
      ['credentials in front of an allowed host', 'https://app.northline.test@evil.test/auth/link'],
      ['a loopback URL outside the local tier', 'http://localhost:5174/auth/link'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['not a URL', 'auth/link'],
    ])('%s is refused and nothing is sent', async (_, redirectUrl) => {
      await seedUser()
      const attempt = await start()
      const error = await rejection(prepare(attempt, { strategy: 'email_link', redirectUrl }))
      expect(error.toJSON()).toMatchObject({ status: 400, code: 'request.redirect_not_allowed' })
      expect(deps.mailer.outbox).toHaveLength(0)
      expect((await stored(attempt)).state.prepared).toBeUndefined()
    })

    test('an exact entry is accepted', async () => {
      await seedUser()
      const { prepared } = await askForLink()
      expect(prepared.attempt.linkBinding).toBeString()
    })

    test('the answer is the same for an address with no account', async () => {
      const attempt = await start(STRANGER)
      const error = await rejection(
        prepare(attempt, { strategy: 'email_link', redirectUrl: 'https://evil.test/' })
      )
      expect(error.code).toBe('request.redirect_not_allowed')
    })
  })

  describe('in the local tier', () => {
    test.each([
      'http://localhost:5174/auth/link',
      'http://127.0.0.1:8080/',
      'http://[::1]:3000/callback?x=1',
    ])('%s is allowed without being listed', async (redirectUrl) => {
      await seedUser()
      configure({ redirects: [] })
      const attempt = await start()
      const result = await prepare(attempt, { strategy: 'email_link', redirectUrl })
      expect(result.attempt.linkBinding).toBeString()
      expect(sentLink().url.startsWith(`${redirectUrl}#tula_link=`)).toBe(true)
    })

    test.each([
      'https://localhost:5174/auth/link',
      'http://localhost.evil.test/auth/link',
      'http://user:pw@localhost:5174/auth/link',
      'http://localhost:5174/auth/link#frag',
      'http://192.168.1.10/auth/link',
      'not a url',
    ])('%s is not', async (redirectUrl) => {
      await seedUser()
      configure({ redirects: [] })
      const attempt = await start()
      const error = await rejection(prepare(attempt, { strategy: 'email_link', redirectUrl }))
      expect(error.code).toBe('request.redirect_not_allowed')
    })
  })

  test('an attempt that moved on while the email was being sent is refused', async () => {
    await seedUser()
    const attempt = await start()
    spies.push(spyOn(deps.flowAttempts, 'transition').mockResolvedValue(false))
    expect((await rejection(prepare(attempt))).code).toBe('flow.invalid_step')
  })

  test('the code path ignores a redirect URL', async () => {
    await seedUser()
    const attempt = await start()
    const result = await prepare(attempt, {
      strategy: 'email_code',
      redirectUrl: 'https://evil.test/',
    })
    expect(result.attempt.linkBinding).toBeUndefined()
    expect(deps.mailer.last().text).not.toContain('http')
  })
})

describe('opening an emailed link', () => {
  test('in the browser that asked: accepted, with no tokens; the starting client then completes', async () => {
    const userId = await seedUser()
    const { attempt, binding } = await askForLink()
    const link = sentLink()

    // Until the link is opened the waiting client is told nothing has changed.
    const waiting = await poll(attempt)
    expect(waiting.attempt.step).toMatchObject({
      status: 'needs_first_factor',
      prepared: { strategy: 'email_link' },
    })
    expect(waiting.tokens).toBeUndefined()

    const opened = await open({ ...link, binding })
    expect(opened).toEqual({ status: 'verified' })
    // Opening a link signs nobody in by itself.
    expect(await sessionsOf(userId)).toHaveLength(0)

    const done = await poll(attempt)
    expect(done.attempt.step).toMatchObject({ status: 'complete', userId })
    expect(done.tokens?.accessToken).toBeString()
    expect(await sessionsOf(userId)).toHaveLength(1)
    expect((await stored(attempt)).state).toEqual({ client: 'web' })
  })

  test('waiting costs no guess and no lockout, however often it asks', async () => {
    await seedUser()
    const { attempt } = await askForLink()
    for (let asked = 0; asked < CREDENTIAL_LOCKOUT.freeAttempts * 3; asked++) {
      expect((await poll(attempt)).attempt.step.status).toBe('needs_first_factor')
    }
    expect(deps.lockout.size).toBe(0)
    const token = await deps.verificationTokens.findLatest(tenant.environmentId, 'sign_in', {
      flowAttemptId: attempt.id,
    })
    expect(token?.attempts).toBe(0)
    // And the code in the same email still works.
    expect((await submitCode(attempt, sentCode())).attempt.step.status).toBe('complete')
  })

  test('waiting looks the same for an address with no account, and never completes', async () => {
    await seedUser()
    const known = await askForLink(EMAIL)
    const unknown = await askForLink(STRANGER)
    const [a, b] = [await poll(known.attempt), await poll(unknown.attempt)]
    expect(Object.keys(b.attempt).sort()).toEqual(Object.keys(a.attempt).sort())
    expect(b.attempt.step).toMatchObject({
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'email_link'],
      prepared: { strategy: 'email_link' },
    })
    expect(b.tokens).toBeUndefined()
  })

  test.each<[string, (binding: string) => string | undefined]>([
    ['no binding (another browser or device)', () => undefined],
    ['an empty binding', () => ''],
    ['a made-up binding', () => 'tula_lb_made-up'],
    ['the binding with one character changed', (binding) => `${binding.slice(0, -1)}_`],
  ])('with %s: different_browser, and nothing is used up', async (_, forge) => {
    const userId = await seedUser()
    const { attempt, binding } = await askForLink()
    const link = sentLink()
    const error = await rejection(open({ ...link, binding: forge(binding) }))
    expect(error.toJSON()).toMatchObject({ status: 409, code: 'verification.different_browser' })
    expect((await poll(attempt)).attempt.step.status).toBe('needs_first_factor')
    expect(await sessionsOf(userId)).toHaveLength(0)
    // The link still works where it was asked for…
    expect(await open({ ...link, binding })).toEqual({ status: 'verified' })
    expect((await poll(attempt)).attempt.step.status).toBe('complete')
  })

  test('refused elsewhere, the code beside it still works on the starting device', async () => {
    await seedUser()
    const { attempt } = await askForLink()
    await rejection(open({ ...sentLink() }))
    expect((await submitCode(attempt, sentCode())).attempt.step.status).toBe('complete')
  })

  test("an attacker's attempt is not completed by the victim opening the link", async () => {
    // The attacker starts a sign-in for the victim's address and keeps the secret and binding.
    const victim = await seedUser()
    const attacker = await askForLink(EMAIL)
    // The victim opens the genuine email's link in their own browser, which has no binding.
    expect((await rejection(open({ ...sentLink() }))).code).toBe('verification.different_browser')
    // The attacker's waiting client gets nothing, however long it waits.
    const waiting = await poll(attacker.attempt)
    expect(waiting.attempt.step.status).toBe('needs_first_factor')
    expect(waiting.tokens).toBeUndefined()
    expect(await sessionsOf(victim)).toHaveLength(0)
  })

  test("another attempt's binding does not open a link", async () => {
    await seedUser()
    const mine = await askForLink()
    const link = sentLink()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await seedUser({ email: 'ines@northline.app' })
    const theirs = await askForLink('ines@northline.app')
    expect((await rejection(open({ ...link, binding: theirs.binding }))).code).toBe(
      'verification.different_browser'
    )
    expect((await poll(mine.attempt)).attempt.step.status).toBe('needs_first_factor')
  })

  test('a link is single use: opening it twice is refused the second time', async () => {
    await seedUser()
    const { binding } = await askForLink()
    const link = sentLink()
    await open({ ...link, binding })
    expect((await rejection(open({ ...link, binding }))).code).toBe('verification.expired')
    // Without the binding a spent link is just as dead, not "another browser".
    expect((await rejection(open({ ...link }))).code).toBe('verification.expired')
  })

  test('of two tabs opening the same link at once, one is accepted', async () => {
    const userId = await seedUser()
    const { attempt, binding } = await askForLink()
    const link = sentLink()
    const results = await Promise.allSettled([
      open({ ...link, binding }),
      open({ ...link, binding }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const [done, again] = await Promise.allSettled([poll(attempt), poll(attempt)])
    expect([done.status, again.status].filter((status) => status === 'fulfilled')).toHaveLength(1)
    expect(await sessionsOf(userId)).toHaveLength(1)
  })

  test('opening the link ends the code that came with it', async () => {
    await seedUser()
    const { attempt, binding } = await askForLink()
    const code = sentCode()
    await open({ ...sentLink(), binding })
    expect((await rejection(submitCode(attempt, code))).code).toBe('verification.expired')
  })

  test('using the code ends the link that came with it', async () => {
    await seedUser()
    const { attempt, binding } = await askForLink()
    const link = sentLink()
    await submitCode(attempt, sentCode())
    expect((await rejection(open({ ...link, binding }))).code).toBe('verification.expired')
  })

  test.each<[string, (link: ReturnType<typeof sentLink>) => { token: string; attemptId: string }]>([
    ['a made-up token', (link) => ({ ...link, token: 'x'.repeat(43) })],
    [
      'a made-up attempt',
      (link) => ({ ...link, attemptId: '00000000-0000-7000-8000-00000000dead' }),
    ],
  ])('%s answers like an expired link, even with a real binding', async (_, forge) => {
    await seedUser()
    const { binding } = await askForLink()
    expect((await rejection(open({ ...forge(sentLink()), binding }))).code).toBe(
      'verification.expired'
    )
  })

  test("a token presented with another attempt's id and binding is refused", async () => {
    await seedUser()
    await askForLink()
    const link = sentLink()
    await seedUser({ email: 'ines@northline.app' })
    const other = await askForLink('ines@northline.app')
    expect(
      (
        await rejection(
          open({ token: link.token, attemptId: other.attempt.id, binding: other.binding })
        )
      ).code
    ).toBe('verification.expired')
    expect((await poll(other.attempt)).attempt.step.status).toBe('needs_first_factor')
  })

  test('a link is dead after ten minutes, and once its attempt is gone', async () => {
    await seedUser()
    const { binding } = await askForLink()
    const link = sentLink()
    deps.clock.advance(Verification.TOKEN_TTL)
    expect((await rejection(open({ ...link, binding }))).code).toBe('verification.expired')
  })

  test('asking for a new email retires the previous link', async () => {
    await seedUser()
    const { attempt, binding } = await askForLink()
    const old = sentLink()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const again = await prepare(attempt, { strategy: 'email_link', redirectUrl: REDIRECT })
    expect((await rejection(open({ ...old, binding }))).code).toBe('verification.expired')
    // The old binding is retired with it: the new link needs the new binding.
    expect((await rejection(open({ ...sentLink(), binding }))).code).toBe(
      'verification.different_browser'
    )
    expect(await open({ ...sentLink(), binding: again.attempt.linkBinding })).toEqual({
      status: 'verified',
    })
  })

  test('asking for a plain code afterwards retires the link and its proof', async () => {
    await seedUser()
    const { attempt, binding } = await askForLink()
    const link = sentLink()
    await open({ ...link, binding })
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await prepare(attempt, { strategy: 'email_code' })
    // The earlier proof is dropped with the email it came from.
    expect((await poll(attempt)).attempt.step.status).toBe('needs_first_factor')
    expect((await submitCode(attempt, sentCode())).attempt.step.status).toBe('complete')
  })

  test('a link from another environment is not found', async () => {
    configure({}, otherTenant)
    await seedUser()
    const { binding } = await askForLink()
    expect((await rejection(open({ ...sentLink(), binding }, web, otherTenant))).code).toBe(
      'verification.expired'
    )
  })

  test('a browser attempt is refused from an origin that is not allowed, with the link intact', async () => {
    await seedUser()
    const { attempt, binding } = await askForLink()
    const link = sentLink()
    expect((await rejection(open({ ...link, binding }, foreign))).code).toBe(
      'request.origin_not_allowed'
    )
    expect(await open({ ...link, binding })).toEqual({ status: 'verified' })
    expect((await poll(attempt)).attempt.step.status).toBe('complete')
  })

  test('a link stops working when the method is switched off', async () => {
    await seedUser()
    const { binding } = await askForLink()
    const link = sentLink()
    configure({ emailLink: false })
    expect((await rejection(open({ ...link, binding }))).code).toBe('auth.method_disabled')
  })

  test('a link for an attempt that was not offered links is dead', async () => {
    await seedUser()
    const { attempt, binding } = await askForLink()
    const record = await stored(attempt)
    spies.push(
      spyOn(deps.flowAttempts, 'findById').mockResolvedValue({
        ...record,
        state: { ...record.state, strategies: ['password', 'email_code'] },
      })
    )
    expect((await rejection(open({ ...sentLink(), binding }))).code).toBe('verification.expired')
  })

  test('an attempt that completed while the link was being opened leaves the link dead', async () => {
    await seedUser()
    const { binding } = await askForLink()
    spies.push(spyOn(deps.flowAttempts, 'transition').mockResolvedValue(false))
    expect((await rejection(open({ ...sentLink(), binding }))).code).toBe('verification.expired')
  })

  test('a ban is revealed to the starting client only, after the link', async () => {
    const userId = await seedUser({ banned: true })
    const { attempt, binding } = await askForLink()
    expect(await open({ ...sentLink(), binding })).toEqual({ status: 'verified' })
    expect((await rejection(poll(attempt))).code).toBe('auth.user_banned')
    expect(await sessionsOf(userId)).toHaveLength(0)
  })

  test('a user with a second factor is not signed in by a link', async () => {
    const userId = await seedUser()
    spies.push(spyOn(Factors, 'requiredFor').mockResolvedValue(['totp']))
    const { attempt, binding } = await askForLink()
    await open({ ...sentLink(), binding })
    const result = await poll(attempt)
    expect(result.attempt.step).toEqual({ status: 'needs_second_factor', options: ['totp'] })
    expect(result.tokens).toBeUndefined()
    expect(await sessionsOf(userId)).toHaveLength(0)
  })

  test('an unverified address is marked verified by a link as well', async () => {
    const userId = await seedUser({ verified: false })
    const { attempt, binding } = await askForLink()
    await open({ ...sentLink(), binding })
    expect((await poll(attempt)).attempt.step.status).toBe('complete')
    expect(
      (await deps.users.findById(tenant.environmentId, userId))?.emailVerifiedAt
    ).not.toBeNull()
  })

  test('an account deleted after the link was opened is not entered', async () => {
    await seedUser()
    const { attempt, binding } = await askForLink()
    await open({ ...sentLink(), binding })
    spies.push(spyOn(deps.users, 'findById').mockResolvedValue(null))
    expect((await rejection(poll(attempt))).code).toBe('flow.invalid_step')
  })
})

describe('a user without a password where only the password is offered', () => {
  test('gets the same generic failure as a wrong password', async () => {
    await seedUser({ password: false })
    configure({ emailCode: false, emailLink: false })
    const attempt = await start()
    expect(attempt.step).toEqual({ status: 'needs_password' })
    const error = await rejection(Flows.submitPassword(deps, tenant, ref(attempt), PASSWORD, web))
    expect(error.toJSON()).toMatchObject({ status: 401, code: 'auth.invalid_credentials' })
  })
})

describe('sign-up without a password', () => {
  const signUp = (input: Partial<Parameters<typeof Flows.signUp>[2]> = {}, context = web) =>
    Flows.signUp(deps, tenant, { email: EMAIL, ...input }, context)
  const verify = (attempt: Presented, code: string) =>
    Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), code, web)

  test('is a validation error on the password where the environment requires one', async () => {
    const error = await rejection(signUp())
    expect(error.toJSON()).toMatchObject({
      status: 422,
      code: 'validation.failed',
      errors: [{ field: 'password', code: 'validation.failed' }],
    })
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  describe('where the environment makes it optional', () => {
    beforeEach(() => configure({ signUpPassword: 'optional' }))

    test('creates an account with no password once the address is verified', async () => {
      const started = await signUp({ firstName: 'Maya' })
      expect(started.attempt.step).toEqual({
        status: 'needs_email_verification',
        destination: 'M***@Northline.app',
        strategies: ['email_code'],
      })
      expect((await stored(started.attempt)).state).toEqual({
        client: 'web',
        email: EMAIL,
        passwordless: true,
        firstName: 'Maya',
        lastName: null,
      })
      expect(await deps.users.findByEmail(tenant.environmentId, NORMALIZED)).toBeNull()

      const done = await verify(started.attempt, sentCode())
      expect(done.attempt.step.status).toBe('complete')
      expect(done.tokens?.accessToken).toBeString()
      const found = await deps.users.findByEmailWithPassword(tenant.environmentId, NORMALIZED)
      expect(found?.passwordHash).toBeNull()
      expect(found?.user).toMatchObject({ firstName: 'Maya' })
      expect(found?.user.emailVerifiedAt).not.toBeNull()
      expect(deps.activityLog.ofType('user.created')).toMatchObject([
        { data: { method: 'sign_up', emailVerified: true, passwordless: true } },
      ])
    })

    test('the new account signs in with an emailed code, and a password never works for it', async () => {
      const started = await signUp()
      await verify(started.attempt, sentCode())
      deps.clock.advance(Verification.RESEND_COOLDOWN)
      const attempt = await start()
      expect(
        (await rejection(Flows.submitPassword(deps, tenant, ref(attempt), PASSWORD, web))).code
      ).toBe('auth.invalid_credentials')
      await prepare(attempt)
      expect((await submitCode(attempt, sentCode())).attempt.step.status).toBe('complete')
    })

    test('an address that already has an account gets the same answer and a notice', async () => {
      await seedUser()
      const fresh = await signUp({ email: STRANGER })
      const taken = await signUp()
      expect(Object.keys(taken.attempt).sort()).toEqual(Object.keys(fresh.attempt).sort())
      expect(taken.attempt.step.status).toBe('needs_email_verification')
      expect(deps.mailer.last().subject).toBe('Your Tula account already exists')
      expect((await stored(taken.attempt)).state).toEqual({
        client: 'web',
        email: EMAIL,
        passwordless: true,
        decoy: true,
      })
      // Even a guessed decoy code creates nothing.
      const decoy = await deps.verificationTokens.findLatest(
        tenant.environmentId,
        'email_verification',
        { flowAttemptId: taken.attempt.id }
      )
      spies.push(spyOn(Verification, 'verifyCode').mockResolvedValue(decoy as never))
      expect((await rejection(verify(taken.attempt, '123456'))).code).toBe(
        'verification.invalid_code'
      )
    })

    test('a sign-up that does choose a password works as before', async () => {
      const started = await signUp({ password: PASSWORD })
      expect((await stored(started.attempt)).state.passwordless).toBeUndefined()
      await verify(started.attempt, sentCode())
      const found = await deps.users.findByEmailWithPassword(tenant.environmentId, NORMALIZED)
      expect(found?.passwordHash).toBeString()
      expect(deps.activityLog.ofType('user.created')[0]?.data).toEqual({
        method: 'sign_up',
        emailVerified: true,
      })
    })

    test('a weak password is still refused when one is given', async () => {
      expect((await rejection(signUp({ password: 'short' }))).code).toStartWith('password.')
    })

    test('with passwords switched off, only a sign-up without one is possible', async () => {
      configure({ signUpPassword: 'optional', password: false })
      expect((await rejection(signUp({ password: PASSWORD }))).toJSON()).toMatchObject({
        code: 'auth.method_disabled',
        params: { method: 'password' },
      })
      const started = await signUp()
      expect((await verify(started.attempt, sentCode())).attempt.step.status).toBe('complete')
    })

    test('stops, at every step, when the email code is switched off meanwhile', async () => {
      const started = await signUp()
      const code = sentCode()
      // Not reachable through the settings API (optional needs the code); a rollback could.
      configure({ signUpPassword: 'optional', emailCode: false, emailLink: false })
      const disabled = { code: 'auth.method_disabled', params: { method: 'emailCode' } }
      expect((await rejection(signUp({ email: STRANGER }))).toJSON()).toMatchObject(disabled)
      expect((await rejection(verify(started.attempt, code))).toJSON()).toMatchObject(disabled)
      expect(
        (
          await rejection(Flows.resendCode(deps, tenant, 'sign_up', ref(started.attempt), web))
        ).toJSON()
      ).toMatchObject(disabled)
      expect(await deps.users.findByEmail(tenant.environmentId, NORMALIZED)).toBeNull()
    })

    test('a browser sign-up from an origin that is not allowed is refused', async () => {
      expect((await rejection(signUp({}, foreign))).code).toBe('request.origin_not_allowed')
    })
  })
})
