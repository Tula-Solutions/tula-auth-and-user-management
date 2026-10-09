import { afterAll, describe, expect, test } from 'bun:test'
import { ADVISORY_LOCK_NAMESPACE, SMS_DAY_LOCK_NAMESPACE } from '@tula/db'
import { sql } from 'drizzle-orm'
import {
  type IntegrationTenant,
  openIntegrationDatabase,
} from '~/adapters/postgres/integration-support'
import { PostgresSmsUsageStore, SMS_DAY_LOCK_WAIT_MS } from '~/adapters/postgres/sms-usage'
import { describeSmsUsageStore } from '~/adapters/sms-usage-store.suite'

/**
 * The day's count of text messages against a real Postgres, on **pools of two connections**:
 * what a take promises when many are made at once, which one session (PGlite) cannot show.
 *
 * Two things are proven here. That of the takes that meet at an environment's last message
 * exactly one is granted, across two instances. And that no number of takes at once can leave
 * them waiting on each other: a take is one transaction on one connection, so a pool of two
 * serves any number of them, where a lock held on one connection around work on another
 * (the environment lock) would have every connection held by a holder waiting for a second.
 *
 * Uses the database of `docker compose up -d`; everything is created under tenants of its own.
 */
const POOL = 2
const database = openIntegrationDatabase(POOL)

/** Longer than any of these takes all together; far shorter than the test's own timeout. */
const BOUND_MS = 15_000

const at = new Date('2026-01-01T12:00:00.000Z')
const DAY = '2026-01-01'

afterAll(() => database.close())

const first = () => new PostgresSmsUsageStore(database.first.db)
const second = () => new PostgresSmsUsageStore(database.second.db)

