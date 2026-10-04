import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, type FlowAttempt } from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { RateLimitError, ServiceException } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import { verifyAccessToken } from '~/middleware/session-auth'
import * as Factors from '~/modules/factor/service'
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
  originAllowed: true,
}
const ios: Flows.ClientContext = {
  client: 'ios',
  userAgent: 'TulaSDK/1 iOS',
  ipAddress: null,
  originAllowed: true,
}
/** A request from a page whose origin the environment does not allow. */
const foreign = (context: Flows.ClientContext): Flows.ClientContext => ({
  ...context,
  originAllowed: false,
})
/** What a client presents on every call after the start: the attempt's id and its secret. */
type Presented = Pick<FlowAttempt, 'id' | 'attemptSecret'>
const ref = (attempt: Presented): Flows.AttemptRef => ({
  id: attempt.id,
  secret: attempt.attemptSecret,
})
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
  const done = await Flows.verifyEmail(
    deps,
    tenant,
    'sign_up',
    ref(started.attempt),
    sentCode(),
    web
  )
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
  await deps.users.create({
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
const password = (attempt: Presented, value = PASSWORD, ctx = web, t = tenant) =>
  Flows.submitPassword(deps, t, ref(attempt), value, ctx)

/** An attempt with its id and expiry blanked, for comparing two responses. */
const shape = (attempt: FlowAttempt) => ({
  ...attempt,
  id: 'id',
  expiresAt: 'at',
  attemptSecret: 'secret',
})

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
      attemptSecret: expect.stringMatching(/^tula_at_[A-Za-z0-9_-]{43}$/),
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
        Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), '123456', web)
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
        Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), '123456', web)
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
  const verify = (attempt: Presented, code: string, ctx = web, t = tenant) =>
    Flows.verifyEmail(deps, t, 'sign_up', ref(attempt), code, ctx)

  test('creates the verified user, signs them in and completes the attempt', async () => {
    const { attempt } = await signUp({ firstName: ' Maya ', lastName: 'Okafor' }, ios)
    const done = await verify(attempt, sentCode(), ios)

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
    await verify(attempt, sentCode())
    const stored = await deps.flowAttempts.findById(tenant.environmentId, attempt.id)
    expect(stored).toMatchObject({ status: 'complete', completedAt: deps.clock.now() })
    expect(stored?.state).toEqual({ client: 'web' })
  })

  test('a failure to record the sign-in time does not discard the issued tokens', async () => {
    const { attempt } = await signUp()
    spy = spyOn(deps.users, 'recordSignIn').mockRejectedValue(new Error('database unavailable'))
    const done = await verify(attempt, sentCode())
    expect(done.attempt.step.status).toBe('complete')
    await verifyAccessToken(deps, done.tokens?.accessToken ?? '', tenant)
  })

  test('a wrong code leaves the attempt open for the right one', async () => {
    const { attempt } = await signUp()
    const code = sentCode()
    const err = await rejection(verify(attempt, wrong(code)))
    expect(err.code).toBe('verification.invalid_code')
    expect(await deps.users.findByEmail(tenant.environmentId, NORMALIZED)).toBeNull()
    expect((await verify(attempt, code)).attempt.step.status).toBe('complete')
  })

  test('a completed attempt cannot be replayed', async () => {
    const { attempt } = await signUp()
    const code = sentCode()
    await verify(attempt, code)
    const err = await rejection(verify(attempt, code))
    expect(err.status).toBe(404)
    expect(err.code).toBe('flow.not_found')
  })

  test('an attempt expires after 10 minutes', async () => {
    const { attempt } = await signUp()
    const code = sentCode()
    deps.clock.advance('10m')
    expect((await rejection(verify(attempt, code))).code).toBe('flow.not_found')
    expect(await deps.users.findByEmail(tenant.environmentId, NORMALIZED)).toBeNull()
  })

  test.each([
    [
      'an unknown attempt',
      () =>
        verify(
          { id: '00000000-0000-7000-8000-00000000dead', attemptSecret: 'tula_at_made-up' },
          '123456'
        ),
    ],
    // Both present the attempt's real secret: it is the environment and the kind that refuse.
    [
      'another environment',
      async () => verify((await signUp()).attempt, sentCode(), web, otherTenant),
    ],
    ['a sign-in attempt', async () => verify(await startSignIn(), '123456')],
  ])('answers flow.not_found for %s', async (_name, attempt) => {
    expect((await rejection(attempt())).code).toBe('flow.not_found')
  })

  test('when two sign-ups for one email are both verified, only the first creates the account', async () => {
    const first = await signUp()
    const firstCode = sentCode()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const second = await signUp({ password: 'a completely different passphrase' })
    const secondCode = sentCode()

    await verify(first.attempt, firstCode)
    const err = await rejection(verify(second.attempt, secondCode))
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
        attemptSecret: 'secret',
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
    const done = await password(attempt, PASSWORD, ios)

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
    const err = await rejection(password(attempt, 'not the password'))
    expect(err.status).toBe(401)
    expect(err.code).toBe('auth.invalid_credentials')
    expect(err.params).toBeUndefined()
    expect((await password(attempt)).attempt.step.status).toBe('complete')
  })

  test('an unknown user fails identically and still costs one argon2id verify', async () => {
    const known = await (async () => {
      await registered()
      return rejection(password(await startSignIn(), 'not the password'))
    })()
    spy = spyOn(Bun.password, 'verify')
    const unknown = await rejection(password(await startSignIn('nobody@northline.app')))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(unknown.toJSON()).toEqual(known.toJSON())
  })

  test('a banned user learns it only with the right password', async () => {
    const { userId } = await registered()
    await deps.users.setBanned(tenant.environmentId, userId, deps.clock.now(), deps.clock.now())
    const wrongPassword = await rejection(password(await startSignIn(), 'not the password'))
    expect(wrongPassword.code).toBe('auth.invalid_credentials')
    const banned = await rejection(password(await startSignIn()))
    expect(banned.status).toBe(403)
    expect(banned.code).toBe('auth.user_banned')
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
    ).toHaveLength(1)
  })

  test('an account in another environment does not exist here', async () => {
    await registered()
    const attempt = (await Flows.signIn(deps, otherTenant, { identifier: EMAIL }, web)).attempt
    expect((await rejection(password(attempt, PASSWORD, web, otherTenant))).code).toBe(
      'auth.invalid_credentials'
    )
    // And an attempt started in one environment is unknown in the other.
    const here = await startSignIn()
    expect((await rejection(password(here, PASSWORD, web, otherTenant))).code).toBe(
      'flow.not_found'
    )
  })

  test('after the free tries, each failure makes the identifier wait longer', async () => {
    await registered()
    const attempt = await startSignIn()
    const guess = () => rejection(password(attempt, 'not the password'))
    for (let i = 0; i < CREDENTIAL_LOCKOUT.freeAttempts; i++) {
      expect((await guess()).code).toBe('auth.invalid_credentials')
    }
    // The next failure is still answered, and starts the first wait.
    expect((await guess()).code).toBe('auth.invalid_credentials')
    const locked = await rejection(password(attempt))
    expect(locked).toBeInstanceOf(RateLimitError)
    expect(locked.params).toEqual({ retryAfter: 30 })

    // A fresh attempt for the same identifier is locked too; another identifier is not.
    expect(await rejection(password(await startSignIn()))).toBeInstanceOf(RateLimitError)
    expect((await rejection(password(await startSignIn('other@northline.app')))).code).toBe(
      'auth.invalid_credentials'
    )

    deps.clock.advance('30s')
    expect((await guess()).code).toBe('auth.invalid_credentials')
    expect((await rejection(password(attempt))).params).toEqual({ retryAfter: 60 })
    deps.clock.advance('60s')
    expect((await password(attempt)).attempt.step.status).toBe('complete')
  })

  test('a successful sign-in clears the failures', async () => {
    await registered()
    for (let round = 0; round < 3; round++) {
      const attempt = await startSignIn()
      for (let i = 0; i < CREDENTIAL_LOCKOUT.freeAttempts - 1; i++) {
        expect((await rejection(password(attempt, 'not the password'))).code).toBe(
          'auth.invalid_credentials'
        )
      }
      expect((await password(attempt)).attempt.step.status).toBe('complete')
    }
  })

  test('parallel guesses cannot exceed the free tries plus one', async () => {
    await registered()
    const attempt = await startSignIn()
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rejection(password(attempt, 'not the password')))
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
      expect((await rejection(password(attempt))).code).toBe('auth.invalid_credentials')
    }
    expect(await rejection(password(attempt))).toBeInstanceOf(RateLimitError)
  })

  test('upgrades a hash made with weaker parameters after a successful sign-in', async () => {
    const weak = await Bun.password.hash(PASSWORD, {
      algorithm: 'argon2id',
      memoryCost: 8,
      timeCost: 1,
    })
    expect(Passwords.needsRehash(weak)).toBe(true)
    await seedUser({ passwordHash: weak })
    await password(await startSignIn())
    const found = await deps.users.findByEmailWithPassword(tenant.environmentId, NORMALIZED)
    expect(Passwords.needsRehash(found?.passwordHash ?? '')).toBe(false)
    expect(await Passwords.verify(found?.passwordHash ?? null, PASSWORD)).toBe(true)
  })

  test('an unverified user must verify their email before the sign-in completes', async () => {
    const userId = await seedUser({ verified: false })
    const attempt = await startSignIn()
    const pending = await password(attempt)
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
    expect((await rejection(password(attempt))).code).toBe('flow.invalid_step')
    expect(
      (await rejection(Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), sentCode(), web)))
        .code
    ).toBe('flow.not_found')

    const done = await Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), sentCode(), web)
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
    expect(await password(attempt).catch((err) => err)).toBeInstanceOf(RateLimitError)
    expect((await deps.flowAttempts.findById(tenant.environmentId, attempt.id))?.status).toBe(
      'needs_password'
    )

    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const pending = await password(attempt)
    expect(pending.attempt.step.status).toBe('needs_email_verification')
    const done = await Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), sentCode(), web)
    expect(done.attempt.step.status).toBe('complete')
  })

  test('a user banned while verifying their email is not signed in', async () => {
    const userId = await seedUser({ verified: false })
    const attempt = await startSignIn()
    await password(attempt)
    await deps.users.setBanned(tenant.environmentId, userId, deps.clock.now(), deps.clock.now())
    const err = await rejection(
      Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), sentCode(), web)
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
      Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), '123456', web)
    )
    expect(err.code).toBe('flow.invalid_step')
  })

  test('a completed or expired attempt is gone', async () => {
    await registered()
    const done = await startSignIn()
    await password(done)
    expect((await rejection(password(done))).code).toBe('flow.not_found')
    const stale = await startSignIn()
    deps.clock.advance('10m')
    expect((await rejection(password(stale))).code).toBe('flow.not_found')
  })

  test('two concurrent correct submissions create one session', async () => {
    const { userId } = await registered()
    const attempt = await startSignIn()
    const results = await Promise.allSettled([password(attempt), password(attempt)])
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
      await Flows.resendCode(deps, tenant, 'sign_up', ref(attempt), web).catch((err) => err)
    ).toBeInstanceOf(RateLimitError)

    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const resent = await Flows.resendCode(deps, tenant, 'sign_up', ref(attempt), web)
    expect(resent.attempt.step).toEqual(attempt.step)
    const second = sentCode()
    if (first !== second) {
      expect(
        (await rejection(Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), first, web))).code
      ).toBe('verification.invalid_code')
    }
    expect(
      (await Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), second, web)).attempt.step
        .status
    ).toBe('complete')
  })

  test('for an existing account it resends the notice, never a code', async () => {
    await registered()
    const { attempt } = await signUp()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await Flows.resendCode(deps, tenant, 'sign_up', ref(attempt), web)
    expect(deps.mailer.last().subject.toLowerCase()).toContain('already')
    expect(deps.mailer.last().text).not.toMatch(/\d{6}/)
  })

  test('resends to the user’s address during an unverified sign-in', async () => {
    await seedUser({ verified: false })
    const attempt = await startSignIn()
    await password(attempt)
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await Flows.resendCode(deps, tenant, 'sign_in', ref(attempt), web)
    expect(deps.mailer.last().to).toBe(EMAIL)
    const done = await Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), sentCode(), web)
    expect(done.attempt.step.status).toBe('complete')
  })

  test('is refused when the attempt is not waiting on email verification', async () => {
    const attempt = await startSignIn()
    const err = await rejection(Flows.resendCode(deps, tenant, 'sign_in', ref(attempt), web))
    expect(err.code).toBe('flow.invalid_step')
    expect(
      (await rejection(Flows.resendCode(deps, tenant, 'sign_up', ref(attempt), web))).code
    ).toBe('flow.not_found')
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
      const missing = {
        id: `00000000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
        attemptSecret: 'tula_at_made-up',
      }
      await rejection(signUp({ email: 'not-an-email' }))
      await rejection(password(missing))
      await rejection(Flows.verifyEmail(deps, tenant, 'sign_up', ref(missing), '123456', web))
      await rejection(Flows.resendCode(deps, tenant, 'sign_up', ref(missing), web))
    }
    // Real requests still go through.
    expect((await password(await startSignIn())).attempt.step.status).toBe('complete')
    const started = await signUp({ email: 'real@northline.app' })
    const done = await Flows.verifyEmail(
      deps,
      tenant,
      'sign_up',
      ref(started.attempt),
      sentCode(),
      web
    )
    expect(done.attempt.step.status).toBe('complete')
  })

  test('refused tries on a locked-out identifier do not use the ceiling up', async () => {
    await registered()
    const locked = await startSignIn('victim@northline.app')
    for (let i = 0; i <= CREDENTIAL_LOCKOUT.freeAttempts; i++) {
      await rejection(password(locked, 'not the password'))
    }
    for (let i = 0; i <= Flows.ENVIRONMENT_RATE_LIMITS.password; i++) {
      expect(await rejection(password(locked))).toBeInstanceOf(RateLimitError)
    }
    // Everyone else in the environment can still sign in.
    expect((await password(await startSignIn())).attempt.step.status).toBe('complete')
  })

  test('resends refused by the address cooldown do not use the ceiling up', async () => {
    const { attempt } = await signUp()
    for (let i = 0; i <= Flows.ENVIRONMENT_RATE_LIMITS.signUp; i++) {
      expect(
        await Flows.resendCode(deps, tenant, 'sign_up', ref(attempt), web).catch((err) => err)
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
    expect(await rejection(password(attempt))).toBeInstanceOf(RateLimitError)
    deps.clock.advance('1m')
    expect((await rejection(password(attempt))).code).toBe('auth.invalid_credentials')
  })
})

describe('activity', () => {
  const recorded = () => deps.activityLog.entries.map((entry) => entry.type)

  test('nothing is recorded until a sign-up is verified; then the account and its session are', async () => {
    const started = await signUp()
    await rejection(
      Flows.verifyEmail(deps, tenant, 'sign_up', ref(started.attempt), wrong(sentCode()), web)
    )
    expect(recorded()).toEqual([])

    const done = await Flows.verifyEmail(
      deps,
      tenant,
      'sign_up',
      ref(started.attempt),
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
    await rejection(Flows.verifyEmail(deps, tenant, 'sign_up', ref(decoy.attempt), '123456', web))
    expect(recorded()).toEqual(before)
  })

  test('a failed password records nothing; a sign-in records its session', async () => {
    const { userId } = await registered()
    const before = recorded()
    await rejection(password(await startSignIn(), 'wrong password'))
    expect(recorded()).toEqual(before)

    const done = await password(await startSignIn(EMAIL, ios), PASSWORD, ios)
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
    await password(attempt)
    await Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), sentCode(), web)
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
    await password(await startSignIn())
    expect(recorded()).toEqual(['session.created'])
  })

  test('no code, password, hash or email address ever reaches the record', async () => {
    const started = await signUp({ firstName: 'Maya' })
    const code = sentCode()
    await Flows.verifyEmail(deps, tenant, 'sign_up', ref(started.attempt), code, web)
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
    await password(attempt)
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
  const reset = (attempt: Presented, code: string, pw = NEW_PASSWORD, ctx = web, t = tenant) =>
    Flows.resetPassword(deps, t, ref(attempt), { code, password: pw }, ctx)
  async function signInWith(pw: string) {
    return password(await startSignIn(), pw)
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
      attemptSecret: expect.stringMatching(/^tula_at_[A-Za-z0-9_-]{43}$/),
    })
    expect(tokens).toBeUndefined()
    expect(deps.mailer.last().subject).toContain('is your Tula password reset code')
  })

  test('the code and a new password replace the password, end every session and sign in', async () => {
    const { userId, tokens: before } = await registered()
    const { attempt } = await startReset(EMAIL, ios)
    const done = await reset(attempt, sentCode(), NEW_PASSWORD, ios)

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
    const guess = await rejection(reset(unknown.attempt, '000000'))
    expect(guess.code).toBe('verification.invalid_code')
    expect(guess.params).toEqual({ attemptsRemaining: 4 })
  })

  test('guessing a decoy’s code does not complete it', async () => {
    const hmac = spyOn(deps.keyedHash, 'hmac').mockResolvedValue('same')
    spy = hmac
    const { attempt } = await startReset('nobody@northline.app')
    const guess = await rejection(reset(attempt, '123456'))
    expect(guess.code).toBe('verification.invalid_code')
    expect(guess.params).toEqual({ attemptsRemaining: 0 })
    expect(await deps.users.findByEmail(tenant.environmentId, 'nobody@northline.app')).toBeNull()
  })

  test('a wrong code changes nothing and counts down the guesses', async () => {
    const { userId } = await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    const error = await rejection(reset(attempt, wrong(code)))
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
      await rejection(reset(attempt, wrong(code)))
    }
    expect((await rejection(reset(attempt, code))).code).toBe('verification.too_many_attempts')
  })

  test('a new password the policy rejects does not spend the code', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    expect((await rejection(reset(attempt, code, 'short'))).code).toBe('password.too_short')
    // Names count too: the check uses the account's details, not just the address.
    expect((await rejection(reset(attempt, code, 'Okafor Okafor Okafor'))).code).toMatch(
      /^password\./
    )
    expect((await signInWith(PASSWORD)).attempt.step.status).toBe('complete')
    expect((await reset(attempt, code)).attempt.step.status).toBe('complete')
  })

  test('a code works once: a second reset with it is refused', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    await reset(attempt, code)
    expect((await rejection(reset(attempt, code, 'yet another passphrase 77'))).code).toBe(
      'flow.not_found'
    )
    expect((await signInWith(NEW_PASSWORD)).attempt.step.status).toBe('complete')
  })

  test('of two racing resets with the same code only one stores a password', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    const results = await Promise.allSettled([
      reset(attempt, code, 'first racing passphrase 11'),
      reset(attempt, code, 'second racing passphrase 22'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(deps.activityLog.ofType('user.password_changed')).toHaveLength(1)
  })

  test('an expired code or attempt is refused', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    deps.clock.advance(Flows.ATTEMPT_TTL)
    expect((await rejection(reset(attempt, code))).code).toBe('flow.not_found')
  })

  test('an attempt cannot be used from another environment or as another kind', async () => {
    await registered()
    const { attempt } = await startReset()
    const code = sentCode()
    expect((await rejection(reset(attempt, code, NEW_PASSWORD, web, otherTenant))).code).toBe(
      'flow.not_found'
    )
    expect(
      (await rejection(Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), code, web))).code
    ).toBe('flow.not_found')
    const signUpAttempt = (await signUp({ email: 'other@northline.app' })).attempt
    expect((await rejection(reset(signUpAttempt, sentCode()))).code).toBe('flow.not_found')
  })

  test('a code emailed for verifying an address does not reset its password', async () => {
    await seedUser({ verified: false })
    const signIn = await password(await startSignIn())
    expect(signIn.attempt.step.status).toBe('needs_email_verification')
    const verificationCode = sentCode()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const { attempt } = await startReset()
    // Two random codes are equal one time in a million; only then is there nothing to check.
    if (verificationCode !== sentCode()) {
      expect((await rejection(reset(attempt, verificationCode))).code).toBe(
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
    expect((await rejection(reset(attempt, wrong(code)))).code).toBe('verification.invalid_code')
    expect((await rejection(reset(attempt, code))).code).toBe('auth.user_banned')
    expect(deps.activityLog.ofType('user.password_changed')).toEqual([])
  })

  test('a reset proves the address: an unverified email becomes verified', async () => {
    const userId = await seedUser({ verified: false })
    const { attempt } = await startReset()
    const done = await reset(attempt, sentCode())
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
    await reset(attempt, sentCode())
    expect((await signInWith(NEW_PASSWORD)).attempt.step.status).toBe('complete')
  })

  test('the change is recorded with the user as actor and the request origin', async () => {
    const { userId } = await registered()
    const { attempt } = await startReset()
    await reset(attempt, sentCode())
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
    await expect(reset(attempt, code)).rejects.toThrow('database blip')
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
    expect((await rejection(reset(attempt, code))).code).toBe('verification.expired')
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
    const done = await reset(attempt, sentCode())
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
    await expect(reset(attempt, code)).rejects.toThrow('out of memory')
    expect((await reset(attempt, code)).attempt.step.status).toBe('complete')
  })

  test('bookkeeping failures after the password is stored do not fail the reset', async () => {
    const userId = await seedUser({ verified: false })
    const { attempt } = await startReset()
    const verified = spyOn(deps.users, 'markEmailVerified').mockRejectedValueOnce(new Error('x'))
    const cleared = spyOn(deps.lockout, 'clear').mockRejectedValueOnce(new Error('y'))
    const done = await reset(attempt, sentCode())
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
    const error = await rejection(reset(attempt, code))
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
    const resent = await Flows.resendCode(deps, tenant, 'password_reset', ref(attempt), web)
    expect(resent.attempt.step.status).toBe('needs_new_password')
    expect(deps.mailer.last().subject).toContain('is your Tula password reset code')
    const second = sentCode()
    if (first !== second) {
      expect((await rejection(reset(attempt, first))).code).toBe('verification.invalid_code')
    }
    expect((await reset(attempt, second)).attempt.step.status).toBe('complete')

    const decoy = await startReset('nobody@northline.app')
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await Flows.resendCode(deps, tenant, 'password_reset', ref(decoy.attempt), web)
    expect(deps.mailer.last().subject).toBe('Tula password reset requested')
  })

  test('a sign-up attempt cannot be resent as a reset, nor a reset as a sign-up', async () => {
    await registered()
    const { attempt } = await startReset()
    expect(
      (await rejection(Flows.resendCode(deps, tenant, 'sign_up', ref(attempt), web))).code
    ).toBe('flow.not_found')
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
        signIn: {
          methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, password: { enabled: false } },
        },
      },
    })
  })

  test.each<[string, () => Promise<unknown>]>([
    ['sign-up', () => signUp()],
    ['sign-in', () => Flows.signIn(deps, tenant, { identifier: EMAIL }, web)],
    ['password reset', () => Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)],
  ])('%s is refused before anything is stored, counted or sent', async (name, start) => {
    const err = await rejection(start())
    expect(err.toJSON()).toMatchObject({
      status: 403,
      code: 'auth.method_disabled',
      // A sign-in start names no method: it is refused because none is enabled at all.
      ...(name !== 'sign-in' && { params: { method: 'password' } }),
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
    await deps.users.create({
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

describe('an attempt started before password sign-in was switched off', () => {
  function switchOff() {
    deps.environmentSettings.seed(tenant.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        signIn: {
          methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, password: { enabled: false } },
        },
      },
    })
  }
  const disabled = { status: 403, code: 'auth.method_disabled', params: { method: 'password' } }

  test('a started sign-in cannot submit its password, and the try counts against nobody', async () => {
    await seedUser()
    const attempt = await startSignIn()
    switchOff()
    const err = await rejection(password(attempt))
    expect(err.toJSON()).toMatchObject(disabled)
    expect(deps.activityLog.ofType('session.created')).toEqual([])
    // Neither the lockout nor the environment's ceiling was charged for the refused try.
    const ceiling = Flows.environmentKey('password', tenant)
    expect((await deps.rateLimiter.hit(ceiling, 10, 60_000)).remaining).toBe(9)
    deps.environmentSettings.seed(tenant.environmentId, {
      revision: 2,
      settings: DEFAULT_ENVIRONMENT_SETTINGS,
    })
    expect((await password(attempt)).attempt.step.status).toBe('complete')
  })

  test('a started sign-up cannot be completed: no password account is created', async () => {
    const { attempt } = await signUp()
    const code = sentCode()
    switchOff()
    const err = await rejection(Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), code, web))
    expect(err.toJSON()).toMatchObject(disabled)
    expect(await deps.users.findByEmail(tenant.environmentId, NORMALIZED)).toBeNull()
  })

  test('a sign-in waiting on email verification cannot be completed either', async () => {
    await seedUser({ verified: false })
    const attempt = await startSignIn()
    await password(attempt)
    const code = sentCode()
    switchOff()
    const err = await rejection(Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), code, web))
    expect(err.toJSON()).toMatchObject(disabled)
    expect(deps.activityLog.ofType('session.created')).toEqual([])
  })

  test('a started password reset cannot set a password, and its code is not spent', async () => {
    await seedUser()
    const { attempt } = await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)
    const code = sentCode()
    switchOff()
    const reset = () =>
      Flows.resetPassword(
        deps,
        tenant,
        ref(attempt),
        { code, password: 'a brand new passphrase 42' },
        web
      )
    expect((await rejection(reset())).toJSON()).toMatchObject(disabled)
    expect(deps.activityLog.ofType('user.password_changed')).toEqual([])
    const found = await deps.users.findByEmailWithPassword(tenant.environmentId, NORMALIZED)
    expect(await Passwords.verify(found?.passwordHash ?? null, PASSWORD)).toBe(true)
    // Switched back on, the same code still works: the refused call did not use a guess.
    deps.environmentSettings.seed(tenant.environmentId, {
      revision: 2,
      settings: DEFAULT_ENVIRONMENT_SETTINGS,
    })
    expect((await reset()).attempt.step.status).toBe('complete')
  })

  test('no further code is emailed for an attempt that can no longer finish', async () => {
    const { attempt } = await signUp()
    deps.clock.advance('2m')
    switchOff()
    const sent = deps.mailer.outbox.length
    const err = await rejection(Flows.resendCode(deps, tenant, 'sign_up', ref(attempt), web))
    expect(err.toJSON()).toMatchObject(disabled)
    expect(deps.mailer.outbox).toHaveLength(sent)
  })
})

describe('attempt binding', () => {
  const NEW_PASSWORD = 'a brand new passphrase 42'
  const MADE_UP = { id: '00000000-0000-7000-8000-00000000dead', attemptSecret: 'tula_at_made-up' }

  /** One started attempt of each kind, and every later call that can be made on it. */
  async function started() {
    await registered()
    const signInAttempt = await startSignIn()
    const signUpAttempt = (await signUp({ email: 'new@northline.app' })).attempt
    const signUpCode = sentCode()
    const resetAttempt = (await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web))
      .attempt
    const resetCode = sentCode()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const calls: [string, FlowAttempt, (presented: Presented) => Promise<Flows.FlowResult>][] = [
      ['the password step', signInAttempt, (a) => password(a)],
      [
        'verify-email',
        signUpAttempt,
        (a) => Flows.verifyEmail(deps, tenant, 'sign_up', ref(a), signUpCode, web),
      ],
      ['resend-code', signUpAttempt, (a) => Flows.resendCode(deps, tenant, 'sign_up', ref(a), web)],
      [
        'the reset submit',
        resetAttempt,
        (a) =>
          Flows.resetPassword(
            deps,
            tenant,
            ref(a),
            { code: resetCode, password: NEW_PASSWORD },
            web
          ),
      ],
      [
        'the reset resend',
        resetAttempt,
        (a) => Flows.resendCode(deps, tenant, 'password_reset', ref(a), web),
      ],
      [
        'the second factor',
        signInAttempt,
        (a) =>
          Flows.submitSecondFactor(
            deps,
            tenant,
            'sign_in',
            ref(a),
            { method: 'totp', response: '123456' },
            web
          ),
      ],
    ]
    return { calls, signInAttempt, signUpAttempt, resetAttempt }
  }

  test('every start returns a 256-bit secret once, and stores only its SHA-256', async () => {
    await registered()
    const starts = [
      (await signUp({ email: 'new@northline.app' })).attempt,
      await startSignIn(),
      (await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)).attempt,
    ]
    const secrets = starts.map((attempt) => attempt.attemptSecret as string)
    expect(new Set(secrets).size).toBe(3)
    for (const [index, attempt] of starts.entries()) {
      const secret = secrets[index] as string
      // The prefix, then 32 random bytes as base64url.
      expect(secret).toMatch(/^tula_at_[A-Za-z0-9_-]{43}$/)
      expect(secret.startsWith(Flows.ATTEMPT_SECRET_PREFIX)).toBe(true)
      const stored = await deps.flowAttempts.findById(tenant.environmentId, attempt.id)
      expect(stored?.secretHash).toBe(sha256Hex(secret))
      expect(JSON.stringify(stored)).not.toContain(secret)
    }
  })

  test('no later response, email or audit entry ever carries the secret', async () => {
    await seedUser({ verified: false })
    const attempt = await startSignIn()
    const secret = attempt.attemptSecret as string
    const waiting = await password(attempt)
    expect(waiting.attempt.step.status).toBe('needs_email_verification')
    const code = sentCode()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const resent = await Flows.resendCode(deps, tenant, 'sign_in', ref(attempt), web)
    const done = await Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), sentCode(), web)
    expect(code).not.toBe('')
    for (const result of [waiting, resent, done]) {
      expect(result.attempt.attemptSecret).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain(secret)
    }
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain(secret)
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain(sha256Hex(secret))
    expect(JSON.stringify(deps.mailer.outbox)).not.toContain(secret)
  })

  test('every later call is refused, exactly like an unknown attempt, without the right secret', async () => {
    const { calls, signInAttempt, signUpAttempt, resetAttempt } = await started()
    const unknown = (await rejection(password(MADE_UP))).toJSON()
    expect(unknown).toMatchObject({ status: 404, code: 'flow.not_found' })
    const lockout = spyOn(deps.lockout, 'attempt')
    const limiter = spyOn(deps.rateLimiter, 'hit')
    const verifier = spyOn(Bun.password, 'verify')
    const sent = deps.mailer.outbox.length
    const recorded = deps.activityLog.entries.length
    try {
      for (const [name, attempt, call] of calls) {
        const others = [signInAttempt, signUpAttempt, resetAttempt].filter(
          (other) => other.id !== attempt.id
        )
        const secret = attempt.attemptSecret as string
        const presented: [string, string | undefined][] = [
          ['no secret', undefined],
          ['an empty secret', ''],
          ['a made-up secret', 'tula_at_made-up'],
          ['the secret cut short', secret.slice(0, -1)],
          [
            'the secret with a different last character',
            `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`,
          ],
          ['the stored hash itself', sha256Hex(secret)],
          ...others.map((other): [string, string | undefined] => [
            `the secret of another ${other.kind} attempt`,
            other.attemptSecret,
          ]),
        ]
        for (const [what, value] of presented) {
          const err = await rejection(call({ id: attempt.id, attemptSecret: value }))
          expect({ name, what, error: err.toJSON() }).toEqual({ name, what, error: unknown })
        }
      }
      // Nothing was guessed, counted, sent or recorded on behalf of someone without the secret.
      expect(lockout).not.toHaveBeenCalled()
      expect(limiter).not.toHaveBeenCalled()
      expect(verifier).not.toHaveBeenCalled()
      expect(deps.mailer.outbox).toHaveLength(sent)
      expect(deps.activityLog.entries).toHaveLength(recorded)
    } finally {
      for (const watched of [lockout, limiter, verifier]) {
        watched.mockRestore()
      }
    }
    // The attempts are untouched: each still works with its own secret.
    expect((await password(signInAttempt)).attempt.step.status).toBe('complete')
  })

  test('an attempt stored before attempts were bound can never be continued', async () => {
    await registered()
    const attempt = await startSignIn()
    const stored = await deps.flowAttempts.findById(tenant.environmentId, attempt.id)
    await deps.flowAttempts.delete(tenant.environmentId, attempt.id)
    await deps.flowAttempts.create({ ...(stored as NonNullable<typeof stored>), secretHash: null })
    for (const value of [undefined, '', attempt.attemptSecret, 'null']) {
      const err = await rejection(password({ id: attempt.id, attemptSecret: value }))
      expect(err.code).toBe('flow.not_found')
    }
  })

  test('an attempt and its secret are worth nothing in another environment', async () => {
    await registered()
    const attempt = await startSignIn()
    expect((await rejection(password(attempt, PASSWORD, web, otherTenant))).code).toBe(
      'flow.not_found'
    )
    expect((await password(attempt)).attempt.step.status).toBe('complete')
  })

  test('the secret does not outlive the attempt: completed and expired attempts are gone', async () => {
    await registered()
    const done = await startSignIn()
    await password(done)
    expect((await rejection(password(done))).code).toBe('flow.not_found')
    const stale = await startSignIn()
    deps.clock.advance(Flows.ATTEMPT_TTL)
    expect((await rejection(password(stale))).code).toBe('flow.not_found')
  })
})

describe('a browser flow from an origin the environment does not allow', () => {
  const NEW_PASSWORD = 'a brand new passphrase 42'
  const refused = { status: 403, code: 'request.origin_not_allowed' }

  test.each<[string, (ctx: Flows.ClientContext) => Promise<Flows.FlowResult>]>([
    ['sign-up', (ctx) => signUp({}, ctx)],
    ['sign-in', (ctx) => Flows.signIn(deps, tenant, { identifier: EMAIL }, ctx)],
    ['password reset', (ctx) => Flows.startPasswordReset(deps, tenant, { email: EMAIL }, ctx)],
  ])('cannot start a %s: nothing is stored, sent or counted', async (_, start) => {
    const create = spyOn(deps.flowAttempts, 'create')
    const limiter = spyOn(deps.rateLimiter, 'hit')
    try {
      expect((await rejection(start(foreign(web)))).toJSON()).toMatchObject(refused)
      expect(create).not.toHaveBeenCalled()
      expect(limiter).not.toHaveBeenCalled()
      expect(deps.mailer.outbox).toEqual([])
      // The same page may start a native-kind attempt: its tokens come back in a response body
      // the page cannot read, and no cookie is ever set for it.
      expect((await start(foreign(ios))).client).toBe('ios')
      // And an allowed origin starts a browser attempt as before.
      deps.clock.advance(Verification.RESEND_COOLDOWN)
      expect((await start(web)).client).toBe('web')
    } finally {
      create.mockRestore()
      limiter.mockRestore()
    }
  })

  test('cannot submit the password: no guess is counted and no session is created', async () => {
    const { userId } = await registered()
    const attempt = await startSignIn()
    const lockout = spyOn(deps.lockout, 'attempt')
    const verifier = spyOn(Bun.password, 'verify')
    try {
      const err = await rejection(password(attempt, PASSWORD, foreign(web)))
      expect(err.toJSON()).toMatchObject(refused)
      expect(lockout).not.toHaveBeenCalled()
      expect(verifier).not.toHaveBeenCalled()
    } finally {
      lockout.mockRestore()
      verifier.mockRestore()
    }
    // Only the session from the sign-up exists.
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
    ).toHaveLength(1)
    // The attempt is untouched and completes from an allowed origin.
    expect((await password(attempt)).attempt.step.status).toBe('complete')
  })

  test('cannot complete a sign-up: the code is not consumed and no account is created', async () => {
    const { attempt } = await signUp()
    const code = sentCode()
    const verify = (ctx: Flows.ClientContext) =>
      Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), code, ctx)
    expect((await rejection(verify(foreign(web)))).toJSON()).toMatchObject(refused)
    expect(await deps.users.findByEmail(tenant.environmentId, NORMALIZED)).toBeNull()
    expect(deps.activityLog.entries).toEqual([])
    // The same code still works, with all five guesses, from an allowed origin.
    expect((await verify(web)).attempt.step.status).toBe('complete')
  })

  test('cannot complete a password reset: the code is not spent and the password is unchanged', async () => {
    const { userId } = await registered()
    const { attempt } = await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)
    const code = sentCode()
    const submit = (ctx: Flows.ClientContext) =>
      Flows.resetPassword(deps, tenant, ref(attempt), { code, password: NEW_PASSWORD }, ctx)
    expect((await rejection(submit(foreign(web)))).toJSON()).toMatchObject(refused)
    const found = await deps.users.findByEmailWithPassword(tenant.environmentId, NORMALIZED)
    expect(await Passwords.verify(found?.passwordHash ?? null, PASSWORD)).toBe(true)
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
    ).toHaveLength(1)
    expect((await submit(web)).attempt.step.status).toBe('complete')
  })

  test('cannot have a code resent', async () => {
    const { attempt } = await signUp()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const sent = deps.mailer.outbox.length
    const err = await rejection(
      Flows.resendCode(deps, tenant, 'sign_up', ref(attempt), foreign(web))
    )
    expect(err.toJSON()).toMatchObject(refused)
    expect(deps.mailer.outbox).toHaveLength(sent)
  })

  test('learns nothing without the secret: the answer is still flow.not_found', async () => {
    await registered()
    const attempt = await startSignIn()
    const err = await rejection(
      password({ id: attempt.id, attemptSecret: 'tula_at_made-up' }, PASSWORD, foreign(web))
    )
    expect(err.code).toBe('flow.not_found')
  })

  test('the attempt’s own kind decides, not what the later request claims', async () => {
    await registered()
    // Started as a native app: its later steps are not bound to an origin, whatever they say.
    const native = await startSignIn(EMAIL, ios)
    const done = await password(native, PASSWORD, foreign(web))
    expect(done.client).toBe('ios')
    expect(done.tokens?.refreshToken).toMatch(/^tula_rt_/)
    // Started as a browser: a later request cannot escape the rule by claiming to be native.
    const browser = await startSignIn(EMAIL, web)
    expect((await rejection(password(browser, PASSWORD, foreign(ios)))).toJSON()).toMatchObject(
      refused
    )
  })
})

describe('first-factor choice', () => {
  let offered: ReturnType<typeof spyOn>
  const offer = (...strategies: ReturnType<typeof Factors.firstFactors>) => {
    offered = spyOn(Factors, 'firstFactors').mockReturnValue(strategies)
  }
  afterEach(() => offered?.mockRestore())

  test('password alone asks for the password; the attempt remembers what it was offered', async () => {
    const attempt = await startSignIn()
    expect(attempt.step).toEqual({ status: 'needs_password' })
    const stored = await deps.flowAttempts.findById(tenant.environmentId, attempt.id)
    expect(stored?.state).toEqual({ client: 'web', strategies: ['password'] })
  })

  test('more than one enabled method answers needs_first_factor with the strategies', async () => {
    offer('password', 'email_code', 'oauth_google')
    const attempt = await startSignIn()
    expect(attempt.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'oauth_google'],
    })
    expect(attempt.attemptSecret).toMatch(/^tula_at_/)
  })

  test('one enabled method that is not the password is still a choice of one', async () => {
    offer('email_code')
    expect((await startSignIn()).step).toEqual({
      status: 'needs_first_factor',
      strategies: ['email_code'],
    })
  })

  test('the strategies depend on the settings only: every identifier gets the same answer and none is looked up', async () => {
    await registered()
    // A user with no password at all, who could only use another method.
    await deps.users.create({
      id: deps.ids.next(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: 'passkey-only@northline.app',
      emailNormalized: 'passkey-only@northline.app',
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: null,
    })
    offer('password', 'passkey')
    const lookups = [
      spyOn(deps.users, 'findByEmail'),
      spyOn(deps.users, 'findByEmailWithPassword'),
      spyOn(deps.users, 'findById'),
    ]
    try {
      const answers = []
      for (const identifier of [
        EMAIL,
        'passkey-only@northline.app',
        'nobody@northline.app',
        'not even an email',
      ]) {
        answers.push(shape(await startSignIn(identifier)))
      }
      expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1)
      expect(offered).toHaveBeenCalledTimes(4)
      // The registry is asked with the environment's settings and its enabled OAuth providers
      // (none here), and nothing else: never an identifier or an account.
      for (const call of offered.mock.calls) {
        expect(call).toEqual([DEFAULT_ENVIRONMENT_SETTINGS, []])
      }
      for (const lookup of lookups) {
        expect(lookup).not.toHaveBeenCalled()
      }
    } finally {
      for (const lookup of lookups) {
        lookup.mockRestore()
      }
    }
  })

  test('a password completes an attempt that offered it among others', async () => {
    const { userId } = await registered()
    offer('password', 'email_code')
    const attempt = await startSignIn()
    expect((await rejection(password(attempt, 'not the password'))).code).toBe(
      'auth.invalid_credentials'
    )
    const done = await password(attempt)
    expect(done.attempt.step).toMatchObject({ status: 'complete', userId })
    expect(done.tokens?.accessToken).toBeString()
  })

  test('a password is refused by an attempt that did not offer it, before anything is checked', async () => {
    await registered()
    offer('email_code')
    const attempt = await startSignIn()
    const lockout = spyOn(deps.lockout, 'attempt')
    const verifier = spyOn(Bun.password, 'verify')
    try {
      const err = await rejection(password(attempt))
      expect(err.toJSON()).toMatchObject({ status: 409, code: 'flow.invalid_step' })
      expect(lockout).not.toHaveBeenCalled()
      expect(verifier).not.toHaveBeenCalled()
    } finally {
      lockout.mockRestore()
      verifier.mockRestore()
    }
  })

  test('what an attempt was offered is fixed at its start, not re-read later', async () => {
    await registered()
    offer('email_code')
    const attempt = await startSignIn()
    offered.mockReturnValue(['password', 'email_code'])
    expect((await rejection(password(attempt))).code).toBe('flow.invalid_step')
  })

  test('with no method enabled a sign-in cannot start', async () => {
    offer()
    const err = await rejection(Flows.signIn(deps, tenant, { identifier: EMAIL }, web))
    expect(err.toJSON()).toMatchObject({ status: 403, code: 'auth.method_disabled' })
  })
})

describe('a user without a password', () => {
  const NEW_PASSWORD = 'a brand new passphrase 42'

  async function passwordless() {
    const id = deps.ids.next()
    await deps.users.create({
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: EMAIL,
      emailNormalized: NORMALIZED,
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: null,
    })
    return id
  }

  test('signing in with a password fails exactly like an unknown address, at the same cost', async () => {
    await passwordless()
    spy = spyOn(Bun.password, 'verify')
    const noPassword = await rejection(password(await startSignIn()))
    expect(spy).toHaveBeenCalledTimes(1)
    const unknown = await rejection(password(await startSignIn('nobody@northline.app')))
    expect(spy).toHaveBeenCalledTimes(2)
    expect(noPassword.toJSON()).toEqual(unknown.toJSON())
    expect(noPassword.code).toBe('auth.invalid_credentials')
  })

  test('a password reset gives them their first password, recorded as created', async () => {
    const userId = await passwordless()
    const { attempt } = await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)
    const done = await Flows.resetPassword(
      deps,
      tenant,
      ref(attempt),
      { code: sentCode(), password: NEW_PASSWORD },
      web
    )
    expect(done.attempt.step).toMatchObject({ status: 'complete', userId })
    expect(deps.activityLog.ofType('user.password_changed').map((entry) => entry.data)).toEqual([
      { method: 'reset', created: true },
    ])
    expect((await password(await startSignIn(), NEW_PASSWORD)).attempt.step.status).toBe('complete')
  })
})

describe('second factor', () => {
  const NEW_PASSWORD = 'a brand new passphrase 42'
  let required: ReturnType<typeof spyOn>
  let verifier: ReturnType<typeof spyOn>
  const GOOD = '424242'

  /** Every user has a TOTP factor and backup codes; `GOOD` is the code that verifies. */
  beforeEach(() => {
    required = spyOn(Factors, 'requiredFor').mockResolvedValue(['totp', 'backup_code'])
    verifier = spyOn(Factors, 'verify').mockImplementation(
      async (_deps, _tenant, _userId, proof) =>
        proof.response === GOOD ? { methods: ['otp'] } : null
    )
  })
  afterEach(() => {
    required.mockRestore()
    verifier.mockRestore()
  })

  const second = (
    attempt: Presented,
    response = GOOD,
    options: {
      kind?: 'sign_in' | 'sign_up' | 'password_reset'
      method?: Factors.SecondFactorProof['method']
      ctx?: Flows.ClientContext
      t?: Tenant
    } = {}
  ) =>
    Flows.submitSecondFactor(
      deps,
      options.t ?? tenant,
      options.kind ?? 'sign_in',
      ref(attempt),
      { method: options.method ?? 'totp', response },
      options.ctx ?? web
    )

  const liveSessions = (userId: string) =>
    deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())

  /** A verified user with a password, created without going through a flow. */
  async function user() {
    return seedUser()
  }

  test('a right password yields needs_second_factor: no tokens, no session, no secret', async () => {
    const userId = await user()
    const attempt = await startSignIn()
    const waiting = await password(attempt)
    expect(waiting.attempt).toEqual({
      id: attempt.id,
      kind: 'sign_in',
      expiresAt: attempt.expiresAt,
      step: { status: 'needs_second_factor', options: ['totp', 'backup_code'] },
    })
    expect(waiting.tokens).toBeUndefined()
    expect(await liveSessions(userId)).toEqual([])
    expect(deps.activityLog.ofType('session.created')).toEqual([])
    expect(required).toHaveBeenCalledWith(deps, tenant, userId)
    const stored = await deps.flowAttempts.findById(tenant.environmentId, attempt.id)
    expect(stored).toMatchObject({ status: 'needs_second_factor', userId, completedAt: null })
  })

  test('a wrong password never reaches the second factor, and never asks which the user has', async () => {
    await user()
    const attempt = await startSignIn()
    expect((await rejection(password(attempt, 'not the password'))).code).toBe(
      'auth.invalid_credentials'
    )
    expect(required).not.toHaveBeenCalled()
    expect((await rejection(second(attempt))).code).toBe('flow.invalid_step')
    expect(verifier).not.toHaveBeenCalled()
  })

  test('the right proof completes the sign-in with one session', async () => {
    const userId = await user()
    const attempt = await startSignIn(EMAIL, ios)
    await password(attempt, PASSWORD, ios)
    const done = await second(attempt, GOOD, { ctx: ios })
    expect(done.attempt.step).toEqual({
      status: 'complete',
      userId,
      sessionId: done.tokens?.sessionId as string,
    })
    expect(done.client).toBe('ios')
    expect(done.tokens?.refreshToken).toMatch(/^tula_rt_/)
    expect(verifier).toHaveBeenCalledWith(
      deps,
      tenant,
      userId,
      { method: 'totp', response: GOOD },
      { type: 'user', id: userId, ipAddress: null, userAgent: 'TulaSDK/1 iOS' }
    )
    expect((await liveSessions(userId)).map((session) => session.id)).toEqual([
      done.tokens?.sessionId as string,
    ])
    // Completed: neither step can be replayed.
    expect((await rejection(second(attempt, GOOD, { ctx: ios }))).code).toBe('flow.not_found')
    expect((await rejection(password(attempt, PASSWORD, ios))).code).toBe('flow.not_found')
  })

  test('a wrong proof is refused, creates nothing and leaves the attempt open', async () => {
    const userId = await user()
    const attempt = await startSignIn()
    await password(attempt)
    const err = await rejection(second(attempt, '000000'))
    expect(err.toJSON()).toMatchObject({ status: 422, code: 'mfa.invalid_code' })
    expect(await liveSessions(userId)).toEqual([])
    expect((await second(attempt)).attempt.step.status).toBe('complete')
  })

  test('wrong proofs back off per user, across attempts; a right one clears them', async () => {
    const userId = await user()
    const first = await startSignIn()
    await password(first)
    // The free tries, and the one failure that starts the first wait.
    for (let i = 0; i <= CREDENTIAL_LOCKOUT.freeAttempts; i++) {
      expect((await rejection(second(first, '000000'))).code).toBe('mfa.invalid_code')
    }
    // Locked: even the right code is refused, and the verifier is not consulted.
    verifier.mockClear()
    expect(await rejection(second(first))).toBeInstanceOf(RateLimitError)
    // A fresh attempt for the same user is locked too.
    const other = await startSignIn()
    await password(other)
    expect(await rejection(second(other))).toBeInstanceOf(RateLimitError)
    expect(verifier).not.toHaveBeenCalled()
    expect(await liveSessions(userId)).toEqual([])

    deps.clock.advance('1h')
    const again = await startSignIn()
    await password(again)
    expect((await second(again)).attempt.step.status).toBe('complete')
    // Cleared: the free tries are back.
    const fresh = await startSignIn()
    await password(fresh)
    expect((await rejection(second(fresh, '000000'))).code).toBe('mfa.invalid_code')
    expect((await second(fresh)).attempt.step.status).toBe('complete')
  })

  test('a method the attempt did not offer is refused without consulting a verifier', async () => {
    await user()
    const attempt = await startSignIn()
    await password(attempt)
    const lockout = spyOn(deps.lockout, 'attempt')
    try {
      const err = await rejection(second(attempt, GOOD, { method: 'passkey' }))
      expect(err.toJSON()).toMatchObject({ status: 409, code: 'flow.invalid_step' })
      expect(verifier).not.toHaveBeenCalled()
      expect(lockout).not.toHaveBeenCalled()
    } finally {
      lockout.mockRestore()
    }
    expect((await second(attempt, GOOD, { method: 'backup_code' })).attempt.step.status).toBe(
      'complete'
    )
  })

  test('the first factor cannot be replayed, and the email step cannot stand in for the second', async () => {
    const userId = await user()
    const attempt = await startSignIn()
    await password(attempt)
    expect((await rejection(password(attempt))).code).toBe('flow.invalid_step')
    expect(
      (await rejection(Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), '123456', web)))
        .code
    ).toBe('flow.invalid_step')
    expect(
      (await rejection(Flows.resendCode(deps, tenant, 'sign_in', ref(attempt), web))).code
    ).toBe('flow.invalid_step')
    expect(await liveSessions(userId)).toEqual([])
  })

  test('needs the attempt’s secret, its environment, its kind and an allowed origin', async () => {
    const userId = await user()
    const attempt = await startSignIn()
    await password(attempt)
    const withSecret = (attemptSecret: string | undefined) => ({ id: attempt.id, attemptSecret })
    for (const presented of [withSecret(undefined), withSecret('tula_at_made-up')]) {
      expect((await rejection(second(presented))).code).toBe('flow.not_found')
    }
    expect((await rejection(second(attempt, GOOD, { t: otherTenant }))).code).toBe('flow.not_found')
    expect((await rejection(second(attempt, GOOD, { kind: 'password_reset' }))).code).toBe(
      'flow.not_found'
    )
    expect((await rejection(second(attempt, GOOD, { ctx: foreign(web) }))).code).toBe(
      'request.origin_not_allowed'
    )
    expect(verifier).not.toHaveBeenCalled()
    expect(await liveSessions(userId)).toEqual([])
  })

  test('of two concurrent right proofs exactly one creates a session', async () => {
    const userId = await user()
    const attempt = await startSignIn()
    await password(attempt)
    const results = await Promise.allSettled([second(attempt), second(attempt)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const lost = results.find((result) => result.status === 'rejected')
    expect((lost as PromiseRejectedResult).reason).toMatchObject({ code: 'flow.invalid_step' })
    expect(await liveSessions(userId)).toHaveLength(1)
  })

  test('of two concurrent right passwords exactly one moves the attempt on', async () => {
    await user()
    const attempt = await startSignIn()
    const results = await Promise.allSettled([password(attempt), password(attempt)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })

  test('an expired attempt cannot be finished', async () => {
    const userId = await user()
    const attempt = await startSignIn()
    await password(attempt)
    deps.clock.advance(Flows.ATTEMPT_TTL)
    expect((await rejection(second(attempt))).code).toBe('flow.not_found')
    expect(await liveSessions(userId)).toEqual([])
  })

  test('a user banned or deleted in between is not signed in', async () => {
    const userId = await user()
    const banned = await startSignIn()
    await password(banned)
    await deps.users.setBanned(tenant.environmentId, userId, deps.clock.now(), deps.clock.now())
    // The ban is told only to someone who proved the factor.
    expect((await rejection(second(banned, '000000'))).code).toBe('mfa.invalid_code')
    expect((await rejection(second(banned))).code).toBe('auth.user_banned')
    expect(await liveSessions(userId)).toEqual([])

    await deps.users.setBanned(tenant.environmentId, userId, null, deps.clock.now())
    const deleted = await startSignIn()
    await password(deleted)
    await deps.users.delete(tenant.environmentId, userId)
    expect((await rejection(second(deleted))).code).toBe('mfa.invalid_code')
  })

  test('an unverified user verifies the email first, then the second factor', async () => {
    const userId = await seedUser({ verified: false })
    const attempt = await startSignIn()
    const first = await password(attempt)
    expect(first.attempt.step.status).toBe('needs_email_verification')
    // The second factor cannot be submitted ahead of the email step.
    expect((await rejection(second(attempt))).code).toBe('flow.invalid_step')

    const verified = await Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), sentCode(), web)
    expect(verified.attempt.step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code'],
    })
    expect(verified.tokens).toBeUndefined()
    expect(await liveSessions(userId)).toEqual([])
    expect(
      (await deps.users.findById(tenant.environmentId, userId))?.emailVerifiedAt
    ).not.toBeNull()

    const done = await second(attempt)
    expect(done.attempt.step).toMatchObject({ status: 'complete', userId })
    expect(await liveSessions(userId)).toHaveLength(1)
  })

  test('a sign-up never asks for a second factor: the account is created at that moment', async () => {
    const { attempt } = await signUp()
    const done = await Flows.verifyEmail(deps, tenant, 'sign_up', ref(attempt), sentCode(), web)
    expect(done.attempt.step.status).toBe('complete')
    expect(done.tokens?.accessToken).toBeString()
    expect(required).not.toHaveBeenCalled()
    expect((await rejection(second(attempt, GOOD, { kind: 'sign_up' }))).code).toBe(
      'flow.not_found'
    )
  })

  describe('password reset', () => {
    const startReset = () => Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)
    const reset = (attempt: Presented, code: string, pw = NEW_PASSWORD) =>
      Flows.resetPassword(deps, tenant, ref(attempt), { code, password: pw }, web)
    const stored = async () =>
      (await deps.users.findByEmailWithPassword(tenant.environmentId, NORMALIZED))?.passwordHash ??
      null

    /** A user with a live session from before the reset. */
    async function userWithSession() {
      const userId = await user()
      // Twice: when the password is accepted, and again once the session exists (`finish`).
      required.mockResolvedValueOnce([]).mockResolvedValueOnce([])
      const before = await password(await startSignIn())
      return { userId, sessionId: before.tokens?.sessionId as string }
    }

    test('stores the new password and ends old sessions, but does not sign in', async () => {
      const { userId, sessionId } = await userWithSession()
      const { attempt } = await startReset()
      const waiting = await reset(attempt, sentCode())

      expect(waiting.attempt.step).toEqual({
        status: 'needs_second_factor',
        options: ['totp', 'backup_code'],
      })
      expect(waiting.tokens).toBeUndefined()
      expect(waiting.attempt.attemptSecret).toBeUndefined()
      // The inbox was proven, so the password is replaced and the old sessions are gone...
      expect(await Passwords.verify(await stored(), NEW_PASSWORD)).toBe(true)
      expect(await deps.revokedSessions.has(sessionId, deps.clock.now())).toBe(true)
      // ...but no new session exists until the second factor is proven.
      expect(await liveSessions(userId)).toEqual([])
    })

    test('cannot be replayed to set the password again', async () => {
      await userWithSession()
      const { attempt } = await startReset()
      const code = sentCode()
      await reset(attempt, code)
      const hash = await stored()

      const replay = await rejection(reset(attempt, code, 'yet another passphrase 77'))
      expect(replay.toJSON()).toMatchObject({ status: 409, code: 'flow.invalid_step' })
      expect(await stored()).toBe(hash)
      expect(deps.activityLog.ofType('user.password_changed')).toHaveLength(1)
      // Nor can a fresh code be sent for it.
      deps.clock.advance(Verification.RESEND_COOLDOWN)
      expect(
        (await rejection(Flows.resendCode(deps, tenant, 'password_reset', ref(attempt), web))).code
      ).toBe('flow.invalid_step')
    })

    test('the second factor then signs the user in; the password change is not rolled back without it', async () => {
      const { userId } = await userWithSession()
      const { attempt } = await startReset()
      await reset(attempt, sentCode())

      expect((await rejection(second(attempt, '000000', { kind: 'password_reset' }))).code).toBe(
        'mfa.invalid_code'
      )
      expect(await Passwords.verify(await stored(), NEW_PASSWORD)).toBe(true)
      // A sign-in attempt's route cannot finish a reset attempt.
      expect((await rejection(second(attempt))).code).toBe('flow.not_found')

      const done = await second(attempt, GOOD, { kind: 'password_reset' })
      expect(done.attempt).toMatchObject({
        kind: 'password_reset',
        step: { status: 'complete', userId },
      })
      expect((await liveSessions(userId)).map((session) => session.id)).toEqual([
        done.tokens?.sessionId as string,
      ])
    })

    test('abandoned at the second factor, the new password stays and still needs the factor to sign in', async () => {
      const { userId } = await userWithSession()
      const { attempt } = await startReset()
      await reset(attempt, sentCode())
      deps.clock.advance(Flows.ATTEMPT_TTL)
      expect((await rejection(second(attempt, GOOD, { kind: 'password_reset' }))).code).toBe(
        'flow.not_found'
      )

      const signIn = await startSignIn()
      expect((await rejection(password(signIn, PASSWORD))).code).toBe('auth.invalid_credentials')
      expect((await password(signIn, NEW_PASSWORD)).attempt.step.status).toBe('needs_second_factor')
      expect(await liveSessions(userId)).toEqual([])
    })

    test('if the user’s factors cannot be read, nothing is spent or stored', async () => {
      await userWithSession()
      const { attempt } = await startReset()
      const code = sentCode()
      const before = await stored()
      required.mockRejectedValueOnce(new Error('factor store down'))
      await expect(reset(attempt, code)).rejects.toThrow('factor store down')
      expect(await stored()).toBe(before)
      // The same code still completes the reset.
      expect((await reset(attempt, code)).attempt.step.status).toBe('needs_second_factor')
    })

    test('a decoy reset never asks which factors anyone has', async () => {
      const { attempt } = await Flows.startPasswordReset(
        deps,
        tenant,
        { email: 'nobody@northline.app' },
        web
      )
      expect((await rejection(reset(attempt, '000000'))).code).toBe('verification.invalid_code')
      expect(required).not.toHaveBeenCalled()
    })
  })
})

describe('an attempt that changes underneath a request', () => {
  test('a password accepted for an attempt that has meanwhile moved on is refused', async () => {
    await seedUser({ verified: false })
    const attempt = await startSignIn()
    // Another request moved the attempt between this one's check and its own move.
    spy = spyOn(deps.flowAttempts, 'transition').mockResolvedValueOnce(false)
    const err = await rejection(password(attempt))
    expect(err.toJSON()).toMatchObject({ status: 409, code: 'flow.invalid_step' })
  })

  test('a sign-in whose user was deleted while they verified their email is refused', async () => {
    const userId = await seedUser({ verified: false })
    const attempt = await startSignIn()
    await password(attempt)
    const code = sentCode()
    await deps.users.delete(tenant.environmentId, userId)
    const err = await rejection(Flows.verifyEmail(deps, tenant, 'sign_in', ref(attempt), code, web))
    expect(err.toJSON()).toMatchObject({ status: 409, code: 'flow.invalid_step' })
    expect(deps.activityLog.ofType('session.created')).toEqual([])
  })
})
