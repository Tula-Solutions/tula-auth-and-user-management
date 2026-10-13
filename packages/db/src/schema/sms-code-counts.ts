import { sql } from 'drizzle-orm'
import { check, date, integer, pgPolicy, text, unique } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * How many days of counts no `DELETE` of the runtime role can touch: the bound the database
 * itself keeps (`sms_code_counts_retention_floor`). Today's rows are what the daily limit is
 * held against, so a statement that deleted them would reopen a spent day; a week is far
 * inside the retention job's period and wide of any argument about time zones.
 */
export const SMS_COUNT_RETENTION_FLOOR_DAYS = 7

/**
 * How many codes an environment texted to the numbers of one destination prefix on one day
 * (UTC), and how many of those were then entered correctly (ADR 0037). What an operator reads
 * to spot SMS pumping: a prefix whose codes are sent and never used.
 *
 * One row per environment, day and prefix. **It holds no phone number**: `prefix` is a
 * country calling prefix, at most four digits, and the check `sms_code_counts_prefix_shape`
 * refuses anything longer whatever a statement asks. Nothing says who asked. `used` never
 * exceeds `sent` (`sms_code_counts_bounds`).
 *
 * The day's rows of an environment, added up, are also what its daily limit
 * (`sms.dailyMessageLimit`) is held against.
 *
 * Rows are removed by the retention job (ADR 0017) once their day is older than its period.
 * The runtime role's `DELETE` is bound twice by row-level security: the tenant policy to the
 * environment in scope, and `sms_code_counts_retention_floor` to days more than
 * {@link SMS_COUNT_RETENTION_FLOOR_DAYS} days before today (UTC). Its `UPDATE` is of the two
 * counters and `updated_at` only: a row's day, prefix and environment cannot be rewritten.
 * A counter can still be lowered as far as `sms_code_counts_bounds` lets it (a message that
 * was not sent is counted back out that way), so the table bounds how a count is erased, not
 * that it is right.
 */
export const smsCodeCounts = tula.table(
  'sms_code_counts',
  {
    id: primaryKey(),
    ...tenantColumns(),
    /** The day the codes were sent, in UTC, as `YYYY-MM-DD`. */
    day: date('day', { mode: 'string' }).notNull(),
    /** The destination prefix (`+1`, `+1242`): the contract's `phoneNumberPrefix`. */
    prefix: text('prefix').notNull(),
    sent: integer('sent').notNull().default(0),
    used: integer('used').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    unique('sms_code_counts_environment_day_prefix_key').on(t.environmentId, t.day, t.prefix),
    check('sms_code_counts_prefix_shape', sql`${t.prefix} ~ '^\\+[0-9]{1,4}$'`),
    check(
      'sms_code_counts_bounds',
      sql`${t.sent} >= 0 and ${t.used} >= 0 and ${t.used} <= ${t.sent}`
    ),
    ...tenantConstraints('sms_code_counts', t),
    // Restrictive: ANDed with the tenant policy, so it can only take rows away from a delete.
    // With no `UPDATE` grant on `day`, a row cannot be moved to an old day to get past it.
    pgPolicy('sms_code_counts_retention_floor', {
      as: 'restrictive',
      for: 'delete',
      using: sql.raw(`day < (now() at time zone 'utc')::date - ${SMS_COUNT_RETENTION_FLOOR_DAYS}`),
    }),
  ]
)

/** A row of texted-code counts. */
export type SmsCodeCount = typeof smsCodeCounts.$inferSelect
/** Insert shape for a row of texted-code counts. */
export type NewSmsCodeCount = typeof smsCodeCounts.$inferInsert
