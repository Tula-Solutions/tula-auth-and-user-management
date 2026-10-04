import {
  bigint,
  boolean,
  customType,
  index,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { tula } from './pg-schema'
import { users } from './users'

// A `bytea` column read and written as bytes, whichever driver is underneath.
const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
})

/**
 * WebAuthn credentials ("passkeys") of users (ADR 0027).
 *
 * Nothing here is a secret: `public_key` is the credential's COSE public key, and the private
 * key never leaves the authenticator. A table of its own rather than `credentials`, because a
 * user has many and a sign-in looks one up by `credential_id` alone.
 *
 * - `credential_id` is unique per environment (base64url, as the browser sends it).
 * - `user_handle` is the opaque id given to the authenticator as `user.id`: 32 bytes,
 *   `HMAC-SHA256(key from TULA_MASTER_KEY, environment : user)`. It is derived, not random: the
 *   same for every passkey of one user, and it says nothing about the email or the user id to
 *   anyone without the key. Each row stores the handle it was registered with, and an
 *   assertion is checked against its own row's. So after a change of the master key a user's
 *   new passkeys carry a different handle than their existing rows; both keep working.
 * - `sign_count` is the authenticator's signature counter. `0` for one that keeps none (synced
 *   passkeys); otherwise it must grow with every use, and one that does not is refused.
 * - `backup_eligible` / `backed_up` are the BE and BS flags of the last authenticator data.
 */
export const passkeys = tula.table(
  'passkeys',
  {
    id: primaryKey(),
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    credentialId: text('credential_id').notNull(),
    publicKey: bytes('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: jsonb('transports').$type<string[]>().notNull().default([]),
    aaguid: text('aaguid').notNull(),
    backupEligible: boolean('backup_eligible').notNull().default(false),
    backedUp: boolean('backed_up').notNull().default(false),
    userHandle: text('user_handle').notNull(),
    name: text('name').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('passkeys_environment_credential_id_key').on(t.environmentId, t.credentialId),
    index('passkeys_user_id_idx').on(t.userId),
    tenantForeignKey('passkeys_user_fk', t, t.userId, users),
    ...tenantConstraints('passkeys', t),
  ]
)

/** A passkey row. */
export type Passkey = typeof passkeys.$inferSelect
/** Insert shape for a passkey. */
export type NewPasskey = typeof passkeys.$inferInsert
