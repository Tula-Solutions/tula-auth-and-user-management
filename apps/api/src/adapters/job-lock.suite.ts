import { describe, expect, test } from 'bun:test'
import type { JobLock } from '~/ports/job-lock'

/** Two handles on one lock: two API instances sharing one database. */
export interface JobLockSuiteContext {
  first: JobLock
  second: JobLock
}

/**
 * Behaviour every `JobLock` must have. Run against the memory adapter (unit tests) and against
 * Postgres with two real sessions (`job-lock.integration.ts`), so "the second runner skips"
 * means the same thing in both.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds the two handles; called for each test.
 */
export function describeJobLock(name: string, setup: () => Promise<JobLockSuiteContext>): void {
  describe(`${name} (JobLock)`, () => {
    /** A job that has started and stays running until `finish` is called. */
    function running(lock: JobLock, value: string) {
      let finish: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        finish = resolve
      })
      let entered: () => void = () => undefined
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const outcome = lock.runExclusive('retention', async () => {
        entered()
        await gate
        return value
      })
      return { outcome, started, finish }
    }

    test('runs the job and returns its result', async () => {
      const { first } = await setup()
      expect(await first.runExclusive('retention', async () => 42)).toEqual({
        ran: true,
        value: 42,
      })
    })

    test('while one instance runs the job, a second runner skips it without waiting', async () => {
      const { first, second } = await setup()
      const job = running(first, 'first')
      await job.started

      let ranTwice = false
      const skipped = await second.runExclusive('retention', async () => {
        ranTwice = true
      })
      expect(skipped).toEqual({ ran: false })
      expect(ranTwice).toBe(false)
      // The holder itself cannot start a second copy either.
      expect(await first.runExclusive('retention', async () => 'again')).toEqual({ ran: false })

      job.finish()
      expect(await job.outcome).toEqual({ ran: true, value: 'first' })
    })

    test('once the job finishes, the other instance can run it', async () => {
      const { first, second } = await setup()
      await first.runExclusive('retention', async () => 'first')
      expect(await second.runExclusive('retention', async () => 'second')).toEqual({
        ran: true,
        value: 'second',
      })
    })

    test('a job that fails rethrows and still frees the lock', async () => {
      const { first, second } = await setup()
      const failing = first.runExclusive('retention', async () => {
        throw new Error('job failed')
      })
      await expect(failing).rejects.toThrow('job failed')
      expect(await second.runExclusive('retention', async () => 'next')).toEqual({
        ran: true,
        value: 'next',
      })
    })
  })
}
