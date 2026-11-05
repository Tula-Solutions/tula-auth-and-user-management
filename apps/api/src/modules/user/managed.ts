import type { Deps } from '~/dependencies'
import { AuthError } from '~/exceptions'
import type { UserRecord } from '~/ports/user-repository'

/**
 * Refuse a client-side change of address or password for an account an identity provider
 * manages (ADR 0067, DECISIONS 11).
 *
 * The lock holds only while the manager is live: a deleted connection (hard-deleted, which
 * also clears the mark) or a directory with no unrevoked SCIM token no longer manages anyone.
 * Administrators' routes never call this.
 *
 * @param deps - SSO connections and SCIM store.
 * @param environmentId - The environment of the user.
 * @param user - The signed-in user.
 * @throws AuthError `user.managed` (403) when an active connection or directory manages them.
 */
export async function requireNotManaged(
  deps: Pick<Deps, 'ssoConnections' | 'scim'>,
  environmentId: string,
  user: Pick<UserRecord, 'managedByConnectionId' | 'managedByDirectoryId'>
): Promise<void> {
  if (await isManaged(deps, environmentId, user)) {
    throw new AuthError('user.managed')
  }
}

/**
 * Whether an active connection or directory manages the user (see {@link requireNotManaged}).
 *
 * @param deps - SSO connections and SCIM store.
 * @param environmentId - The environment of the user.
 * @param user - The user.
 * @returns True while the manager is live.
 */
export async function isManaged(
  deps: Pick<Deps, 'ssoConnections' | 'scim'>,
  environmentId: string,
  user: Pick<UserRecord, 'managedByConnectionId' | 'managedByDirectoryId'>
): Promise<boolean> {
  if (
    user.managedByConnectionId &&
    (await deps.ssoConnections.find(environmentId, user.managedByConnectionId))
  ) {
    return true
  }
  if (user.managedByDirectoryId) {
    const tokens = await deps.scim.listTokens(environmentId, user.managedByDirectoryId)
    return tokens.some((token) => token.revokedAt === null)
  }
  return false
}
