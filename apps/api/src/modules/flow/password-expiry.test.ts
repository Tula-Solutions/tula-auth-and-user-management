import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  type FlowAttempt,
  type FlowStep,
} from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { AuthError, RateLimitError, ServiceException } from '~/exceptions'
import * as logger from '~/lib/logger'
import { base32Decode, totp } from '~/lib/totp'
import { verifyAccessToken } from '~/middleware/session-auth'
import * as Audit from '~/modules/audit/service'
import * as Flows from '~/modules/flow/service'
import * as Hooks from '~/modules/hook/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Users from '~/modules/user/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// Password expiry (ADR 0041): a sign-in with a password that is right and older than
// `password.expiryDays` allows sets a new one before it gets a session.

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a brand new passphrase 42'
const THIRD_PASSWORD = 'yet another passphrase 77'
// One argon2 hash for the whole file: hashing per test would dominate its run time.
const PASSWORD_HASH = await Passwords.hash(PASSWORD)
const DAY = 86_400_000
const web: Flows.ClientContext = {
  client: 'web',
  userAgent: 'Mozilla/5.0',
  ipAddress: '203.0.113.7',
  originAllowed: true,
}
const EXPIRED_STEP: FlowStep = {
  status: 'needs_new_password',
  destination: 'm***@northline.app',
  strategies: [],
  reason: 'expired',
}

type Presented = Pick<FlowAttempt, 'id' | 'attemptSecret'>
const ref = (attempt: Presented): Flows.AttemptRef => ({
  id: attempt.id,
  secret: attempt.attemptSecret,
})

let deps: TestDeps
const spies: ReturnType<typeof spyOn>[] = []

interface Switches {
  expiryDays?: number | null
  history?: number
  mfa?: EnvironmentSettings['mfa']['policy']
  password?: boolean
  emailCode?: boolean
}

let revision = 0
function configure(switches: Switches = {}) {
  revision += 1
  deps.environmentSettings.seed(tenant.environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      password: {
        ...DEFAULT_ENVIRONMENT_SETTINGS.password,
        preset: 'custom',
        // No lookup of the breached-password source: the tests are about age.
        breachCheck: 'off',
        history: switches.history ?? 0,
        expiryDays: switches.expiryDays === undefined ? 90 : switches.expiryDays,
      },
      signIn: {
        methods: {
          ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods,
          password: { enabled: switches.password ?? true },
          emailCode: { enabled: switches.emailCode ?? false },
        },
      },
      mfa: { policy: switches.mfa ?? 'optional', smsCode: { enabled: false } },
    },
  })
}

beforeEach(() => {
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  configure()
})

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
  options: { verified?: boolean; email?: string; passwordHash?: string | null } = {}
) {
  const id = deps.ids.next()
  const email = options.email ?? EMAIL
  await deps.users.create(
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email,
      emailNormalized: email,
      emailVerifiedAt: options.verified === false ? null : deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: options.passwordHash === undefined ? PASSWORD_HASH : options.passwordHash,
    },
    Audit.none('fixture')
  )
  return id
}

/** A user whose password was set `days` days ago (and, with `less`, that much less). */
async function seedAged(days: number, less = 0, options: Parameters<typeof seedUser>[0] = {}) {
  const userId = await seedUser(options)
  deps.clock.advance(days * DAY - less)
  return userId
}

const codeFor = (secret: string) => totp(base32Decode(secret), deps.clock.now())

/** Turn two-step verification on for a user, outside any attempt. */
async function enrol(userId: string) {
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
  return { secret, codes }
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

const startSignIn = async (identifier = EMAIL, context = web) =>
  (await Flows.signIn(deps, tenant, { identifier }, context)).attempt
const password = (attempt: Presented, value = PASSWORD, context = web) =>
  Flows.submitPassword(deps, tenant, ref(attempt), value, context)
const renew = (attempt: Presented, value = NEW_PASSWORD, context = web) =>
  Flows.replaceExpiredPassword(deps, tenant, ref(attempt), value, context)
/** Start a sign-in and submit the password: the attempt, and what the password answered. */
async function signIn(value = PASSWORD, identifier = EMAIL) {
  const attempt = await startSignIn(identifier)
  return { attempt, result: await password(attempt, value) }
}

const liveSessions = (userId: string) =>
  deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
const stored = (attempt: Presented) => deps.flowAttempts.findById(tenant.environmentId, attempt.id)
const storedHash = async (email = EMAIL) =>
  (await deps.users.findByEmailWithPassword(tenant.environmentId, email))?.passwordHash ?? null
const amrOf = async (result: Flows.FlowResult) =>
  (await verifyAccessToken(deps, result.tokens?.accessToken as string, tenant)).amr
const passwordChanges = () => deps.activityLog.ofType('user.password_changed')

/** Nothing that only a completed attempt may have exists. */
async function expectNoSession(result: Flows.FlowResult, userId: string) {
  expect(result.tokens).toBeUndefined()
  expect(result.attempt).not.toHaveProperty('session')
  expect(result.attempt).not.toHaveProperty('attemptSecret')
  expect(await liveSessions(userId)).toEqual([])
  expect(deps.activityLog.ofType('session.created')).toEqual([])
}

describe('Passwords.expired', () => {
  const setAt = new Date('2026-01-01T12:00:00.000Z')
  const after = (ms: number) => new Date(setAt.getTime() + ms)

  test('a password expires at the instant its last day ends, not before', () => {
    expect(Passwords.expired({ expiryDays: 90 }, setAt, after(90 * DAY - 1))).toBe(false)
    expect(Passwords.expired({ expiryDays: 90 }, setAt, after(90 * DAY))).toBe(true)
    expect(Passwords.expired({ expiryDays: 1 }, setAt, after(DAY - 1))).toBe(false)
    expect(Passwords.expired({ expiryDays: 1 }, setAt, after(DAY))).toBe(true)
  })

  test('no number means no expiry, however old the password', () => {
    expect(Passwords.expired({ expiryDays: null }, setAt, after(10_000 * DAY))).toBe(false)
  })

  test('a user with no password has nothing that expires', () => {
    expect(Passwords.expired({ expiryDays: 1 }, null, after(10_000 * DAY))).toBe(false)
  })

  test.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'a number the schema would never store (%p) expires nothing',
    (days) => {
      expect(Passwords.expired({ expiryDays: days }, setAt, after(10_000 * DAY))).toBe(false)
    }
  )

  test('a password set in the future has not expired', () => {
    expect(Passwords.expired({ expiryDays: 1 }, after(5 * DAY), setAt)).toBe(false)
  })
})

