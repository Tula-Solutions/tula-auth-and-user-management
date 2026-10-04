import type {
  AuditLogList,
  InstanceActivityType,
  InstanceAuditTargetType,
  PaginationMeta,
} from '@tula/contract'
import type { Deps } from '~/dependencies'
import { ConflictError, NotFoundError } from '~/exceptions'
import { type Actor, cleanOrigin } from '~/lib/actor'
import type {
  EnvironmentListQuery,
  InstanceAuditLogQuery,
  PageQuery,
  Project,
  ProjectListQuery,
  Workspace,
} from '~/modules/control-plane/schema'
import * as Jwks from '~/modules/jwks/service'
import type { Environment } from '~/modules/project/schema'
import type { InstanceActivity, ProjectRecord, WorkspaceRecord } from '~/ports/control-plane'
import type { EnvironmentKind, EnvironmentRecord } from '~/ports/environment-repository'

/** The environments every new project gets: the dashboard's Development / Production switch. */
export const PROJECT_ENVIRONMENT_KINDS: readonly EnvironmentKind[] = ['development', 'production']

type WriteDeps = Pick<Deps, 'controlPlane' | 'ids' | 'clock'>
type KeyDeps = Pick<Deps, 'signingKeys' | 'environments' | 'secretBox'>

/** What an instance audit entry is made from. */
export interface InstanceEntryInput {
  type: InstanceActivityType
  actor: Actor
  target?: { type: InstanceAuditTargetType; id: string }
  /** Details of the action. Never a token, a key or an email address. */
  data?: Record<string, unknown>
}

/**
 * Build an instance audit entry.
 *
 * @param deps - Id generator and clock.
 * @param input - What happened, who did it and to what.
 * @returns The entry, to hand to the control plane together with the change it records.
 */
export function entry(
  deps: Pick<Deps, 'ids' | 'clock'>,
  input: InstanceEntryInput
): InstanceActivity {
  return {
    id: deps.ids.next(),
    type: input.type,
    actor: { type: input.actor.type, id: input.actor.id },
    target: input.target ?? null,
    ...cleanOrigin(input.actor),
    data: input.data ?? {},
    occurredAt: deps.clock.now(),
  }
}

/**
 * Record a dashboard sign-in, a failed one or a sign-out. The entry carries who and from
 * where, and nothing of what was presented.
 *
 * Awaited by its callers: a session is not handed out when its sign-in cannot be recorded.
 *
 * @param deps - Control plane, ids and clock.
 * @param type - Which of the three.
 * @param actor - The request's actor; its id is the session's, or `null` for a failure.
 */
export async function recordSession(
  deps: Pick<Deps, 'controlPlane' | 'ids' | 'clock'>,
  type: 'instance.signed_in' | 'instance.sign_in_failed' | 'instance.signed_out',
  actor: Actor
): Promise<void> {
  await deps.controlPlane.record(entry(deps, { type, actor }))
}

function meta(totalCount: number, query: PageQuery): PaginationMeta {
  return {
    totalCount,
    totalPages: Math.ceil(totalCount / query.size),
    page: query.page,
    perPage: query.size,
  }
}

function toWorkspace(record: WorkspaceRecord): Workspace {
  return { id: record.id, name: record.name, createdAt: record.createdAt.toISOString() }
}

