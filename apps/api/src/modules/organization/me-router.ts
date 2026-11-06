import {
  ActiveOrganizationSchema,
  CreateOrganizationRequestSchema,
  OrganizationPageQuerySchema,
  SetActiveOrganizationRequestSchema,
  UserOrganizationListSchema,
  UserOrganizationSchema,
} from '@tula-tech/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { userActor } from '~/lib/actor'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import { sessionAuth } from '~/middleware/session-auth'
import * as Me from '~/modules/organization/me-service'
import * as openapi from '~/openapi'

/** Requests per minute from one IP to the route that lists the signed-in user's organizations. */
export const MY_ORGANIZATIONS_READ_RATE_LIMIT = 60

/**
 * Requests per minute from one IP to each route that creates an organization or changes the
 * session's active one. Switching is a click, creating is rarer.
 */
export const MY_ORGANIZATIONS_WRITE_RATE_LIMIT = 20

// Mounted at `/v1/client/me/organizations`: the signed-in user's own organizations and the
// session's active one (ADR 0065, Orgs 02).
const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const errors = {
  401: openapi.responses[401],
  403: openapi.responses[403],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
} as const

const disabled =
  'While the environment’s `organizations.enabled` setting is off, every organization route ' +
  'answers `organization.disabled` (403) and touches nothing.'

router.get(
  '/',
  describeRoute({
    operationId: 'listMyOrganizations',
    tags: ['Organizations'],
    summary: 'List my organizations',
    description:
      'The organizations the signed-in user belongs to, the one they joined first at the top, ' +
      'with their role in each and its permission keys, and the session’s active ' +
      `organization (\`activeOrganizationId\`, \`null\` for the personal account). ${disabled}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'One page of organizations.', content: json(UserOrganizationListSchema) },
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organizations_list',
    limit: MY_ORGANIZATIONS_READ_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('query', OrganizationPageQuerySchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { sub, sid } = c.get('session')
    return c.json(
      UserOrganizationListSchema.parse(
        await Me.list(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          c.req.valid('query')
        )
      )
    )
  }
)

router.post(
  '/',
  describeRoute({
    operationId: 'createMyOrganization',
    tags: ['Organizations'],
    summary: 'Create an organization',
    description:
      'Creates an organization with the signed-in user as its first member, holding the ' +
      'environment’s `creatorRole`. Only where `organizations.allowUserCreated` is on ' +
      '(`organization.creation_disabled` otherwise), and up to `organizations.maxCreatedPerUser` ' +
      'organizations created by one user (`organization.limit_reached`). A slug another ' +
      'organization has is `organization.slug_taken` (409). The session does not switch to it: ' +
      `call \`PUT /v1/client/me/organizations/active\`. ${disabled}`,
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      201: { description: 'The organization.', content: json(UserOrganizationSchema) },
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organizations_create',
    limit: MY_ORGANIZATIONS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('json', CreateOrganizationRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      UserOrganizationSchema.parse(
        await Me.create(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('json'),
          userActor(c)
        )
      ),
      201
    )
  }
)

router.put(
  '/active',
  describeRoute({
    operationId: 'setActiveOrganization',
    tags: ['Organizations'],
    summary: 'Set the active organization',
    description:
      'Makes an organization the one the session acts in, or clears it (`organizationId: null`, ' +
      'the personal account, where `organizations.personalAccount` allows it: ' +
      '`organization.personal_account_disabled` otherwise). The user must belong to the ' +
      'organization: one they do not belong to, and one that does not exist, both answer ' +
      '`organization.not_a_member` (403). A `hybrid` session gets a **new access token** that ' +
      'carries `org_id`, `org_role` and `org_perms` (none once cleared) and keeps its refresh ' +
      'token; a `stateful` session gets none and its next request carries them. Every later ' +
      'token re-reads the membership: a user removed from the organization, or given another ' +
      `role, has the change at the next refresh. ${disabled}`,
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      200: {
        description: 'The session and its active organization.',
        content: json(ActiveOrganizationSchema),
      },
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organizations_set_active',
    limit: MY_ORGANIZATIONS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('json', SetActiveOrganizationRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { sub, sid } = c.get('session')
    return c.json(
      ActiveOrganizationSchema.parse(
        await Me.setActive(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          c.req.valid('json').organizationId
        )
      )
    )
  }
)

export default router
