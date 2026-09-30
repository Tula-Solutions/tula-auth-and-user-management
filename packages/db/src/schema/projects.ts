import { index, text, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tula } from './pg-schema'
import { workspaces } from './workspaces'

/** An app a workspace secures, e.g. "Mobile app" (control plane). */
export const projects = tula.table(
  'projects',
  {
    id: primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ...timestamps(),
  },
  (t) => [index('projects_workspace_id_idx').on(t.workspaceId)]
)

/** A project row. */
export type Project = typeof projects.$inferSelect
/** Insert shape for a project. */
export type NewProject = typeof projects.$inferInsert
