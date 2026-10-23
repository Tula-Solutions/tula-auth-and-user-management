import { sql } from 'drizzle-orm'
import { check, index, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { organizations } from './organizations'
import { tula } from './pg-schema'

/**
 * An invitation to join an organization (ADR 0065, Orgs 04).
 *
 * - `email` is the invited address as it was typed (what the email is sent to) and
 *   `email_normalized` the same trimmed, with the ASCII letters lower-cased (as `users` holds
 *   them): the signed-in user's verified address must equal the latter for the invitation to
 *   be accepted. Personal data like a user's address: never in a log line, an event or an
 *   error.
 * - `role_key` is the role's **key**, not a foreign key to the role: deleting a role must not
 *   be blocked by, or silently delete, old invitations. An invitation whose role was deleted
 *   since is refused at acceptance (`organization.invitation_role_gone`); it is never given
 *   another role.
 * - `token_hash` is the SHA-256 of the high-entropy token the emailed link carries. The token
 *   itself is never stored. Unique, so a token finds at most one invitation.
 * - `status` is `pending` until the invitation is accepted, declined or revoked; each of the
 *   three is final. A pending row past `expires_at` is *expired*: that is derived, not stored.
 *   `resolved_at` and `resolved_by` say when and (for an accept or a decline) by whom.
 * - At most one **pending** invitation per organization and address
 *   (`organization_invitations_pending_key`, a partial unique index). A pending row that has
 *   expired still holds the index until it is replaced or purged: the store removes an expired
 *   one in the same transaction as the new invitation.
 *
 * The organization's rows take their invitations with them (cascade). `invited_by` is a user's
 * id or `null` (an administrator): not a foreign key, as for `organizations.created_by`. The
 * runtime role may update the three columns a resolution writes and delete (the retention job
 * purges rows past their expiry).
 */
export const organizationInvitations = tula.table(
  'organization_invitations',
  {
    id: primaryKey(),
    ...tenantColumns(),
    organizationId: uuid('organization_id').notNull(),
    email: text('email').notNull(),
    emailNormalized: text('email_normalized').notNull(),
    roleKey: text('role_key').notNull(),
    tokenHash: text('token_hash').notNull(),
    status: text('status').notNull().default('pending'),
    invitedBy: uuid('invited_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by'),
    ...timestamps(),
  },
  (t) => [
    unique('organization_invitations_token_hash_key').on(t.tokenHash),
    uniqueIndex('organization_invitations_pending_key')
      .on(t.organizationId, t.emailNormalized)
      .where(sql`${t.status} = 'pending'`),
    tenantForeignKey(
      'organization_invitations_organization_fk',
      t,
      t.organizationId,
      organizations
    ),
    check(
      'organization_invitations_status_known',
      sql`${t.status} in ('pending', 'accepted', 'declined', 'revoked')`
    ),
    check('organization_invitations_role_key_shape', sql`${t.roleKey} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    check(
      'organization_invitations_email_length',
      sql`char_length(${t.email}) between 3 and 320 and char_length(${t.emailNormalized}) between 3 and 320`
    ),
    // A resolved invitation says when; a pending one does not.
    check(
      'organization_invitations_resolved_consistent',
      sql`(${t.status} = 'pending') = (${t.resolvedAt} is null)`
    ),
    // An organization's invitations, newest first; the purge by expiry.
    index('organization_invitations_organization_idx').on(t.environmentId, t.organizationId),
    index('organization_invitations_expires_idx').on(t.environmentId, t.expiresAt),
    // The invitee's own list (`GET /v1/client/me/organization-invitations`): by address, across
    // organizations. Partial: only a pending row is ever listed.
    index('organization_invitations_email_idx')
      .on(t.environmentId, t.emailNormalized)
      .where(sql`${t.status} = 'pending'`),
    ...tenantConstraints('organization_invitations', t),
  ]
)

/** An invitation row. */
export type OrganizationInvitationRow = typeof organizationInvitations.$inferSelect
/** Insert shape for an invitation. */
export type NewOrganizationInvitationRow = typeof organizationInvitations.$inferInsert
