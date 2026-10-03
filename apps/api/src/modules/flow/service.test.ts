import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, type FlowAttempt } from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { RateLimitError, ServiceException } from '~/exceptions'
import { verifyAccessToken } from '~/middleware/session-auth'
import * as Flows from '~/modules/flow/service'
import * as Passwords from '~/modules/password/service'
import * as Verification from '~/modules/verification/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const EMAIL = 'Maya@Northline.app'
const NORMALIZED = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const web: Flows.ClientContext = {
  client: 'web',
  userAgent: 'Mozilla/5.0',
  ipAddress: '203.0.113.7',
}
const ios: Flows.ClientContext = { client: 'ios', userAgent: 'TulaSDK/1 iOS', ipAddress: null }
let deps: TestDeps

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
}

beforeEach(() => build())

let spy: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  spy?.mockRestore()
  spy = undefined
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

/** The 6-digit code in the most recent email. */
function sentCode(): string {
  const code = /\b(\d{6})\b/.exec(deps.mailer.last().text)?.[1]
  if (!code) {
    throw new Error('no code in the last email')
  }
  return code
}
const wrong = (code: string) => (code === '000000' ? '000001' : '000000')

const signUp = (overrides: Partial<Parameters<typeof Flows.signUp>[2]> = {}, ctx = web) =>
  Flows.signUp(deps, tenant, { email: EMAIL, password: PASSWORD, ...overrides }, ctx)

/** Create a verified user through the real sign-up flow. */
async function registered(email = EMAIL, password = PASSWORD) {
  const started = await signUp({ email, password, firstName: 'Maya', lastName: 'Okafor' })
  const done = await Flows.verifyEmail(deps, tenant, 'sign_up', started.attempt.id, sentCode(), web)
  // Let later sign-ups / resends for the same address past the send cooldown.
  deps.clock.advance(Verification.RESEND_COOLDOWN)
  if (done.attempt.step.status !== 'complete') {
    throw new Error('sign-up did not complete')
  }
  return { userId: done.attempt.step.userId, tokens: done.tokens }
}

/** Seed a user directly, e.g. one created by an admin with an unverified email. */
async function seedUser(options: { verified?: boolean; passwordHash?: string } = {}) {
  const id = deps.ids.next()
  await deps.users.createWithPassword({
    id,
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    email: EMAIL,
    emailNormalized: NORMALIZED,
    emailVerifiedAt: options.verified === false ? null : deps.clock.now(),
    firstName: null,
    lastName: null,
    createdAt: deps.clock.now(),
    identityId: deps.ids.next(),
    credentialId: deps.ids.next(),
    passwordHash: options.passwordHash ?? (await Passwords.hash(PASSWORD)),
  })
  return id
}

async function startSignIn(identifier = EMAIL, ctx = web) {
  return (await Flows.signIn(deps, tenant, { identifier }, ctx)).attempt
}
const password = (attemptId: string, value = PASSWORD, ctx = web, t = tenant) =>
  Flows.submitPassword(deps, t, attemptId, value, ctx)

/** An attempt with its id and expiry blanked, for comparing two responses. */
const shape = (attempt: FlowAttempt) => ({ ...attempt, id: 'id', expiresAt: 'at' })

