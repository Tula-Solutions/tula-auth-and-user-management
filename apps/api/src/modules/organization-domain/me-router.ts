import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { userActor } from '~/lib/actor'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import { sessionAuth } from '~/middleware/session-auth'
import * as Domains from '~/modules/organization-domain/service'
import * as openapi from '~/openapi'
import {
  DomainParamSchema,
  OrganizationDomainListSchema,
  OrganizationDomainSchema,
  OrganizationIdParamSchema,
  OrganizationSuggestionListSchema,
  StartOrganizationDomainRequestSchema,
  SuggestionParamSchema,
  UpdateOrganizationDomainRequestSchema,
  UserOrganizationSchema,
  VerifyOrganizationDomainRequestSchema,
} from './schema'

/** Requests per minute from one IP to a route that reads suggestions or domains. */
export const DOMAINS_READ_RATE_LIMIT = 60

/**
 * Requests per minute from one IP to each route that joins a suggestion or changes a domain.
 * Sending a code has tighter limits of its own, per organization, environment and address
 * (`Domains.start`).
 */
export const DOMAINS_WRITE_RATE_LIMIT = 20

/**
 * Requests per minute from one IP to the route that verifies a code. The per-claim back-off and
 * five guesses per code are what stop guessing; this is the coarse ceiling in front of them.
 */
export const DOMAINS_VERIFY_RATE_LIMIT = 10

// Mounted at `/v1/client/me/organizations`, beside `me-router.ts` of `modules/organization`
// (the paths do not overlap): the organizations a signed-in user is suggested because of their
// verified address, and the domains of an organization for a member who holds
// `org:sys:domains:manage` (ADR 0065, "Verified domains"). Every route is `no-store`.
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

const manager =
  'The caller must be a member whose role holds `org:sys:domains:manage` **now** (read from ' +
  'the role on every request, never from the token): `organization.not_a_member` (403) for ' +
  'an organization they do not belong to, and for one that does not exist alike, and ' +
  '`auth.forbidden` (403) for a member without the permission.'

router.get(
  '/suggestions',
  describeRoute({
    operationId: 'listMyOrganizationSuggestions',
    tags: ['Organizations'],
    summary: 'List the organizations I am suggested',
    description:
      'The organization whose verified domain the signed-in user’s **verified** email address ' +
      'is on (exactly: a subdomain does not match), when they are not a member of it. Empty ' +
      'for a user with an unverified address or none, and for a public mail domain. ' +
      `${disabled}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The suggestions.', content: json(OrganizationSuggestionListSchema) },
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_suggestions',
    limit: DOMAINS_READ_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      OrganizationSuggestionListSchema.parse(
        await Domains.suggestions(c.get('deps'), c.get('tenant'), { userId: c.get('session').sub })
      )
    )
  }
)

router.post(
  '/suggestions/:organizationId/join',
  describeRoute({
    operationId: 'joinOrganizationSuggestion',
    tags: ['Organizations'],
    summary: 'Join a suggested organization',
    description:
      'Makes the signed-in user a member with the environment’s default role. The server ' +
      'decides again: the organization must still have a verified domain the user’s verified ' +
      'address is on. An organization that does not exist, is another environment’s, has no ' +
      'such domain any more, or a user without a verified address all answer ' +
      '`organization.suggestion_unavailable` (403). A user who is a member already answers ' +
      '`organization.member_exists` (409). The session does not switch to it: call ' +
      `\`PUT /v1/client/me/organizations/active\`. ${disabled}`,
    security: openapi.security.session,
    responses: {
      201: { description: 'The organization.', content: json(UserOrganizationSchema) },
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_suggestion_join',
    limit: DOMAINS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', SuggestionParamSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      UserOrganizationSchema.parse(
        await Domains.joinSuggestion(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('param').organizationId,
          userActor(c)
        )
      ),
      201
    )
  }
)

