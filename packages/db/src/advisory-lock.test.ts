import { describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import {
  ADVISORY_LOCK_NAMESPACE,
  type AdvisoryLockKey,
  type LockPool,
  withAdvisoryLock,
} from './advisory-lock'

const KEY: AdvisoryLockKey = [ADVISORY_LOCK_NAMESPACE, 7]

/** A pool of one scripted connection that records what was asked of it. */
function fakePool(script: { acquired?: unknown; released?: unknown; unlockFails?: boolean }) {
  const queries: { text: string; values: number[] }[] = []
  const releases: (boolean | undefined)[] = []
  const pool: LockPool = {
    connect: async () => ({
      query: async (text, values) => {
        queries.push({ text, values })
        if (text.includes('pg_advisory_unlock')) {
          if (script.unlockFails) {
            throw new Error('connection lost')
          }
          return { rows: [{ released: script.released ?? true }] }
        }
        return { rows: [{ acquired: script.acquired ?? true }] }
      },
      release: (destroy) => {
        releases.push(destroy)
      },
    }),
  }
  return { pool, queries, releases }
}

describe('withAdvisoryLock', () => {
  test('takes the lock, runs the work, unlocks and returns the connection to the pool', async () => {
    const { pool, queries, releases } = fakePool({})
    const result = await withAdvisoryLock(pool, KEY, async () => {
      // The lock is held while the work runs: only the lock query so far.
      expect(queries).toHaveLength(1)
      return 'done'
    })
    expect(result).toEqual({ acquired: true, value: 'done' })
    expect(queries).toEqual([
      { text: 'select pg_try_advisory_lock($1, $2) as acquired', values: [0x74756c61, 7] },
      { text: 'select pg_advisory_unlock($1, $2) as released', values: [0x74756c61, 7] },
    ])
    expect(releases).toEqual([false])
  })

  test('does not run the work, or unlock, when another session holds the lock', async () => {
    const { pool, queries, releases } = fakePool({ acquired: false })
    let ran = false
    const result = await withAdvisoryLock(pool, KEY, async () => {
      ran = true
    })
    expect(result).toEqual({ acquired: false })
    expect(ran).toBe(false)
    expect(queries).toHaveLength(1)
    expect(releases).toEqual([false])
  })

  test('unlocks when the work throws, and rethrows', async () => {
    const { pool, queries, releases } = fakePool({})
    const failing = withAdvisoryLock(pool, KEY, async () => {
      throw new Error('purge failed')
    })
    await expect(failing).rejects.toThrow('purge failed')
    expect(queries.map((query) => query.text)).toEqual([
      'select pg_try_advisory_lock($1, $2) as acquired',
      'select pg_advisory_unlock($1, $2) as released',
    ])
    expect(releases).toEqual([false])
  })

  test('destroys the connection when the lock may still be held on it', async () => {
    // Unlock reported "not held" or failed outright: the connection must not be reused, or the
    // next request to check it out would hold the lock without knowing.
    const notReleased = fakePool({ released: false })
    await withAdvisoryLock(notReleased.pool, KEY, async () => 1)
    expect(notReleased.releases).toEqual([true])

    const broken = fakePool({ unlockFails: true })
    await expect(withAdvisoryLock(broken.pool, KEY, async () => 1)).rejects.toThrow(
      'connection lost'
    )
    expect(broken.releases).toEqual([true])
  })

  test('the SQL is valid Postgres and the lock is free again afterwards', async () => {
    // PGlite has a single session, and a session may retake its own advisory lock, so this
    // proves the statements only. Two sessions contending is `advisory-lock.integration.ts`.
    const client = new PGlite()
    const pool: LockPool = {
      connect: async () => ({
        query: (text, values) => client.query<Record<string, unknown>>(text, values),
        release: () => undefined,
      }),
    }
    expect(await withAdvisoryLock(pool, KEY, async () => 'held')).toEqual({
      acquired: true,
      value: 'held',
    })
    const held = await client.query<{ count: number }>(
      "select count(*)::int as count from pg_locks where locktype = 'advisory'"
    )
    expect(held.rows).toEqual([{ count: 0 }])
    await client.close()
  })
})
