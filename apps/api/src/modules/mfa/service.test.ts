import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type AccessTokenClaims,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  STEP_UP_MAX_AGE_SECONDS,
} from '@tula/contract'
import { users as usersTable, withTenant } from '@tula/db'
import { createTestDatabase, createTestTenant, queryRows } from '@tula/db/testing'
import { sql } from 'drizzle-orm'
import { PostgresFactorStore } from '~/adapters/postgres/factors'
import type { Tenant } from '~/dependencies'
import {
  NotFoundError,
  RateLimitError,
  ServiceException,
  ServiceUnavailableError,
} from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as logger from '~/lib/logger'
import { base32Decode, base32Encode, totp, totpStep } from '~/lib/totp'
import { verifyAccessToken } from '~/middleware/session-auth'
import * as Factors from '~/modules/factor/service'
import * as Flows from '~/modules/flow/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Verification from '~/modules/verification/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import type { UserRecord } from '~/ports/user-repository'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
// One argon2 hash for the whole file: hashing per test would dominate its run time.
const PASSWORD_HASH = await Passwords.hash(PASSWORD)
const ios: Flows.ClientContext = {
  client: 'ios',
  userAgent: 'TulaSDK/1 iOS',
  ipAddress: null,
  originAllowed: true,
}
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

const spies: ReturnType<typeof spyOn>[] = []
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

const actorOf = (userId: string): Actor => ({
  type: 'user',
  id: userId,
  ipAddress: '203.0.113.7',
  userAgent: 'tula-tests/1.0',
})

/** A verified user, with a password unless `password` is `null`. */
async function seedUser(
  options: { email?: string; password?: boolean; verified?: boolean; scope?: Tenant } = {}
): Promise<UserRecord> {
  const scope = options.scope ?? tenant
  const email = options.email ?? EMAIL
  const id = deps.ids.next()
  await deps.users.create({
    id,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
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
  return (await deps.users.findById(scope.environmentId, id)) as UserRecord
}

/** The code an authenticator holding `secret` shows now, or `steps` time steps away. */
const codeFor = (secret: string, steps = 0) =>
  totp(base32Decode(secret), new Date(deps.clock.now().getTime() + steps * 30_000))

const newSession = (userId: string, authMethods: string[] = ['pwd'], scope = tenant) =>
  Sessions.create(deps, scope, { userId, client: 'web', userAgent: 'Mozilla/5.0', authMethods })

const claimsOf = (accessToken: string) => verifyAccessToken(deps, accessToken, tenant)

/** Turn two-step verification on for a user; the confirming code's step is then spent. */
async function enrol(userId: string, sessionId?: string, scope = tenant) {
  const enrolment = await Mfa.startTotp(deps, scope, userId)
  const { codes } = await Mfa.confirmTotp(
    deps,
    scope,
    { userId, ...(sessionId && { sessionId }) },
    codeFor(enrolment.secret),
    actorOf(userId)
  )
  await Notices.settled()
  deps.clock.advance('30s')
  return { ...enrolment, codes }
}

function configure(change: Partial<EnvironmentSettings>, scope = tenant) {
  deps.environmentSettings.seed(scope.environmentId, {
    revision: 1,
    settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, ...change },
  })
}
const policy = (value: EnvironmentSettings['mfa']['policy']) =>
  configure({ mfa: { policy: value } })

const stepUp = (userId: string, sessionId: string, proof: Parameters<typeof Mfa.stepUp>[3]) =>
  Mfa.stepUp(deps, tenant, { userId, sessionId }, proof, {
    ipAddress: '203.0.113.7',
    userAgent: 'tula-tests/1.0',
  })

const liveSessions = (userId: string) =>
  deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())

describe('startTotp', () => {
  test('returns a 160-bit secret and its URI, and stores only the sealed secret, pending', async () => {
    const user = await seedUser()
    const enrolment = await Mfa.startTotp(deps, tenant, user.id)
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(enrolment.uri).toBe(
      `otpauth://totp/Tula:maya%40northline.app?secret=${enrolment.secret}` +
        '&issuer=Tula&algorithm=SHA1&digits=6&period=30'
    )
    const stored = await deps.factors.findTotp(tenant.environmentId, user.id)
    expect(stored).toMatchObject({
      userId: user.id,
      type: 'totp',
      confirmedAt: null,
      lastUsedStep: null,
      expiresAt: new Date(deps.clock.now().getTime() + 600_000),
    })
    expect(stored?.secret).toMatch(/^v1\./)
    expect(JSON.stringify(stored)).not.toContain(enrolment.secret)
    // Nothing is recorded or sent for an enrolment that was only started.
    expect(deps.activityLog.entries).toEqual([])
    await Notices.settled()
    expect(deps.mailer.outbox).toEqual([])
  })

  test('names the environment’s app in the URI', async () => {
    configure({ app: { ...DEFAULT_ENVIRONMENT_SETTINGS.app, name: 'Northline: Staging & Co' } })
    const user = await seedUser()
    const { uri } = await Mfa.startTotp(deps, tenant, user.id)
    expect(
      uri.startsWith('otpauth://totp/Northline%20Staging%20%26%20Co:maya%40northline.app?')
    ).toBe(true)
  })

  test('a pending enrolment counts for nothing: not required, not enabled, never verified', async () => {
    const user = await seedUser()
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    const used = spyOn(deps.factors, 'useTotpStep')
    spies.push(used)

    expect(await Factors.requiredFor(deps, tenant, user.id)).toEqual([])
    expect(await Mfa.secondFactors(deps, tenant, user.id)).toEqual([])
    expect(await Mfa.status(deps, tenant, user.id)).toEqual({
      totp: { enabled: false, confirmedAt: null },
      backupCodes: { remaining: 0 },
    })
    expect(await Mfa.stepUpMethods(deps, tenant, user.id)).toEqual(['password', 'email_code'])
    // The right code of a factor that was never confirmed proves nothing.
    expect(await Mfa.verifyTotp(deps, tenant, user.id, codeFor(secret))).toBe(false)
    expect(used).not.toHaveBeenCalled()
    expect(
      await Factors.verify(
        deps,
        tenant,
        user.id,
        { method: 'totp', response: codeFor(secret) },
        actorOf(user.id)
      )
    ).toBeNull()
  })

  test('starting again replaces the pending secret: the earlier one no longer confirms', async () => {
    const user = await seedUser()
    const first = await Mfa.startTotp(deps, tenant, user.id)
    const second = await Mfa.startTotp(deps, tenant, user.id)
    expect(second.secret).not.toBe(first.secret)
    const err = await rejection(
      Mfa.confirmTotp(deps, tenant, { userId: user.id }, codeFor(first.secret), actorOf(user.id))
    )
    expect(err.code).toBe('mfa.invalid_code')
    const { codes } = await Mfa.confirmTotp(
      deps,
      tenant,
      { userId: user.id },
      codeFor(second.secret),
      actorOf(user.id)
    )
    expect(codes).toHaveLength(10)
  })

  test('is refused for a user who already has a confirmed authenticator', async () => {
    const user = await seedUser()
    await enrol(user.id)
    const before = await deps.factors.findTotp(tenant.environmentId, user.id)
    const err = await rejection(Mfa.startTotp(deps, tenant, user.id))
    expect(err.toJSON()).toMatchObject({ status: 409, code: 'mfa.already_enabled' })
    expect(await deps.factors.findTotp(tenant.environmentId, user.id)).toEqual(before)
  })

  test('an unknown user, or one of another environment, is not found', async () => {
    const user = await seedUser()
    expect(await Mfa.startTotp(deps, tenant, deps.ids.next()).catch((err) => err)).toBeInstanceOf(
      NotFoundError
    )
    expect(await Mfa.startTotp(deps, otherTenant, user.id).catch((err) => err)).toBeInstanceOf(
      NotFoundError
    )
    expect(await deps.factors.findTotp(otherTenant.environmentId, user.id)).toBeNull()
  })
})