describe('signUp', () => {
  test('asks for email verification, emails a code and creates no user yet', async () => {
    const { attempt, tokens } = await signUp({ firstName: 'Maya' })
    expect(attempt).toEqual({
      id: expect.any(String),
      kind: 'sign_up',
      expiresAt: new Date(deps.clock.now().getTime() + 10 * 60_000).toISOString(),
      step: {
        status: 'needs_email_verification',
        destination: 'M***@Northline.app',
        strategies: ['email_code'],
      },
    })
    expect(tokens).toBeUndefined()
    expect(deps.mailer.last().to).toBe(EMAIL)
    expect(sentCode()).toMatch(/^\d{6}$/)
    expect(await deps.users.findByEmail(tenant.environmentId, NORMALIZED)).toBeNull()
  })

  test('keeps the pending password only as an argon2id hash', async () => {
    const { attempt } = await signUp()
    const stored = await deps.flowAttempts.findById(tenant.environmentId, attempt.id)
    expect(JSON.stringify(stored)).not.toContain(PASSWORD)
    expect(String(stored?.state.passwordHash).startsWith('$argon2id$')).toBe(true)
    expect(stored?.identifier).toBe(NORMALIZED)
  })

  test.each(['not-an-email', 'maya@', '@northline.app', ''])(
    'rejects the email %p with a field error and stores nothing',
    async (email) => {
      const err = await rejection(signUp({ email }))
      expect(err.status).toBe(422)
      expect(err.code).toBe('email.invalid')
      expect(err.errors).toEqual([
        { field: 'email', code: 'email.invalid', message: expect.any(String) },
      ])
      expect(deps.mailer.outbox).toHaveLength(0)
    }
  )

  test('explains exactly which password rules failed', async () => {
    const err = await rejection(signUp({ password: 'short' }))
    expect(err.code).toBe('password.too_short')
    expect(err.errors?.[0]).toMatchObject({ field: 'password', code: 'password.too_short' })
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('refuses a password containing the user’s own details', async () => {
    const err = await rejection(signUp({ password: 'northline-maya-okafor', lastName: 'Okafor' }))
    expect(err.code).toBe('password.contains_user_info')
  })

  describe('when the email already has an account', () => {
    test('answers exactly as for a new email, so sign-up cannot enumerate accounts', async () => {
      const fresh = await signUp({ email: 'new@northline.app' })
      await registered()
      const taken = await signUp()
      expect(shape(taken.attempt)).toEqual({
        ...shape(fresh.attempt),
        step: { ...fresh.attempt.step, destination: 'M***@Northline.app' },
      } as never)
      expect(taken.tokens).toBeUndefined()
    })

    test('emails the owner a notice instead of a code, and creates nothing', async () => {
      const { userId } = await registered()
      const before = deps.mailer.outbox.length
      await signUp({ password: 'a completely different passphrase' })
      expect(deps.mailer.outbox).toHaveLength(before + 1)
      const notice = deps.mailer.last()
      expect(notice.to).toBe(EMAIL)
      expect(notice.subject.toLowerCase()).toContain('already')
      expect(`${notice.subject} ${notice.text} ${notice.html}`).not.toMatch(/\d{6}/)
      // The existing account and its password are untouched.
      const found = await deps.users.findByEmailWithPassword(tenant.environmentId, NORMALIZED)
      expect(found?.user.id).toBe(userId)
      expect(await Passwords.verify(found?.passwordHash ?? null, PASSWORD)).toBe(true)
    })

    test('does the same password hashing work as for a new email', async () => {
      await registered()
      spy = spyOn(Bun.password, 'hash')
      await signUp()
      expect(spy).toHaveBeenCalledTimes(1)
    })

    test('code guesses behave like a real attempt, and can never complete it', async () => {
      await registered()
      const { attempt } = await signUp()
      const err = await rejection(
        Flows.verifyEmail(deps, tenant, 'sign_up', attempt.id, '123456', web)
      )
      expect(err.code).toBe('verification.invalid_code')
      expect(err.params).toEqual({ attemptsRemaining: Verification.MAX_ATTEMPTS - 1 })
    })

    test('even a correctly guessed decoy code grants nothing', async () => {
      // Make every code "match" so the guess succeeds.
      build({ keyedHash: { hmac: async () => 'same' } })
      const { userId } = await registered()
      const { attempt } = await signUp()
      const sessionsBefore = (
        await deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
      ).length
      const err = await rejection(
        Flows.verifyEmail(deps, tenant, 'sign_up', attempt.id, '123456', web)
      )
      expect(err.code).toBe('verification.invalid_code')
      expect(
        await deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
      ).toHaveLength(sessionsBefore)
      expect((await deps.flowAttempts.findById(tenant.environmentId, attempt.id))?.status).toBe(
        'needs_email_verification'
      )
    })
  })

  test('a refused send leaves no attempt (and no password hash) behind', async () => {
    const create = spyOn(deps.flowAttempts, 'create')
    await signUp()
    expect(await signUp().catch((err) => err)).toBeInstanceOf(RateLimitError)
    deps.mailer.failing = true
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    expect((await rejection(signUp())).status).toBe(500)

    expect(create).toHaveBeenCalledTimes(3)
    const ids = create.mock.calls.map(([attempt]) => attempt.id)
    const stored = await Promise.all(
      ids.map((id) => deps.flowAttempts.findById(tenant.environmentId, id))
    )
    // Only the first, successful sign-up still has a row.
    expect(stored.map((attempt) => attempt !== null)).toEqual([true, false, false])
    create.mockRestore()
  })

  test('is limited per address for new and existing emails alike', async () => {
    await signUp()
    expect(await signUp().catch((err) => err)).toBeInstanceOf(RateLimitError)
    build()
    await registered()
    await signUp()
    expect(await signUp().catch((err) => err)).toBeInstanceOf(RateLimitError)
  })
})

describe('verifyEmail (sign-up)', () => {
  const verify = (id: string, code: string, ctx = web, t = tenant) =>
    Flows.verifyEmail(deps, t, 'sign_up', id, code, ctx)

  test('creates the verified user, signs them in and completes the attempt', async () => {
    const { attempt } = await signUp({ firstName: ' Maya ', lastName: 'Okafor' }, ios)
    const done = await verify(attempt.id, sentCode(), ios)

    const found = await deps.users.findByEmailWithPassword(tenant.environmentId, NORMALIZED)
    expect(found?.user).toMatchObject({
      email: EMAIL,
      emailNormalized: NORMALIZED,
      emailVerifiedAt: deps.clock.now(),
      firstName: 'Maya',
      lastName: 'Okafor',
      lastSignInAt: deps.clock.now(),
    })
    expect(await Passwords.verify(found?.passwordHash ?? null, PASSWORD)).toBe(true)

    expect(done.client).toBe('ios')
    expect(done.attempt.step).toEqual({
      status: 'complete',
      userId: found?.user.id ?? '',
      sessionId: done.tokens?.sessionId ?? '',
    })
    const claims = await verifyAccessToken(deps, done.tokens?.accessToken ?? '', tenant)
    expect(claims.sub).toBe(found?.user.id ?? '')
    expect(done.tokens?.refreshToken).toBeString()
    expect(await deps.sessions.findById(tenant.environmentId, claims.sid)).toMatchObject({
      client: 'ios',
      userAgent: 'TulaSDK/1 iOS',
    })
  })

  test('drops the pending password hash from the attempt once it is used', async () => {
    const { attempt } = await signUp()
    await verify(attempt.id, sentCode())
    const stored = await deps.flowAttempts.findById(tenant.environmentId, attempt.id)
    expect(stored).toMatchObject({ status: 'complete', completedAt: deps.clock.now() })
    expect(stored?.state).toEqual({ client: 'web' })
  })

  test('a failure to record the sign-in time does not discard the issued tokens', async () => {
    const { attempt } = await signUp()
    spy = spyOn(deps.users, 'recordSignIn').mockRejectedValue(new Error('database unavailable'))
    const done = await verify(attempt.id, sentCode())
    expect(done.attempt.step.status).toBe('complete')
    await verifyAccessToken(deps, done.tokens?.accessToken ?? '', tenant)
  })

  test('a wrong code leaves the attempt open for the right one', async () => {
    const { attempt } = await signUp()
    const code = sentCode()
    const err = await rejection(verify(attempt.id, wrong(code)))
    expect(err.code).toBe('verification.invalid_code')
    expect(await deps.users.findByEmail(tenant.environmentId, NORMALIZED)).toBeNull()
    expect((await verify(attempt.id, code)).attempt.step.status).toBe('complete')
  })

  test('a completed attempt cannot be replayed', async () => {
    const { attempt } = await signUp()
    const code = sentCode()
    await verify(attempt.id, code)
    const err = await rejection(verify(attempt.id, code))
    expect(err.status).toBe(404)
    expect(err.code).toBe('flow.not_found')
  })

  test('an attempt expires after 10 minutes', async () => {
    const { attempt } = await signUp()
    const code = sentCode()
    deps.clock.advance('10m')
    expect((await rejection(verify(attempt.id, code))).code).toBe('flow.not_found')
    expect(await deps.users.findByEmail(tenant.environmentId, NORMALIZED)).toBeNull()
  })

  test.each([
    ['an unknown attempt', () => verify('00000000-0000-7000-8000-00000000dead', '123456')],
    [
      'another environment',
      async () => verify((await signUp()).attempt.id, sentCode(), web, otherTenant),
    ],
    ['a sign-in attempt', async () => verify((await startSignIn()).id, '123456')],
  ])('answers flow.not_found for %s', async (_name, attempt) => {
    expect((await rejection(attempt())).code).toBe('flow.not_found')
  })

  test('when two sign-ups for one email are both verified, only the first creates the account', async () => {
    const first = await signUp()
    const firstCode = sentCode()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const second = await signUp({ password: 'a completely different passphrase' })
    const secondCode = sentCode()

    await verify(first.attempt.id, firstCode)
    const err = await rejection(verify(second.attempt.id, secondCode))
    expect(err.status).toBe(409)
    expect(err.code).toBe('flow.invalid_step')
    // The account keeps the first password.
    const found = await deps.users.findByEmailWithPassword(tenant.environmentId, NORMALIZED)
    expect(await Passwords.verify(found?.passwordHash ?? null, PASSWORD)).toBe(true)
  })
})

describe('signIn', () => {
  test('always asks for a password, without looking the identifier up', async () => {
    await registered()
    const lookups = [spyOn(deps.users, 'findByEmail'), spyOn(deps.users, 'findByEmailWithPassword')]
    const known = await startSignIn(EMAIL)
    const unknown = await startSignIn('nobody@northline.app')
    const nonsense = await startSignIn('not even an email')
    for (const attempt of [known, unknown, nonsense]) {
      expect(shape(attempt)).toEqual({
        id: 'id',
        kind: 'sign_in',
        expiresAt: 'at',
        step: { status: 'needs_password' },
      })
    }
    for (const lookup of lookups) {
      expect(lookup).not.toHaveBeenCalled()
    }
  })
})

describe('submitPassword', () => {
  test('signs a verified user in', async () => {
    const { userId } = await registered()
    deps.clock.advance('1h')
    const attempt = await startSignIn(' MAYA@northline.APP ', ios)
    const done = await password(attempt.id, PASSWORD, ios)

    expect(done.attempt).toMatchObject({
      id: attempt.id,
      kind: 'sign_in',
      step: { status: 'complete', userId, sessionId: done.tokens?.sessionId },
    })
    expect(done.client).toBe('ios')
    await verifyAccessToken(deps, done.tokens?.accessToken ?? '', tenant)
    expect((await deps.users.findById(tenant.environmentId, userId))?.lastSignInAt).toEqual(
      deps.clock.now()
    )
    expect(await deps.flowAttempts.findById(tenant.environmentId, attempt.id)).toMatchObject({
      status: 'complete',
      userId,
      completedAt: deps.clock.now(),
    })
  })

  test('a wrong password is a generic failure and the attempt can be retried', async () => {
    await registered()
    const attempt = await startSignIn()
    const err = await rejection(password(attempt.id, 'not the password'))
    expect(err.status).toBe(401)
    expect(err.code).toBe('auth.invalid_credentials')
    expect(err.params).toBeUndefined()
    expect((await password(attempt.id)).attempt.step.status).toBe('complete')
  })

  test('an unknown user fails identically and still costs one argon2id verify', async () => {
    const known = await (async () => {
      await registered()
      return rejection(password((await startSignIn()).id, 'not the password'))
    })()
    spy = spyOn(Bun.password, 'verify')
    const unknown = await rejection(password((await startSignIn('nobody@northline.app')).id))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(unknown.toJSON()).toEqual(known.toJSON())
  })

  test('a banned user learns it only with the right password', async () => {
    const { userId } = await registered()
    await deps.users.setBanned(tenant.environmentId, userId, deps.clock.now(), deps.clock.now())
    const wrongPassword = await rejection(password((await startSignIn()).id, 'not the password'))
    expect(wrongPassword.code).toBe('auth.invalid_credentials')
    const banned = await rejection(password((await startSignIn()).id))
    expect(banned.status).toBe(403)
    expect(banned.code).toBe('auth.user_banned')
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
    ).toHaveLength(1)
  })

  test('an account in another environment does not exist here', async () => {
    await registered()
    const attempt = (await Flows.signIn(deps, otherTenant, { identifier: EMAIL }, web)).attempt
    expect((await rejection(password(attempt.id, PASSWORD, web, otherTenant))).code).toBe(
      'auth.invalid_credentials'
    )
    // And an attempt started in one environment is unknown in the other.
    const here = await startSignIn()
    expect((await rejection(password(here.id, PASSWORD, web, otherTenant))).code).toBe(
      'flow.not_found'
    )
  })

  test('after the free tries, each failure makes the identifier wait longer', async () => {
    await registered()
    const attempt = await startSignIn()
    const guess = () => rejection(password(attempt.id, 'not the password'))
    for (let i = 0; i < CREDENTIAL_LOCKOUT.freeAttempts; i++) {
      expect((await guess()).code).toBe('auth.invalid_credentials')
    }
    // The next failure is still answered, and starts the first wait.
    expect((await guess()).code).toBe('auth.invalid_credentials')
    const locked = await rejection(password(attempt.id))
    expect(locked).toBeInstanceOf(RateLimitError)
    expect(locked.params).toEqual({ retryAfter: 30 })

    // A fresh attempt for the same identifier is locked too; another identifier is not.
    expect(await rejection(password((await startSignIn()).id))).toBeInstanceOf(RateLimitError)
    expect((await rejection(password((await startSignIn('other@northline.app')).id))).code).toBe(
      'auth.invalid_credentials'
    )

    deps.clock.advance('30s')
    expect((await guess()).code).toBe('auth.invalid_credentials')
    expect((await rejection(password(attempt.id))).params).toEqual({ retryAfter: 60 })
    deps.clock.advance('60s')
    expect((await password(attempt.id)).attempt.step.status).toBe('complete')
  })

  test('a successful sign-in clears the failures', async () => {
    await registered()
    for (let round = 0; round < 3; round++) {
      const attempt = await startSignIn()
      for (let i = 0; i < CREDENTIAL_LOCKOUT.freeAttempts - 1; i++) {
        expect((await rejection(password(attempt.id, 'not the password'))).code).toBe(
          'auth.invalid_credentials'
        )
      }
      expect((await password(attempt.id)).attempt.step.status).toBe('complete')
    }
  })

  test('parallel guesses cannot exceed the free tries plus one', async () => {
    await registered()
    const attempt = await startSignIn()
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rejection(password(attempt.id, 'not the password')))
    )
    expect(results.filter((err) => err.code === 'auth.invalid_credentials')).toHaveLength(
      CREDENTIAL_LOCKOUT.freeAttempts + 1
    )
    expect(results.filter((err) => err instanceof RateLimitError)).toHaveLength(
      20 - CREDENTIAL_LOCKOUT.freeAttempts - 1
    )
  })

  test('unknown identifiers are locked out the same way, so lockout reveals nothing', async () => {
    const attempt = await startSignIn('nobody@northline.app')
    for (let i = 0; i <= CREDENTIAL_LOCKOUT.freeAttempts; i++) {
      expect((await rejection(password(attempt.id))).code).toBe('auth.invalid_credentials')
    }
    expect(await rejection(password(attempt.id))).toBeInstanceOf(RateLimitError)
  })

  test('upgrades a hash made with weaker parameters after a successful sign-in', async () => {
    const weak = await Bun.password.hash(PASSWORD, {
      algorithm: 'argon2id',
      memoryCost: 8,
      timeCost: 1,
    })
    expect(Passwords.needsRehash(weak)).toBe(true)
    await seedUser({ passwordHash: weak })
    await password((await startSignIn()).id)
    const found = await deps.users.findByEmailWithPassword(tenant.environmentId, NORMALIZED)
    expect(Passwords.needsRehash(found?.passwordHash ?? '')).toBe(false)
    expect(await Passwords.verify(found?.passwordHash ?? null, PASSWORD)).toBe(true)
  })

  test('an unverified user must verify their email before the sign-in completes', async () => {
    const userId = await seedUser({ verified: false })
    const attempt = await startSignIn()
    const pending = await password(attempt.id)
    expect(pending.tokens).toBeUndefined()
    expect(pending.attempt.step).toEqual({
      status: 'needs_email_verification',
      destination: 'M***@Northline.app',
      strategies: ['email_code'],
    })
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
    ).toHaveLength(0)

    // The password step is done; it can't be replayed, and sign-up's route can't finish it.
    expect((await rejection(password(attempt.id))).code).toBe('flow.invalid_step')
    expect(
      (await rejection(Flows.verifyEmail(deps, tenant, 'sign_up', attempt.id, sentCode(), web)))
        .code
    ).toBe('flow.not_found')

    const done = await Flows.verifyEmail(deps, tenant, 'sign_in', attempt.id, sentCode(), web)
    expect(done.attempt.step).toMatchObject({ status: 'complete', userId })
    expect((await deps.users.findById(tenant.environmentId, userId))?.emailVerifiedAt).toEqual(
      deps.clock.now()
    )
  })

  test('if the code cannot be sent, the password step stays retryable', async () => {
    const userId = await seedUser({ verified: false })
    // Someone else just triggered an email to this address, so the cooldown is spent.
    await Verification.issue(deps, tenant, {
      purpose: 'password_reset',
      destination: EMAIL,
      userId,
    })
    const attempt = await startSignIn()
    expect(await password(attempt.id).catch((err) => err)).toBeInstanceOf(RateLimitError)
    expect((await deps.flowAttempts.findById(tenant.environmentId, attempt.id))?.status).toBe(
      'needs_password'
    )

    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const pending = await password(attempt.id)
    expect(pending.attempt.step.status).toBe('needs_email_verification')
    const done = await Flows.verifyEmail(deps, tenant, 'sign_in', attempt.id, sentCode(), web)
    expect(done.attempt.step.status).toBe('complete')
  })

  test('a user banned while verifying their email is not signed in', async () => {
    const userId = await seedUser({ verified: false })
    const attempt = await startSignIn()
    await password(attempt.id)
    await deps.users.setBanned(tenant.environmentId, userId, deps.clock.now(), deps.clock.now())
    const err = await rejection(
      Flows.verifyEmail(deps, tenant, 'sign_in', attempt.id, sentCode(), web)
    )
    expect(err.code).toBe('auth.user_banned')
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
    ).toHaveLength(0)
  })

  test('verifying an email before the password step is refused', async () => {
    await registered()
    const attempt = await startSignIn()
    const err = await rejection(
      Flows.verifyEmail(deps, tenant, 'sign_in', attempt.id, '123456', web)
    )
    expect(err.code).toBe('flow.invalid_step')
  })

  test('a completed or expired attempt is gone', async () => {
    await registered()
    const done = await startSignIn()
    await password(done.id)
    expect((await rejection(password(done.id))).code).toBe('flow.not_found')
    const stale = await startSignIn()
    deps.clock.advance('10m')
    expect((await rejection(password(stale.id))).code).toBe('flow.not_found')
  })

  test('two concurrent correct submissions create one session', async () => {
    const { userId } = await registered()
    const attempt = await startSignIn()
    const results = await Promise.allSettled([password(attempt.id), password(attempt.id)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    // One from sign-up, one from this sign-in.
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
    ).toHaveLength(2)
  })
})

