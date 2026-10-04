import { describe, expect, test } from 'bun:test'
import {
  ADVISORY_LOCK_NAMESPACE,
  type AdvisoryLockKey,
  type AdvisoryLockResult,
  type DatabaseHandle,
} from '@tula/db'
import { describeEnvironmentLock } from '~/adapters/environment-lock.suite'
import {
  ENVIRONMENT_LOCK_FIRST_ID,
  environmentLockKey,
  PostgresEnvironmentLock,
} from '~/adapters/postgres/environment-lock'
import { JOB_LOCK_IDS } from '~/adapters/postgres/job-lock'
import { ServiceUnavailableError } from '~/exceptions'

/**
 * A stand-in for a database's advisory locks: one set of held keys that every "session" built
 * from it shares. The real lock, with two Postgres sessions, is proved in
 * `environment-lock.integration.ts`.
 */
function fakeDatabase() {
  const held = new Set<string>()
  const keys: AdvisoryLockKey[] = []
  const withAdvisoryLock: DatabaseHandle['withAdvisoryLock'] = async <T>(
    key: AdvisoryLockKey,
    fn: () => Promise<T>
  ): Promise<AdvisoryLockResult<T>> => {
    keys.push(key)
    const name = key.join(':')
    if (held.has(name)) {
      return { acquired: false }
    }
    held.add(name)
    try {
      return { acquired: true, value: await fn() }
    } finally {
      held.delete(name)
    }
  }
  return { withAdvisoryLock, keys, held }
}

describeEnvironmentLock('PostgresEnvironmentLock over a stand-in database', async () => {
  const database = fakeDatabase()
  return {
    first: new PostgresEnvironmentLock(database.withAdvisoryLock, { retryMs: 5 }),
    second: new PostgresEnvironmentLock(database.withAdvisoryLock, { retryMs: 5 }),
  }
})

describe('PostgresEnvironmentLock', () => {
  const ENVIRONMENT = '0198a3f2-0000-7000-8000-00000000e001'

  test('the key is in Tula’s namespace, stable, and can never be a job’s', () => {
    const key = environmentLockKey(ENVIRONMENT, 'sign_in_methods')
    expect(key[0]).toBe(ADVISORY_LOCK_NAMESPACE)
    // Fixed forever: instances of two versions must agree during a rolling upgrade.
    expect(key).toEqual(environmentLockKey(ENVIRONMENT, 'sign_in_methods'))
    expect(key[1]).toBe(1846934428)
    for (let index = 0; index < 500; index += 1) {
      const id = environmentLockKey(`environment-${index}`, 'sign_in_methods')[1]
      expect(id).toBeGreaterThanOrEqual(ENVIRONMENT_LOCK_FIRST_ID)
      expect(id).toBeLessThanOrEqual(0x7fffffff)
      expect(Number.isInteger(id)).toBe(true)
    }
    for (const id of Object.values(JOB_LOCK_IDS)) {
      expect(id).toBeLessThan(ENVIRONMENT_LOCK_FIRST_ID)
    }
  })

  test('a lock that stays taken past the wait is service.unavailable, and the function never ran', async () => {
    const database = fakeDatabase()
    const key = environmentLockKey(ENVIRONMENT, 'sign_in_methods')
    database.held.add(key.join(':'))
    const pauses: number[] = []
    const lock = new PostgresEnvironmentLock(database.withAdvisoryLock, {
      waitMs: 100,
      retryMs: 25,
      sleep: async (ms) => {
        pauses.push(ms)
      },
    })
    let ran = false
    const outcome = lock.runExclusive(ENVIRONMENT, 'sign_in_methods', async () => {
      ran = true
    })
    await expect(outcome).rejects.toBeInstanceOf(ServiceUnavailableError)
    expect(ran).toBe(false)
    expect(pauses).toEqual([25, 25, 25, 25])
    expect(database.keys).toHaveLength(5)
  })

  test('between tries a waiter holds nothing: the lock function is asked again each time', async () => {
    const database = fakeDatabase()
    const key = environmentLockKey(ENVIRONMENT, 'sign_in_methods').join(':')
    database.held.add(key)
    let tries = 0
    const lock = new PostgresEnvironmentLock(database.withAdvisoryLock, {
      sleep: async () => {
        tries += 1
        if (tries === 3) {
          database.held.delete(key)
        }
      },
    })
    expect(await lock.runExclusive(ENVIRONMENT, 'sign_in_methods', async () => 'in')).toBe('in')
    expect(database.keys).toHaveLength(4)
  })
})