describe('confirmTotp', () => {
  const confirm = (userId: string, code: string, sessionId?: string) =>
    Mfa.confirmTotp(
      deps,
      tenant,
      { userId, ...(sessionId && { sessionId }) },
      code,
      actorOf(userId)
    )

  test('turns the factor on, spends the confirming step, returns ten codes and records it', async () => {
    const user = await seedUser()
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    const code = codeFor(secret)
    const { codes } = await confirm(user.id, code)

    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const backup of codes) {
      expect(backup).toMatch(/^[2-9a-hjkmnp-z]{5}-[2-9a-hjkmnp-z]{5}$/)
    }
    expect(await Mfa.status(deps, tenant, user.id)).toEqual({
      totp: { enabled: true, confirmedAt: deps.clock.now().toISOString() },
      backupCodes: { remaining: 10 },
    })
    expect(await Factors.requiredFor(deps, tenant, user.id)).toEqual(['totp', 'backup_code'])
    expect(await deps.factors.findTotp(tenant.environmentId, user.id)).toMatchObject({
      expiresAt: null,
      lastUsedStep: totpStep(deps.clock.now()),
    })
    // The code that confirmed the enrolment does not also sign anyone in.
    expect(await Mfa.verifyTotp(deps, tenant, user.id, code)).toBe(false)
    expect(deps.activityLog.ofType('user.mfa_enabled')).toEqual([
      expect.objectContaining({
        actor: { type: 'user', id: user.id },
        target: { type: 'user', id: user.id },
        ipAddress: '203.0.113.7',
        userAgent: 'tula-tests/1.0',
        data: { method: 'totp' },
      }),
    ])
  })

  test('with nothing pending the enrolment has expired, and no guess is counted', async () => {
    const user = await seedUser()
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)
    const err = await rejection(confirm(user.id, '123456'))
    expect(err.toJSON()).toMatchObject({ status: 410, code: 'mfa.enrolment_expired' })
    expect(counted).not.toHaveBeenCalled()
  })

  test('a pending enrolment lapses after ten minutes, to the millisecond', async () => {
    expect(Mfa.PENDING_ENROLMENT_TTL).toBe('10m')
    const user = await seedUser()
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    deps.clock.advance('10m')
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)
    expect((await rejection(confirm(user.id, codeFor(secret)))).code).toBe('mfa.enrolment_expired')
    expect(counted).not.toHaveBeenCalled()
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ totp: { enabled: false } })
    expect(deps.activityLog.ofType('user.mfa_enabled')).toEqual([])

    // One millisecond inside the window it still confirms.
    const fresh = await Mfa.startTotp(deps, tenant, user.id)
    deps.clock.advance(600_000 - 1)
    expect((await confirm(user.id, codeFor(fresh.secret))).codes).toHaveLength(10)
  })

  test('an enrolment that lapses between the check and the write is refused', async () => {
    const user = await seedUser()
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    spies.push(spyOn(deps.factors, 'confirmTotp').mockResolvedValueOnce(false))
    expect((await rejection(confirm(user.id, codeFor(secret)))).code).toBe('mfa.enrolment_expired')
    await Notices.settled()
    expect(deps.mailer.outbox).toEqual([])
  })

  test('a wrong code is refused and changes nothing', async () => {
    const user = await seedUser()
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    const session = await newSession(user.id)
    for (const code of ['000000', codeFor(secret, 2), codeFor(secret, -2), '12345', '']) {
      if (code === codeFor(secret)) {
        continue
      }
      const err = await rejection(confirm(user.id, code, session.sessionId))
      expect(err.toJSON()).toMatchObject({ status: 422, code: 'mfa.invalid_code' })
    }
    expect(await Mfa.status(deps, tenant, user.id)).toEqual({
      totp: { enabled: false, confirmedAt: null },
      backupCodes: { remaining: 0 },
    })
    expect(deps.activityLog.ofType('user.mfa_enabled')).toEqual([])
    expect(await liveSessions(user.id)).toHaveLength(1)
    await Notices.settled()
    expect(deps.mailer.outbox).toEqual([])
  })

  test('accepts the code of the step before or after: a phone’s clock may be off', async () => {
    for (const [index, drift] of [-1, 1].entries()) {
      const user = await seedUser({ email: `drift-${index}@northline.app` })
      const { secret } = await Mfa.startTotp(deps, tenant, user.id)
      expect((await confirm(user.id, codeFor(secret, drift))).codes).toHaveLength(10)
    }
  })

  test('a confirmed factor cannot be confirmed again', async () => {
    const user = await seedUser()
    const { secret } = await enrol(user.id)
    const err = await rejection(confirm(user.id, codeFor(secret)))
    expect(err.toJSON()).toMatchObject({ status: 409, code: 'mfa.already_enabled' })
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({
      backupCodes: { remaining: 10 },
    })
  })

  test('a user deleted in between cannot confirm', async () => {
    const user = await seedUser()
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    await deps.users.delete(tenant.environmentId, user.id)
    expect((await rejection(confirm(user.id, codeFor(secret)))).code).toBe('mfa.enrolment_expired')
  })

  test('of two concurrent confirmations exactly one succeeds, with exactly one set of codes', async () => {
    const user = await seedUser()
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    const code = codeFor(secret)
    const results = await Promise.allSettled([confirm(user.id, code), confirm(user.id, code)])
    const won = results.filter((result) => result.status === 'fulfilled')
    const lost = results.filter((result) => result.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(['mfa.enrolment_expired', 'mfa.already_enabled']).toContain(
      (lost[0] as PromiseRejectedResult).reason.code
    )
    expect(await deps.factors.countBackupCodes(tenant.environmentId, user.id)).toBe(10)
    expect(deps.activityLog.ofType('user.mfa_enabled')).toHaveLength(1)
    // The codes the winner was shown are the ones stored.
    const { codes } = (won[0] as PromiseFulfilledResult<{ codes: string[] }>).value
    for (const [index, backup] of codes.entries()) {
      expect(await Mfa.verifyBackupCode(deps, tenant, user.id, backup, actorOf(user.id))).toBe(
        9 - index
      )
    }
    await Notices.settled()
  })

  test('ends the user’s other sessions and keeps the current one, marked as having proven the factor', async () => {
    const user = await seedUser()
    const current = await newSession(user.id)
    const other = await newSession(user.id)
    const bystander = await seedUser({ email: 'someone@northline.app' })
    const theirs = await newSession(bystander.id)
    deps.clock.advance('5m')
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    await confirm(user.id, codeFor(secret), current.sessionId)
    const now = deps.clock.now()

    expect((await liveSessions(user.id)).map((session) => session.id)).toEqual([current.sessionId])
    expect(await deps.sessions.findById(tenant.environmentId, other.sessionId)).toMatchObject({
      revokedAt: now,
      revokeReason: 'mfa_changed',
    })
    // Denylisted, so the other session's access token stops working at once.
    expect(await deps.revokedSessions.has(other.sessionId, now)).toBe(true)
    expect(await deps.revokedSessions.has(current.sessionId, now)).toBe(false)
    expect(await deps.revokedSessions.has(theirs.sessionId, now)).toBe(false)
    expect(await deps.sessions.findById(tenant.environmentId, current.sessionId)).toMatchObject({
      factorVerifiedAt: now,
      authMethods: ['pwd', 'otp', 'mfa'],
      revokedAt: null,
    })
    expect(deps.activityLog.ofType('session.stepped_up')).toEqual([
      expect.objectContaining({
        target: { type: 'session', id: current.sessionId },
        data: { userId: user.id, methods: ['otp', 'mfa'] },
      }),
    ])
    // The kept session's next access token says so.
    const refreshed = await Sessions.refresh(deps, tenant, current.refreshToken as string)
    expect(await claimsOf(refreshed.accessToken)).toMatchObject({
      amr: ['pwd', 'otp', 'mfa'],
      auth_time: Math.floor(now.getTime() / 1000),
    })
  })

  test('without a current session every session of the user ends', async () => {
    const user = await seedUser()
    const first = await newSession(user.id)
    const second = await newSession(user.id)
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    await confirm(user.id, codeFor(secret))
    expect(await liveSessions(user.id)).toEqual([])
    for (const session of [first, second]) {
      expect(await deps.revokedSessions.has(session.sessionId, deps.clock.now())).toBe(true)
    }
    expect(deps.activityLog.ofType('session.stepped_up')).toEqual([])
  })

  test('the codes still reach the user when the enrolling session cannot be marked', async () => {
    const user = await seedUser()
    const session = await newSession(user.id)
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    const warned = spyOn(logger, 'warn').mockImplementation(() => {})
    spies.push(warned)
    spies.push(
      spyOn(deps.sessions, 'recordAuthentication').mockRejectedValueOnce(new Error('store down'))
    )
    const { codes } = await confirm(user.id, codeFor(secret), session.sessionId)
    expect(codes).toHaveLength(10)
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ totp: { enabled: true } })
    expect(warned).toHaveBeenCalledWith(
      'could not mark the enrolling session as having proven the factor',
      { environmentId: tenant.environmentId, err: 'Error' }
    )

    // The same when what fails is not an Error at all.
    const second = await seedUser({ email: 'second@northline.app' })
    const theirs = await newSession(second.id)
    const started = await Mfa.startTotp(deps, tenant, second.id)
    spies.push(spyOn(deps.sessions, 'recordAuthentication').mockRejectedValueOnce('nope'))
    expect(
      (await confirm(second.id, codeFor(started.secret), theirs.sessionId)).codes
    ).toHaveLength(10)
    expect(warned).toHaveBeenLastCalledWith(expect.any(String), {
      environmentId: tenant.environmentId,
      err: 'unknown',
    })
  })
})

