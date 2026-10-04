import { bigint, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { tula } from './pg-schema'
import { users } from './users'

/** Second-factor types stored here. Passkeys (step 1.10) get their own table. */
export const USER_FACTOR_TYPES = ['totp'] as const

/**
 * A user's second factor: an authenticator app (TOTP, ADR 0025).
 *
 * Its own table rather than a `credentials` row because a factor has a lifecycle a password
 * does not: it is **pending** until confirmed with a code (`confirmed_at` is null and
 * `expires_at` says when the enrolment lapses), it carries a replay counter (`last_used_step`,
 * the last RFC 6238 time step a code was accepted for; a code is accepted only for a strictly
 * greater one), and later a name. One row per user and type: starting again replaces a pending
 * row, never a confirmed one.
 *
 * `secret` is the shared secret sealed with AES-256-GCM under `TULA_MASTER_KEY`, bound to the
 * environment, the user and this row's id, so a ciphertext copied to another row does not
 * decrypt.
 */
export const userFactors = tula.table(
  'user_factors',
  {
    id: primaryKey(),
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    type: text('type', { enum: USER_FACTOR_TYPES }).notNull(),
    secret: text('secret').notNull(),
    name: text('name'),
    /** `null` while the enrolment is pending: a pending factor is never asked for or accepted. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** When a pending enrolment lapses; `null` once confirmed. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedStep: bigint('last_used_step', { mode: 'number' }),
    ...timestamps(),
  },
  (t) => [
    unique('user_factors_user_type_key').on(t.userId, t.type),
    index('user_factors_expires_at_idx').on(t.expiresAt),
    tenantForeignKey('user_factors_user_fk', t, t.userId, users),
    ...tenantConstraints('user_factors', t),
  ]
)

/** A second-factor row. */
export type UserFactor = typeof userFactors.$inferSelect
/** Insert shape for a second factor. */
export type NewUserFactor = typeof userFactors.$inferInsert
