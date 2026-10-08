import { ADVISORY_LOCK_NAMESPACE, type DatabaseHandle } from '@tula/db'
import type { ExclusiveJob, JobLock, JobOutcome } from '~/ports/job-lock'

/**
 * The advisory-lock id of each job (the second integer of the key; the first is Tula's
 * namespace). Fixed forever: instances of different versions must agree on them during a
 * rolling upgrade, so never renumber, only add.
 */
export const JOB_LOCK_IDS: Readonly<Record<ExclusiveJob, number>> = {
  retention: 1,
  webhook_delivery: 2,
}

/**
 * A job lock on a Postgres session-level advisory lock, so it excludes every API instance
 * connected to the same database. Postgres was chosen over Redis because the jobs are database
 * work: an instance that cannot reach the database cannot hold the lock either, and a crashed
 * holder's lock goes with its connection.
 */
export class PostgresJobLock implements JobLock {
  /** @param withAdvisoryLock - The database handle's lock function (its own pool connection). */
  constructor(private readonly withAdvisoryLock: DatabaseHandle['withAdvisoryLock']) {}

  /** @inheritdoc */
  async runExclusive<T>(job: ExclusiveJob, fn: () => Promise<T>): Promise<JobOutcome<T>> {
    const result = await this.withAdvisoryLock([ADVISORY_LOCK_NAMESPACE, JOB_LOCK_IDS[job]], fn)
    return result.acquired ? { ran: true, value: result.value } : { ran: false }
  }
}
