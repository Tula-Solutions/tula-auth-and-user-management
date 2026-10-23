import { MEMBERSHIPS_MANAGE_PERMISSION } from '@tula-tech/contract'
import {
  type Database,
  organizationMemberships,
  organizationRoles,
  organizations,
  type Transaction,
  withTenant,
} from '@tula-tech/db'
import { and, arrayContains, asc, count, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import {
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from '~/adapters/postgres/errors'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  AddMembershipOutcome,
  ChangeMembershipOutcome,
  DeleteRoleOutcome,
  MembershipRecord,
  OrganizationChanges,
  OrganizationRecord,
  OrganizationRoleRecord,
  OrganizationStore,
  Page,
  PageCriteria,
  RoleChanges,
  UpdateOrganizationOutcome,
  UpdateRoleOutcome,
} from '~/ports/organization-store'

const organizationColumns = {
  id: organizations.id,
  projectId: organizations.projectId,
  environmentId: organizations.environmentId,
  name: organizations.name,
  slug: organizations.slug,
  createdBy: organizations.createdBy,
  createdAt: organizations.createdAt,
  updatedAt: organizations.updatedAt,
}

const roleColumns = {
  id: organizationRoles.id,
  projectId: organizationRoles.projectId,
  environmentId: organizationRoles.environmentId,
  key: organizationRoles.key,
  name: organizationRoles.name,
  permissions: organizationRoles.permissions,
  builtIn: organizationRoles.builtIn,
  version: organizationRoles.version,
  createdAt: organizationRoles.createdAt,
  updatedAt: organizationRoles.updatedAt,
}

const membershipColumns = {
  id: organizationMemberships.id,
  projectId: organizationMemberships.projectId,
  environmentId: organizationMemberships.environmentId,
  organizationId: organizationMemberships.organizationId,
  userId: organizationMemberships.userId,
  roleId: organizationMemberships.roleId,
  roleKey: organizationRoles.key,
  createdAt: organizationMemberships.createdAt,
  updatedAt: organizationMemberships.updatedAt,
}

/** A membership joined to its role, in the one environment (the join is composite on it). */
const joinedToRole = and(
  eq(organizationMemberships.environmentId, organizationRoles.environmentId),
  eq(organizationMemberships.roleId, organizationRoles.id)
)

/** The membership of one user in one organization, with its role's key. */
async function readMembership(
  tx: Transaction,
  environmentId: string,
  organizationId: string,
  userId: string
): Promise<MembershipRecord | null> {
  const [row] = await tx
    .select(membershipColumns)
    .from(organizationMemberships)
    .innerJoin(organizationRoles, joinedToRole)
    .where(
      and(
        eq(organizationMemberships.environmentId, environmentId),
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId)
      )
    )
    .limit(1)
  return row ?? null
}

/**
 * Lock the organization's row, so that the removals and demotions of its members take turns,
 * and say whether it exists. Taking the lock needs UPDATE on a column of the table, which the
 * runtime role has (`name`, `slug`, `updated_at`).
 */
async function lockOrganization(
  tx: Transaction,
  environmentId: string,
  organizationId: string
): Promise<boolean> {
  const rows = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(eq(organizations.environmentId, environmentId), eq(organizations.id, organizationId))
    )
    .for('update')
  return rows.length === 1
}

/** Whether a member other than `userId` holds the permission that manages members. */
async function hasAnotherManager(
  tx: Transaction,
  environmentId: string,
  organizationId: string,
  userId: string
): Promise<boolean> {
  const [row] = await tx
    .select({ value: count() })
    .from(organizationMemberships)
    .innerJoin(organizationRoles, joinedToRole)
    .where(
      and(
        eq(organizationMemberships.environmentId, environmentId),
        eq(organizationMemberships.organizationId, organizationId),
        ne(organizationMemberships.userId, userId),
        arrayContains(organizationRoles.permissions, [MEMBERSHIPS_MANAGE_PERMISSION])
      )
    )
  return (row?.value ?? 0) > 0
}

