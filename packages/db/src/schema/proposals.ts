import { sql } from 'drizzle-orm'
import { check, index, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * Changes an AI agent has asked for (ADR 0053): a proposal. A row says what would be done
 * (`operation`) to what (`target_type`, `target_id`), who asked (`proposed_by`, the id of an
 * agent key) and until when a human may approve it (`expires_at`). Nothing happens when a row
 * is inserted.
 *
 * **What a proposal is never changes.** The runtime role may update only the columns that
 * record the decision and its outcome (`status`, `approved_*`, `failure_reason`,
 * `updated_at`): never the operation, the target, who asked or the expiry. So what a human
 * approves is what was proposed, whatever an attacker with the API's own database role tries
 * between the two.
 *
 * `status` is `pending`, `approved`, `executed` or `failed`; "expired" is not stored, it is
 * read from `expires_at`. A row leaves `pending` once, by a compare-and-set in the store, and
 * the check `proposals_approval_whole` keeps the approver and the time together with it.
 *
 * There is no column for text: no reason, no note, no name. A proposal holds ids, times and
 * words from the contract's closed lists, and must never get a column an agent can write
 * prose into. `target_id` and `proposed_by` are deliberately not foreign keys: the row is a
 * record, and outlives a user who was deleted or a key that was revoked.
 */
export const proposals = tula.table(
  'proposals',
  {
    id: primaryKey(),
    ...tenantColumns(),
    /** One of the contract's `PROPOSAL_OPERATIONS`. */
    operation: text('operation').notNull(),
    /** One of the contract's `PROPOSAL_TARGET_TYPES`. */
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    /** The agent key that asked. */
    proposedBy: uuid('proposed_by').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'executed', 'failed'] })
      .notNull()
      .default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** `admin` or `instance_admin`: the kind of credential that approved. */
    approvedByType: text('approved_by_type'),
    /** The approving secret key's id, or the dashboard session's. */
    approvedById: text('approved_by_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** For `failed`: one of the contract's `PROPOSAL_FAILURE_REASONS`. */
    failureReason: text('failure_reason'),
    ...timestamps(),
  },
  (t) => [
    check(
      'proposals_status_known',
      sql`${t.status} in ('pending', 'approved', 'executed', 'failed')`
    ),
    check('proposals_operation_shape', sql`${t.operation} ~ '^[a-z_]{1,64}$'`),
    check('proposals_target_type_shape', sql`${t.targetType} ~ '^[a-z_]{1,64}$'`),
    // Pending means nobody approved; anything else means somebody did, at a known time.
    check(
      'proposals_approval_whole',
      sql`(${t.status} = 'pending') = (${t.approvedAt} is null) and (${t.status} = 'pending') = (${t.approvedByType} is null) and (${t.approvedByType} is null or ${t.approvedByType} in ('admin', 'instance_admin')) and (${t.approvedById} is null or (${t.approvedByType} is not null and char_length(${t.approvedById}) between 1 and 128))`
    ),
    check(
      'proposals_failure_whole',
      sql`(${t.status} = 'failed') = (${t.failureReason} is not null) and (${t.failureReason} is null or ${t.failureReason} ~ '^[a-z_]{1,64}$')`
    ),
    // A proposal lives for minutes. The API sets the lifetime; no write of any kind may make
    // one that can be approved a day later.
    check('proposals_lifetime_bounds', sql`${t.expiresAt} <= ${t.createdAt} + interval '1 hour'`),
    index('proposals_environment_created_idx').on(t.environmentId, t.createdAt),
    ...tenantConstraints('proposals', t),
  ]
)

/** A proposal row. */
export type ProposalRow = typeof proposals.$inferSelect
/** Insert shape for a proposal. */
export type NewProposalRow = typeof proposals.$inferInsert
