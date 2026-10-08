import { describe, expect, test } from 'bun:test'
import type { EnvironmentLock } from '~/ports/environment-lock'

/** Two handles on one lock: two API instances sharing one database. */
export interface EnvironmentLockSuiteContext {
  first: EnvironmentLock
  second: EnvironmentLock
}

const ENVIRONMENT = '0198a3f2-0000-7000-8000-00000000e001'
const OTHER_ENVIRONMENT = '0198a3f2-0000-7000-8000-00000000e002'

/** Let timers and I/O run: long enough for a waiter that is going to get in to get in. */
const moment = () => new Promise((resolve) => setTimeout(resolve, 60))

/**
 * Behaviour every `EnvironmentLock` must have. Run against the memory adapter (unit tests),
 * the Postgres adapter over a stand-in database, and Postgres with two real sessions
 * (`environment-lock.integration.ts`), so "the second writer waits" means the same in each.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds the two handles; called for each test.
 */
export function describeEnvironmentLock(
  name: string,
  setup: () => Promise<EnvironmentLockSuiteContext>
): void {
  describe(`${name} (EnvironmentLock)`, () => {
    /** A holder that has started and stays inside until `finish` is called. */
    function holding(lock: EnvironmentLock, environmentId: string, log: string[], label: string) {
      let finish: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        finish = resolve
      })
      let entered: () => void = () => undefined
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const outcome = lock.runExclusive(environmentId, 'sign_in_methods', async () => {
        log.push(`${label}:in`)
        entered()
        await gate
        log.push(`${label}:out`)
        return label
      })
      return { outcome, started, finish }
    }

    test('runs the function and returns its result', async () => {
      const { first } = await setup()
      expect(await first.runExclusive(ENVIRONMENT, 'sign_in_methods', async () => 42)).toBe(42)
    })

    test('a second writer for the same environment waits, then runs after the first', async () => {
      const { first, second } = await setup()
      const log: string[] = []
      const holder = holding(first, ENVIRONMENT, log, 'first')
      await holder.started

      const waiter = second.runExclusive(ENVIRONMENT, 'sign_in_methods', async () => {
        log.push('second:in')
        return 'second'
      })
      await moment()
      expect(log).toEqual(['first:in'])

      holder.finish()
      expect(await holder.outcome).toBe('first')
      expect(await waiter).toBe('second')
      expect(log).toEqual(['first:in', 'first:out', 'second:in'])
    })

    test('another environment is not held up', async () => {
      const { first, second } = await setup()
      const log: string[] = []
      const holder = holding(first, ENVIRONMENT, log, 'first')
      await holder.started
      expect(
        await second.runExclusive(OTHER_ENVIRONMENT, 'sign_in_methods', async () => 'other')
      ).toBe('other')
      holder.finish()
      await holder.outcome
    })

    test('a function that throws releases the lock and its error reaches the caller', async () => {
      const { first, second } = await setup()
      const failure = first.runExclusive(ENVIRONMENT, 'sign_in_methods', async () => {
        throw new Error('write failed')
      })
      await expect(failure).rejects.toThrow('write failed')
      expect(await second.runExclusive(ENVIRONMENT, 'sign_in_methods', async () => 'next')).toBe(
        'next'
      )
    })

    test('several waiters each get their turn, never two at once', async () => {
      const { first, second } = await setup()
      let inside = 0
      let most = 0
      const turn = (lock: EnvironmentLock) =>
        lock.runExclusive(ENVIRONMENT, 'sign_in_methods', async () => {
          inside += 1
          most = Math.max(most, inside)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inside -= 1
        })
      await Promise.all([turn(first), turn(second), turn(first), turn(second)])
      expect(most).toBe(1)
    })
  })
}
