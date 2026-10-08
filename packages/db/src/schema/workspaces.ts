import { text } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tula } from './pg-schema'

/** Top of the account model: a team that owns projects (control plane, not tenant data). */
export const workspaces = tula.table('workspaces', {
  id: primaryKey(),
  name: text('name').notNull(),
  ...timestamps(),
})

/** A workspace row. */
export type Workspace = typeof workspaces.$inferSelect
/** Insert shape for a workspace. */
export type NewWorkspace = typeof workspaces.$inferInsert
