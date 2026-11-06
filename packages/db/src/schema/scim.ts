import { sql } from 'drizzle-orm'
import { boolean, check, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import {
  tenantColumns,
  tenantConstraints,
  tenantForeignKey,
  tenantParentKey,
} from '../tenant-columns'
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
    // Minted by a setup link's portal: such a token never applies a privileged role (ADR 0067).
    viaSetupLink: boolean('via_setup_link').notNull().default(false),
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

/**
 * A group a directory pushed (ADR 0067, "SCIM"). `display_name` is directory data: the role it
 * maps to is read from `organization_group_roles` when it is applied, and the name is never in
 * an audit entry or an event.
 */
export const scimGroups = tula.table(
  'scim_groups',
  {
    id: primaryKey(),
    ...tenantColumns(),
    organizationId: uuid('organization_id').notNull(),
    displayName: text('display_name').notNull(),
    externalId: text('external_id'),
    ...timestamps(),
  },
  (t) => [
    unique('scim_groups_organization_name_key').on(t.organizationId, t.displayName),
    tenantParentKey('scim_groups', t),
    tenantForeignKey('scim_groups_organization_fk', t, t.organizationId, organizations),
    check('scim_groups_name_bounds', sql`char_length(${t.displayName}) between 1 and 256`),
    check(
      'scim_groups_external_id_bounds',
      sql`${t.externalId} is null or char_length(${t.externalId}) between 1 and 256`
    ),
    ...tenantConstraints('scim_groups', t),
  ]
)

/** A user in a directory group. Rows go with the group or the user (cascade). */
export const scimGroupMembers = tula.table(
  'scim_group_members',
  {
    id: primaryKey(),
    ...tenantColumns(),
    groupId: uuid('group_id').notNull(),
    userId: uuid('user_id').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('scim_group_members_group_user_key').on(t.groupId, t.userId),
    tenantForeignKey('scim_group_members_group_fk', t, t.groupId, scimGroups),
    tenantForeignKey('scim_group_members_user_fk', t, t.userId, users),
    index('scim_group_members_user_idx').on(t.environmentId, t.userId),
    ...tenantConstraints('scim_group_members', t),
  ]
)

/** A SCIM group row. */
export type ScimGroupRow = typeof scimGroups.$inferSelect
/** A SCIM token row. */
export type ScimTokenRow = typeof scimTokens.$inferSelect
/** A SCIM user row. */
export type ScimUserRow = typeof scimUsers.$inferSelect
