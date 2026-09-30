import { index, text, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { tula } from './pg-schema'
import { users } from './users'

/** Identity providers. Phase 0 ships `email`; social providers arrive in Phase 1. */
export const IDENTITY_PROVIDERS = ['email', 'google', 'apple', 'github'] as const

/** How a user proves who they are: one row per provider account (email address, Google sub…). */
export const identities = tula.table(
  'identities',
  {
    id: primaryKey(),
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    provider: text('provider', { enum: IDENTITY_PROVIDERS }).notNull(),
    /** The provider's stable id for the account (normalized email for `email`). */
    providerSubject: text('provider_subject').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('identities_environment_provider_subject_key').on(
      t.environmentId,
      t.provider,
      t.providerSubject
    ),
    index('identities_user_id_idx').on(t.userId),
    tenantForeignKey('identities_user_fk', t, t.userId, users),
    ...tenantConstraints('identities', t),
  ]
)

/** An identity row. */
export type Identity = typeof identities.$inferSelect
/** Insert shape for an identity. */
export type NewIdentity = typeof identities.$inferInsert
