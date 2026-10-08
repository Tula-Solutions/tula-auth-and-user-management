import { sql } from 'drizzle-orm'
import { boolean, check, integer, text, timestamp, unique } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * The questions an environment has the server ask an operator's endpoint before it acts
 * (ADR 0035): a hook. One row per point at most (`hooks_environment_point_key`).
 *
 * `secret` is the Standard Webhooks signing secret (`whsec_…`) sealed with AES-256-GCM under
 * `TULA_MASTER_KEY`, bound to the environment and the hook's id, under a purpose of its own:
 * a ciphertext copied to another row, or to a webhook endpoint, does not open. It is returned
 * once, when the hook is registered, and by no API afterwards.
 *
 * `deadline_ms` is how long the server waits for the answer. The API validates it, and the
 * database refuses a value outside 100 to 5000 by itself (`hooks_deadline_bounds`): a hook is
 * on the path of someone signing up, and no write of any kind may make that wait longer.
 *
 * `last_failed_at` and `last_failure_reason` are what the operator is shown of a hook that is
 * failing: a time, and one of the server's own fixed words. There is no column for anything
 * the endpoint answered, and there must never be one.
 */
export const hooks = tula.table(
  'hooks',
  {
    id: primaryKey(),
    ...tenantColumns(),
    /** When it is asked. Names from the contract's `HOOK_POINTS`. */
    point: text('point', { enum: ['before_sign_up', 'before_session', 'before_token'] }).notNull(),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    /** A hook that is off is not asked. */
    enabled: boolean('enabled').notNull().default(true),
    deadlineMs: integer('deadline_ms').notNull().default(2000),
    /** What a failed call does: `deny` refuses, `allow` lets through. */
    failureMode: text('failure_mode', { enum: ['deny', 'allow'] })
      .notNull()
      .default('deny'),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true }),
    lastFailureReason: text('last_failure_reason'),
    ...timestamps(),
  },
  (t) => [
    unique('hooks_environment_point_key').on(t.environmentId, t.point),
    check('hooks_deadline_bounds', sql`${t.deadlineMs} between 100 and 5000`),
    check('hooks_failure_mode_known', sql`${t.failureMode} in ('deny', 'allow')`),
    check(
      'hooks_last_failure_whole',
      sql`(${t.lastFailedAt} is null) = (${t.lastFailureReason} is null)`
    ),
    ...tenantConstraints('hooks', t),
  ]
)

/** A hook row. */
export type HookRow = typeof hooks.$inferSelect
/** Insert shape for a hook. */
export type NewHookRow = typeof hooks.$inferInsert
