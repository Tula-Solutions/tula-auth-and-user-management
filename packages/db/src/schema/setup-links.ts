import { sql } from 'drizzle-orm'
import { check, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { organizations } from './organizations'
import { tula } from './pg-schema'

/**
 * A setup link: the credential an organization's IT administrator uses to set up single
 * sign-on without an account (ADR 0067, "Setup links").
 *
 * Only the SHA-256 of the token is stored; `prefix` is its first characters, for the list. The
 * token names its environment, so the row is found by hash inside that environment and
 * row-level security holds. A link expires (`expiresAt`) and can be revoked; the retention
 * job deletes it once it has been expired for a while.
 */
export const setupLinks = tula.table(
  'setup_links',
  {
    id: primaryKey(),
    ...tenantColumns(),
    organizationId: uuid('organization_id').notNull(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Who created it: the audit actor's type and id (a secret key, a dashboard session, a user). */
    createdByType: text('created_by_type').notNull(),
    createdById: text('created_by_id'),
    ...timestamps(),
  },
  (t) => [
    unique('setup_links_token_hash_key').on(t.tokenHash),
    tenantForeignKey('setup_links_organization_fk', t, t.organizationId, organizations),
    index('setup_links_organization_idx').on(t.environmentId, t.organizationId),
    index('setup_links_expiry_idx').on(t.environmentId, t.expiresAt),
    check('setup_links_name_bounds', sql`char_length(${t.name}) between 1 and 100`),
    ...tenantConstraints('setup_links', t),
  ]
)

/** A setup link row. */
export type SetupLinkRow = typeof setupLinks.$inferSelect
