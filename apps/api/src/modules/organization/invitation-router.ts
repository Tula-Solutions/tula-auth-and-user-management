import {
  CreateOrganizationInvitationRequestSchema,
  OrganizationInvitationListSchema,
  OrganizationInvitationQuerySchema,
  OrganizationInvitationSchema,
} from '@tula-tech/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Invitations from '~/modules/organization/invitation-service'
import * as openapi from '~/openapi'
import { InvitationParamSchema, OrganizationIdParamSchema } from './schema'

// Mounted at `/v1/admin/organizations`: an organization's invitations, for the operator (ADR
// 0065, Orgs 04). Behind `secretKey()`, so the dashboard's session works too and an agent key
// reads and nothing else. The signed-in members' routes are `invitation-me-router.ts`.
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
  '/:id/invitations',
  describeRoute({
    operationId: 'listOrganizationInvitations',
    tags: ['Organizations'],
    summary: 'List an organization’s invitations',
    description:
      'The organization’s invitations in one state (`status`, `pending` unless another is ' +
      'asked for; `expired` is a pending invitation past its expiry), newest first, one page ' +
      `at a time. The token of an invitation is never returned. ${disabled}`,
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'One page of invitations.',
        content: json(OrganizationInvitationListSchema),
      },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', OrganizationIdParamSchema, validationHook),
  validator('query', OrganizationInvitationQuerySchema, validationHook),
  async (c) => {
    const { page, size, status } = c.req.valid('query')
    return c.json(
      OrganizationInvitationListSchema.parse(
        await Invitations.list(c.get('deps'), c.get('tenant'), c.req.valid('param').id, {
          page,
          size,
          status,
        })
      )
    )
  }
)

router.post(
  '/:id/invitations',
  describeRoute({
    operationId: 'inviteToOrganization',
    tags: ['Organizations'],
    summary: 'Invite an address to an organization',
    description:
      'Emails the address a link that leads to `redirectUrl` (one of the environment’s allowed ' +
      'redirect URLs, matched exactly; a custom scheme is refused) with the invitation’s token ' +
      'in the URL fragment (`#tula_invitation=…`). The invitation lasts 7 days and can be ' +
      'accepted only by a signed-in user whose **verified** email is the invited address. ' +
      'The role must exist (`organization.role_unknown`, 422); an address that is a member ' +
      'already answers `organization.member_exists` and one with a pending invitation ' +
      '`organization.invitation_exists` (409). Limited per organization per hour and per ' +
      `environment per day (\`rate_limited\`, 429). ${disabled}`,
    security: openapi.security.admin,
    responses: {
      201: { description: 'The invitation.', content: json(OrganizationInvitationSchema) },
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
  validator('json', CreateOrganizationInvitationRequestSchema, validationHook),
  async (c) =>
    c.json(
      OrganizationInvitationSchema.parse(
        await Invitations.invite(
          c.get('deps'),
          c.get('tenant'),
          c.req.valid('param').id,
          c.req.valid('json'),
          adminActor(c),
          null
        )
      ),
      201
    )
)

router.delete(
  '/:id/invitations/:invitationId',
  describeRoute({
    operationId: 'revokeOrganizationInvitation',
    tags: ['Organizations'],
    summary: 'Revoke an invitation',
    description:
      'Withdraws a pending invitation: its link stops working. An invitation that was ' +
      'accepted or declined answers `organization.invitation_used`, a withdrawn one ' +
      '`organization.invitation_revoked` and an expired one `organization.invitation_expired` ' +
      `(410). ${disabled}`,
    security: openapi.security.admin,
    responses: {
      204: { description: 'Revoked.' },
      410: openapi.responses[410],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', InvitationParamSchema, validationHook),
  async (c) => {
    const { id, invitationId } = c.req.valid('param')
    await Invitations.revoke(c.get('deps'), c.get('tenant'), id, invitationId, adminActor(c))
    return c.body(null, 204)
  }
)

export default router
