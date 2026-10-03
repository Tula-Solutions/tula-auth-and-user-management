import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ADVISORY_LOCK_NAMESPACE, type AdvisoryLockKey } from './advisory-lock'
import { createDatabase, type DatabaseHandle } from './client'

// Two real sessions contending for one advisory lock: what makes "only one API instance runs
// the retention job" true. PGlite cannot show this (it has a single session). Runs against the
// docker-compose Postgres as the runtime login; only via `bun run test:integration`.
const runtimeUrl = process.env.DATABASE_URL
if (!runtimeUrl) {
  throw new Error('Integration tests need DATABASE_URL (see .env.example)')
}

describe('advisory lock across sessions', () => {
  // A key no real job uses, different on every run so parallel CI jobs cannot collide.
  const key: AdvisoryLockKey = [ADVISORY_LOCK_NAMESPACE, 1_000_000 + (Date.now() % 1_000_000)]
  let first: DatabaseHandle
  let second: DatabaseHandle

  beforeAll(() => {
    // Two pools stand in for two API instances.
    first = createDatabase(runtimeUrl, { max: 2 })
    second = createDatabase(runtimeUrl, { max: 2 })
  })

  afterAll(async () => {
    await first.close()
    await second.close()
  })

  test('while one instance holds the lock the other is refused; afterwards it can take it', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })

    const holder = first.withAdvisoryLock(key, async () => {
      entered()
      await held
      return 'first'
    })
    await started

    let ran = false
    expect(
      await second.withAdvisoryLock(key, async () => {
        ran = true
      })
    ).toEqual({ acquired: false })
    expect(ran).toBe(false)
    // The same instance is refused too: the lock belongs to the holder's connection, not its pool.
    expect(await first.withAdvisoryLock(key, async () => 'again')).toEqual({ acquired: false })

    release()
    expect(await holder).toEqual({ acquired: true, value: 'first' })
    expect(await second.withAdvisoryLock(key, async () => 'second')).toEqual({
      acquired: true,
      value: 'second',
    })
  })

  test('a holder that fails still frees the lock', async () => {
    const failing = first.withAdvisoryLock(key, async () => {
      throw new Error('job failed')
    })
    await expect(failing).rejects.toThrow('job failed')
    expect(await second.withAdvisoryLock(key, async () => 'next')).toEqual({
      acquired: true,
      value: 'next',
    })
  })
})