router.get(
  '/:id/domains',
  describeRoute({
    operationId: 'listMyOrganizationDomains',
    tags: ['Organizations'],
    summary: 'List an organization’s domains',
    description: `The organization’s domains, verified and waiting for a code. ${manager} ${disabled}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The domains.', content: json(OrganizationDomainListSchema) },
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_domains',
    limit: DOMAINS_READ_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', OrganizationIdParamSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { id } = c.req.valid('param')
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    await Domains.requireEnabledManager(deps, tenant, { userId: c.get('session').sub }, id)
    return c.json(OrganizationDomainListSchema.parse(await Domains.list(deps, tenant, id)))
  }
)

router.post(
  '/:id/domains',
  describeRoute({
    operationId: 'startMyOrganizationDomain',
    tags: ['Organizations'],
    summary: 'Claim a domain for an organization',
    description:
      'Emails a 6-digit code to an address on the domain and keeps a pending claim, as ' +
      '`POST /v1/admin/organizations/{id}/domains` does (the same refusals and send limits). ' +
      `${manager} ${disabled}`,
    security: openapi.security.session,
    responses: {
      201: { description: 'The pending claim.', content: json(OrganizationDomainSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_domain_start',
    limit: DOMAINS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', OrganizationIdParamSchema, validationHook),
  validator('json', StartOrganizationDomainRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { id } = c.req.valid('param')
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    await Domains.requireEnabledManager(deps, tenant, { userId: c.get('session').sub }, id)
    return c.json(
      OrganizationDomainSchema.parse(
        await Domains.start(deps, tenant, id, c.req.valid('json'), userActor(c))
      ),
      201
    )
  }
)

router.post(
  '/:id/domains/:domainId/verify',
  describeRoute({
    operationId: 'verifyMyOrganizationDomain',
    tags: ['Organizations'],
    summary: 'Verify a claimed domain',
    description:
      'Verifies the claim with the emailed code, with the same guess limits as ' +
      `\`POST /v1/admin/organizations/{id}/domains/{domainId}/verify\`. ${manager} ${disabled}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The verified domain.', content: json(OrganizationDomainSchema) },
      409: openapi.responses[409],
      410: openapi.responses[410],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_domain_verify',
    limit: DOMAINS_VERIFY_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', DomainParamSchema, validationHook),
  validator('json', VerifyOrganizationDomainRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { id, domainId } = c.req.valid('param')
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    await Domains.requireEnabledManager(deps, tenant, { userId: c.get('session').sub }, id)
    return c.json(
      OrganizationDomainSchema.parse(
        await Domains.verify(deps, tenant, id, domainId, c.req.valid('json').code, userActor(c))
      )
    )
  }
)

router.patch(
  '/:id/domains/:domainId',
  describeRoute({
    operationId: 'updateMyOrganizationDomain',
    tags: ['Organizations'],
    summary: 'Change what a domain does',
    description: `Sets the domain’s \`mode\`. ${manager} ${disabled}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The domain.', content: json(OrganizationDomainSchema) },
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_domain_update',
    limit: DOMAINS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', DomainParamSchema, validationHook),
  validator('json', UpdateOrganizationDomainRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { id, domainId } = c.req.valid('param')
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    await Domains.requireEnabledManager(deps, tenant, { userId: c.get('session').sub }, id)
    return c.json(
      OrganizationDomainSchema.parse(
        await Domains.setMode(deps, tenant, id, domainId, c.req.valid('json').mode, userActor(c))
      )
    )
  }
)

router.delete(
  '/:id/domains/:domainId',
  describeRoute({
    operationId: 'removeMyOrganizationDomain',
    tags: ['Organizations'],
    summary: 'Remove a domain',
    description: `Removes a claim; members who joined stay. ${manager} ${disabled}`,
    security: openapi.security.session,
    responses: {
      204: { description: 'Removed.' },
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_domain_remove',
    limit: DOMAINS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', DomainParamSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { id, domainId } = c.req.valid('param')
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    await Domains.requireEnabledManager(deps, tenant, { userId: c.get('session').sub }, id)
    await Domains.remove(deps, tenant, id, domainId, userActor(c))
    return c.body(null, 204)
  }
)

export default router
