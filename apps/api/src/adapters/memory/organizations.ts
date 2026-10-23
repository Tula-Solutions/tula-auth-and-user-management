import { MEMBERSHIPS_MANAGE_PERMISSION } from '@tula-tech/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import type { MemoryUserRepository } from '~/adapters/memory/users'
import { activityOf, type Recorded, recordedOf } from '~/ports/activity-log'
import type {
  AddMembershipOutcome,
  ChangeMembershipOutcome,
  CreateOwnedOutcome,
  MembershipRecord,
  OrganizationChanges,
  OrganizationRecord,
  OrganizationRoleRecord,
  OrganizationStore,
  OwnedOrganization,
  Page,
  PageCriteria,
  UpdateOrganizationOutcome,
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
    // The memberships go with their organization, as the foreign key cascades.
    for (const [key, membership] of this.#memberships) {
      if (membership.organizationId === id) {
        this.#memberships.delete(key)
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
