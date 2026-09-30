import type { EnvironmentRecord, EnvironmentRepository } from '~/ports/environment-repository'

const KIND_ORDER = { development: 0, production: 1 } as const

/** In-memory environments. Tests seed them with {@link MemoryEnvironmentRepository.add}. */
export class MemoryEnvironmentRepository implements EnvironmentRepository {
  readonly #environments: EnvironmentRecord[]

  // Constructor assignment for Bun coverage; see MemoryApiKeyRepository.
  constructor() {
    this.#environments = []
  }

  /** @param environment - The environment to store. */
  add(environment: EnvironmentRecord): void {
    this.#environments.push({ ...environment })
  }

  /** @inheritdoc */
  async findById(id: string): Promise<EnvironmentRecord | null> {
    const found = this.#environments.find((environment) => environment.id === id)
    return found ? { ...found } : null
  }

  /** @inheritdoc */
  async listAll(): Promise<EnvironmentRecord[]> {
    return this.#environments.map((environment) => ({ ...environment }))
  }

  /** @inheritdoc */
  async listByProject(projectId: string): Promise<EnvironmentRecord[]> {
    return this.#environments
      .filter((environment) => environment.projectId === projectId)
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
      .map((environment) => ({ ...environment }))
  }
}