describe('a right password that has expired', () => {
  test('stops at needs_new_password, says why, and creates no session', async () => {
    const userId = await seedAged(90)
    const { attempt, result } = await signIn()
    expect(result.attempt.step).toEqual(EXPIRED_STEP)
    expect(result.attempt.kind).toBe('sign_in')
    await expectNoSession(result, userId)
    expect(await stored(attempt)).toMatchObject({
      status: 'needs_new_password',
      userId,
      completedAt: null,
      state: { amr: ['pwd'], firstFactor: 'password' },
    })
    // Nothing was emailed: there is no code on this step.
    expect(deps.mailer.outbox).toEqual([])
  })

  test('one millisecond before the last day ends it still signs in', async () => {
    const userId = await seedAged(90, 1)
    const { result } = await signIn()
    expect(result.attempt.step.status).toBe('complete')
    expect(await liveSessions(userId)).toHaveLength(1)
  })

  test('with no expiry in the policy an old password signs in', async () => {
    configure({ expiryDays: null })
    await seedAged(5_000)
    expect((await signIn()).result.attempt.step.status).toBe('complete')
  })

  test('the expiry is the environment’s as configured when the password is typed', async () => {
    await seedAged(30)
    expect((await signIn()).result.attempt.step.status).toBe('complete')
    configure({ expiryDays: 30 })
    expect((await signIn()).result.attempt.step).toEqual(EXPIRED_STEP)
    configure({ expiryDays: null })
    expect((await signIn()).result.attempt.step.status).toBe('complete')
  })

  test('nothing of the user’s password or its age is kept on the attempt but when it was set', async () => {
    const created = deps.clock.now().getTime()
    await seedAged(90)
    const { attempt } = await signIn()
    const state = (await stored(attempt))?.state as Record<string, unknown>
    expect(state.expiredPasswordSetAt).toBe(created)
    expect(JSON.stringify(state)).not.toContain('argon2')
  })
})