describe('a sealed secret is bound to its environment, user and row', () => {
  /**
   * Store a confirmed factor row directly, as a copied database row would be. It is the only
   * factor row left: the memory store finds a row by id, and two of the cases reuse one.
   */
  async function plant(
    row: { environmentId: string; userId: string; id: string; secret: string },
    others: readonly string[] = []
  ) {
    const at = deps.clock.now()
    for (const environmentId of [tenant.environmentId, otherTenant.environmentId]) {
      for (const userId of [row.userId, ...others]) {
        await deps.factors.removeForUser(environmentId, userId)
      }
    }
    expect(
      await deps.factors.startTotp({
        ...row,
        projectId: tenant.projectId,
        type: 'totp',
        createdAt: at,
        expiresAt: new Date(at.getTime() + 600_000),
      })
    ).toBe(true)
    expect(
      await deps.factors.confirmTotp(row.environmentId, row.id, { step: 0, at, backupCodes: [] })
    ).toBe(true)
  }

  test('a ciphertext copied to another user, row or environment opens for nobody', async () => {
    const victim = await seedUser()
    const thief = await seedUser({ email: 'thief@northline.app' })
    const { secret } = await enrol(victim.id)
    const original = await deps.factors.findTotp(tenant.environmentId, victim.id)
    if (!original) {
      throw new Error('expected a factor')
    }
    const warned = spyOn(logger, 'warn').mockImplementation(() => {})
    spies.push(warned)
    const used = spyOn(deps.factors, 'useTotpStep')
    spies.push(used)

    const copies: [string, Tenant, { userId: string; id: string; secret: string }][] = [
      [
        'another user, a new row',
        tenant,
        { userId: thief.id, id: deps.ids.next(), secret: original.secret },
      ],
      [
        'another user, the same row id',
        tenant,
        { userId: thief.id, id: original.id, secret: original.secret },
      ],
      [
        'the same user and row id in another environment',
        otherTenant,
        { userId: victim.id, id: original.id, secret: original.secret },
      ],
      [
        'the same user, another row id',
        tenant,
        { userId: victim.id, id: deps.ids.next(), secret: original.secret },
      ],
      [
        'the same row with one character of the ciphertext changed',
        tenant,
        {
          userId: victim.id,
          id: original.id,
          secret: `${original.secret.slice(0, -1)}${original.secret.endsWith('A') ? 'B' : 'A'}`,
        },
      ],
      [
        'a row that holds no ciphertext at all',
        tenant,
        { userId: thief.id, id: deps.ids.next(), secret: 'x' },
      ],
    ]
    for (const [what, scope, row] of copies) {
      await plant({ environmentId: scope.environmentId, ...row }, [victim.id, thief.id])
      warned.mockClear()
      // The victim's authenticator shows this code now; it must prove nothing for the copy.
      expect([what, await Mfa.verifyTotp(deps, scope, row.userId, codeFor(secret))]).toEqual([
        what,
        false,
      ])
      expect(
        await Factors.verify(
          deps,
          scope,
          row.userId,
          { method: 'totp', response: codeFor(secret) },
          actorOf(row.userId)
        )
      ).toBeNull()
      // Logged without anything about the secret.
      expect(warned).toHaveBeenCalledWith('a TOTP secret could not be opened', {
        environmentId: scope.environmentId,
        userId: row.userId,
      })
    }
    expect(used).not.toHaveBeenCalled()

    // The same ciphertext back in its own row, for its own user, opens: the binding is the
    // only thing that differed above.
    await plant(original, [victim.id, thief.id])
    expect(await Mfa.verifyTotp(deps, tenant, victim.id, codeFor(secret))).toBe(true)
  })

  test('a pending enrolment holding a copied ciphertext cannot be confirmed with the victim’s code', async () => {
    const victim = await seedUser()
    const thief = await seedUser({ email: 'thief@northline.app' })
    const { secret } = await enrol(victim.id)
    const original = await deps.factors.findTotp(tenant.environmentId, victim.id)
    spies.push(spyOn(logger, 'warn').mockImplementation(() => {}))
    await deps.factors.startTotp({
      id: deps.ids.next(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      userId: thief.id,
      type: 'totp',
      secret: original?.secret as string,
      createdAt: deps.clock.now(),
      expiresAt: new Date(deps.clock.now().getTime() + 600_000),
    })
    const err = await rejection(
      Mfa.confirmTotp(deps, tenant, { userId: thief.id }, codeFor(secret), actorOf(thief.id))
    )
    expect(err.code).toBe('mfa.invalid_code')
    expect(await Mfa.status(deps, tenant, thief.id)).toMatchObject({ totp: { enabled: false } })
  })

  test('a secret sealed under another master key opens for nobody', async () => {
    const user = await seedUser()
    const { secret } = await enrol(user.id)
    spies.push(spyOn(logger, 'warn').mockImplementation(() => {}))
    const rotated = createTestDeps({
      secretBox: (await import('~/lib/secret-box')).createSecretBox('cd'.repeat(32)),
    })
    expect(
      await Mfa.verifyTotp(
        { factors: deps.factors, clock: deps.clock, secretBox: rotated.secretBox },
        tenant,
        user.id,
        codeFor(secret)
      )
    ).toBe(false)
    expect(await Mfa.verifyTotp(deps, tenant, user.id, codeFor(secret))).toBe(true)
  })
})

describe('verifyTotp: a code works once', () => {
  test('the same code is refused the second time', async () => {
    const user = await seedUser()
    const { secret } = await enrol(user.id)
    const code = codeFor(secret)
    expect(await Mfa.verifyTotp(deps, tenant, user.id, code)).toBe(true)
    expect(await Mfa.verifyTotp(deps, tenant, user.id, code)).toBe(false)
    // Still refused later in the same step and in the next one (it is then the previous step's).
    deps.clock.advance('30s')
    expect(await Mfa.verifyTotp(deps, tenant, user.id, code)).toBe(false)
    expect(await Mfa.verifyTotp(deps, tenant, user.id, codeFor(secret))).toBe(true)
  })

  test('of concurrent submissions of one code exactly one is accepted', async () => {
    const user = await seedUser()
    const { secret } = await enrol(user.id)
    const code = codeFor(secret)
    const results = await Promise.all(
      Array.from({ length: 8 }, () => Mfa.verifyTotp(deps, tenant, user.id, code))
    )
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  test('the previous step’s code is refused once a newer step was used', async () => {
    const user = await seedUser()
    const { secret } = await enrol(user.id)
    deps.clock.advance('30s')
    const previous = codeFor(secret, -1)
    const current = codeFor(secret)
    const next = codeFor(secret, 1)
    expect(await Mfa.verifyTotp(deps, tenant, user.id, current)).toBe(true)
    // Inside the drift window, but older than what was already used.
    expect(await Mfa.verifyTotp(deps, tenant, user.id, previous)).toBe(false)
    expect(await Mfa.verifyTotp(deps, tenant, user.id, next)).toBe(true)
    expect(await Mfa.verifyTotp(deps, tenant, user.id, current)).toBe(false)
  })

  test('the previous step’s code is accepted when nothing newer was used', async () => {
    const user = await seedUser()
    const { secret } = await enrol(user.id)
    deps.clock.advance('1m')
    expect(await Mfa.verifyTotp(deps, tenant, user.id, codeFor(secret, -1))).toBe(true)
    expect(await Mfa.verifyTotp(deps, tenant, user.id, codeFor(secret))).toBe(true)
  })

  test.each<[string, unknown]>([
    ['a wrong code', '000000'],
    ['a code two steps old', 'two-steps-old'],
    ['a code two steps ahead', 'two-steps-ahead'],
    ['a number', 123456],
    ['nothing', undefined],
    ['null', null],
    ['an object', { code: '123456' }],
    ['a backup code', 'abcde-fghjk'],
  ])('%s is refused and uses no step', async (_, submitted) => {
    const user = await seedUser()
    const { secret } = await enrol(user.id)
    const code =
      submitted === 'two-steps-old'
        ? codeFor(secret, -2)
        : submitted === 'two-steps-ahead'
          ? codeFor(secret, 2)
          : submitted
    const before = await deps.factors.findTotp(tenant.environmentId, user.id)
    if (code !== codeFor(secret) && code !== codeFor(secret, 1) && code !== codeFor(secret, -1)) {
      expect(await Mfa.verifyTotp(deps, tenant, user.id, code)).toBe(false)
      expect(await deps.factors.findTotp(tenant.environmentId, user.id)).toEqual(before)
    }
  })

  test('a user with no factor, or of another environment, proves nothing', async () => {
    const user = await seedUser()
    const { secret } = await enrol(user.id)
    const nobody = await seedUser({ email: 'nobody@northline.app' })
    expect(await Mfa.verifyTotp(deps, tenant, nobody.id, codeFor(secret))).toBe(false)
    expect(await Mfa.verifyTotp(deps, otherTenant, user.id, codeFor(secret))).toBe(false)
    expect(await Mfa.secondFactors(deps, otherTenant, user.id)).toEqual([])
  })
})

describe('verifyBackupCode', () => {
  const spend = (userId: string, code: unknown, scope = tenant) =>
    Mfa.verifyBackupCode(deps, scope, userId, code, actorOf(userId))

  test('normalizeBackupCode ignores case, spaces and dashes', () => {
    for (const typed of [
      'ABCDE-FGHJK',
      'abcdefghjk',
      ' abcde fghjk ',
      'ab-cd-ef-gh-jk',
      'Abcde\tFghjk\n',
    ]) {
      expect(Mfa.normalizeBackupCode(typed)).toBe('abcdefghjk')
    }
  })

  test('a code works however it is typed: capitals, spaces, without its dash', async () => {
    const user = await seedUser()
    const { codes } = await enrol(user.id)
    const [first, second, third, fourth] = codes as [string, string, string, string]
    expect(await spend(user.id, first.toUpperCase())).toBe(9)
    expect(await spend(user.id, ` ${second.replace('-', ' ')} `)).toBe(8)
    expect(await spend(user.id, third.replace('-', ''))).toBe(7)
    expect(await spend(user.id, fourth)).toBe(6)
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ backupCodes: { remaining: 6 } })
  })

  test('a code works once, and its use is recorded and told to the owner with how many are left', async () => {
    const user = await seedUser()
    const { codes } = await enrol(user.id)
    const sent = deps.mailer.outbox.length
    expect(await spend(user.id, codes[0])).toBe(9)
    expect(await spend(user.id, codes[0])).toBeNull()
    expect(await spend(user.id, (codes[0] as string).toUpperCase())).toBeNull()
    await Notices.settled()

    expect(deps.activityLog.ofType('user.backup_code_used')).toEqual([
      expect.objectContaining({
        actor: { type: 'user', id: user.id },
        target: { type: 'user', id: user.id },
        ipAddress: '203.0.113.7',
        data: {},
      }),
    ])
    const notices = deps.mailer.outbox.slice(sent)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      to: EMAIL,
      subject: 'A backup code was used to sign in to your Tula account',
    })
    expect(notices[0]?.text).toContain('Backup codes left: 9')
    expect(notices[0]?.text).not.toContain(codes[0] as string)
  })

  test('of concurrent submissions of one code exactly one spends it', async () => {
    const user = await seedUser()
    const { codes } = await enrol(user.id)
    const results = await Promise.all(Array.from({ length: 8 }, () => spend(user.id, codes[0])))
    expect(results.filter((result) => result !== null)).toEqual([9])
    expect(deps.activityLog.ofType('user.backup_code_used')).toHaveLength(1)
  })

  test('another user’s code is refused and stays unused', async () => {
    const owner = await seedUser()
    const other = await seedUser({ email: 'other@northline.app' })
    const { codes } = await enrol(owner.id)
    await enrol(other.id)
    expect(await spend(other.id, codes[0])).toBeNull()
    expect(await Mfa.status(deps, tenant, other.id)).toMatchObject({
      backupCodes: { remaining: 10 },
    })
    // Nor does it work for the same user id in another environment.
    expect(await spend(owner.id, codes[0], otherTenant)).toBeNull()
    expect(deps.activityLog.ofType('user.backup_code_used')).toEqual([])
    expect(await spend(owner.id, codes[0])).toBe(9)
  })

  test.each<[string, unknown]>([
    ['a made-up code', 'zzzzz-zzzzz'],
    ['an empty string', ''],
    ['a number', 1234567890],
    ['nothing', undefined],
    ['an array', ['abcde-fghjk']],
  ])('%s spends nothing and records nothing', async (_, submitted) => {
    const user = await seedUser()
    await enrol(user.id)
    const sent = deps.mailer.outbox.length
    expect(await spend(user.id, submitted)).toBeNull()
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({
      backupCodes: { remaining: 10 },
    })
    expect(deps.activityLog.ofType('user.backup_code_used')).toEqual([])
    await Notices.settled()
    expect(deps.mailer.outbox).toHaveLength(sent)
  })

  test('a code spent for a user who was deleted meanwhile sends no notice', async () => {
    const user = await seedUser()
    const { codes } = await enrol(user.id)
    const sent = deps.mailer.outbox.length
    await deps.users.delete(tenant.environmentId, user.id)
    expect(await spend(user.id, codes[0])).toBe(9)
    await Notices.settled()
    expect(deps.mailer.outbox).toHaveLength(sent)
  })

  test('the store is only ever handed keyed hashes, bound to the user', async () => {
    const user = await seedUser()
    const confirmed = spyOn(deps.factors, 'confirmTotp')
    const replaced = spyOn(deps.factors, 'replaceBackupCodes')
    const consumed = spyOn(deps.factors, 'consumeBackupCode')
    spies.push(confirmed, replaced, consumed)
    const { codes } = await enrol(user.id)
    const fresh = await Mfa.regenerateBackupCodes(deps, tenant, user.id, actorOf(user.id))
    await spend(user.id, fresh.codes[0])

    const handed = JSON.stringify([confirmed.mock.calls, replaced.mock.calls, consumed.mock.calls])
    for (const code of [...codes, ...fresh.codes]) {
      expect(handed).not.toContain(code)
      expect(handed).not.toContain(Mfa.normalizeBackupCode(code))
    }
    const stored = confirmed.mock.calls[0]?.[2].backupCodes ?? []
    expect(stored).toHaveLength(10)
    for (const row of stored) {
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/)
    }
    // The hash is keyed and bound to environment and user: the same code hashes differently
    // for anyone else, and a plain SHA-256 of the code is not what is stored.
    const hashOf = (environmentId: string, userId: string, code: string) =>
      deps.keyedHash.hmac(
        Mfa.BACKUP_CODE_PURPOSE,
        `${environmentId}:${userId}:${Mfa.normalizeBackupCode(code)}`
      )
    const hashes = stored.map((row) => row.codeHash)
    expect(hashes).toContain(await hashOf(tenant.environmentId, user.id, codes[0] as string))
    expect(hashes).not.toContain(
      await hashOf(tenant.environmentId, 'someone-else', codes[0] as string)
    )
    expect(hashes).not.toContain(
      await hashOf(otherTenant.environmentId, user.id, codes[0] as string)
    )
    expect(hashes).not.toContain(
      new Bun.CryptoHasher('sha256')
        .update(Mfa.normalizeBackupCode(codes[0] as string))
        .digest('hex')
    )
  })

  test('codes are drawn from the unambiguous alphabet, each character about equally often', async () => {
    expect(Mfa.BACKUP_CODE_ALPHABET).toHaveLength(31)
    expect(Mfa.BACKUP_CODE_ALPHABET).not.toMatch(/[01ilo]/)
    expect(Mfa.BACKUP_CODE_LENGTH).toBe(10)
    const user = await seedUser()
    await enrol(user.id)
    const counts = new Map<string, number>()
    for (let round = 0; round < 40; round++) {
      const { codes } = await Mfa.regenerateBackupCodes(deps, tenant, user.id, actorOf(user.id))
      for (const character of codes.join('').replaceAll('-', '')) {
        counts.set(character, (counts.get(character) ?? 0) + 1)
      }
    }
    await Notices.settled()
    // 4,000 characters over 31 symbols: about 129 each. A `% 31` of raw bytes would favour
    // the first eight by a quarter; this only catches a gross bias or a missing symbol.
    expect([...counts.keys()].sort().join('')).toBe(Mfa.BACKUP_CODE_ALPHABET)
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(70)
      expect(count).toBeLessThan(200)
    }
  })
})

describe('the database holds no secret and no code', () => {
  test('only the sealed secret and keyed hashes are stored, and the audit log names neither', async () => {
    const testDb = await createTestDatabase()
    try {
      const created = await createTestTenant(testDb.db)
      const scope: Tenant = {
        projectId: created.projectId,
        environmentId: created.environmentId,
        apiKeyId: 'key_1',
      }
      build({ factors: new PostgresFactorStore(testDb.db) as never })
      deps.environments.add({
        id: scope.environmentId,
        projectId: scope.projectId,
        kind: 'development',
        createdAt: deps.clock.now(),
      })
      const user = await seedUser({ scope })
      await withTenant(testDb.db, scope.environmentId, (tx) =>
        tx.insert(usersTable).values({
          id: user.id,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          email: user.email,
          emailNormalized: user.emailNormalized,
        })
      )

      const enrolment = await Mfa.startTotp(deps, scope, user.id)
      const totpCode = codeFor(enrolment.secret)
      const { codes } = await Mfa.confirmTotp(
        deps,
        scope,
        { userId: user.id },
        totpCode,
        actorOf(user.id)
      )
      deps.clock.advance('30s')
      expect(await Mfa.verifyTotp(deps, scope, user.id, codeFor(enrolment.secret))).toBe(true)
      expect(await Mfa.verifyBackupCode(deps, scope, user.id, codes[0], actorOf(user.id))).toBe(9)
      const fresh = await Mfa.regenerateBackupCodes(deps, scope, user.id, actorOf(user.id))
      await Notices.settled()

      await testDb.setRole('postgres')
      const tables = ['user_factors', 'backup_codes', 'audit_logs', 'events']
      const dump: Record<string, unknown[]> = {}
      for (const table of tables) {
        dump[table] = await queryRows<Record<string, unknown>>(
          testDb.db,
          sql.raw(`select * from tula.${table}`)
        )
      }
      expect(dump.user_factors).toHaveLength(1)
      expect(dump.backup_codes).toHaveLength(10)
      expect(dump.audit_logs?.length).toBeGreaterThanOrEqual(3)

      const stored = JSON.stringify(dump).toLowerCase()
      const raw = Buffer.from(base32Decode(enrolment.secret))
      for (const secret of [
        enrolment.secret,
        raw.toString('hex'),
        raw.toString('base64'),
        raw.toString('base64url'),
        'otpauth',
        ...[...codes, ...fresh.codes].flatMap((code) => [code, Mfa.normalizeBackupCode(code)]),
      ]) {
        expect(stored).not.toContain(secret.toLowerCase())
      }
      const [factorRow] = dump.user_factors as { secret: string }[]
      expect(factorRow?.secret).toMatch(/^v1\.[\w-]+\.[\w-]+$/)
      for (const row of dump.backup_codes as { code_hash: string }[]) {
        expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/)
      }
      // The Base32 form re-encodes to itself: the check above compared the real secret.
      expect(base32Encode(raw)).toBe(enrolment.secret)
    } finally {
      await testDb.close()
    }
  })
})

