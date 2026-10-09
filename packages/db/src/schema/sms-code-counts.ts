import { sql } from 'drizzle-orm'
import { check, date, integer, text, unique } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

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
  ]
)

/** A row of texted-code counts. */
export type SmsCodeCount = typeof smsCodeCounts.$inferSelect
/** Insert shape for a row of texted-code counts. */
export type NewSmsCodeCount = typeof smsCodeCounts.$inferInsert
