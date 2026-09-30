import { index, jsonb, text, timestamp } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

/** Key lifecycle: `next` is published ahead of use, `active` signs, `retired` only verifies. */
export const SIGNING_KEY_STATUSES = ['next', 'active', 'retired'] as const

/** Ed25519 keys that sign an environment's access tokens. The row id is the JWT `kid`. */
export const signingKeys = tula.table(
  'signing_keys',
  {
    id: primaryKey(),
    ...tenantColumns(),
    algorithm: text('algorithm', { enum: ['EdDSA'] })
      .notNull()
      .default('EdDSA'),
    /** Public JWK served from the environment's JWKS. */
    publicJwk: jsonb('public_jwk').$type<Record<string, string>>().notNull(),
    /** PKCS#8 private key, AES-256-GCM encrypted with `TULA_MASTER_KEY`. */
    privateKeyCiphertext: text('private_key_ciphertext').notNull(),
    status: text('status', { enum: SIGNING_KEY_STATUSES }).notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index('signing_keys_environment_status_idx').on(t.environmentId, t.status),
    ...tenantConstraints('signing_keys', t),
  ]
)

/** A signing key row. */
export type SigningKey = typeof signingKeys.$inferSelect
/** Insert shape for a signing key. */
export type NewSigningKey = typeof signingKeys.$inferInsert