describe('one lockout budget for every second-factor guess', () => {
  /** A sign-in attempt of the user, waiting on the second factor. */
  async function waiting() {
    const { attempt } = await Flows.signIn(deps, tenant, { identifier: EMAIL }, ios)
    const ref = { id: attempt.id, secret: attempt.attemptSecret }
    await Flows.submitPassword(deps, tenant, ref, PASSWORD, ios)
    return (method: 'totp' | 'backup_code', response: string) =>
      Flows.submitSecondFactor(deps, tenant, 'sign_in', ref, { method, response }, ios)
  }

  test('the key is per environment and user', () => {
    expect(Mfa.secondFactorLockKey('env', 'user')).toBe('second_factor:env:user')
    expect(Flows.secondFactorLockKey('env', 'user')).toBe(Mfa.secondFactorLockKey('env', 'user'))
  })

  test('wrong proofs through sign-in and step-up, by TOTP and backup code, use up the same guesses', async () => {
    const user = await seedUser()
    const { secret, codes } = await enrol(user.id)
    const session = await newSession(user.id, ['pwd', 'otp', 'mfa'])
    const second = await waiting()
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)

    // The free tries and the one failure that starts the first wait, spread over every route.
    const guesses: (() => Promise<unknown>)[] = [
      () => second('totp', '000000'),
      () => stepUp(user.id, session.sessionId, { method: 'totp', code: '000000' }),
      () => second('backup_code', 'zzzzz-zzzzz'),
      () => stepUp(user.id, session.sessionId, { method: 'backup_code', code: 'zzzzz-zzzzz' }),
      () => second('totp', '111111'),
      () => stepUp(user.id, session.sessionId, { method: 'totp', code: '111111' }),
    ]
    expect(guesses).toHaveLength(CREDENTIAL_LOCKOUT.freeAttempts + 1)
    for (const guess of guesses) {
      expect((await rejection(guess())).code).toBe('mfa.invalid_code')
    }
    const key = Mfa.secondFactorLockKey(tenant.environmentId, user.id)
    expect(counted.mock.calls.map((call) => call[0])).toEqual(Array(6).fill(key))

    // Locked: the right proof is refused through every route, and nothing is checked or spent.
    const used = spyOn(deps.factors, 'useTotpStep')
    const consumed = spyOn(deps.factors, 'consumeBackupCode')
    spies.push(used, consumed)
    for (const right of [
      () => second('totp', codeFor(secret)),
      () => second('backup_code', codes[0] as string),
      () => stepUp(user.id, session.sessionId, { method: 'totp', code: codeFor(secret) }),
      () => stepUp(user.id, session.sessionId, { method: 'backup_code', code: codes[0] as string }),
    ]) {
      const err = await right().catch((caught) => caught)
      expect(err).toBeInstanceOf(RateLimitError)
      expect(err.toJSON()).toMatchObject({ status: 429, code: 'rate_limited' })
    }
    expect(used).not.toHaveBeenCalled()
    expect(consumed).not.toHaveBeenCalled()
    expect(await liveSessions(user.id)).toHaveLength(1)

    // After the wait a right proof goes through and gives the free tries back.
    deps.clock.advance('31s')
    await stepUp(user.id, session.sessionId, { method: 'totp', code: codeFor(secret) })
    for (let index = 0; index <= CREDENTIAL_LOCKOUT.freeAttempts; index++) {
      expect(
        (await rejection(stepUp(user.id, session.sessionId, { method: 'totp', code: '000000' })))
          .code
      ).toBe('mfa.invalid_code')
    }
    expect(await second('backup_code', codes[0] as string).catch((err) => err)).toBeInstanceOf(
      RateLimitError
    )
  })

  test('wrong confirmation codes are counted under the same key, and lock the confirmation', async () => {
    const user = await seedUser()
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)
    const confirm = (code: string) =>
      Mfa.confirmTotp(deps, tenant, { userId: user.id }, code, actorOf(user.id))
    for (let index = 0; index <= CREDENTIAL_LOCKOUT.freeAttempts; index++) {
      expect((await rejection(confirm('000000'))).code).toBe('mfa.invalid_code')
    }
    expect(counted).toHaveBeenCalledWith(
      Mfa.secondFactorLockKey(tenant.environmentId, user.id),
      CREDENTIAL_LOCKOUT,
      deps.clock.now()
    )
    expect(await confirm(codeFor(secret)).catch((err) => err)).toBeInstanceOf(RateLimitError)
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ totp: { enabled: false } })

    deps.clock.advance('31s')
    expect((await confirm(codeFor(secret))).codes).toHaveLength(10)
    // Confirming cleared the count: the new factor starts with its free tries.
    const session = await newSession(user.id, ['pwd', 'otp', 'mfa'])
    for (let index = 0; index <= CREDENTIAL_LOCKOUT.freeAttempts; index++) {
      expect(
        (await rejection(stepUp(user.id, session.sessionId, { method: 'totp', code: '000000' })))
          .code
      ).toBe('mfa.invalid_code')
    }
  })

  test('one user’s wrong guesses do not lock another user, or the same user elsewhere', async () => {
    const user = await seedUser()
    const other = await seedUser({ email: 'other@northline.app' })
    await enrol(user.id)
    const theirs = await enrol(other.id)
    const session = await newSession(user.id)
    const otherSession = await newSession(other.id)
    for (let index = 0; index <= CREDENTIAL_LOCKOUT.freeAttempts; index++) {
      await rejection(stepUp(user.id, session.sessionId, { method: 'totp', code: '000000' }))
    }
    expect(
      (
        await stepUp(other.id, otherSession.sessionId, {
          method: 'totp',
          code: codeFor(theirs.secret),
        })
      ).sessionId
    ).toBe(otherSession.sessionId)
  })

  test('guesses at a factor that was turned off do not count against the next one', async () => {
    const user = await seedUser()
    await enrol(user.id)
    const session = await newSession(user.id, ['pwd', 'otp', 'mfa'])
    for (let index = 0; index < CREDENTIAL_LOCKOUT.freeAttempts - 1; index++) {
      await rejection(stepUp(user.id, session.sessionId, { method: 'totp', code: '000000' }))
    }
    await Mfa.disableTotp(deps, tenant, user.id, actorOf(user.id))
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    const confirm = (code: string) =>
      Mfa.confirmTotp(deps, tenant, { userId: user.id }, code, actorOf(user.id))
    for (let index = 0; index < CREDENTIAL_LOCKOUT.freeAttempts; index++) {
      expect((await rejection(confirm('000000'))).code).toBe('mfa.invalid_code')
    }
    expect((await confirm(codeFor(secret))).codes).toHaveLength(10)
  })

  test('a lockout store that cannot forget is logged, and the change still happens', async () => {
    const user = await seedUser()
    await enrol(user.id)
    const warned = spyOn(logger, 'warn').mockImplementation(() => {})
    spies.push(warned)
    spies.push(spyOn(deps.lockout, 'clear').mockRejectedValueOnce(new Error('redis down')))
    await Mfa.disableTotp(deps, tenant, user.id, actorOf(user.id))
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ totp: { enabled: false } })
    expect(warned).toHaveBeenCalledWith('could not clear the second-factor lockout', {
      environmentId: tenant.environmentId,
      err: 'Error',
    })

    spies.push(spyOn(deps.lockout, 'clear').mockRejectedValueOnce('nope'))
    await Mfa.reset(deps, tenant, user.id, TEST_ACTOR)
    expect(warned).toHaveBeenLastCalledWith('could not clear the second-factor lockout', {
      environmentId: tenant.environmentId,
      err: 'unknown',
    })
  })
})

describe('disableTotp', () => {
  const disable = (userId: string) => Mfa.disableTotp(deps, tenant, userId, actorOf(userId))

  test('removes the authenticator and every backup code, records it and tells the owner', async () => {
    const user = await seedUser()
    const { secret, codes } = await enrol(user.id)
    const sent = deps.mailer.outbox.length
    await disable(user.id)
    await Notices.settled()

    expect(await Mfa.status(deps, tenant, user.id)).toEqual({
      totp: { enabled: false, confirmedAt: null },
      backupCodes: { remaining: 0 },
    })
    expect(await Factors.requiredFor(deps, tenant, user.id)).toEqual([])
    expect(await deps.factors.findTotp(tenant.environmentId, user.id)).toBeNull()
    expect(await Mfa.verifyTotp(deps, tenant, user.id, codeFor(secret))).toBe(false)
    expect(await Mfa.verifyBackupCode(deps, tenant, user.id, codes[0], actorOf(user.id))).toBeNull()
    expect(deps.activityLog.ofType('user.mfa_disabled')).toEqual([
      expect.objectContaining({
        actor: { type: 'user', id: user.id },
        target: { type: 'user', id: user.id },
        data: { method: 'self' },
      }),
    ])
    expect(deps.mailer.outbox.slice(sent).map((message) => [message.to, message.subject])).toEqual([
      [EMAIL, 'Two-step verification was turned off for your Tula account'],
    ])
  })

  test('is refused while the environment requires a second factor: nothing is removed', async () => {
    const user = await seedUser()
    await enrol(user.id)
    policy('required')
    const err = await rejection(disable(user.id))
    expect(err.toJSON()).toMatchObject({ status: 403, code: 'mfa.required_by_policy' })
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({
      totp: { enabled: true },
      backupCodes: { remaining: 10 },
    })
    expect(deps.activityLog.ofType('user.mfa_disabled')).toEqual([])
  })

  test('with nothing turned on there is nothing to turn off', async () => {
    const user = await seedUser()
    const err = await rejection(disable(user.id))
    expect(err.toJSON()).toMatchObject({ status: 409, code: 'mfa.not_enabled' })
    // A pending enrolment is not "on" either.
    await Mfa.startTotp(deps, tenant, user.id)
    expect((await rejection(disable(user.id))).code).toBe('mfa.not_enabled')
    expect((await rejection(disable(deps.ids.next()))).code).toBe('mfa.not_enabled')
    expect(deps.activityLog.ofType('user.mfa_disabled')).toEqual([])
    await Notices.settled()
    expect(deps.mailer.outbox).toEqual([])
  })

  test('a second call finds nothing to turn off', async () => {
    const user = await seedUser()
    await enrol(user.id)
    await disable(user.id)
    expect((await rejection(disable(user.id))).code).toBe('mfa.not_enabled')
    expect(deps.activityLog.ofType('user.mfa_disabled')).toHaveLength(1)
  })
})

describe('regenerateBackupCodes', () => {
  const regenerate = (userId: string) =>
    Mfa.regenerateBackupCodes(deps, tenant, userId, actorOf(userId))

  test('the earlier codes stop working, ten new ones work, and it is recorded and announced', async () => {
    const user = await seedUser()
    const { codes: old } = await enrol(user.id)
    await Mfa.verifyBackupCode(deps, tenant, user.id, old[0], actorOf(user.id))
    await Notices.settled()
    const sent = deps.mailer.outbox.length
    const { codes: fresh } = await regenerate(user.id)
    await Notices.settled()

    expect(fresh).toHaveLength(10)
    expect(new Set([...old, ...fresh]).size).toBe(20)
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({
      backupCodes: { remaining: 10 },
    })
    for (const code of old) {
      expect(await Mfa.verifyBackupCode(deps, tenant, user.id, code, actorOf(user.id))).toBeNull()
    }
    expect(await Mfa.verifyBackupCode(deps, tenant, user.id, fresh[9], actorOf(user.id))).toBe(9)
    expect(deps.activityLog.ofType('user.backup_codes_regenerated')).toEqual([
      expect.objectContaining({
        actor: { type: 'user', id: user.id },
        target: { type: 'user', id: user.id },
        data: {},
      }),
    ])
    expect(deps.mailer.outbox[sent]).toMatchObject({
      to: EMAIL,
      subject: 'New backup codes were created for your Tula account',
    })
  })

  test('is refused without a confirmed authenticator: nothing stored, recorded or sent', async () => {
    const user = await seedUser()
    expect((await rejection(regenerate(user.id))).toJSON()).toMatchObject({
      status: 409,
      code: 'mfa.not_enabled',
    })
    await Mfa.startTotp(deps, tenant, user.id)
    expect((await rejection(regenerate(user.id))).code).toBe('mfa.not_enabled')
    expect((await rejection(regenerate(deps.ids.next()))).code).toBe('mfa.not_enabled')
    expect(await deps.factors.countBackupCodes(tenant.environmentId, user.id)).toBe(0)
    expect(deps.activityLog.ofType('user.backup_codes_regenerated')).toEqual([])
    await Notices.settled()
    expect(deps.mailer.outbox).toEqual([])
  })
})

