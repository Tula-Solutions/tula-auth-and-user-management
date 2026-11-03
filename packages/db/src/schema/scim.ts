import { sql } from 'drizzle-orm'
import { boolean, check, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { organizations } from './organizations'
import { tula } from './pg-schema'
import { users } from './users'

/**
 * A SCIM bearer token of an organization's directory (ADR 0067, "SCIM").
 *
 * Only the SHA-256 of the token is stored; `prefix` is its first characters, for the list. The
 * token names its environment, so the row is found by hash inside that environment and
 * row-level security holds.
 */
export const scimTokens = tula.table(
  'scim_tokens',
  {
    id: primaryKey(),
    ...tenantColumns(),
    organizationId: uuid('organization_id').notNull(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('scim_tokens_token_hash_key').on(t.tokenHash),
    tenantForeignKey('scim_tokens_organization_fk', t, t.organizationId, organizations),
    index('scim_tokens_organization_idx').on(t.environmentId, t.organizationId),
    check('scim_tokens_name_bounds', sql`char_length(${t.name}) between 1 and 100`),
    ...tenantConstraints('scim_tokens', t),
  ]
)

/**
 * A user a directory provisioned or was linked to (ADR 0067, "SCIM"): its `externalId` and
 * whether the directory says the user is `active`. A deactivated user has no membership, so
 * this row is what a later GET answers from.
 */
export const scimUsers = tula.table(
  'scim_users',
  {
    id: primaryKey(),
    ...tenantColumns(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    externalId: text('external_id'),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('scim_users_organization_user_key').on(t.organizationId, t.userId),
    unique('scim_users_organization_external_key').on(t.organizationId, t.externalId),
    tenantForeignKey('scim_users_organization_fk', t, t.organizationId, organizations),
    tenantForeignKey('scim_users_user_fk', t, t.userId, users),
    index('scim_users_user_idx').on(t.environmentId, t.userId),
    check(
      'scim_users_external_id_bounds',
      sql`${t.externalId} is null or char_length(${t.externalId}) between 1 and 256`
    ),
    ...tenantConstraints('scim_users', t),
  ]
)

/** A SCIM token row. */
export type ScimTokenRow = typeof scimTokens.$inferSelect
/** A SCIM user row. */
export type ScimUserRow = typeof scimUsers.$inferSelect
