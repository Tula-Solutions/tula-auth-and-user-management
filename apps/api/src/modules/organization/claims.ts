import {
  MAX_ORGANIZATION_CLAIMS_BYTES,
  MAX_ORGANIZATION_PERMISSIONS_CLAIM,
  ORGANIZATION_ID_CLAIM,
  ORGANIZATION_PERMISSIONS_CLAIM,
  ORGANIZATION_ROLE_CLAIM,
  type OrganizationClaims,
  organizationClaimsBytes,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import * as logger from '~/lib/logger'
import * as Settings from '~/modules/settings/service'
import type { UserMembershipRecord } from '~/ports/organization-store'
import type { SessionRecord } from '~/ports/session-store'

/** What building a session's organization claims reads. */
type ClaimDeps = Pick<Deps, 'organizations' | 'environmentSettings' | 'config'>

/**
 * The organization claims of a session as they are now, or `undefined` for none: the one
 * place a membership becomes the `org_id`, `org_role` and `org_perms` of a token (ADR 0065,
 * "Token claims").
 *
 * **Re-reads the membership every time and trusts nothing stored on the session beyond the
 * organization's id**: the user must still be a member of it, and the permissions are those of
 * the role they hold now. So a removal or a demotion is in the next token this builds (a
 * refresh, or a `stateful` session's next request), and no revocation of the session is
 * needed. A session with no active organization reads nothing at all.
 *
 * Fails closed: there are **no claims**, never a partial or a cut list, when organizations
 * are switched off, the user is not a member (any more), or the three claims would be over
 * {@link MAX_ORGANIZATION_CLAIMS_BYTES} (or hold more than
 * {@link MAX_ORGANIZATION_PERMISSIONS_CLAIM} permissions), which a role the contract and the
 * database bound cannot be. An application reads a missing claim as "no permission".
 *
 * @param deps - Organization store, settings and config.
 * @param scope - The environment (a session of another is never read).
 * @param session - The session, for its user and its active organization.
 * @returns The three claims, or `undefined`.
 */
export async function claimsOf(
  deps: ClaimDeps,
  scope: Pick<Tenant, 'environmentId'>,
  session: Pick<SessionRecord, 'userId' | 'activeOrganizationId'>
): Promise<OrganizationClaims | undefined> {
  const { activeOrganizationId } = session
  if (activeOrganizationId === null) {
    return undefined
  }
  const { organizations } = await Settings.current(deps, scope)
  if (!organizations.enabled) {
    return undefined
  }
  const held = await deps.organizations.findUserMembership(
    scope.environmentId,
    activeOrganizationId,
    session.userId
  )
  return held ? fromMembership(scope, held) : undefined
}

/**
 * The claims of a membership that has just been read, under the same rules as
 * {@link claimsOf}. For a caller that holds the membership already (switching organization
 * reads it to check it) and must not read it a second time.
 *
 * @param scope - The environment, for the log line.
 * @param held - The user's membership with its role's permissions.
 * @returns The three claims, or `undefined` when they would not fit.
 */
export function fromMembership(
  scope: Pick<Tenant, 'environmentId'>,
  held: UserMembershipRecord
): OrganizationClaims | undefined {
  const claims: OrganizationClaims = {
    orgId: held.organization.id,
    orgRole: held.membership.roleKey,
    orgPermissions: held.permissions,
  }
  if (
    claims.orgPermissions.length > MAX_ORGANIZATION_PERMISSIONS_CLAIM ||
    organizationClaimsBytes(claims) > MAX_ORGANIZATION_CLAIMS_BYTES
  ) {
    // Ids and a count, never a role's contents.
    logger.error('organization claims over their cap; the token carries none', {
      environmentId: scope.environmentId,
      organizationId: claims.orgId,
      permissions: claims.orgPermissions.length,
    })
    return undefined
  }
  return claims
}

/**
 * The claims as they are written into a token.
 *
 * @param claims - The organization claims.
 * @returns The three top-level claims, under their reserved names.
 */
export function asTokenClaims(claims: OrganizationClaims) {
  return {
    [ORGANIZATION_ID_CLAIM]: claims.orgId,
    [ORGANIZATION_ROLE_CLAIM]: claims.orgRole,
    [ORGANIZATION_PERMISSIONS_CLAIM]: [...claims.orgPermissions],
  }
}
