import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  ScimGroupRecord,
  ScimGroupRefusal,
  ScimStore,
  ScimTokenRecord,
  ScimUserRecord,
  ScimUserRefusal,
} from '~/ports/scim-store'

/** In-memory SCIM tokens and directory users for tests. */
export class MemoryScimStore implements ScimStore {
  readonly #tokens: Map<string, ScimTokenRecord>
  readonly #users: ScimUserRecord[]
  readonly #groups: ScimGroupRecord[]
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#tokens = new Map()
    this.#users = []
    this.#groups = []
    this.#activityLog = activityLog
  }

  #user(environmentId: string, organizationId: string, userId: string): ScimUserRecord | undefined {
    return this.#users.find(
      (one) =>
        one.environmentId === environmentId &&
        one.organizationId === organizationId &&
        one.userId === userId
    )
  }

  #record(recorded: Recorded): void {
    const activity = activityOf(recorded)
    this.#activityLog.record(activity ? [activity] : [])
  }

  /** @inheritdoc */
  async insertToken(record: ScimTokenRecord, recorded: Recorded): Promise<void> {
    this.#tokens.set(record.id, structuredClone(record))
    this.#record(recorded)
  }

  /** @inheritdoc */
  async listTokens(environmentId: string, organizationId: string): Promise<ScimTokenRecord[]> {
    return [...this.#tokens.values()]
      .filter((one) => one.environmentId === environmentId && one.organizationId === organizationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .map((one) => structuredClone(one))
  }

  /** @inheritdoc */
  async findTokenByHash(environmentId: string, tokenHash: string): Promise<ScimTokenRecord | null> {
    const found = [...this.#tokens.values()].find(
      (one) => one.environmentId === environmentId && one.tokenHash === tokenHash
    )
    return found ? structuredClone(found) : null
  }

  /** @inheritdoc */
  async revokeToken(
    environmentId: string,
    organizationId: string,
    id: string,
    at: Date,
    recorded: Recorded
  ): Promise<ScimTokenRecord | null> {
    const token = this.#tokens.get(id)
    if (
      !token ||
      token.environmentId !== environmentId ||
      token.organizationId !== organizationId ||
      token.revokedAt !== null
    ) {
      return null
    }
    token.revokedAt = at
    token.updatedAt = at
    this.#record(recorded)
    return structuredClone(token)
  }

  /** @inheritdoc */
  async touchToken(environmentId: string, id: string, at: Date): Promise<void> {
    const token = this.#tokens.get(id)
    if (token && token.environmentId === environmentId) {
      token.lastUsedAt = at
    }
  }

  /** @inheritdoc */
  async findUser(
    environmentId: string,
    organizationId: string,
    userId: string
  ): Promise<ScimUserRecord | null> {
    const found = this.#user(environmentId, organizationId, userId)
    return found ? structuredClone(found) : null
  }

  /** @inheritdoc */
  async findUserByExternalId(
    environmentId: string,
    organizationId: string,
    externalId: string
  ): Promise<ScimUserRecord | null> {
    const found = this.#users.find(
      (one) =>
        one.environmentId === environmentId &&
        one.organizationId === organizationId &&
        one.externalId === externalId
    )
    return found ? structuredClone(found) : null
  }

  /** @inheritdoc */
  async listUsers(
    environmentId: string,
    organizationId: string,
    offset: number,
    limit: number
  ): Promise<{ records: ScimUserRecord[]; total: number }> {
    const all = this.#users
      .filter((one) => one.environmentId === environmentId && one.organizationId === organizationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
    return {
      records: all.slice(offset, offset + limit).map((one) => structuredClone(one)),
      total: all.length,
    }
  }

  /** @inheritdoc */
  async insertUser(record: ScimUserRecord, recorded: Recorded): Promise<ScimUserRefusal | null> {
    if (this.#user(record.environmentId, record.organizationId, record.userId)) {
      return 'exists'
    }
    if (
      record.externalId !== null &&
      (await this.findUserByExternalId(
        record.environmentId,
        record.organizationId,
        record.externalId
      ))
    ) {
      return 'external_id_taken'
    }
    this.#users.push(structuredClone(record))
    this.#record(recorded)
    return null
  }

  /** @inheritdoc */
  async updateUser(
    environmentId: string,
    organizationId: string,
    userId: string,
    changes: { externalId?: string | null; active?: boolean },
    at: Date
  ): Promise<ScimUserRefusal | null> {
    const found = this.#user(environmentId, organizationId, userId)
    if (!found) {
      return 'missing'
    }
    if (changes.externalId != null) {
      const other = await this.findUserByExternalId(
        environmentId,
        organizationId,
        changes.externalId
      )
      if (other && other.userId !== userId) {
        return 'external_id_taken'
      }
    }
    if (changes.externalId !== undefined) {
      found.externalId = changes.externalId
    }
    if (changes.active !== undefined) {
      found.active = changes.active
    }
    found.updatedAt = at
    return null
  }

  /** @inheritdoc */
  async deleteUser(environmentId: string, organizationId: string, userId: string): Promise<void> {
    const index = this.#users.findIndex(
      (one) =>
        one.environmentId === environmentId &&
        one.organizationId === organizationId &&
        one.userId === userId
    )
    if (index >= 0) {
      this.#users.splice(index, 1)
    }
    for (const group of this.#groups) {
      if (group.environmentId === environmentId && group.organizationId === organizationId) {
        group.memberIds = group.memberIds.filter((id) => id !== userId)
      }
    }
  }

  #group(environmentId: string, organizationId: string, id: string) {
    return this.#groups.find(
      (one) =>
        one.environmentId === environmentId &&
        one.organizationId === organizationId &&
        one.id === id
    )
  }

  #nameTaken(environmentId: string, organizationId: string, name: string, except?: string) {
    return this.#groups.some(
      (one) =>
        one.environmentId === environmentId &&
        one.organizationId === organizationId &&
        one.displayName === name &&
        one.id !== except
    )
  }

  /** @inheritdoc */
  async insertGroup(record: ScimGroupRecord, recorded: Recorded): Promise<ScimGroupRefusal | null> {
    if (this.#nameTaken(record.environmentId, record.organizationId, record.displayName)) {
      return 'name_taken'
    }
    this.#groups.push(structuredClone({ ...record, memberIds: [...new Set(record.memberIds)] }))
    this.#record(recorded)
    return null
  }

  /** @inheritdoc */
  async findGroup(environmentId: string, organizationId: string, id: string) {
    const found = this.#group(environmentId, organizationId, id)
    return found ? structuredClone(found) : null
  }

  /** @inheritdoc */
  async findGroupByName(environmentId: string, organizationId: string, displayName: string) {
    const found = this.#groups.find(
      (one) =>
        one.environmentId === environmentId &&
        one.organizationId === organizationId &&
        one.displayName === displayName
    )
    return found ? structuredClone(found) : null
  }

  /** @inheritdoc */
  async listGroups(environmentId: string, organizationId: string, offset: number, limit: number) {
    const all = this.#groups
      .filter((one) => one.environmentId === environmentId && one.organizationId === organizationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
    return {
      records: all.slice(offset, offset + limit).map((one) => structuredClone(one)),
      total: all.length,
    }
  }

  /** @inheritdoc */
  async replaceGroup(
    environmentId: string,
    organizationId: string,
    id: string,
    next: { displayName: string; externalId: string | null; memberIds: string[] },
    at: Date,
    recorded: Recorded
  ): Promise<ScimGroupRefusal | null> {
    const found = this.#group(environmentId, organizationId, id)
    if (!found) {
      return 'missing'
    }
    if (this.#nameTaken(environmentId, organizationId, next.displayName, id)) {
      return 'name_taken'
    }
    found.displayName = next.displayName
    found.externalId = next.externalId
    found.memberIds = [...new Set(next.memberIds)]
    found.updatedAt = at
    this.#record(recorded)
    return null
  }

  /** @inheritdoc */
  async deleteGroup(environmentId: string, organizationId: string, id: string, recorded: Recorded) {
    const index = this.#groups.findIndex(
      (one) =>
        one.environmentId === environmentId &&
        one.organizationId === organizationId &&
        one.id === id
    )
    if (index < 0) {
      return false
    }
    this.#groups.splice(index, 1)
    this.#record(recorded)
    return true
  }

  /** @inheritdoc */
  async groupNamesOfUser(environmentId: string, organizationId: string, userId: string) {
    return this.#groups
      .filter(
        (one) =>
          one.environmentId === environmentId &&
          one.organizationId === organizationId &&
          one.memberIds.includes(userId)
      )
      .map((one) => one.displayName)
  }
}