describe('a failure half-way leaves the safer state', () => {
  test('reset: when the sessions cannot be ended the factor is still there, and a retry finishes', async () => {
    const user = await seedUser()
    const session = await newSession(user.id)
    await enrol(user.id, session.sessionId)
    spies.push(
      spyOn(deps.sessions, 'revokeByUser').mockRejectedValueOnce(new Error('the database is away'))
    )
    await expect(Mfa.reset(deps, tenant, user.id, TEST_ACTOR)).rejects.toThrow(
      'the database is away'
    )
    // Not "factor gone, a possibly stolen session alive": the factor still guards the account.
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ totp: { enabled: true } })
    expect(deps.activityLog.ofType('user.mfa_disabled')).toEqual([])

    await Mfa.reset(deps, tenant, user.id, TEST_ACTOR)
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ totp: { enabled: false } })
    expect(await liveSessions(user.id)).toEqual([])
  })

  test('confirmTotp: when the other sessions cannot be ended the factor is not turned on, and the same enrolment can be retried', async () => {
    const user = await seedUser()
    const current = await newSession(user.id)
    const other = await newSession(user.id)
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    spies.push(
      spyOn(deps.sessions, 'revokeByUser').mockRejectedValueOnce(new Error('the database is away'))
    )
    const confirm = () =>
      Mfa.confirmTotp(
        deps,
        tenant,
        { userId: user.id, sessionId: current.sessionId },
        codeFor(secret),
        actorOf(user.id)
      )
    await expect(confirm()).rejects.toThrow('the database is away')
    // Not "factor on, a session that never proved it alive, backup codes lost".
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ totp: { enabled: false } })
    expect(deps.activityLog.ofType('user.mfa_enabled')).toEqual([])

    expect((await confirm()).codes).toHaveLength(10)
    expect((await liveSessions(user.id)).map((session) => session.id)).toEqual([current.sessionId])
    expect(await deps.revokedSessions.has(other.sessionId, deps.clock.now())).toBe(true)
  })
})

describe('reset (admin)', () => {
  test('removes the factor and codes, ends and denylists every session, records the admin and tells the owner', async () => {
    const user = await seedUser()
    const first = await newSession(user.id)
    const { secret, codes } = await enrol(user.id, first.sessionId)
    const second = await newSession(user.id, ['pwd', 'otp', 'mfa'])
    const bystander = await seedUser({ email: 'someone@northline.app' })
    const theirs = await newSession(bystander.id)
    const sent = deps.mailer.outbox.length

    await Mfa.reset(deps, tenant, user.id, TEST_ACTOR)
    await Notices.settled()
    const now = deps.clock.now()

    expect(await Mfa.status(deps, tenant, user.id)).toEqual({
      totp: { enabled: false, confirmedAt: null },
      backupCodes: { remaining: 0 },
    })
    expect(await Mfa.verifyTotp(deps, tenant, user.id, codeFor(secret))).toBe(false)
    expect(await Mfa.verifyBackupCode(deps, tenant, user.id, codes[0], actorOf(user.id))).toBeNull()
    expect(await liveSessions(user.id)).toEqual([])
    for (const session of [first, second]) {
      expect(await deps.revokedSessions.has(session.sessionId, now)).toBe(true)
      expect(await deps.sessions.findById(tenant.environmentId, session.sessionId)).toMatchObject({
        revokeReason: 'mfa_changed',
      })
    }
    expect(await deps.revokedSessions.has(theirs.sessionId, now)).toBe(false)
    expect(deps.activityLog.ofType('user.mfa_disabled')).toEqual([
      expect.objectContaining({
        actor: { type: 'admin', id: TEST_ACTOR.id },
        target: { type: 'user', id: user.id },
        ipAddress: TEST_ACTOR.ipAddress,
        data: { method: 'admin_reset' },
      }),
    ])
    const revoked = deps.activityLog
      .ofType('session.revoked')
      .filter((entry) => entry.actor.type === 'admin')
    expect(revoked.map((entry) => entry.target.id).sort()).toEqual(
      [first.sessionId, second.sessionId].sort()
    )
    expect(deps.mailer.outbox.slice(sent).map((message) => [message.to, message.subject])).toEqual([
      [EMAIL, 'Two-step verification was reset for your Tula account'],
    ])
    // The user can enrol again afterwards.
    expect((await Mfa.startTotp(deps, tenant, user.id)).secret).not.toBe(secret)
  })

  test('an unknown user, or one of another environment, is not found and nothing changes', async () => {
    const user = await seedUser()
    const session = await newSession(user.id)
    await enrol(user.id, session.sessionId)
    for (const attempt of [
      () => Mfa.reset(deps, tenant, deps.ids.next(), TEST_ACTOR),
      () => Mfa.reset(deps, otherTenant, user.id, TEST_ACTOR),
    ]) {
      const err = await attempt().catch((caught) => caught)
      expect(err).toBeInstanceOf(NotFoundError)
      expect(err.toJSON()).toMatchObject({ status: 404 })
    }
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ totp: { enabled: true } })
    expect(await liveSessions(user.id)).toHaveLength(1)
    expect(deps.activityLog.ofType('user.mfa_disabled')).toEqual([])
  })

  test('a user with nothing enrolled still has every session ended; nothing else is recorded or sent', async () => {
    const user = await seedUser()
    const session = await newSession(user.id)
    await Mfa.reset(deps, tenant, user.id, TEST_ACTOR)
    await Notices.settled()
    expect(await liveSessions(user.id)).toEqual([])
    expect(await deps.revokedSessions.has(session.sessionId, deps.clock.now())).toBe(true)
    expect(deps.activityLog.ofType('user.mfa_disabled')).toEqual([])
    expect(deps.activityLog.ofType('session.revoked')).toHaveLength(1)
    expect(deps.mailer.outbox).toEqual([])
  })

  test('a pending enrolment is removed without a record or a notice', async () => {
    const user = await seedUser()
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    await Mfa.reset(deps, tenant, user.id, TEST_ACTOR)
    await Notices.settled()
    expect(await deps.factors.findTotp(tenant.environmentId, user.id)).toBeNull()
    expect(
      (
        await rejection(
          Mfa.confirmTotp(deps, tenant, { userId: user.id }, codeFor(secret), actorOf(user.id))
        )
      ).code
    ).toBe('mfa.enrolment_expired')
    expect(deps.activityLog.ofType('user.mfa_disabled')).toEqual([])
    expect(deps.mailer.outbox).toEqual([])
  })

  test('works where the policy requires a second factor: the user enrols again at sign-in', async () => {
    const user = await seedUser()
    await enrol(user.id)
    policy('required')
    await Mfa.reset(deps, tenant, user.id, TEST_ACTOR)
    const required = await Factors.requiredFor(deps, tenant, user.id)
    expect(required).toEqual([])
    expect(await Factors.enrolmentRequired(deps, tenant, required)).toBe(true)
  })
})

describe('the environment’s MFA policy', () => {
  test('off: nobody can start an enrolment, and nothing is stored', async () => {
    policy('off')
    const user = await seedUser()
    const err = await rejection(Mfa.startTotp(deps, tenant, user.id))
    expect(err.toJSON()).toMatchObject({ status: 403, code: 'mfa.not_available' })
    expect(await deps.factors.findTotp(tenant.environmentId, user.id)).toBeNull()
  })

  test('off: a factor a user already has is still asked for, verified, and can be turned off', async () => {
    const user = await seedUser()
    const { secret, codes } = await enrol(user.id)
    policy('off')
    expect(await Factors.requiredFor(deps, tenant, user.id)).toEqual(['totp', 'backup_code'])
    expect(await Factors.enrolmentRequired(deps, tenant, ['totp', 'backup_code'])).toBe(false)
    expect(await Mfa.verifyTotp(deps, tenant, user.id, codeFor(secret))).toBe(true)
    expect(await Mfa.verifyBackupCode(deps, tenant, user.id, codes[0], actorOf(user.id))).toBe(9)
    expect(
      (await Mfa.regenerateBackupCodes(deps, tenant, user.id, actorOf(user.id))).codes
    ).toHaveLength(10)
    await Mfa.disableTotp(deps, tenant, user.id, actorOf(user.id))
    expect(await Factors.requiredFor(deps, tenant, user.id)).toEqual([])
    // Once off it cannot be turned on again.
    expect((await rejection(Mfa.startTotp(deps, tenant, user.id))).code).toBe('mfa.not_available')
  })

  test('off: an enrolment started before the switch-off cannot be confirmed, and the guess is not counted', async () => {
    const user = await seedUser()
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    policy('off')
    const err = await rejection(
      Mfa.confirmTotp(deps, tenant, { userId: user.id }, codeFor(secret), actorOf(user.id))
    )
    expect(err.toJSON()).toMatchObject({ status: 403, code: 'mfa.not_available' })
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ totp: { enabled: false } })
    expect(deps.activityLog.ofType('user.mfa_enabled')).toEqual([])
    // Nothing was counted: every free guess is still there once the policy allows it again.
    policy('optional')
    for (let guess = 0; guess < CREDENTIAL_LOCKOUT.freeAttempts - 1; guess++) {
      expect(
        (
          await rejection(
            Mfa.confirmTotp(deps, tenant, { userId: user.id }, '000000', actorOf(user.id))
          )
        ).code
      ).toBe('mfa.invalid_code')
    }
    expect(
      (await Mfa.confirmTotp(deps, tenant, { userId: user.id }, codeFor(secret), actorOf(user.id)))
        .codes
    ).toHaveLength(10)
  })

  test.each<['optional' | 'required']>([['optional'], ['required']])(
    '%s: a user can enrol',
    async (value) => {
      policy(value)
      const user = await seedUser()
      expect((await enrol(user.id)).codes).toHaveLength(10)
    }
  )

  test('the policy of one environment says nothing about another', async () => {
    policy('off')
    const user = await seedUser({ scope: otherTenant })
    expect((await Mfa.startTotp(deps, otherTenant, user.id)).secret).toMatch(/^[A-Z2-7]{32}$/)
  })
})

describe('notices about two-step verification', () => {
  /** Every change that is announced, in order. */
  async function everyChange() {
    const user = await seedUser()
    const { secret, uri, codes } = await enrol(user.id)
    await Mfa.verifyBackupCode(deps, tenant, user.id, codes[0], actorOf(user.id))
    await Notices.settled()
    const fresh = await Mfa.regenerateBackupCodes(deps, tenant, user.id, actorOf(user.id))
    await Notices.settled()
    // Past the hourly allowance of notices per user.
    deps.clock.advance('61m')
    await Mfa.disableTotp(deps, tenant, user.id, actorOf(user.id))
    await Notices.settled()
    const again = await enrol(user.id)
    await Mfa.reset(deps, tenant, user.id, TEST_ACTOR)
    await Notices.settled()
    return {
      secrets: [secret, uri, again.secret, again.uri, ...codes, ...fresh.codes, ...again.codes],
    }
  }

  test('each change is emailed to the owner once, and no email holds a secret or a code', async () => {
    const { secrets } = await everyChange()
    expect(deps.mailer.outbox.map((message) => [message.to, message.subject])).toEqual([
      [EMAIL, 'Two-step verification was turned on for your Tula account'],
      [EMAIL, 'A backup code was used to sign in to your Tula account'],
      [EMAIL, 'New backup codes were created for your Tula account'],
      [EMAIL, 'Two-step verification was turned off for your Tula account'],
      [EMAIL, 'Two-step verification was turned on for your Tula account'],
      [EMAIL, 'Two-step verification was reset for your Tula account'],
    ])
    const mail = JSON.stringify(deps.mailer.outbox).toLowerCase()
    expect(mail).not.toContain('otpauth')
    for (const secret of secrets) {
      expect(mail).not.toContain(secret.toLowerCase())
      expect(mail).not.toContain(Mfa.normalizeBackupCode(secret))
    }
    // "Backup codes left" only where a code was used.
    expect(
      deps.mailer.outbox.filter((message) => message.text.includes('Backup codes left'))
    ).toHaveLength(1)
  })

  test('with notifications.mfaChanged off nothing is sent, and every change still happens', async () => {
    configure({
      notifications: {
        ...DEFAULT_ENVIRONMENT_SETTINGS.notifications,
        mfaChanged: false,
        identityChanged: true,
      },
    })
    await everyChange()
    expect(deps.mailer.outbox).toEqual([])
    expect(deps.activityLog.ofType('user.mfa_enabled')).toHaveLength(2)
    expect(deps.activityLog.ofType('user.mfa_disabled')).toHaveLength(2)
    expect(deps.activityLog.ofType('user.backup_code_used')).toHaveLength(1)
    expect(deps.activityLog.ofType('user.backup_codes_regenerated')).toHaveLength(1)
  })

  test('the other notices being off does not silence this one', async () => {
    configure({
      notifications: {
        passwordChanged: false,
        newSignIn: false,
        mfaChanged: true,
        identityChanged: true,
      },
    })
    const user = await seedUser()
    await enrol(user.id)
    expect(deps.mailer.outbox).toHaveLength(1)
  })

  test('a mail relay that is down fails no change', async () => {
    const user = await seedUser()
    deps.mailer.failing = true
    spies.push(spyOn(logger, 'warn').mockImplementation(() => {}))
    const { codes } = await enrol(user.id)
    expect(codes).toHaveLength(10)
    expect(await Mfa.verifyBackupCode(deps, tenant, user.id, codes[0], actorOf(user.id))).toBe(9)
    await Mfa.disableTotp(deps, tenant, user.id, actorOf(user.id))
    await Notices.settled()
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ totp: { enabled: false } })
  })
})