describe('resendVerification', () => {
  test('sends a fresh sign-up code after the cooldown and retires the old one', async () => {
    const { attempt } = await signUp()
    const first = sentCode()
    expect(
      await Flows.resendCode(deps, tenant, 'sign_up', attempt.id).catch((err) => err)
    ).toBeInstanceOf(RateLimitError)

    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const resent = await Flows.resendCode(deps, tenant, 'sign_up', attempt.id)
    expect(resent.attempt.step).toEqual(attempt.step)
    const second = sentCode()
    if (first !== second) {
      expect(
        (await rejection(Flows.verifyEmail(deps, tenant, 'sign_up', attempt.id, first, web))).code
      ).toBe('verification.invalid_code')
    }
    expect(
      (await Flows.verifyEmail(deps, tenant, 'sign_up', attempt.id, second, web)).attempt.step
        .status
    ).toBe('complete')
  })

  test('for an existing account it resends the notice, never a code', async () => {
    await registered()
    const { attempt } = await signUp()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await Flows.resendCode(deps, tenant, 'sign_up', attempt.id)
    expect(deps.mailer.last().subject.toLowerCase()).toContain('already')
    expect(deps.mailer.last().text).not.toMatch(/\d{6}/)
  })

  test('resends to the user’s address during an unverified sign-in', async () => {
    await seedUser({ verified: false })
    const attempt = await startSignIn()
    await password(attempt.id)
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await Flows.resendCode(deps, tenant, 'sign_in', attempt.id)
    expect(deps.mailer.last().to).toBe(EMAIL)
    const done = await Flows.verifyEmail(deps, tenant, 'sign_in', attempt.id, sentCode(), web)
    expect(done.attempt.step.status).toBe('complete')
  })

  test('is refused when the attempt is not waiting on email verification', async () => {
    const attempt = await startSignIn()
    const err = await rejection(Flows.resendCode(deps, tenant, 'sign_in', attempt.id))
    expect(err.code).toBe('flow.invalid_step')
    expect((await rejection(Flows.resendCode(deps, tenant, 'sign_up', attempt.id))).code).toBe(
      'flow.not_found'
    )
  })
})

