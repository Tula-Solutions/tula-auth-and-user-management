import type { MemoryEnvironmentRepository } from '~/adapters/memory/environments'
import type {
  ControlPlane,
  InstanceActivity,
  InstanceAuditCriteria,
  InstanceAuditEntry,
  Paged,
  PageRequest,
  ProjectRecord,
  WorkspaceRecord,
} from '~/ports/control-plane'
import type { EnvironmentRecord } from '~/ports/environment-repository'

const KIND_ORDER = { development: 0, production: 1 } as const

function pageOf<T>(rows: readonly T[], page: PageRequest): Paged<T> {
  const start = (page.page - 1) * page.size
  return {
    items: rows.slice(start, start + page.size).map((row) => structuredClone(row)),
    totalCount: rows.length,
  }
}

function byCreation<T extends { createdAt: Date; id: string }>(a: T, b: T): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * In-memory control plane. Environments live in the {@link MemoryEnvironmentRepository} the
 * rest of the test deps read, so an environment created here resolves everywhere.
 */
export class MemoryControlPlane implements ControlPlane {
  readonly workspaces: WorkspaceRecord[]
  readonly projects: ProjectRecord[]
  /** Everything recorded, oldest first. Tests read it. */
  entries: InstanceActivity[]
  readonly #environments: MemoryEnvironmentRepository

  /** @param environments - The environment repository of the same deps. */
  constructor(environments: MemoryEnvironmentRepository) {
    // Assigned here rather than as field initializers; see MemoryActivityLog.
    this.workspaces = []
    this.projects = []
    this.entries = []
    this.#environments = environments
  }

  /**
   * @param type - An instance activity type.
   * @returns The entries of that type, oldest first.
   */
  ofType(type: InstanceActivity['type']): InstanceActivity[] {
    return this.entries.filter((entry) => entry.type === type)
  }

  /** @inheritdoc */
  async listWorkspaces(page: PageRequest): Promise<Paged<WorkspaceRecord>> {
    return pageOf([...this.workspaces].sort(byCreation), page)
  }

  /** @inheritdoc */
  async findWorkspace(id: string): Promise<WorkspaceRecord | null> {
    const found = this.workspaces.find((workspace) => workspace.id === id)
    return found ? { ...found } : null
  }

  /** @inheritdoc */
  async createWorkspace(workspace: WorkspaceRecord, activity: InstanceActivity): Promise<void> {
    this.workspaces.push({ ...workspace })
    await this.record(activity)
  }

  /** @inheritdoc */
  async listProjects(
    criteria: PageRequest & { workspaceId?: string }
  ): Promise<Paged<ProjectRecord>> {
    return pageOf(
      this.projects
        .filter((project) => !criteria.workspaceId || project.workspaceId === criteria.workspaceId)
        .sort(byCreation),
      criteria
    )
  }

  /** @inheritdoc */
  async findProject(id: string): Promise<ProjectRecord | null> {
    const found = this.projects.find((project) => project.id === id)
    return found ? { ...found } : null
  }

  /** @inheritdoc */
  async createProject(
    project: ProjectRecord,
    environments: readonly EnvironmentRecord[],
    activities: readonly InstanceActivity[]
  ): Promise<void> {
    this.projects.push({ ...project })
    for (const environment of environments) {
      this.#environments.add(environment)
    }
    for (const activity of activities) {
      await this.record(activity)
    }
  }

  /** @inheritdoc */
  async renameProject(
    id: string,
    name: string,
    now: Date,
    activity: InstanceActivity
  ): Promise<ProjectRecord | null> {
    const found = this.projects.find((project) => project.id === id)
    if (!found) {
      return null
    }
    found.name = name
    found.updatedAt = now
    await this.record(activity)
    return { ...found }
  }

  /** @inheritdoc */
  async listEnvironments(
    criteria: PageRequest & { projectId?: string }
  ): Promise<Paged<EnvironmentRecord>> {
    const projectOrder = new Map(
      [...this.projects].sort(byCreation).map((project, index) => [project.id, index])
    )
    const rows = (await this.#environments.listAll())
      .filter((environment) => !criteria.projectId || environment.projectId === criteria.projectId)
      .sort(
        (a, b) =>
          (projectOrder.get(a.projectId) ?? 0) - (projectOrder.get(b.projectId) ?? 0) ||
          (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0) ||
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
      )
    return pageOf(rows, criteria)
  }

  /** @inheritdoc */
  async createEnvironment(
    environment: EnvironmentRecord,
    activity: InstanceActivity
  ): Promise<boolean> {
    const siblings = await this.#environments.listByProject(environment.projectId)
    if (siblings.some((sibling) => sibling.kind === environment.kind)) {
      return false
    }
    this.#environments.add(environment)
    await this.record(activity)
    return true
  }

  /** @inheritdoc */
  async record(activity: InstanceActivity): Promise<void> {
    this.entries.push(structuredClone(activity))
  }

  /** @inheritdoc */
  async deleteAuditBefore(before: Date, limit: number): Promise<number> {
    const doomed = new Set(
      this.entries
        .filter((entry) => entry.occurredAt.getTime() < before.getTime())
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((entry) => entry.id)
    )
    this.entries = this.entries.filter((entry) => !doomed.has(entry.id))
    return doomed.size
  }

  /** @inheritdoc */
  async listAudit(criteria: InstanceAuditCriteria): Promise<Paged<InstanceAuditEntry>> {
    const matches = this.entries
      .filter(
        (entry) =>
          (!criteria.action || entry.type === criteria.action) &&
          (!criteria.actorId || entry.actor.id === criteria.actorId) &&
          (!criteria.targetId || entry.target?.id === criteria.targetId) &&
          (!criteria.from || entry.occurredAt.getTime() >= criteria.from.getTime()) &&
          (!criteria.to || entry.occurredAt.getTime() < criteria.to.getTime())
      )
      .sort(
        (x, y) =>
          y.occurredAt.getTime() - x.occurredAt.getTime() ||
          (y.id > x.id ? 1 : y.id < x.id ? -1 : 0)
      )
    return pageOf(matches, criteria)
  }
}
