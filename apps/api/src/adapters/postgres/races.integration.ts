import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ActivityType } from '@tula/contract'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresFactorStore } from '~/adapters/postgres/factors'
import {
  type IntegrationTenant,
  openIntegrationDatabase,
} from '~/adapters/postgres/integration-support'
import { PostgresSessionStore } from '~/adapters/postgres/sessions'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import type { Activity } from '~/ports/activity-log'
import type { NewFactor } from '~/ports/factor-store'
import type { NewRefreshToken, NewSession } from '~/ports/session-store'
import type { NewUser } from '~/ports/user-repository'

/**
 * Three races between two API instances, each on its own pool of a real Postgres: what the
 * stores promise when two transactions meet, which one session (PGlite) cannot show.
 *
 * Every race is run many times, with the instance that starts first alternating, because one
 * round only shows one interleaving. Each test names the outcomes the store documents, asserts
 * every round is one of them, and checks the audit entries against the outcome it got.
 *
 * Uses the database of `docker compose up -d`; everything is created under a tenant of its own.
 */
const database = openIntegrationDatabase()
const ROUNDS = 40

/**
 * The audit argument of a write that only sets a round up (a user, a session to count). The
 * stores take it as optional today; once it is required, this one line becomes the "nothing to
 * record, it is a fixture" value and no call site changes.
 */
const FIXTURE = undefined

const now = new Date('2026-01-01T00:00:00.000Z')
const later = (ms: number) => new Date(now.getTime() + ms)
const DAY = 86_400_000

let tenant: IntegrationTenant

beforeAll(async () => {
  tenant = await database.tenant()
})

afterAll(() => database.close())

const log = () => new PostgresActivityLog(database.first.db)

function activity(
  type: ActivityType,
  target: { type: 'user' | 'session'; id: string },
  data: Record<string, unknown>
): Activity {
  return {
    id: Bun.randomUUIDv7(),
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    type,
    actor: { type: 'system', id: null },
    target,
    ipAddress: null,
    userAgent: null,
    data,
    occurredAt: now,
  }
}

/** The audit entries about one user or session, as `type` and `data`. */
async function recorded(targetId: string): Promise<{ type: string; data: unknown }[]> {
  const { entries } = await log().listAudit(tenant.environmentId, {
    targetId,
    page: 1,
    size: 100,
  })
  return entries.map(({ type, data }) => ({ type, data }))
}

/** Start two calls together, the one named by `round`'s parity first. */
function together<A, B>(round: number, a: () => Promise<A>, b: () => Promise<B>): Promise<[A, B]> {
  if (round % 2 === 0) {
    const first = a()
    return Promise.all([first, b()])
  }
  const second = b()
  return Promise.all([a(), second])
}

