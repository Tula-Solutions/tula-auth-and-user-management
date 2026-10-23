import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Organizations from '~/modules/organization/service'
import * as openapi from '~/openapi'
import {
  AddOrganizationMemberRequestSchema,
  CreateOrganizationRequestSchema,
  MembershipParamSchema,
  OrganizationIdParamSchema,
  OrganizationListSchema,
  OrganizationMembershipListSchema,
  OrganizationMembershipSchema,
  OrganizationPageQuerySchema,
  OrganizationSchema,
  UpdateOrganizationMemberRequestSchema,
  UpdateOrganizationRequestSchema,
} from './schema'

const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const errors = {
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
}

const disabled =
  'While the environment’s `organizations.enabled` setting is off, every organization route ' +
  'answers `organization.disabled` (403) and touches nothing.'

router.get(
  '/',
  describeRoute({
    operationId: 'listOrganizations',
    tags: ['Organizations'],
    summary: 'List organizations',
    description: `Organizations of the secret key’s environment, newest first, one page at a time. ${disabled}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'One page of organizations.', content: json(OrganizationListSchema) },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('query', OrganizationPageQuerySchema, validationHook),
  async (c) =>
    c.json(
      OrganizationListSchema.parse(
        await Organizations.list(c.get('deps'), c.get('tenant'), c.req.valid('query'))
      )
    )
)

router.post(
  '/',
  describeRoute({
    operationId: 'createOrganization',
    tags: ['Organizations'],
    summary: 'Create an organization',
    description:
      'Creates an organization with no member. The `slug` is lower-case letters and digits ' +
      'joined by single hyphens, 2 to 48 characters, and unique in the environment (a taken ' +
      `one answers \`organization.slug_taken\`, 409). ${disabled}`,
    security: openapi.security.admin,
    responses: {
      201: { description: 'The created organization.', content: json(OrganizationSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', CreateOrganizationRequestSchema, validationHook),
  async (c) =>
    c.json(
      OrganizationSchema.parse(
        await Organizations.create(
          c.get('deps'),
          c.get('tenant'),
          c.req.valid('json'),
          adminActor(c)
        )
      ),
      201
    )
)

router.get(
  '/:id',
  describeRoute({
    operationId: 'getOrganization',
    tags: ['Organizations'],
    summary: 'Get an organization',
    description: `One organization of the environment. ${disabled}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The organization.', content: json(OrganizationSchema) },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', OrganizationIdParamSchema, validationHook),
  async (c) =>
    c.json(
      OrganizationSchema.parse(
        await Organizations.get(c.get('deps'), c.get('tenant'), c.req.valid('param').id)
      )
    )
)

router.patch(
  '/:id',
  describeRoute({
    operationId: 'updateOrganization',
    tags: ['Organizations'],
    summary: 'Rename an organization',
    description:
      'Changes the organization’s `name`, its `slug` or both. A request that changes nothing ' +
      'writes nothing. Recorded in the audit log by the names of the fields that changed, ' +
      `never their values. ${disabled}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The organization as it is now.', content: json(OrganizationSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', OrganizationIdParamSchema, validationHook),
  validator('json', UpdateOrganizationRequestSchema, validationHook),
  async (c) =>
    c.json(
      OrganizationSchema.parse(
        await Organizations.update(
          c.get('deps'),
          c.get('tenant'),
          c.req.valid('param').id,
          c.req.valid('json'),
          adminActor(c)
        )
      )
    )
)

router.delete(
  '/:id',
  describeRoute({
    operationId: 'deleteOrganization',
    tags: ['Organizations'],
    summary: 'Delete an organization',
    description:
      'Deletes the organization and its memberships. The users keep their accounts; a session ' +
      `that had the organization active leaves it at its next refresh. ${disabled}`,
    security: openapi.security.admin,
    responses: {
      204: { description: 'Deleted.' },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', OrganizationIdParamSchema, validationHook),
  async (c) => {
    await Organizations.remove(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      adminActor(c)
    )
    return c.body(null, 204)
  }
)

router.get(
  '/:id/memberships',
  describeRoute({
    operationId: 'listOrganizationMemberships',
    tags: ['Organizations'],
    summary: 'List an organization’s members',
    description: `The organization’s memberships, oldest first, one page at a time. ${disabled}`,
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'One page of memberships.',
        content: json(OrganizationMembershipListSchema),
      },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', OrganizationIdParamSchema, validationHook),
  validator('query', OrganizationPageQuerySchema, validationHook),
  async (c) =>
    c.json(
      OrganizationMembershipListSchema.parse(
        await Organizations.listMembers(
          c.get('deps'),
          c.get('tenant'),
          c.req.valid('param').id,
          c.req.valid('query')
        )
      )
    )
)

router.post(
  '/:id/memberships',
  describeRoute({
    operationId: 'addOrganizationMember',
    tags: ['Organizations'],
    summary: 'Add a member to an organization',
    description:
      'Adds an existing user with the role of the given key (`admin` and `member` are built ' +
      'in). A user who is a member already answers `organization.member_exists` (409), and a ' +
      `key that names no role \`organization.role_unknown\` (422). ${disabled}`,
    security: openapi.security.admin,
    responses: {
      201: { description: 'The membership.', content: json(OrganizationMembershipSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', OrganizationIdParamSchema, validationHook),
  validator('json', AddOrganizationMemberRequestSchema, validationHook),
  async (c) =>
    c.json(
      OrganizationMembershipSchema.parse(
        await Organizations.addMember(
          c.get('deps'),
          c.get('tenant'),
          c.req.valid('param').id,
          c.req.valid('json'),
          adminActor(c)
        )
      ),
      201
    )
)

router.patch(
  '/:id/memberships/:userId',
  describeRoute({
    operationId: 'updateOrganizationMember',
    tags: ['Organizations'],
    summary: 'Change a member’s role',
    description:
      'Gives the member another role. The member’s sessions carry it from their next ' +
      'refresh. The last member who holds `org:sys:memberships:manage` cannot be moved to a ' +
      `role without it (\`organization.last_manager\`, 409). ${disabled}`,
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'The membership as it is now.',
        content: json(OrganizationMembershipSchema),
      },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', MembershipParamSchema, validationHook),
  validator('json', UpdateOrganizationMemberRequestSchema, validationHook),
  async (c) => {
    const { id, userId } = c.req.valid('param')
    return c.json(
      OrganizationMembershipSchema.parse(
        await Organizations.changeMemberRole(
          c.get('deps'),
          c.get('tenant'),
          id,
          userId,
          c.req.valid('json'),
          adminActor(c)
        )
      )
    )
  }
)

router.delete(
  '/:id/memberships/:userId',
  describeRoute({
    operationId: 'removeOrganizationMember',
    tags: ['Organizations'],
    summary: 'Remove a member from an organization',
    description:
      'Removes the membership. The user keeps their account; a session that had the ' +
      'organization active leaves it at its next refresh. The last member who holds ' +
      `\`org:sys:memberships:manage\` cannot be removed (\`organization.last_manager\`, 409). ${disabled}`,
    security: openapi.security.admin,
    responses: {
      204: { description: 'Removed.' },
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', MembershipParamSchema, validationHook),
  async (c) => {
    const { id, userId } = c.req.valid('param')
    await Organizations.removeMember(c.get('deps'), c.get('tenant'), id, userId, adminActor(c))
    return c.body(null, 204)
  }
)

export default router
