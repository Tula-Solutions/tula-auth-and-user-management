import type { Deps } from '~/dependencies'
import * as Organizations from '~/modules/organization/service'
import { roleForGroups } from '~/modules/sso/service'
import type { ScimContext } from './service'

/** The role a provisioned member gets when no group of the directory is mapped to another. */
export const MEMBER_ROLE = 'member'

/** One member's role change a group change implies. */
export interface RoleChange {
  userId: string
  from: string
  to: string
}

/**
 * The role the organization's group mapping gives a user in these groups. This is the SAME
 * function and precedence an SSO sign-in uses (`roleForGroups`, ADR 0067): a second resolver
 * would let a sign-in and the directory disagree about one person.
 *
 * @param deps - The SSO connection store.
 * @param ctx - The environment and the organization.
 * @param names - The directory groups the user is in.
 * @returns The role, or `null` when the organization maps no group (roles are left alone).
 */
export async function resolve(deps: Deps, ctx: ScimContext, names: string[]) {
  return roleForGroups(
    await deps.ssoConnections.listGroupRoles(ctx.tenant.environmentId, ctx.organizationId),
    names,
    MEMBER_ROLE
  )
}

/**
 * Plan the role change of one user, if they are a member whose role differs from the one
 * their groups give.
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param userId - The user.
 * @param names - The directory groups the user will be in.
 * @returns The change, or `null`.
 */
export async function plan(
  deps: Deps,
  ctx: ScimContext,
  userId: string,
  names: string[]
): Promise<RoleChange | null> {
  const to = await resolve(deps, ctx, names)
  const member = await deps.organizations.findMembership(
    ctx.tenant.environmentId,
    ctx.organizationId,
    userId
  )
  return member && to !== null && member.roleKey !== to
    ? { userId, from: member.roleKey, to }
    : null
}

/** Move one member to a role, through the organization service (the last-manager rule holds). */
export function change(deps: Deps, ctx: ScimContext, userId: string, role: string) {
  return Organizations.changeMemberRole(
    deps,
    ctx.tenant,
    ctx.organizationId,
    userId,
    { role },
    ctx.actor
  )
}

/**
 * Give a member the role their current groups imply (after a user is let back in).
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param userId - The user.
 * @throws AuthError `organization.last_manager` when it would demote the last manager.
 */
export async function sync(deps: Deps, ctx: ScimContext, userId: string) {
  const names = await deps.scim.groupNamesOfUser(
    ctx.tenant.environmentId,
    ctx.organizationId,
    userId
  )
  const planned = await plan(deps, ctx, userId, names)
  if (planned) {
    await change(deps, ctx, userId, planned.to)
  }
}