describe('an emailed sign-in verifies an address while a password is being set', () => {
  const users = {
    first: () => new PostgresUserRepository(database.first.db),
    second: () => new PostgresUserRepository(database.second.db),
  }

  function unverified(passwordHash: string | null): NewUser {
    const id = Bun.randomUUIDv7()
    return {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: `${id}@northline.app`,
      emailNormalized: `${id}@northline.app`,
      emailVerifiedAt: null,
      firstName: null,
      lastName: null,
      createdAt: now,
      identityId: Bun.randomUUIDv7(),
      credentialId: Bun.randomUUIDv7(),
      passwordHash,
    }
  }

  /** One round: the verification on one instance, the password on the other. */
  async function race(round: number, existing: string | null) {
    const user = unverified(existing)
    expect(await users.first().create(user, FIXTURE)).toBe(true)
    const target = { type: 'user', id: user.id } as const
    const [verification, outcome] = await together(
      round,
      () =>
        users
          .first()
          .markEmailVerified(
            tenant.environmentId,
            user.id,
            later(1_000),
            activity('user.email_verified', target, {}),
            { activity: activity('user.password_changed', target, { removed: true }) }
          ),
      () =>
        users
          .second()
          .setPasswordHash(
            tenant.environmentId,
            user.id,
            '$argon2id$new',
            later(1_000),
            activity('user.password_changed', target, { method: 'set' })
          )
    )
    const found = await users
      .first()
      .findByEmailWithPassword(tenant.environmentId, user.emailNormalized)
    return { user, verification, outcome, found, entries: await recorded(user.id) }
  }

  // Both calls lock the user's row, so they take turns. Whichever is second sees the other's
  // commit. The address is verified either way; the password that survives is the one set
  // AFTER the verification, never one that was there before or was set underneath it.
  test('an account with a password ends verified, with the new password only if it was set after the verification', async () => {
    const seen = { passwordSetLast: 0, verificationLast: 0 }
    for (let round = 0; round < ROUNDS; round += 1) {
      const { verification, outcome, found, entries } = await race(round, '$argon2id$old')
      expect(found?.user.emailVerifiedAt).toEqual(later(1_000))
      // A password existed whichever came first (the old one, or the one just set over it).
      expect(verification).toEqual({ passwordRemoved: true })
      expect(['created', 'replaced']).toContain(outcome as string)
      if (outcome === 'created') {
        // The verification removed the old password, then the new one was stored.
        seen.passwordSetLast += 1
        expect(found?.passwordHash).toBe('$argon2id$new')
      } else {
        // The new password replaced the old one, then the verification removed it.
        seen.verificationLast += 1
        expect(found?.passwordHash).toBeNull()
      }
      // Never the password from before the verification.
      expect(found?.passwordHash).not.toBe('$argon2id$old')
      expect(entries).toHaveLength(3)
      expect(entries).toContainEqual({ type: 'user.email_verified', data: {} })
      expect(entries).toContainEqual({ type: 'user.password_changed', data: { removed: true } })
      expect(entries).toContainEqual({
        type: 'user.password_changed',
        data: outcome === 'created' ? { method: 'set', created: true } : { method: 'set' },
      })
    }
    expect(seen.passwordSetLast + seen.verificationLast).toBe(ROUNDS)
  })

  test('an account without a password ends verified, with a password only if it was set after the verification', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { verification, outcome, found, entries } = await race(round, null)
      expect(found?.user.emailVerifiedAt).toEqual(later(1_000))
      // Nothing to replace in either order.
      expect(outcome).toBe('created')
      expect(found?.passwordHash).toBe(verification.passwordRemoved ? null : '$argon2id$new')
      expect(entries).toHaveLength(verification.passwordRemoved ? 3 : 2)
      expect(entries).toContainEqual({ type: 'user.email_verified', data: {} })
      expect(entries).toContainEqual({
        type: 'user.password_changed',
        data: { method: 'set', created: true },
      })
      expect(
        entries.filter(({ data }) => (data as { removed?: boolean }).removed === true)
      ).toHaveLength(verification.passwordRemoved ? 1 : 0)
    }
  })

  test('of two verifications on two instances exactly one removes the password and records it', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const user = unverified('$argon2id$old')
      await users.first().create(user, FIXTURE)
      const target = { type: 'user', id: user.id } as const
      const verify = (repository: PostgresUserRepository) => () =>
        repository.markEmailVerified(
          tenant.environmentId,
          user.id,
          later(1_000),
          activity('user.email_verified', target, {}),
          { activity: activity('user.password_changed', target, { removed: true }) }
        )
      const results = await together(round, verify(users.first()), verify(users.second()))
      expect(results.map((result) => result.passwordRemoved).sort()).toEqual([false, true])
      expect((await recorded(user.id)).map((entry) => entry.type).sort()).toEqual([
        'user.email_verified',
        'user.password_changed',
      ])
    }
  })
})