describe('a wrong password reveals nothing about expiry', () => {
  /** What a wrong password is answered with, and what it cost. */
  async function wrongGuess(seed: () => Promise<unknown>) {
    deps = createTestDeps()
    deps.environments.add({
      id: TEST_TENANT.environmentId,
      projectId: TEST_TENANT.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
    configure()
    await seed()
    const verify = spyOn(Bun.password, 'verify')
    const attempt = await startSignIn()
    const error = await rejection(password(attempt, 'not the password at all'))
    const verifications = verify.mock.calls.length
    verify.mockRestore()
    return {
      code: error.code,
      status: error.status,
      params: error.params,
      verifications,
      attempt: { status: (await stored(attempt))?.status, userId: (await stored(attempt))?.userId },
      emails: deps.mailer.outbox.length,
      audit: deps.activityLog.entries.length,
    }
  }

  test('an expired account, a fresh one and no account answer a wrong password alike', async () => {
    const expired = await wrongGuess(() => seedAged(400))
    const fresh = await wrongGuess(() => seedUser())
    const nobody = await wrongGuess(async () => undefined)
    expect(expired).toEqual({
      code: 'auth.invalid_credentials',
      status: 401,
      params: undefined,
      verifications: 1,
      attempt: { status: 'needs_password', userId: null },
      emails: 0,
      audit: 0,
    })
    expect(fresh).toEqual(expired)
    expect(nobody).toEqual(expired)
  })

  test('a wrong password never asks whether the password has expired', async () => {
    await seedAged(400)
    const asked = spyOn(Passwords, 'expired')
    spies.push(asked)
    await rejection(password(await startSignIn(), 'not the password at all'))
    await rejection(password(await startSignIn('nobody@northline.app'), PASSWORD))
    expect(asked).not.toHaveBeenCalled()
    // A right one does.
    await signIn()
    expect(asked).toHaveBeenCalledTimes(1)
  })

  test('a locked-out identifier is refused the same with an expired password', async () => {
    await seedAged(400)
    for (let guess = 0; guess <= CREDENTIAL_LOCKOUT.freeAttempts; guess++) {
      await rejection(password(await startSignIn(), 'wrong one'))
    }
    // The next try is inside the back-off, right password or not.
    const locked = await rejection(password(await startSignIn(), PASSWORD))
    expect(locked).toBeInstanceOf(RateLimitError)
    expect(locked.code).toBe('rate_limited')
  })

  test('a banned user is told so, not asked for a new password', async () => {
    const userId = await seedAged(400)
    await Users.ban(deps, tenant, userId, TEST_ACTOR)
    const error = await rejection(signIn())
    expect(error.code).toBe('auth.user_banned')
    expect(passwordChanges()).toEqual([])
  })
})

describe('setting the new password', () => {
  test('stores it, completes the sign-in and records it as the user’s own change', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    const done = await renew(attempt)
    expect(done.attempt.step).toMatchObject({ status: 'complete', userId })
    expect(done.tokens?.accessToken).toBeString()
    expect(await amrOf(done)).toEqual(['pwd'])
    expect(await liveSessions(userId)).toHaveLength(1)
    expect(await Passwords.verify(await storedHash(), NEW_PASSWORD)).toBe(true)
    expect(await Passwords.verify(await storedHash(), PASSWORD)).toBe(false)
    expect(passwordChanges()).toMatchObject([
      { actor: { type: 'user', id: userId }, target: { id: userId }, data: { method: 'self' } },
    ])
    expect((await stored(attempt))?.status).toBe('complete')
    // The attempt is spent: it cannot set a second password.
    expect((await rejection(renew(attempt, THIRD_PASSWORD))).code).toBe('flow.not_found')
  })

  test('the owner is told, and nothing in the notice is a code or a link', async () => {
    await seedAged(90)
    const { attempt } = await signIn()
    await renew(attempt)
    await Notices.settled()
    const subjects = deps.mailer.outbox.map((mail) => mail.subject)
    expect(subjects.some((subject) => /password/i.test(subject))).toBe(true)
    for (const mail of deps.mailer.outbox) {
      expect(mail.subject).not.toMatch(/^\d/)
      expect(mail.text).not.toContain(NEW_PASSWORD)
    }
  })

  test('afterwards the new password signs in and is not expired; the old one is wrong', async () => {
    await seedAged(90)
    await renew((await signIn()).attempt)
    expect((await signIn(NEW_PASSWORD)).result.attempt.step.status).toBe('complete')
    expect((await rejection(signIn(PASSWORD))).code).toBe('auth.invalid_credentials')
    // And it expires in its own time.
    deps.clock.advance(90 * DAY)
    expect((await signIn(NEW_PASSWORD)).result.attempt.step).toEqual(EXPIRED_STEP)
  })

  test('every session the user had ends; the sign-in’s own is the only one left', async () => {
    configure({ expiryDays: 1 })
    const userId = await seedUser()
    const earlier = await signIn()
    const earlierSession = earlier.result.tokens?.sessionId as string
    deps.clock.advance(DAY)
    // Still alive when the password expires: otherwise this test would show nothing.
    expect((await liveSessions(userId)).map((session) => session.id)).toEqual([earlierSession])
    const { attempt } = await signIn()
    const done = await renew(attempt)
    expect((await liveSessions(userId)).map((session) => session.id)).toEqual([
      done.tokens?.sessionId as string,
    ])
    expect(await deps.revokedSessions.has(earlierSession, deps.clock.now())).toBe(true)
  })

  test('a password the policy refuses leaves the attempt where it is, to be tried again', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    const refused = await rejection(renew(attempt, 'short'))
    expect(refused.code).toBe('password.too_short')
    expect(refused.status).toBe(422)
    expect((await stored(attempt))?.status).toBe('needs_new_password')
    expect(await storedHash()).toBe(PASSWORD_HASH)
    expect(await liveSessions(userId)).toEqual([])
    expect(passwordChanges()).toEqual([])
    expect((await renew(attempt)).attempt.step.status).toBe('complete')
  })

  test('the expired password is refused as its own replacement, also with a history of 0', async () => {
    configure({ history: 0 })
    await seedAged(90)
    const { attempt } = await signIn()
    const refused = await rejection(renew(attempt, PASSWORD))
    expect(refused.code).toBe('password.reused')
    // The rule in force here is "not the one you have now": a history of one.
    expect(refused.params).toEqual({ history: 1 })
    expect(refused.errors).toMatchObject([
      { field: 'password', code: 'password.reused', params: { history: 1 } },
    ])
    expect(await storedHash()).toBe(PASSWORD_HASH)
    expect((await stored(attempt))?.status).toBe('needs_new_password')
    expect((await renew(attempt)).attempt.step.status).toBe('complete')
    // The policy keeps none, so none was kept: only the comparison was forced.
    expect(
      (await deps.users.storedPasswords(tenant.environmentId, attempt.id, 24)).previous
    ).toEqual([])
  })

  test('with a history of 0 nothing is kept of the expired password', async () => {
    configure({ history: 0 })
    const userId = await seedAged(90)
    await renew((await signIn()).attempt)
    expect((await deps.users.storedPasswords(tenant.environmentId, userId, 24)).previous).toEqual(
      []
    )
  })

  test('where a history is on, it applies as for a user’s own change', async () => {
    configure({ history: 3 })
    const userId = await seedUser()
    // The user has had two passwords before the current one.
    await Users.setPassword(deps, tenant, userId, NEW_PASSWORD, TEST_ACTOR)
    await Users.setPassword(deps, tenant, userId, THIRD_PASSWORD, TEST_ACTOR)
    // A day over: the two replacements at one instant of the test clock are stamped a
    // millisecond apart (a replacement is always newer than what it replaces).
    deps.clock.advance(91 * DAY)
    const { attempt } = await signIn(THIRD_PASSWORD)
    for (const old of [PASSWORD, NEW_PASSWORD, THIRD_PASSWORD]) {
      const refused = await rejection(renew(attempt, old))
      expect({ old, code: refused.code, params: refused.params }).toEqual({
        old,
        code: 'password.reused',
        params: { history: 3 },
      })
    }
    expect((await renew(attempt, 'a fourth passphrase 2026')).attempt.step.status).toBe('complete')
    // The expired password is now the newest previous one.
    expect(
      (await deps.users.storedPasswords(tenant.environmentId, userId, 24)).previous
    ).toHaveLength(2)
  })

  test('the comparison is counted against the user’s hourly allowance', async () => {
    await seedAged(90)
    const { attempt } = await signIn()
    for (let tries = 0; tries < Passwords.PASSWORD_HISTORY_CHECKS_PER_HOUR; tries++) {
      expect((await rejection(renew(attempt, PASSWORD))).code).toBe('password.reused')
    }
    const limited = await rejection(renew(attempt))
    expect(limited).toBeInstanceOf(RateLimitError)
    expect(await storedHash()).toBe(PASSWORD_HASH)
    expect((await stored(attempt))?.status).toBe('needs_new_password')
  })

  test('a limiter that cannot count refuses, and stores nothing', async () => {
    await seedAged(90)
    const { attempt } = await signIn()
    const hit = spyOn(deps.rateLimiter, 'hit').mockRejectedValue(
      new ServiceException('service.unavailable')
    )
    spies.push(hit)
    expect((await rejection(renew(attempt))).code).toBe('service.unavailable')
    expect(await storedHash()).toBe(PASSWORD_HASH)
  })
})

