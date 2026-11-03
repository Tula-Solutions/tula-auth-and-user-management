import type { Recorded } from '~/ports/activity-log'

/** A SCIM token of an organization's directory, as stored (ADR 0067, "SCIM"). */
export interface ScimTokenRecord {
  id: string
  projectId: string
  environmentId: string
  organizationId: string
  name: string
  /** The first characters of the token, for the list: never enough to use it. */
  prefix: string
  /** SHA-256 of the token. */
  tokenHash: string
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** A user a directory provisioned or was linked to, as stored. */
export interface ScimUserRecord {
  id: string
  projectId: string
  environmentId: string
  organizationId: string
  userId: string
  externalId: string | null
  /** What the directory last said; a deactivated user has no membership. */
  active: boolean
  createdAt: Date
  updatedAt: Date
}

/** A group the directory pushed, with the users in it. */
export interface ScimGroupRecord {
  id: string
  projectId: string
  environmentId: string
  organizationId: string
  /** Directory data: never in an audit entry, an event or a log line. */
  displayName: string
  externalId: string | null
  /** Ids of users the directory manages in this organization. */
  memberIds: string[]
  createdAt: Date
  updatedAt: Date
}

/** Why a write to a group stored nothing. */
export type ScimGroupRefusal = 'name_taken' | 'missing'

/** A group the directory pushed, with the users in it. */
export interface ScimGroupRecord {
  id: string
  projectId: string
  environmentId: string
  organizationId: string
  /** Directory data: never in an audit entry, an event or a log line. */
  displayName: string
  externalId: string | null
  /** Ids of users the directory manages in this organization. */
  memberIds: string[]
  createdAt: Date
  updatedAt: Date
}

/** Why a write to a directory user stored nothing. */
export type ScimUserRefusal = 'external_id_taken' | 'exists' | 'missing'

/** Storage of SCIM tokens and of the users a directory manages. */
export interface ScimStore {
  /**
   * @param record - The token, hash only.
   * @param recorded - The audit entry written in the same transaction (`scim_token.created`).
   */
  insertToken(record: ScimTokenRecord, recorded: Recorded): Promise<void>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @returns Its tokens, revoked ones included, newest first.
   */
  listTokens(environmentId: string, organizationId: string): Promise<ScimTokenRecord[]>

  /**
   * @param environmentId - The environment the presented token names.
   * @param tokenHash - SHA-256 of the presented token.
   * @returns The token, or `null` (also for another environment's).
   */
  findTokenByHash(environmentId: string, tokenHash: string): Promise<ScimTokenRecord | null>

  /**
   * Revoke a token that is not revoked yet.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization the token must belong to.
   * @param id - The token.
   * @param at - Revocation time.
   * @param recorded - Written only when this call revoked (`scim_token.revoked`).
   * @returns The token as revoked, or `null` when it is missing or was revoked already.
   */
  revokeToken(
    environmentId: string,
    organizationId: string,
    id: string,
    at: Date,
    recorded: Recorded
  ): Promise<ScimTokenRecord | null>

  /**
   * @param environmentId - The environment.
   * @param id - The token.
   * @param at - Use time.
   */
  touchToken(environmentId: string, id: string, at: Date): Promise<void>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param userId - The user.
   * @returns The directory's record of the user, or `null`.
   */
  findUser(
    environmentId: string,
    organizationId: string,
    userId: string
  ): Promise<ScimUserRecord | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param externalId - The directory's own id of the user.
   * @returns The directory's record of the user, or `null`.
   */
  findUserByExternalId(
    environmentId: string,
    organizationId: string,
    externalId: string
  ): Promise<ScimUserRecord | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param offset - Rows to skip.
   * @param limit - Most rows to return.
   * @returns A page of the directory's users, oldest first, and how many there are.
   */
  listUsers(
    environmentId: string,
    organizationId: string,
    offset: number,
    limit: number
  ): Promise<{ records: ScimUserRecord[]; total: number }>