describe('per-environment ceilings', () => {
  test('sign-ups are capped per environment across all callers', async () => {
    // Hashing 600 passwords for real would take most of a minute.
    spy = spyOn(Bun.password, 'hash').mockResolvedValue(
      '$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA'
    )
    for (let i = 0; i < Flows.ENVIRONMENT_RATE_LIMITS.signUp; i++) {
      await signUp({ email: `user-${i}@northline.app` })
    }
    const err = await rejection(signUp({ email: 'one-too-many@northline.app' }))
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.params?.retryAfter).toBeGreaterThan(0)
    // Another environment has its own ceiling.
    const other = await Flows.signUp(
      deps,
      otherTenant,
      { email: 'elsewhere@northline.app', password: PASSWORD },
      web
    )
    expect(other.attempt.step.status).toBe('needs_email_verification')
  })

  test('requests that never reach the expensive step do not use the ceiling up', async () => {
    await registered()
    const junk = Math.max(
      Flows.ENVIRONMENT_RATE_LIMITS.signUp,
      Flows.ENVIRONMENT_RATE_LIMITS.password,
      Flows.ENVIRONMENT_RATE_LIMITS.verify
    )
    for (let i = 0; i <= junk; i++) {
      const missing = `00000000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`
      await rejection(signUp({ email: 'not-an-email' }))
      await rejection(password(missing))
      await rejection(Flows.verifyEmail(deps, tenant, 'sign_up', missing, '123456', web))
      await rejection(Flows.resendCode(deps, tenant, 'sign_up', missing))
    }
    // Real requests still go through.
    expect((await password((await startSignIn()).id)).attempt.step.status).toBe('complete')
    const started = await signUp({ email: 'real@northline.app' })
    const done = await Flows.verifyEmail(
      deps,
      tenant,
      'sign_up',
      started.attempt.id,
      sentCode(),
      web
    )
    expect(done.attempt.step.status).toBe('complete')
  })

  test('refused tries on a locked-out identifier do not use the ceiling up', async () => {
    await registered()
    const locked = await startSignIn('victim@northline.app')
    for (let i = 0; i <= CREDENTIAL_LOCKOUT.freeAttempts; i++) {
      await rejection(password(locked.id, 'not the password'))
    }
    for (let i = 0; i <= Flows.ENVIRONMENT_RATE_LIMITS.password; i++) {
      expect(await rejection(password(locked.id))).toBeInstanceOf(RateLimitError)
    }
    // Everyone else in the environment can still sign in.
    expect((await password((await startSignIn()).id)).attempt.step.status).toBe('complete')
  })

  test('resends refused by the address cooldown do not use the ceiling up', async () => {
    const { attempt } = await signUp()
    for (let i = 0; i <= Flows.ENVIRONMENT_RATE_LIMITS.signUp; i++) {
      expect(
        await Flows.resendCode(deps, tenant, 'sign_up', attempt.id).catch((err) => err)
      ).toBeInstanceOf(RateLimitError)
    }
    const other = await signUp({ email: 'someone-else@northline.app' })
    expect(other.attempt.step.status).toBe('needs_email_verification')
  })

  test('password submissions are capped per environment', async () => {
    const attempt = await startSignIn('nobody@northline.app')
    // Fill the bucket directly: 3,000 argon2id verifies would take minutes.
    for (let i = 0; i < Flows.ENVIRONMENT_RATE_LIMITS.password; i++) {
      await deps.rateLimiter.hit(Flows.environmentKey('password', tenant), 1e9, 60_000)
    }
    expect(await rejection(password(attempt.id))).toBeInstanceOf(RateLimitError)
    deps.clock.advance('1m')
    expect((await rejection(password(attempt.id))).code).toBe('auth.invalid_credentials')
  })
})

