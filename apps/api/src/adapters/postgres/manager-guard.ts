import { MEMBERSHIPS_MANAGE_PERMISSION } from '@tula-tech/contract'
import {
  organizationMemberships,
  organizationRoles,
  organizations,
  type Transaction,
  users,
} from '@tula-tech/db'
import { and, arrayContains, asc, eq, inArray, notInArray, type SQL } from 'drizzle-orm'

/**
 * Lock the rows a deletion of these users must hold: the users' own, then the organizations
 * they belong to, each in id order.
 *
 * The users come first, as creating an organization takes them: no membership can be added to
 * a user being deleted from here on (the insert waits for this lock, then finds the user gone),
 * so a join cannot land after the check. The organizations are locked `FOR NO KEY UPDATE` and
 * not `FOR UPDATE`: that conflicts with the `FOR UPDATE` a removal, a demotion and a role
 * update take, which is all the exclusion needed, but not with the `KEY SHARE` a membership
 * insert holds on the organization's row, so a deletion never waits for an insert that waits
 * for the user lock. Every organization the users belong to is locked, not only those they
 * manage: a member can be promoted between a read and the lock.
 */
async function lockRows(tx: Transaction, environmentId: string, userIds: string[]): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.environmentId, environmentId), inArray(users.id, userIds)))
    .orderBy(asc(users.id))
    .for('update')
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.environmentId, environmentId),
        inArray(
          organizations.id,
          tx
            .select({ id: organizationMemberships.organizationId })
            .from(organizationMemberships)
            .where(
              and(
                eq(organizationMemberships.environmentId, environmentId),
                inArray(organizationMemberships.userId, userIds)
              )
            )
        )
      )
    )
    .orderBy(asc(organizations.id))
    .for('no key update')
}

/**
 * Find the users whom deleting would leave some organization without a member who holds
 * `org:sys:memberships:manage` (ADR 0065, TULA-124), after taking the locks that make the
 * answer hold until the transaction ends.
 *
 * The order is the one a custom role's update takes several organizations in, and the one a
 * removal or a demotion takes its organization in, so a deletion and a demotion of the other
 * manager take turns and two writers cannot wait for each other. The check reads after the
 * locks are held (each statement of a read-committed transaction sees what committed before
 * it).
 *
 * A user is blocked when they hold the permission in an organization where nobody outside
 * `userIds` does. For a set that is conservative: two managers deleted together are both
 * blocked.
 *
 * @param tx - The tenant transaction the deletion runs in.
 * @param environmentId - The users' environment.
 * @param userIds - The users about to be deleted.
 * @param lock - Take the locks (a deletion does). Left off, the answer is only read, which a
 *   caller may use to refuse early and never to decide.
 * @returns For each blocked user, the ids of the organizations they block, ascending.
 */
export async function findBlocked(
  tx: Transaction,
  environmentId: string,
  userIds: readonly string[],
  lock = true
): Promise<Map<string, string[]>> {
  const blocked = new Map<string, string[]>()
  if (userIds.length === 0) {
    return blocked
  }
  const ids = [...userIds]
  if (lock) {
    await lockRows(tx, environmentId, ids)
  }

  const managing = (extra: SQL | undefined) =>
    tx
      .select({
        organizationId: organizationMemberships.organizationId,
        userId: organizationMemberships.userId,
      })
      .from(organizationMemberships)
      .innerJoin(
        organizationRoles,
        and(
          eq(organizationRoles.environmentId, organizationMemberships.environmentId),
          eq(organizationRoles.id, organizationMemberships.roleId)
        )
      )
      .where(
        and(
          eq(organizationMemberships.environmentId, environmentId),
          arrayContains(organizationRoles.permissions, [MEMBERSHIPS_MANAGE_PERMISSION]),
          extra
        )
      )

  const theirs = await managing(inArray(organizationMemberships.userId, ids))
  if (theirs.length === 0) {
    return blocked
  }
  const organizationIds = [...new Set(theirs.map((row) => row.organizationId))]
  const others = await managing(
    and(
      inArray(organizationMemberships.organizationId, organizationIds),
      notInArray(organizationMemberships.userId, ids)
    )
  )
  const covered = new Set(others.map((row) => row.organizationId))
  for (const row of theirs) {
    if (!covered.has(row.organizationId)) {
      blocked.set(row.userId, [...(blocked.get(row.userId) ?? []), row.organizationId])
    }
  }
  for (const [userId, list] of blocked) {
    blocked.set(userId, list.sort())
  }
  return blocked
}
