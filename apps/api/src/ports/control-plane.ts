import type { AuditActorType, InstanceActivityType, InstanceAuditTargetType } from '@tula/contract'
import type { EnvironmentRecord } from '~/ports/environment-repository'

/** A workspace: the team that owns projects. */
export interface WorkspaceRecord {
  id: string
  name: string
  createdAt: Date
}

/** A project: one app a workspace secures. */
export interface ProjectRecord {
  id: string
  workspaceId: string
  name: string
  createdAt: Date
  updatedAt: Date
}

/**
 * Something the deployment's operator did outside any one environment, recorded in the
 * instance audit log in the same transaction as the change it describes. Never holds a token,
 * a key or an email address.
 */
export interface InstanceActivity {
  id: string
  type: InstanceActivityType
  actor: { type: AuditActorType; id: string | null }
  target: { type: InstanceAuditTargetType; id: string } | null
  ipAddress: string | null
  userAgent: string | null
  data: Record<string, unknown>
  occurredAt: Date
}

/** An instance audit entry as read back: its `type` may be one a newer server recorded. */
export interface InstanceAuditEntry extends Omit<InstanceActivity, 'type' | 'target'> {
  type: string
  target: { type: string; id: string } | null
}

/** One page of a list: 1-based page number and its size. */
export interface PageRequest {
  page: number
  size: number
}

/** One page of rows and how many rows match in all. */
export interface Paged<T> {
  items: T[]
  totalCount: number
}

/** Filters of the instance audit list. Entries come newest first. */
export interface InstanceAuditCriteria extends PageRequest {
  action?: InstanceActivityType
  actorId?: string
  targetId?: string
  /** Entries at or after this instant. */
  from?: Date
  /** Entries before this instant. */
  to?: Date
}

/**
 * Workspaces, projects and environments as the deployment's operator manages them, and the
 * instance audit log (ADR 0032). Control plane: nothing here is one tenant's data.
 *
 * Every write takes the {@link InstanceActivity} that records it and stores both or neither.
 */
export interface ControlPlane {
  /**
   * @param page - Which page.
   * @returns Workspaces, oldest first.
   */
  listWorkspaces(page: PageRequest): Promise<Paged<WorkspaceRecord>>

  /**
   * @param id - Workspace id.
   * @returns The workspace, or `null`.
   */
  findWorkspace(id: string): Promise<WorkspaceRecord | null>

  /**
   * @param workspace - The workspace to store.
   * @param activity - The audit entry for it.
   */
  createWorkspace(workspace: WorkspaceRecord, activity: InstanceActivity): Promise<void>

  /**
   * @param criteria - Page, and optionally the workspace to list.
   * @returns Projects, oldest first.
   */
  listProjects(criteria: PageRequest & { workspaceId?: string }): Promise<Paged<ProjectRecord>>

  /**
   * @param id - Project id.
   * @returns The project, or `null`.
   */
  findProject(id: string): Promise<ProjectRecord | null>

  /**
   * Store a project together with its first environments.
   *
   * @param project - The project.
   * @param environments - Its environments (at most one of each kind).
   * @param activities - The audit entries: the project's and one per environment.
   */
  createProject(
    project: ProjectRecord,
    environments: readonly EnvironmentRecord[],
    activities: readonly InstanceActivity[]
  ): Promise<void>

  /**
   * @param id - Project id.
   * @param name - The new name.
   * @param now - When.
   * @param activity - The audit entry for it.
   * @returns The renamed project, or `null` when there is none (nothing is recorded then).
   */
  renameProject(
    id: string,
    name: string,
    now: Date,
    activity: InstanceActivity
  ): Promise<ProjectRecord | null>

  /**
   * @param criteria - Page, and optionally the project to list.
   * @returns Environments, oldest project first and development before production.
   */
  listEnvironments(
    criteria: PageRequest & { projectId?: string }
  ): Promise<Paged<EnvironmentRecord>>

  /**
   * Add an environment to a project that exists.
   *
   * @param environment - The environment.
   * @param activity - The audit entry for it.
   * @returns `false` when the project already has an environment of that kind (nothing is
   *   stored or recorded then).
   */
  createEnvironment(environment: EnvironmentRecord, activity: InstanceActivity): Promise<boolean>

  /**
   * Record something that changed no row: a dashboard sign-in, a failed one, a sign-out.
   *
   * @param activity - The entry.
   */
  record(activity: InstanceActivity): Promise<void>

  /**
   * @param criteria - Filters and page.
   * @returns Instance audit entries, newest first.
   */
  listAudit(criteria: InstanceAuditCriteria): Promise<Paged<InstanceAuditEntry>>

  /**
   * Delete instance audit entries that are past the deployment's retention period, one batch
   * at a time, oldest first (the retention job, ADR 0017). The only way an entry is ever
   * removed.
   *
   * @param before - Entries that occurred before this instant are deleted.
   * @param limit - The most entries one call deletes.
   * @returns How many were deleted.
   */
  deleteAuditBefore(before: Date, limit: number): Promise<number>
}
