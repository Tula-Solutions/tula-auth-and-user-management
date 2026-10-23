import type { InvitationStatus } from '@tula-tech/contract'
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
 * An organization a user belongs to, with their membership and the permissions of their role
 * as stored now (ADR 0065, Orgs 02). **The one shape every read of "what may this member do"
 * goes through**: the list of a user's organizations and the claims of a token are built from
 * it, so the rule that turns a role into permissions is in one place.
 */
export interface UserMembershipRecord {
  organization: OrganizationRecord
  membership: MembershipRecord
  /** The permission keys of the membership's role. */
  permissions: string[]
}

/** What creating an organization for a user, as its first member, came to. */
export type CreateOwnedOutcome =
  | { outcome: 'created'; record: UserMembershipRecord }
  | { outcome: 'slug_taken' }
  /** The user has already created as many organizations as the limit allows. */
  | { outcome: 'limit_reached' }
  /** The user or the role is gone (removed between the read and the write). */
  | { outcome: 'gone' }

/** What {@link OrganizationStore.insertOwned} writes. */
export interface OwnedOrganization {
  /** The organization, with `createdBy` the user. */
  organization: OrganizationRecord
  /** The creator's membership. */
  membership: MembershipRecord
  /** The permissions of the role the membership names. */
  permissions: string[]
  /** The most organizations the user may have created, this one included; `null` for no limit. */
  limit: number | null
}

/** The states an invitation is stored in. `expired` is derived: a pending one past its expiry. */
export type StoredInvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked'

/**
 * An invitation to an organization as stored (ADR 0065, Orgs 04). The token is never stored,
 * only its SHA-256.
 */
export interface InvitationRecord {
  id: string
  projectId: string
  environmentId: string
  organizationId: string
  /** The invited address as it was typed: where the email went. Personal data. */
  email: string
  /** The same trimmed and lower-cased (`normalizeEmail`): what a signed-in user's is compared to. */
  emailNormalized: string
  /** The key of the role the invitee gets. Not a reference: the role may be deleted later. */
  roleKey: string
  /** SHA-256 of the token the emailed link carries. */
  tokenHash: string
  status: StoredInvitationStatus
  /** The user who invited them, or `null` for an administrator. */
  invitedBy: string | null
  expiresAt: Date
  /** When it was accepted, declined or revoked; `null` while pending. */
  resolvedAt: Date | null
  /** The user who accepted or declined it; `null` while pending and when revoked. */
  resolvedBy: string | null
  createdAt: Date
  updatedAt: Date
}

/** What storing a new invitation came to. */
export type InsertInvitationOutcome =
  | { outcome: 'created'; record: InvitationRecord }
  /** The address has a pending invitation (not expired) to the organization already. */
  | { outcome: 'exists' }
  /** The organization is gone (removed between the read and the write). */
  | { outcome: 'gone' }

/** What revoking, declining or accepting an invitation came to. */
export type ResolveInvitationOutcome =
  /** The invitation was pending and is now resolved. */
  | { outcome: 'done'; record: InvitationRecord }
  /** It could not be resolved: it was resolved already, or it has expired. Its state now. */
  | { outcome: 'unavailable'; record: InvitationRecord }
  | { outcome: 'not_found' }

