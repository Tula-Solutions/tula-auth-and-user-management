import {
  type Database,
  environments,
  instanceAuditLogs,
  projects,
  type Transaction,
  workspaces,
} from '@tula/db'
import { and, asc, count, desc, eq, gte, lt } from 'drizzle-orm'
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

const workspaceColumns = {
  id: workspaces.id,
  name: workspaces.name,
  createdAt: workspaces.createdAt,
}

const projectColumns = {
  id: projects.id,
  workspaceId: projects.workspaceId,
  name: projects.name,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
}

const environmentColumns = {
  id: environments.id,
  projectId: environments.projectId,
  kind: environments.kind,
  createdAt: environments.createdAt,
}

async function insertActivities(
  tx: Transaction | Database,
  activities: readonly InstanceActivity[]
): Promise<void> {
  if (activities.length === 0) {
    return
  }
  await tx.insert(instanceAuditLogs).values(
    activities.map((activity) => ({
      id: activity.id,
      actorType: activity.actor.type,
      actorId: activity.actor.id,
      action: activity.type,
      targetType: activity.target?.type ?? null,
      targetId: activity.target?.id ?? null,
      ipAddress: activity.ipAddress,
      userAgent: activity.userAgent,
      metadata: activity.data,
      occurredAt: activity.occurredAt,
    }))
  )
}

/**
 * The control plane in `tula.workspaces`, `tula.projects`, `tula.environments` and
 * `tula.instance_audit_logs` (no RLS: none of them is tenant data). Every write runs in one
 * transaction with its audit entry.
 */
export class PostgresControlPlane implements ControlPlane {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async listWorkspaces(page: PageRequest): Promise<Paged<WorkspaceRecord>> {
    const [total] = await this.db.select({ value: count() }).from(workspaces)
    const items = await this.db
      .select(workspaceColumns)
      .from(workspaces)
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(page.size)
      .offset((page.page - 1) * page.size)
    return { items, totalCount: total?.value ?? 0 }
  }

  /** @inheritdoc */
  async findWorkspace(id: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.db
      .select(workspaceColumns)
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1)
    return row ?? null
  }

  /** @inheritdoc */
  async createWorkspace(workspace: WorkspaceRecord, activity: InstanceActivity): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({ ...workspace, updatedAt: workspace.createdAt })
      await insertActivities(tx, [activity])
    })
  }

  /** @inheritdoc */
  async listProjects(
    criteria: PageRequest & { workspaceId?: string }
  ): Promise<Paged<ProjectRecord>> {
    const where = criteria.workspaceId ? eq(projects.workspaceId, criteria.workspaceId) : undefined
    const [total] = await this.db.select({ value: count() }).from(projects).where(where)
    const items = await this.db
      .select(projectColumns)
      .from(projects)
      .where(where)
      .orderBy(asc(projects.createdAt), asc(projects.id))
      .limit(criteria.size)
      .offset((criteria.page - 1) * criteria.size)
    return { items, totalCount: total?.value ?? 0 }
  }

  /** @inheritdoc */
  async findProject(id: string): Promise<ProjectRecord | null> {
    const [row] = await this.db
      .select(projectColumns)
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)
    return row ?? null
  }

  /** @inheritdoc */
  async createProject(
    project: ProjectRecord,
    created: readonly EnvironmentRecord[],
    activities: readonly InstanceActivity[]
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(projects).values(project)
      if (created.length > 0) {
        await tx
          .insert(environments)
          .values(
            created.map((environment) => ({ ...environment, updatedAt: environment.createdAt }))
          )
      }
      await insertActivities(tx, activities)
    })
  }

  /** @inheritdoc */
  async renameProject(
    id: string,
    name: string,
    now: Date,
    activity: InstanceActivity
  ): Promise<ProjectRecord | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(projects)
        .set({ name, updatedAt: now })
        .where(eq(projects.id, id))
        .returning(projectColumns)
      if (!row) {
        return null
      }
      await insertActivities(tx, [activity])
      return row
    })
  }

  /** @inheritdoc */
  async listEnvironments(
    criteria: PageRequest & { projectId?: string }
  ): Promise<Paged<EnvironmentRecord>> {
    const where = criteria.projectId ? eq(environments.projectId, criteria.projectId) : undefined
    const [total] = await this.db.select({ value: count() }).from(environments).where(where)
    const items = await this.db
      .select(environmentColumns)
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(where)
      // 'development' < 'production' alphabetically, matching the dashboard's order.
      .orderBy(asc(projects.createdAt), asc(projects.id), asc(environments.kind))
      .limit(criteria.size)
      .offset((criteria.page - 1) * criteria.size)
    return { items, totalCount: total?.value ?? 0 }
  }

  /** @inheritdoc */
  async createEnvironment(
    environment: EnvironmentRecord,
    activity: InstanceActivity
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // The unique (project, kind) constraint decides, so two concurrent creates cannot both
      // win; "do nothing" keeps the transaction usable for the audit entry.
      const inserted = await tx
        .insert(environments)
        .values({ ...environment, updatedAt: environment.createdAt })
        .onConflictDoNothing({ target: [environments.projectId, environments.kind] })
        .returning({ id: environments.id })
      if (inserted.length === 0) {
        return false
      }
      await insertActivities(tx, [activity])
      return true
    })
  }

  /** @inheritdoc */
  async record(activity: InstanceActivity): Promise<void> {
    await insertActivities(this.db, [activity])
  }

  /** @inheritdoc */
  async listAudit(criteria: InstanceAuditCriteria): Promise<Paged<InstanceAuditEntry>> {
    const where = and(
      criteria.action ? eq(instanceAuditLogs.action, criteria.action) : undefined,
      criteria.actorId ? eq(instanceAuditLogs.actorId, criteria.actorId) : undefined,
      criteria.targetId ? eq(instanceAuditLogs.targetId, criteria.targetId) : undefined,
      criteria.from ? gte(instanceAuditLogs.occurredAt, criteria.from) : undefined,
      criteria.to ? lt(instanceAuditLogs.occurredAt, criteria.to) : undefined
    )
    const [total] = await this.db.select({ value: count() }).from(instanceAuditLogs).where(where)
    const rows = await this.db
      .select()
      .from(instanceAuditLogs)
      .where(where)
      // The id breaks ties between entries of the same instant, so paging is stable.
      .orderBy(desc(instanceAuditLogs.occurredAt), desc(instanceAuditLogs.id))
      .limit(criteria.size)
      .offset((criteria.page - 1) * criteria.size)
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.action,
        actor: { type: row.actorType, id: row.actorId },
        target:
          row.targetType !== null && row.targetId !== null
            ? { type: row.targetType, id: row.targetId }
            : null,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        data: row.metadata,
        occurredAt: row.occurredAt,
      })),
      totalCount: total?.value ?? 0,
    }
  }
}
