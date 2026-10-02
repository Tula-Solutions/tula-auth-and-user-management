import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { FlowAttempt } from '@tula/contract'
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
      await Flows.resendVerification(deps, tenant, 'sign_up', attempt.id).catch((err) => err)
    ).toBeInstanceOf(RateLimitError)

    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const resent = await Flows.resendVerification(deps, tenant, 'sign_up', attempt.id)
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
    await Flows.resendVerification(deps, tenant, 'sign_up', attempt.id)
    expect(deps.mailer.last().subject.toLowerCase()).toContain('already')
    expect(deps.mailer.last().text).not.toMatch(/\d{6}/)
  })

  test('resends to the user’s address during an unverified sign-in', async () => {
    await seedUser({ verified: false })
    const attempt = await startSignIn()
    await password(attempt.id)
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await Flows.resendVerification(deps, tenant, 'sign_in', attempt.id)
    expect(deps.mailer.last().to).toBe(EMAIL)
    const done = await Flows.verifyEmail(deps, tenant, 'sign_in', attempt.id, sentCode(), web)
    expect(done.attempt.step.status).toBe('complete')
  })

  test('is refused when the attempt is not waiting on email verification', async () => {
    const attempt = await startSignIn()
    const err = await rejection(Flows.resendVerification(deps, tenant, 'sign_in', attempt.id))
    expect(err.code).toBe('flow.invalid_step')
    expect(
      (await rejection(Flows.resendVerification(deps, tenant, 'sign_up', attempt.id))).code
    ).toBe('flow.not_found')
  })
})

describe('purgeExpired', () => {
  test('removes expired attempts in every environment, with their pending password hashes', async () => {
    const abandoned = await signUp()
    const other = (await Flows.signUp(deps, otherTenant, { email: EMAIL, password: PASSWORD }, web))
      .attempt
    deps.clock.advance('5m')
    const live = await startSignIn()

    expect(await Flows.purgeExpired(deps)).toBe(0)
    deps.clock.advance('5m')
    expect(await Flows.purgeExpired(deps)).toBe(2)
    expect(await deps.flowAttempts.findById(tenant.environmentId, abandoned.attempt.id)).toBeNull()
    expect(await deps.flowAttempts.findById(otherTenant.environmentId, other.id)).toBeNull()
    expect(await deps.flowAttempts.findById(tenant.environmentId, live.id)).not.toBeNull()
  })

  test('one failing environment does not stop the others from being purged', async () => {
    await signUp()
    const other = (await Flows.signUp(deps, otherTenant, { email: EMAIL, password: PASSWORD }, web))
      .attempt
    deps.clock.advance('10m')
    const deleteExpired = deps.flowAttempts.deleteExpired.bind(deps.flowAttempts)
    spy = spyOn(deps.flowAttempts, 'deleteExpired').mockImplementation(
      async (environmentId, now) => {
        if (environmentId === tenant.environmentId) {
          throw new Error('database unavailable')
        }
        return deleteExpired(environmentId, now)
      }
    )
    expect(await Flows.purgeExpired(deps)).toBe(1)
    expect(await deps.flowAttempts.findById(otherTenant.environmentId, other.id)).toBeNull()
  })
})