describe('the attempt’s binding on the new step', () => {
  test.each([
    ['no secret', (attempt: Presented) => ({ id: attempt.id, secret: undefined })],
    ['a wrong secret', (attempt: Presented) => ({ id: attempt.id, secret: 'tula_at_wrong' })],
    [
      'an unknown attempt',
      (attempt: Presented) => ({
        id: '0199c2f4-0000-7000-8000-00000000dead',
        secret: attempt.attemptSecret,
      }),
    ],
  ])('%s is flow.not_found, with nothing stored or counted', async (_name, presented) => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    const hit = spyOn(deps.rateLimiter, 'hit')
    spies.push(hit)
    const error = await rejection(
      Flows.replaceExpiredPassword(deps, tenant, presented(attempt), NEW_PASSWORD, web)
    )
    expect(error.code).toBe('flow.not_found')
    expect(hit).not.toHaveBeenCalled()
    expect(await storedHash()).toBe(PASSWORD_HASH)
    expect(await liveSessions(userId)).toEqual([])
  })

  test('another attempt’s secret does not replace this attempt’s password', async () => {
    await seedAged(90)
    const { attempt } = await signIn()
    const other = await startSignIn()
    const error = await rejection(
      Flows.replaceExpiredPassword(
        deps,
        tenant,
        { id: attempt.id, secret: other.attemptSecret },
        NEW_PASSWORD,
        web
      )
    )
    expect(error.code).toBe('flow.not_found')
    expect(await storedHash()).toBe(PASSWORD_HASH)
  })

  test('a browser attempt is refused from an origin the environment does not allow', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    const error = await rejection(renew(attempt, NEW_PASSWORD, { ...web, originAllowed: false }))
    expect(error.code).toBe('request.origin_not_allowed')
    expect(await storedHash()).toBe(PASSWORD_HASH)
    expect(await liveSessions(userId)).toEqual([])
    expect((await stored(attempt))?.status).toBe('needs_new_password')
  })

  test('passwords switched off meanwhile: auth.method_disabled, and nothing is used up', async () => {
    await seedAged(90)
    const { attempt } = await signIn()
    configure({ password: false, emailCode: true })
    const hit = spyOn(deps.rateLimiter, 'hit')
    spies.push(hit)
    expect((await rejection(renew(attempt))).code).toBe('auth.method_disabled')
    expect(hit).not.toHaveBeenCalled()
    expect(await storedHash()).toBe(PASSWORD_HASH)
    // Switched back on, the same attempt goes through.
    configure()
    expect((await renew(attempt)).attempt.step.status).toBe('complete')
  })

  test.each([
    ['a sign-in still on its password', async () => startSignIn()],
    [
      'a sign-in whose password has not expired and is waiting on a second factor',
      async () => {
        const fresh = await seedUser({ email: 'second@northline.app' })
        await enrol(fresh)
        const attempt = await startSignIn('second@northline.app')
        await password(attempt)
        return attempt
      },
    ],
  ])('the step is refused for %s', async (_name, make) => {
    await seedAged(90)
    const attempt = await make()
    expect((await rejection(renew(attempt))).code).toBe('flow.invalid_step')
  })

  test('a password reset’s attempt is not a sign-in’s: each route refuses the other’s', async () => {
    await seedAged(90)
    const reset = (await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)).attempt
    expect(reset.step).toEqual({
      status: 'needs_new_password',
      destination: 'm***@northline.app',
      strategies: ['email_code'],
    })
    // The sign-in's route with a reset's attempt: no emailed code is skipped that way.
    expect((await rejection(renew(reset))).code).toBe('flow.not_found')
    const { attempt } = await signIn()
    const viaReset = await rejection(
      Flows.resetPassword(
        deps,
        tenant,
        ref(attempt),
        { code: sentCode(), password: NEW_PASSWORD },
        web
      )
    )
    expect(viaReset.code).toBe('flow.not_found')
    expect(await storedHash()).toBe(PASSWORD_HASH)
  })
})

