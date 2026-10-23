import { MEMBERSHIPS_MANAGE_PERMISSION } from '@tula-tech/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  AddMembershipOutcome,
  ChangeMembershipOutcome,
  MembershipRecord,
  OrganizationChanges,
  OrganizationRecord,
  OrganizationRoleRecord,
  OrganizationStore,
  Page,
  PageCriteria,
  UpdateOrganizationOutcome,
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

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#organizations = new Map()
    this.#roles = new Map()
    this.#memberships = new Map()
    this.#activityLog = activityLog
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
