import {
  type CreateMySsoConnectionRequest,
  SSO_MANAGE_PERMISSION,
  type SsoConnection,
  type SsoGroupRoles,
  type UpdateSsoConnectionRequest,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, ForbiddenError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as Organizations from '~/modules/organization/service'
import * as SsoConnections from '~/modules/sso-connection/service'

// What a signed-in organization admin does to their own organization's single sign-on (ADR
// 0067). The decisions are the admin service's, so a change is the same change with the same
// audit entry whoever asks; this file only decides **whether this caller may ask, and of which
// connection**. The permission is read from the membership now on every call, never from the
// token. A connection of another organization answers `sso.connection_not_found`, like a
// missing one.

/** The signed-in user who calls. */
export interface Caller {
  userId: string
}

type Base = Pick<Deps, 'organizations' | 'environmentSettings' | 'config' | 'ssoConnections'>
type Full = Parameters<typeof SsoConnections.update>[0]

/**
 * The caller's permissions in the organization, once organizations are on and the caller is a
 * member who holds `org:sys:sso:manage`.
 *
 * @throws AuthError `organization.disabled`, `organization.not_a_member` (also for an
 *   organization that does not exist).
 * @throws ForbiddenError (`auth.forbidden`) for a member without the permission.
 */
async function requireManager(
  deps: Base,
  tenant: Pick<Tenant, 'environmentId'>,
  caller: Caller,
  organizationId: string
): Promise<readonly string[]> {
  await Organizations.requireEnabled(deps, tenant)
  const held = await deps.organizations.findUserMembership(
    tenant.environmentId,
    organizationId,
    caller.userId
  )
  if (!held) {
    throw new AuthError('organization.not_a_member')
  }
  if (!held.permissions.includes(SSO_MANAGE_PERMISSION)) {
    throw new ForbiddenError()
  }
  return held.permissions
}

/** The connection, when it belongs to the organization of the path. */
async function requireOwn(
  deps: Base & Pick<Deps, 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  organizationId: string,
  id: string
): Promise<SsoConnection> {
  const connection = await SsoConnections.get(deps, tenant, id)
  if (connection.organizationId !== organizationId) {
    throw new AuthError('sso.connection_not_found')
  }
  return connection
}

/**
 * Refuse a role the caller does not hold every permission of: otherwise a member with
 * `org:sys:sso:manage` alone could map their own group to `admin` and sign in as one.
 */
async function requireAssignable(
  deps: Pick<Deps, 'organizations' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  permissions: readonly string[],
  role: string
): Promise<void> {
  const found = await Organizations.requireRole(deps, tenant, role)
  if (!found.permissions.every((permission) => permissions.includes(permission))) {
    throw new AuthError('organization.role_not_assignable')
  }
}

/**
 * Whether an update is one of the three that ask less of a sign-in without activating
 * anything: enforcement off, the provider trusted for MFA, a break-glass role named. The route
 * wants a recent authentication for these (the audit entry says `weakened: true` for them).
 *
 * @param current - The connection as it is.
 * @param input - The change asked for.
 * @returns `true` for a weakening.
 */
export function needsStepUp(current: SsoConnection, input: UpdateSsoConnectionRequest): boolean {
  return (
    (input.enforced === false && current.enforced) ||
    (input.trustIdpMfa === true && !current.trustIdpMfa) ||
    (typeof input.breakGlassRole === 'string' && input.breakGlassRole !== current.breakGlassRole)
  )
}

/**
 * The organization's connections.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @returns The connections, without secrets.
 * @throws AuthError `organization.disabled`, `organization.not_a_member`, `sso.disabled`.
 * @throws ForbiddenError without `org:sys:sso:manage`.
 */
export async function list(
  deps: Parameters<typeof SsoConnections.list>[0] & Base,
  tenant: Pick<Tenant, 'environmentId'>,
  caller: Caller,
  organizationId: string
): Promise<SsoConnection[]> {
  await requireManager(deps, tenant, caller, organizationId)
  return SsoConnections.list(deps, tenant, organizationId)
}

/**
 * One connection of the organization.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @param id - The connection.
 * @returns The connection.
 * @throws As {@link list}, and `sso.connection_not_found` (also for another organization's).
 */
export async function get(
  deps: Base & Pick<Deps, 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  caller: Caller,
  organizationId: string,
  id: string
): Promise<SsoConnection> {
  await requireManager(deps, tenant, caller, organizationId)
  return requireOwn(deps, tenant, organizationId, id)
}

/**
 * Create a draft connection for the organization.
 *
 * @param deps - As {@link SsoConnections.create}.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization; the body cannot name another.
 * @param input - The connection.
 * @param actor - The user, for the audit log.
 * @returns The connection.
 * @throws As {@link list}, `organization.role_not_assignable`, and those of the admin create.
 */
export async function create(
  deps: Parameters<typeof SsoConnections.create>[0] & Full & Base,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  caller: Caller,
  organizationId: string,
  input: CreateMySsoConnectionRequest,
  actor: Actor
): Promise<SsoConnection> {
  const permissions = await requireManager(deps, tenant, caller, organizationId)
  await requireAssignable(deps, tenant, permissions, input.defaultRole)
  return SsoConnections.create(deps, tenant, { ...input, organizationId }, actor)
}

/**
 * Change a connection of the organization. `step` runs between the permission check and the
 * change when the change is a weakening, so a stale session learns nothing it should not and
 * changes nothing.
 *
 * @param deps - As {@link SsoConnections.update}.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @param id - The connection.
 * @param input - The fields to change.
 * @param actor - The user, for the audit log.
 * @param step - Throws `auth.step_up_required` when the session is not recent enough.
 * @returns The connection as it is now.
 * @throws As {@link get}, `organization.role_not_assignable`, and those of the admin update.
 */
export async function update(
  deps: Full & Base,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  caller: Caller,
  organizationId: string,
  id: string,
  input: UpdateSsoConnectionRequest,
  actor: Actor,
  step: () => Promise<void>
): Promise<SsoConnection> {
  const permissions = await requireManager(deps, tenant, caller, organizationId)
  const current = await requireOwn(deps, tenant, organizationId, id)
  if (needsStepUp(current, input)) {
    await step()
  }
  for (const role of [input.defaultRole, input.breakGlassRole]) {
    if (typeof role === 'string') {
      await requireAssignable(deps, tenant, permissions, role)
    }
  }
  return SsoConnections.update(deps, tenant, id, input, actor)
}

/**
 * Read a SAML connection's metadata address again.
 *
 * @param deps - As {@link SsoConnections.refreshMetadata}.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @param id - The connection.
 * @param actor - The user, for the audit log.
 * @returns The connection.
 * @throws As {@link get}.
 */
export async function refreshMetadata(
  deps: Full & Base,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  caller: Caller,
  organizationId: string,
  id: string,
  actor: Actor
): Promise<SsoConnection> {
  await requireManager(deps, tenant, caller, organizationId)
  await requireOwn(deps, tenant, organizationId, id)
  return SsoConnections.refreshMetadata(deps, tenant, id, actor)
}

/**
 * Delete a connection nobody has signed in through.
 *
 * @param deps - As {@link SsoConnections.remove}.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @param id - The connection.
 * @param actor - The user, for the audit log.
 * @throws As {@link get}, and `sso.connection_in_use`.
 */
export async function remove(
  deps: Base & Parameters<typeof SsoConnections.remove>[0],
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  caller: Caller,
  organizationId: string,
  id: string,
  actor: Actor
): Promise<void> {
  await requireManager(deps, tenant, caller, organizationId)
  await requireOwn(deps, tenant, organizationId, id)
  await SsoConnections.remove(deps, tenant, id, actor)
}

/**
 * The organization's group to role mapping.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @param id - A connection of the organization.
 * @returns The mapping.
 * @throws As {@link get}.
 */
export async function getGroupRoles(
  deps: Base & Pick<Deps, 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  caller: Caller,
  organizationId: string,
  id: string
): Promise<SsoGroupRoles> {
  await requireManager(deps, tenant, caller, organizationId)
  await requireOwn(deps, tenant, organizationId, id)
  return SsoConnections.getGroupRoles(deps, tenant, id)
}

/**
 * Replace the mapping, to roles the caller holds every permission of.
 *
 * @param deps - As {@link SsoConnections.putGroupRoles}.
 * @param tenant - The environment.
 * @param caller - The signed-in user.
 * @param organizationId - The organization.
 * @param id - A connection of the organization.
 * @param input - The whole new mapping.
 * @param actor - The user, for the audit log.
 * @returns The mapping as saved.
 * @throws As {@link get}, `organization.role_not_assignable`, and those of the admin route.
 */
export async function putGroupRoles(
  deps: Base & Parameters<typeof SsoConnections.putGroupRoles>[0] & Pick<Deps, 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  caller: Caller,
  organizationId: string,
  id: string,
  input: SsoGroupRoles,
  actor: Actor
): Promise<SsoGroupRoles> {
  const permissions = await requireManager(deps, tenant, caller, organizationId)
  await requireOwn(deps, tenant, organizationId, id)
  for (const role of new Set(input.mappings.map((one) => one.role))) {
    await requireAssignable(deps, tenant, permissions, role)
  }
  return SsoConnections.putGroupRoles(deps, tenant, id, input, actor)
}
