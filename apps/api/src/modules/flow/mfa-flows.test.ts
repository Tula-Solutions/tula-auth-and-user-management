import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  type FlowAttempt,
  type FlowKind,
} from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { NotFoundError, RateLimitError, ServiceException } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import { base32Decode, totp } from '~/lib/totp'
import { verifyAccessToken } from '~/middleware/session-auth'
import * as Factors from '~/modules/factor/service'
import * as Flows from '~/modules/flow/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a brand new passphrase 42'
// One argon2 hash for the whole file: hashing per test would dominate its run time.
const PASSWORD_HASH = await Passwords.hash(PASSWORD)
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
  policy?: EnvironmentSettings['mfa']['policy']
  emailCode?: boolean
  signUpPassword?: EnvironmentSettings['signUp']['password']
}

let revision = 0
function configure(switches: Switches = {}, target: Tenant = tenant) {
  revision += 1
  deps.environmentSettings.seed(target.environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      signIn: {
        methods: {
          ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods,
          emailCode: { enabled: switches.emailCode ?? false },
        },
      },
      signUp: { password: switches.signUpPassword ?? 'required' },
      mfa: { policy: switches.policy ?? 'optional' },
    },
  })
}

beforeEach(() => {
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

async function seedUser(options: { verified?: boolean; password?: boolean; email?: string } = {}) {
  const id = deps.ids.next()
  const email = options.email ?? EMAIL
  await deps.users.create({
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
    passwordHash: options.password === false ? null : PASSWORD_HASH,
  })
  return id
}

/** The code an authenticator holding `secret` shows at the test clock's time. */
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

const startSignIn = async (context = web) =>
  (await Flows.signIn(deps, tenant, { identifier: EMAIL }, context)).attempt
const password = (attempt: Presented, value = PASSWORD, context = web) =>
  Flows.submitPassword(deps, tenant, ref(attempt), value, context)
const second = (
  attempt: Presented,
  method: 'totp' | 'backup_code' | 'passkey',
  response: string,
  kind: FlowKind = 'sign_in',
  context = web
) => Flows.submitSecondFactor(deps, tenant, kind, ref(attempt), { method, response }, context)
const startEnrolment = (attempt: Presented, kind: FlowKind = 'sign_in', context = web) =>
  Flows.startFactorEnrolment(deps, tenant, kind, ref(attempt), context)
const confirmEnrolment = (
  attempt: Presented,
  code: string,
  kind: FlowKind = 'sign_in',
  context = web
) => Flows.confirmFactorEnrolment(deps, tenant, kind, ref(attempt), code, context)

const liveSessions = (userId: string) =>
  deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
const stored = (attempt: Presented) => deps.flowAttempts.findById(tenant.environmentId, attempt.id)
const amrOf = async (result: Flows.FlowResult) =>
  (await verifyAccessToken(deps, result.tokens?.accessToken as string, tenant)).amr

/** Nothing that only a completed attempt may have exists yet. */
async function expectNoSession(result: Flows.FlowResult, userId: string) {
  expect(result.tokens).toBeUndefined()
  expect(result.attempt).not.toHaveProperty('session')
  expect(result.attempt).not.toHaveProperty('backupCodes')
  expect(result.attempt).not.toHaveProperty('backupCodesRemaining')
  expect(result.attempt).not.toHaveProperty('attemptSecret')
  expect(await liveSessions(userId)).toEqual([])
  expect(deps.activityLog.ofType('session.created')).toEqual([])
}

/** Take an attempt of each kind up to and including its last proof before any second factor. */
const LAST_PROOF: Record<
  FlowKind,
  () => Promise<{ attempt: Presented; result: Flows.FlowResult; userId: string; first: string }>
> = {
  sign_in: async () => {
    const userId = await seedUser()
    const attempt = await startSignIn()
    return { attempt, result: await password(attempt), userId, first: 'pwd' }
  },
  sign_up: async () => {
    const { attempt } = await Flows.signUp(deps, tenant, { email: EMAIL, password: PASSWORD }, web)
    const result = await Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), sentCode(), web)
    const user = await deps.users.findByEmail(tenant.environmentId, EMAIL)
    return { attempt, result, userId: user?.id as string, first: 'email' }
  },
  password_reset: async () => {
    const userId = await seedUser()
    const { attempt } = await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)
    const result = await Flows.resetPassword(
      deps,
      tenant,
      ref(attempt),
      { code: sentCode(), password: NEW_PASSWORD },
      web
    )
    return { attempt, result, userId, first: 'email' }
  },
}
const KINDS: [FlowKind][] = [['sign_in'], ['sign_up'], ['password_reset']]

