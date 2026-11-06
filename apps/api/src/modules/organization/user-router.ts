import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Organizations from '~/modules/organization/service'
import * as openapi from '~/openapi'
import { OrganizationPageQuerySchema, UserIdParamSchema, UserMembershipListSchema } from './schema'

// The one admin route about a user's organizations. It lives here and not in `modules/user`:
// the answer is the organization store's, and it is gated by `organizations.enabled` like
// every other organization route (`.claude/rules/organizations.md`).

const router = new Hono<AppEnv>()

router.get(
  '/:userId/organizations',
  describeRoute({
    operationId: 'listUserOrganizations',
    tags: ['Organizations'],
    summary: 'List the organizations a user belongs to',
    description:
      'The user’s memberships, the one they joined first at the top, one page at a time: ' +
      'each organization’s id, name and slug and the key of the user’s role in it. ' +
      'While the environment’s `organizations.enabled` setting is off, every organization ' +
      'route answers `organization.disabled` (403) and touches nothing.',
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'One page of the user’s memberships.',
        content: { 'application/json': { schema: resolver(UserMembershipListSchema) } },
      },
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', UserIdParamSchema, validationHook),
  validator('query', OrganizationPageQuerySchema, validationHook),
  async (c) =>
    c.json(
      UserMembershipListSchema.parse(
        await Organizations.listForUser(
          c.get('deps'),
          c.get('tenant'),
          c.req.valid('param').userId,
          c.req.valid('query')
        )
      )
    )
)

export default router