describe('activity', () => {
  const recorded = () => deps.activityLog.entries.map((entry) => entry.type)

  test('nothing is recorded until a sign-up is verified; then the account and its session are', async () => {
    const started = await signUp()
    await rejection(
      Flows.verifyEmail(deps, tenant, 'sign_up', started.attempt.id, wrong(sentCode()), web)
    )
    expect(recorded()).toEqual([])

    const done = await Flows.verifyEmail(
      deps,
      tenant,
      'sign_up',
      started.attempt.id,
      sentCode(),
      web
    )
    if (done.attempt.step.status !== 'complete') {
      throw new Error('sign-up did not complete')
    }
    const { userId, sessionId } = done.attempt.step
    expect(deps.activityLog.entries).toMatchObject([
      {
        type: 'user.created',
        actor: { type: 'user', id: userId },
        target: { type: 'user', id: userId },
        ipAddress: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        data: { method: 'sign_up', emailVerified: true },
      },
      {
        type: 'session.created',
        actor: { type: 'user', id: userId },
        target: { type: 'session', id: sessionId },
        ipAddress: '203.0.113.7',
        data: { userId, client: 'web' },
      },
    ])
  })

  test('a sign-up for an existing address records nothing, even if its decoy code is guessed', async () => {
    await registered()
    const before = recorded()
    const decoy = await signUp()
    spy = spyOn(Verification, 'verifyCode').mockResolvedValue(undefined as never)
    await rejection(Flows.verifyEmail(deps, tenant, 'sign_up', decoy.attempt.id, '123456', web))
    expect(recorded()).toEqual(before)
  })

  test('a failed password records nothing; a sign-in records its session', async () => {
    const { userId } = await registered()
    const before = recorded()
    await rejection(password((await startSignIn()).id, 'wrong password'))
    expect(recorded()).toEqual(before)

    const done = await password((await startSignIn(EMAIL, ios)).id, PASSWORD, ios)
    expect(deps.activityLog.entries.at(-1)).toMatchObject({
      type: 'session.created',
      actor: { type: 'user', id: userId },
      ipAddress: null,
      userAgent: 'TulaSDK/1 iOS',
      data: { userId, client: 'ios' },
    })
    expect(done.tokens).toBeDefined()
  })

  test('verifying an existing user’s email during sign-in is recorded once', async () => {
    const userId = await seedUser({ verified: false })
    const attempt = await startSignIn()
    await password(attempt.id)
    await Flows.verifyEmail(deps, tenant, 'sign_in', attempt.id, sentCode(), web)
    expect(recorded()).toEqual(['user.email_verified', 'session.created'])
    expect(deps.activityLog.ofType('user.email_verified')).toMatchObject([
      {
        actor: { type: 'user', id: userId },
        target: { type: 'user', id: userId },
        ipAddress: '203.0.113.7',
      },
    ])
  })

  test('upgrading a weak hash after sign-in is not a password change', async () => {
    const weak = await Bun.password.hash(PASSWORD, {
      algorithm: 'argon2id',
      memoryCost: 8,
      timeCost: 1,
    })
    await seedUser({ passwordHash: weak })
    await password((await startSignIn()).id)
    expect(recorded()).toEqual(['session.created'])
  })

  test('no code, password, hash or email address ever reaches the record', async () => {
    const started = await signUp({ firstName: 'Maya' })
    const code = sentCode()
    await Flows.verifyEmail(deps, tenant, 'sign_up', started.attempt.id, code, web)
    const written = JSON.stringify(deps.activityLog.entries).toLowerCase()
    for (const secret of [PASSWORD, code, 'northline', 'maya', '$argon2']) {
      expect(written).not.toContain(secret.toLowerCase())
    }
  })
})