describe('a user with a real second factor', () => {
  test('the password alone yields needs_second_factor: no tokens and no session row', async () => {
    const userId = await seedUser()
    await enrol(userId)
    const attempt = await startSignIn()
    const waiting = await password(attempt)
    expect(waiting.attempt.step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code'],
    })
    await expectNoSession(waiting, userId)
    expect(await stored(attempt)).toMatchObject({
      status: 'needs_second_factor',
      userId,
      completedAt: null,
      state: { secondFactors: ['totp', 'backup_code'], amr: ['pwd'] },
    })
  })

  test('an emailed code alone yields needs_second_factor: no tokens and no session row', async () => {
    configure({ emailCode: true })
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    const attempt = await startSignIn()
    await Flows.prepareFirstFactor(deps, tenant, ref(attempt), { strategy: 'email_code' }, web)
    const waiting = await Flows.attemptFirstFactor(
      deps,
      tenant,
      ref(attempt),
      { strategy: 'email_code', code: sentCode() },
      web
    )
    expect(waiting.attempt.step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code'],
    })
    await expectNoSession(waiting, userId)

    const done = await second(attempt, 'totp', codeFor(secret))
    expect(done.attempt.step).toMatchObject({ status: 'complete', userId })
    expect(await amrOf(done)).toEqual(['email', 'otp', 'mfa'])
  })

  test('a password reset stops at the second factor: the inbox alone never signs in', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    const { attempt } = await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)
    const waiting = await Flows.resetPassword(
      deps,
      tenant,
      ref(attempt),
      { code: sentCode(), password: NEW_PASSWORD },
      web
    )
    expect(waiting.attempt.step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code'],
    })
    await expectNoSession(waiting, userId)
    // The factor is still on: a reset removes nothing.
    expect(await Mfa.status(deps, tenant, userId)).toMatchObject({ totp: { enabled: true } })

    const done = await second(attempt, 'totp', codeFor(secret), 'password_reset')
    expect(done.attempt.step).toMatchObject({ status: 'complete', userId })
    expect(await amrOf(done)).toEqual(['email', 'otp', 'mfa'])
    expect(await liveSessions(userId)).toHaveLength(1)
  })

  test('a wrong code is mfa.invalid_code: no session, and the attempt stays open', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    const attempt = await startSignIn()
    await password(attempt)
    for (const [method, response] of [
      ['totp', '000000'],
      ['backup_code', 'zzzzz-zzzzz'],
    ] as const) {
      if (response === codeFor(secret)) {
        continue
      }
      const err = await rejection(second(attempt, method, response))
      expect(err.toJSON()).toMatchObject({ status: 422, code: 'mfa.invalid_code' })
    }
    expect(await liveSessions(userId)).toEqual([])
    expect(await stored(attempt)).toMatchObject({ status: 'needs_second_factor' })
    expect((await second(attempt, 'totp', codeFor(secret))).attempt.step.status).toBe('complete')
  })

  test('a code that signed the user in is refused in another attempt until the next step', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    const code = codeFor(secret)
    const first = await startSignIn()
    await password(first)
    expect((await second(first, 'totp', code)).attempt.step.status).toBe('complete')

    const again = await startSignIn()
    await password(again)
    expect((await rejection(second(again, 'totp', code))).code).toBe('mfa.invalid_code')
    deps.clock.advance('30s')
    expect((await second(again, 'totp', codeFor(secret))).attempt.step.status).toBe('complete')
    expect(await liveSessions(userId)).toHaveLength(2)
  })

  test('one code submitted to two attempts at once signs in exactly one', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    const first = await startSignIn()
    await password(first)
    const other = await startSignIn()
    await password(other)
    const code = codeFor(secret)
    const results = await Promise.allSettled([
      second(first, 'totp', code),
      second(other, 'totp', code),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await liveSessions(userId)).toHaveLength(1)
  })

  test('a backup code completes the sign-in once and says how many are left', async () => {
    const userId = await seedUser()
    const { codes } = await enrol(userId)
    const attempt = await startSignIn()
    await password(attempt)
    const done = await second(attempt, 'backup_code', (codes[0] as string).toUpperCase())
    expect(done.attempt).toMatchObject({
      step: { status: 'complete', userId },
      backupCodesRemaining: 9,
    })
    expect(done.attempt).not.toHaveProperty('backupCodes')
    expect(await amrOf(done)).toEqual(['pwd', 'backup_code', 'mfa'])
    expect(deps.activityLog.ofType('user.backup_code_used')).toEqual([
      expect.objectContaining({
        actor: { type: 'user', id: userId },
        ipAddress: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      }),
    ])

    const again = await startSignIn()
    await password(again)
    expect((await rejection(second(again, 'backup_code', codes[0] as string))).code).toBe(
      'mfa.invalid_code'
    )
    expect(await liveSessions(userId)).toHaveLength(1)
  })

  test('a TOTP sign-in does not report backup codes left', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    const attempt = await startSignIn()
    await password(attempt)
    const done = await second(attempt, 'totp', codeFor(secret))
    expect(done.attempt).not.toHaveProperty('backupCodesRemaining')
  })

  test('one backup code submitted to two attempts at once signs in exactly one', async () => {
    const userId = await seedUser()
    const { codes } = await enrol(userId)
    const first = await startSignIn()
    await password(first)
    const other = await startSignIn()
    await password(other)
    const results = await Promise.allSettled([
      second(first, 'backup_code', codes[0] as string),
      second(other, 'backup_code', codes[0] as string),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await liveSessions(userId)).toHaveLength(1)
    expect(await Mfa.status(deps, tenant, userId)).toMatchObject({ backupCodes: { remaining: 9 } })
  })

  test('with no backup code left only the authenticator is offered, and a backup code is not a step', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    await deps.factors.replaceBackupCodes(
      tenant.environmentId,
      userId,
      tenant,
      [],
      deps.clock.now()
    )
    const attempt = await startSignIn()
    const waiting = await password(attempt)
    expect(waiting.attempt.step).toEqual({ status: 'needs_second_factor', options: ['totp'] })
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)
    const err = await rejection(second(attempt, 'backup_code', 'abcde-fghjk'))
    expect(err.toJSON()).toMatchObject({ status: 409, code: 'flow.invalid_step' })
    expect(counted).not.toHaveBeenCalled()
    expect((await second(attempt, 'totp', codeFor(secret))).attempt.step.status).toBe('complete')
  })

  test('a method with no verifier is never a step of the attempt', async () => {
    const userId = await seedUser()
    await enrol(userId)
    const attempt = await startSignIn()
    await password(attempt)
    expect((await rejection(second(attempt, 'passkey', 'anything'))).code).toBe('flow.invalid_step')
    expect(await liveSessions(userId)).toEqual([])
  })

  test('a pending enrolment is not asked for: the sign-in completes', async () => {
    const userId = await seedUser()
    await Mfa.startTotp(deps, tenant, userId)
    const done = await password(await startSignIn())
    expect(done.attempt.step).toMatchObject({ status: 'complete', userId })
    expect(await amrOf(done)).toEqual(['pwd'])
  })

  test('the policy `off` still asks an enrolled user for their factor', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    configure({ policy: 'off' })
    const attempt = await startSignIn()
    const waiting = await password(attempt)
    expect(waiting.attempt.step.status).toBe('needs_second_factor')
    await expectNoSession(waiting, userId)
    expect(await amrOf(await second(attempt, 'totp', codeFor(secret)))).toEqual([
      'pwd',
      'otp',
      'mfa',
    ])
  })

  test('a factor reset by an admin while an attempt waits on it: that attempt cannot finish', async () => {
    const userId = await seedUser()
    const { secret, codes } = await enrol(userId)
    const attempt = await startSignIn()
    await password(attempt)
    await Mfa.reset(deps, tenant, userId, TEST_ACTOR)
    expect((await rejection(second(attempt, 'totp', codeFor(secret)))).code).toBe(
      'mfa.invalid_code'
    )
    expect((await rejection(second(attempt, 'backup_code', codes[0] as string))).code).toBe(
      'mfa.invalid_code'
    )
    expect(await liveSessions(userId)).toEqual([])
    // A new sign-in no longer asks for it.
    expect((await password(await startSignIn())).attempt.step.status).toBe('complete')
  })

  test('wrong codes lock the user out of the second factor across attempts and methods', async () => {
    const userId = await seedUser()
    const { secret, codes } = await enrol(userId)
    const first = await startSignIn()
    await password(first)
    for (let index = 0; index <= CREDENTIAL_LOCKOUT.freeAttempts; index++) {
      const method = index % 2 === 0 ? 'totp' : 'backup_code'
      expect((await rejection(second(first, method, '999999'))).code).toBe('mfa.invalid_code')
    }
    const other = await startSignIn()
    await password(other)
    const used = spyOn(deps.factors, 'useTotpStep')
    const consumed = spyOn(deps.factors, 'consumeBackupCode')
    spies.push(used, consumed)
    expect(await second(other, 'totp', codeFor(secret)).catch((err) => err)).toBeInstanceOf(
      RateLimitError
    )
    expect(
      await second(other, 'backup_code', codes[0] as string).catch((err) => err)
    ).toBeInstanceOf(RateLimitError)
    expect(used).not.toHaveBeenCalled()
    expect(consumed).not.toHaveBeenCalled()
    expect(await liveSessions(userId)).toEqual([])
  })

  test('the attempt’s secret, kind, environment and origin are checked before any code', async () => {
    const userId = await seedUser()
    const { secret, codes } = await enrol(userId)
    const attempt = await startSignIn()
    await password(attempt)
    const counted = spyOn(deps.lockout, 'attempt')
    const used = spyOn(deps.factors, 'useTotpStep')
    const consumed = spyOn(deps.factors, 'consumeBackupCode')
    spies.push(counted, used, consumed)
    const code = codeFor(secret)

    for (const presented of [
      { id: attempt.id, attemptSecret: undefined },
      { id: attempt.id, attemptSecret: 'tula_at_made-up' },
    ]) {
      expect((await rejection(second(presented, 'totp', code))).code).toBe('flow.not_found')
      expect((await rejection(second(presented, 'backup_code', codes[0] as string))).code).toBe(
        'flow.not_found'
      )
    }
    expect((await rejection(second(attempt, 'totp', code, 'password_reset'))).code).toBe(
      'flow.not_found'
    )
    expect(
      (
        await rejection(
          Flows.submitSecondFactor(
            deps,
            otherTenant,
            'sign_in',
            ref(attempt),
            { method: 'totp', response: code },
            web
          )
        )
      ).code
    ).toBe('flow.not_found')
    for (const [method, response] of [
      ['totp', code],
      ['backup_code', codes[0] as string],
    ] as const) {
      expect((await rejection(second(attempt, method, response, 'sign_in', foreign))).code).toBe(
        'request.origin_not_allowed'
      )
    }
    expect(counted).not.toHaveBeenCalled()
    expect(used).not.toHaveBeenCalled()
    expect(consumed).not.toHaveBeenCalled()
    expect(await liveSessions(userId)).toEqual([])
    // Nothing was spent: the same code still completes the attempt.
    expect((await second(attempt, 'totp', code)).attempt.step.status).toBe('complete')
  })
})

