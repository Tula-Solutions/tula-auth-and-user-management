import { type Database, environments } from '@tula/db'
import { asc, eq } from 'drizzle-orm'
import type { EnvironmentRecord, EnvironmentRepository } from '~/ports/environment-repository'

const columns = {
  id: environments.id,
  projectId: environments.projectId,
  kind: environments.kind,
  createdAt: environments.createdAt,
}

/** Environments in `tula.environments` (control plane, no RLS). */
export class PostgresEnvironmentRepository implements EnvironmentRepository {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async findById(id: string): Promise<EnvironmentRecord | null> {
    const [row] = await this.db
      .select(columns)
      .from(environments)
      .where(eq(environments.id, id))
      .limit(1)
    return row ?? null
  }

  /** @inheritdoc */
  async listByProject(projectId: string): Promise<EnvironmentRecord[]> {
    // 'development' < 'production' alphabetically, matching the dashboard's order.
    return this.db
      .select(columns)
      .from(environments)
      .where(eq(environments.projectId, projectId))
      .orderBy(asc(environments.kind))
  }
}
