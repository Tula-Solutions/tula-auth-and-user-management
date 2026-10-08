import { describe, expect, test } from 'bun:test'
import {
  ADVISORY_LOCK_NAMESPACE,
  type AdvisoryLockKey,
  type AdvisoryLockResult,
  type DatabaseHandle,
} from '@tula/db'
import { describeJobLock } from '~/adapters/job-lock.suite'
import { JOB_LOCK_IDS, PostgresJobLock } from '~/adapters/postgres/job-lock'

/**
 * A stand-in for a database's advisory locks: one set of held keys that every "session" built
 * from it shares. The real lock, with two Postgres sessions, is proved in
 * `job-lock.integration.ts` and in `@tula/db`'s `advisory-lock.integration.ts`.
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
  return { withAdvisoryLock, keys }
}

describeJobLock('PostgresJobLock over a stand-in database', async () => {
  const database = fakeDatabase()
  return {
    first: new PostgresJobLock(database.withAdvisoryLock),
    second: new PostgresJobLock(database.withAdvisoryLock),
  }
})

describe('PostgresJobLock', () => {
  test('locks the job’s fixed key in Tula’s namespace', async () => {
    const database = fakeDatabase()
    await new PostgresJobLock(database.withAdvisoryLock).runExclusive('retention', async () => 1)
    expect(database.keys).toEqual([[ADVISORY_LOCK_NAMESPACE, 1]])
  })

  test('each job has a key of its own', async () => {
    const database = fakeDatabase()
    const lock = new PostgresJobLock(database.withAdvisoryLock)
    await lock.runExclusive('retention', async () => 1)
    await lock.runExclusive('webhook_delivery', async () => 1)
    expect(database.keys).toEqual([
      [ADVISORY_LOCK_NAMESPACE, 1],
      [ADVISORY_LOCK_NAMESPACE, 2],
    ])
  })

  test('job ids never change: instances of two versions must agree during an upgrade', () => {
    expect(JOB_LOCK_IDS).toEqual({ retention: 1, webhook_delivery: 2 })
  })
})