describe('what an issued token says was proven (amr)', () => {
  test('a password sign-in: pwd', async () => {
    const userId = await seedUser()
    const done = await password(await startSignIn())
    expect(await amrOf(done)).toEqual(['pwd'])
    const claims = await verifyAccessToken(deps, done.tokens?.accessToken as string, tenant)
    expect(claims.auth_time).toBe(Math.floor(deps.clock.now().getTime() / 1000))
    expect(
      await deps.sessions.findById(tenant.environmentId, done.tokens?.sessionId as string)
    ).toMatchObject({ userId, authMethods: ['pwd'], factorVerifiedAt: deps.clock.now() })
  })

  test('a password and an authenticator code: pwd, otp, mfa', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    const attempt = await startSignIn()
    await password(attempt)
    deps.clock.advance('1m')
    const done = await second(attempt, 'totp', codeFor(secret))
    expect(await amrOf(done)).toEqual(['pwd', 'otp', 'mfa'])
    // auth_time is when the sign-in completed, not when the password was accepted.
    const claims = await verifyAccessToken(deps, done.tokens?.accessToken as string, tenant)
    expect(claims.auth_time).toBe(Math.floor(deps.clock.now().getTime() / 1000))
    expect(
      await deps.sessions.findById(tenant.environmentId, done.tokens?.sessionId as string)
    ).toMatchObject({ authMethods: ['pwd', 'otp', 'mfa'] })
  })

  test('a password and a backup code: pwd, backup_code, mfa', async () => {
    const userId = await seedUser()
    const { codes } = await enrol(userId)
    const attempt = await startSignIn()
    await password(attempt)
    expect(await amrOf(await second(attempt, 'backup_code', codes[3] as string))).toEqual([
      'pwd',
      'backup_code',
      'mfa',
    ])
  })

  test('an emailed code: email', async () => {
    configure({ emailCode: true })
    await seedUser()
    const attempt = await startSignIn()
    await Flows.prepareFirstFactor(deps, tenant, ref(attempt), { strategy: 'email_code' }, web)
    const done = await Flows.attemptFirstFactor(
      deps,
      tenant,
      ref(attempt),
      { strategy: 'email_code', code: sentCode() },
      web
    )
    expect(await amrOf(done)).toEqual(['email'])
  })

  test('a password sign-in that had to verify the email: pwd, email', async () => {
    await seedUser({ verified: false })
    const attempt = await startSignIn()
    expect((await password(attempt)).attempt.step.status).toBe('needs_email_verification')
    const done = await Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), sentCode(), web)
    expect(await amrOf(done)).toEqual(['pwd', 'email'])
  })

  test('an unverified user with a factor proves all three: pwd, email, otp, mfa', async () => {
    const userId = await seedUser({ verified: false })
    const { secret } = await enrol(userId)
    const attempt = await startSignIn()
    await password(attempt)
    const waiting = await Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), sentCode(), web)
    expect(waiting.attempt.step.status).toBe('needs_second_factor')
    await expectNoSession(waiting, userId)
    expect(await amrOf(await second(attempt, 'totp', codeFor(secret)))).toEqual([
      'pwd',
      'email',
      'otp',
      'mfa',
    ])
  })

  test('a sign-up and a password reset prove the inbox: email', async () => {
    const signedUp = await LAST_PROOF.sign_up()
    expect(await amrOf(signedUp.result)).toEqual(['email'])
    deps.clock.advance('2m')
    const { attempt } = await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)
    const reset = await Flows.resetPassword(
      deps,
      tenant,
      ref(attempt),
      { code: sentCode(), password: NEW_PASSWORD },
      web
    )
    expect(await amrOf(reset)).toEqual(['email'])
  })
})

