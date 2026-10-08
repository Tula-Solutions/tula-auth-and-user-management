import { sql } from 'drizzle-orm'
import { type AnyPgColumn, foreignKey, index, pgPolicy, unique, uuid } from 'drizzle-orm/pg-core'
import { environments } from './schema/environments'
import { projects } from './schema/projects'

/** Name of the transaction-local setting that carries the current environment id. */
export const TENANT_SETTING = 'tula.environment_id'

/**
 * RLS predicate shared by every tenant policy. With no setting (a code path that skipped
 * `withTenant`) it compares against NULL and matches nothing: fail closed.
 */
export const TENANT_PREDICATE = sql.raw(
  `environment_id = nullif(current_setting('${TENANT_SETTING}', true), '')::uuid`
)

/**
 * `project_id` and `environment_id` columns for a tenant table.
 *
 * @returns The two column definitions, to spread into a table.
 */
export function tenantColumns() {
  return {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
  }
}

/**
 * Constraints every tenant table needs: a composite FK proving `(environment_id, project_id)`
 * belong together, an index on `environment_id`, and the row-level-security policy.
 *
 * FORCE ROW LEVEL SECURITY can't be declared in Drizzle; it lives in a SQL migration, and the RLS
 * test fails for any tenant table that lacks it.
 *
 * @param table - Table name, used to name the constraints.
 * @param t - The table's columns.
 * @returns Extra config to return from the table's third argument.
 */
export function tenantConstraints(
  table: string,
  t: { projectId: AnyPgColumn; environmentId: AnyPgColumn }
) {
  return [
    foreignKey({
      name: `${table}_environment_project_fk`,
      columns: [t.environmentId, t.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }).onDelete('cascade'),
    index(`${table}_environment_id_idx`).on(t.environmentId),
    pgPolicy(`${table}_tenant_isolation`, {
      as: 'permissive',
      for: 'all',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ]
}

/**
 * A foreign key from a tenant row to another tenant row **in the same environment**.
 *
 * Postgres checks foreign keys without applying row-level security, so a plain
 * `user_id → users.id` would let an environment-A row point at an environment-B user. Making the
 * key `(environment_id, <column>) → parent(environment_id, id)` makes that impossible. The parent
 * needs a unique `(id, environment_id)` constraint (`tenantParentKey`).
 *
 * @param name - Constraint name.
 * @param t - The child table's `environmentId` column.
 * @param column - The child's reference column (e.g. `userId`).
 * @param parent - The parent table's `environmentId` and `id` columns.
 * @param onDelete - Cascade (default) or `no action` for self references.
 * @returns The foreign key builder.
 */
export function tenantForeignKey(
  name: string,
  t: { environmentId: AnyPgColumn },
  column: AnyPgColumn,
  parent: { environmentId: AnyPgColumn; id: AnyPgColumn },
  onDelete: 'cascade' | 'no action' = 'cascade'
) {
  return foreignKey({
    name,
    columns: [t.environmentId, column],
    foreignColumns: [parent.environmentId, parent.id],
  }).onDelete(onDelete)
}

/**
 * Unique `(environment_id, id)` on a table that other tenant rows reference, the target of
 * {@link tenantForeignKey}.
 *
 * @param table - Table name, used to name the constraint.
 * @param t - The table's columns.
 * @returns The unique constraint builder.
 */
export function tenantParentKey(table: string, t: { environmentId: AnyPgColumn; id: AnyPgColumn }) {
  return unique(`${table}_environment_id_id_key`).on(t.environmentId, t.id)
}
