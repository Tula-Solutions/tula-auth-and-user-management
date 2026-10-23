import {
  type AddOrganizationMemberRequest,
  BUILT_IN_ROLES,
  type CreateOrganizationRequest,
  ORGANIZATION_FIELDS,
  type Organization,
  type OrganizationField,
  type OrganizationList,
  type OrganizationMembership,
  type OrganizationMembershipList,
  type UpdateOrganizationMemberRequest,
  type UpdateOrganizationRequest,
  type UserMembershipList,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, ConflictError, NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as Audit from '~/modules/audit/service'
import * as Settings from '~/modules/settings/service'
import type {
  MembershipRecord,
  OrganizationRecord,
  OrganizationRoleRecord,
  PageCriteria,
} from '~/ports/organization-store'

/** What the service reads and writes: the stores and the settings, ids and clock. */
type ReadDeps = Pick<Deps, 'organizations' | 'environmentSettings' | 'config'>
type WriteDeps = ReadDeps & Pick<Deps, 'ids' | 'clock'>

/** The public view of a stored organization. */
function view(record: OrganizationRecord): Organization {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

/** The public view of a stored membership. */
function membershipView(record: MembershipRecord): OrganizationMembership {
  return {
    id: record.id,
    organizationId: record.organizationId,
    userId: record.userId,
    role: record.roleKey,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

/** The paging details of a list. */
function meta(total: number, { page, size }: PageCriteria) {
  return { totalCount: total, totalPages: Math.ceil(total / size), page, perPage: size }
}

/**
 * Refuse every organization route while the environment has organizations switched off.
 *
 * Read through the settings (cached per instance, ADR 0018) before anything is read or
 * written, so a disabled environment answers the same thing for an id that exists and one that
 * does not: the answer says nothing about what is stored.
 *
 * @param deps - The settings store and config.
 * @param tenant - The environment.
 * @throws AuthError `organization.disabled` when `organizations.enabled` is off.
 */
export async function requireEnabled(
  deps: Pick<Deps, 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<void> {
  const { organizations } = await Settings.current(deps, tenant)
  if (!organizations.enabled) {
    throw new AuthError('organization.disabled')
  }
}

/** The stored organization, or the 404 every route answers for one that is not this environment's. */
async function requireOrganization(
  deps: Pick<Deps, 'organizations'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<OrganizationRecord> {
  const record = await deps.organizations.find(tenant.environmentId, id)
  if (!record) {
    throw new NotFoundError()
  }
  return record
}

/**
 * Store the built-in roles of an environment that does not have them yet.
 *
 * An environment created after migration 0036 has no role rows until something needs one
 * (ADR 0065, "Built-in roles"): the built-in roles are the contract's {@link BUILT_IN_ROLES}.
 * Idempotent, and safe from several instances at once.
 *
 * @param deps - The organization store, ids and clock.
 * @param tenant - The environment.
 */
export async function ensureBuiltInRoles(
  deps: Pick<Deps, 'organizations' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>
): Promise<void> {
  const now = deps.clock.now()
  await deps.organizations.ensureBuiltInRoles(
    BUILT_IN_ROLES.map((role) => ({
      id: deps.ids.next(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      key: role.key,
      name: role.name,
      permissions: [...role.permissions],
      builtIn: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }))
  )
}

/**
 * The role with this key, creating the environment's built-in roles first if it has none yet.
 *
 * A missing `admin` or `member` is created by {@link ensureBuiltInRoles} and read again. Any
 * other key that is missing is an unknown role.
 */
export async function requireRole(
  deps: Pick<Deps, 'organizations' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  key: string
): Promise<OrganizationRoleRecord> {
  const found = await deps.organizations.findRole(tenant.environmentId, key)
  if (found) {
    return found
  }
  if (BUILT_IN_ROLES.some((role) => role.key === key)) {
    await ensureBuiltInRoles(deps, tenant)
    const created = await deps.organizations.findRole(tenant.environmentId, key)
    if (created) {
      return created
    }
  }
  throw new AuthError('organization.role_unknown', { role: key })
}

/**
 * List the environment's organizations, newest first.
 *
 * @param deps - The organization store and the settings.
 * @param tenant - The environment.
 * @param page - Which page, and how long.
 * @returns The page and its paging details.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 */
export async function list(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  page: PageCriteria
): Promise<OrganizationList> {
  await requireEnabled(deps, tenant)
  const { records, total } = await deps.organizations.list(tenant.environmentId, page)
  return { meta: meta(total, page), data: records.map(view) }
}

/**
 * Read one organization.
 *
 * @param deps - The organization store and the settings.
 * @param tenant - The environment.
 * @param id - The organization.
 * @returns The organization.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the environment has no organization with that id.
 */
export async function get(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<Organization> {
  await requireEnabled(deps, tenant)
  return view(await requireOrganization(deps, tenant, id))
}

/**
 * Create an organization from the admin API. It has no member until one is added, and no
 * creator (`createdBy` is `null`): the per-user cap on created organizations counts users'
 * own.
 *
 * @param deps - The organization store, the settings, ids and clock.
 * @param tenant - The environment to create it in.
 * @param input - Name and slug.
 * @param actor - Who creates it, for the audit log.
 * @returns The organization.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws AuthError `organization.slug_taken` when the environment has that slug already.
 */
export async function create(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: CreateOrganizationRequest,
  actor: Actor
): Promise<Organization> {
  await requireEnabled(deps, tenant)
  const id = deps.ids.next()
  const activity = Audit.entry(deps, tenant, {
    type: 'organization.created',
    actor,
    target: { type: 'organization', id },
  })
  const record = await deps.organizations.insert(
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      name: input.name,
      slug: input.slug,
      createdBy: null,
      createdAt: activity.occurredAt,
      updatedAt: activity.occurredAt,
    },
    activity
  )
  if (!record) {
    throw new AuthError('organization.slug_taken')
  }
  return view(record)
}

/**
 * Rename an organization or change its slug. A request that changes nothing writes nothing.
 * The audit entry names the fields that changed and never their values.
 *
 * @param deps - The organization store, the settings, ids and clock.
 * @param tenant - The environment.
 * @param id - The organization.
 * @param input - The fields to change.
 * @param actor - Who changes it, for the audit log.
 * @returns The organization as it is now.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the environment has no organization with that id.
 * @throws AuthError `organization.slug_taken` when the new slug belongs to another organization.
 */
export async function update(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  input: UpdateOrganizationRequest,
  actor: Actor
): Promise<Organization> {
  await requireEnabled(deps, tenant)
  const current = await requireOrganization(deps, tenant, id)
  const changes = {
    ...(input.name !== undefined && input.name !== current.name && { name: input.name }),
    ...(input.slug !== undefined && input.slug !== current.slug && { slug: input.slug }),
  }
  const changed: OrganizationField[] = ORGANIZATION_FIELDS.filter(
    (field) => changes[field] !== undefined
  )
  if (changed.length === 0) {
    return view(current)
  }
  const result = await deps.organizations.update(
    tenant.environmentId,
    id,
    changes,
    deps.clock.now(),
    Audit.entry(deps, tenant, {
      type: 'organization.updated',
      actor,
      target: { type: 'organization', id },
      data: { changed },
    })
  )
  switch (result.outcome) {
    case 'updated':
      return view(result.record)
    case 'slug_taken':
      throw new AuthError('organization.slug_taken')
    case 'not_found':
      // Deleted between the read and the write.
      throw new NotFoundError()
  }
}

/**
 * Delete an organization. Its memberships go with it: the
 * users keep their accounts, and their sessions leave the organization at the next refresh.
 *
 * @param deps - The organization store, the settings, ids and clock.
 * @param tenant - The environment.
 * @param id - The organization.
 * @param actor - Who deletes it, for the audit log.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the environment has no organization with that id.
 */
export async function remove(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  actor: Actor
): Promise<void> {
  await requireEnabled(deps, tenant)
  await requireOrganization(deps, tenant, id)
  // How many memberships go with it, as read just before: the event says it for a receiver
  // that mirrors them, since no `organization_membership.removed` follows.
  const members = await deps.organizations.listMemberships(tenant.environmentId, id, {
    page: 1,
    size: 1,
  })
  const deleted = await deps.organizations.delete(
    tenant.environmentId,
    id,
    Audit.entry(deps, tenant, {
      type: 'organization.deleted',
      actor,
      target: { type: 'organization', id },
      data: { memberships: members.total },
    })
  )
  if (!deleted) {
    // Deleted between the read and the write.
    throw new NotFoundError()
  }
}

/**
 * List an organization's members, oldest first.
 *
 * @param deps - The organization store and the settings.
 * @param tenant - The environment.
 * @param id - The organization.
 * @param page - Which page, and how long.
 * @returns The page and its paging details.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the environment has no organization with that id.
 */
export async function listMembers(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string,
  page: PageCriteria
): Promise<OrganizationMembershipList> {
  await requireEnabled(deps, tenant)
  await requireOrganization(deps, tenant, id)
  const { records, total } = await deps.organizations.listMemberships(
    tenant.environmentId,
    id,
    page
  )
  return { meta: meta(total, page), data: records.map(membershipView) }
}

/**
 * Add an existing user to an organization with a role.
 *
 * @param deps - The organization store, users, the settings, ids and clock.
 * @param tenant - The environment.
 * @param id - The organization.
 * @param input - The user and the key of the role.
 * @param actor - Who adds the member, for the audit log.
 * @returns The membership.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the organization, or the user, is not this environment's.
 * @throws AuthError `organization.role_unknown` when no role has that key.
 * @throws AuthError `organization.member_exists` when the user is a member already.
 */
export async function addMember(
  deps: WriteDeps & Pick<Deps, 'users'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  input: AddOrganizationMemberRequest,
  actor: Actor
): Promise<OrganizationMembership> {
  await requireEnabled(deps, tenant)
  await requireOrganization(deps, tenant, id)
  if (!(await deps.users.findById(tenant.environmentId, input.userId))) {
    throw new NotFoundError()
  }
  const role = await requireRole(deps, tenant, input.role)
  const membershipId = deps.ids.next()
  const activity = Audit.entry(deps, tenant, {
    type: 'organization_membership.added',
    actor,
    target: { type: 'organization_membership', id: membershipId },
    data: { organizationId: id, userId: input.userId, role: role.key },
  })
  const result = await deps.organizations.addMembership(
    {
      id: membershipId,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId: id,
      userId: input.userId,
      roleId: role.id,
      roleKey: role.key,
      createdAt: activity.occurredAt,
      updatedAt: activity.occurredAt,
    },
    activity
  )
  switch (result.outcome) {
    case 'added':
      return membershipView(result.record)
    case 'duplicate':
      throw new AuthError('organization.member_exists')
    case 'gone':
      // The organization, the user or the role was deleted between the reads and the write.
      throw new NotFoundError()
  }
}

/**
 * Give a member another role. The member's sessions carry the new role from their next
 * refresh, within the access-token lifetime (ADR 0065). A request for the role they hold
 * writes nothing.
 *
 * @param deps - The organization store, the settings, ids and clock.
 * @param tenant - The environment.
 * @param id - The organization.
 * @param userId - The member.
 * @param input - The key of the new role.
 * @param actor - Who changes it, for the audit log.
 * @returns The membership as it is now.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the organization is not this environment's or the user is not a member.
 * @throws AuthError `organization.role_unknown` when no role has that key.
 * @throws AuthError `organization.last_manager` when the member is the last to hold
 *   `org:sys:memberships:manage` and the new role does not.
 * @throws ConflictError when the membership changed between the read and the write.
 */
export async function changeMemberRole(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  userId: string,
  input: UpdateOrganizationMemberRequest,
  actor: Actor
): Promise<OrganizationMembership> {
  await requireEnabled(deps, tenant)
  await requireOrganization(deps, tenant, id)
  const current = await deps.organizations.findMembership(tenant.environmentId, id, userId)
  if (!current) {
    throw new NotFoundError()
  }
  const role = await requireRole(deps, tenant, input.role)
  if (role.id === current.roleId) {
    return membershipView(current)
  }
  const result = await deps.organizations.changeRole(
    tenant.environmentId,
    id,
    userId,
    current.roleId,
    role,
    deps.clock.now(),
    Audit.entry(deps, tenant, {
      type: 'organization_membership.role_changed',
      actor,
      target: { type: 'organization_membership', id: current.id },
      data: { organizationId: id, userId, role: role.key, previousRole: current.roleKey },
    })
  )
  switch (result.outcome) {
    case 'done':
      return membershipView(result.record)
    case 'last_manager':
      throw new AuthError('organization.last_manager')
    case 'conflict':
      throw new ConflictError({
        message: 'The membership changed since it was read. Read it again and retry.',
      })
    case 'not_found':
      throw new NotFoundError()
  }
}

/**
 * Remove a member from an organization. The user keeps their account; their sessions leave
 * the organization at the next refresh (ADR 0065).
 *
 * @param deps - The organization store, the settings, ids and clock.
 * @param tenant - The environment.
 * @param id - The organization.
 * @param userId - The member.
 * @param actor - Who removes them, for the audit log.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the organization is not this environment's or the user is not a member.
 * @throws AuthError `organization.last_manager` when the member is the last to hold
 *   `org:sys:memberships:manage`.
 * @throws ConflictError when the membership changed between the read and the write.
 */
export async function removeMember(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  userId: string,
  actor: Actor
): Promise<void> {
  await requireEnabled(deps, tenant)
  await requireOrganization(deps, tenant, id)
  const current = await deps.organizations.findMembership(tenant.environmentId, id, userId)
  if (!current) {
    throw new NotFoundError()
  }
  const result = await deps.organizations.removeMembership(
    tenant.environmentId,
    id,
    userId,
    current.roleId,
    Audit.entry(deps, tenant, {
      type: 'organization_membership.removed',
      actor,
      target: { type: 'organization_membership', id: current.id },
      data: { organizationId: id, userId, role: current.roleKey },
    })
  )
  switch (result.outcome) {
    case 'done':
      return
    case 'last_manager':
      throw new AuthError('organization.last_manager')
    case 'conflict':
      throw new ConflictError({
        message: 'The membership changed since it was read. Read it again and retry.',
      })
    case 'not_found':
      throw new NotFoundError()
  }
}

/**
 * List the organizations a user belongs to, the one they joined first at the top, for the
 * administrator reading the user's page.
 *
 * @param deps - The organization store, users and the settings.
 * @param tenant - The environment.
 * @param userId - The user.
 * @param page - Which page, and how long.
 * @returns The page: each organization's id, name and slug, the user's role key and when they
 *   joined. Permissions are not listed: they are read through the role.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the environment has no user with that id.
 */
export async function listForUser(
  deps: ReadDeps & Pick<Deps, 'users'>,
  tenant: Pick<Tenant, 'environmentId'>,
  userId: string,
  page: PageCriteria
): Promise<UserMembershipList> {
  await requireEnabled(deps, tenant)
  if (!(await deps.users.findById(tenant.environmentId, userId))) {
    throw new NotFoundError()
  }
  const { records, total } = await deps.organizations.listUserMemberships(
    tenant.environmentId,
    userId,
    page
  )
  return {
    meta: meta(total, page),
    data: records.map(({ organization, membership }) => ({
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: membership.roleKey,
      joinedAt: membership.createdAt.toISOString(),
    })),
  }
}
