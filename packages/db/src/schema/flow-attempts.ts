import { jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import {
  tenantColumns,
  tenantConstraints,
  tenantForeignKey,
  tenantParentKey,
} from '../tenant-columns'
import { tula } from './pg-schema'
import { users } from './users'

/** In-progress sign-in, sign-up and password-reset attempts driving the server-side flow state machine (§5.2). */
export const flowAttempts = tula.table(
  'flow_attempts',
  {
    id: primaryKey(),
    ...tenantColumns(),
    kind: text('kind', { enum: ['sign_in', 'sign_up', 'password_reset'] }).notNull(),
    /** The current `FlowStep` status from `@tula/contract`. */
    status: text('status').notNull(),
    /** Set once the identifier resolves to a user (never exposed to the client before then). */
    userId: uuid('user_id'),
    /** Normalized identifier the attempt started with. */
    identifier: text('identifier').notNull(),
    /**
     * SHA-256 of the attempt's secret, which every call after the start must present. `NULL` only
     * on rows written before the column existed; such an attempt can never be continued.
     */
    secretHash: text('secret_hash'),
    /** Step-specific server state (never sent to clients). */
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    tenantParentKey('flow_attempts', t),
    tenantForeignKey('flow_attempts_user_fk', t, t.userId, users),
    ...tenantConstraints('flow_attempts', t),
  ]
)

/** A flow attempt row. */
export type FlowAttemptRow = typeof flowAttempts.$inferSelect
/** Insert shape for a flow attempt. */
export type NewFlowAttemptRow = typeof flowAttempts.$inferInsert
