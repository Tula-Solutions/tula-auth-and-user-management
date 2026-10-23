import {
  type CreateOrganizationRoleRequest,
  isBuiltInRoleKey,
  MAX_CUSTOM_ROLES,
  normalizePermissions,
  ORGANIZATION_ROLE_FIELDS,
  type OrganizationRole,
  type OrganizationRoleField,
  type OrganizationRoleList,
  organizationRoleWeakenings,
  type UpdateOrganizationRoleRequest,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, NotFoundError, ServiceException } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import type { OrganizationRoleRecord, RoleChanges } from '~/ports/organization-store'

/** What the service reads: the role store, the settings, ids and clock. */
type ReadDeps = Pick<Deps, 'organizations' | 'environmentSettings' | 'config' | 'ids' | 'clock'>

/** The public view of a stored role. Permissions are always the sorted set. */
function view(record: OrganizationRoleRecord): OrganizationRole {
  return {
    id: record.id,
    key: record.key,
    name: record.name,
    permissions: normalizePermissions(record.permissions),
    builtIn: record.builtIn,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

/**
 * The stored role with this key, the built-in ones created first if the environment has none
 * yet, or the 404 every route answers for a key that is not this environment's.
 */
async function requireRole(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  key: string
): Promise<OrganizationRoleRecord> {
  let record = await deps.organizations.findRole(tenant.environmentId, key)
  if (!record && isBuiltInRoleKey(key)) {
    await Organizations.ensureBuiltInRoles(deps, tenant)
    record = await deps.organizations.findRole(tenant.environmentId, key)
  }
  if (!record) {
    throw new NotFoundError()
  }
  return record
}

/** The 412 for a role that is no longer at the version the caller read. */
function stale(version: number): ServiceException {
  return new ServiceException('precondition.failed', { params: { version } })
}

/**
 * List the environment's roles: the two built-in ones first, then the custom ones by key.
 *
 * @param deps - The role store, the settings, ids and clock.
 * @param tenant - The environment.
 * @returns The roles.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 */
export async function list(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>
): Promise<OrganizationRoleList> {
  await Organizations.requireEnabled(deps, tenant)
  let roles = await deps.organizations.listRoles(tenant.environmentId)
  if (roles.filter((role) => role.builtIn).length < 2) {
    // An environment created since migration 0036 has no role rows until something needs one.
    await Organizations.ensureBuiltInRoles(deps, tenant)
    roles = await deps.organizations.listRoles(tenant.environmentId)
  }
  return { data: roles.map(view) }
}

/**
 * Read one role by its key.
 *
 * @param deps - The role store, the settings, ids and clock.
 * @param tenant - The environment.
 * @param key - The role's key.
 * @returns The role.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the environment has no role with that key.
 */
export async function get(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  key: string
): Promise<OrganizationRole> {
  await Organizations.requireEnabled(deps, tenant)
  return view(await requireRole(deps, tenant, key))
}

/**
 * Define a custom role.
 *
 * The count against `MAX_CUSTOM_ROLES` and the insert are made while holding the environment's
 * lock for roles, so definitions that arrive together cannot each see room for one more. The
 * key of a built-in role is taken whether or not the environment has that row yet. The role
 * is not a weakening: no member holds it until somebody gives it to one.
 *
 * @param deps - The role store, the settings, the environment's lock, ids and clock.
 * @param tenant - The environment.
 * @param input - Key, name and permissions (already checked against the grammar).
 * @param actor - Who defines it, for the audit log.
 * @returns The role, at version 1.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws AuthError `organization.role_exists` when the key is taken, by a custom role or a
 *   built-in one.
 * @throws AuthError `organization.role_limit` when the environment has `MAX_CUSTOM_ROLES`
 *   custom roles (`params.max`).
 * @throws ServiceUnavailableError when the environment's lock could not be had in time.
 */
export async function create(
  deps: ReadDeps & Pick<Deps, 'environmentLock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: CreateOrganizationRoleRequest,
  actor: Actor
): Promise<OrganizationRole> {
  await Organizations.requireEnabled(deps, tenant)
  if (isBuiltInRoleKey(input.key)) {
    throw new AuthError('organization.role_exists')
  }
  return deps.environmentLock.runExclusive(tenant.environmentId, 'organization_roles', async () => {
    const existing = await deps.organizations.listRoles(tenant.environmentId)
    if (existing.some((role) => role.key === input.key)) {
      throw new AuthError('organization.role_exists')
    }
    if (existing.filter((role) => !role.builtIn).length >= MAX_CUSTOM_ROLES) {
      throw new AuthError('organization.role_limit', { max: MAX_CUSTOM_ROLES })
    }
    const permissions = normalizePermissions(input.permissions)
    const id = deps.ids.next()
    const activity = Audit.entry(deps, tenant, {
      type: 'organization_role.created',
      actor,
      target: { type: 'organization_role', id },
      data: { role: input.key, permissions: permissions.length },
    })
    const record = await deps.organizations.insertRole(
      {
        id,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        key: input.key,
        name: input.name,
        permissions,
        builtIn: false,
        version: 1,
        createdAt: activity.occurredAt,
        updatedAt: activity.occurredAt,
      },
      activity
    )
    if (!record) {
      throw new AuthError('organization.role_exists')
    }
    return view(record)
  })
}

/**
 * Rename a custom role or replace its permissions, over the version the caller read.
 *
 * Members who hold the role carry the new permissions from their next refresh (ADR 0065): the
 * permissions are read from the role at that moment and never copied into a membership. The
 * audit entry names the fields that changed and a count, never the permissions, and says
 * `weakened` when the role gained a permission (`organizationRoleWeakenings`). A request that
 * changes nothing writes nothing and keeps the version.
 *
 * @param deps - The role store, the settings, ids and clock.
 * @param tenant - The environment.
 * @param key - The role's key.
 * @param expectedVersion - The version the caller read, from `If-Match`.
 * @param input - The fields to change.
 * @param actor - Who changes it, for the audit log.
 * @returns The role as it is now.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the environment has no role with that key.
 * @throws AuthError `organization.role_built_in` for `admin` and `member`.
 * @throws ServiceException `precondition.failed` (412) when the role is no longer at
 *   `expectedVersion` (`params.version` is the current one).
 * @throws AuthError `organization.last_manager` when the change takes
 *   `org:sys:memberships:manage` from the role and an organization would be left with no
 *   member who holds it.
 */
export async function update(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  key: string,
  expectedVersion: number,
  input: UpdateOrganizationRoleRequest,
  actor: Actor
): Promise<OrganizationRole> {
  await Organizations.requireEnabled(deps, tenant)
  const current = await requireRole(deps, tenant, key)
  if (current.builtIn) {
    throw new AuthError('organization.role_built_in')
  }
  if (current.version !== expectedVersion) {
    throw stale(current.version)
  }
  const before = normalizePermissions(current.permissions)
  const changes: RoleChanges = {}
  if (input.name !== undefined && input.name !== current.name) {
    changes.name = input.name
  }
  const after = input.permissions === undefined ? before : normalizePermissions(input.permissions)
  if (after.join('\n') !== before.join('\n')) {
    changes.permissions = after
  }
  const changed: OrganizationRoleField[] = ORGANIZATION_ROLE_FIELDS.filter(
    (field) => changes[field] !== undefined
  )
  if (changed.length === 0) {
    return view(current)
  }
  const weakened = organizationRoleWeakenings(before, after).length > 0
  const result = await deps.organizations.updateRole(
    tenant.environmentId,
    current.id,
    expectedVersion,
    changes,
    deps.clock.now(),
    Audit.entry(deps, tenant, {
      type: 'organization_role.updated',
      actor,
      target: { type: 'organization_role', id: current.id },
      data: {
        role: current.key,
        changed,
        permissions: after.length,
        ...(weakened && { weakened: true as const }),
      },
    })
  )
  switch (result.outcome) {
    case 'updated':
      return view(result.record)
    case 'stale':
      throw stale(result.version)
    case 'built_in':
      throw new AuthError('organization.role_built_in')
    case 'last_manager':
      throw new AuthError('organization.last_manager')
    case 'not_found':
      // Deleted between the read and the write.
      throw new NotFoundError()
  }
}

/**
 * Delete a custom role that no member holds.
 *
 * @param deps - The role store, the settings, ids and clock.
 * @param tenant - The environment.
 * @param key - The role's key.
 * @param expectedVersion - The version the caller read, from `If-Match`, or `null` when the
 *   request named none (the role is then deleted whatever its version).
 * @param actor - Who deletes it, for the audit log.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the environment has no role with that key.
 * @throws AuthError `organization.role_built_in` for `admin` and `member`.
 * @throws ServiceException `precondition.failed` (412) when the role is no longer at
 *   `expectedVersion`.
 * @throws AuthError `organization.role_in_use` when a member holds the role, in any
 *   organization of the environment.
 */
export async function remove(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  key: string,
  expectedVersion: number | null,
  actor: Actor
): Promise<void> {
  await Organizations.requireEnabled(deps, tenant)
  const current = await requireRole(deps, tenant, key)
  if (current.builtIn) {
    throw new AuthError('organization.role_built_in')
  }
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw stale(current.version)
  }
  const result = await deps.organizations.deleteRole(
    tenant.environmentId,
    current.id,
    expectedVersion,
    Audit.entry(deps, tenant, {
      type: 'organization_role.deleted',
      actor,
      target: { type: 'organization_role', id: current.id },
      data: { role: current.key },
    })
  )
  switch (result.outcome) {
    case 'deleted':
      return
    case 'in_use':
      throw new AuthError('organization.role_in_use')
    case 'stale':
      throw stale(result.version)
    case 'built_in':
      throw new AuthError('organization.role_built_in')
    case 'not_found':
      // Deleted between the read and the write.
      throw new NotFoundError()
  }
}