describe('two instances start an authenticator enrolment for one user', () => {
  const stores = {
    first: () => new PostgresFactorStore(database.first.db),
    second: () => new PostgresFactorStore(database.second.db),
  }

  function pending(userId: string): NewFactor {
    const id = Bun.randomUUIDv7()
    return {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      userId,
      type: 'totp',
      secret: `sealed-${id}`,
      createdAt: now,
      expiresAt: later(600_000),
    }
  }

  test('both starts succeed and one whole pending factor is left: neither is told a factor is on', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = await tenant.user()
      const [one, two] = [pending(userId), pending(userId)]
      expect(
        await together(
          round,
          () => stores.first().startTotp(one),
          () => stores.second().startTotp(two)
        )
      ).toEqual([true, true])
      const kept = await stores.first().findTotp(tenant.environmentId, userId)
      expect(kept?.confirmedAt).toBeNull()
      expect([one.id, two.id]).toContain(kept?.id as string)
      // The id and the secret are one start's, never one's id with the other's secret.
      expect(kept?.secret).toBe(`sealed-${kept?.id}`)
    }
  })

  test('a start that meets a confirmation either precedes it or is refused: a confirmed factor is never replaced', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = await tenant.user()
      const [original, again] = [pending(userId), pending(userId)]
      expect(await stores.first().startTotp(original)).toBe(true)
      const [confirmed, restarted] = await together(
        round,
        () =>
          stores.first().confirmTotp(tenant.environmentId, original.id, {
            step: 100,
            at: later(1_000),
            backupCodes: [{ id: Bun.randomUUIDv7(), codeHash: `hash-${Bun.randomUUIDv7()}` }],
          }),
        () => stores.second().startTotp(again)
      )
      const kept = await stores.first().findTotp(tenant.environmentId, userId)
      const codes = await stores.first().countBackupCodes(tenant.environmentId, userId)
      if (confirmed) {
        // The confirmation won: the second start must have been told a factor is on.
        expect(restarted).toBe(false)
        expect(kept).toMatchObject({ id: original.id, secret: original.secret })
        expect(kept?.confirmedAt).toEqual(later(1_000))
        expect(codes).toBe(1)
      } else {
        // The start replaced the pending factor first: the confirmation found nothing to
        // confirm, and no backup code belongs to a factor that is not on.
        expect(restarted).toBe(true)
        expect(kept).toMatchObject({ id: again.id, secret: again.secret, confirmedAt: null })
        expect(codes).toBe(0)
      }
    }
  })
})

describe('two instances sign one user in at the concurrent-session limit', () => {
  const stores = {
    first: () => new PostgresSessionStore(database.first.db),
    second: () => new PostgresSessionStore(database.second.db),
  }

  function session(userId: string, createdAt: Date): NewSession {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      userId,
      profile: 'web',
      client: 'web',
      userAgent: 'Mozilla/5.0',
      ipAddress: '203.0.113.7',
      lastActiveAt: createdAt,
      idleExpiresAt: later(7 * DAY),
      absoluteExpiresAt: later(30 * DAY),
      createdAt,
    }
  }

  function token(sessionId: string): NewRefreshToken {
    return {
      id: Bun.randomUUIDv7(),
      sessionId,
      tokenHash: `hash-${Bun.randomUUIDv7()}`,
      parentId: null,
      expiresAt: later(7 * DAY),
      createdAt: now,
    }
  }

  async function seed(userId: string, createdAt: Date): Promise<NewSession> {
    const made = session(userId, createdAt)
    expect(await stores.first().create(made, token(made.id), FIXTURE)).toEqual({
      created: true,
      ended: [],
    })
    return made
  }

  const limit = (max: number, end: readonly string[]) => ({
    max,
    end,
    at: later(1_000),
    activity: (id: string) =>
      activity('session.revoked', { type: 'session', id }, { reason: 'session_limit' }),
  })

  const live = (userId: string) =>
    stores.first().listActiveByUser(tenant.environmentId, userId, later(1_000))

  test('with one place left, one sign-in gets the session and the other is refused', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = await tenant.user()
      await seed(userId, now)
      const [one, two] = [session(userId, later(1_000)), session(userId, later(1_000))]
      const results = await together(
        round,
        () => stores.first().create(one, token(one.id), FIXTURE, limit(2, [])),
        () => stores.second().create(two, token(two.id), FIXTURE, limit(2, []))
      )
      expect(results.filter((result) => result.created)).toHaveLength(1)
      expect(await live(userId)).toHaveLength(2)
    }
  })

  // The service names the oldest session for both sign-ins, from the same reading. The one
  // that waits finds it already ended, which frees no place a second time.
  test('when both name the same oldest session to end, it is ended once and the user stays at the limit', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = await tenant.user()
      const oldest = await seed(userId, now)
      const kept = await seed(userId, later(10))
      const [one, two] = [session(userId, later(1_000)), session(userId, later(1_000))]
      const [first, second] = await together(
        round,
        () => stores.first().create(one, token(one.id), FIXTURE, limit(2, [oldest.id])),
        () => stores.second().create(two, token(two.id), FIXTURE, limit(2, [oldest.id]))
      )
      const [won, lost] = first.created ? [first, second] : [second, first]
      expect(won).toEqual({ created: true, ended: [oldest.id] })
      expect(lost).toEqual({ created: false })
      const winner = first.created ? one : two
      expect((await live(userId)).map((row) => row.id).sort()).toEqual([kept.id, winner.id].sort())
      expect(await recorded(oldest.id)).toEqual([
        { type: 'session.revoked', data: { reason: 'session_limit' } },
      ])
    }
  })
})
