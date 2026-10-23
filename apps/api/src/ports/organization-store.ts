import type { Recorded } from '~/ports/activity-log'

/** An organization as stored (ADR 0065). */
export interface OrganizationRecord {
  id: string
  projectId: string
  environmentId: string
  name: string
  /** Unique in the environment. */
  slug: string
  /** The user who created it; `null` when an administrator did. */
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

/** A role as stored: a set of permission keys, shared by every organization of the environment. */
export interface OrganizationRoleRecord {
  id: string
  projectId: string
  environmentId: string
  /** Unique in the environment. */
  key: string
  name: string
  permissions: string[]
  /** `true` for the two roles every environment has, `admin` and `member`. */
  builtIn: boolean
  /**
   * How many changes the role has had, from 1. A change is made only over the version the
   * caller read, so two administrators cannot overwrite each other's change.
   */
  version: number
  createdAt: Date
  updatedAt: Date
}

/** A user's membership of an organization, with the key of the role they hold. */
export interface MembershipRecord {
  id: string
  projectId: string
  environmentId: string
  organizationId: string
  userId: string
  roleId: string
  /** The `key` of the role `roleId` names. */
  roleKey: string
  createdAt: Date
  updatedAt: Date
}

/** The page of a list: one-based `page`, and how many rows it holds at most. */
export interface PageCriteria {
  page: number
  size: number
}

/** One page of rows and how many there are in all. */
export interface Page<T> {
  records: T[]
  total: number
}

/** The fields of an organization an update may change. */
export interface OrganizationChanges {
  name?: string
  slug?: string
}

/** What an update of an organization came to. */
export type UpdateOrganizationOutcome =
  | { outcome: 'updated'; record: OrganizationRecord }
  | { outcome: 'not_found' }
  | { outcome: 'slug_taken' }

/** What adding a member came to. */
export type AddMembershipOutcome =
  | { outcome: 'added'; record: MembershipRecord }
  /** The user is a member of the organization already. */
  | { outcome: 'duplicate' }
  /** The organization, the user or the role is gone (removed between the read and the write). */
  | { outcome: 'gone' }

/** What changing or removing a membership came to. */
export type ChangeMembershipOutcome =
  | { outcome: 'done'; record: MembershipRecord }
  | { outcome: 'not_found' }
  /** The membership does not hold the role the caller read: someone changed it meanwhile. */
  | { outcome: 'conflict' }
  /**
   * The change would leave the organization with no member who holds
   * `org:sys:memberships:manage`. Nothing was written.
   */
  | { outcome: 'last_manager' }

/** The fields of a custom role an update may change. The key is not among them. */
export interface RoleChanges {
  name?: string
  /** The whole set: sorted, each key once. */
  permissions?: string[]
}

/** What an update of a custom role came to. */
export type UpdateRoleOutcome =
  | { outcome: 'updated'; record: OrganizationRoleRecord }
  | { outcome: 'not_found' }
  /** The role is built in. Nothing was written. */
  | { outcome: 'built_in' }
  /** The role is no longer at the version the caller read (`version` is the current one). */
  | { outcome: 'stale'; version: number }
  /**
   * The change takes `org:sys:memberships:manage` away from the role, and some organization
   * has no manager but the members who hold it. Nothing was written.
   */
  | { outcome: 'last_manager' }

/** What the deletion of a custom role came to. */
export type DeleteRoleOutcome =
  | { outcome: 'deleted'; record: OrganizationRoleRecord }
  | { outcome: 'not_found' }
  /** The role is built in. Nothing was deleted. */
  | { outcome: 'built_in' }
  /** The role is no longer at the version the caller read (`version` is the current one). */
  | { outcome: 'stale'; version: number }
  /** A member still holds the role. Nothing was deleted. */
  | { outcome: 'in_use' }

/**
 * Organizations, the roles of an environment and the memberships between users and
 * organizations, always read and written inside one environment (ADR 0065). Another
 * environment's row is never returned, changed or counted.
 */
export interface OrganizationStore {
  /**
   * @param environmentId - The environment to look in.
   * @param page - Which page.
   * @returns The environment's organizations, newest first, and how many there are.
   */
  list(environmentId: string, page: PageCriteria): Promise<Page<OrganizationRecord>>

  /**
   * @param environmentId - The environment to look in.
   * @param id - The organization.
   * @returns The organization, or `null` when the environment has none with that id.
   */
  find(environmentId: string, id: string): Promise<OrganizationRecord | null>

  /**
   * Store a new organization.
   *
   * @param record - The organization.
   * @param activity - Recorded in the same transaction, only if the organization was stored.
   * @returns The row as stored, or `null` when the environment already has an organization
   *   with that slug: the unique key decides, so of two creations at once one is stored.
   */
  insert(record: OrganizationRecord, activity: Recorded): Promise<OrganizationRecord | null>

  /**
   * Rename an organization or change its slug.
   *
   * @param environmentId - The environment. An organization of another is not touched.
   * @param id - The organization.
   * @param changes - The fields to set; one left out keeps its value.
   * @param updatedAt - When the change is made.
   * @param activity - Recorded in the same transaction, only if the row was written.
   * @returns What came of it.
   */
  update(
    environmentId: string,
    id: string,
    changes: OrganizationChanges,
    updatedAt: Date,
    activity: Recorded
  ): Promise<UpdateOrganizationOutcome>

  /**
   * Delete an organization. Its memberships go with it.
   *
   * @param environmentId - The environment. An organization of another is not touched.
   * @param id - The organization.
   * @param activity - Recorded in the same transaction, only if something was deleted.
   * @returns `false` when the environment had no organization with that id.
   */
  delete(environmentId: string, id: string, activity: Recorded): Promise<boolean>