describe('stepUpMethods', () => {
  test('a second factor when there is one, else the password and an emailed code, else nothing', async () => {
    const withPassword = await seedUser()
    const passwordless = await seedUser({
      email: 'link@northline.app',
      password: false,
      verified: false,
    })
    expect(await Mfa.stepUpMethods(deps, tenant, withPassword.id)).toEqual([
      'password',
      'email_code',
    ])
    expect(await Mfa.stepUpMethods(deps, tenant, passwordless.id)).toEqual([])
    expect(await Mfa.stepUpMethods(deps, tenant, deps.ids.next())).toEqual([])

    await enrol(withPassword.id)
    await enrol(passwordless.id)
    for (const user of [withPassword, passwordless]) {
      expect(await Mfa.stepUpMethods(deps, tenant, user.id)).toEqual(['totp', 'backup_code'])
    }
    // With every backup code gone only the authenticator is left.
    await deps.factors.replaceBackupCodes(
      tenant.environmentId,
      withPassword.id,
      tenant,
      [],
      deps.clock.now()
    )
    expect(await Mfa.stepUpMethods(deps, tenant, withPassword.id)).toEqual(['totp'])
    expect(await Mfa.secondFactors(deps, tenant, withPassword.id)).toEqual(['totp'])
  })
})

describe('requireRecentAuthentication', () => {
  const nowSeconds = () => Math.floor(deps.clock.now().getTime() / 1000)
  type Claims = Pick<AccessTokenClaims, 'sub' | 'auth_time' | 'amr'>
  const check = (claims: Claims, options?: Mfa.RecentAuthenticationOptions) =>
    Mfa.requireRecentAuthentication(deps, tenant, claims, options)

  test('accepts a proof up to ten minutes old, to the second, and refuses an older one', async () => {
    expect(STEP_UP_MAX_AGE_SECONDS).toBe(600)
    const user = await seedUser()
    const claims = (age: number): Claims => ({
      sub: user.id,
      auth_time: nowSeconds() - age,
      amr: ['pwd'],
    })
    await check(claims(0))
    await check(claims(599))
    await check(claims(600))
    const err = await rejection(check(claims(601)))
    expect(err.toJSON()).toEqual({
      status: 403,
      code: 'auth.step_up_required',
      detail: 'Confirm it is you to continue.',
      params: { methods: 'password,email_code' },
    })
    expect((await rejection(check(claims(86_400)))).code).toBe('auth.step_up_required')
  })

  test('honours a route’s own maximum age, at its edges', async () => {
    const user = await seedUser()
    const claims = (age: number): Claims => ({
      sub: user.id,
      auth_time: nowSeconds() - age,
      amr: [],
    })
    await check(claims(60), { maxAgeSeconds: 60 })
    expect((await rejection(check(claims(61), { maxAgeSeconds: 60 }))).code).toBe(
      'auth.step_up_required'
    )
    // Zero means "proven this very second".
    await check(claims(0), { maxAgeSeconds: 0 })
    expect((await rejection(check(claims(1), { maxAgeSeconds: 0 }))).code).toBe(
      'auth.step_up_required'
    )
  })

  test('a token without auth_time is never recent', async () => {
    const user = await seedUser()
    expect((await rejection(check({ sub: user.id, amr: ['pwd'] }))).code).toBe(
      'auth.step_up_required'
    )
    expect((await rejection(check({ sub: user.id }))).code).toBe('auth.step_up_required')
  })

  test('a user with a second factor needs `mfa` in the claims, however recent the sign-in', async () => {
    const user = await seedUser()
    await enrol(user.id)
    const recent = nowSeconds()
    for (const amr of [['pwd'], ['pwd', 'otp'], ['email'], [], undefined]) {
      const err = await rejection(check({ sub: user.id, auth_time: recent, amr }))
      expect(err.toJSON()).toMatchObject({
        status: 403,
        code: 'auth.step_up_required',
        params: { methods: 'totp,backup_code' },
      })
    }
    await check({ sub: user.id, auth_time: recent, amr: ['pwd', 'otp', 'mfa'] })
    await check({ sub: user.id, auth_time: recent - 600, amr: ['pwd', 'backup_code', 'mfa'] })
    // Proven with the factor, but too long ago.
    expect(
      (
        await rejection(
          check({ sub: user.id, auth_time: recent - 601, amr: ['pwd', 'otp', 'mfa'] })
        )
      ).code
    ).toBe('auth.step_up_required')
  })

  test('names only the authenticator when no backup code is left', async () => {
    const user = await seedUser()
    await enrol(user.id)
    await deps.factors.replaceBackupCodes(
      tenant.environmentId,
      user.id,
      tenant,
      [],
      deps.clock.now()
    )
    const err = await rejection(check({ sub: user.id, auth_time: nowSeconds(), amr: ['pwd'] }))
    expect(err.toJSON()).toMatchObject({ params: { methods: 'totp' } })
  })

  test('a user with no password, no verified address and no second factor has nothing to step up with', async () => {
    const user = await seedUser({ password: false, verified: false })
    await check({ sub: user.id, auth_time: nowSeconds(), amr: ['email'] })
    const err = await rejection(
      check({ sub: user.id, auth_time: nowSeconds() - 601, amr: ['email'] })
    )
    expect(err.toJSON()).toMatchObject({ code: 'auth.step_up_required', params: { methods: '' } })
  })

  test('onlyWithSecondFactor holds users with a second factor to it and nobody else', async () => {
    const plain = await seedUser()
    const passwordless = await seedUser({ email: 'link@northline.app', password: false })
    const stale = nowSeconds() - 86_400
    const only = { onlyWithSecondFactor: true }
    await check({ sub: plain.id, auth_time: stale, amr: ['pwd'] }, only)
    await check({ sub: passwordless.id, auth_time: stale, amr: ['email'] }, only)
    await check({ sub: plain.id }, only)

    await enrol(plain.id)
    expect(
      (await rejection(check({ sub: plain.id, auth_time: nowSeconds(), amr: ['pwd'] }, only))).code
    ).toBe('auth.step_up_required')
    expect(
      (
        await rejection(
          check({ sub: plain.id, auth_time: stale, amr: ['pwd', 'otp', 'mfa'] }, only)
        )
      ).code
    ).toBe('auth.step_up_required')
    await check({ sub: plain.id, auth_time: nowSeconds(), amr: ['pwd', 'otp', 'mfa'] }, only)
  })

  test('a pending enrolment does not make a user one with a second factor', async () => {
    const user = await seedUser()
    await Mfa.startTotp(deps, tenant, user.id)
    await check({ sub: user.id, auth_time: nowSeconds(), amr: ['pwd'] })
    await check({ sub: user.id, auth_time: 0, amr: ['pwd'] }, { onlyWithSecondFactor: true })
  })
})

