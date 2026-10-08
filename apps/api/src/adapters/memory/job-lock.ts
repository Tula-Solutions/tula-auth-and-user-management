import type { ExclusiveJob, JobLock, JobOutcome } from '~/ports/job-lock'

/**
 * A job lock held in memory, for tests and for nothing else: it only excludes callers that
 * share this object. Two test "instances" share one to stand in for two processes sharing a
 * database.
 */
export class MemoryJobLock implements JobLock {
  readonly #running: Set<ExclusiveJob>

  constructor() {
    // Assigned here rather than as a field initializer: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#running = new Set()
  }

  /** @inheritdoc */
  async runExclusive<T>(job: ExclusiveJob, fn: () => Promise<T>): Promise<JobOutcome<T>> {
    if (this.#running.has(job)) {
      return { ran: false }
    }
    this.#running.add(job)
    try {
      return { ran: true, value: await fn() }
    } finally {
      this.#running.delete(job)
    }
  }
}