describe('hash upgrade after sign-in', () => {
  test('does not bring back a password that was changed while the sign-in was in progress', async () => {
    const weak = await Bun.password.hash(PASSWORD, {
      algorithm: 'argon2id',
      memoryCost: 8,
      timeCost: 1,
    })
    const userId = await seedUser({ passwordHash: weak })
    const attempt = await startSignIn()
    // An admin resets the password after this sign-in read the old hash and before it upgrades it.
    const changed = await Passwords.hash('a different password entirely')
    const find = deps.users.findByEmailWithPassword.bind(deps.users)
    deps.users.findByEmailWithPassword = async (environmentId, email) => {
      const found = await find(environmentId, email)
      await deps.users.setPasswordHash(environmentId, userId, changed, deps.clock.now())
      return found
    }
    await password(attempt.id)
    deps.users.findByEmailWithPassword = find
    expect((await find(tenant.environmentId, NORMALIZED))?.passwordHash).toBe(changed)
  })
})

describe('the account-exists notice', () => {
  test('points people who forgot their password at the reset, without a code or a link', async () => {
    await registered()
    await signUp()
    const notice = deps.mailer.last()
    expect(notice.subject).toBe('Your Tula account already exists')
    expect(notice.text).toContain('reset it from the sign-in screen')
    expect(`${notice.text} ${notice.html}`).not.toMatch(/\d{6}|https?:/)
  })
})

