import { index, integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { flowAttempts } from './flow-attempts'
import { tula } from './pg-schema'
import { users } from './users'

/**
 * What a verification token proves. The column is plain `text`, so a new purpose needs no
 * migration; `sign_in` is the emailed code or link that is a sign-in's first factor.
 */
export const VERIFICATION_PURPOSES = ['email_verification', 'password_reset', 'sign_in'] as const

/**
 * Emailed codes and magic links, with an attempt counter so codes can't be brute-forced online.
 *
 * `code_hash` is a **keyed** hash, `HMAC-SHA256(verification key, token id || code)`: a 6-digit
 * code has only 10^6 values, so a plain SHA-256 would be reversed instantly by anyone who can read
 * a row (backup, replica, SQL injection). `link_token_hash` is plain SHA-256 because link tokens
 * are 256-bit random values.
 */
export const verificationTokens = tula.table(
  'verification_tokens',
  {
    id: primaryKey(),
    ...tenantColumns(),
    userId: uuid('user_id'),
    flowAttemptId: uuid('flow_attempt_id'),
    purpose: text('purpose', { enum: VERIFICATION_PURPOSES }).notNull(),
    /** Where it was sent (normalized email). */
    destination: text('destination').notNull(),
    codeHash: text('code_hash').notNull(),
    linkTokenHash: text('link_token_hash'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('verification_tokens_link_token_hash_key').on(t.linkTokenHash),
    index('verification_tokens_flow_attempt_id_idx').on(t.flowAttemptId),
    tenantForeignKey('verification_tokens_user_fk', t, t.userId, users),
    tenantForeignKey('verification_tokens_flow_attempt_fk', t, t.flowAttemptId, flowAttempts),
    ...tenantConstraints('verification_tokens', t),
  ]
)

/** A verification token row. */
export type VerificationToken = typeof verificationTokens.$inferSelect
/** Insert shape for a verification token. */
export type NewVerificationToken = typeof verificationTokens.$inferInsert
