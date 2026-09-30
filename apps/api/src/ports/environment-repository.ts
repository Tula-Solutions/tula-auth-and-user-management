/** Environment kinds shown in the dashboard's Development / Production switch. */
export type EnvironmentKind = 'development' | 'production'

/** An environment: an isolated copy of a project's users and config (the tenant boundary). */
export interface EnvironmentRecord {
  id: string
  projectId: string
  kind: EnvironmentKind
  createdAt: Date
}

/** Read access to environments (control plane). */
export interface EnvironmentRepository {
  /**
   * @param id - Environment id.
   * @returns The environment, or `null`.
   */
  findById(id: string): Promise<EnvironmentRecord | null>

  /**
   * Every environment, for boot-time maintenance such as signing-key bootstrap.
   *
   * @returns All environments, oldest first.
   */
  listAll(): Promise<EnvironmentRecord[]>

  /**
   * @param projectId - Project id.
   * @returns The project's environments, development first.
   */
  listByProject(projectId: string): Promise<EnvironmentRecord[]>
}