describe('enrolment inside an attempt, where the environment requires a second factor', () => {
  beforeEach(() => configure({ policy: 'required' }))

  describe.each(KINDS)('%s', (kind) => {
    test('stops at needs_factor_enrolment: no tokens, no session row, no password hash kept', async () => {
      const { attempt, result, userId } = await LAST_PROOF[kind]()
      expect(result.attempt).toEqual({
        id: attempt.id,
        kind,
        expiresAt: expect.any(String),
        step: { status: 'needs_factor_enrolment', methods: ['totp'] },
      })
      await expectNoSession(result, userId)
      const record = await stored(attempt)
      expect(record).toMatchObject({ status: 'needs_factor_enrolment', userId, completedAt: null })
      expect(record?.state).not.toHaveProperty('passwordHash')
      expect(record?.state).not.toHaveProperty('secondFactors')
      expect(JSON.stringify(record)).not.toContain('$argon2')
    })

    test('start, a wrong code, then the right one completes with the backup codes, once', async () => {
      const { attempt, userId, first } = await LAST_PROOF[kind]()
      const enrolment = await startEnrolment(attempt, kind)
      expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/)
      expect(enrolment.uri).toContain(`secret=${enrolment.secret}`)
      // Started, not confirmed: still nothing to sign in with.
      expect(await liveSessions(userId)).toEqual([])
      expect(await Mfa.status(deps, tenant, userId)).toMatchObject({ totp: { enabled: false } })

      const wrong = await rejection(confirmEnrolment(attempt, '000000', kind))
      expect(wrong.toJSON()).toMatchObject({ status: 422, code: 'mfa.invalid_code' })
      expect(await liveSessions(userId)).toEqual([])
      expect(await stored(attempt)).toMatchObject({ status: 'needs_factor_enrolment' })

      const done = await confirmEnrolment(attempt, codeFor(enrolment.secret), kind)
      expect(done.attempt.step).toEqual({
        status: 'complete',
        userId,
        sessionId: done.tokens?.sessionId as string,
      })
      expect(done.attempt.backupCodes).toHaveLength(10)
      expect(new Set(done.attempt.backupCodes).size).toBe(10)
      expect(done.attempt).not.toHaveProperty('backupCodesRemaining')
      expect(done.client).toBe('web')
      expect(await amrOf(done)).toEqual([first, 'otp', 'mfa'])
      expect((await liveSessions(userId)).map((session) => session.id)).toEqual([
        done.tokens?.sessionId as string,
      ])
      expect(await Mfa.status(deps, tenant, userId)).toMatchObject({
        totp: { enabled: true },
        backupCodes: { remaining: 10 },
      })
      expect(deps.activityLog.ofType('user.mfa_enabled')).toEqual([
        expect.objectContaining({
          actor: { type: 'user', id: userId },
          ipAddress: '203.0.113.7',
          userAgent: 'Mozilla/5.0',
        }),
      ])
      // The codes are not stored on the attempt, and the attempt cannot be replayed for them.
      expect(JSON.stringify(await stored(attempt))).not.toContain(
        done.attempt.backupCodes?.[0] as string
      )
      expect(
        (await rejection(confirmEnrolment(attempt, codeFor(enrolment.secret), kind))).code
      ).toBe('flow.not_found')
      expect((await rejection(startEnrolment(attempt, kind))).code).toBe('flow.not_found')
    })

    test('the secret, the kind and the origin are checked before anything is stored or counted', async () => {
      const { attempt, userId } = await LAST_PROOF[kind]()
      const counted = spyOn(deps.lockout, 'attempt')
      const stores = spyOn(deps.factors, 'startTotp')
      spies.push(counted, stores)
      const otherKind = kind === 'sign_in' ? 'password_reset' : 'sign_in'
      const refusals: [() => Promise<unknown>, string][] = [
        [() => startEnrolment({ id: attempt.id }, kind), 'flow.not_found'],
        [
          () => startEnrolment({ id: attempt.id, attemptSecret: 'tula_at_made-up' }, kind),
          'flow.not_found',
        ],
        [() => startEnrolment(attempt, otherKind), 'flow.not_found'],
        [() => startEnrolment(attempt, kind, foreign), 'request.origin_not_allowed'],
        [() => confirmEnrolment({ id: attempt.id }, '123456', kind), 'flow.not_found'],
        [
          () =>
            confirmEnrolment({ id: attempt.id, attemptSecret: 'tula_at_made-up' }, '123456', kind),
          'flow.not_found',
        ],
        [() => confirmEnrolment(attempt, '123456', otherKind), 'flow.not_found'],
        [() => confirmEnrolment(attempt, '123456', kind, foreign), 'request.origin_not_allowed'],
        [
          () => Flows.startFactorEnrolment(deps, otherTenant, kind, ref(attempt), web),
          'flow.not_found',
        ],
      ]
      for (const [refused, code] of refusals) {
        expect((await rejection(refused())).code as string).toBe(code)
      }
      expect(counted).not.toHaveBeenCalled()
      expect(stores).not.toHaveBeenCalled()
      expect(await deps.factors.findTotp(tenant.environmentId, userId)).toBeNull()
    })

    test('the second-factor route does not accept an attempt that is waiting on an enrolment', async () => {
      if (kind === 'sign_up') {
        // A sign-up has no second-factor route at all.
        return
      }
      const { attempt, userId } = await LAST_PROOF[kind]()
      const counted = spyOn(deps.lockout, 'attempt')
      spies.push(counted)
      const err = await rejection(second(attempt, 'totp', '123456', kind))
      expect(err.toJSON()).toMatchObject({ status: 409, code: 'flow.invalid_step' })
      expect(counted).not.toHaveBeenCalled()
      expect(await liveSessions(userId)).toEqual([])
    })
  })

  test('confirming with nothing started is mfa.enrolment_expired, and the attempt stays open', async () => {
    const { attempt, userId } = await LAST_PROOF.sign_in()
    const err = await rejection(confirmEnrolment(attempt, '123456'))
    expect(err.toJSON()).toMatchObject({ status: 410, code: 'mfa.enrolment_expired' })
    expect(await liveSessions(userId)).toEqual([])
    const enrolment = await startEnrolment(attempt)
    expect((await confirmEnrolment(attempt, codeFor(enrolment.secret))).attempt.step.status).toBe(
      'complete'
    )
  })

  test('an enrolment that lapsed is mfa.enrolment_expired; starting again completes', async () => {
    const userId = await seedUser()
    // Started from a profile nine minutes before this sign-in: it lapses during the attempt.
    const early = await Mfa.startTotp(deps, tenant, userId)
    deps.clock.advance('9m')
    const attempt = await startSignIn()
    await password(attempt)
    deps.clock.advance('1m')
    const err = await rejection(confirmEnrolment(attempt, codeFor(early.secret)))
    expect(err.toJSON()).toMatchObject({ status: 410, code: 'mfa.enrolment_expired' })
    expect(await liveSessions(userId)).toEqual([])
    expect(await Mfa.status(deps, tenant, userId)).toMatchObject({ totp: { enabled: false } })

    const enrolment = await startEnrolment(attempt)
    const done = await confirmEnrolment(attempt, codeFor(enrolment.secret))
    expect(done.attempt.backupCodes).toHaveLength(10)
  })

  test('starting again replaces the secret: only the newest confirms', async () => {
    const { attempt } = await LAST_PROOF.sign_in()
    const first = await startEnrolment(attempt)
    const again = await startEnrolment(attempt)
    expect(again.secret).not.toBe(first.secret)
    expect((await rejection(confirmEnrolment(attempt, codeFor(first.secret)))).code).toBe(
      'mfa.invalid_code'
    )
    expect((await confirmEnrolment(attempt, codeFor(again.secret))).attempt.step.status).toBe(
      'complete'
    )
  })

  test('a user banned while enrolling is not signed in and gets no factor', async () => {
    const { attempt, userId } = await LAST_PROOF.sign_in()
    const enrolment = await startEnrolment(attempt)
    await deps.users.setBanned(tenant.environmentId, userId, deps.clock.now(), deps.clock.now())
    const err = await rejection(confirmEnrolment(attempt, codeFor(enrolment.secret)))
    expect(err.toJSON()).toMatchObject({ status: 403, code: 'auth.user_banned' })
    expect(await liveSessions(userId)).toEqual([])
    expect(await Mfa.status(deps, tenant, userId)).toMatchObject({ totp: { enabled: false } })
    expect(deps.activityLog.ofType('user.mfa_enabled')).toEqual([])
  })

  test('a user deleted while enrolling cannot start or confirm', async () => {
    const { attempt, userId } = await LAST_PROOF.sign_in()
    const enrolment = await startEnrolment(attempt)
    await deps.users.delete(tenant.environmentId, userId)
    expect(
      (await rejection(confirmEnrolment(attempt, codeFor(enrolment.secret)))).toJSON()
    ).toMatchObject({ status: 409, code: 'flow.invalid_step' })
    expect(await startEnrolment(attempt).catch((err) => err)).toBeInstanceOf(NotFoundError)
    expect(deps.activityLog.ofType('session.created')).toEqual([])
  })

  test('an attempt on that step with no user is not a step anyone can take', async () => {
    const secret = 'tula_at_seeded'
    const id = deps.ids.next()
    await deps.flowAttempts.create({
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      kind: 'sign_in',
      status: 'needs_factor_enrolment',
      userId: null,
      identifier: EMAIL,
      secretHash: sha256Hex(secret),
      state: { client: 'web' },
      expiresAt: new Date(deps.clock.now().getTime() + 600_000),
      createdAt: deps.clock.now(),
    })
    const presented = { id, attemptSecret: secret }
    expect((await rejection(startEnrolment(presented))).code).toBe('flow.invalid_step')
    expect((await rejection(confirmEnrolment(presented, '123456'))).code).toBe('flow.invalid_step')
  })

  test.each<[string, () => Promise<Presented>]>([
    ['the password step', async () => startSignIn()],
    [
      'the email verification step',
      async () => {
        const attempt = await startSignIn()
        await password(attempt)
        return attempt
      },
    ],
  ])('the enrolment routes refuse an attempt on %s', async (what, reach) => {
    await seedUser({ verified: what === 'the password step' })
    const attempt = await reach()
    const counted = spyOn(deps.lockout, 'attempt')
    const stores = spyOn(deps.factors, 'startTotp')
    spies.push(counted, stores)
    expect((await rejection(startEnrolment(attempt))).toJSON()).toMatchObject({
      status: 409,
      code: 'flow.invalid_step',
    })
    expect((await rejection(confirmEnrolment(attempt, '123456'))).code).toBe('flow.invalid_step')
    expect(counted).not.toHaveBeenCalled()
    expect(stores).not.toHaveBeenCalled()
  })

  test('the enrolment routes refuse an attempt waiting on a second factor', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    const attempt = await startSignIn()
    expect((await password(attempt)).attempt.step.status).toBe('needs_second_factor')
    expect((await rejection(startEnrolment(attempt))).code).toBe('flow.invalid_step')
    expect((await rejection(confirmEnrolment(attempt, codeFor(secret)))).code).toBe(
      'flow.invalid_step'
    )
    expect(await liveSessions(userId)).toEqual([])
  })

  test('an unverified user verifies the email first, then enrols', async () => {
    const userId = await seedUser({ verified: false })
    const attempt = await startSignIn()
    expect((await password(attempt)).attempt.step.status).toBe('needs_email_verification')
    const waiting = await Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), sentCode(), web)
    expect(waiting.attempt.step).toEqual({ status: 'needs_factor_enrolment', methods: ['totp'] })
    await expectNoSession(waiting, userId)
    const enrolment = await startEnrolment(attempt)
    const done = await confirmEnrolment(attempt, codeFor(enrolment.secret))
    expect(await amrOf(done)).toEqual(['pwd', 'email', 'otp', 'mfa'])
  })

  test('an emailed-code sign-in stops at the enrolment too', async () => {
    configure({ policy: 'required', emailCode: true })
    const userId = await seedUser()
    const attempt = await startSignIn()
    await Flows.prepareFirstFactor(deps, tenant, ref(attempt), { strategy: 'email_code' }, web)
    const waiting = await Flows.attemptFirstFactor(
      deps,
      tenant,
      ref(attempt),
      { strategy: 'email_code', code: sentCode() },
      web
    )
    expect(waiting.attempt.step).toEqual({ status: 'needs_factor_enrolment', methods: ['totp'] })
    await expectNoSession(waiting, userId)
    const enrolment = await startEnrolment(attempt)
    expect(await amrOf(await confirmEnrolment(attempt, codeFor(enrolment.secret)))).toEqual([
      'email',
      'otp',
      'mfa',
    ])
  })

  test('a sign-up without a password enrols before it completes', async () => {
    configure({ policy: 'required', emailCode: true, signUpPassword: 'optional' })
    const { attempt } = await Flows.signUp(deps, tenant, { email: EMAIL }, web)
    const waiting = await Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), sentCode(), web)
    expect(waiting.attempt.step.status).toBe('needs_factor_enrolment')
    expect(waiting.tokens).toBeUndefined()
    const enrolment = await startEnrolment(attempt, 'sign_up')
    const done = await confirmEnrolment(attempt, codeFor(enrolment.secret), 'sign_up')
    expect(await amrOf(done)).toEqual(['email', 'otp', 'mfa'])
  })

  test('a user who already has a factor is asked for it, not for an enrolment', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    const attempt = await startSignIn()
    expect((await password(attempt)).attempt.step.status).toBe('needs_second_factor')
    expect(await amrOf(await second(attempt, 'totp', codeFor(secret)))).toEqual([
      'pwd',
      'otp',
      'mfa',
    ])
  })

  test('the policy switched off mid-attempt: mfa.not_available, and nothing is stored', async () => {
    const { attempt, userId } = await LAST_PROOF.sign_in()
    configure({ policy: 'off' })
    const err = await rejection(startEnrolment(attempt))
    expect(err.toJSON()).toMatchObject({ status: 403, code: 'mfa.not_available' })
    expect(await deps.factors.findTotp(tenant.environmentId, userId)).toBeNull()
    expect(await liveSessions(userId)).toEqual([])
    // The attempt is where it was: a new sign-in is what completes now.
    expect(await stored(attempt)).toMatchObject({ status: 'needs_factor_enrolment' })
    expect((await password(await startSignIn())).attempt.step.status).toBe('complete')
  })

  test('the policy switched off after the enrolment started: the confirmation is refused, nothing is turned on', async () => {
    const { attempt, userId } = await LAST_PROOF.sign_in()
    const enrolment = await startEnrolment(attempt)
    configure({ policy: 'off' })
    const err = await rejection(confirmEnrolment(attempt, codeFor(enrolment.secret)))
    expect(err.toJSON()).toMatchObject({ status: 403, code: 'mfa.not_available' })
    expect(await Mfa.status(deps, tenant, userId)).toMatchObject({ totp: { enabled: false } })
    expect(await liveSessions(userId)).toEqual([])
  })

  test('the undo removes only the factor this request confirmed: another one, confirmed since, survives', async () => {
    const { attempt, userId } = await LAST_PROOF.sign_in()
    const enrolment = await startEnrolment(attempt)
    let later: { secret: string; codes: string[] } | undefined
    const create = deps.sessions.create.bind(deps.sessions)
    spies.push(
      spyOn(deps.sessions, 'create').mockImplementationOnce(async () => {
        // Between this request's confirmation and its failure, an administrator resets the
        // user and they enrol again: a different factor, which this request must not touch.
        await Mfa.reset(deps, tenant, userId, TEST_ACTOR)
        later = await enrol(userId)
        throw new Error('the database went away')
      })
    )
    await expect(confirmEnrolment(attempt, codeFor(enrolment.secret))).rejects.toThrow(
      'the database went away'
    )
    expect(create).toBeDefined()
    expect(later?.secret).not.toBe(enrolment.secret)
    expect(await Mfa.status(deps, tenant, userId)).toMatchObject({
      totp: { enabled: true },
      backupCodes: { remaining: 10 },
    })
    expect(await Mfa.verifyTotp(deps, tenant, userId, codeFor(later?.secret as string))).toBe(true)
    expect(
      deps.activityLog
        .ofType('user.mfa_disabled')
        .filter((entry) => entry.data.method === 'enrolment_incomplete')
    ).toEqual([])
  })

  test('a session that cannot be created undoes the enrolment: no factor is left whose codes were never shown', async () => {
    const { attempt, userId } = await LAST_PROOF.sign_in()
    const enrolment = await startEnrolment(attempt)
    spies.push(
      spyOn(deps.sessions, 'create').mockRejectedValueOnce(new Error('the database went away'))
    )
    await expect(confirmEnrolment(attempt, codeFor(enrolment.secret))).rejects.toThrow(
      'the database went away'
    )
    await Notices.settled()
    // Not on, no codes, and the owner was not told it was turned on.
    expect(await Mfa.status(deps, tenant, userId)).toEqual({
      totp: { enabled: false, confirmedAt: null },
      backupCodes: { remaining: 0 },
    })
    expect(await deps.factors.findTotp(tenant.environmentId, userId)).toBeNull()
    expect(deps.mailer.outbox.filter((mail) => mail.subject.includes('turned on'))).toEqual([])
    expect(deps.activityLog.ofType('user.mfa_disabled').at(-1)).toMatchObject({
      actor: { type: 'system', id: null },
      data: { method: 'enrolment_incomplete' },
    })
    expect(await liveSessions(userId)).toEqual([])
    // The way back in: a new sign-in enrols afresh and this time gets its codes.
    deps.clock.advance('30s')
    const again = await startSignIn()
    expect((await password(again)).attempt.step.status).toBe('needs_factor_enrolment')
    const fresh = await startEnrolment(again)
    expect(fresh.secret).not.toBe(enrolment.secret)
    const done = await confirmEnrolment(again, codeFor(fresh.secret))
    expect(done.attempt.backupCodes).toHaveLength(10)
  })

  test('an undo that fails too is logged and the first error still surfaces', async () => {
    const { attempt, userId } = await LAST_PROOF.sign_in()
    const enrolment = await startEnrolment(attempt)
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    spies.push(
      warn,
      spyOn(deps.sessions, 'create').mockRejectedValueOnce(new Error('the database went away')),
      spyOn(deps.factors, 'removeForUser').mockRejectedValueOnce(new Error('still away'))
    )
    await expect(confirmEnrolment(attempt, codeFor(enrolment.secret))).rejects.toThrow(
      'the database went away'
    )
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      'could not undo an enrolment whose attempt did not complete'
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain(enrolment.secret)
    // The documented last resort: the factor is on; the user signs in with it and makes codes.
    expect(await Mfa.status(deps, tenant, userId)).toMatchObject({ totp: { enabled: true } })
    deps.clock.advance('30s')
    const again = await startSignIn()
    expect((await password(again)).attempt.step.status).toBe('needs_second_factor')
    const done = await second(again, 'totp', codeFor(enrolment.secret))
    const { sub, sid } = await verifyAccessToken(deps, done.tokens?.accessToken as string, tenant)
    expect(
      (
        await Mfa.regenerateBackupCodes(deps, tenant, sub, {
          type: 'user',
          id: sub,
          ipAddress: null,
          userAgent: null,
        })
      ).codes
    ).toHaveLength(10)
    expect(sid).toBe(done.tokens?.sessionId as string)
  })

  test('two attempts of one user: the first to confirm wins, the other is told it is already on', async () => {
    const userId = await seedUser()
    const first = await startSignIn()
    await password(first)
    const other = await startSignIn()
    await password(other)
    const enrolment = await startEnrolment(first)
    expect((await confirmEnrolment(first, codeFor(enrolment.secret))).attempt.step.status).toBe(
      'complete'
    )
    // One at a time: a promise that rejects before it is awaited is an unhandled rejection.
    for (const refused of [
      () => startEnrolment(other),
      () => confirmEnrolment(other, codeFor(enrolment.secret)),
    ]) {
      expect((await rejection(refused())).toJSON()).toMatchObject({
        status: 409,
        code: 'mfa.already_enabled',
      })
    }
    expect(await liveSessions(userId)).toHaveLength(1)
    expect(deps.activityLog.ofType('user.mfa_enabled')).toHaveLength(1)
  })

  test('of two concurrent confirmations of one attempt exactly one completes', async () => {
    const { attempt, userId } = await LAST_PROOF.sign_in()
    const enrolment = await startEnrolment(attempt)
    const code = codeFor(enrolment.secret)
    const results = await Promise.allSettled([
      confirmEnrolment(attempt, code),
      confirmEnrolment(attempt, code),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await liveSessions(userId)).toHaveLength(1)
    expect(await deps.factors.countBackupCodes(tenant.environmentId, userId)).toBe(10)
    expect(deps.activityLog.ofType('user.mfa_enabled')).toHaveLength(1)
  })

  test('wrong confirmation codes lock the user out, even for the right code', async () => {
    const { attempt, userId } = await LAST_PROOF.sign_in()
    const enrolment = await startEnrolment(attempt)
    for (let index = 0; index <= CREDENTIAL_LOCKOUT.freeAttempts; index++) {
      expect((await rejection(confirmEnrolment(attempt, '000000'))).code).toBe('mfa.invalid_code')
    }
    expect(
      await confirmEnrolment(attempt, codeFor(enrolment.secret)).catch((err) => err)
    ).toBeInstanceOf(RateLimitError)
    expect(await liveSessions(userId)).toEqual([])
    deps.clock.advance('31s')
    expect((await confirmEnrolment(attempt, codeFor(enrolment.secret))).attempt.step.status).toBe(
      'complete'
    )
  })

  test('sessions the user had before the policy are ended when the factor is turned on', async () => {
    configure({ policy: 'optional' })
    const userId = await seedUser()
    const before = await Sessions.create(deps, tenant, {
      userId,
      client: 'web',
      authMethods: ['pwd'],
    })
    configure({ policy: 'required' })
    const attempt = await startSignIn()
    await password(attempt)
    const enrolment = await startEnrolment(attempt)
    const done = await confirmEnrolment(attempt, codeFor(enrolment.secret))
    expect((await liveSessions(userId)).map((session) => session.id)).toEqual([
      done.tokens?.sessionId as string,
    ])
    expect(await deps.revokedSessions.has(before.sessionId, deps.clock.now())).toBe(true)
  })

  test('the environment’s ceiling applies to the enrolment steps', async () => {
    const { attempt } = await LAST_PROOF.sign_in()
    spies.push(
      spyOn(deps.rateLimiter, 'hit').mockResolvedValue({
        allowed: false,
        remaining: 0,
        retryAfterMs: 1_000,
      })
    )
    expect(await startEnrolment(attempt).catch((err) => err)).toBeInstanceOf(RateLimitError)
    expect(await confirmEnrolment(attempt, '123456').catch((err) => err)).toBeInstanceOf(
      RateLimitError
    )
  })
})

