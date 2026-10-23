import {
  BUILT_IN_ROLES,
  type InvitationStatus,
  MEMBERSHIPS_MANAGE_PERMISSION,
} from '@tula-tech/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import type { MemoryUserRepository } from '~/adapters/memory/users'
import { activityOf, type Recorded, recordedOf } from '~/ports/activity-log'
import type {
  AcceptInvitationOutcome,
  AddMembershipOutcome,
  ChangeMembershipOutcome,
  CreateOwnedOutcome,
  DeleteRoleOutcome,
  InsertInvitationOutcome,
  InvitationRecord,
  MembershipRecord,
  OrganizationChanges,
  OrganizationRecord,
  OrganizationRoleRecord,
  OrganizationStore,
  OwnedOrganization,
  Page,
  PageCriteria,
  ResolveInvitationOutcome,
  RoleChanges,
  UpdateOrganizationOutcome,
  UpdateRoleOutcome,
  UserMembershipRecord,
} from '~/ports/organization-store'

/** A page of `rows`, which the caller has already put in order. */
function paged<T>(rows: readonly T[], { page, size }: PageCriteria): Page<T> {
  return {
    records: rows.slice((page - 1) * size, page * size).map((row) => structuredClone(row)),
    total: rows.length,
  }
}

/** In-memory organizations, roles and memberships for tests. */
export class MemoryOrganizationStore implements OrganizationStore {
  readonly #organizations: Map<string, OrganizationRecord>
  readonly #roles: Map<string, OrganizationRoleRecord>
  readonly #memberships: Map<string, MembershipRecord>
  readonly #invitations: Map<string, InvitationRecord>
  readonly #activityLog: MemoryActivityLog
  readonly #users: MemoryUserRepository | null

  /**
   * @param activityLog - Where activity is recorded; shared with the other memory stores.
   * @param users - The users these memberships refer to. Given, a membership for a user it
   *   does not hold is refused (`gone`, as the foreign key does) and a deleted user's
   *   memberships go with them (as the cascade does). Left out, any user id is accepted.
   */
  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(
    activityLog: MemoryActivityLog = new MemoryActivityLog(),
    users: MemoryUserRepository | null = null
  ) {
    this.#organizations = new Map()
    this.#roles = new Map()
    this.#memberships = new Map()
    this.#invitations = new Map()
    this.#activityLog = activityLog
    this.#users = users
    users?.onDelete((environmentId, userId) => {
      for (const [key, membership] of this.#memberships) {
        if (membership.environmentId === environmentId && membership.userId === userId) {
          this.#memberships.delete(key)
        }
      }
    })
  }

