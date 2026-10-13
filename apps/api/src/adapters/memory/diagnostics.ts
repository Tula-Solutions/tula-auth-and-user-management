import type { Clock } from '~/ports/clock'
import type { DatabaseDiagnosis, Diagnostics, FetchedDocument } from '~/ports/diagnostics'

/**
 * Diagnostics for tests: every probe passes until a test replaces it. The one exception is
 * `httpDocument`, which has nothing to serve: it answers 404 until a test gives it an app.
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
  httpDocument: (url: string, timeoutMs: number) => Promise<FetchedDocument>
  /** Every URL `httpStatus` and `httpDocument` were asked for. */
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
    this.httpDocument = async (url) => {
      this.requested.push(url)
      return { status: 404, contentType: null, body: null }
    }
  }
}
