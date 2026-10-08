import { foreignKey, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { environments } from './environments'
import { tula } from './pg-schema'
import { projects } from './projects'

/** Publishable keys identify an environment from apps; secret keys authorize server calls. */
export const API_KEY_KINDS = ['publishable', 'secret'] as const

/**
 * Environment API keys, stored only as SHA-256 hashes.
 *
 * Deliberately **not** under row-level security: the key lookup is what *determines* the tenant,
 * so it has to run before any environment is known. Only key resolution and the admin key routes touch it.
 *
 * It still carries the composite `(environment_id, project_id)` foreign key every tenant table
 * has: without row-level security that key is the only thing stopping a row from naming one
 * project and another project's environment, and key resolution trusts both columns.
 */
export const apiKeys = tula.table(
  'api_keys',
  {
    id: primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: API_KEY_KINDS }).notNull(),
    name: text('name').notNull(),
    /** SHA-256 (hex) of the full key. */
    keyHash: text('key_hash').notNull(),
    /** Last 4 characters, for display (`tula_pk_dev_••••8f2a`). */
    lastFour: text('last_four').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('api_keys_key_hash_key').on(t.keyHash),
    foreignKey({
      name: 'api_keys_environment_project_fk',
      columns: [t.environmentId, t.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }).onDelete('cascade'),
    index('api_keys_environment_id_idx').on(t.environmentId),
  ]
)

/** An API key row. */
export type ApiKey = typeof apiKeys.$inferSelect
/** Insert shape for an API key. */
export type NewApiKey = typeof apiKeys.$inferInsert