function toProject(record: ProjectRecord): Project {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

/**
 * List the deployment's workspaces, oldest first.
 *
 * @param deps - Control plane.
 * @param query - Which page.
 * @returns One page.
 */
export async function listWorkspaces(
  deps: Pick<Deps, 'controlPlane'>,
  query: PageQuery
): Promise<{ meta: PaginationMeta; data: Workspace[] }> {
  const { items, totalCount } = await deps.controlPlane.listWorkspaces(query)
  return { meta: meta(totalCount, query), data: items.map(toWorkspace) }
}

/**
 * Create a workspace. A deployment that was never seeded has none, and a project needs one.
 *
 * The audit entry carries the id, not the name: a name is free text an operator typed.
 *
 * @param deps - Control plane, ids and clock.
 * @param input - The name.
 * @param actor - Who is creating it.
 * @returns The workspace.
 */
export async function createWorkspace(
  deps: WriteDeps,
  input: { name: string },
  actor: Actor
): Promise<Workspace> {
  const record: WorkspaceRecord = {
    id: deps.ids.next(),
    name: input.name,
    createdAt: deps.clock.now(),
  }
  await deps.controlPlane.createWorkspace(
    record,
    entry(deps, {
      type: 'workspace.created',
      actor,
      target: { type: 'workspace', id: record.id },
    })
  )
  return toWorkspace(record)
}

/**
 * List projects, oldest first.
 *
 * @param deps - Control plane.
 * @param query - Page, and optionally one workspace.
 * @returns One page.
 */
export async function listProjects(
  deps: Pick<Deps, 'controlPlane'>,
  query: ProjectListQuery
): Promise<{ meta: PaginationMeta; data: Project[] }> {
  const { items, totalCount } = await deps.controlPlane.listProjects(query)
  return { meta: meta(totalCount, query), data: items.map(toProject) }
}

function environmentEntry(
  deps: Pick<Deps, 'ids' | 'clock'>,
  environment: EnvironmentRecord,
  actor: Actor
): InstanceActivity {
  return entry(deps, {
    type: 'environment.created',
    actor,
    target: { type: 'environment', id: environment.id },
    data: { projectId: environment.projectId, kind: environment.kind },
  })
}

/**
 * Create a project with a development and a production environment, and each environment's
 * first signing keys, as the seed does.
 *
 * The rows and their audit entries are one transaction. The signing keys come after it: they
 * are the one unrecorded write (ADR 0012), and an environment without them gets them on first
 * use or at the next boot (`Jwks.ensureAllEnvironments`), so a failure here leaves nothing
 * broken.
 *
 * @param deps - Control plane, key stores, ids and clock.
 * @param input - The owning workspace and the name.
 * @param actor - Who is creating it.
 * @returns The project and its environments, development first.
 * @throws NotFoundError when the workspace does not exist.
 */
export async function createProject(
  deps: WriteDeps & KeyDeps,
  input: { workspaceId: string; name: string },
  actor: Actor
): Promise<{ project: Project; environments: Environment[] }> {
  if (!(await deps.controlPlane.findWorkspace(input.workspaceId))) {
    throw new NotFoundError({ message: 'That workspace does not exist.' })
  }
  const now = deps.clock.now()
  const project: ProjectRecord = {
    id: deps.ids.next(),
    workspaceId: input.workspaceId,
    name: input.name,
    createdAt: now,
    updatedAt: now,
  }
  const environments: EnvironmentRecord[] = PROJECT_ENVIRONMENT_KINDS.map((kind) => ({
    id: deps.ids.next(),
    projectId: project.id,
    kind,
    createdAt: now,
  }))
  await deps.controlPlane.createProject(project, environments, [
    entry(deps, {
      type: 'project.created',
      actor,
      target: { type: 'project', id: project.id },
      data: { workspaceId: project.workspaceId },
    }),
    ...environments.map((environment) => environmentEntry(deps, environment, actor)),
  ])
  for (const environment of environments) {
    await Jwks.ensureKeys(deps, environment.id)
  }
  return { project: toProject(project), environments }
}

/**
 * Rename a project.
 *
 * @param deps - Control plane, ids and clock.
 * @param projectId - The project.
 * @param input - The new name.
 * @param actor - Who is renaming it.
 * @returns The project.
 * @throws NotFoundError when the project does not exist.
 */
export async function renameProject(
  deps: WriteDeps,
  projectId: string,
  input: { name: string },
  actor: Actor
): Promise<Project> {
  const renamed = await deps.controlPlane.renameProject(
    projectId,
    input.name,
    deps.clock.now(),
    entry(deps, {
      type: 'project.renamed',
      actor,
      target: { type: 'project', id: projectId },
      // The key that changed, never its value.
      data: { changed: ['name'] },
    })
  )
  if (!renamed) {
    throw new NotFoundError({ message: 'That project does not exist.' })
  }
  return toProject(renamed)
}

/**
 * List environments: oldest project first, development before production.
 *
 * @param deps - Control plane.
 * @param query - Page, and optionally one project.
 * @returns One page.
 */
export async function listEnvironments(
  deps: Pick<Deps, 'controlPlane'>,
  query: EnvironmentListQuery
): Promise<{ meta: PaginationMeta; data: Environment[] }> {
  const { items, totalCount } = await deps.controlPlane.listEnvironments(query)
  return { meta: meta(totalCount, query), data: items }
}

/**
 * Add an environment to a project that lacks one of that kind, with its first signing keys.
 *
 * @param deps - Control plane, key stores, ids and clock.
 * @param projectId - The project.
 * @param input - The kind.
 * @param actor - Who is creating it.
 * @returns The environment.
 * @throws NotFoundError when the project does not exist.
 * @throws ConflictError when the project already has an environment of that kind.
 */
export async function createEnvironment(
  deps: WriteDeps & KeyDeps,
  projectId: string,
  input: { kind: EnvironmentKind },
  actor: Actor
): Promise<Environment> {
  if (!(await deps.controlPlane.findProject(projectId))) {
    throw new NotFoundError({ message: 'That project does not exist.' })
  }
  const environment: EnvironmentRecord = {
    id: deps.ids.next(),
    projectId,
    kind: input.kind,
    createdAt: deps.clock.now(),
  }
  const created = await deps.controlPlane.createEnvironment(
    environment,
    environmentEntry(deps, environment, actor)
  )
  if (!created) {
    throw new ConflictError({
      message: `This project already has a ${input.kind} environment.`,
      params: { kind: input.kind },
    })
  }
  await Jwks.ensureKeys(deps, environment.id)
  return environment
}

/**
 * List the instance audit log, newest first.
 *
 * @param deps - Control plane.
 * @param query - Filters and page.
 * @returns One page, in the shape of the environments' audit log.
 */
export async function listAudit(
  deps: Pick<Deps, 'controlPlane'>,
  query: InstanceAuditLogQuery
): Promise<AuditLogList> {
  const { items, totalCount } = await deps.controlPlane.listAudit({
    action: query.action,
    actorId: query.actorId,
    targetId: query.targetId,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
    page: query.page,
    size: query.size,
  })
  return {
    meta: meta(totalCount, query),
    data: items.map((item) => ({
      id: item.id,
      action: item.type,
      actor: item.actor,
      target: item.target,
      ipAddress: item.ipAddress,
      userAgent: item.userAgent,
      metadata: item.data,
      occurredAt: item.occurredAt.toISOString(),
    })),
  }
}