/**
 * `work`'s result, or a failure that says the work did not finish: a hang is reported as what
 * it is, not as the runner's timeout.
 */
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the takes did not finish within ${BOUND_MS} ms`)),
      BOUND_MS
    )
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

const tenants = (count: number): Promise<IntegrationTenant[]> =>
  Promise.all(Array.from({ length: count }, () => database.tenant()))

const scope = (tenant: IntegrationTenant) => ({
  projectId: tenant.projectId,
  environmentId: tenant.environmentId,
})

/** The second integer of an environment's lock, as the database computes it. */
async function lockId(environmentId: string): Promise<number> {
  const { rows } = (await database.second.db.execute(
    sql`select hashtext(${environmentId}::text) as id`
  )) as { rows: { id: number }[] }
  const id = rows[0]?.id
  if (id === undefined) {
    throw new Error('hashtext returned no row')
  }
  return id
}

// The behaviour every adapter has, on a real server: its takes at once are real sessions here.
describeSmsUsageStore('Postgres on a real server', async () => {
  const [a, b] = [await database.tenant(), await database.tenant('production')]
  return { store: first(), a: scope(a), b: scope(b) }
})

describe('takes at once on a pool of two connections', () => {
  test('many environments, one take each: every one finishes and is counted once', async () => {
    const many = await tenants(24)
    const store = first()
    const taken = await bounded(
      Promise.all(many.map((tenant) => store.takeFromDay(scope(tenant), DAY, '+1', 1, at)))
    )
    expect(taken).toEqual(many.map(() => true))
    for (const tenant of many) {
      expect(await store.sentOn(tenant.environmentId, DAY)).toBe(1)
    }
  })

  test('many environments, each at its last message, several takes each: one is granted in each', async () => {
    const many = await tenants(8)
    const PER_ENVIRONMENT = 6
    const store = first()
    const taken = await bounded(
      Promise.all(
        many.flatMap((tenant) =>
          Array.from({ length: PER_ENVIRONMENT }, (_, index) =>
            store
              .takeFromDay(scope(tenant), DAY, index % 2 ? '+1' : '+49', 1, at)
              .then((granted) => ({ environmentId: tenant.environmentId, granted }))
          )
        )
      )
    )
    for (const tenant of many) {
      const mine = taken.filter((take) => take.environmentId === tenant.environmentId)
      expect(mine).toHaveLength(PER_ENVIRONMENT)
      expect(mine.filter((take) => take.granted)).toHaveLength(1)
      expect(await store.sentOn(tenant.environmentId, DAY)).toBe(1)
    }
  })

  test('one environment at its last message, from two instances: exactly one take is granted, round after round', async () => {
    const tenant = await database.tenant()
    const LIMIT = 5
    const ROUNDS = 20
    const stores = [first(), second()]
    for (let round = 0; round < ROUNDS; round += 1) {
      // A day of its own per round: every round starts from an empty day.
      const day = `2025-06-${String(round + 1).padStart(2, '0')}`
      for (let i = 0; i < LIMIT - 1; i += 1) {
        expect(await stores[0]?.takeFromDay(scope(tenant), day, '+33', LIMIT, at)).toBe(true)
      }
      const taken = await bounded(
        Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            (stores[index % 2] as PostgresSmsUsageStore).takeFromDay(
              scope(tenant),
              day,
              ['+1', '+49', '+33'][index % 3] as string,
              LIMIT,
              at
            )
          )
        )
      )
      expect(taken.filter(Boolean)).toHaveLength(1)
      expect(await first().sentOn(tenant.environmentId, day)).toBe(LIMIT)
    }
  })

  test('takes at once below the limit are all counted, and none past it', async () => {
    const tenant = await database.tenant()
    const stores = [first(), second()]
    const taken = await bounded(
      Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          (stores[index % 2] as PostgresSmsUsageStore).takeFromDay(
            scope(tenant),
            DAY,
            index % 2 ? '+1' : '+49',
            25,
            at
          )
        )
      )
    )
    expect(taken.filter(Boolean)).toHaveLength(25)
    expect(await first().sentOn(tenant.environmentId, DAY)).toBe(25)
    const summary = await first().summary(tenant.environmentId, DAY, 10)
    expect(summary.sent).toBe(25)
    expect(summary.prefixes.reduce((sum, prefix) => sum + prefix.sent, 0)).toBe(25)
  })
})

describe('the environment’s turn', () => {
  test('a take waits behind a holder of its key, on another session, and is granted once that one lets go', async () => {
    const tenant = await database.tenant()
    const store = first()
    const started = await bounded(
      database.holding(async (hold) => {
        await hold.tx.execute(
          sql`select pg_advisory_xact_lock(${sql.raw(String(SMS_DAY_LOCK_NAMESPACE))}, hashtext(${tenant.environmentId}::text))`
        )
        const take = store.takeFromDay(scope(tenant), DAY, '+1', 1, at)
        // It is waiting on that lock and on nothing else: this is the key the store uses.
        await hold.waiting(1)
        // Wrapped: returning the promise itself would keep the lock until the take settled,
        // which it cannot while the lock is held.
        return { take }
      })
    )
    expect(await bounded(started.take)).toBe(true)
    expect(await store.sentOn(tenant.environmentId, DAY)).toBe(1)
  })

  test('another environment’s turn is its own: its take does not wait', async () => {
    const [held, free] = await tenants(2)
    if (!held || !free) {
      throw new Error('two tenants were asked for')
    }
    // One chance in four billion that the two ids hash alike; then this test would say so.
    expect(await lockId(held.environmentId)).not.toBe(await lockId(free.environmentId))
    const store = first()
    await bounded(
      database.holding(async (hold) => {
        await hold.tx.execute(
          sql`select pg_advisory_xact_lock(${sql.raw(String(SMS_DAY_LOCK_NAMESPACE))}, hashtext(${held.environmentId}::text))`
        )
        expect(await store.takeFromDay(scope(free), DAY, '+1', 1, at)).toBe(true)
      })
    )
  })

  test('a session-level lock of Tula’s own namespace with the same second integer is another lock: the take does not wait', async () => {
    const tenant = await database.tenant()
    const id = await lockId(tenant.environmentId)
    // What the job locks and the environment lock take: `(ADVISORY_LOCK_NAMESPACE, id)`,
    // held by a session of the first pool while the take runs on the second.
    const held = await bounded(
      database.first.withAdvisoryLock([ADVISORY_LOCK_NAMESPACE, id], () =>
        second().takeFromDay(scope(tenant), DAY, '+1', 1, at)
      )
    )
    expect(held).toEqual({ acquired: true, value: true })
    expect(SMS_DAY_LOCK_NAMESPACE).not.toBe(ADVISORY_LOCK_NAMESPACE)
  })

  test('a turn that does not come fails the take after the wait, and nothing is counted', async () => {
    const tenant = await database.tenant()
    const store = first()
    const started = Date.now()
    const outcome = await bounded(
      database.holding(async (hold) => {
        await hold.tx.execute(
          sql`select pg_advisory_xact_lock(${sql.raw(String(SMS_DAY_LOCK_NAMESPACE))}, hashtext(${tenant.environmentId}::text))`
        )
        // Held for longer than the take waits.
        return store.takeFromDay(scope(tenant), DAY, '+1', 1, at).then(
          () => 'taken',
          () => 'failed'
        )
      })
    )
    expect(outcome).toBe('failed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(SMS_DAY_LOCK_WAIT_MS - 250)
    expect(await store.sentOn(tenant.environmentId, DAY)).toBe(0)
    // The connection went back to the pool usable, with no wait of its own left on it.
    expect(await store.takeFromDay(scope(tenant), DAY, '+1', 1, at)).toBe(true)
  })
})
