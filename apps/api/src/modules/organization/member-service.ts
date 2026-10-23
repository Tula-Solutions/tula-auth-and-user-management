import {
  type AssignableRoleList,
  INVITATIONS_MANAGE_PERMISSION,
  MEMBERSHIPS_MANAGE_PERMISSION,
  MEMBERSHIPS_READ_PERMISSION,
  ORGANIZATION_DELETE_PERMISSION,
  ORGANIZATION_MANAGE_PERMISSION,
  type OrganizationMember,
  type OrganizationMemberList,
  type UpdateOrganizationMemberRequest,
  type UpdateOrganizationRequest,
  type UserOrganization,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as Organizations from '~/modules/organization/service'
import type {
  MembershipRecord,
  PageCriteria,
  UserMembershipRecord,
} from '~/ports/organization-store'

// What a signed-in member does to the organization they belong to (ADR 0065, Orgs 07): rename
// or delete it, read its members, change a role, remove a member or leave, and read the roles
// they may offer. The decisions are the admin service's (`service.ts`), so a change is the same
// change with the same audit entry and event whoever asks; this file only decides **whether
// this caller may ask**. The permission is read from the membership **now** on every call
// (`findUserMembership`), never from the token's claims: a demotion or a removal takes effect
// here at once. An organization that does not exist, is another environment's or is not the
// caller's all answer `organization.not_a_member`.

/** The signed-in user who calls, from the verified access token. */
export interface Caller {
  userId: string
}

type ReadDeps = Pick<Deps, 'organizations' | 'environmentSettings' | 'config' | 'users'>
type WriteDeps = ReadDeps & Pick<Deps, 'ids' | 'clock'>

/**
 * The caller's membership, read now.
 *
 * @throws AuthError `organization.disabled`, and `organization.not_a_member` for an
 *   organization the caller is not in (also one that does not exist).
 */
async function requireHeld(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  caller: Caller,
  organizationId: string
): Promise<UserMembershipRecord> {
  await Organizations.requireEnabled(deps, tenant)
  const held = await deps.organizations.findUserMembership(
    tenant.environmentId,
    organizationId,
    caller.userId
  )
  if (!held) {
    throw new AuthError('organization.not_a_member')
  }
  return held
}

/** Refuse a caller whose role holds none of the permissions. */
function requireAny(held: UserMembershipRecord, permissions: readonly string[]): void {
  if (!permissions.some((permission) => held.permissions.includes(permission))) {
    throw new AuthError('organization.permission_required', { permission: permissions[0] ?? '' })
  }
}

/**
 * Refuse a caller who would act on a member holding permissions the caller lacks.
 *
 * Giving a role is already limited to the caller's own permissions; acting on a member is
 * limited the same way, or a manager with a narrow custom role could demote or remove an
 * administrator. A user not in the organization is left to the store, which says so.
 *
 * @param deps - The organization store.
 * @param tenant - The environment.
 * @param held - The caller's membership.
 * @param organizationId - The organization.
 * @param userId - The member acted on.
 * @throws AuthError `organization.permission_required` naming a permission the caller lacks.
 */
async function requireOutranks(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  held: UserMembershipRecord,
  organizationId: string,
  userId: string
): Promise<void> {
  const target = await deps.organizations.findUserMembership(
    tenant.environmentId,
    organizationId,
    userId
  )
  const missing = target?.permissions.find((permission) => !held.permissions.includes(permission))
  if (missing !== undefined) {
    throw new AuthError('organization.permission_required', { permission: missing })
  }
}

/** The public view of an organization the caller belongs to. */
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
 * Rename the organization, or change its slug, as a member whose role holds
 * `org:sys:organization:manage`.
 *
 * @param deps - The stores, the settings, ids and clock.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @param input - The fields to change.
 * @param actor - The user, for the audit log.
 * @returns The organization with the caller's role, as it is now.
 * @throws AuthError `organization.disabled`, `organization.not_a_member`,
 *   `organization.permission_required`, `organization.slug_taken`.
 */
export async function update(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  caller: Caller,
  organizationId: string,
  input: UpdateOrganizationRequest,
  actor: Actor
): Promise<UserOrganization> {
  const held = await requireHeld(deps, tenant, caller, organizationId)
  requireAny(held, [ORGANIZATION_MANAGE_PERMISSION])
  await Organizations.update(deps, tenant, organizationId, input, actor)
  const now = await deps.organizations.findUserMembership(
    tenant.environmentId,
    organizationId,
    caller.userId
  )
  if (!now) {
    // Removed between the write and this read.
    throw new AuthError('organization.not_a_member')
  }
  return view(now)
}

/**
 * Delete the organization, as a member whose role holds `org:sys:organization:delete`. Its
 * memberships go with it; every member's sessions leave it at their next refresh.
 *
 * @param deps - The stores, the settings, ids and clock.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @param actor - The user, for the audit log.
 * @throws AuthError `organization.disabled`, `organization.not_a_member`,
 *   `organization.permission_required`.
 */
export async function remove(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  caller: Caller,
  organizationId: string,
  actor: Actor
): Promise<void> {
  const held = await requireHeld(deps, tenant, caller, organizationId)
  requireAny(held, [ORGANIZATION_DELETE_PERMISSION])
  await Organizations.remove(deps, tenant, organizationId, actor)
}

/** How a member is named: first and last name as given, or `null`. */
function nameOf(first: string | null, last: string | null): string | null {
  const name = [first, last].filter((part) => part && part.trim() !== '').join(' ')
  return name === '' ? null : name
}

/**
 * List the organization's members, oldest first, with the name and address of each, as a
 * member whose role holds `org:sys:memberships:read` or `:manage`.
 *
 * @param deps - The stores, the settings.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @param page - Which page, and how long.
 * @returns The page.
 * @throws AuthError `organization.disabled`, `organization.not_a_member`,
 *   `organization.permission_required`.
 */
export async function listMembers(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  caller: Caller,
  organizationId: string,
  page: PageCriteria
): Promise<OrganizationMemberList> {
  const held = await requireHeld(deps, tenant, caller, organizationId)
  requireAny(held, [MEMBERSHIPS_READ_PERMISSION, MEMBERSHIPS_MANAGE_PERMISSION])
  const { records, total } = await deps.organizations.listMemberships(
    tenant.environmentId,
    organizationId,
    page
  )
  // One lookup for the whole page, not one per member.
  const found = await deps.users.findByIds(
    tenant.environmentId,
    records.map((record) => record.userId)
  )
  const byId = new Map(found.map((user) => [user.id, user]))
  const data = records.map((record: MembershipRecord): OrganizationMember => {
    const user = byId.get(record.userId)
    return {
      userId: record.userId,
      name: user ? nameOf(user.firstName, user.lastName) : null,
      email: user?.email ?? null,
      role: record.roleKey,
      createdAt: record.createdAt.toISOString(),
    }
  })
  return {
    meta: {
      totalCount: total,
      totalPages: Math.ceil(total / page.size),
      page: page.page,
      perPage: page.size,
    },
    data,
  }
}

/**
 * The roles the caller may give: those whose permissions they hold all of themselves (the
 * rule invitations already follow), as a member whose role holds
 * `org:sys:invitations:manage` or `org:sys:memberships:manage`.
 *
 * @param deps - The stores, the settings.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @returns Their keys and names.
 * @throws AuthError `organization.disabled`, `organization.not_a_member`,
 *   `organization.permission_required`.
 */
export async function assignableRoles(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  caller: Caller,
  organizationId: string
): Promise<AssignableRoleList> {
  const held = await requireHeld(deps, tenant, caller, organizationId)
  requireAny(held, [INVITATIONS_MANAGE_PERMISSION, MEMBERSHIPS_MANAGE_PERMISSION])
  const roles = await deps.organizations.listRoles(tenant.environmentId)
  return {
    data: roles
      .filter((role) =>
        role.permissions.every((permission) => held.permissions.includes(permission))
      )
      .map((role) => ({ key: role.key, name: role.name })),
  }
}

/**
 * Give a member another role, as a member whose role holds `org:sys:memberships:manage`, to a
 * role whose permissions they hold all of themselves (otherwise a manager could make
 * themselves or a friend more than they are).
 *
 * @param deps - The stores, the settings, ids and clock.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @param userId - The member whose role changes.
 * @param input - The key of the new role.
 * @param actor - The user, for the audit log.
 * @returns The member as they are now.
 * @throws AuthError `organization.disabled`, `organization.not_a_member`,
 *   `organization.permission_required`, `organization.role_unknown`,
 *   `organization.role_not_assignable`, `organization.last_manager`.
 * @throws NotFoundError when `userId` is not a member.
 */
export async function changeRole(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  caller: Caller,
  organizationId: string,
  userId: string,
  input: UpdateOrganizationMemberRequest,
  actor: Actor
): Promise<OrganizationMember> {
  const held = await requireHeld(deps, tenant, caller, organizationId)
  requireAny(held, [MEMBERSHIPS_MANAGE_PERMISSION])
  const role = await Organizations.requireRole(deps, tenant, input.role)
  if (!role.permissions.every((permission) => held.permissions.includes(permission))) {
    throw new AuthError('organization.role_not_assignable')
  }
  await requireOutranks(deps, tenant, held, organizationId, userId)
  const changed = await Organizations.changeMemberRole(
    deps,
    tenant,
    organizationId,
    userId,
    input,
    actor
  )
  const user = await deps.users.findById(tenant.environmentId, userId)
  return {
    userId,
    name: user ? nameOf(user.firstName, user.lastName) : null,
    email: user?.email ?? null,
    role: changed.role,
    createdAt: changed.createdAt,
  }
}

/**
 * Remove a member, or leave: a member may always remove **themselves**; removing anyone else
 * needs `org:sys:memberships:manage`. The last member who can manage members cannot go either
 * way (`organization.last_manager`).
 *
 * @param deps - The stores, the settings, ids and clock.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @param userId - The member to remove; the caller's own id leaves.
 * @param actor - The user, for the audit log.
 * @throws AuthError `organization.disabled`, `organization.not_a_member`,
 *   `organization.permission_required`, `organization.last_manager`.
 * @throws NotFoundError when `userId` is not a member.
 */
export async function removeMember(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  caller: Caller,
  organizationId: string,
  userId: string,
  actor: Actor
): Promise<void> {
  const held = await requireHeld(deps, tenant, caller, organizationId)
  if (userId !== caller.userId) {
    requireAny(held, [MEMBERSHIPS_MANAGE_PERMISSION])
    await requireOutranks(deps, tenant, held, organizationId, userId)
  }
  try {
    await Organizations.removeMember(deps, tenant, organizationId, userId, actor)
  } catch (caught) {
    // A caller who holds the permission may be told a user is not a member; one who removes
    // themselves was a member a moment ago.
    if (caught instanceof NotFoundError && userId === caller.userId) {
      throw new AuthError('organization.not_a_member')
    }
    throw caught
  }
}
