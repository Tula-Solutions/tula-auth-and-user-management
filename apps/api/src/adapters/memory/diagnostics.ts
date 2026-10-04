import type { Clock } from '~/ports/clock'
import type { DatabaseDiagnosis, Diagnostics } from '~/ports/diagnostics'

/**
 * Diagnostics for tests: every probe passes until a test replaces it.
 *
 * @example
 * ```ts
 * const diagnostics = new MemoryDiagnostics(clock)
 * diagnostics.smtp = async () => {
 *   throw new Error('connect ECONNREFUSED')
 * }
 * ```
 */
export class MemoryDiagnostics implements Diagnostics {
  shippedMigrations: readonly number[]
  redis: (() => Promise<void>) | null
  database: () => Promise<DatabaseDiagnosis>
  smtp: () => Promise<void>
  httpStatus: (url: string, timeoutMs: number) => Promise<number>
  /** Every URL `httpStatus` was asked for. */
  readonly requested: string[]

  /** @param clock - The clock the database's clock follows. */
  constructor(clock: Clock) {
    this.shippedMigrations = [1, 2, 3]
    this.redis = null
    this.requested = []
    this.database = async () => ({ appliedMigrations: this.shippedMigrations, now: clock.now() })
    this.smtp = async () => {}
    this.httpStatus = async (url) => {
      this.requested.push(url)
      return 200
    }
  }
}
