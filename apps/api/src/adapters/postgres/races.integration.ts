import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ActivityType } from '@tula-tech/contract'
import {
  apiKeys,
  passwordHistory,
  proposals as proposalsTable,
  type Transaction,
  userFactors,
  users as usersTable,
} from '@tula-tech/db'
import { eq } from 'drizzle-orm'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresApiKeyRepository } from '~/adapters/postgres/api-keys'
import { PostgresFactorStore } from '~/adapters/postgres/factors'
import {
  type IntegrationTenant,
  openIntegrationDatabase,
} from '~/adapters/postgres/integration-support'
import { PostgresProposalStore } from '~/adapters/postgres/proposals'
import { PostgresSessionStore } from '~/adapters/postgres/sessions'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type { NewFactor } from '~/ports/factor-store'
import type { NewProposalRecord, ProposalRecord } from '~/ports/proposal-store'
import type { NewRefreshToken, NewSession } from '~/ports/session-store'
import type { NewUser } from '~/ports/user-repository'

/**
 * Races between two API instances, each on its own pool of a real Postgres: what the
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
 * The audit argument of a write that only sets a round up (a user, a session to count):
 * nothing to record, it is a fixture.
 */
const FIXTURE = Audit.none('fixture')

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
            activity('user.password_changed', target, { method: 'set' }),
            { keep: 0 }
          )
    )
    const found = await users
      .first()
      .findByEmailWithPassword(tenant.environmentId, user.emailNormalized ?? '')
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

