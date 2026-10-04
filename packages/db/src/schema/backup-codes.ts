import { index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { tula } from './pg-schema'
import { users } from './users'

/**
 * Single-use backup codes for two-step verification (ADR 0025).
 *
 * `code_hash` is a **keyed** hash, `HMAC-SHA256(backup-code key, environment : user : code)`.
 * A code has about 50 bits of entropy: far more than an emailed 6-digit code, but a plain
 * SHA-256 would still let whoever reads a row test guesses offline, so the key from
 * `TULA_MASTER_KEY` stays in the way. Binding the hash to the user means a row copied to
 * another user matches nothing.
 *
 * A code is spent by setting `used_at` in one guarded update, so it works exactly once. A
 * user's rows are all replaced when the codes are regenerated and all deleted when two-step
 * verification is turned off or reset.
 */
export const backupCodes = tula.table(
  'backup_codes',
  {
    id: primaryKey(),
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('backup_codes_user_code_hash_key').on(t.userId, t.codeHash),
    index('backup_codes_user_id_idx').on(t.userId),
    tenantForeignKey('backup_codes_user_fk', t, t.userId, users),
    ...tenantConstraints('backup_codes', t),
  ]
)

/** A backup-code row. */
export type BackupCode = typeof backupCodes.$inferSelect
/** Insert shape for a backup code. */
export type NewBackupCode = typeof backupCodes.$inferInsert