describe('stepUp', () => {
  test('a user without a second factor steps up with their password', async () => {
    const user = await seedUser()
    const session = await newSession(user.id, ['email'])
    const before = await claimsOf(session.accessToken)
    deps.clock.advance('20m')
    const tokens = await stepUp(user.id, session.sessionId, {
      method: 'password',
      password: PASSWORD,
    })
    expect(tokens.sessionId).toBe(session.sessionId)
    expect(tokens).not.toHaveProperty('refreshToken')
    const claims = await claimsOf(tokens.accessToken)
    expect(claims.auth_time).toBe(Math.floor(deps.clock.now().getTime() / 1000))
    expect(claims.auth_time).toBe((before.auth_time as number) + 1_200)
    expect(claims.amr).toEqual(['pwd', 'email'])
    expect(claims).toMatchObject({ sub: user.id, sid: session.sessionId })
    await Mfa.requireRecentAuthentication(deps, tenant, claims)
    expect(deps.activityLog.ofType('session.stepped_up')).toEqual([
      expect.objectContaining({
        actor: { type: 'user', id: user.id },
        target: { type: 'session', id: session.sessionId },
        ipAddress: '203.0.113.7',
        userAgent: 'tula-tests/1.0',
        data: { userId: user.id, methods: ['pwd'] },
      }),
    ])
    // The refresh token was not rotated: it still refreshes.
    expect((await Sessions.refresh(deps, tenant, session.refreshToken as string)).sessionId).toBe(
      session.sessionId
    )
  })

  test('a wrong password is refused generically and changes nothing', async () => {
    const user = await seedUser()
    const session = await newSession(user.id)
    const err = await rejection(
      stepUp(user.id, session.sessionId, { method: 'password', password: 'not the password' })
    )
    expect(err.toJSON()).toMatchObject({ status: 401, code: 'auth.invalid_credentials' })
    expect(await deps.sessions.findById(tenant.environmentId, session.sessionId)).toMatchObject({
      authMethods: ['pwd'],
    })
    expect(deps.activityLog.ofType('session.stepped_up')).toEqual([])
  })

  test('wrong passwords back off per user; a right one clears them', async () => {
    const user = await seedUser()
    const session = await newSession(user.id)
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)
    const attempt = (password: string) =>
      stepUp(user.id, session.sessionId, { method: 'password', password })
    for (let index = 0; index <= CREDENTIAL_LOCKOUT.freeAttempts; index++) {
      expect((await rejection(attempt('not the password'))).code).toBe('auth.invalid_credentials')
    }
    // Its own key: password guesses do not use up second-factor guesses.
    expect(counted.mock.calls.map((call) => call[0])).toEqual(
      Array(6).fill(`step_up:${tenant.environmentId}:${user.id}`)
    )
    const locked = await attempt(PASSWORD).catch((err) => err)
    expect(locked).toBeInstanceOf(RateLimitError)
    expect(locked.toJSON()).toMatchObject({ status: 429 })

    deps.clock.advance('31s')
    expect((await attempt(PASSWORD)).sessionId).toBe(session.sessionId)
    for (let index = 0; index <= CREDENTIAL_LOCKOUT.freeAttempts; index++) {
      expect((await rejection(attempt('not the password'))).code).toBe('auth.invalid_credentials')
    }
  })

  test('a user with a second factor cannot step up with the password alone', async () => {
    const user = await seedUser()
    await enrol(user.id)
    const session = await newSession(user.id)
    const counted = spyOn(deps.lockout, 'attempt')
    spies.push(counted)
    const err = await rejection(
      stepUp(user.id, session.sessionId, { method: 'password', password: PASSWORD })
    )
    expect(err.toJSON()).toEqual({
      status: 403,
      code: 'auth.step_up_required',
      detail: 'Confirm it is you to continue.',
      params: { methods: 'totp,backup_code' },
    })
    // The password was not even looked at: nothing was counted.
    expect(counted).not.toHaveBeenCalled()
    expect(deps.activityLog.ofType('session.stepped_up')).toEqual([])

    await deps.factors.replaceBackupCodes(
      tenant.environmentId,
      user.id,
      tenant,
      [],
      deps.clock.now()
    )
    expect(
      (
        await rejection(
          stepUp(user.id, session.sessionId, { method: 'password', password: PASSWORD })
        )
      ).toJSON()
    ).toMatchObject({ params: { methods: 'totp' } })
    // A backup code is not offered once none is left.
    expect(
      (
        await rejection(
          stepUp(user.id, session.sessionId, { method: 'backup_code', code: 'abcde-fghjk' })
        )
      ).toJSON()
    ).toMatchObject({ code: 'auth.step_up_required', params: { methods: 'totp' } })
  })

  test('a user without a second factor cannot step up with a code', async () => {
    const user = await seedUser()
    const session = await newSession(user.id)
    for (const proof of [
      { method: 'totp', code: '123456' },
      { method: 'backup_code', code: 'abcde-fghjk' },
    ] as const) {
      const err = await rejection(stepUp(user.id, session.sessionId, proof))
      expect(err.toJSON()).toMatchObject({
        code: 'auth.step_up_required',
        params: { methods: 'password,email_code' },
      })
    }
  })

  test('a user with no password, no verified address and no second factor has no step-up', async () => {
    const user = await seedUser({ password: false, verified: false })
    const session = await newSession(user.id, ['email'])
    for (const proof of [
      { method: 'password', password: PASSWORD },
      { method: 'password', password: '' },
      { method: 'totp', code: '123456' },
    ] as const) {
      const err = await rejection(stepUp(user.id, session.sessionId, proof))
      expect(err.toJSON()).toMatchObject({
        status: 403,
        code: 'auth.step_up_required',
        params: { methods: '' },
      })
    }
  })

  test('an authenticator code steps the session up: auth_time moves and amr gains otp and mfa', async () => {
    const user = await seedUser()
    const { secret } = await enrol(user.id)
    const session = await newSession(user.id)
    deps.clock.advance('15m')
    const code = codeFor(secret)
    const tokens = await stepUp(user.id, session.sessionId, { method: 'totp', code })
    const claims = await claimsOf(tokens.accessToken)
    expect(claims).toMatchObject({
      auth_time: Math.floor(deps.clock.now().getTime() / 1000),
      amr: ['pwd', 'otp', 'mfa'],
    })
    await Mfa.requireRecentAuthentication(deps, tenant, claims)
    // The code is spent: it does not step up again, here or anywhere.
    expect(
      (await rejection(stepUp(user.id, session.sessionId, { method: 'totp', code }))).toJSON()
    ).toMatchObject({ status: 422, code: 'mfa.invalid_code' })
    expect(await Mfa.verifyTotp(deps, tenant, user.id, code)).toBe(false)
  })

  test('a backup code steps the session up, is spent, and its use is recorded with the origin', async () => {
    const user = await seedUser()
    const { codes } = await enrol(user.id)
    const session = await newSession(user.id)
    const tokens = await stepUp(user.id, session.sessionId, {
      method: 'backup_code',
      code: (codes[0] as string).toUpperCase(),
    })
    expect((await claimsOf(tokens.accessToken)).amr).toEqual(['pwd', 'backup_code', 'mfa'])
    expect(await Mfa.status(deps, tenant, user.id)).toMatchObject({ backupCodes: { remaining: 9 } })
    expect(deps.activityLog.ofType('user.backup_code_used')).toEqual([
      expect.objectContaining({ ipAddress: '203.0.113.7', userAgent: 'tula-tests/1.0' }),
    ])
    expect(
      (
        await rejection(
          stepUp(user.id, session.sessionId, { method: 'backup_code', code: codes[0] as string })
        )
      ).code
    ).toBe('mfa.invalid_code')
  })

  test('a wrong code is refused and the session proves nothing new', async () => {
    const user = await seedUser()
    await enrol(user.id)
    const session = await newSession(user.id)
    for (const proof of [
      { method: 'totp', code: '000000' },
      { method: 'backup_code', code: 'zzzzz-zzzzz' },
    ] as const) {
      const err = await rejection(stepUp(user.id, session.sessionId, proof))
      expect(err.toJSON()).toMatchObject({ status: 422, code: 'mfa.invalid_code' })
    }
    expect(await deps.sessions.findById(tenant.environmentId, session.sessionId)).toMatchObject({
      authMethods: ['pwd'],
    })
  })

  test('refreshing never changes auth_time or amr; a step-up does, and a refresh then keeps it', async () => {
    const user = await seedUser()
    const { secret } = await enrol(user.id)
    const session = await newSession(user.id)
    const issued = await claimsOf(session.accessToken)
    expect(issued).toMatchObject({
      auth_time: Math.floor(deps.clock.now().getTime() / 1000),
      amr: ['pwd'],
    })

    deps.clock.advance('30m')
    const refreshed = await Sessions.refresh(deps, tenant, session.refreshToken as string)
    const afterRefresh = await claimsOf(refreshed.accessToken)
    expect(afterRefresh.iat).toBe((issued.iat as number) + 1_800)
    expect(afterRefresh).toMatchObject({ auth_time: issued.auth_time, amr: ['pwd'] })

    deps.clock.advance('1m')
    const stepped = await stepUp(user.id, session.sessionId, {
      method: 'totp',
      code: codeFor(secret),
    })
    const afterStepUp = await claimsOf(stepped.accessToken)
    expect(afterStepUp.auth_time).toBe((issued.auth_time as number) + 1_860)
    expect(afterStepUp.amr).toEqual(['pwd', 'otp', 'mfa'])

    deps.clock.advance('30m')
    const again = await Sessions.refresh(deps, tenant, refreshed.refreshToken as string)
    expect(await claimsOf(again.accessToken)).toMatchObject({
      auth_time: afterStepUp.auth_time,
      amr: ['pwd', 'otp', 'mfa'],
    })
  })

  test('a session that has ended, or is someone else’s, cannot be stepped up', async () => {
    const user = await seedUser()
    const other = await seedUser({ email: 'other@northline.app' })
    const session = await newSession(user.id)
    const theirs = await newSession(other.id)
    await Sessions.revoke(deps, tenant, {
      userId: user.id,
      sessionId: session.sessionId,
      actor: actorOf(user.id),
    })
    const proof = { method: 'password', password: PASSWORD } as const
    for (const sessionId of [session.sessionId, theirs.sessionId, deps.ids.next()]) {
      const err = await rejection(stepUp(user.id, sessionId, proof))
      expect(err.toJSON()).toMatchObject({ status: 401, code: 'session.revoked' })
    }
    expect(await deps.sessions.findById(tenant.environmentId, theirs.sessionId)).toMatchObject({
      authMethods: ['pwd'],
    })
    expect(deps.activityLog.ofType('session.stepped_up')).toEqual([])
  })

  test('a session past its idle expiry cannot be stepped up', async () => {
    const user = await seedUser()
    const session = await newSession(user.id)
    deps.clock.advance('400d')
    expect(
      (
        await rejection(
          stepUp(user.id, session.sessionId, { method: 'password', password: PASSWORD })
        )
      ).code
    ).toBe('session.revoked')
  })

  test('without an origin the audit entry has none', async () => {
    const user = await seedUser()
    const session = await newSession(user.id)
    await Mfa.stepUp(
      deps,
      tenant,
      { userId: user.id, sessionId: session.sessionId },
      { method: 'password', password: PASSWORD }
    )
    expect(deps.activityLog.ofType('session.stepped_up')[0]).toMatchObject({
      ipAddress: null,
      userAgent: null,
    })
  })
})

