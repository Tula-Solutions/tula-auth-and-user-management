import { sql } from 'drizzle-orm'
import { check, index, integer, text, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { tula } from './pg-schema'
import { users } from './users'

/**
 * The passwords a user had before their current one (ADR 0038), kept so that the environment's
 * `password.history` can refuse one of them as a new password.
 *
 * One row per previous password. `secret` is the argon2id hash exactly as it stood in
 * `credentials` when the password stopped being the current one: the store copies it from that
 * row inside the transaction that changes the password, so it is as expensive to attack as a
 * current hash and is never a second, cheaper form of the password. The current password is
 * not here: it is the `credentials` row.
 *
 * `position` says how far back a password is: 1 is the one before the current, 2 the one
 * before that. A password change moves every row of the user one further back and deletes
 * what is then beyond what the policy keeps (`history` minus one, the current one counting).
 * It is a column, and not an order read from `created_at`, so that "beyond what the policy
 * keeps" is an indexed range of one environment: the retention job deletes the rows a lowered
 * `password.history` has left behind without reading the rest (ADR 0017).
 *
 * Rows go with their user (the foreign key cascades), and with the password itself when an
 * address is first proven by someone who did not prove the password (ADR 0024): that password
 * and every one before it were chosen by a stranger.
 *
 * The runtime role may change `position` and `updated_at` only: a row's hash, its user and its
 * environment cannot be rewritten.
 */
export const passwordHistory = tula.table(
  'password_history',
  {
    id: primaryKey(),
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    /** The argon2id hash of a previous password, copied from `credentials.secret`. */
    secret: text('secret').notNull(),
    /** 1 for the password before the current one, counting up towards older ones. */
    position: integer('position').notNull(),
    ...timestamps(),
  },
  (t) => [
    tenantForeignKey('password_history_user_fk', t, t.userId, users),
    check('password_history_position_positive', sql`${t.position} >= 1`),
    // A user's rows, newest first: what a new password is compared with.
    index('password_history_user_position_idx').on(t.userId, t.position),
    // The rows beyond what an environment keeps: what the retention job deletes.
    index('password_history_environment_position_idx').on(t.environmentId, t.position),
    ...tenantConstraints('password_history', t),
  ]
)

/** A previous password's row. */
export type PasswordHistoryEntry = typeof passwordHistory.$inferSelect
/** Insert shape for a previous password's row. */
export type NewPasswordHistoryEntry = typeof passwordHistory.$inferInsert
