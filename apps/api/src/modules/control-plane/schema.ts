import {
  AuditLogSchema,
  DEFAULT_PAGE_SIZE,
  InstanceActivityTypeSchema,
  MAX_PAGE_SIZE,
  PaginationMetaSchema,
} from '@tula/contract'
import { z } from 'zod'
import {
  EnvironmentKindSchema,
  EnvironmentSchema,
  MAX_NAME_LENGTH,
  NameSchema,
} from '~/modules/project/schema'

/**
 * The body of a dashboard sign-in: the instance admin token, once.
 *
 * Anything that is not this shape gets the same `auth.invalid_key` as a wrong token.
 */
export const DashboardSignInRequestSchema = z
  .object({
    /** `TULA_ADMIN_TOKEN`. Sent in the body, never in a URL. */
    token: z.string().min(1).max(256),
  })
  .meta({ ref: 'DashboardSignInRequest' })

/** A dashboard session: when it ends. Nothing extends it. */
export const DashboardSessionSchema = z
  .object({ expiresAt: z.iso.datetime() })
  .meta({ ref: 'DashboardSession' })

export { MAX_NAME_LENGTH }

const page = {
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
}

/** Query of a list that only pages. */
export const PageQuerySchema = z.object(page).meta({ ref: 'InstancePageQuery' })

/** A workspace: the team that owns projects. */
export const WorkspaceSchema = z
  .object({ id: z.uuid(), name: z.string(), createdAt: z.iso.datetime() })
  .meta({ ref: 'Workspace' })

/** One page of workspaces, oldest first. */
export const WorkspaceListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(WorkspaceSchema) })
  .meta({ ref: 'WorkspaceList' })

/** The body that creates a workspace. */
export const CreateWorkspaceRequestSchema = z
  .strictObject({ name: NameSchema })
  .meta({ ref: 'CreateWorkspaceRequest' })

/** A project: one app a workspace secures. */
export const ProjectSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    name: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ ref: 'Project' })

/** One page of projects, oldest first. */
export const ProjectListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(ProjectSchema) })
  .meta({ ref: 'ProjectList' })

/** Query of the project list: optionally one workspace's. */
export const ProjectListQuerySchema = z
  .object({ workspaceId: z.uuid().optional(), ...page })
  .meta({ ref: 'ProjectListQuery' })

/** The body that creates a project. It gets a development and a production environment. */
export const CreateProjectRequestSchema = z
  .strictObject({ workspaceId: z.uuid(), name: NameSchema })
  .meta({ ref: 'CreateProjectRequest' })

/** A new project with the environments created for it. */
export const CreatedProjectSchema = z
  .object({ project: ProjectSchema, environments: z.array(EnvironmentSchema) })
  .meta({ ref: 'CreatedProject' })

/** The body that renames a project. */
export const UpdateProjectRequestSchema = z
  .strictObject({ name: NameSchema })
  .meta({ ref: 'UpdateProjectRequest' })

/** A project id in the path. */
export const ProjectIdParamSchema = z.object({ projectId: z.uuid() })

/** One page of environments: oldest project first, development before production. */
export const InstanceEnvironmentListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(EnvironmentSchema) })
  .meta({ ref: 'InstanceEnvironmentList' })

/** Query of the environment list: optionally one project's. */
export const EnvironmentListQuerySchema = z
  .object({ projectId: z.uuid().optional(), ...page })
  .meta({ ref: 'InstanceEnvironmentListQuery' })

/** The body that adds an environment to a project. */
export const CreateEnvironmentRequestSchema = z
  .strictObject({ kind: EnvironmentKindSchema })
  .meta({ ref: 'CreateEnvironmentRequest' })

/** Query of the instance audit log. */
export const InstanceAuditLogQuerySchema = z
  .object({
    action: InstanceActivityTypeSchema.optional(),
    /** A dashboard session's id. */
    actorId: z.uuid().optional(),
    /** A workspace, project or environment id. */
    targetId: z.uuid().optional(),
    /** Entries at or after this instant. */
    from: z.iso.datetime({ offset: true }).optional(),
    /** Entries before this instant. */
    to: z.iso.datetime({ offset: true }).optional(),
    ...page,
  })
  .meta({ ref: 'InstanceAuditLogQuery' })

/** One page of instance audit entries, newest first. Same entry shape as the audit log. */
export const InstanceAuditLogListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(AuditLogSchema) })
  .meta({ ref: 'InstanceAuditLogList' })

/** The body of a dashboard sign-in. */
export type DashboardSignInRequest = z.infer<typeof DashboardSignInRequestSchema>
/** A workspace as returned. */
export type Workspace = z.infer<typeof WorkspaceSchema>
/** A project as returned. */
export type Project = z.infer<typeof ProjectSchema>
/** A page request. */
export type PageQuery = z.infer<typeof PageQuerySchema>
/** The project list's query. */
export type ProjectListQuery = z.infer<typeof ProjectListQuerySchema>
/** The environment list's query. */
export type EnvironmentListQuery = z.infer<typeof EnvironmentListQuerySchema>
/** The instance audit log's query. */
export type InstanceAuditLogQuery = z.infer<typeof InstanceAuditLogQuerySchema>
