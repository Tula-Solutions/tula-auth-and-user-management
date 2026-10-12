import { sql } from 'drizzle-orm'
import { check, integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { hooks } from './hooks'
import { tula } from './pg-schema'

/**
 * How many calls of a hook came to each outcome in one hour (ADR 0035, "Recent outcomes"):
 * what an operator is shown of a hook's recent calls.
 *
 * One row per hook, hour (UTC) and outcome, counted up by every call of that outcome.
 * **It is a count and not a log**: there is no row for a call, so no time of any call but
 * the latest of its hour and outcome (`last_at`), and nothing a call can be told from
 * another by. There is no column for anything of the question (it holds an email address
 * and an IP address), for the operator's code of a denial, for a claim, for a status code or
 * for a failure's reason, and there must never be one: the outcome is one of four fixed
 * words (`hook_call_counts_outcome_known`).
 *
 * `hour` is the beginning of an hour (`hook_call_counts_hour_whole`). Rows go with their
 * hook by cascade, and the retention job deletes the hours past its period (ADR 0017). The
 * runtime role's `UPDATE` is of the counter, `last_at` and `updated_at` only: a row cannot
 * be moved to another hook, hour or outcome.
 */
export const hookCallCounts = tula.table(
  'hook_call_counts',
  {
    id: primaryKey(),
    ...tenantColumns(),
    hookId: uuid('hook_id').notNull(),
    /** The beginning of the hour the calls were made in. */
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    /** What the calls came to. Names from the contract's `HOOK_OUTCOMES`. */
    outcome: text('outcome', { enum: ['allowed', 'denied', 'failed', 'timed_out'] }).notNull(),
    calls: integer('calls').notNull().default(0),
    /** When the latest call of this hour and outcome was made. */
    lastAt: timestamp('last_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('hook_call_counts_hook_hour_outcome_key').on(t.hookId, t.hour, t.outcome),
    // Composite on the environment: a count can only be of a hook of its own environment.
    tenantForeignKey('hook_call_counts_hook_fk', t, t.hookId, hooks),
    check(
      'hook_call_counts_outcome_known',
      sql`${t.outcome} in ('allowed', 'denied', 'failed', 'timed_out')`
    ),
    check('hook_call_counts_calls_bounds', sql`${t.calls} >= 0`),
    check('hook_call_counts_hour_whole', sql`${t.hour} = date_trunc('hour', ${t.hour}, 'UTC')`),
    check(
      'hook_call_counts_last_at_in_hour',
      sql`${t.lastAt} >= ${t.hour} and ${t.lastAt} < ${t.hour} + interval '1 hour'`
    ),
    ...tenantConstraints('hook_call_counts', t),
  ]
)

/** A row of hook call counts. */
export type HookCallCount = typeof hookCallCounts.$inferSelect
/** Insert shape for a row of hook call counts. */
export type NewHookCallCount = typeof hookCallCounts.$inferInsert