describe('step-up by emailed code', () => {
  const self = (userId: string, sessionId: string) => ({ userId, sessionId })
  const prepare = (userId: string, sessionId: string) =>
    Mfa.prepareStepUp(deps, tenant, self(userId, sessionId), { method: 'email_code' })
  /** The code in the newest email whose subject leads with one. */
  function latestCode(): string {
    const code = deps.mailer.outbox
      .map((message) => /^(\d{6})\b/.exec(message.subject)?.[1])
      .findLast((found) => found !== undefined)
    if (!code) {
      throw new Error('no email with a code was sent')
    }
    return code
  }
  const wrong = (code: string) => (code === '000000' ? '111111' : '000000')

  test('is offered exactly to a user with a verified email and no second factor', async () => {
    const withPassword = await seedUser()
    const passwordless = await seedUser({ email: 'link@northline.app', password: false })
    const unverified = await seedUser({ email: 'new@northline.app', verified: false })
    const neither = await seedUser({
      email: 'none@northline.app',
      password: false,
      verified: false,
    })
    expect(await Mfa.stepUpMethods(deps, tenant, withPassword.id)).toEqual([
      'password',
      'email_code',
    ])
    expect(await Mfa.stepUpMethods(deps, tenant, passwordless.id)).toEqual(['email_code'])
    expect(await Mfa.stepUpMethods(deps, tenant, unverified.id)).toEqual(['password'])
    expect(await Mfa.stepUpMethods(deps, tenant, neither.id)).toEqual([])

    await enrol(passwordless.id)
    expect(await Mfa.stepUpMethods(deps, tenant, passwordless.id)).toEqual(['totp', 'backup_code'])
  })

  test('a passwordless user asks for a code and steps up with it', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['fed'])
    deps.clock.advance('1h')

    const prepared = await prepare(user.id, session.sessionId)
    expect(prepared).toEqual({
      method: 'email_code',
      destination: 'm***@northline.app',
      expiresAt: new Date(deps.clock.now().getTime() + 600_000).toISOString(),
    })
    const mail = deps.mailer.last()
    expect(mail.to).toBe(EMAIL)
    expect(mail.subject).toMatch(/^\d{6} is your .+ confirmation code$/)
    // A step-up email carries a code and never a link.
    expect(mail.text).not.toMatch(/https?:\/\//)

    const tokens = await stepUp(user.id, session.sessionId, {
      method: 'email_code',
      code: latestCode(),
    })
    const claims = await claimsOf(tokens.accessToken)
    expect(claims.auth_time).toBe(Math.floor(deps.clock.now().getTime() / 1000))
    expect(new Set(claims.amr)).toEqual(new Set(['fed', 'email']))
    expect(deps.activityLog.ofType('session.stepped_up').at(-1)).toMatchObject({
      actor: { type: 'user', id: user.id },
      data: { userId: user.id, methods: ['email'] },
    })
    await Mfa.requireRecentAuthentication(deps, tenant, claims)
  })

  test('a code works once', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['email'])
    await prepare(user.id, session.sessionId)
    const code = latestCode()
    await stepUp(user.id, session.sessionId, { method: 'email_code', code })
    expect(
      (await rejection(stepUp(user.id, session.sessionId, { method: 'email_code', code }))).code
    ).toBe('verification.expired')
  })

  test('a user with a second factor can neither ask for a code nor use one', async () => {
    const user = await seedUser()
    const session = await newSession(user.id)
    await prepare(user.id, session.sessionId)
    const code = latestCode()
    await enrol(user.id, session.sessionId)
    const sentBefore = deps.mailer.outbox.length

    const asked = await rejection(prepare(user.id, session.sessionId))
    expect(asked.toJSON()).toMatchObject({
      status: 403,
      code: 'auth.step_up_required',
      params: { methods: 'totp,backup_code' },
    })
    expect(deps.mailer.outbox).toHaveLength(sentBefore)
    // Not even with a code that was emailed before the factor existed.
    const used = await rejection(stepUp(user.id, session.sessionId, { method: 'email_code', code }))
    expect(used.toJSON()).toMatchObject({
      code: 'auth.step_up_required',
      params: { methods: 'totp,backup_code' },
    })
  })

  test('a user whose email is not verified cannot ask for a code', async () => {
    const user = await seedUser({ verified: false })
    const session = await newSession(user.id)
    const err = await rejection(prepare(user.id, session.sessionId))
    expect(err.toJSON()).toMatchObject({
      code: 'auth.step_up_required',
      params: { methods: 'password' },
    })
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('a code asked by one session does not step up another', async () => {
    const user = await seedUser({ password: false })
    const asking = await newSession(user.id, ['email'])
    const other = await newSession(user.id, ['email'])
    await prepare(user.id, asking.sessionId)
    const code = latestCode()
    const err = await rejection(stepUp(user.id, other.sessionId, { method: 'email_code', code }))
    expect(err.code).toBe('verification.invalid_code')
    expect(deps.activityLog.ofType('session.stepped_up')).toHaveLength(0)
    // The session that asked still can.
    await stepUp(user.id, asking.sessionId, { method: 'email_code', code })
  })

  test('a code asked by one user does not step up another', async () => {
    const user = await seedUser({ password: false })
    const other = await seedUser({ email: 'noor@northline.app', password: false })
    const session = await newSession(user.id, ['email'])
    const otherSession = await newSession(other.id, ['email'])
    await prepare(user.id, session.sessionId)
    const err = await rejection(
      stepUp(other.id, otherSession.sessionId, { method: 'email_code', code: latestCode() })
    )
    expect(err.code).toBe('verification.expired')
  })

  test('a step-up code is refused for every other purpose, and theirs for a step-up', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['email'])
    await prepare(user.id, session.sessionId)
    const stepUpCode = latestCode()
    for (const purpose of ['email_verification', 'password_reset', 'sign_in'] as const) {
      expect(
        (
          await rejection(
            Verification.verifyCode(deps, tenant, {
              purpose,
              subject: { userId: user.id },
              code: stepUpCode,
            })
          )
        ).code
      ).toBe('verification.expired')
    }
    await stepUp(user.id, session.sessionId, { method: 'email_code', code: stepUpCode })

    for (const purpose of ['email_verification', 'password_reset', 'sign_in'] as const) {
      deps.clock.advance('2h')
      await Verification.issue(deps, tenant, { purpose, destination: EMAIL, userId: user.id })
      const err = await rejection(
        stepUp(user.id, session.sessionId, { method: 'email_code', code: latestCode() })
      )
      expect(err.code).toBe('verification.expired')
    }
  })

  test('an expired code is refused', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['email'])
    await prepare(user.id, session.sessionId)
    const code = latestCode()
    deps.clock.advance('10m')
    expect(
      (await rejection(stepUp(user.id, session.sessionId, { method: 'email_code', code }))).code
    ).toBe('verification.expired')
  })

  test('a newer code replaces the older one', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['email'])
    await prepare(user.id, session.sessionId)
    const first = latestCode()
    deps.clock.advance('61s')
    await prepare(user.id, session.sessionId)
    const second = latestCode()
    if (first !== second) {
      expect(
        (await rejection(stepUp(user.id, session.sessionId, { method: 'email_code', code: first })))
          .code
      ).toBe('verification.invalid_code')
    }
    await stepUp(user.id, session.sessionId, { method: 'email_code', code: second })
  })

  test('asking again within the cooldown is rate limited and sends nothing', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['email'])
    await prepare(user.id, session.sessionId)
    const err = await rejection(prepare(user.id, session.sessionId))
    expect(err).toBeInstanceOf(RateLimitError)
    expect(deps.mailer.outbox).toHaveLength(1)
  })

  test('a user is sent at most five codes an hour, whatever the address limit says', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['email'])
    const hits: string[] = []
    const hit = deps.rateLimiter.hit.bind(deps.rateLimiter)
    spies.push(
      spyOn(deps.rateLimiter, 'hit').mockImplementation((key, limit, windowMs) => {
        hits.push(`${key}|${limit}|${windowMs}`)
        return hit(key, limit, windowMs)
      })
    )
    await prepare(user.id, session.sessionId)
    expect(hits).toEqual([
      `step_up_email_cooldown:${tenant.environmentId}:${user.id}|1|60000`,
      `step_up_email:${tenant.environmentId}:${user.id}|${Mfa.STEP_UP_EMAILS_PER_HOUR}|3600000`,
    ])
    expect(Mfa.STEP_UP_EMAILS_PER_HOUR).toBe(5)
    // Limiter keys hold ids and hashes, never an address.
    expect(hits.join('\n')).not.toContain('northline')
  })

  // Review finding F7: step-up sends shared the per-address cooldown and hourly cap with the
  // sign-in, reset and verification codes, which anyone who knows the address can ask for
  // without signing in. That let a stranger keep a user's step-up refused.
  describe('send limits of its own', () => {
    const signInCode = () =>
      Verification.issue(deps, tenant, {
        purpose: 'sign_in',
        destination: EMAIL,
        flowAttemptId: deps.ids.next(),
      })

    test('codes anyone can ask for at the address do not hold back a step-up code', async () => {
      const user = await seedUser({ password: false })
      const session = await newSession(user.id, ['email'])
      for (let sent = 0; sent < Verification.SENDS_PER_HOUR; sent += 1) {
        await signInCode()
        deps.clock.advance('61s')
      }
      // The address is out of sends for the hour, and one more starts its cooldown again.
      expect(await rejection(signInCode())).toBeInstanceOf(RateLimitError)
      const before = deps.mailer.outbox.length

      const prepared = await prepare(user.id, session.sessionId)
      expect(prepared.method).toBe('email_code')
      expect(deps.mailer.outbox).toHaveLength(before + 1)
      await stepUp(user.id, session.sessionId, { method: 'email_code', code: latestCode() })
    })

    test('a sign-in code asked for a moment earlier does not hold back a step-up code', async () => {
      const user = await seedUser({ password: false })
      const session = await newSession(user.id, ['email'])
      await signInCode()
      // Within the address's one-minute cooldown.
      expect(await rejection(signInCode())).toBeInstanceOf(RateLimitError)
      await prepare(user.id, session.sessionId)
      expect(deps.mailer.outbox).toHaveLength(2)
    })

    test('step-up codes do not use up the sends of a sign-in code', async () => {
      const user = await seedUser({ password: false })
      const session = await newSession(user.id, ['email'])
      for (let sent = 0; sent < Mfa.STEP_UP_EMAILS_PER_HOUR; sent += 1) {
        await prepare(user.id, session.sessionId)
        deps.clock.advance('61s')
      }
      await prepare(user.id, session.sessionId).catch(() => undefined)
      const before = deps.mailer.outbox.length
      // Neither the address's hourly cap nor its cooldown was touched.
      await signInCode()
      expect(deps.mailer.outbox).toHaveLength(before + 1)
    })

    test('its own cooldown refuses a second code within a minute, with when to retry', async () => {
      const user = await seedUser({ password: false })
      const session = await newSession(user.id, ['email'])
      await prepare(user.id, session.sessionId)
      deps.clock.advance('20s')
      const err = await rejection(prepare(user.id, session.sessionId))
      expect(err).toBeInstanceOf(RateLimitError)
      expect(err.toJSON()).toMatchObject({ code: 'rate_limited', params: { retryAfter: 40 } })
      expect(deps.mailer.outbox).toHaveLength(1)
      deps.clock.advance('41s')
      await prepare(user.id, session.sessionId)
      expect(deps.mailer.outbox).toHaveLength(2)
    })

    test('its own hourly cap refuses the sixth code, from any of the user’s sessions', async () => {
      const user = await seedUser({ password: false })
      const session = await newSession(user.id, ['email'])
      const other = await newSession(user.id, ['email'])
      for (let sent = 0; sent < Mfa.STEP_UP_EMAILS_PER_HOUR; sent += 1) {
        await prepare(user.id, sent % 2 === 0 ? session.sessionId : other.sessionId)
        deps.clock.advance('61s')
      }
      const err = await rejection(prepare(user.id, other.sessionId))
      expect(err).toBeInstanceOf(RateLimitError)
      expect((err as RateLimitError).retryAfter).toBeGreaterThan(60)
      expect(deps.mailer.outbox).toHaveLength(Mfa.STEP_UP_EMAILS_PER_HOUR)
    })

    test('another user’s step-up codes are counted apart', async () => {
      const user = await seedUser({ password: false })
      const session = await newSession(user.id, ['email'])
      const second = await seedUser({ email: 'second@northline.app', password: false })
      const secondSession = await newSession(second.id, ['email'])
      await prepare(user.id, session.sessionId)
      await prepare(second.id, secondSession.sessionId)
      expect(deps.mailer.outbox).toHaveLength(2)
    })

    test('a limiter that cannot answer sends nothing', async () => {
      const user = await seedUser({ password: false })
      const session = await newSession(user.id, ['email'])
      spies.push(spyOn(deps.rateLimiter, 'hit').mockRejectedValue(new ServiceUnavailableError()))
      const err = await rejection(prepare(user.id, session.sessionId))
      expect(err.code).toBe('service.unavailable')
      expect(deps.mailer.outbox).toHaveLength(0)
    })
  })

  test('wrong codes are counted against the step-up lockout before the check', async () => {
    const user = await seedUser()
    const session = await newSession(user.id)
    const lockKey = `step_up:${tenant.environmentId}:${user.id}`
    const order: string[] = []
    const attempt = deps.lockout.attempt.bind(deps.lockout)
    spies.push(
      spyOn(deps.lockout, 'attempt').mockImplementation((key, policy, now) => {
        order.push(`lockout:${key}`)
        return attempt(key, policy, now)
      })
    )
    const record = deps.verificationTokens.recordAttempt.bind(deps.verificationTokens)
    spies.push(
      spyOn(deps.verificationTokens, 'recordAttempt').mockImplementation((env, id, now) => {
        order.push('check')
        return record(env, id, now)
      })
    )
    await prepare(user.id, session.sessionId)
    const code = latestCode()
    const err = await rejection(
      stepUp(user.id, session.sessionId, { method: 'email_code', code: wrong(code) })
    )
    expect(err.toJSON()).toMatchObject({
      code: 'verification.invalid_code',
      params: { attemptsRemaining: 4 },
    })
    expect(order).toEqual([`lockout:${lockKey}`, 'check'])

    // The budget is the password step-up's: guessing one uses up the other.
    let locked: ServiceException | undefined
    for (let i = 0; i < CREDENTIAL_LOCKOUT.freeAttempts + 2 && !locked; i++) {
      const next = await rejection(
        stepUp(user.id, session.sessionId, { method: 'password', password: 'not the password' })
      )
      if (next instanceof RateLimitError) {
        locked = next
      }
    }
    expect(locked).toBeInstanceOf(RateLimitError)
    // While locked out, the right code is not even looked at.
    order.length = 0
    expect(
      await rejection(stepUp(user.id, session.sessionId, { method: 'email_code', code }))
    ).toBeInstanceOf(RateLimitError)
    expect(order).toEqual([`lockout:${lockKey}`])
  })

  test('a token takes five guesses and then no more, even the right one', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['email'])
    await prepare(user.id, session.sessionId)
    const code = latestCode()
    spies.push(
      spyOn(deps.lockout, 'attempt').mockResolvedValue({ allowed: true, retryAfterMs: 0 } as never)
    )
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await rejection(
            stepUp(user.id, session.sessionId, { method: 'email_code', code: wrong(code) })
          )
        ).code
      ).toBe('verification.invalid_code')
    }
    expect(
      (await rejection(stepUp(user.id, session.sessionId, { method: 'email_code', code }))).code
    ).toBe('verification.too_many_attempts')
  })

  test('success clears the lockout count', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['email'])
    await prepare(user.id, session.sessionId)
    const code = latestCode()
    await rejection(stepUp(user.id, session.sessionId, { method: 'email_code', code: wrong(code) }))
    const clear = spyOn(deps.lockout, 'clear')
    spies.push(clear)
    await stepUp(user.id, session.sessionId, { method: 'email_code', code })
    expect(clear).toHaveBeenCalledWith(`step_up:${tenant.environmentId}:${user.id}`)
  })

  test('a revoked session cannot be stepped up, and the code is not spent on it', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['email'])
    await prepare(user.id, session.sessionId)
    const code = latestCode()
    await Sessions.revoke(deps, tenant, {
      userId: user.id,
      sessionId: session.sessionId,
      actor: actorOf(user.id),
    })
    expect(
      (await rejection(stepUp(user.id, session.sessionId, { method: 'email_code', code }))).code
    ).toBe('session.revoked')
  })

  test('when the email cannot be sent nothing is stored', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['email'])
    deps.mailer.failing = true
    expect((await rejection(prepare(user.id, session.sessionId))).status).toBe(500)
    expect(
      await deps.verificationTokens.findLatest(tenant.environmentId, 'step_up', { userId: user.id })
    ).toBeNull()
  })

  test('neither the code nor the address reaches a log line or the audit log', async () => {
    const user = await seedUser({ password: false })
    const session = await newSession(user.id, ['email'])
    const lines: string[] = []
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      spies.push(
        spyOn(logger, level).mockImplementation((...args: unknown[]) => {
          lines.push(JSON.stringify(args))
        })
      )
    }
    await prepare(user.id, session.sessionId)
    const code = latestCode()
    await stepUp(user.id, session.sessionId, { method: 'email_code', code })
    const audit = JSON.stringify(deps.activityLog.ofType('session.stepped_up'))
    for (const text of [lines.join('\n'), audit]) {
      expect(text).not.toContain(code)
      expect(text).not.toContain(EMAIL)
    }
    const stored = await deps.verificationTokens.findLatest(tenant.environmentId, 'step_up', {
      userId: user.id,
    })
    expect(stored?.codeHash).not.toContain(code)
    expect(stored?.linkTokenHash).toBeNull()
  })
})