/** What accepting an invitation came to. */
export type AcceptInvitationOutcome =
  | { outcome: 'accepted'; record: InvitationRecord; membership: MembershipRecord }
  | { outcome: 'unavailable'; record: InvitationRecord }
  | { outcome: 'not_found' }
  /** The user is a member of the organization already. Nothing was written. */
  | { outcome: 'duplicate' }
  /** The organization, the user or the role is gone. Nothing was written. */
  | { outcome: 'gone' }

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
   * The organizations a user belongs to, the one they joined first at the top.
   *
   * @param environmentId - The environment to look in.
   * @param userId - The user.
   * @param page - Which page.
   * @returns The user's memberships with their organizations and permissions, and how many.
   */
  listUserMemberships(
    environmentId: string,
    userId: string,
    page: PageCriteria
  ): Promise<Page<UserMembershipRecord>>

  /**
   * @param environmentId - The environment to look in.
   * @param organizationId - The organization.
   * @param userId - The user.
   * @returns The user's membership of that organization with its permissions, or `null` when
   *   they are not a member (or the organization is another environment's, or does not exist).
   */
  findUserMembership(
    environmentId: string,
    organizationId: string,
    userId: string
  ): Promise<UserMembershipRecord | null>

  /**
   * Create an organization for a user and make them its first member, **in one transaction**
   * that first holds the user's row, so that the limit on organizations one user creates holds
   * against simultaneous requests: of several creations at once, no more than the limit are
   * stored.
   *
   * @param input - The organization, the membership and the limit.
   * @param activities - The records of the two writes, stored with them.
   * @returns What came of it. Nothing is written unless it is `created`.
   */
  insertOwned(
    input: OwnedOrganization,
    activities: { organization: Recorded; membership: Recorded }
  ): Promise<CreateOwnedOutcome>

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
   * Store an invitation, in one transaction that first removes a pending invitation of the same
   * organization and address that has **expired** (it would hold the one-pending-per-address
   * key for nothing). One that has not expired makes this `exists`.
   *
   * @param record - The invitation, `pending`.
   * @param now - The time the expiry is judged at.
   * @param activity - Recorded in the same transaction, only if the invitation was stored.
   * @returns What came of it.
   */
  insertInvitation(
    record: InvitationRecord,
    now: Date,
    activity: Recorded
  ): Promise<InsertInvitationOutcome>

  /**
   * @param environmentId - The environment to look in.
   * @param organizationId - The organization.
   * @param status - Which invitations: `pending` is the stored ones still inside their expiry,
   *   `expired` the pending ones past it, the others are stored states.
   * @param now - The time the expiry is judged at.
   * @param page - Which page.
   * @returns The invitations, newest first, and how many there are.
   */
  listInvitations(
    environmentId: string,
    organizationId: string,
    status: InvitationStatus,
    now: Date,
    page: PageCriteria
  ): Promise<Page<InvitationRecord>>

  /**
   * @param environmentId - The environment to look in.
   * @param organizationId - The organization the invitation must be of.
   * @param id - The invitation.
   * @returns The invitation, or `null` when there is none with that id in the organization.
   */
  findInvitation(
    environmentId: string,
    organizationId: string,
    id: string
  ): Promise<InvitationRecord | null>

  /**
   * @param environmentId - The environment to look in.
   * @param tokenHash - The SHA-256 of the presented token.
   * @returns The invitation that token belongs to, or `null`.
   */
  findInvitationByTokenHash(
    environmentId: string,
    tokenHash: string
  ): Promise<InvitationRecord | null>

  /**
   * Withdraw a pending invitation, **only if it is still pending and has not expired**. The
   * write is conditional, so of two resolutions at once one wins.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization the invitation must be of.
   * @param id - The invitation.
   * @param now - When it is withdrawn, and the time its expiry is judged at.
   * @param activity - Recorded in the same transaction, only if it was withdrawn.
   * @returns What came of it.
   */
  revokeInvitation(
    environmentId: string,
    organizationId: string,
    id: string,
    now: Date,
    activity: Recorded
  ): Promise<ResolveInvitationOutcome>

  /**
   * Decline a pending invitation, on the same conditions as {@link revokeInvitation}.
   *
   * @param environmentId - The environment.
   * @param id - The invitation.
   * @param userId - The user who declines it.
   * @param now - When it is declined, and the time its expiry is judged at.
   * @param activity - Recorded in the same transaction, only if it was declined.
   * @returns What came of it.
   */
  declineInvitation(
    environmentId: string,
    id: string,
    userId: string,
    now: Date,
    activity: Recorded
  ): Promise<ResolveInvitationOutcome>

  /**
   * Accept a pending invitation and make the user a member, **in one transaction**: the
   * invitation is used up only if the membership is stored, and the membership is stored only
   * if the invitation was still pending and had not expired. Two acceptances at once make
   * one membership; a user who is a member already is `duplicate` and the invitation stays
   * pending.
   *
   * @param environmentId - The environment.
   * @param id - The invitation.
   * @param membership - The membership to store, with the role the service resolved.
   * @param now - When it is accepted, and the time its expiry is judged at.
   * @param activities - The records of the two writes, stored with them.
   * @returns What came of it. Nothing is written unless it is `accepted`.
   */
  acceptInvitation(
    environmentId: string,
    id: string,
    membership: MembershipRecord,
    now: Date,
    activities: { invitation: Recorded; membership: Recorded }
  ): Promise<AcceptInvitationOutcome>

  /**
   * Delete invitations that expired before a cutoff, whatever became of them, at most `limit`
   * of them (the retention job's batch).
   *
   * @param environmentId - The environment whose invitations are purged.
   * @param before - The cutoff: rows whose `expiresAt` is earlier go.
   * @param limit - The most rows to delete.
   * @returns How many were deleted.
   */
  deleteExpiredInvitations(environmentId: string, before: Date, limit: number): Promise<number>

  /**
   * Store the built-in roles of an environment that does not have them yet. A role the
   * environment already has (by key) is left as it is, so this is safe to call at any time
   * and from several instances at once. Not an audit event: it is not a change anyone made.
   *
   * @param roles - The built-in roles to store, if absent.
   */
  ensureBuiltInRoles(roles: readonly OrganizationRoleRecord[]): Promise<void>
}