  /**
   * @param record - The directory's record of a user.
   * @param recorded - Written with it (`user.scim_provisioned`).
   * @returns `null` when stored, else the refusal: `exists` (the user has a record) or
   *   `external_id_taken`.
   */
  insertUser(record: ScimUserRecord, recorded: Recorded): Promise<ScimUserRefusal | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param userId - The user.
   * @param changes - What to change; a field left out keeps its value.
   * @param at - Update time.
   * @returns `null` when stored, else `missing` or `external_id_taken`.
   */
  updateUser(
    environmentId: string,
    organizationId: string,
    userId: string,
    changes: { externalId?: string | null; active?: boolean },
    at: Date
  ): Promise<ScimUserRefusal | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param userId - The user.
   */
  deleteUser(environmentId: string, organizationId: string, userId: string): Promise<void>

  /**
   * Store a group and its members in one write.
   *
   * @param record - The group.
   * @param recorded - Written with it (`scim_group.created`).
   * @returns `null` when stored, or `name_taken`.
   */
  insertGroup(record: ScimGroupRecord, recorded: Recorded): Promise<ScimGroupRefusal | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The group.
   * @returns The group with its members, or `null`.
   */
  findGroup(
    environmentId: string,
    organizationId: string,
    id: string
  ): Promise<ScimGroupRecord | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param displayName - The exact name.
   * @returns The group with its members, or `null`.
   */
  findGroupByName(
    environmentId: string,
    organizationId: string,
    displayName: string
  ): Promise<ScimGroupRecord | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param offset - Rows to skip.
   * @param limit - Most rows to return.
   * @returns A page of groups with their members, oldest first, and how many there are.
   */
  listGroups(
    environmentId: string,
    organizationId: string,
    offset: number,
    limit: number
  ): Promise<{ records: ScimGroupRecord[]; total: number }>

  /**
   * Replace a group's name, external id and whole member list in one write.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The group.
   * @param next - The new state.
   * @param at - Update time.
   * @param recorded - Written with the change (`scim_group.updated`).
   * @returns `null` when stored, else `missing` or `name_taken`.
   */
  replaceGroup(
    environmentId: string,
    organizationId: string,
    id: string,
    next: { displayName: string; externalId: string | null; memberIds: string[] },
    at: Date,
    recorded: Recorded
  ): Promise<ScimGroupRefusal | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The group.
   * @param recorded - Written only when a group was removed (`scim_group.deleted`).
   * @returns Whether a group was removed.
   */
  deleteGroup(
    environmentId: string,
    organizationId: string,
    id: string,
    recorded: Recorded
  ): Promise<boolean>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param userId - The user.
   * @returns The names of the directory's groups the user is in.
   */
  groupNamesOfUser(environmentId: string, organizationId: string, userId: string): Promise<string[]>

  /**
   * Store a group and its members in one write.
   *
   * @param record - The group.
   * @param recorded - Written with it (`scim_group.created`).
   * @returns `null` when stored, or `name_taken`.
   */
  insertGroup(record: ScimGroupRecord, recorded: Recorded): Promise<ScimGroupRefusal | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The group.
   * @returns The group with its members, or `null`.
   */
  findGroup(
    environmentId: string,
    organizationId: string,
    id: string
  ): Promise<ScimGroupRecord | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param displayName - The exact name.
   * @returns The group with its members, or `null`.
   */
  findGroupByName(
    environmentId: string,
    organizationId: string,
    displayName: string
  ): Promise<ScimGroupRecord | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param offset - Rows to skip.
   * @param limit - Most rows to return.
   * @returns A page of groups with their members, oldest first, and how many there are.
   */
  listGroups(
    environmentId: string,
    organizationId: string,
    offset: number,
    limit: number
  ): Promise<{ records: ScimGroupRecord[]; total: number }>

  /**
   * Replace a group's name, external id and whole member list in one write.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The group.
   * @param next - The new state.
   * @param at - Update time.
   * @param recorded - Written with the change (`scim_group.updated`).
   * @returns `null` when stored, else `missing` or `name_taken`.
   */
  replaceGroup(
    environmentId: string,
    organizationId: string,
    id: string,
    next: { displayName: string; externalId: string | null; memberIds: string[] },
    at: Date,
    recorded: Recorded
  ): Promise<ScimGroupRefusal | null>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The group.
   * @param recorded - Written only when a group was removed (`scim_group.deleted`).
   * @returns Whether a group was removed.
   */
  deleteGroup(
    environmentId: string,
    organizationId: string,
    id: string,
    recorded: Recorded
  ): Promise<boolean>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param userId - The user.
   * @returns The names of the directory's groups the user is in.
   */
  groupNamesOfUser(environmentId: string, organizationId: string, userId: string): Promise<string[]>
}
