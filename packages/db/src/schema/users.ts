import { sql } from 'drizzle-orm'
import { check, text, timestamp, unique } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantParentKey } from '../tenant-columns'
import { tula } from './pg-schema'

/** End users of a customer's app, scoped to one environment. */
export const users = tula.table(
  'users',
  {
    id: primaryKey(),
    ...tenantColumns(),
    /** Email as entered (for display). */
    email: text('email').notNull(),
    /** Lowercased, trimmed email used for lookups and uniqueness. */
    emailNormalized: text('email_normalized').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    firstName: text('first_name'),
    lastName: text('last_name'),
    bannedAt: timestamp('banned_at', { withTimezone: true }),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    /**
     * The account's phone number in E.164 form, set only once the user proved it with a code
     * sent to it. Contact data, not an identifier: it is deliberately **not** unique, and no
     * lookup goes by it (ADR 0037). A number waiting for its code is on the verification
     * token, never here.
     */
    phoneNumber: text('phone_number'),
    /** When `phone_number` was verified. Set and cleared together with it. */
    phoneNumberVerifiedAt: timestamp('phone_number_verified_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('users_environment_email_key').on(t.environmentId, t.emailNormalized),
    // A number is there exactly when its verification time is: neither half alone.
    check(
      'users_phone_number_whole',
      sql`(${t.phoneNumber} IS NULL) = (${t.phoneNumberVerifiedAt} IS NULL)`
    ),
    tenantParentKey('users', t),
    ...tenantConstraints('users', t),
  ]
)

/** A user row. */
export type User = typeof users.$inferSelect
/** Insert shape for a user. */
export type NewUser = typeof users.$inferInsert
