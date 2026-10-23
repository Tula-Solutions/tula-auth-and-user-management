import { sql } from 'drizzle-orm'
import { check, text, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantParentKey } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * An organization of an environment (ADR 0065): the company, team or workspace a group of the
 * environment's users belongs to.
 *
 * `slug` is unique in the environment (`organizations_environment_slug_key`) and held to the
 * contract's grammar by the database itself (`organizations_slug_shape`): lower-case letters
 * and digits joined by single hyphens, 2 to 48 characters. `name` is text an operator or a
 * user typed: 1 to 100 characters, and it is never put in an event or a log line.
 *
 * `created_by` is the id of the user who created it, or `null` for an organization an
 * administrator created. It is **not a foreign key**, on purpose: it is a record of who made
 * the organization, and it outlives the user (the audit log does too). The per-user cap on
 * created organizations (`organizations.maxCreatedPerUser`) counts it.
 *
 * Memberships go with their organization by cascade. The runtime role may change `name`,
 * `slug` and `updated_at` only.
 */
export const organizations = tula.table(
  'organizations',
  {
    id: primaryKey(),
    ...tenantColumns(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** The user who created it; `null` when an administrator did. Not a foreign key. */
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('organizations_environment_slug_key').on(t.environmentId, t.slug),
    // What `organization_memberships` refers to: a member of an organization of its own
    // environment only.
    tenantParentKey('organizations', t),
    check(
      'organizations_slug_shape',
      sql`char_length(${t.slug}) between 2 and 48 and ${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`
    ),
    check('organizations_name_length', sql`char_length(${t.name}) between 1 and 100`),
    ...tenantConstraints('organizations', t),
  ]
)

/** An organization row. */
export type OrganizationRow = typeof organizations.$inferSelect
/** Insert shape for an organization. */
export type NewOrganizationRow = typeof organizations.$inferInsert
