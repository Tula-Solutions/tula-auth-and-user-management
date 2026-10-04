import type { Hook } from '@hono/standard-validator'
import { DASHBOARD_HEADER, DASHBOARD_HEADER_VALUE } from '@tula/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { AuthError } from '~/exceptions'
import { validationHook } from '~/handlers'
import { instanceActor } from '~/lib/actor'
import {
  clearDashboardSession,
  readDashboardSession,
  refuseMixedCredentials,
  requireDashboardOrigin,
  requireDashboardSession,
  startDashboardSession,
} from '~/middleware/dashboard-session'
import {
  instanceAdmin,
  instanceRoutesExist,
  instanceTokenRateLimit,
  isInstanceAdminToken,
} from '~/middleware/instance-admin'
import { adminRateLimit } from '~/middleware/rate-limit'
import * as ControlPlane from '~/modules/control-plane/service'
import { EnvironmentSchema } from '~/modules/project/schema'
import * as openapi from '~/openapi'
import {
  CreatedProjectSchema,
  CreateEnvironmentRequestSchema,
  CreateProjectRequestSchema,
  CreateWorkspaceRequestSchema,
  DashboardSessionSchema,
  DashboardSignInRequestSchema,
  EnvironmentListQuerySchema,
  InstanceAuditLogListSchema,
  InstanceAuditLogQuerySchema,
  InstanceEnvironmentListSchema,
  PageQuerySchema,
  ProjectIdParamSchema,
  ProjectListQuerySchema,
  ProjectListSchema,
  ProjectSchema,
  UpdateProjectRequestSchema,
  WorkspaceListSchema,
  WorkspaceSchema,
} from './schema'

const router = new Hono<AppEnv>()

/**
 * Not a 422: a body without a usable token is a failed sign-in like any other, with the same
 * answer and the same audit entry.
 */
const refuseUnusableToken: Hook<unknown, AppEnv, string> = async (result, c) => {
  if (!result.success) {
    await ControlPlane.recordSession(c.get('deps'), 'instance.sign_in_failed', instanceActor(c))
    throw new AuthError('auth.invalid_key')
  }
}

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