/** The role with this id. */
async function readRole(
  tx: Transaction,
  environmentId: string,
  id: string
): Promise<OrganizationRoleRecord | null> {
  const [row] = await tx
    .select(roleColumns)
    .from(organizationRoles)
    .where(and(eq(organizationRoles.environmentId, environmentId), eq(organizationRoles.id, id)))
    .limit(1)
  return row ?? null
}

/** The organizations that have a member holding the role. */
function organizationsUsing(tx: Transaction, environmentId: string, roleId: string) {
  return tx
    .select({ id: organizationMemberships.organizationId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.environmentId, environmentId),
        eq(organizationMemberships.roleId, roleId)
      )
    )
}

/**
 * Lock the rows of every organization that has a member holding the role, in id order, so that
 * the removals and demotions of those members (which each lock their organization) take turns
 * with a change to the role. The order is the same for every writer that locks several, so two
 * of them cannot wait for each other. The role's own row is not locked first: a membership
 * change takes a shared lock on it for its foreign key, and the two would wait for each other.
 */
async function lockOrganizationsUsing(
  tx: Transaction,
  environmentId: string,
  roleId: string
): Promise<void> {
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.environmentId, environmentId),
        inArray(organizations.id, organizationsUsing(tx, environmentId, roleId))
      )
    )
    .orderBy(asc(organizations.id))
    .for('update')
}

/**
 * Whether some organization has a member holding the role and no member holding another role
 * that can manage members: the organizations the role is the only source of managers for.
 */
async function isOnlySourceOfManagers(
  tx: Transaction,
  environmentId: string,
  roleId: string
): Promise<boolean> {
  const using = await organizationsUsing(tx, environmentId, roleId)
  if (using.length === 0) {
    return false
  }
  const covered = await tx
    .select({ id: organizationMemberships.organizationId })
    .from(organizationMemberships)
    .innerJoin(organizationRoles, joinedToRole)
    .where(
      and(
        eq(organizationMemberships.environmentId, environmentId),
        ne(organizationMemberships.roleId, roleId),
        arrayContains(organizationRoles.permissions, [MEMBERSHIPS_MANAGE_PERMISSION]),
        inArray(
          organizationMemberships.organizationId,
          organizationsUsing(tx, environmentId, roleId)
        )
      )
    )
  const withManager = new Set(covered.map((row) => row.id))
  return using.some((row) => !withManager.has(row.id))
}

