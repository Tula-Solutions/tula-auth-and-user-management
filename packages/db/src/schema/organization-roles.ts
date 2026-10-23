import { sql } from 'drizzle-orm'
import { boolean, check, text, unique } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantParentKey } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * A role of an environment's organizations (ADR 0065): a set of permission keys, shared by every
 * organization of the environment. A member holds one role in each organization.
 *
 * `key` is unique in the environment and follows the contract's grammar
 * (`organization_roles_key_shape`). `permissions` holds at most 32 keys, each of the contract's
 * grammar (`org:<feature>:<action>`, or `org:sys:<feature>:<action>`; the feature `sys` is
 * reserved to the second form), none twice by construction of the API and none null. The
 * database holds the shape, because the keys are copied into access tokens (ADR 0065, "Token
 * claims"): no writer may put anything else there.
 *
 * `built_in` marks the two roles every environment has, `admin` and `member`. Only those keys
 * may be built in (`organization_roles_built_in_known`), and the runtime role cannot delete
 * a role or change one: it has SELECT and INSERT only in this version. The built-in rows are
 * created for every environment by migration 0036 and, for an environment created since, by
 * the API on first use (`ensureBuiltInRoles`, ADR 0065, "Built-in roles").
 *
 * A membership refers to its role without a cascade: a role that is still assigned cannot be
 * deleted.
 */
export const organizationRoles = tula.table(
  'organization_roles',
  {
    id: primaryKey(),
    ...tenantColumns(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    builtIn: boolean('built_in').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    unique('organization_roles_environment_key_key').on(t.environmentId, t.key),
    // What `organization_memberships` refers to.
    tenantParentKey('organization_roles', t),
    check('organization_roles_key_shape', sql`${t.key} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    check('organization_roles_name_length', sql`char_length(${t.name}) between 1 and 100`),
    check(
      'organization_roles_built_in_known',
      sql`not ${t.builtIn} or ${t.key} in ('admin', 'member')`
    ),
    // Joined by commas, the array must read as permission keys and commas and nothing else, so
    // an element that holds two keys, or half of one, is refused (a key has no comma). A null
    // element is left out by `array_to_string`, so it is refused on its own. `sys` is the one
    // feature with a fourth segment.
    check(
      'organization_roles_permissions_shape',
      sql`cardinality(${t.permissions}) <= 32 and array_position(${t.permissions}, null) is null and array_to_string(${t.permissions}, ',') ~ '^((org:(sys:[a-z][a-z0-9_]{0,31}|(?!sys:)[a-z][a-z0-9_]{0,31}):[a-z][a-z0-9_]{0,31})(,org:(sys:[a-z][a-z0-9_]{0,31}|(?!sys:)[a-z][a-z0-9_]{0,31}):[a-z][a-z0-9_]{0,31})*)?$' and char_length(array_to_string(${t.permissions}, ',')) - char_length(replace(array_to_string(${t.permissions}, ','), ',', '')) = greatest(cardinality(${t.permissions}) - 1, 0)`
    ),
    ...tenantConstraints('organization_roles', t),
  ]
)

/** A role row. */
export type OrganizationRoleRow = typeof organizationRoles.$inferSelect
/** Insert shape for a role. */
export type NewOrganizationRoleRow = typeof organizationRoles.$inferInsert