describe('a second factor comes before the new password', () => {
  test('the password alone gets needs_second_factor, with nothing said about expiry', async () => {
    const userId = await seedUser()
    await enrol(userId)
    deps.clock.advance(90 * DAY)
    const { attempt, result } = await signIn()
    expect(result.attempt.step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code'],
    })
    await expectNoSession(result, userId)
    // The holder of only the old password cannot replace it.
    expect((await rejection(renew(attempt))).code).toBe('flow.invalid_step')
    expect(await storedHash()).toBe(PASSWORD_HASH)
  })

  test('the factor, then the new password, then the session', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    deps.clock.advance(90 * DAY)
    const { attempt } = await signIn()
    const afterFactor = await Flows.submitSecondFactor(
      deps,
      tenant,
      'sign_in',
      ref(attempt),
      { method: 'totp', response: codeFor(secret) },
      web
    )
    expect(afterFactor.attempt.step).toEqual(EXPIRED_STEP)
    await expectNoSession(afterFactor, userId)
    expect(await stored(attempt)).toMatchObject({
      status: 'needs_new_password',
      state: { amr: expect.arrayContaining(['pwd', 'otp', 'mfa']) },
    })
    const done = await renew(attempt)
    expect(done.attempt.step.status).toBe('complete')
    expect(new Set(await amrOf(done))).toEqual(new Set(['pwd', 'otp', 'mfa']))
    expect(await liveSessions(userId)).toHaveLength(1)
  })

  test('a backup code is spent on the way, and the answer says how many are left', async () => {
    const userId = await seedUser()
    const { codes } = await enrol(userId)
    deps.clock.advance(90 * DAY)
    const { attempt } = await signIn()
    const afterFactor = await Flows.submitSecondFactor(
      deps,
      tenant,
      'sign_in',
      ref(attempt),
      { method: 'backup_code', response: codes[0] as string },
      web
    )
    expect(afterFactor.attempt.step).toEqual(EXPIRED_STEP)
    expect(afterFactor.attempt.backupCodesRemaining).toBe(9)
    expect(afterFactor.tokens).toBeUndefined()
    expect((await renew(attempt)).attempt.step.status).toBe('complete')
  })

  test('a wrong second factor leaves the attempt on the factor, not on the password', async () => {
    const userId = await seedUser()
    await enrol(userId)
    deps.clock.advance(90 * DAY)
    const { attempt } = await signIn()
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
    expect(wrong.code).toBe('mfa.invalid_code')
    expect((await stored(attempt))?.status).toBe('needs_second_factor')
    expect((await rejection(renew(attempt))).code).toBe('flow.invalid_step')
  })

  test('a factor confirmed while the attempt waits on the new password ends the attempt', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    expect((await stored(attempt))?.status).toBe('needs_new_password')
    await enrol(userId)
    const error = await rejection(renew(attempt))
    expect(error.code).toBe('flow.invalid_step')
    expect(await storedHash()).toBe(PASSWORD_HASH)
    expect(passwordChanges()).toEqual([])
    expect(await liveSessions(userId)).toEqual([])
  })

  test('where a second factor is required, the enrolment comes first and its codes are shown once', async () => {
    configure({ mfa: 'required' })
    const userId = await seedAged(90)
    const { attempt, result } = await signIn()
    expect(result.attempt.step).toEqual({ status: 'needs_factor_enrolment', methods: ['totp'] })
    expect((await rejection(renew(attempt))).code).toBe('flow.invalid_step')
    const { secret } = await Flows.startFactorEnrolment(deps, tenant, 'sign_in', ref(attempt), web)
    const enrolled = await Flows.confirmFactorEnrolment(
      deps,
      tenant,
      'sign_in',
      ref(attempt),
      codeFor(secret),
      web
    )
    expect(enrolled.attempt.step).toEqual(EXPIRED_STEP)
    expect(enrolled.attempt.backupCodes).toHaveLength(10)
    expect(enrolled.tokens).toBeUndefined()
    expect(await liveSessions(userId)).toEqual([])
    const done = await renew(attempt)
    expect(done.attempt.step.status).toBe('complete')
    expect(done.attempt).not.toHaveProperty('backupCodes')
    expect(new Set(await amrOf(done))).toEqual(new Set(['pwd', 'otp', 'mfa']))
  })

  test('an unverified address is proven before the new password is asked for', async () => {
    const userId = await seedAged(90, 0, { verified: false })
    const { attempt, result } = await signIn()
    expect(result.attempt.step.status).toBe('needs_email_verification')
    expect((await rejection(renew(attempt))).code).toBe('flow.invalid_step')
    const verified = await Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), sentCode(), web)
    expect(verified.attempt.step).toEqual(EXPIRED_STEP)
    await expectNoSession(verified, userId)
    expect((await renew(attempt)).attempt.step.status).toBe('complete')
  })
})