describe('two instances change one user’s password (ADR 0038)', () => {
  const users = {
    first: () => new PostgresUserRepository(database.first.db),
    second: () => new PostgresUserRepository(database.second.db),
  }

  async function seeded(): Promise<NewUser> {
    const id = Bun.randomUUIDv7()
    const user: NewUser = {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: `${id}@northline.app`,
      emailNormalized: `${id}@northline.app`,
      emailVerifiedAt: now,
      firstName: null,
      lastName: null,
      createdAt: now,
      identityId: Bun.randomUUIDv7(),
      credentialId: Bun.randomUUIDv7(),
      passwordHash: '$argon2id$old',
    }
    expect(await users.first().create(user, FIXTURE)).toBe(true)
    return user
  }

  const change = (
    repository: PostgresUserRepository,
    userId: string,
    hash: string,
    ifCurrent?: string
  ) =>
    repository.setPasswordHash(
      tenant.environmentId,
      userId,
      hash,
      later(1_000),
      activity('user.password_changed', { type: 'user', id: userId }, { method: 'self' }),
      { keep: 5, ...(ifCurrent !== undefined && { ifCurrent }) }
    )

  // Both lock the user's row before they read the hash they replace, so the second reads the
  // first's: each hash that was ever current is kept once, in the order they were replaced.
  test('neither loses a previous password nor keeps one twice', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const user = await seeded()
      const { results, order } = await overlapping(
        round,
        userRow(user.id),
        () => change(users.first(), user.id, '$argon2id$a'),
        () => change(users.second(), user.id, '$argon2id$b')
      )
      expect(results).toEqual(['replaced', 'replaced'])
      const [last, first] = order === 'a-first' ? ['b', 'a'] : ['a', 'b']
      expect(await users.first().storedPasswords(tenant.environmentId, user.id, 24)).toEqual({
        current: `$argon2id$${last}`,
        previous: [`$argon2id$${first}`, '$argon2id$old'],
      })
    }
  })

  // Each was compared with the same stored hash; only the first still finds it there.
  test('of two changes judged against the same hash exactly one is stored', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const user = await seeded()
      const { results, order } = await overlapping(
        round,
        userRow(user.id),
        () => change(users.first(), user.id, '$argon2id$a', '$argon2id$old'),
        () => change(users.second(), user.id, '$argon2id$b', '$argon2id$old')
      )
      expect(results).toEqual(order === 'a-first' ? ['replaced', 'stale'] : ['stale', 'replaced'])
      expect(await users.first().storedPasswords(tenant.environmentId, user.id, 24)).toEqual({
        current: order === 'a-first' ? '$argon2id$a' : '$argon2id$b',
        previous: ['$argon2id$old'],
      })
      // The one that was stale recorded nothing.
      expect(await recorded(user.id)).toEqual([
        { type: 'user.password_changed', data: { method: 'self' } },
      ])
    }
  })

  // A password change holds its user's rows while it moves them. A purge that waited for them
  // could deadlock with it; it passes them over (`FOR UPDATE SKIP LOCKED`) and takes them in a
  // later round. Without that this test ends at the bound: the purge waits for the hold.
  test('the retention purge passes over rows a password change holds, without waiting', async () => {
    const BOUND_MS = 5_000
    const user = await seeded()
    for (const hash of ['$argon2id$a', '$argon2id$b', '$argon2id$c']) {
      expect(await change(users.first(), user.id, hash)).toBe('replaced')
    }
    const previous = async () =>
      (await users.first().storedPasswords(tenant.environmentId, user.id, 24)).previous
    const kept = await previous()
    expect(kept).toHaveLength(3)

    await database.holding(async ({ tx }) => {
      await tx
        .select({ id: passwordHistory.id })
        .from(passwordHistory)
        .where(eq(passwordHistory.userId, user.id))
        .for('update')
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the purge waited more than ${BOUND_MS} ms for held rows`)),
          BOUND_MS
        )
      })
      try {
        // Whatever it deleted is other users' (earlier rounds of this file): never these.
        await Promise.race([
          users.second().deletePasswordHistoryBeyond(tenant.environmentId, 0, 10_000),
          late,
        ])
      } finally {
        clearTimeout(timer)
      }
    })
    expect(await previous()).toEqual(kept)

    // The hold is gone: the next round takes them.
    expect(await users.second().deletePasswordHistoryBeyond(tenant.environmentId, 0, 10_000)).toBe(
      3
    )
    expect(await previous()).toEqual([])
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
            activity: FIXTURE,
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

describe('an approval of a proposal, against another approval and against the revocation of its agent key', () => {
  const stores = {
    first: () => new PostgresProposalStore(database.first.db),
    second: () => new PostgresProposalStore(database.second.db),
  }
  const keys = {
    first: () => new PostgresApiKeyRepository(database.first.db),
    second: () => new PostgresApiKeyRepository(database.second.db),
  }
  const expiry = later(600_000)
  const beforeExpiry = later(599_999)

  /** Hold a proposal's row as a writer does: an approval's update waits. */
  const proposalRow = (id: string) => (tx: Transaction) =>
    tx
      .select({ id: proposalsTable.id })
      .from(proposalsTable)
      .where(eq(proposalsTable.id, id))
      .for('update')

  /** Hold an agent key's row as a writer does: an approval's share lock and a revocation wait. */
  const keyRow = (id: string) => (tx: Transaction) =>
    tx.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, id)).for('update')

  /** A pending proposal of a new agent key, both stored as fixtures. */
  async function seed(): Promise<{ proposal: ProposalRecord; agent: string }> {
    const agent = Bun.randomUUIDv7()
    await keys.first().insert(
      {
        id: agent,
        kind: 'agent',
        name: 'race',
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        keyHash: agent,
        lastFour: '0000',
        createdAt: now,
      },
      FIXTURE
    )
    const record: NewProposalRecord = {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      operation: 'ban_user',
      targetType: 'user',
      targetId: Bun.randomUUIDv7(),
      proposedBy: agent,
      status: 'pending',
      expiresAt: expiry,
      approvedByType: null,
      approvedById: null,
      approvedAt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    }
    return { proposal: await stores.first().insert(record, FIXTURE), agent }
  }

  /** One approval, by an administrator of its own id, with the entry an approval writes. */
  function approve(
    store: PostgresProposalStore,
    proposal: ProposalRecord,
    approver: string,
    at: Date = beforeExpiry
  ) {
    const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
    return store.approve(
      tenant.environmentId,
      proposal.id,
      { type: 'admin', id: approver },
      at,
      Audit.entry({ ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => at } }, scope, {
        type: 'proposal.approved',
        actor: { type: 'admin', id: approver, ipAddress: null, userAgent: null },
        target: { type: 'proposal', id: proposal.id },
        data: {
          operation: 'ban_user',
          targetType: 'user',
          targetId: proposal.targetId,
          proposedBy: proposal.proposedBy,
        },
      })
    )
  }

  const revoke = (repository: PostgresApiKeyRepository, agent: string) =>
    repository.revoke(tenant.environmentId, agent, later(1_000), FIXTURE)

  const approvals = async (proposalId: string) =>
    (await recorded(proposalId)).filter((entry) => entry.type === 'proposal.approved')

  // Both approvals hold the key's row for share (compatible) and meet at the proposal's row.
  // The one that waits judges "still pending" against the row as the first left it.
  test('of two approvals at once exactly one wins, and one approval is recorded', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { proposal } = await seed()
      const [one, two] = [Bun.randomUUIDv7(), Bun.randomUUIDv7()]
      const {
        results: [first, second],
        order,
      } = await overlapping(
        round,
        proposalRow(proposal.id),
        () => approve(stores.first(), proposal, one),
        () => approve(stores.second(), proposal, two)
      )
      const [won, lost] = order === 'a-first' ? [first, second] : [second, first]
      const winner = order === 'a-first' ? one : two
      expect(lost).toBeNull()
      expect(won).toMatchObject({
        status: 'approved',
        approvedByType: 'admin',
        approvedById: winner,
      })
      expect(await stores.first().find(tenant.environmentId, proposal.id)).toMatchObject({
        status: 'approved',
        approvedById: winner,
      })
      expect(await approvals(proposal.id)).toHaveLength(1)
    }
  })

  // "Not expired" is in the statement too, judged with each call's own time. An approval at
  // the expiry matches no row, so it takes no row lock and never waits: it is refused while
  // the row is held and while an approval that is in time is in flight on it. So this is not
  // two waiters (`overlapping` would fail, rightly): the late one runs to its end inside the
  // hold, before or after the other was started, and only the other is seen waiting.
  test('an approval at the expiry is refused without waiting, beside one in time that then wins, in either order', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { proposal } = await seed()
      const [inTime, tooLate] = [Bun.randomUUIDv7(), Bun.randomUUIDv7()]
      const lateFirst = round % 2 === 1
      let early: ReturnType<typeof approve> | undefined
      try {
        await database.holding(async ({ tx, waiting }) => {
          await proposalRow(proposal.id)(tx)
          const late = () => approve(stores.second(), proposal, tooLate, expiry)
          if (lateFirst) {
            expect(await late()).toBeNull()
          }
          early = approve(stores.first(), proposal, inTime, beforeExpiry)
          // Its failure is reported by the await below; until then it is not unhandled.
          early.catch(() => undefined)
          await waiting(1)
          if (!lateFirst) {
            expect(await late()).toBeNull()
          }
          // The late one came and went; the one in time is still the only waiter.
          await waiting(1)
          const [row] = await tx
            .select({ status: proposalsTable.status })
            .from(proposalsTable)
            .where(eq(proposalsTable.id, proposal.id))
          expect(row?.status).toBe('pending')
        })
      } catch (error) {
        // The lock is gone: let what was started finish before the round fails.
        await Promise.allSettled([early])
        throw error
      }
      expect(await early).toMatchObject({ status: 'approved', approvedById: inTime })
      expect(await approvals(proposal.id)).toHaveLength(1)
      expect(await stores.first().find(tenant.environmentId, proposal.id)).toMatchObject({
        status: 'approved',
        approvedById: inTime,
      })
    }
  })

  test('alone, an approval at the expiry and one after it write nothing', async () => {
    const { proposal } = await seed()
    expect(await approve(stores.first(), proposal, Bun.randomUUIDv7(), expiry)).toBeNull()
    expect(await approve(stores.second(), proposal, Bun.randomUUIDv7(), later(600_001))).toBeNull()
    expect(await approvals(proposal.id)).toEqual([])
    expect((await stores.first().find(tenant.environmentId, proposal.id))?.status).toBe('pending')
  })

  // What the share lock on the key's row gives, stated exactly: between the moment an
  // approval's transaction holds it and that transaction's commit, no revocation of the key
  // can commit. So a revocation is either wholly before the approval's statement (which then
  // reads the key as revoked and writes nothing) or wholly after the approval's commit. It
  // does not stop an operation that follows a committed approval.
  //
  // Both calls wait on the key's row here. Started first, the approval takes its share lock
  // first and the revocation waits for its commit; started second, the approval waits for the
  // revocation's commit and then finds no unrevoked key.
  test('an approval and a revocation at once: approved only when the approval was first, and never after the revocation', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { proposal, agent } = await seed()
      const approver = Bun.randomUUIDv7()
      const {
        results: [approved, revoked],
        order,
      } = await overlapping(
        round,
        keyRow(agent),
        () => approve(stores.first(), proposal, approver),
        () => revoke(keys.second(), agent)
      )
      // The revocation always lands: nothing an approval does refuses it.
      expect(revoked?.revokedAt).not.toBeNull()
      const after = await stores.first().find(tenant.environmentId, proposal.id)
      expect(after?.proposerActive).toBe(false)
      if (order === 'a-first') {
        expect(approved).toMatchObject({ status: 'approved', approvedById: approver })
        // The record the approval returned was read while the key was still unrevoked.
        expect(approved?.proposerActive).toBe(true)
        expect(after?.status).toBe('approved')
        expect(await approvals(proposal.id)).toHaveLength(1)
      } else {
        expect(approved).toBeNull()
        expect(after).toMatchObject({ status: 'pending', approvedById: null, approvedAt: null })
        expect(await approvals(proposal.id)).toEqual([])
      }
    }
  })

  // The lock itself. The proposal's row is held, so the approval stops after it has taken the
  // key's row for share. A revocation started then has nothing of the holder's in its way: it
  // can only be waiting for the approval. Two sessions waiting (the approval on the holder,
  // the revocation behind the approval) is that; without the share lock the revocation would
  // commit at once, only one session would wait, and the round would fail.
  test('a revocation started while an approval holds the key’s row waits for that approval to commit', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { proposal, agent } = await seed()
      const approver = Bun.randomUUIDv7()
      const calls: {
        approval?: ReturnType<typeof approve>
        revocation?: ReturnType<typeof revoke>
      } = {}
      try {
        await database.holding(async ({ tx, waiting }) => {
          await proposalRow(proposal.id)(tx)
          calls.approval = approve(stores.first(), proposal, approver)
          calls.approval.catch(() => undefined)
          await waiting(1)
          calls.revocation = revoke(keys.second(), agent)
          calls.revocation.catch(() => undefined)
          await waiting(2)
          // Still unrevoked for everybody else: the revocation has not committed.
          const [key] = await tx
            .select({ revokedAt: apiKeys.revokedAt })
            .from(apiKeys)
            .where(eq(apiKeys.id, agent))
          expect(key?.revokedAt).toBeNull()
        })
      } catch (error) {
        await Promise.allSettled([calls.approval, calls.revocation])
        throw error
      }
      const [approved, revoked] = await Promise.all([calls.approval, calls.revocation])
      expect(approved).toMatchObject({ status: 'approved', approvedById: approver })
      expect(approved?.proposerActive).toBe(true)
      expect(revoked?.revokedAt).not.toBeNull()
      expect(await approvals(proposal.id)).toHaveLength(1)
      expect(await stores.first().find(tenant.environmentId, proposal.id)).toMatchObject({
        status: 'approved',
        proposerActive: false,
      })
    }
  })

  // The other order, with the lock that decides it held by the revocation itself: nothing
  // here is arranged by a third session's row lock on the key.
  test('an approval started while a revocation is in flight waits for it and then writes nothing', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { proposal, agent } = await seed()
      // The revocation's own audit entry needs no lock of the holder's; hold the key's row
      // so that it is in flight, start the approval behind it, and let go.
      const calls: {
        approval?: ReturnType<typeof approve>
        revocation?: ReturnType<typeof revoke>
      } = {}
      try {
        await database.holding(async ({ tx, waiting }) => {
          await keyRow(agent)(tx)
          calls.revocation = revoke(keys.first(), agent)
          calls.revocation.catch(() => undefined)
          await waiting(1)
          calls.approval = approve(stores.second(), proposal, Bun.randomUUIDv7())
          calls.approval.catch(() => undefined)
          await waiting(2)
        })
      } catch (error) {
        await Promise.allSettled([calls.approval, calls.revocation])
        throw error
      }
      const [approved, revoked] = await Promise.all([calls.approval, calls.revocation])
      expect(revoked?.revokedAt).not.toBeNull()
      expect(approved).toBeNull()
      expect(await approvals(proposal.id)).toEqual([])
      expect(await stores.first().find(tenant.environmentId, proposal.id)).toMatchObject({
        status: 'pending',
        proposerActive: false,
        approvedById: null,
      })
    }
  })
})
