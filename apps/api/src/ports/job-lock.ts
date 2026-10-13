/** Background jobs that only one API instance may run at a time. */
export type ExclusiveJob = 'retention' | 'webhook_delivery'

/** What {@link JobLock.runExclusive} reports: the job's result, or that it did not run here. */
export type JobOutcome<T> = { ran: true; value: T } | { ran: false }

/**
 * Makes a background job run on one instance at a time.
 *
 * Every instance starts the same timers. Whichever asks first runs the job; the others are told
 * at once that it is taken and skip that round. Nothing waits and nothing is queued, so a job
 * that is still running when its next round comes is simply not started twice.
 */
export interface JobLock {
  /**
   * Run `fn` unless the job is already running, here or on another instance.
   *
   * @param job - Which job.
   * @param fn - The work. The lock is released when it settles, whether it resolves or rejects.
   * @returns `fn`'s result, or `{ ran: false }` when the job was already running.
   * @throws Whatever `fn` throws, or the lock's own failure (an unreachable database).
   */
  runExclusive<T>(job: ExclusiveJob, fn: () => Promise<T>): Promise<JobOutcome<T>>
}