describe('password reset', () => {
  const NEW_PASSWORD = 'a brand new passphrase 42'
  const startReset = (email = EMAIL, ctx = web, t = tenant) =>
    Flows.startPasswordReset(deps, t, { email }, ctx)
  const reset = (attemptId: string, code: string, pw = NEW_PASSWORD, ctx = web, t = tenant) =>
    Flows.resetPassword(deps, t, attemptId, { code, password: pw }, ctx)
  async function signInWith(pw: string) {
    return password((await startSignIn()).id, pw)
  }

  test('emails a reset code and waits on the code and a new password', async () => {
    await registered()
    const { attempt, tokens } = await startReset()
    expect(attempt).toEqual({
      id: expect.any(String),
      kind: 'password_reset',
      expiresAt: new Date(deps.clock.now().getTime() + 10 * 60_000).toISOString(),
      step: {
        status: 'needs_new_password',
        destination: 'M***@Northline.app',
        strategies: ['email_code'],
      },
    })
    expect(tokens).toBeUndefined()
    expect(deps.mailer.last().subject).toContain('is your Tula password reset code')
  })

  test('the code and a new password replace the password, end every session and sign in', async () => {
    const { userId, tokens: before } = await registered()
    const { attempt } = await startReset(EMAIL, ios)
    const done = await reset(attempt.id, sentCode(), NEW_PASSWORD, ios)

    expect(done.attempt.step).toEqual({
      status: 'complete',
      userId,
      sessionId: done.tokens?.sessionId as string,
    })
    expect(done.client).toBe('ios')
    expect(done.tokens?.refreshToken).toMatch(/^tula_rt_/)
    // The session from before the reset is gone; the new one is the only live session.
    const sessions = await deps.sessions.listActiveByUser(
      tenant.environmentId,
      userId,
      deps.clock.now()
    )
    expect(sessions.map((s) => s.id)).toEqual([done.tokens?.sessionId as string])
    expect(await deps.revokedSessions.has(before?.sessionId as string, deps.clock.now())).toBe(true)

    expect((await rejection(signInWith(PASSWORD))).code).toBe('auth.invalid_credentials')
    expect((await signInWith(NEW_PASSWORD)).attempt.step.status).toBe('complete')
  })

  test('an address with no account answers the same, gets a notice and can never complete', async () => {
    await registered()
    const known = await startReset()
    const unknown = await startReset('nobody@northline.app')
    const expected: unknown = {
      ...shape(known.attempt),
      step: { ...known.attempt.step, destination: 'n***@northline.app' },
    }
    expect(shape(unknown.attempt)).toEqual(expected as never)
    const notice = deps.mailer.last()
    expect(notice.to).toBe('nobody@northline.app')
    expect(notice.subject).toBe('Tula password reset requested')
    expect(notice.text).not.toMatch(/\d{6}/)

    // A wrong guess counts down exactly as it does for a real account.
    const guess = await rejection(reset(unknown.attempt.id, '000000'))
    expect(guess.code).toBe('verification.invalid_code')
    expect(guess.params).toEqual({ attemptsRemaining: 4 })
  })

  test('guessing a decoy’s code does not complete it', async () => {
    const hmac = spyOn(deps.keyedHash, 'hmac').mockResolvedValue('same')
    spy = hmac
    const { attempt } = await startReset('nobody@northline.app')
    const guess = await rejection(reset(attempt.id, '123456'))
    expect(guess.code).toBe('verification.invalid_code')
    expect(guess.params).toEqual({ attemptsRemaining: 0 })
    expect(await deps.users.findByEmail(tenant.environmentId, 'nobody@northline.app')).toBeNull()
  })

  test('a wrong code changes nothing and counts down the guesses', async () => {
    const { userId } = await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    const error = await rejection(reset(attempt.id, wrong(code)))
    expect(error.code).toBe('verification.invalid_code')
    expect(error.params).toEqual({ attemptsRemaining: 4 })
    expect(deps.activityLog.ofType('user.password_changed')).toEqual([])
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
    ).toHaveLength(1)
    expect((await signInWith(PASSWORD)).attempt.step.status).toBe('complete')
  })

  test('five wrong codes exhaust the code, even for the right one', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    for (let i = 0; i < Verification.MAX_ATTEMPTS; i++) {
      await rejection(reset(attempt.id, wrong(code)))
    }
    expect((await rejection(reset(attempt.id, code))).code).toBe('verification.too_many_attempts')
  })

  test('a new password the policy rejects does not spend the code', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    expect((await rejection(reset(attempt.id, code, 'short'))).code).toBe('password.too_short')
    // Names count too: the check uses the account's details, not just the address.
    expect((await rejection(reset(attempt.id, code, 'Okafor Okafor Okafor'))).code).toMatch(
      /^password\./
    )
    expect((await signInWith(PASSWORD)).attempt.step.status).toBe('complete')
    expect((await reset(attempt.id, code)).attempt.step.status).toBe('complete')
  })

  test('a code works once: a second reset with it is refused', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    await reset(attempt.id, code)
    expect((await rejection(reset(attempt.id, code, 'yet another passphrase 77'))).code).toBe(
      'flow.not_found'
    )
    expect((await signInWith(NEW_PASSWORD)).attempt.step.status).toBe('complete')
  })

  test('of two racing resets with the same code only one stores a password', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    const results = await Promise.allSettled([
      reset(attempt.id, code, 'first racing passphrase 11'),
      reset(attempt.id, code, 'second racing passphrase 22'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(deps.activityLog.ofType('user.password_changed')).toHaveLength(1)
  })

  test('an expired code or attempt is refused', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    deps.clock.advance(Flows.ATTEMPT_TTL)
    expect((await rejection(reset(attempt.id, code))).code).toBe('flow.not_found')
  })

  test('an attempt cannot be used from another environment or as another kind', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    expect((await rejection(reset(attempt.id, code, NEW_PASSWORD, web, otherTenant))).code).toBe(
      'flow.not_found'
    )
    expect(
      (await rejection(Flows.verifyEmail(deps, tenant, 'sign_up', attempt.id, code, web))).code
    ).toBe('flow.not_found')
    const signUpAttempt = (await signUp({ email: 'other@northline.app' })).attempt
    expect((await rejection(reset(signUpAttempt.id, sentCode()))).code).toBe('flow.not_found')
  })

  test('a code emailed for verifying an address does not reset its password', async () => {
    await seedUser({ verified: false })
    const signIn = await password((await startSignIn()).id)
    expect(signIn.attempt.step.status).toBe('needs_email_verification')
    const verificationCode = sentCode()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const { attempt } = await startReset()
    // Two random codes are equal one time in a million; only then is there nothing to check.
    if (verificationCode !== sentCode()) {
      expect((await rejection(reset(attempt.id, verificationCode))).code).toBe(
        'verification.invalid_code'
      )
    }
    expect(deps.activityLog.ofType('user.password_changed')).toEqual([])
  })

  test('a banned user learns of the ban only after the right code, and keeps their password', async () => {
    const { userId } = await registered()
    await deps.users.setBanned(tenant.environmentId, userId, deps.clock.now(), deps.clock.now())
    const { attempt } = await startReset()
    expect(deps.mailer.last().subject).toContain('is your Tula password reset code')
    const code = sentCode()
    expect((await rejection(reset(attempt.id, wrong(code)))).code).toBe('verification.invalid_code')
    expect((await rejection(reset(attempt.id, code))).code).toBe('auth.user_banned')
    expect(deps.activityLog.ofType('user.password_changed')).toEqual([])
  })

  test('a reset proves the address: an unverified email becomes verified', async () => {
    const userId = await seedUser({ verified: false })
    const { attempt } = await startReset()
    const done = await reset(attempt.id, sentCode())
    expect(done.attempt.step.status).toBe('complete')
    const user = await deps.users.findById(tenant.environmentId, userId)
    expect(user?.emailVerifiedAt).toEqual(deps.clock.now())
    expect(deps.activityLog.ofType('user.email_verified')).toMatchObject([
      { actor: { type: 'user', id: userId }, target: { type: 'user', id: userId } },
    ])
  })

  test('a reset clears the sign-in lockout for the address', async () => {
    await registered()
    for (let i = 0; i < CREDENTIAL_LOCKOUT.freeAttempts + 2; i++) {
      await rejection(signInWith('wrong password entirely'))
    }
    expect(await rejection(signInWith(PASSWORD))).toBeInstanceOf(RateLimitError)
    const { attempt } = await startReset()
    await reset(attempt.id, sentCode())
    expect((await signInWith(NEW_PASSWORD)).attempt.step.status).toBe('complete')
  })

  test('the change is recorded with the user as actor and the request origin', async () => {
    const { userId } = await registered()
    const { attempt } = await startReset()
    await reset(attempt.id, sentCode())
    expect(deps.activityLog.ofType('user.password_changed')).toMatchObject([
      {
        actor: { type: 'user', id: userId },
        target: { type: 'user', id: userId },
        ipAddress: web.ipAddress,
        userAgent: web.userAgent,
        data: { method: 'reset' },
      },
    ])
    expect(deps.activityLog.ofType('session.revoked').map((entry) => entry.data)).toContainEqual(
      expect.objectContaining({ reason: 'password_changed' })
    )
  })

  test('if ending the old sessions fails, the password is not changed', async () => {
    const { userId } = await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    spy = spyOn(deps.sessions, 'revokeByUser').mockRejectedValueOnce(new Error('database blip'))
    await expect(reset(attempt.id, code)).rejects.toThrow('database blip')
    // Never the dangerous half-state: a new password with the old sessions still alive.
    expect(deps.activityLog.ofType('user.password_changed')).toEqual([])
    // What is left fails safe: the session row survives but its access tokens are already
    // denylisted, and the code is spent, so the user starts a new reset.
    const [session] = await deps.sessions.listActiveByUser(
      tenant.environmentId,
      userId,
      deps.clock.now()
    )
    expect(await deps.revokedSessions.has(session?.id as string, deps.clock.now())).toBe(true)
    expect((await rejection(reset(attempt.id, code))).code).toBe('verification.expired')
    expect((await signInWith(PASSWORD)).attempt.step.status).toBe('complete')
  })

  test('a sign-in with the old password that lands mid-reset does not survive it', async () => {
    const { userId } = await registered()
    const { attempt } = await startReset()
    const store = deps.users.setPasswordHash.bind(deps.users)
    spy = spyOn(deps.users, 'setPasswordHash').mockImplementation(async (...args) => {
      // After the old sessions ended and just before the new password is stored.
      expect((await signInWith(PASSWORD)).attempt.step.status).toBe('complete')
      return store(...args)
    })
    const done = await reset(attempt.id, sentCode())
    const active = await deps.sessions.listActiveByUser(
      tenant.environmentId,
      userId,
      deps.clock.now()
    )
    expect(active.map((s) => s.id)).toEqual([done.tokens?.sessionId as string])
  })

  test('a failure while hashing the new password does not spend the code', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    spy = spyOn(Passwords, 'hash').mockRejectedValueOnce(new Error('out of memory'))
    await expect(reset(attempt.id, code)).rejects.toThrow('out of memory')
    expect((await reset(attempt.id, code)).attempt.step.status).toBe('complete')
  })

  test('bookkeeping failures after the password is stored do not fail the reset', async () => {
    const userId = await seedUser({ verified: false })
    const { attempt } = await startReset()
    const verified = spyOn(deps.users, 'markEmailVerified').mockRejectedValueOnce(new Error('x'))
    const cleared = spyOn(deps.lockout, 'clear').mockRejectedValueOnce(new Error('y'))
    const done = await reset(attempt.id, sentCode())
    expect(verified).toHaveBeenCalledTimes(1)
    expect(cleared).toHaveBeenCalledTimes(1)
    verified.mockRestore()
    cleared.mockRestore()
    expect(done.attempt.step).toMatchObject({ status: 'complete', userId })
    expect(deps.activityLog.ofType('user.password_changed')).toHaveLength(1)
  })

  test('a code sent to an address the account no longer uses cannot reset it', async () => {
    const { userId } = await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    const user = await deps.users.findById(tenant.environmentId, userId)
    spy = spyOn(deps.users, 'findById').mockResolvedValue(
      user && { ...user, email: 'new@northline.app', emailNormalized: 'new@northline.app' }
    )
    const error = await rejection(reset(attempt.id, code))
    expect(error.code).toBe('verification.invalid_code')
    expect(error.params).toEqual({ attemptsRemaining: 0 })
    expect(deps.activityLog.ofType('user.password_changed')).toEqual([])
  })

  test('a malformed address is refused before anything is sent', async () => {
    const sent = deps.mailer.outbox.length
    expect((await rejection(startReset('not-an-email'))).code).toBe('email.invalid')
    expect(deps.mailer.outbox).toHaveLength(sent)
  })

  test('reset emails share the per-address cooldown, and a refused send leaves no attempt', async () => {
    await registered()
    await startReset()
    expect(await rejection(startReset())).toBeInstanceOf(RateLimitError)
    // Unknown addresses are limited the same way.
    await startReset('nobody@northline.app')
    expect(await rejection(startReset('nobody@northline.app'))).toBeInstanceOf(RateLimitError)
  })

  test('an attempt whose email could not be sent is deleted', async () => {
    await registered()
    spy = spyOn(deps.mailer, 'send').mockRejectedValue(new Error('relay down'))
    const create = spyOn(deps.flowAttempts, 'create')
    const error = await rejection(startReset())
    expect(error.status).toBe(500)
    const [created] = create.mock.calls.at(-1) ?? []
    create.mockRestore()
    expect(await deps.flowAttempts.findById(tenant.environmentId, created?.id as string)).toBeNull()
  })

  test('resending sends a fresh reset code and retires the old one; a decoy resends its notice', async () => {
    await registered()
    const { attempt } = await startReset()
    const first = sentCode()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const resent = await Flows.resendCode(deps, tenant, 'password_reset', attempt.id)
    expect(resent.attempt.step.status).toBe('needs_new_password')
    expect(deps.mailer.last().subject).toContain('is your Tula password reset code')
    const second = sentCode()
    if (first !== second) {
      expect((await rejection(reset(attempt.id, first))).code).toBe('verification.invalid_code')
    }
    expect((await reset(attempt.id, second)).attempt.step.status).toBe('complete')

    const decoy = await startReset('nobody@northline.app')
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await Flows.resendCode(deps, tenant, 'password_reset', decoy.attempt.id)
    expect(deps.mailer.last().subject).toBe('Tula password reset requested')
  })

  test('a sign-up attempt cannot be resent as a reset, nor a reset as a sign-up', async () => {
    await registered()
    const { attempt } = await startReset()
    expect((await rejection(Flows.resendCode(deps, tenant, 'sign_up', attempt.id))).code).toBe(
      'flow.not_found'
    )
  })

  test('starting a reset counts against the environment’s ceiling', async () => {
    for (let i = 0; i < Flows.ENVIRONMENT_RATE_LIMITS.passwordReset; i++) {
      await deps.rateLimiter.hit(Flows.environmentKey('passwordReset', tenant), 600, 60_000)
    }
    expect(await rejection(startReset())).toBeInstanceOf(RateLimitError)
    // Another environment is unaffected.
    expect((await startReset(EMAIL, web, otherTenant)).attempt.step.status).toBe(
      'needs_new_password'
    )
  })
})

