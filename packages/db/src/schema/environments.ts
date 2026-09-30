import { index, text, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tula } from './pg-schema'
import { projects } from './projects'

/** Environment kinds shown in the dashboard's Development / Production switch. */
export const ENVIRONMENT_KINDS = ['development', 'production'] as const

/**
 * An isolated copy of a project's users and config (the tenant boundary).
 *
 * Every tenant table carries `environment_id`, and row-level security scopes it to the
 * environment set by `withTenant`.
 */
export const environments = tula.table(
  'environments',
  {
    id: primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ENVIRONMENT_KINDS }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('environments_project_kind_key').on(t.projectId, t.kind),
    // Target of every tenant table's composite FK, which guarantees a row's project_id and
    // environment_id always agree.
    unique('environments_id_project_key').on(t.id, t.projectId),
    index('environments_project_id_idx').on(t.projectId),
  ]
)

/** An environment row. */
export type Environment = typeof environments.$inferSelect
/** Insert shape for an environment. */
export type NewEnvironment = typeof environments.$inferInsert
