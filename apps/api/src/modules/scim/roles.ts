import type { Deps } from '~/dependencies'
import * as Organizations from '~/modules/organization/service'
import { roleForGroups } from '~/modules/sso/service'
import { invalidValue } from './errors'
import type { ScimContext } from './service'

/** The role of a provisioned member when the organization has no SSO connection at all. */
export const MEMBER_ROLE = 'member'

/**
 * The role a provisioned member gets in no mapped group: the default role of the organization's
 * connection, the same one an SSO sign-in gives (DECISIONS 10), so a user's role never flips
 * between a directory push and a sign-in. The active connection; else the latest one that
 * passed a test; else `member`.
 *
 * @param deps - The SSO connection store.
 * @param ctx - The environment and the organization.
 * @returns The role key.
 */
export async function defaultRole(deps: Pick<Deps, 'ssoConnections'>, ctx: ScimContext) {
  const all = await deps.ssoConnections.list(ctx.tenant.environmentId, ctx.organizationId)
  const newest = (rows: typeof all) =>
    rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
  const chosen =
    newest(all.filter((one) => one.status === 'active')) ??
    newest(all.filter((one) => one.testedFingerprint !== null))
  return chosen?.defaultRole ?? MEMBER_ROLE
}

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
    await defaultRole(deps, ctx)
  )
}

/**
 * Refuse a privileged role to a token a setup link minted.
 *
 * The portal lock (ADR 0067) holds where a role is applied, not only where a mapping is saved:
 * a setup-link token must not turn an operator's privileged mapping or default role into a role.
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and whether the token came from a setup link.
 * @param role - The role about to be applied.
 * @throws ScimError `invalidValue` when the token is a setup link's and the role is privileged.
 */
export async function assertAppliable(deps: Deps, ctx: ScimContext, role: string) {
  if (ctx.viaSetupLink && (await Organizations.isPrivilegedRole(deps, ctx.tenant, role))) {
    throw invalidValue(
      'This token cannot apply a privileged role. Use a token an administrator created.'
    )
  }
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
  if (to !== null) {
    await assertAppliable(deps, ctx, to)
  }
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