/** Organizations, roles and memberships in Postgres, behind row-level security. */
export class PostgresOrganizationStore implements OrganizationStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async list(
    environmentId: string,
    { page, size }: PageCriteria
  ): Promise<Page<OrganizationRecord>> {
    return withTenant(this.db, environmentId, async (tx) => {
      const where = eq(organizations.environmentId, environmentId)
      const [total] = await tx.select({ value: count() }).from(organizations).where(where)
      const records = await tx
        .select(organizationColumns)
        .from(organizations)
        .where(where)
        // The id breaks ties between organizations of the same instant, so the order is stable.
        .orderBy(desc(organizations.createdAt), desc(organizations.id))
        .limit(size)
        .offset((page - 1) * size)
      return { records, total: total?.value ?? 0 }
    })
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<OrganizationRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(organizationColumns)
        .from(organizations)
        .where(and(eq(organizations.environmentId, environmentId), eq(organizations.id, id)))
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async insert(record: OrganizationRecord, recorded: Recorded): Promise<OrganizationRecord | null> {
    const activity = activityOf(recorded)
    try {
      return await withTenant(this.db, record.environmentId, async (tx) => {
        const [row] = await tx.insert(organizations).values(record).returning(organizationColumns)
        await recordActivity(tx, activity ? [activity] : [])
        // An insert that did not throw returns its row.
        return row as OrganizationRecord
      })
    } catch (error) {
      // The slug is taken (or this very id): the unique key decided, and the transaction, with
      // its audit entry, is rolled back.
      if (isUniqueViolation(error)) {
        return null
      }
      throw error
    }
  }

  /** @inheritdoc */
  async update(
    environmentId: string,
    id: string,
    changes: OrganizationChanges,
    updatedAt: Date,
    recorded: Recorded
  ): Promise<UpdateOrganizationOutcome> {
    const activity = activityOf(recorded)
    try {
      return await withTenant(this.db, environmentId, async (tx) => {
        const [row] = await tx
          .update(organizations)
          // A field left out is `undefined`, which Drizzle leaves out of the statement.
          .set({ name: changes.name, slug: changes.slug, updatedAt })
          .where(and(eq(organizations.environmentId, environmentId), eq(organizations.id, id)))
          .returning(organizationColumns)
        if (!row) {
          return { outcome: 'not_found' } as const
        }
        await recordActivity(tx, activity ? [activity] : [])
        return { outcome: 'updated', record: row } as const
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { outcome: 'slug_taken' }
      }
      throw error
    }
  }

  /** @inheritdoc */
  async delete(environmentId: string, id: string, recorded: Recorded): Promise<boolean> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      // The memberships go with the organization: the foreign key cascades.
      const rows = await tx
        .delete(organizations)
        .where(and(eq(organizations.environmentId, environmentId), eq(organizations.id, id)))
        .returning({ id: organizations.id })
      const deleted = rows.length === 1
      await recordActivity(tx, deleted && activity ? [activity] : [])
      return deleted
    })
  }

  /** @inheritdoc */
  async listMemberships(
    environmentId: string,
    organizationId: string,
    { page, size }: PageCriteria
  ): Promise<Page<MembershipRecord>> {
    return withTenant(this.db, environmentId, async (tx) => {
      const where = and(
        eq(organizationMemberships.environmentId, environmentId),
        eq(organizationMemberships.organizationId, organizationId)
      )
      const [total] = await tx.select({ value: count() }).from(organizationMemberships).where(where)
      const records = await tx
        .select(membershipColumns)
        .from(organizationMemberships)
        .innerJoin(organizationRoles, joinedToRole)
        .where(where)
        .orderBy(asc(organizationMemberships.createdAt), asc(organizationMemberships.id))
        .limit(size)
        .offset((page - 1) * size)
      return { records, total: total?.value ?? 0 }
    })
  }

  /** @inheritdoc */
  async findMembership(
    environmentId: string,
    organizationId: string,
    userId: string
  ): Promise<MembershipRecord | null> {
    return withTenant(this.db, environmentId, (tx) =>
      readMembership(tx, environmentId, organizationId, userId)
    )
  }

  /** @inheritdoc */
  async addMembership(record: MembershipRecord, recorded: Recorded): Promise<AddMembershipOutcome> {
    const activity = activityOf(recorded)
    const { roleKey: _roleKey, ...row } = record
    try {
      return await withTenant(this.db, record.environmentId, async (tx) => {
        await tx.insert(organizationMemberships).values(row)
        await recordActivity(tx, activity ? [activity] : [])
        return { outcome: 'added', record } as const
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { outcome: 'duplicate' }
      }
      // The organization, the user or the role was removed since the caller read it.
      if (isForeignKeyViolation(error)) {
        return { outcome: 'gone' }
      }
      throw error
    }
  }

  /** @inheritdoc */
  async changeRole(
    environmentId: string,
    organizationId: string,
    userId: string,
    expectedRoleId: string,
    role: { id: string; key: string },
    updatedAt: Date,
    recorded: Recorded
  ): Promise<ChangeMembershipOutcome> {
    const activity = activityOf(recorded)
    try {
      return await withTenant(this.db, environmentId, async (tx) => {
        if (!(await lockOrganization(tx, environmentId, organizationId))) {
          return { outcome: 'not_found' } as const
        }
        const current = await readMembership(tx, environmentId, organizationId, userId)
        if (!current) {
          return { outcome: 'not_found' } as const
        }
        if (current.roleId !== expectedRoleId) {
          return { outcome: 'conflict' } as const
        }
        const [held] = await tx
          .select({ permissions: organizationRoles.permissions })
          .from(organizationRoles)
          .where(
            and(
              eq(organizationRoles.environmentId, environmentId),
              eq(organizationRoles.id, current.roleId)
            )
          )
        const [target] = await tx
          .select({ permissions: organizationRoles.permissions })
          .from(organizationRoles)
          .where(
            and(
              eq(organizationRoles.environmentId, environmentId),
              eq(organizationRoles.id, role.id)
            )
          )
        const manages = held?.permissions.includes(MEMBERSHIPS_MANAGE_PERMISSION) === true
        const stays = target?.permissions.includes(MEMBERSHIPS_MANAGE_PERMISSION) === true
        if (
          manages &&
          !stays &&
          !(await hasAnotherManager(tx, environmentId, organizationId, userId))
        ) {
          return { outcome: 'last_manager' } as const
        }
        await tx
          .update(organizationMemberships)
          .set({ roleId: role.id, updatedAt })
          .where(eq(organizationMemberships.id, current.id))
        await recordActivity(tx, activity ? [activity] : [])
        return {
          outcome: 'done',
          record: { ...current, roleId: role.id, roleKey: role.key, updatedAt },
        } as const
      })
    } catch (error) {
      // The role was removed between the caller's read and this write.
      if (isForeignKeyViolation(error)) {
        return { outcome: 'conflict' }
      }
      throw error
    }
  }

  /** @inheritdoc */
  async removeMembership(
    environmentId: string,
    organizationId: string,
    userId: string,
    expectedRoleId: string,
    recorded: Recorded
  ): Promise<ChangeMembershipOutcome> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      if (!(await lockOrganization(tx, environmentId, organizationId))) {
        return { outcome: 'not_found' } as const
      }
      const current = await readMembership(tx, environmentId, organizationId, userId)
      if (!current) {
        return { outcome: 'not_found' } as const
      }
      if (current.roleId !== expectedRoleId) {
        return { outcome: 'conflict' } as const
      }
      const [held] = await tx
        .select({ permissions: organizationRoles.permissions })
        .from(organizationRoles)
        .where(
          and(
            eq(organizationRoles.environmentId, environmentId),
            eq(organizationRoles.id, current.roleId)
          )
        )
      if (
        held?.permissions.includes(MEMBERSHIPS_MANAGE_PERMISSION) === true &&
        !(await hasAnotherManager(tx, environmentId, organizationId, userId))
      ) {
        return { outcome: 'last_manager' } as const
      }
      await tx.delete(organizationMemberships).where(eq(organizationMemberships.id, current.id))
      await recordActivity(tx, activity ? [activity] : [])
      return { outcome: 'done', record: current } as const
    })
  }

  /** @inheritdoc */
  async listRoles(environmentId: string): Promise<OrganizationRoleRecord[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select(roleColumns)
        .from(organizationRoles)
        .where(eq(organizationRoles.environmentId, environmentId))
        .orderBy(desc(organizationRoles.builtIn), asc(organizationRoles.key))
    )
  }

  /** @inheritdoc */
  async findRole(environmentId: string, key: string): Promise<OrganizationRoleRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(roleColumns)
        .from(organizationRoles)
        .where(
          and(eq(organizationRoles.environmentId, environmentId), eq(organizationRoles.key, key))
        )
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async findRoleById(environmentId: string, id: string): Promise<OrganizationRoleRecord | null> {
    return withTenant(this.db, environmentId, (tx) => readRole(tx, environmentId, id))
  }

  /** @inheritdoc */
  async insertRole(
    record: OrganizationRoleRecord,
    recorded: Recorded
  ): Promise<OrganizationRoleRecord | null> {
    const activity = activityOf(recorded)
    try {
      return await withTenant(this.db, record.environmentId, async (tx) => {
        const [row] = await tx.insert(organizationRoles).values(record).returning(roleColumns)
        await recordActivity(tx, activity ? [activity] : [])
        // An insert that did not throw returns its row.
        return row as OrganizationRoleRecord
      })
    } catch (error) {
      // The key is taken (the unique key decided), or it is a built-in role's key
      // (`organization_roles_reserved_keys`); the transaction, with its audit entry, is rolled
      // back either way.
      if (isUniqueViolation(error) || isCheckViolation(error)) {
        return null
      }
      throw error
    }
  }

  /** @inheritdoc */
  async updateRole(
    environmentId: string,
    id: string,
    expectedVersion: number,
    changes: RoleChanges,
    updatedAt: Date,
    recorded: Recorded
  ): Promise<UpdateRoleOutcome> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const current = await readRole(tx, environmentId, id)
      if (!current) {
        return { outcome: 'not_found' } as const
      }
      if (current.builtIn) {
        return { outcome: 'built_in' } as const
      }
      if (current.version !== expectedVersion) {
        return { outcome: 'stale', version: current.version } as const
      }
      const dropsManage =
        current.permissions.includes(MEMBERSHIPS_MANAGE_PERMISSION) &&
        changes.permissions !== undefined &&
        !changes.permissions.includes(MEMBERSHIPS_MANAGE_PERMISSION)
      if (dropsManage) {
        await lockOrganizationsUsing(tx, environmentId, id)
        if (await isOnlySourceOfManagers(tx, environmentId, id)) {
          return { outcome: 'last_manager' } as const
        }
      }
      const [row] = await tx
        .update(organizationRoles)
        .set({
          // A field left out is `undefined`, which Drizzle leaves out of the statement.
          name: changes.name,
          permissions: changes.permissions,
          version: sql`${organizationRoles.version} + 1`,
          updatedAt,
        })
        .where(
          and(
            eq(organizationRoles.environmentId, environmentId),
            eq(organizationRoles.id, id),
            eq(organizationRoles.version, expectedVersion)
          )
        )
        .returning(roleColumns)
      if (!row) {
        // Another change got in between the read and the write.
        const now = await readRole(tx, environmentId, id)
        return now
          ? ({ outcome: 'stale', version: now.version } as const)
          : ({ outcome: 'not_found' } as const)
      }
      await recordActivity(tx, activity ? [activity] : [])
      return { outcome: 'updated', record: row } as const
    })
  }

  /** @inheritdoc */
  async deleteRole(
    environmentId: string,
    id: string,
    expectedVersion: number | null,
    recorded: Recorded
  ): Promise<DeleteRoleOutcome> {
    const activity = activityOf(recorded)
    try {
      return await withTenant(this.db, environmentId, async (tx) => {
        const current = await readRole(tx, environmentId, id)
        if (!current) {
          return { outcome: 'not_found' } as const
        }
        if (current.builtIn) {
          return { outcome: 'built_in' } as const
        }
        if (expectedVersion !== null && current.version !== expectedVersion) {
          return { outcome: 'stale', version: current.version } as const
        }
        const [held] = await tx
          .select({ value: count() })
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.environmentId, environmentId),
              eq(organizationMemberships.roleId, id)
            )
          )
        if ((held?.value ?? 0) > 0) {
          return { outcome: 'in_use' } as const
        }
        const rows = await tx
          .delete(organizationRoles)
          .where(
            and(
              eq(organizationRoles.environmentId, environmentId),
              eq(organizationRoles.id, id),
              eq(organizationRoles.version, current.version)
            )
          )
          .returning({ id: organizationRoles.id })
        if (rows.length === 0) {
          // Changed (or deleted) between the read and the delete.
          const now = await readRole(tx, environmentId, id)
          return now
            ? ({ outcome: 'stale', version: now.version } as const)
            : ({ outcome: 'not_found' } as const)
        }
        await recordActivity(tx, activity ? [activity] : [])
        return { outcome: 'deleted', record: current } as const
      })
    } catch (error) {
      // A member was given the role between the count and the delete: the membership's foreign
      // key refuses the deletion, and the transaction, with its audit entry, is rolled back.
      if (isForeignKeyViolation(error)) {
        return { outcome: 'in_use' }
      }
      throw error
    }
  }

  /** @inheritdoc */
  async ensureBuiltInRoles(roles: readonly OrganizationRoleRecord[]): Promise<void> {
    // One environment at a time: a row is only visible and writable inside its own.
    for (const environmentId of new Set(roles.map((role) => role.environmentId))) {
      await withTenant(this.db, environmentId, (tx) =>
        tx
          .insert(organizationRoles)
          .values(roles.filter((role) => role.environmentId === environmentId))
          // Two instances creating an environment's roles at once: the first wins, both are fine.
          .onConflictDoNothing({
            target: [organizationRoles.environmentId, organizationRoles.key],
          })
      )
    }
  }
}
