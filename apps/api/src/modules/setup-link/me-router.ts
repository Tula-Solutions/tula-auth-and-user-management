import {
  CreatedSetupLinkSchema,
  CreateMySetupLinkRequestSchema,
  SetupLinkListSchema,
} from '@tula-tech/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { userActor } from '~/lib/actor'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import { sessionAuth } from '~/middleware/session-auth'
import * as SetupLinks from '~/modules/setup-link/service'
import * as openapi from '~/openapi'

/** Requests per minute from one IP to the organization administrator's setup link routes. */
export const MY_SETUP_LINKS_RATE_LIMIT = 30

// Mounted at `/v1/client/me/organizations`: the setup links of an organization for a member
// whose role holds `org:sys:sso:manage` now (ADR 0067, "Setup links"). The same service as the
// admin routes; the actor is the user. Every route is `no-store`.
const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const errors = {
  401: openapi.responses[401],
  403: openapi.responses[403],
  404: openapi.responses[404],
  409: openapi.responses[409],
  422: openapi.responses[422],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
} as const

const manager =
  'The caller must be a member whose role holds `org:sys:sso:manage` **now** (read from the ' +
  'role on every request, never from the token): `organization.not_a_member` (403) for an ' +
  'organization they do not belong to, and `auth.forbidden` (403) for a member without the ' +
  'permission.'

const OrganizationParamSchema = z.object({ id: z.uuid() })
const LinkParamSchema = z.object({ id: z.uuid(), linkId: z.uuid() })

const limit = rateLimit({
  name: 'my_organization_setup_links',
  limit: MY_SETUP_LINKS_RATE_LIMIT,
  window: '1m',
  key: byIp,
})

router.get(
  '/:id/setup-links',
  describeRoute({
    operationId: 'listMyOrganizationSetupLinks',
    tags: ['SSO setup links'],
    summary: 'List my organization’s SSO setup links',
    description: `The organization’s setup links, newest first. No tokens. ${manager}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The links.', content: json(SetupLinkListSchema) },
      ...errors,
    },
  }),
  limit,
  publishableKey(),
  sessionAuth(),
  validator('param', OrganizationParamSchema, validationHook),
  async (c) => {
    const { id } = c.req.valid('param')
    await SetupLinks.requireManager(c.get('deps'), c.get('tenant'), c.get('session').sub, id)
    c.header('Cache-Control', 'no-store')
    return c.json(
      SetupLinkListSchema.parse({
        links: await SetupLinks.list(c.get('deps'), c.get('tenant'), id),
      })
    )
  }
)

router.post(
  '/:id/setup-links',
  describeRoute({
    operationId: 'createMyOrganizationSetupLink',
    tags: ['SSO setup links'],
    summary: 'Create an SSO setup link for my organization',
    description:
      'Creates a setup link; the token and its address are in this answer and nowhere else. ' +
      manager,
    security: openapi.security.session,
    responses: {
      201: { description: 'The link, with its token.', content: json(CreatedSetupLinkSchema) },
      ...errors,
    },
  }),
  limit,
  publishableKey(),
  sessionAuth(),
  validator('param', OrganizationParamSchema, validationHook),
  validator('json', CreateMySetupLinkRequestSchema, validationHook),
  async (c) => {
    const { id } = c.req.valid('param')
    await SetupLinks.requireManager(c.get('deps'), c.get('tenant'), c.get('session').sub, id)
    const created = await SetupLinks.create(
      c.get('deps'),
      c.get('tenant'),
      { ...c.req.valid('json'), organizationId: id },
      userActor(c)
    )
    c.header('Cache-Control', 'no-store')
    return c.json(CreatedSetupLinkSchema.parse(created), 201)
  }
)

router.delete(
  '/:id/setup-links/:linkId',
  describeRoute({
    operationId: 'revokeMyOrganizationSetupLink',
    tags: ['SSO setup links'],
    summary: 'Revoke one of my organization’s SSO setup links',
    description: `Revokes a link that is not revoked yet. ${manager}`,
    security: openapi.security.session,
    responses: {
      204: { description: 'Revoked.' },
      ...errors,
    },
  }),
  limit,
  publishableKey(),
  sessionAuth(),
  validator('param', LinkParamSchema, validationHook),
  async (c) => {
    const { id, linkId } = c.req.valid('param')
    await SetupLinks.requireManager(c.get('deps'), c.get('tenant'), c.get('session').sub, id)
    await SetupLinks.revoke(c.get('deps'), c.get('tenant'), id, linkId, userActor(c))
    c.header('Cache-Control', 'no-store')
    return c.body(null, 204)
  }
)

export default router
