import { text, timestamp, unique } from 'drizzle-orm/pg-core'
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
    ...timestamps(),
  },
  (t) => [
    unique('users_environment_email_key').on(t.environmentId, t.emailNormalized),
    tenantParentKey('users', t),
    ...tenantConstraints('users', t),
  ]
)

/** A user row. */
export type User = typeof users.$inferSelect
/** Insert shape for a user. */
export type NewUser = typeof users.$inferInsert
