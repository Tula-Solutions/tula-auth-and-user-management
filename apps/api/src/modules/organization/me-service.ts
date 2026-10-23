import type {
  ActiveOrganization,
  CreateOrganizationRequest,
  UserOrganization,
  UserOrganizationList,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as Audit from '~/modules/audit/service'
import { requireEnabled, requireRole } from '~/modules/organization/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
import type { PageCriteria, UserMembershipRecord } from '~/ports/organization-store'

// A signed-in user's own organizations (ADR 0065, Orgs 02): the list, creating one and the
// session's active one. Every function starts with `requireEnabled` (organizations off: the
// same `organization.disabled` for everything, reads included) and only ever touches the
// caller's own memberships: there is no organization id in a path that a caller could use to
// look at an organization they do not belong to.

/** The signed-in user and their session, from the verified access token. */
export interface Self {
  userId: string
  sessionId: string
}

type ReadDeps = Pick<Deps, 'organizations' | 'environmentSettings' | 'config' | 'sessions'>

/** The public view of a membership: the organization, the user's role and its permissions. */
function view({ organization, membership, permissions }: UserMembershipRecord): UserOrganization {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role: membership.roleKey,
    permissions: [...permissions],
    createdAt: organization.createdAt.toISOString(),
  }
}

/**
 * List the organizations the signed-in user belongs to, with their role in each, and say
 * which one the session acts in.
 *
 * @param deps - Organization store, sessions, settings and config.
 * @param tenant - The environment.
 * @param self - The signed-in user and their session.
 * @param page - Which page, and how long.
 * @returns The page, its paging details and the session's active organization (`null` for the
 *   personal account, or for an organization the user has left).
 * @throws AuthError `organization.disabled` while organizations are switched off.
 */
export async function list(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  self: Self,
  page: PageCriteria
): Promise<UserOrganizationList> {
  await requireEnabled(deps, tenant)
  const { records, total } = await deps.organizations.listUserMemberships(
    tenant.environmentId,
    self.userId,
    page
  )
  const session = await deps.sessions.findById(tenant.environmentId, self.sessionId)
  const stored = session?.userId === self.userId ? session.activeOrganizationId : null
  // Only an organization the user still belongs to is "active": the stored id alone says what
  // they chose, not what they may use.
  const active = stored
    ? await deps.organizations.findUserMembership(tenant.environmentId, stored, self.userId)
    : null
  return {
    activeOrganizationId: active?.organization.id ?? null,
    meta: {
      totalCount: total,
      totalPages: Math.ceil(total / page.size),
      page: page.page,
      perPage: page.size,
    },
    data: records.map(view),
  }
}

/**
 * Create an organization for the signed-in user, who becomes its first member with the
 * environment's `creatorRole`. Allowed only where `organizations.allowUserCreated` is on, and
 * up to `maxCreatedPerUser` organizations per user (counted among those they created, whether
 * or not they are still members). The organization and the membership are one transaction.
 * The session is not switched to it: that is the client's next call.
 *
 * @param deps - The organization store, the settings, ids and clock.
 * @param tenant - The environment.
 * @param self - The signed-in user and their session.
 * @param input - Name and slug.
 * @param actor - The user, for the audit log.
 * @returns The organization with the creator's role and permissions.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws AuthError `organization.creation_disabled` when users may not create organizations.
 * @throws AuthError `organization.role_unknown` when the environment's `creatorRole` names no role.
 * @throws AuthError `organization.slug_taken` when the environment has that slug already.
 * @throws AuthError `organization.limit_reached` when the user has created as many as allowed.
 * @throws NotFoundError when the user no longer exists.
 */
export async function create(
  deps: Pick<Deps, 'organizations' | 'environmentSettings' | 'config' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  self: Pick<Self, 'userId'>,
  input: CreateOrganizationRequest,
  actor: Actor
): Promise<UserOrganization> {
  await requireEnabled(deps, tenant)
  const { organizations } = await Settings.current(deps, tenant)
  if (!organizations.allowUserCreated) {
    throw new AuthError('organization.creation_disabled')
  }
  const role = await requireRole(deps, tenant, organizations.creatorRole)
  const id = deps.ids.next()
  const membershipId = deps.ids.next()
  const created = Audit.entry(deps, tenant, {
    type: 'organization.created',
    actor,
    target: { type: 'organization', id },
  })
  const joined = Audit.entry(deps, tenant, {
    type: 'organization_membership.added',
    actor,
    target: { type: 'organization_membership', id: membershipId },
    data: { organizationId: id, userId: self.userId, role: role.key },
  })
  const result = await deps.organizations.insertOwned(
    {
      organization: {
        id,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        name: input.name,
        slug: input.slug,
        createdBy: self.userId,
        createdAt: created.occurredAt,
        updatedAt: created.occurredAt,
      },
      membership: {
        id: membershipId,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        organizationId: id,
        userId: self.userId,
        roleId: role.id,
        roleKey: role.key,
        createdAt: joined.occurredAt,
        updatedAt: joined.occurredAt,
      },
      permissions: role.permissions,
      limit: organizations.maxCreatedPerUser,
    },
    { organization: created, membership: joined }
  )
  switch (result.outcome) {
    case 'created':
      return view(result.record)
    case 'slug_taken':
      throw new AuthError('organization.slug_taken')
    case 'limit_reached':
      throw new AuthError('organization.limit_reached')
    case 'gone':
      // The user, or the role, was deleted between the reads and the write.
      throw new NotFoundError()
  }
}

/**
 * Make an organization the one the signed-in user's session acts in, or clear it.
 *
 * The user must belong to the organization **now**: an organization that does not exist, is
 * another environment's, or is simply not theirs all answer `organization.not_a_member`, so
 * the answer says nothing about what exists. Clearing needs the environment to allow a
 * personal account (`organizations.personalAccount`). A `hybrid` session gets a new access
 * token that carries the claims at once; the refresh token is untouched. The choice is
 * stored on the session, and every later token re-reads the membership (`claims.ts`).
 *
 * @param deps - The organization store, sessions, signing keys, settings, clock and ids.
 * @param tenant - The environment.
 * @param self - The signed-in user and their session.
 * @param organizationId - The organization to act in, or `null` for the personal account.
 * @returns The session and its active organization, with a fresh access token for a `hybrid`
 *   session.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws AuthError `organization.not_a_member` when the user does not belong to it.
 * @throws AuthError `organization.personal_account_disabled` when clearing is not allowed.
 * @throws AuthError `session.revoked` when the session has ended.
 */
export async function setActive(
  deps: Parameters<typeof Sessions.setActiveOrganization>[0] &
    Pick<Deps, 'organizations' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  self: Self,
  organizationId: string | null
): Promise<ActiveOrganization> {
  await requireEnabled(deps, tenant)
  if (organizationId === null) {
    const { organizations } = await Settings.current(deps, tenant)
    if (!organizations.personalAccount) {
      throw new AuthError('organization.personal_account_disabled')
    }
    return Sessions.setActiveOrganization(deps, tenant, self, null)
  }
  const held = await deps.organizations.findUserMembership(
    tenant.environmentId,
    organizationId,
    self.userId
  )
  if (!held) {
    throw new AuthError('organization.not_a_member')
  }
  return Sessions.setActiveOrganization(deps, tenant, self, held)
}