describe('a sign-in method the environment has switched off', () => {
  beforeEach(() => {
    deps.environmentSettings.seed(tenant.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        signIn: { methods: { password: { enabled: false } } },
      },
    })
  })

  test.each<[string, () => Promise<unknown>]>([
    ['sign-up', () => signUp()],
    ['sign-in', () => Flows.signIn(deps, tenant, { identifier: EMAIL }, web)],
    ['password reset', () => Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)],
  ])('%s is refused before anything is stored, counted or sent', async (_, start) => {
    const err = await rejection(start())
    expect(err.toJSON()).toMatchObject({
      status: 403,
      code: 'auth.method_disabled',
      params: { method: 'password' },
    })
    expect(deps.mailer.outbox).toEqual([])
    expect(deps.activityLog.entries).toEqual([])
    // The environment's ceilings were not charged for a refused request.
    for (const step of ['signUp', 'passwordReset'] as const) {
      const key = Flows.environmentKey(step, tenant)
      expect((await deps.rateLimiter.hit(key, 10, 60_000)).remaining).toBe(9)
    }
  })

  test('the answer is the same for an address with an account and one without', async () => {
    await deps.users.createWithPassword({
      id: '00000000-0000-7000-8000-0000000000a1',
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: EMAIL,
      emailNormalized: NORMALIZED,
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: '00000000-0000-7000-8000-0000000000b1',
      credentialId: '00000000-0000-7000-8000-0000000000c1',
      passwordHash: 'x',
    })
    const known = await rejection(Flows.signIn(deps, tenant, { identifier: EMAIL }, web))
    const unknown = await rejection(
      Flows.signIn(deps, tenant, { identifier: 'nobody@northline.app' }, web)
    )
    expect(known.toJSON()).toEqual(unknown.toJSON())
  })

  test('another environment of the same deployment is unaffected', async () => {
    const started = await Flows.signIn(deps, otherTenant, { identifier: EMAIL }, web)
    expect(started.attempt.step.status).toBe('needs_password')
  })
})