  /**
   * @param environmentId - The environment to look in.
   * @param organizationId - The organization. One of another environment has no members here.
   * @param page - Which page.
   * @returns Its memberships, oldest first, and how many there are.
   */
  listMemberships(
    environmentId: string,
    organizationId: string,
    page: PageCriteria
  ): Promise<Page<MembershipRecord>>

  /**
   * @param environmentId - The environment to look in.
   * @param organizationId - The organization.
   * @param userId - The user.
   * @returns The membership, or `null` when the user is not a member.
   */
  findMembership(
    environmentId: string,
    organizationId: string,
    userId: string
  ): Promise<MembershipRecord | null>

  /**
   * Add a user to an organization with a role.
   *
   * @param record - The membership, with the role it names.
   * @param activity - Recorded in the same transaction, only if the user was added.
   * @returns What came of it. The unique key decides a race between two additions.
   */
  addMembership(record: MembershipRecord, activity: Recorded): Promise<AddMembershipOutcome>

  /**
   * Give a member another role, **only if they still hold the role the caller read**, and
   * never so that the organization is left with no member holding
   * `org:sys:memberships:manage`. The check and the write are one transaction that holds the
   * organization's row, so two demotions at once cannot each see another manager.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param userId - The member.
   * @param expectedRoleId - The role the caller read the member in.
   * @param role - The role to give.
   * @param updatedAt - When the change is made.
   * @param activity - Recorded in the same transaction, only if the role was changed.
   * @returns What came of it.
   */
  changeRole(
    environmentId: string,
    organizationId: string,
    userId: string,
    expectedRoleId: string,
    role: Pick<OrganizationRoleRecord, 'id' | 'key'>,
    updatedAt: Date,
    activity: Recorded
  ): Promise<ChangeMembershipOutcome>

  /**
   * Remove a member, **only if they still hold the role the caller read**, and never so that
   * the organization is left with no member holding `org:sys:memberships:manage` (the same
   * transaction as {@link changeRole}).
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param userId - The member.
   * @param expectedRoleId - The role the caller read the member in.
   * @param activity - Recorded in the same transaction, only if the member was removed.
   * @returns What came of it.
   */
  removeMembership(
    environmentId: string,
    organizationId: string,
    userId: string,
    expectedRoleId: string,
    activity: Recorded
  ): Promise<ChangeMembershipOutcome>

  /**
   * @param environmentId - The environment to look in.
   * @returns Its roles, built-in ones first, then by key.
   */
  listRoles(environmentId: string): Promise<OrganizationRoleRecord[]>

  /**
   * @param environmentId - The environment to look in.
   * @param key - The role's key.
   * @returns The role, or `null` when the environment has none with that key.
   */
  findRole(environmentId: string, key: string): Promise<OrganizationRoleRecord | null>

  /**
   * @param environmentId - The environment to look in.
   * @param id - The role's id.
   * @returns The role, or `null` when the environment has none with that id.
   */
  findRoleById(environmentId: string, id: string): Promise<OrganizationRoleRecord | null>

  /**
   * Store a new custom role at version 1.
   *
   * @param record - The role. Never built in, and never with a built-in key.
   * @param activity - Recorded in the same transaction, only if the role was stored.
   * @returns The row as stored, or `null` when the environment already has a role with that
   *   key: the unique key decides, so of two definitions at once one is stored.
   */
  insertRole(
    record: OrganizationRoleRecord,
    activity: Recorded
  ): Promise<OrganizationRoleRecord | null>

  /**
   * Rename a custom role or replace its permissions, **only if it is still at the version the
   * caller read**, and never so that an organization is left with no member holding
   * `org:sys:memberships:manage`. The version goes up by one. The check of the managers is made
   * while holding the rows of the organizations the role is used in, so it takes turns with
   * the removal and demotion of their members. Members' tokens carry the new permissions from
   * their next refresh: nothing is copied into a membership.
   *
   * @param environmentId - The environment. A role of another is not touched.
   * @param id - The role.
   * @param expectedVersion - The version the caller read.
   * @param changes - The fields to set; one left out keeps its value.
   * @param updatedAt - When the change is made.
   * @param activity - Recorded in the same transaction, only if the role was written.
   * @returns What came of it.
   */
  updateRole(
    environmentId: string,
    id: string,
    expectedVersion: number,
    changes: RoleChanges,
    updatedAt: Date,
    activity: Recorded
  ): Promise<UpdateRoleOutcome>

  /**
   * Delete a custom role, **only if it is still at `expectedVersion`** (when one is given) and
   * no member holds it.
   *
   * @param environmentId - The environment. A role of another is not touched.
   * @param id - The role.
   * @param expectedVersion - The version the caller read, or `null` to delete whatever it is.
   * @param activity - Recorded in the same transaction, only if the role was deleted.
   * @returns What came of it.
   */
  deleteRole(
    environmentId: string,
    id: string,
    expectedVersion: number | null,
    activity: Recorded
  ): Promise<DeleteRoleOutcome>

  /**
   * Store the built-in roles of an environment that does not have them yet. A role the
   * environment already has (by key) is left as it is, so this is safe to call at any time
   * and from several instances at once. Not an audit event: it is not a change anyone made.
   *
   * @param roles - The built-in roles to store, if absent.
   */
  ensureBuiltInRoles(roles: readonly OrganizationRoleRecord[]): Promise<void>
}
