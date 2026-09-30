import { index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import {
  tenantColumns,
  tenantConstraints,
  tenantForeignKey,
  tenantParentKey,
} from '../tenant-columns'
import { tula } from './pg-schema'
import { sessions } from './sessions'

/**
 * Opaque, single-use refresh tokens, stored only as SHA-256 hashes and chained parent → child.
 *
 * Rotation sets `used_at` and `replaced_by_id`. The child token's secret is **derived**, not
 * stored: `HMAC(refresh-derivation key, parent id)`. So within the profile's `reuseGracePeriod`
 * the server can hand a racing client the same child again without keeping any recoverable token
 * material in the database. Any reuse after the window revokes the session (the token family).
 *
 * Pruning is **by session only**: delete expired/revoked sessions and let the cascade remove their
 * whole chain in one statement. Deleting individual tokens is rejected by the self-referencing
 * foreign keys (a parent's `replaced_by_id` or a child's `parent_id` would dangle).
 */
export const refreshTokens = tula.table(
  'refresh_tokens',
  {
    id: primaryKey(),
    ...tenantColumns(),
    sessionId: uuid('session_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    parentId: uuid('parent_id'),
    replacedById: uuid('replaced_by_id'),
    usedAt: timestamp('used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('refresh_tokens_token_hash_key').on(t.tokenHash),
    index('refresh_tokens_session_id_idx').on(t.sessionId),
    tenantParentKey('refresh_tokens', t),
    tenantForeignKey('refresh_tokens_session_fk', t, t.sessionId, sessions),
    // Self references: rows only disappear together, via the session cascade.
    tenantForeignKey('refresh_tokens_parent_fk', t, t.parentId, t, 'no action'),
    tenantForeignKey('refresh_tokens_replaced_by_fk', t, t.replacedById, t, 'no action'),
    ...tenantConstraints('refresh_tokens', t),
  ]
)

/** A refresh token row. */
export type RefreshToken = typeof refreshTokens.$inferSelect
/** Insert shape for a refresh token. */
export type NewRefreshToken = typeof refreshTokens.$inferInsert
