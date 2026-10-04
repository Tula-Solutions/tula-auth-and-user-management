import { index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { tula } from './pg-schema'
import { users } from './users'

/** What a stored WebAuthn challenge was issued for. */
export const PASSKEY_CHALLENGE_PURPOSES = ['registration', 'step_up'] as const

/**
 * WebAuthn challenges issued to a signed-in session: for registering a passkey and for a
 * step-up (ADR 0027). A sign-in's challenge lives on its flow attempt instead.
 *
 * A session has at most one challenge per purpose (asking again replaces it). A challenge is
 * taken by deleting its row, so it is honoured once, and only before `expires_at` (five
 * minutes). It is not a secret: the browser is sent it. Expired rows are removed by the
 * retention job (ADR 0017).
 */
export const passkeyChallenges = tula.table(
  'passkey_challenges',
  {
    id: primaryKey(),
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    purpose: text('purpose', { enum: PASSKEY_CHALLENGE_PURPOSES }).notNull(),
    challenge: text('challenge').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('passkey_challenges_session_purpose_key').on(t.sessionId, t.purpose),
    index('passkey_challenges_expires_at_idx').on(t.expiresAt),
    tenantForeignKey('passkey_challenges_user_fk', t, t.userId, users),
    ...tenantConstraints('passkey_challenges', t),
  ]
)

/** A passkey-challenge row. */
export type PasskeyChallenge = typeof passkeyChallenges.$inferSelect
/** Insert shape for a passkey challenge. */
export type NewPasskeyChallenge = typeof passkeyChallenges.$inferInsert
