import { index, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { organizationRoles } from './organization-roles'
import { organizations } from './organizations'
import { tula } from './pg-schema'
import { users } from './users'

/**
 * A user's membership of an organization (ADR 0065), with the one role they hold in it.
 *
 * A user has at most one membership per organization
 * (`organization_memberships_organization_user_key`). All three references are composite on
 * the environment (`tenantForeignKey`), so a row cannot join an organization, a user or a role
 * of another environment, which a plain foreign key would allow (checks bypass RLS).
 *
 * Rows go with their organization and with their user, by cascade. The role has **no cascade**:
 * a role that is still assigned cannot be deleted. The runtime role may change `role_id` and
 * `updated_at` only: a row cannot be moved to another user or organization.
 *
 * Which member holds `org:sys:memberships:manage` is read by joining the role; the API keeps
 * the last such member of an organization from being removed or demoted inside a transaction
 * that holds the organization's row.
 */
export const organizationMemberships = tula.table(
  'organization_memberships',
  {
    id: primaryKey(),
    ...tenantColumns(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('organization_memberships_organization_user_key').on(t.organizationId, t.userId),
    tenantForeignKey(
      'organization_memberships_organization_fk',
      t,
      t.organizationId,
      organizations
    ),
    tenantForeignKey('organization_memberships_user_fk', t, t.userId, users),
    tenantForeignKey(
      'organization_memberships_role_fk',
      t,
      t.roleId,
      organizationRoles,
      'no action'
    ),
    // A user's organizations, and the members holding a role.
    index('organization_memberships_user_idx').on(t.environmentId, t.userId),
    index('organization_memberships_role_idx').on(t.environmentId, t.roleId),
    ...tenantConstraints('organization_memberships', t),
  ]
)

/** A membership row. */
export type OrganizationMembershipRow = typeof organizationMemberships.$inferSelect
/** Insert shape for a membership. */
export type NewOrganizationMembershipRow = typeof organizationMemberships.$inferInsert