describe('the password must still be the one the attempt proved', () => {
  test('replaced by an administrator meanwhile: the attempt has proven nothing', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    await Users.setPassword(deps, tenant, userId, THIRD_PASSWORD, TEST_ACTOR)
    const theirs = await storedHash()
    const hit = spyOn(deps.rateLimiter, 'hit')
    const verify = spyOn(Bun.password, 'verify')
    spies.push(hit, verify)
    const error = await rejection(renew(attempt))
    expect(error.code).toBe('flow.invalid_step')
    expect(error.status).toBe(409)
    // Nothing was compared, nothing counted against the user, and the password that was
    // set stands.
    expect(verify).not.toHaveBeenCalled()
    expect(JSON.stringify(hit.mock.calls)).not.toContain('password_history')
    expect(await storedHash()).toBe(theirs)
    expect(await liveSessions(userId)).toEqual([])
  })

  test('the stale attempt cannot ask whether a candidate is the new password', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    await Users.setPassword(deps, tenant, userId, THIRD_PASSWORD, TEST_ACTOR)
    // The same answer for the password that was set as for any other candidate.
    expect((await rejection(renew(attempt, THIRD_PASSWORD))).code).toBe('flow.invalid_step')
    expect((await rejection(renew(attempt, NEW_PASSWORD))).code).toBe('flow.invalid_step')
  })

  test('reset by its owner meanwhile: the reset stands and the old attempt is dead', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    const reset = (await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)).attempt
    await Flows.resetPassword(
      deps,
      tenant,
      ref(reset),
      { code: sentCode(), password: THIRD_PASSWORD },
      web
    )
    const sessions = await liveSessions(userId)
    expect((await rejection(renew(attempt))).code).toBe('flow.invalid_step')
    expect(await Passwords.verify(await storedHash(), THIRD_PASSWORD)).toBe(true)
    expect(await liveSessions(userId)).toEqual(sessions)
  })

  test('replaced between the step’s own read and the comparison: refused before any verification', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    const read = deps.users.storedPasswords.bind(deps.users)
    let moved = false
    const racing = spyOn(deps.users, 'storedPasswords').mockImplementation(async (...args) => {
      if (!moved) {
        moved = true
        // Another writer lands after the step read the credential and before the history is read.
        await deps.users.setPasswordHash(
          tenant.environmentId,
          userId,
          await Passwords.hash(THIRD_PASSWORD),
          deps.clock.now(),
          Audit.none('fixture'),
          { keep: 0 }
        )
      }
      return read(...args)
    })
    spies.push(racing)
    const verify = spyOn(Bun.password, 'verify')
    spies.push(verify)
    const error = await rejection(renew(attempt, THIRD_PASSWORD))
    expect(error.code).toBe('flow.invalid_step')
    expect(verify).not.toHaveBeenCalled()
    expect(await Passwords.verify(await storedHash(), THIRD_PASSWORD)).toBe(true)
    expect(await liveSessions(userId)).toEqual([])
  })

  /** Hash the stored password again, as another tab's sign-in does (same password, new hash). */
  async function upgradeHash(userId: string): Promise<string> {
    const upgraded = await Passwords.hash(PASSWORD)
    expect(
      await deps.users.upgradePasswordHash(
        tenant.environmentId,
        userId,
        PASSWORD_HASH,
        upgraded,
        deps.clock.now()
      )
    ).toBe(true)
    return upgraded
  }

  /** Run `land` once, before or after the first read of the history, as a writer racing the step. */
  function racing(when: 'before the comparison' | 'after it', land: () => Promise<unknown>) {
    const read = deps.users.storedPasswords.bind(deps.users)
    let landed = false
    const spy = spyOn(deps.users, 'storedPasswords').mockImplementation(async (...args) => {
      if (landed) {
        return read(...args)
      }
      landed = true
      if (when === 'before the comparison') {
        await land()
        return read(...args)
      }
      const result = await read(...args)
      await land()
      return result
    })
    spies.push(spy)
  }

  test.each(['before the comparison', 'after it'] as const)(
    'a hash upgrade that lands %s is the same password: the attempt completes',
    async (when) => {
      const userId = await seedAged(90)
      const { attempt } = await signIn()
      racing(when, () => upgradeHash(userId))
      const done = await renew(attempt)
      expect(done.attempt.step.status).toBe('complete')
      expect(await Passwords.verify(await storedHash(), NEW_PASSWORD)).toBe(true)
      expect(await liveSessions(userId)).toHaveLength(1)
      // The comparison was counted once, however many times it was made.
      expect(
        (await deps.rateLimiter.hit(`password_history:${tenant.environmentId}:${userId}`, 99, DAY))
          .remaining
      ).toBe(97)
    }
  )

  test('replaced after the comparison, before the write: refused, and the other password stands', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    racing('after it', async () =>
      deps.users.setPasswordHash(
        tenant.environmentId,
        userId,
        await Passwords.hash(THIRD_PASSWORD),
        deps.clock.now(),
        Audit.none('fixture'),
        { keep: 0 }
      )
    )
    expect((await rejection(renew(attempt))).code).toBe('flow.invalid_step')
    expect(await Passwords.verify(await storedHash(), THIRD_PASSWORD)).toBe(true)
    expect(await liveSessions(userId)).toEqual([])
  })

  test.each(['before the step', 'before the comparison', 'after it'] as const)(
    'replaced %s by a write stamped with the very instant the expired password was set: still refused',
    async (when) => {
      const userId = await seedAged(90)
      const { attempt } = await signIn()
      const setAt = (await deps.users.findByEmailWithPassword(tenant.environmentId, EMAIL))
        ?.passwordChangedAt as Date
      const theirs = await Passwords.hash(THIRD_PASSWORD)
      // A writer whose clock reads what it read when the expired password was set (a clock
      // put back): the time alone would not tell its password from the one the attempt proved.
      const replace = () =>
        deps.users.setPasswordHash(
          tenant.environmentId,
          userId,
          theirs,
          new Date(setAt),
          Audit.none('fixture'),
          { keep: 0 }
        )
      if (when === 'before the step') {
        await replace()
      } else {
        racing(when, replace)
      }
      const verify = spyOn(Bun.password, 'verify')
      spies.push(verify)
      expect((await rejection(renew(attempt, THIRD_PASSWORD))).code).toBe('flow.invalid_step')
      if (when !== 'after it') {
        // Nothing was compared: the attempt cannot ask whether its candidate is that password.
        expect(verify).not.toHaveBeenCalled()
      }
      expect(await storedHash()).toBe(theirs)
      expect(await liveSessions(userId)).toEqual([])
    }
  )

  test('a user deleted meanwhile, or moved to another address, is not given a password', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    await Users.remove(deps, tenant, userId, TEST_ACTOR)
    expect((await rejection(renew(attempt))).code).toBe('flow.invalid_step')
  })

  test('a user banned meanwhile is told so, and the password stays', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    await Users.ban(deps, tenant, userId, TEST_ACTOR)
    expect((await rejection(renew(attempt))).code).toBe('auth.user_banned')
    expect(await storedHash()).toBe(PASSWORD_HASH)
  })
})

