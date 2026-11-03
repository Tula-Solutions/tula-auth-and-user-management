import {
  CreatedSetupLinkSchema,
  CreateSetupLinkRequestSchema,
  SetupLinkListSchema,
} from '@tula-tech/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as SetupLinks from '~/modules/setup-link/service'
import * as openapi from '~/openapi'

// The operator's side of setup links (ADR 0067, "Setup links"): behind `secretKey()` like every
// admin route. What a link opens is `portal-router.ts`; an organization's administrators have
// `me-router.ts`.
const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const errors = {
  404: openapi.responses[404],
  409: openapi.responses[409],
  422: openapi.responses[422],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
}

const QuerySchema = z.object({ organizationId: z.uuid() })
const IdParamSchema = z.object({ id: z.uuid() })

router.get(
  '/',
  describeRoute({
    operationId: 'listSetupLinks',
    tags: ['SSO setup links'],
    summary: 'List an organization’s SSO setup links',
    description:
      'The links of one organization, revoked and expired ones included, newest first. No tokens.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The links.', content: json(SetupLinkListSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('query', QuerySchema, validationHook),
  async (c) => {
    const links = await SetupLinks.list(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('query').organizationId
    )
    c.header('Cache-Control', 'no-store')
    return c.json(SetupLinkListSchema.parse({ links }))
  }
)

router.post(
  '/',
  describeRoute({
    operationId: 'createSetupLink',
    tags: ['SSO setup links'],
    summary: 'Create an SSO setup link',
    description:
      'Creates a link that lets an organization’s IT administrator set up single sign-on at ' +
      '`/dashboard/setup` without an account. It lives 7 days unless `expiresInDays` (1 to ' +
      '30) says otherwise and can be revoked. The token and the address, built from ' +
      '`PUBLIC_URL` with the token in its fragment, are in this answer and nowhere else: only ' +
      'the token’s hash is stored. An organization holds at most ten live links ' +
      '(`resource.conflict`, 409).',
    security: openapi.security.admin,
    responses: {
      201: { description: 'The link, with its token.', content: json(CreatedSetupLinkSchema) },
      413: openapi.responses[413],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', CreateSetupLinkRequestSchema, validationHook),
  async (c) => {
    const created = await SetupLinks.create(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('json'),
      adminActor(c)
    )
    c.header('Cache-Control', 'no-store')
    return c.json(CreatedSetupLinkSchema.parse(created), 201)
  }
)

router.delete(
  '/:id',
  describeRoute({
    operationId: 'revokeSetupLink',
    tags: ['SSO setup links'],
    summary: 'Revoke an SSO setup link',
    description:
      'Revokes a link that is not revoked yet. Whoever holds it is refused from the next ' +
      'request; connections made through it stay.',
    security: openapi.security.admin,
    responses: {
      204: { description: 'Revoked.' },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', IdParamSchema, validationHook),
  validator('query', QuerySchema, validationHook),
  async (c) => {
    await SetupLinks.revoke(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('query').organizationId,
      c.req.valid('param').id,
      adminActor(c)
    )
    return c.body(null, 204)
  }
)

export default router
