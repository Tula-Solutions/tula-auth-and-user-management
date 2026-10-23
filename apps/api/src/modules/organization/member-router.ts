import {
  AssignableRoleListSchema,
  OrganizationMemberListSchema,
  OrganizationMemberSchema,
  OrganizationPageQuerySchema,
  UpdateOrganizationMemberRequestSchema,
  UpdateOrganizationRequestSchema,
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
import * as Members from '~/modules/organization/member-service'
import * as openapi from '~/openapi'
import { MemberOrganizationParamSchema, MemberParamSchema } from './schema'

/** Requests per minute from one IP to each route that reads members or the roles on offer. */
export const MEMBER_READ_RATE_LIMIT = 60

/**
 * Requests per minute from one IP to each route that renames or deletes an organization,
 * changes a role or removes a member.
 */
export const MEMBER_WRITE_RATE_LIMIT = 20

// Mounted at `/v1/client/me/organizations`: what a signed-in member does to the organization
// they belong to (ADR 0065, Orgs 07). The admin API's are `router.ts`.
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

const needs = (permission: string) =>
  `Needs the permission \`${permission}\`, read from the caller’s membership on every call ` +
  '(never from the token’s claims): a user who is not a member, of an organization that ' +
  'exists or not, answers `organization.not_a_member` and one whose role lacks it ' +
  `\`organization.permission_required\` (403). ${disabled}`

router.patch(
  '/:organizationId',
  describeRoute({
    operationId: 'updateMyOrganization',
    tags: ['Organizations'],
    summary: 'Rename an organization',
    description: `Changes the organization’s name, its slug or both; a slug another organization has is \`organization.slug_taken\` (409). ${needs('org:sys:organization:manage')}`,
    security: openapi.security.session,
    responses: {
      200: {
        description: 'The organization, with the caller’s role.',
        content: json(UserOrganizationSchema),
      },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_update',
    limit: MEMBER_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', MemberOrganizationParamSchema, validationHook),
  validator('json', UpdateOrganizationRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      UserOrganizationSchema.parse(
        await Members.update(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('param').organizationId,
          c.req.valid('json'),
          userActor(c)
        )
      )
    )
  }
)

router.delete(
  '/:organizationId',
  describeRoute({
    operationId: 'deleteMyOrganization',
    tags: ['Organizations'],
    summary: 'Delete an organization',
    description: `Deletes the organization and its memberships, invitations and domains; the users keep their accounts, and their sessions leave it at the next refresh. Permanent. ${needs('org:sys:organization:delete')}`,
    security: openapi.security.session,
    responses: {
      204: { description: 'Deleted.' },
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_delete',
    limit: MEMBER_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', MemberOrganizationParamSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    await Members.remove(
      c.get('deps'),
      c.get('tenant'),
      { userId: c.get('session').sub },
      c.req.valid('param').organizationId,
      userActor(c)
    )
    return c.body(null, 204)
  }
)

router.get(
  '/:organizationId/members',
  describeRoute({
    operationId: 'listMyOrganizationMembers',
    tags: ['Organizations'],
    summary: 'List an organization’s members',
    description: `The organization’s members, oldest first, with each one’s name, address and role key. ${needs('org:sys:memberships:read` or `org:sys:memberships:manage')}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'One page of members.', content: json(OrganizationMemberListSchema) },
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_members_list',
    limit: MEMBER_READ_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', MemberOrganizationParamSchema, validationHook),
  validator('query', OrganizationPageQuerySchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      OrganizationMemberListSchema.parse(
        await Members.listMembers(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('param').organizationId,
          c.req.valid('query')
        )
      )
    )
  }
)

router.get(
  '/:organizationId/roles',
  describeRoute({
    operationId: 'listMyOrganizationRoles',
    tags: ['Organizations'],
    summary: 'List the roles the caller may give',
    description: `The roles whose permissions the caller holds all of themselves: the ones they may offer in an invitation or give to a member. Keys and names only. ${needs('org:sys:invitations:manage` or `org:sys:memberships:manage')}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The roles.', content: json(AssignableRoleListSchema) },
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_roles_list',
    limit: MEMBER_READ_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', MemberOrganizationParamSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      AssignableRoleListSchema.parse(
        await Members.assignableRoles(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('param').organizationId
        )
      )
    )
  }
)

router.patch(
  '/:organizationId/members/:userId',
  describeRoute({
    operationId: 'updateMyOrganizationMember',
    tags: ['Organizations'],
    summary: 'Change a member’s role',
    description: `Gives a member another role, one whose permissions the caller holds all of themselves (\`organization.role_not_assignable\`). The last member who can manage members cannot be moved to a role without that permission (\`organization.last_manager\`, 409). The member’s sessions carry the new role from their next refresh. ${needs('org:sys:memberships:manage')}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The member.', content: json(OrganizationMemberSchema) },
      404: openapi.responses[404],
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_member_update',
    limit: MEMBER_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', MemberParamSchema, validationHook),
  validator('json', UpdateOrganizationMemberRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { organizationId, userId } = c.req.valid('param')
    return c.json(
      OrganizationMemberSchema.parse(
        await Members.changeRole(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          organizationId,
          userId,
          c.req.valid('json'),
          userActor(c)
        )
      )
    )
  }
)

router.delete(
  '/:organizationId/members/:userId',
  describeRoute({
    operationId: 'removeMyOrganizationMember',
    tags: ['Organizations'],
    summary: 'Remove a member, or leave',
    description:
      'Removes a member; the user keeps their account and their sessions leave the organization ' +
      'at the next refresh. **A member may always remove themselves** (leave) with no ' +
      'permission; removing anyone else needs `org:sys:memberships:manage`, read from the ' +
      'caller’s membership on every call. The last member who can manage members cannot be ' +
      `removed, by someone else or by leaving (\`organization.last_manager\`, 409). ${disabled}`,
    security: openapi.security.session,
    responses: {
      204: { description: 'Removed.' },
      404: openapi.responses[404],
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_member_remove',
    limit: MEMBER_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', MemberParamSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { organizationId, userId } = c.req.valid('param')
    await Members.removeMember(
      c.get('deps'),
      c.get('tenant'),
      { userId: c.get('session').sub },
      organizationId,
      userId,
      userActor(c)
    )
    return c.body(null, 204)
  }
)

export default router