describe('ending the earlier sessions after the password is stored', () => {
  /** A user with one live session whose password has since expired, at the new-password step. */
  async function parked() {
    configure({ expiryDays: 1 })
    const userId = await seedUser()
    const earlier = (await signIn()).result.tokens?.sessionId as string
    deps.clock.advance(DAY)
    const { attempt } = await signIn()
    return { userId, earlier, attempt }
  }

  /** Make the sweep fail `times` times, then work. */
  function failingSweep(times: number) {
    const sweep = Sessions.revokeAllForUser
    let failures = 0
    const spy = spyOn(Sessions, 'revokeAllForUser').mockImplementation(async (...args) => {
      if (failures < times) {
        failures += 1
        throw new Error('canary-sweep-failure the session store is away')
      }
      return sweep(...args)
    })
    spies.push(spy)
    return spy
  }

  test.each([1, 2])(
    'a sweep that fails %p time(s) is tried again: the sign-in completes and the sessions end',
    async (times) => {
      const { userId, earlier, attempt } = await parked()
      const sweep = failingSweep(times)
      const logged = spyOn(logger, 'error').mockImplementation(() => undefined)
      spies.push(logged)
      const done = await renew(attempt)
      expect(done.attempt.step.status).toBe('complete')
      expect(sweep).toHaveBeenCalledTimes(times + 1)
      expect((await liveSessions(userId)).map((session) => session.id)).toEqual([
        done.tokens?.sessionId as string,
      ])
      expect(await deps.revokedSessions.has(earlier, deps.clock.now())).toBe(true)
      expect(logged).not.toHaveBeenCalled()
    }
  )

  test('a sweep that fails every time: 503, said in the log, the password changed and the earlier sessions alive', async () => {
    const { userId, earlier, attempt } = await parked()
    const sweep = failingSweep(Number.POSITIVE_INFINITY)
    const logged = spyOn(logger, 'error').mockImplementation(() => undefined)
    spies.push(logged)
    const error = await rejection(renew(attempt))
    expect(error.code).toBe('service.unavailable')
    expect(error.status).toBe(503)
    // Three tries, and no more.
    expect(sweep).toHaveBeenCalledTimes(3)
    // Fixed words, the environment and the user's id; nothing of the failure or the request.
    expect(logged.mock.calls).toEqual([
      [
        'a password that replaced an expired one was stored, and the user’s earlier sessions could not be ended',
        { environmentId: tenant.environmentId, userId },
      ],
    ])
    expect(JSON.stringify(error)).not.toContain('canary-sweep-failure')
    // The stated cost (ADR 0041), pinned: the new password is stored and announced, the
    // sessions made under the old one are still alive, and nobody was signed in.
    expect(await Passwords.verify(await storedHash(), NEW_PASSWORD)).toBe(true)
    expect(passwordChanges()).toHaveLength(1)
    expect((await liveSessions(userId)).map((session) => session.id)).toEqual([earlier])
    expect(await deps.revokedSessions.has(earlier, deps.clock.now())).toBe(false)
    expect(deps.activityLog.ofType('session.created')).toHaveLength(1)
    // The attempt has proven nothing about the password the account has now.
    expect((await rejection(renew(attempt, THIRD_PASSWORD))).code).toBe('flow.invalid_step')
    // The user signs in with the new password, which is not expired.
    for (const spy of spies.splice(0)) {
      spy.mockRestore()
    }
    expect((await signIn(NEW_PASSWORD)).result.attempt.step.status).toBe('complete')
  })

  test('a hook that refuses the session after the store: the password is the new one, the earlier sessions are gone, nobody is signed in', async () => {
    const { userId, earlier, attempt } = await parked()
    const refusing = spyOn(Hooks, 'beforeSession').mockRejectedValue(
      new AuthError('hook.denied', { code: 'not_now' })
    )
    spies.push(refusing)
    expect((await rejection(renew(attempt))).code).toBe('hook.denied')
    expect(await Passwords.verify(await storedHash(), NEW_PASSWORD)).toBe(true)
    expect(await liveSessions(userId)).toEqual([])
    expect(await deps.revokedSessions.has(earlier, deps.clock.now())).toBe(true)
    refusing.mockRestore()
    expect((await signIn(NEW_PASSWORD)).result.attempt.step.status).toBe('complete')
  })
})