  /** The stored organization, when it is this environment's. */
  #own(environmentId: string, id: string): OrganizationRecord | null {
    const record = this.#organizations.get(id)
    return record && record.environmentId === environmentId ? record : null
  }

  /** The membership of a user in an organization of this environment. */
  #membership(environmentId: string, organizationId: string, userId: string) {
    return (
      [...this.#memberships.values()].find(
        (one) =>
          one.environmentId === environmentId &&
          one.organizationId === organizationId &&
          one.userId === userId
      ) ?? null
    )
  }

  /** Whether a member other than `userId` holds the permission that manages members. */
  #anotherManager(environmentId: string, organizationId: string, userId: string): boolean {
    return [...this.#memberships.values()].some(
      (one) =>
        one.environmentId === environmentId &&
        one.organizationId === organizationId &&
        one.userId !== userId &&
        this.#roles.get(one.roleId)?.permissions.includes(MEMBERSHIPS_MANAGE_PERMISSION) === true
    )
  }

  /** Whether the role of a membership holds the permission that manages members. */
  #manages(membership: MembershipRecord): boolean {
    return (
      this.#roles.get(membership.roleId)?.permissions.includes(MEMBERSHIPS_MANAGE_PERMISSION) ===
      true
    )
  }

  /** @inheritdoc */
  async list(environmentId: string, page: PageCriteria): Promise<Page<OrganizationRecord>> {
    const rows = [...this.#organizations.values()]
      .filter((record) => record.environmentId === environmentId)
      // Newest first; the id breaks ties between organizations of the same instant.
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
    return paged(rows, page)
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<OrganizationRecord | null> {
    const record = this.#own(environmentId, id)
    return record && structuredClone(record)
  }

  /** @inheritdoc */
  async insert(record: OrganizationRecord, recorded: Recorded): Promise<OrganizationRecord | null> {
    const activity = activityOf(recorded)
    // The primary key and the slug's unique key, as Postgres would decide them.
    const taken = [...this.#organizations.values()].some(
      (one) =>
        one.id === record.id ||
        (one.environmentId === record.environmentId && one.slug === record.slug)
    )
    if (taken) {
      return null
    }
    this.#organizations.set(record.id, structuredClone(record))
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(record)
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
    const record = this.#own(environmentId, id)
    if (!record) {
      return { outcome: 'not_found' }
    }
    if (
      changes.slug !== undefined &&
      [...this.#organizations.values()].some(
        (one) => one.id !== id && one.environmentId === environmentId && one.slug === changes.slug
      )
    ) {
      return { outcome: 'slug_taken' }
    }
    const next: OrganizationRecord = {
      ...record,
      name: changes.name ?? record.name,
      slug: changes.slug ?? record.slug,
      updatedAt,
    }
    this.#organizations.set(id, next)
    this.#activityLog.record(activity ? [activity] : [])
    return { outcome: 'updated', record: structuredClone(next) }
  }

  /** @inheritdoc */
  async delete(environmentId: string, id: string, recorded: Recorded): Promise<boolean> {
    const activity = activityOf(recorded)
    if (this.#own(environmentId, id) === null) {
      this.#activityLog.record([])
      return false
    }
    this.#organizations.delete(id)
    // The memberships and invitations go with their organization, as the foreign keys cascade.
    for (const [key, membership] of this.#memberships) {
      if (membership.organizationId === id) {
        this.#memberships.delete(key)
      }
    }
    for (const [key, invitation] of this.#invitations) {
      if (invitation.organizationId === id) {
        this.#invitations.delete(key)
      }
    }
    this.#activityLog.record(activity ? [activity] : [])
    return true
  }

  /** @inheritdoc */
  async listMemberships(
    environmentId: string,
    organizationId: string,
    page: PageCriteria
  ): Promise<Page<MembershipRecord>> {
    const rows = [...this.#memberships.values()]
      .filter((one) => one.environmentId === environmentId && one.organizationId === organizationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
    return paged(rows, page)
  }

  /** @inheritdoc */
  async findMembership(
    environmentId: string,
    organizationId: string,
    userId: string
  ): Promise<MembershipRecord | null> {
    const found = this.#membership(environmentId, organizationId, userId)
    return found && structuredClone(found)
  }

  /** @inheritdoc */
  async addMembership(record: MembershipRecord, recorded: Recorded): Promise<AddMembershipOutcome> {
    const activity = activityOf(recorded)
    if (
      this.#own(record.environmentId, record.organizationId) === null ||
      this.#roles.get(record.roleId)?.environmentId !== record.environmentId
    ) {
      return { outcome: 'gone' }
    }
    if (this.#users && (await this.#users.findById(record.environmentId, record.userId)) === null) {
      return { outcome: 'gone' }
    }
    if (this.#membership(record.environmentId, record.organizationId, record.userId)) {
      return { outcome: 'duplicate' }
    }
    this.#memberships.set(record.id, structuredClone(record))
    this.#activityLog.record(activity ? [activity] : [])
    return { outcome: 'added', record: structuredClone(record) }
  }

  /** @inheritdoc */
  async changeRole(
    environmentId: string,
    organizationId: string,
    userId: string,
    expectedRoleId: string,
    role: Pick<OrganizationRoleRecord, 'id' | 'key'>,
    updatedAt: Date,
    recorded: Recorded
  ): Promise<ChangeMembershipOutcome> {
    const activity = activityOf(recorded)
    const current = this.#membership(environmentId, organizationId, userId)
    if (!current) {
      return { outcome: 'not_found' }
    }
    if (current.roleId !== expectedRoleId) {
      return { outcome: 'conflict' }
    }
    const stays = this.#roles.get(role.id)?.permissions.includes(MEMBERSHIPS_MANAGE_PERMISSION)
    if (
      this.#manages(current) &&
      !stays &&
      !this.#anotherManager(environmentId, organizationId, userId)
    ) {
      return { outcome: 'last_manager' }
    }
    const next: MembershipRecord = { ...current, roleId: role.id, roleKey: role.key, updatedAt }
    this.#memberships.set(current.id, next)
    this.#activityLog.record(activity ? [activity] : [])
    return { outcome: 'done', record: structuredClone(next) }
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
    const current = this.#membership(environmentId, organizationId, userId)
    if (!current) {
      return { outcome: 'not_found' }
    }
    if (current.roleId !== expectedRoleId) {
      return { outcome: 'conflict' }
    }
    if (this.#manages(current) && !this.#anotherManager(environmentId, organizationId, userId)) {
      return { outcome: 'last_manager' }
    }
    this.#memberships.delete(current.id)
    this.#activityLog.record(activity ? [activity] : [])
    return { outcome: 'done', record: structuredClone(current) }
  }

  /** The membership with its organization and the permissions of its role. */
  #joined(membership: MembershipRecord): UserMembershipRecord | null {
    const organization = this.#own(membership.environmentId, membership.organizationId)
    const role = this.#roles.get(membership.roleId)
    if (!organization || !role) {
      return null
    }
    return structuredClone({ organization, membership, permissions: role.permissions })
  }

  /** @inheritdoc */
  async listUserMemberships(
    environmentId: string,
    userId: string,
    page: PageCriteria
  ): Promise<Page<UserMembershipRecord>> {
    const rows = [...this.#memberships.values()]
      .filter((one) => one.environmentId === environmentId && one.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .flatMap((one) => this.#joined(one) ?? [])
    return paged(rows, page)
  }

  /** @inheritdoc */
  async findUserMembership(
    environmentId: string,
    organizationId: string,
    userId: string
  ): Promise<UserMembershipRecord | null> {
    const found = this.#membership(environmentId, organizationId, userId)
    return found ? this.#joined(found) : null
  }

  /** @inheritdoc */
  async insertOwned(
    input: OwnedOrganization,
    activities: { organization: Recorded; membership: Recorded }
  ): Promise<CreateOwnedOutcome> {
    const { organization, membership, limit } = input
    // No await between the checks and the writes: one turn of the event loop, which is what
    // makes the limit hold against simultaneous creations here.
    if (
      this.#users &&
      (await this.#users.findById(organization.environmentId, membership.userId)) === null
    ) {
      return { outcome: 'gone' }
    }
    if (this.#roles.get(membership.roleId)?.environmentId !== membership.environmentId) {
      return { outcome: 'gone' }
    }
    const created = [...this.#organizations.values()].filter(
      (one) =>
        one.environmentId === organization.environmentId && one.createdBy === organization.createdBy
    ).length
    if (limit !== null && created >= limit) {
      return { outcome: 'limit_reached' }
    }
    const taken = [...this.#organizations.values()].some(
      (one) =>
        one.id === organization.id ||
        (one.environmentId === organization.environmentId && one.slug === organization.slug)
    )
    if (taken) {
      return { outcome: 'slug_taken' }
    }
    this.#organizations.set(organization.id, structuredClone(organization))
    this.#memberships.set(membership.id, structuredClone(membership))
    this.#activityLog.record(recordedOf([activities.organization, activities.membership]))
    return {
      outcome: 'created',
      record: structuredClone({ organization, membership, permissions: input.permissions }),
    }
  }

  /** @inheritdoc */
  async listRoles(environmentId: string): Promise<OrganizationRoleRecord[]> {
    return [...this.#roles.values()]
      .filter((role) => role.environmentId === environmentId)
      .sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || (a.key < b.key ? -1 : 1))
      .map((role) => structuredClone(role))
  }

  /** @inheritdoc */
  async findRole(environmentId: string, key: string): Promise<OrganizationRoleRecord | null> {
    const found = [...this.#roles.values()].find(
      (role) => role.environmentId === environmentId && role.key === key
    )
    return found ? structuredClone(found) : null
  }

  /** @inheritdoc */
  async findRoleById(environmentId: string, id: string): Promise<OrganizationRoleRecord | null> {
    const found = this.#roles.get(id)
    return found && found.environmentId === environmentId ? structuredClone(found) : null
  }

  /** @inheritdoc */
  async insertRole(
    record: OrganizationRoleRecord,
    recorded: Recorded
  ): Promise<OrganizationRoleRecord | null> {
    const activity = activityOf(recorded)
    // The primary key and the key's unique key, as Postgres would decide them; and the check
    // that only a built-in role has a built-in key.
    const taken = [...this.#roles.values()].some(
      (one) =>
        one.id === record.id ||
        (one.environmentId === record.environmentId && one.key === record.key)
    )
    if (taken || (!record.builtIn && BUILT_IN_ROLES.some((role) => role.key === record.key))) {
      return null
    }
    this.#roles.set(record.id, structuredClone(record))
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(record)
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
    const role = this.#roles.get(id)
    if (!role || role.environmentId !== environmentId) {
      return { outcome: 'not_found' }
    }
    if (role.builtIn) {
      return { outcome: 'built_in' }
    }
    if (role.version !== expectedVersion) {
      return { outcome: 'stale', version: role.version }
    }
    const next: OrganizationRoleRecord = {
      ...role,
      name: changes.name ?? role.name,
      permissions: changes.permissions ? [...changes.permissions] : role.permissions,
      version: role.version + 1,
      updatedAt,
    }
    if (
      role.permissions.includes(MEMBERSHIPS_MANAGE_PERMISSION) &&
      !next.permissions.includes(MEMBERSHIPS_MANAGE_PERMISSION) &&
      this.#leavesWithoutManager(environmentId, id)
    ) {
      return { outcome: 'last_manager' }
    }
    this.#roles.set(id, next)
    this.#activityLog.record(activity ? [activity] : [])
    return { outcome: 'updated', record: structuredClone(next) }
  }

  /** @inheritdoc */
  async deleteRole(
    environmentId: string,
    id: string,
    expectedVersion: number | null,
    recorded: Recorded
  ): Promise<DeleteRoleOutcome> {
    const activity = activityOf(recorded)
    const role = this.#roles.get(id)
    if (!role || role.environmentId !== environmentId) {
      return { outcome: 'not_found' }
    }
    if (role.builtIn) {
      return { outcome: 'built_in' }
    }
    if (expectedVersion !== null && role.version !== expectedVersion) {
      return { outcome: 'stale', version: role.version }
    }
    // A membership refers to its role without a cascade, as the foreign key says.
    if ([...this.#memberships.values()].some((one) => one.roleId === id)) {
      return { outcome: 'in_use' }
    }
    this.#roles.delete(id)
    this.#activityLog.record(activity ? [activity] : [])
    return { outcome: 'deleted', record: structuredClone(role) }
  }

  /**
   * Whether some organization has members who hold this role and no member whose role is
   * another that can manage members: taking the permission away from the role would leave it
   * with no manager.
   */
  #leavesWithoutManager(environmentId: string, roleId: string): boolean {
    const members = [...this.#memberships.values()].filter(
      (one) => one.environmentId === environmentId
    )
    return members
      .filter((one) => one.roleId === roleId)
      .some(
        (held) =>
          !members.some(
            (other) =>
              other.organizationId === held.organizationId &&
              other.roleId !== roleId &&
              this.#manages(other)
          )
      )
  }

  /** The invitation, when it is this environment's. */
  #invitation(environmentId: string, id: string): InvitationRecord | null {
    const found = this.#invitations.get(id)
    return found && found.environmentId === environmentId ? found : null
  }

  /**
   * Move a pending, unexpired invitation to a final state, as the database's conditional
   * `UPDATE` does. No await between the check and the write.
   */
  #resolve(
    invitation: InvitationRecord | null,
    status: 'accepted' | 'declined' | 'revoked',
    resolvedBy: string | null,
    now: Date
  ): ResolveInvitationOutcome {
    if (!invitation) {
      return { outcome: 'not_found' }
    }
    if (invitation.status !== 'pending' || invitation.expiresAt.getTime() <= now.getTime()) {
      return { outcome: 'unavailable', record: structuredClone(invitation) }
    }
    invitation.status = status
    invitation.resolvedAt = now
    invitation.resolvedBy = resolvedBy
    invitation.updatedAt = now
    return { outcome: 'done', record: structuredClone(invitation) }
  }

  /** @inheritdoc */
  async insertInvitation(
    record: InvitationRecord,
    now: Date,
    recorded: Recorded
  ): Promise<InsertInvitationOutcome> {
    const activity = activityOf(recorded)
    if (this.#own(record.environmentId, record.organizationId) === null) {
      return { outcome: 'gone' }
    }
    const holders = [...this.#invitations.values()].filter(
      (one) =>
        one.environmentId === record.environmentId &&
        one.organizationId === record.organizationId &&
        one.emailNormalized === record.emailNormalized &&
        one.status === 'pending'
    )
    // An expired pending invitation is replaced; one that is still open holds the key.
    if (holders.some((one) => one.expiresAt.getTime() > now.getTime())) {
      return { outcome: 'exists' }
    }
    if (
      this.#invitations.has(record.id) ||
      [...this.#invitations.values()].some((one) => one.tokenHash === record.tokenHash)
    ) {
      return { outcome: 'exists' }
    }
    for (const one of holders) {
      this.#invitations.delete(one.id)
    }
    this.#invitations.set(record.id, structuredClone(record))
    this.#activityLog.record(activity ? [activity] : [])
    return { outcome: 'created', record: structuredClone(record) }
  }

  /** @inheritdoc */
  async listInvitations(
    environmentId: string,
    organizationId: string,
    status: InvitationStatus,
    now: Date,
    page: PageCriteria
  ): Promise<Page<InvitationRecord>> {
    const open = (one: InvitationRecord) => one.expiresAt.getTime() > now.getTime()
    const rows = [...this.#invitations.values()]
      .filter((one) => one.environmentId === environmentId && one.organizationId === organizationId)
      .filter((one) => {
        if (status === 'pending') {
          return one.status === 'pending' && open(one)
        }
        if (status === 'expired') {
          return one.status === 'pending' && !open(one)
        }
        return one.status === status
      })
      // Newest first; the id breaks ties between invitations of the same instant.
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
    return paged(rows, page)
  }

  /** @inheritdoc */
  async findInvitation(
    environmentId: string,
    organizationId: string,
    id: string
  ): Promise<InvitationRecord | null> {
    const found = this.#invitation(environmentId, id)
    return found && found.organizationId === organizationId ? structuredClone(found) : null
  }

  /** @inheritdoc */
  async findInvitationByTokenHash(
    environmentId: string,
    tokenHash: string
  ): Promise<InvitationRecord | null> {
    const found = [...this.#invitations.values()].find(
      (one) => one.environmentId === environmentId && one.tokenHash === tokenHash
    )
    return found ? structuredClone(found) : null
  }

  /** @inheritdoc */
  async revokeInvitation(
    environmentId: string,
    organizationId: string,
    id: string,
    now: Date,
    recorded: Recorded
  ): Promise<ResolveInvitationOutcome> {
    const activity = activityOf(recorded)
    const found = this.#invitation(environmentId, id)
    const result = this.#resolve(
      found && found.organizationId === organizationId ? found : null,
      'revoked',
      null,
      now
    )
    if (result.outcome === 'done') {
      this.#activityLog.record(activity ? [activity] : [])
    }
    return result
  }

  /** @inheritdoc */
  async declineInvitation(
    environmentId: string,
    id: string,
    userId: string,
    now: Date,
    recorded: Recorded
  ): Promise<ResolveInvitationOutcome> {
    const activity = activityOf(recorded)
    const result = this.#resolve(this.#invitation(environmentId, id), 'declined', userId, now)
    if (result.outcome === 'done') {
      this.#activityLog.record(activity ? [activity] : [])
    }
    return result
  }

  /** @inheritdoc */
  async acceptInvitation(
    environmentId: string,
    id: string,
    membership: MembershipRecord,
    now: Date,
    activities: { invitation: Recorded; membership: Recorded }
  ): Promise<AcceptInvitationOutcome> {
    const invitation = this.#invitation(environmentId, id)
    if (!invitation) {
      return { outcome: 'not_found' }
    }
    if (invitation.status !== 'pending' || invitation.expiresAt.getTime() <= now.getTime()) {
      return { outcome: 'unavailable', record: structuredClone(invitation) }
    }
    // The checks the foreign keys and the unique key make, before anything is written.
    if (
      this.#own(environmentId, membership.organizationId) === null ||
      this.#roles.get(membership.roleId)?.environmentId !== environmentId
    ) {
      return { outcome: 'gone' }
    }
    if (this.#users && (await this.#users.findById(environmentId, membership.userId)) === null) {
      return { outcome: 'gone' }
    }
    // The await above is the last: the checks and the writes below are one turn of the loop.
    if (this.#invitation(environmentId, id)?.status !== 'pending') {
      return { outcome: 'unavailable', record: structuredClone(invitation) }
    }
    if (this.#membership(environmentId, membership.organizationId, membership.userId)) {
      return { outcome: 'duplicate' }
    }
    this.#resolve(invitation, 'accepted', membership.userId, now)
    this.#memberships.set(membership.id, structuredClone(membership))
    this.#activityLog.record(recordedOf([activities.invitation, activities.membership]))
    return {
      outcome: 'accepted',
      record: structuredClone(invitation),
      membership: structuredClone(membership),
    }
  }

  /** @inheritdoc */
  async deleteExpiredInvitations(
    environmentId: string,
    before: Date,
    limit: number
  ): Promise<number> {
    const due = [...this.#invitations.values()]
      .filter(
        (one) => one.environmentId === environmentId && one.expiresAt.getTime() <= before.getTime()
      )
      .slice(0, limit)
    for (const one of due) {
      this.#invitations.delete(one.id)
    }
    return due.length
  }

  /** @inheritdoc */
  async ensureBuiltInRoles(roles: readonly OrganizationRoleRecord[]): Promise<void> {
    for (const role of roles) {
      const exists = [...this.#roles.values()].some(
        (one) => one.environmentId === role.environmentId && one.key === role.key
      )
      if (!exists) {
        this.#roles.set(role.id, structuredClone(role))
      }
    }
  }
}
