import { type Database, SHIPPED_MIGRATIONS } from '@tula/db'
import { sql } from 'drizzle-orm'
import type { DatabaseDiagnosis, Diagnostics } from '~/ports/diagnostics'
import type { HealthProbe } from '~/ports/health-probe'

/**
 * SQLSTATEs that mean "the migration that made the history readable is not applied":
 * `undefined_function`, `invalid_schema_name` and `insufficient_privilege`.
 */
const HISTORY_UNREADABLE: ReadonlySet<string> = new Set(['42883', '3F000', '42501'])

function sqlState(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') {
      return code
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown }).rows
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

/**
 * What {@link createDiagnostics} is built from: the deployment's own connections.
 */
export interface DiagnosticsParts {
  /** The database, as the API's runtime role. */
  db: Database
  /** The mailer: its `verify` connects to the relay and greets it, sending nothing. */
  mailer: { verify(): Promise<void> }
  /** The readiness probe of Redis; `null` without Redis. */
  redis: HealthProbe | null
  /** The `fetch` to use. Defaults to the platform's. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

/**
 * The real diagnostics: the deployment's database, mail relay, Redis and network.
 *
 * @param parts - The connections to probe.
 * @returns The probes.
 *
 * @example
 * ```ts
 * const diagnostics = createDiagnostics({ db, mailer, redis: null })
 * ```
 */
export function createDiagnostics(parts: DiagnosticsParts): Diagnostics {
  const send = parts.fetch ?? ((url, init) => fetch(url, init))
  const { redis } = parts
  return {
    shippedMigrations: SHIPPED_MIGRATIONS.map((migration) => migration.when),
    async database(): Promise<DatabaseDiagnosis> {
      const [clock] = rowsOf(await parts.db.execute(sql`select now() as now`))
      const now = new Date(String(clock?.now))
      try {
        const rows = rowsOf(
          await parts.db.execute(sql`select created_at from tula.applied_migrations()`)
        )
        return { appliedMigrations: rows.map((row) => Number(row.created_at)), now }
      } catch (error) {
        if (HISTORY_UNREADABLE.has(sqlState(error) ?? '')) {
          return { appliedMigrations: null, now }
        }
        throw error
      }
    },
    smtp: () => parts.mailer.verify(),
    redis: redis ? () => redis.check() : null,
    async httpStatus(url, timeoutMs) {
      const response = await send(url, {
        method: 'GET',
        // A redirect is an answer in itself: PUBLIC_URL must be the API, not point at it.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      })
      // The body is not needed; do not leave the connection waiting for it to be read.
      await response.body?.cancel().catch(() => {})
      return response.status
    },
  }
}
