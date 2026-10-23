import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Domains from '~/modules/organization-domain/service'
import * as openapi from '~/openapi'
import {
  DomainParamSchema,
  OrganizationDomainListSchema,
  OrganizationDomainSchema,
  OrganizationIdParamSchema,
  StartOrganizationDomainRequestSchema,
  UpdateOrganizationDomainRequestSchema,
  VerifyOrganizationDomainRequestSchema,
} from './schema'

// Mounted at `/v1/admin/organizations`: the domains of an organization (ADR 0065, "Verified
// domains"), for a secret key or the dashboard. The routes of a signed-in member who holds
// `org:sys:domains:manage` are in `me-router.ts`, and call the same service.
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
  '/:id/domains',
  describeRoute({
    operationId: 'listOrganizationDomains',
    tags: ['Organizations'],
    summary: 'List an organization’s domains',
    description: `The domains the organization has claimed, oldest first: verified ones, and claims still waiting for their code. ${disabled}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The domains.', content: json(OrganizationDomainListSchema) },
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
      OrganizationDomainListSchema.parse(
        await Domains.list(c.get('deps'), c.get('tenant'), c.req.valid('param').id)
      )
    )
)

router.post(
  '/:id/domains',
  describeRoute({
    operationId: 'startOrganizationDomain',
    tags: ['Organizations'],
    summary: 'Claim a domain for an organization',
    description:
      'Emails a 6-digit code to an address on the domain and keeps a pending claim; ' +
      '`POST …/{domainId}/verify` with the code verifies it. Sent again for a pending claim it ' +
      'emails a new code and may change the `mode`. A verified domain makes a user who signs ' +
      'up with a **verified** address on exactly that domain (a subdomain is another domain) a ' +
      'member with the environment’s default role (`auto_join`), or is offered the ' +
      'organization (`suggest`). Refused: a public mail domain (`organization.domain_public`, ' +
      '422), an address that is not on the domain (`organization.domain_address_mismatch`, ' +
      '422), a domain verified for an organization already (`organization.domain_taken`, 409) ' +
      'and an organization with ten domains (`organization.domain_limit`, 409). Sends are ' +
      `limited per organization, per environment and per address (429). ${disabled}`,
    security: openapi.security.admin,
    responses: {
      201: { description: 'The pending claim.', content: json(OrganizationDomainSchema) },
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
  validator('json', StartOrganizationDomainRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      OrganizationDomainSchema.parse(
        await Domains.start(
          c.get('deps'),
          c.get('tenant'),
          c.req.valid('param').id,
          c.req.valid('json'),
          adminActor(c)
        )
      ),
      201
    )
  }
)

router.post(
  '/:id/domains/:domainId/verify',
  describeRoute({
    operationId: 'verifyOrganizationDomain',
    tags: ['Organizations'],
    summary: 'Verify a claimed domain',
    description:
      'Verifies the claim with the code emailed to an address on the domain. A wrong code is ' +
      '`verification.invalid_code` (422) and counts against five guesses per code and against ' +
      'a back-off that grows with every further wrong code (429); a code that expired or was ' +
      'replaced is `verification.expired` (410). A domain another organization verified first ' +
      `is \`organization.domain_taken\` (409). ${disabled}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The verified domain.', content: json(OrganizationDomainSchema) },
      409: openapi.responses[409],
      410: openapi.responses[410],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', DomainParamSchema, validationHook),
  validator('json', VerifyOrganizationDomainRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { id, domainId } = c.req.valid('param')
    return c.json(
      OrganizationDomainSchema.parse(
        await Domains.verify(
          c.get('deps'),
          c.get('tenant'),
          id,
          domainId,
          c.req.valid('json').code,
          adminActor(c)
        )
      )
    )
  }
)

router.patch(
  '/:id/domains/:domainId',
  describeRoute({
    operationId: 'updateOrganizationDomain',
    tags: ['Organizations'],
    summary: 'Change what a domain does',
    description: `Sets the domain’s \`mode\`: \`suggest\` or \`auto_join\`. Moving to \`auto_join\` is a weakening, recorded as such. It applies to sign-ups from then on; nobody is joined retroactively. ${disabled}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The domain.', content: json(OrganizationDomainSchema) },
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', DomainParamSchema, validationHook),
  validator('json', UpdateOrganizationDomainRequestSchema, validationHook),
  async (c) => {
    const { id, domainId } = c.req.valid('param')
    return c.json(
      OrganizationDomainSchema.parse(
        await Domains.setMode(
          c.get('deps'),
          c.get('tenant'),
          id,
          domainId,
          c.req.valid('json').mode,
          adminActor(c)
        )
      )
    )
  }
)

router.delete(
  '/:id/domains/:domainId',
  describeRoute({
    operationId: 'removeOrganizationDomain',
    tags: ['Organizations'],
    summary: 'Remove a domain',
    description: `Removes a claim, verified or not. Future sign-ups no longer join or are offered the organization because of it; members who joined stay members. ${disabled}`,
    security: openapi.security.admin,
    responses: {
      204: { description: 'Removed.' },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', DomainParamSchema, validationHook),
  async (c) => {
    const { id, domainId } = c.req.valid('param')
    await Domains.remove(c.get('deps'), c.get('tenant'), id, domainId, adminActor(c))
    return c.body(null, 204)
  }
)

export default router
