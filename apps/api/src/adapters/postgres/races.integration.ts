import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ActivityType } from '@tula/contract'
import { type Transaction, userFactors, users as usersTable } from '@tula/db'
import { eq } from 'drizzle-orm'
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
 * Two calls started together usually do not meet: the first has committed before the second
 * has a connection. So every round makes them meet (`overlapping`): a third session holds the
 * lock both need, each call is started and **seen waiting on it**, and only then is the lock
 * let go. A round in which either call did not wait fails. Postgres serves a row's waiters in
 * the order they arrived, so the call started first runs first; the rounds alternate which one
 * that is, and each test asserts the outcome the store documents **for that order**, with its
 * audit entries.
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

/** Which of a round's two calls was started, and so ran, first. */
type Order = 'a-first' | 'b-first'

/**
 * Run two calls so that they overlap for certain, and say which ran first.
 *
 * `lock` takes, in a third session, the lock both calls need. The call named by the round's
 * parity is started and seen waiting; then the other, and both are seen waiting; then the lock
 * is released. Nothing here sleeps or hopes: a call that got through without waiting (it no
 * longer takes the lock, or the two were not really in flight together) fails the round.
 *
 * @param round - Even: `a` is started first. Odd: `b`.
 * @param lock - Takes the contended lock in the holding transaction.
 * @param a - The first instance's call.
 * @param b - The second instance's call.
 * @returns Both results and the order.
 */
async function overlapping<A, B>(
  round: number,
  lock: (tx: Transaction) => Promise<unknown>,
  a: () => Promise<A>,
  b: () => Promise<B>
): Promise<{ results: [A, B]; order: Order }> {
  const order: Order = round % 2 === 0 ? 'a-first' : 'b-first'
  const calls: { a?: Promise<A>; b?: Promise<B> } = {}
  const start = (which: 'a' | 'b') => {
    let call: Promise<unknown>
    if (which === 'a') {
      calls.a = a()
      call = calls.a
    } else {
      calls.b = b()
      call = calls.b
    }
    // Its failure is reported by the `Promise.all` below; until then it is not unhandled.
    call.catch(() => undefined)
  }
  try {
    await database.holding(async ({ tx, waiting }) => {
      await lock(tx)
      start(order === 'a-first' ? 'a' : 'b')
      await waiting(1)
      start(order === 'a-first' ? 'b' : 'a')
      await waiting(2)
    })
  } catch (error) {
    // The lock is gone: let what was started finish before the round fails.
    await Promise.allSettled([calls.a, calls.b])
    throw error
  }
  return { results: await Promise.all([calls.a as Promise<A>, calls.b as Promise<B>]), order }
}