router.post(
  '/session',
  describeRoute({
    operationId: 'createDashboardSession',
    tags: ['Instance'],
    summary: 'Sign in to the dashboard',
    description:
      'Exchanges the instance admin token (`TULA_ADMIN_TOKEN`), sent once in the body, for a dashboard session: an `HttpOnly`, `SameSite=Strict` cookie (`tula_dashboard`; `__Secure-tula_dashboard` and `Secure` over https) set for `/v1/instance` and `/v1/admin`. The session lasts 8 hours from sign-in and is not extended. It is stateless and signed: it ends for everyone when the admin token or `TULA_MASTER_KEY` changes.\n\nThe request must carry `x-tula-dashboard: 1` and an `Origin` that is the API’s own or on `CORS_ORIGINS`. A wrong, missing or malformed token gets the same `auth.invalid_key`; every attempt is counted (30 a minute per IP) and recorded in the instance audit log. A deployment without an admin token answers 404.',
    security: openapi.security.public,
    responses: {
      200: {
        description: 'Signed in. The cookies are set.',
        content: json(DashboardSessionSchema),
      },
      400: openapi.responses[400],
      401: openapi.responses[401],
      403: openapi.responses[403],
      404: openapi.responses[404],
      413: openapi.responses[413],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  instanceRoutesExist(),
  // Counted before anything else is looked at, so that every guess counts.
  instanceTokenRateLimit(),
  async (c, next) => {
    // The same rules as a request made with the cookie, before the token is looked at: a page
    // on another site must not be able to make this browser the operator of its choosing.
    refuseMixedCredentials(c)
    if (c.req.header(DASHBOARD_HEADER) !== DASHBOARD_HEADER_VALUE) {
      throw new AuthError('request.origin_not_allowed')
    }
    requireDashboardOrigin(c)
    await next()
  },
  validator('json', DashboardSignInRequestSchema, refuseUnusableToken),
  async (c) => {
    const deps = c.get('deps')
    c.header('cache-control', 'no-store')
    // `instanceRoutesExist()` has answered 404 where there is none.
    const expected = deps.config.instanceAdminTokenHash ?? ''
    if (!isInstanceAdminToken(expected, c.req.valid('json').token)) {
      await ControlPlane.recordSession(deps, 'instance.sign_in_failed', instanceActor(c))
      throw new AuthError('auth.invalid_key')
    }
    const id = deps.ids.next()
    // Recorded before the cookie is set: no session without its entry.
    await ControlPlane.recordSession(deps, 'instance.signed_in', { ...instanceActor(c), id })
    const session = await startDashboardSession(c, id)
    return c.json(DashboardSessionSchema.parse({ expiresAt: session.expiresAt.toISOString() }))
  }
)

router.get(
  '/session',
  describeRoute({
    operationId: 'getDashboardSession',
    tags: ['Instance'],
    summary: 'Read the dashboard session',
    description:
      'Whether the browser holds a valid dashboard session, and when it ends. For the dashboard’s start: `auth.unauthenticated` means "show the sign-in form".',
    security: openapi.security.dashboard,
    responses: {
      200: { description: 'The session.', content: json(DashboardSessionSchema) },
      400: openapi.responses[400],
      401: openapi.responses[401],
      403: openapi.responses[403],
      404: openapi.responses[404],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  instanceRoutesExist(),
  adminRateLimit(),
  async (c) => {
    c.header('cache-control', 'no-store')
    // Only a session answers here: the admin token itself is not one.
    const session = await requireDashboardSession(c)
    return c.json(DashboardSessionSchema.parse({ expiresAt: session.expiresAt.toISOString() }))
  }
)

router.delete(
  '/session',
  describeRoute({
    operationId: 'deleteDashboardSession',
    tags: ['Instance'],
    summary: 'Sign out of the dashboard',
    description:
      'Removes the session cookies from the browser. Idempotent: it answers 204 with or without a session. A session is stateless, so a copy of the cookie made elsewhere stays valid until it expires (8 hours at most) or the admin token is rotated.',
    security: openapi.security.dashboard,
    responses: {
      204: { description: 'Signed out. The cookies are cleared.' },
      400: openapi.responses[400],
      403: openapi.responses[403],
      404: openapi.responses[404],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  instanceRoutesExist(),
  adminRateLimit(),
  async (c) => {
    refuseMixedCredentials(c)
    if (c.req.header(DASHBOARD_HEADER) !== DASHBOARD_HEADER_VALUE) {
      throw new AuthError('auth.unauthenticated')
    }
    const session = await readDashboardSession(c)
    if (session) {
      c.set('dashboard', session)
      await ControlPlane.recordSession(c.get('deps'), 'instance.signed_out', instanceActor(c))
    }
    clearDashboardSession(c)
    return c.body(null, 204)
  }
)

/** What every instance route can answer besides its own result. */
const common = {
  400: openapi.responses[400],
  401: openapi.responses[401],
  403: openapi.responses[403],
  404: openapi.responses[404],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
} as const

const AUTH_NOTE =
  'Takes a dashboard session or the instance admin token. A deployment without `TULA_ADMIN_TOKEN` answers 404.'

router.get(
  '/workspaces',
  describeRoute({
    operationId: 'listWorkspaces',
    tags: ['Instance'],
    summary: 'List workspaces',
    description: `The deployment’s workspaces, oldest first. ${AUTH_NOTE}`,
    security: openapi.security.instance,
    responses: {
      200: { description: 'One page of workspaces.', content: json(WorkspaceListSchema) },
      ...common,
      422: openapi.responses[422],
    },
  }),
  instanceAdmin(),
  validator('query', PageQuerySchema, validationHook),
  async (c) =>
    c.json(
      WorkspaceListSchema.parse(
        await ControlPlane.listWorkspaces(c.get('deps'), c.req.valid('query'))
      )
    )
)

router.post(
  '/workspaces',
  describeRoute({
    operationId: 'createWorkspace',
    tags: ['Instance'],
    summary: 'Create a workspace',
    description: `A workspace owns projects. A deployment that was never seeded has none. Recorded in the instance audit log. ${AUTH_NOTE}`,
    security: openapi.security.instance,
    responses: {
      201: { description: 'The workspace.', content: json(WorkspaceSchema) },
      ...common,
      413: openapi.responses[413],
      422: openapi.responses[422],
    },
  }),
  instanceAdmin(),
  validator('json', CreateWorkspaceRequestSchema, validationHook),
  async (c) =>
    c.json(
      WorkspaceSchema.parse(
        await ControlPlane.createWorkspace(c.get('deps'), c.req.valid('json'), instanceActor(c))
      ),
      201
    )
)

router.get(
  '/projects',
  describeRoute({
    operationId: 'listProjects',
    tags: ['Instance'],
    summary: 'List projects',
    description: `Projects, oldest first; \`workspaceId\` narrows the list to one workspace. ${AUTH_NOTE}`,
    security: openapi.security.instance,
    responses: {
      200: { description: 'One page of projects.', content: json(ProjectListSchema) },
      ...common,
      422: openapi.responses[422],
    },
  }),
  instanceAdmin(),
  validator('query', ProjectListQuerySchema, validationHook),
  async (c) =>
    c.json(
      ProjectListSchema.parse(await ControlPlane.listProjects(c.get('deps'), c.req.valid('query')))
    )
)

router.post(
  '/projects',
  describeRoute({
    operationId: 'createProject',
    tags: ['Instance'],
    summary: 'Create a project',
    description: `Creates a project in a workspace together with its development and production environments, each with its first signing keys. No API key is created: mint one with \`POST /v1/admin/api-keys\` for the environment. Recorded in the instance audit log. ${AUTH_NOTE}`,
    security: openapi.security.instance,
    responses: {
      201: {
        description: 'The project and its environments, development first.',
        content: json(CreatedProjectSchema),
      },
      ...common,
      413: openapi.responses[413],
      422: openapi.responses[422],
    },
  }),
  instanceAdmin(),
  validator('json', CreateProjectRequestSchema, validationHook),
  async (c) =>
    c.json(
      CreatedProjectSchema.parse(
        await ControlPlane.createProject(c.get('deps'), c.req.valid('json'), instanceActor(c))
      ),
      201
    )
)

router.patch(
  '/projects/:projectId',
  describeRoute({
    operationId: 'updateProject',
    tags: ['Instance'],
    summary: 'Rename a project',
    description: `Changes a project’s name. Recorded in the instance audit log (the key that changed, not the name). ${AUTH_NOTE}`,
    security: openapi.security.instance,
    responses: {
      200: { description: 'The project.', content: json(ProjectSchema) },
      ...common,
      413: openapi.responses[413],
      422: openapi.responses[422],
    },
  }),
  instanceAdmin(),
  validator('param', ProjectIdParamSchema, validationHook),
  validator('json', UpdateProjectRequestSchema, validationHook),
  async (c) =>
    c.json(
      ProjectSchema.parse(
        await ControlPlane.renameProject(
          c.get('deps'),
          c.req.valid('param').projectId,
          c.req.valid('json'),
          instanceActor(c)
        )
      )
    )
)

router.get(
  '/environments',
  describeRoute({
    operationId: 'listInstanceEnvironments',
    tags: ['Instance'],
    summary: 'List environments',
    description: `Environments of every project, oldest project first and development before production; \`projectId\` narrows the list to one project. An environment’s id is what a dashboard request to \`/v1/admin/*\` sends in \`x-tula-environment\`. ${AUTH_NOTE}`,
    security: openapi.security.instance,
    responses: {
      200: {
        description: 'One page of environments.',
        content: json(InstanceEnvironmentListSchema),
      },
      ...common,
      422: openapi.responses[422],
    },
  }),
  instanceAdmin(),
  validator('query', EnvironmentListQuerySchema, validationHook),
  async (c) =>
    c.json(
      InstanceEnvironmentListSchema.parse(
        await ControlPlane.listEnvironments(c.get('deps'), c.req.valid('query'))
      )
    )
)

router.post(
  '/projects/:projectId/environments',
  describeRoute({
    operationId: 'createEnvironment',
    tags: ['Instance'],
    summary: 'Add an environment to a project',
    description: `Adds the development or production environment a project lacks, with its first signing keys. A project holds one environment of each kind: a second one is \`resource.conflict\`. Recorded in the instance audit log. ${AUTH_NOTE}`,
    security: openapi.security.instance,
    responses: {
      201: { description: 'The environment.', content: json(EnvironmentSchema) },
      ...common,
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
    },
  }),
  instanceAdmin(),
  validator('param', ProjectIdParamSchema, validationHook),
  validator('json', CreateEnvironmentRequestSchema, validationHook),
  async (c) =>
    c.json(
      EnvironmentSchema.parse(
        await ControlPlane.createEnvironment(
          c.get('deps'),
          c.req.valid('param').projectId,
          c.req.valid('json'),
          instanceActor(c)
        )
      ),
      201
    )
)

router.get(
  '/audit-logs',
  describeRoute({
    operationId: 'listInstanceAuditLogs',
    tags: ['Instance'],
    summary: 'List the instance audit log',
    description: `What the deployment’s operator did outside any one environment, newest first: dashboard sign-ins (and failed ones), sign-outs, and every workspace, project and environment created or renamed. The actor is \`instance_admin\`; its id is the dashboard session’s, or \`null\` when the admin token itself was used. Filter by \`action\`, \`actorId\`, \`targetId\` and time (\`from\` inclusive, \`to\` exclusive). What was done inside an environment is in that environment’s own audit log (\`GET /v1/admin/audit-logs\`). ${AUTH_NOTE}`,
    security: openapi.security.instance,
    responses: {
      200: {
        description: 'One page of instance audit entries.',
        content: json(InstanceAuditLogListSchema),
      },
      ...common,
      422: openapi.responses[422],
    },
  }),
  instanceAdmin(),
  validator('query', InstanceAuditLogQuerySchema, validationHook),
  async (c) => {
    c.header('cache-control', 'no-store')
    return c.json(
      InstanceAuditLogListSchema.parse(
        await ControlPlane.listAudit(c.get('deps'), c.req.valid('query'))
      )
    )
  }
)

export default router
