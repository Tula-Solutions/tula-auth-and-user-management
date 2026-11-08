import { sql } from 'drizzle-orm'
import { check, integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * One version of a role's permissions (ADR 0068, "Snapshots"): written with every role creation
 * and every change of its permissions, in the same transaction, and never changed or removed by
 * the runtime role (it holds `INSERT` and `SELECT` only, migration 0062).
 *
 * `role_id` has no foreign key on purpose: the history outlives a deleted role, and a key that is
 * created again restarts at version 1 under a new id without meeting the old rows.
 * `permissions_hash` is the contract's `permissionsHash` of `permissions`, the value an access
 * token carries as `org_ph`.
 */
export const organizationRoleVersions = tula.table(
  'organization_role_versions',
  {
    id: primaryKey(),
    ...tenantColumns(),
    roleId: uuid('role_id').notNull(),
    roleKey: text('role_key').notNull(),
    version: integer('version').notNull(),
    permissions: text('permissions').array().notNull(),
    permissionsHash: text('permissions_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('organization_role_versions_role_version_key').on(t.environmentId, t.roleId, t.version),
    check('organization_role_versions_version_positive', sql`${t.version} >= 1`),
    check(
      'organization_role_versions_hash_shape',
      sql`${t.permissionsHash} ~ '^1\\.[A-Za-z0-9_-]{43}$'`
    ),
    ...tenantConstraints('organization_role_versions', t),
  ]
)

/** A role version row. */
export type OrganizationRoleVersionRow = typeof organizationRoleVersions.$inferSelect
/** Insert shape for a role version. */
export type NewOrganizationRoleVersionRow = typeof organizationRoleVersions.$inferInsert