/** Hold a user's row as a writer does: whoever reads it to lock it or changes it waits. */
const userRow = (userId: string) => (tx: Transaction) =>
  tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).for('update')

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
    const {
      results: [verification, outcome],
      order,
    } = await overlapping(
      round,
      userRow(user.id),
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
    return {
      verification,
      outcome,
      found,
      entries: await recorded(user.id),
      verifiedFirst: order === 'a-first',
    }
  }

  // Both calls lock the user's row, so they take turns, and the one that is second sees the
  // other's commit. The address is verified either way; the password that survives is the one
  // set AFTER the verification, never one that was there before or was set underneath it.
  test('an account with a password ends verified, with the new password only if it was set after the verification', async () => {
    const seen = { passwordSetLast: 0, verificationLast: 0 }
    for (let round = 0; round < ROUNDS; round += 1) {
      const { verification, outcome, found, entries, verifiedFirst } = await race(
        round,
        '$argon2id$old'
      )
      expect(found?.user.emailVerifiedAt).toEqual(later(1_000))
      // A password existed whichever came first (the old one, or the one just set over it).
      expect(verification).toEqual({ passwordRemoved: true })
      if (verifiedFirst) {
        // The verification removed the old password, then the new one was stored.
        seen.passwordSetLast += 1
        expect(outcome).toBe('created')
        expect(found?.passwordHash).toBe('$argon2id$new')
      } else {
        // The new password replaced the old one, then the verification removed it.
        seen.verificationLast += 1
        expect(outcome).toBe('replaced')
        expect(found?.passwordHash).toBeNull()
      }
      expect(entries).toHaveLength(3)
      expect(entries).toContainEqual({ type: 'user.email_verified', data: {} })
      expect(entries).toContainEqual({ type: 'user.password_changed', data: { removed: true } })
      expect(entries).toContainEqual({
        type: 'user.password_changed',
        data: verifiedFirst ? { method: 'set', created: true } : { method: 'set' },
      })
    }
    expect(seen).toEqual({ passwordSetLast: ROUNDS / 2, verificationLast: ROUNDS / 2 })
  })

  test('an account without a password ends verified, with a password only if it was set after the verification', async () => {
    const seen = { passwordSetLast: 0, verificationLast: 0 }
    for (let round = 0; round < ROUNDS; round += 1) {
      const { verification, outcome, found, entries, verifiedFirst } = await race(round, null)
      expect(found?.user.emailVerifiedAt).toEqual(later(1_000))
      // Nothing to replace in either order.
      expect(outcome).toBe('created')
      if (verifiedFirst) {
        // Nothing to remove yet; the password stored afterwards stays.
        seen.passwordSetLast += 1
        expect(verification).toEqual({ passwordRemoved: false })
        expect(found?.passwordHash).toBe('$argon2id$new')
        expect(entries).toHaveLength(2)
      } else {
        // The password was there when the address was verified, so it went.
        seen.verificationLast += 1
        expect(verification).toEqual({ passwordRemoved: true })
        expect(found?.passwordHash).toBeNull()
        expect(entries).toHaveLength(3)
        expect(entries).toContainEqual({ type: 'user.password_changed', data: { removed: true } })
      }
      expect(entries).toContainEqual({ type: 'user.email_verified', data: {} })
      expect(entries).toContainEqual({
        type: 'user.password_changed',
        data: { method: 'set', created: true },
      })
    }
    expect(seen).toEqual({ passwordSetLast: ROUNDS / 2, verificationLast: ROUNDS / 2 })
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
      const { results, order } = await overlapping(
        round,
        userRow(user.id),
        verify(users.first()),
        verify(users.second())
      )
      // The one that ran first verified the address and removed the password; the other found
      // the address verified and touched nothing.
      expect(results.map((result) => result.passwordRemoved)).toEqual(
        order === 'a-first' ? [true, false] : [false, true]
      )
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
    const keptOf = { first: 0, second: 0 }
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = await tenant.user()
      const [one, two] = [pending(userId), pending(userId)]
      const { results } = await overlapping(
        round,
        // No row exists yet for the two to wait on, so the holder takes the key they will
        // collide on: a start of its own that never commits. Both wait to learn whether it
        // stands; when it is rolled back both are let go at once, onto the same key.
        (tx) => tx.insert(userFactors).values({ ...pending(userId), updatedAt: now }),
        () => stores.first().startTotp(one),
        () => stores.second().startTotp(two)
      )
      expect(results).toEqual([true, true])
      const kept = await stores.first().findTotp(tenant.environmentId, userId)
      expect(kept?.confirmedAt).toBeNull()
      expect([one.id, two.id]).toContain(kept?.id as string)
      // The id and the secret are one start's, never one's id with the other's secret.
      expect(kept?.secret).toBe(`sealed-${kept?.id}`)
      keptOf[kept?.id === one.id ? 'first' : 'second'] += 1
    }
    // Let go at the same moment, either start may reach the key first and be replaced by the
    // other: both endings are right, and both must have happened for this to have been a race.
    expect(keptOf.first).toBeGreaterThan(0)
    expect(keptOf.second).toBeGreaterThan(0)
    expect(keptOf.first + keptOf.second).toBe(ROUNDS)
  })

  test('a start that meets a confirmation either precedes it or is refused: a confirmed factor is never replaced', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = await tenant.user()
      const [original, again] = [pending(userId), pending(userId)]
      expect(await stores.first().startTotp(original)).toBe(true)
      const {
        results: [confirmed, restarted],
        order,
      } = await overlapping(
        round,
        (tx) =>
          tx
            .select({ id: userFactors.id })
            .from(userFactors)
            .where(eq(userFactors.id, original.id))
            .for('update'),
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
      expect(confirmed).toBe(order === 'a-first')
      if (confirmed) {
        // The confirmation ran first: the second start must have been told a factor is on.
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
      const { results, order } = await overlapping(
        round,
        userRow(userId),
        () => stores.first().create(one, token(one.id), FIXTURE, limit(2, [])),
        () => stores.second().create(two, token(two.id), FIXTURE, limit(2, []))
      )
      // The sign-in that ran first took the place; the other counted its session and stopped.
      expect(results).toEqual(
        order === 'a-first'
          ? [{ created: true, ended: [] }, { created: false }]
          : [{ created: false }, { created: true, ended: [] }]
      )
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
      const {
        results: [first, second],
        order,
      } = await overlapping(
        round,
        userRow(userId),
        () => stores.first().create(one, token(one.id), FIXTURE, limit(2, [oldest.id])),
        () => stores.second().create(two, token(two.id), FIXTURE, limit(2, [oldest.id]))
      )
      const [won, lost] = order === 'a-first' ? [first, second] : [second, first]
      expect(won).toEqual({ created: true, ended: [oldest.id] })
      expect(lost).toEqual({ created: false })
      const winner = order === 'a-first' ? one : two
      expect((await live(userId)).map((row) => row.id).sort()).toEqual([kept.id, winner.id].sort())
      expect(await recorded(oldest.id)).toEqual([
        { type: 'session.revoked', data: { reason: 'session_limit' } },
      ])
    }
  })
})
