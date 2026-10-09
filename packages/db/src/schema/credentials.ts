import { integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { tula } from './pg-schema'
import { users } from './users'

/** Credential types. Phase 0 ships `password`. */
export const CREDENTIAL_TYPES = ['password', 'totp', 'passkey'] as const

/**
 * Secrets a user signs in with. `secret` holds an argon2id hash for passwords, or AES-256-GCM
 * ciphertext (under `TULA_MASTER_KEY`) for material that must be recovered (TOTP seeds).
 */
export const credentials = tula.table(
  'credentials',
  {
    id: primaryKey(),
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    type: text('type', { enum: CREDENTIAL_TYPES }).notNull(),
    secret: text('secret').notNull(),
    /** Password-policy revision the secret was last checked against (for "tighten policy"). */
    policyVersion: integer('policy_version').notNull().default(1),
    /**
     * When `secret` last became a **different** secret: for a password, when it was set. What
     * a password's age is counted from (`password.expiryDays`, ADR 0041). Not `updated_at`,
     * which also moves when the same password is hashed again with stronger parameters after
     * a sign-in: a rehash must not make an old password look new.
     */
    secretChangedAt: timestamp('secret_changed_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    // One password per user; passkeys (Phase 1) get their own uniqueness on credential id.
    unique('credentials_user_type_key').on(t.userId, t.type),
    tenantForeignKey('credentials_user_fk', t, t.userId, users),
    ...tenantConstraints('credentials', t),
  ]
)

/** A credential row. */
export type Credential = typeof credentials.$inferSelect
/** Insert shape for a credential. */
export type NewCredential = typeof credentials.$inferInsert
