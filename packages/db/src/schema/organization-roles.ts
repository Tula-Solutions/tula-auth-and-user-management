import { sql } from 'drizzle-orm'
import { boolean, check, integer, pgPolicy, text, unique } from 'drizzle-orm/pg-core'
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
 * may be built in (`organization_roles_built_in_known`), and only built-in roles may take them
 * (`organization_roles_reserved_keys`): a custom role named `admin` would be taken for the
 * built-in one wherever a role is found by its key. The built-in rows are created for every
 * environment by migration 0036 and, for an environment created since, by the API on first use
 * (`ensureBuiltInRoles`, ADR 0065, "Built-in roles").
 *
 * The runtime role may change a custom role's name and permissions and delete a custom role
 * (migration 0037, ADR 0065, "Custom roles"), and **no statement of its can touch a built-in
 * row**: two restrictive policies take them out of every UPDATE and DELETE, whatever the API
 * asks. `version` counts the changes made to a role, from 1; the API's `If-Match` carries it.
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
    version: integer('version').notNull().default(1),
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
    check(
      'organization_roles_reserved_keys',
      sql`${t.builtIn} or ${t.key} not in ('admin', 'member')`
    ),
    check('organization_roles_version_positive', sql`${t.version} >= 1`),
    // Joined by commas, the array must read as permission keys and commas and nothing else, so
    // an element that holds two keys, or half of one, is refused (a key has no comma). A null
    // element is left out by `array_to_string`, so it is refused on its own. `sys` is the one
    // feature with a fourth segment.
    check(
      'organization_roles_permissions_shape',
      sql`cardinality(${t.permissions}) <= 32 and array_position(${t.permissions}, null) is null and array_to_string(${t.permissions}, ',') ~ '^((org:(sys:[a-z][a-z0-9_]{0,31}|(?!sys:)[a-z][a-z0-9_]{0,31}):[a-z][a-z0-9_]{0,31})(,org:(sys:[a-z][a-z0-9_]{0,31}|(?!sys:)[a-z][a-z0-9_]{0,31}):[a-z][a-z0-9_]{0,31})*)?$' and char_length(array_to_string(${t.permissions}, ',')) - char_length(replace(array_to_string(${t.permissions}, ','), ',', '')) = greatest(cardinality(${t.permissions}) - 1, 0)`
    ),
    ...tenantConstraints('organization_roles', t),
    // Restrictive: ANDed with the tenant policy, so they can only take rows away. A built-in
    // role can be neither rewritten nor deleted by the runtime role, whatever it asks. (A
    // foreign key's cascade, an environment's deletion, is not a statement of the role's.)
    pgPolicy('organization_roles_custom_update_only', {
      as: 'restrictive',
      for: 'update',
      using: sql`not built_in`,
      withCheck: sql`not built_in`,
    }),
    pgPolicy('organization_roles_custom_delete_only', {
      as: 'restrictive',
      for: 'delete',
      using: sql`not built_in`,
    }),
  ]
)

/** A role row. */
export type OrganizationRoleRow = typeof organizationRoles.$inferSelect
/** Insert shape for a role. */
export type NewOrganizationRoleRow = typeof organizationRoles.$inferInsert