describe('a sign-in racing an enrolment', () => {
  test('a first factor accepted before the user turned two-step verification on yields no session without it', async () => {
    const userId = await seedUser()
    const attempt = await startSignIn()
    const create = deps.sessions.create.bind(deps.sessions)
    spies.push(
      // The user confirms an authenticator elsewhere after this sign-in was told "no second
      // factor needed" and before its session is stored: the confirmation's sweep of "every
      // other session" cannot see a session that does not exist yet.
      spyOn(deps.sessions, 'create').mockImplementationOnce(async (...args) => {
        await enrol(userId)
        return create(...args)
      })
    )
    const err = await rejection(password(attempt))
    expect(err.toJSON()).toMatchObject({ status: 409, code: 'flow.invalid_step' })
    // No session that never proved the factor survives, and its access token is refused.
    expect(await liveSessions(userId)).toEqual([])
    const [created] = deps.activityLog.ofType('session.created').slice(-1)
    const sessionId = created?.target.id as string
    expect(await deps.sessions.findById(tenant.environmentId, sessionId)).toMatchObject({
      revokeReason: 'mfa_changed',
    })
    expect(await deps.revokedSessions.has(sessionId, deps.clock.now())).toBe(true)
    await Notices.settled()
    expect(deps.mailer.outbox.filter((mail) => mail.subject.startsWith('New sign-in'))).toEqual([])
    // Starting again asks for the factor.
    expect((await password(await startSignIn())).attempt.step.status).toBe('needs_second_factor')
  })

  test('a sign-in that proved the factor is not asked twice', async () => {
    const userId = await seedUser()
    const { secret } = await enrol(userId)
    const attempt = await startSignIn()
    await password(attempt)
    const required = spyOn(Factors, 'requiredFor')
    spies.push(required)
    const done = await second(attempt, 'totp', codeFor(secret))
    expect(done.tokens?.accessToken).toBeString()
    expect(required).not.toHaveBeenCalled()
  })
})

describe('where a second factor is optional or off', () => {
  test.each<[EnvironmentSettings['mfa']['policy']]>([['optional'], ['off']])(
    '%s: no attempt asks for an enrolment',
    async (value) => {
      configure({ policy: value })
      const signedUp = await LAST_PROOF.sign_up()
      expect(signedUp.result.attempt.step.status).toBe('complete')
      const done = await password(await startSignIn())
      expect(done.attempt.step.status).toBe('complete')
      expect(done.attempt).not.toHaveProperty('backupCodes')
      // The enrolment routes have nothing to act on.
      const open = await startSignIn()
      expect((await rejection(startEnrolment(open))).code).toBe('flow.invalid_step')
    }
  )
})