describe('what does not make a password newer, and what does', () => {
  test('the hash upgrade after a sign-in leaves an expired password expired', async () => {
    // A hash made with weaker parameters than the server's: the sign-in rehashes it.
    const weak = await Bun.password.hash(PASSWORD, {
      algorithm: 'argon2id',
      memoryCost: 1024,
      timeCost: 1,
    })
    expect(Passwords.needsRehash(weak)).toBe(true)
    await seedAged(90, 0, { passwordHash: weak })
    const first = await signIn()
    expect(first.result.attempt.step).toEqual(EXPIRED_STEP)
    const upgraded = await storedHash()
    expect(upgraded).not.toBe(weak)
    expect(Passwords.needsRehash(upgraded as string)).toBe(false)
    // Hashed again a moment ago, and still as old as it was.
    expect((await signIn()).result.attempt.step).toEqual(EXPIRED_STEP)
    // The attempt that proved it before the upgrade can still replace it: it is the same password.
    expect((await renew(first.attempt)).attempt.step.status).toBe('complete')
  })

  test('a reset stores a fresh password: the next sign-in is not stopped', async () => {
    await seedAged(90)
    const reset = (await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)).attempt
    const done = await Flows.resetPassword(
      deps,
      tenant,
      ref(reset),
      { code: sentCode(), password: NEW_PASSWORD },
      web
    )
    // The reset itself is never sent to a second new-password step.
    expect(done.attempt.step.status).toBe('complete')
    expect((await signIn(NEW_PASSWORD)).result.attempt.step.status).toBe('complete')
  })

  test('an administrator’s set-password does too', async () => {
    const userId = await seedAged(90)
    await Users.setPassword(deps, tenant, userId, NEW_PASSWORD, TEST_ACTOR)
    expect((await signIn(NEW_PASSWORD)).result.attempt.step.status).toBe('complete')
  })

  test('a signed-in user’s own change does, and its current-password check ignores the age', async () => {
    configure({ expiryDays: 1 })
    const userId = await seedUser()
    const session = (await signIn()).result.tokens?.sessionId as string
    deps.clock.advance(DAY)
    // The current password is expired and still proves the change.
    await Users.changePassword(
      deps,
      tenant,
      { userId, sessionId: session },
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }
    )
    expect((await signIn(NEW_PASSWORD)).result.attempt.step.status).toBe('complete')
  })
})

describe('only a sign-in with the password is stopped', () => {
  test('an emailed code signs in whatever the password’s age', async () => {
    configure({ emailCode: true })
    const userId = await seedAged(400)
    const attempt = await startSignIn()
    await Flows.prepareFirstFactor(deps, tenant, ref(attempt), { strategy: 'email_code' }, web)
    const done = await Flows.attemptFirstFactor(
      deps,
      tenant,
      ref(attempt),
      { strategy: 'email_code', code: sentCode() },
      web
    )
    expect(done.attempt.step.status).toBe('complete')
    expect(await liveSessions(userId)).toHaveLength(1)
    // And the password is as old as it was: the next password sign-in is stopped.
    const withPassword = await startSignIn()
    expect((await password(withPassword)).attempt.step).toEqual(EXPIRED_STEP)
  })

  test('a sign-up’s password is new, however the clock stands', async () => {
    deps.clock.advance(400 * DAY)
    const { attempt } = await Flows.signUp(deps, tenant, { email: EMAIL, password: PASSWORD }, web)
    const done = await Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), sentCode(), web)
    expect(done.attempt.step.status).toBe('complete')
  })
})

describe('two requests at once', () => {
  test('one session, and the stored password is one of the two', async () => {
    const userId = await seedAged(90)
    const { attempt } = await signIn()
    const outcomes = await Promise.allSettled([
      renew(attempt, NEW_PASSWORD),
      renew(attempt, THIRD_PASSWORD),
    ])
    const completed = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    expect(completed).toHaveLength(1)
    expect(await liveSessions(userId)).toHaveLength(1)
    const hash = await storedHash()
    expect(
      (await Passwords.verify(hash, NEW_PASSWORD)) || (await Passwords.verify(hash, THIRD_PASSWORD))
    ).toBe(true)
    expect(await Passwords.verify(hash, PASSWORD)).toBe(false)
  })
})

describe('the lockout is not touched by the new step', () => {
  test('a refused new password counts no guess against the identifier', async () => {
    await seedAged(90)
    const { attempt } = await signIn()
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)
    await rejection(renew(attempt, 'short'))
    await rejection(renew(attempt, PASSWORD))
    expect(counted).not.toHaveBeenCalled()
  })
})
