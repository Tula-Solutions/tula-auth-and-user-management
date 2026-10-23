import {
  AcceptedInvitationSchema,
  CreateOrganizationInvitationRequestSchema,
  InvitationPreviewSchema,
  InvitationTokenRequestSchema,
  MyOrganizationInvitationListSchema,
  MyOrganizationInvitationQuerySchema,
  OrganizationInvitationListSchema,
  OrganizationInvitationQuerySchema,
  OrganizationInvitationSchema,
} from '@tula-tech/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { userActor } from '~/lib/actor'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import { sessionAuth } from '~/middleware/session-auth'
import * as Invitations from '~/modules/organization/invitation-service'
import * as openapi from '~/openapi'
import {
  MemberInvitationParamSchema,
  MemberOrganizationParamSchema,
  MyInvitationParamSchema,
} from './schema'

/** Requests per minute from one IP to the route that lists an organization's invitations. */
export const INVITATIONS_READ_RATE_LIMIT = 60

/**
 * Requests per minute from one IP to each route that invites, withdraws, accepts or declines
 * an invitation, or previews one by its token. Sending is also limited per organization and
 * per environment (`INVITATIONS_PER_ORGANIZATION_PER_HOUR`, `…_PER_ENVIRONMENT_PER_DAY`).
 */
export const INVITATIONS_WRITE_RATE_LIMIT = 20

// Mounted at `/v1/client`: the invitation routes of a signed-in member (ADR 0065, Orgs 04) and
// the three routes that take an invitation's token. The admin API's are `invitation-router.ts`.
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

const manage =
  'Needs the permission `org:sys:invitations:manage`, read from the caller’s membership on ' +
  'every call (never from the token’s claims): a user who is not a member answers ' +
  '`organization.not_a_member` and one whose role lacks it `organization.permission_required` ' +
  '(403).'

router.get(
  '/me/organizations/:organizationId/invitations',
  describeRoute({
    operationId: 'listMyOrganizationInvitations',
    tags: ['Organizations'],
    summary: 'List an organization’s invitations',
    description: `The organization’s invitations in one state (\`pending\` unless \`status\` says otherwise), newest first. ${manage} ${disabled}`,
    security: openapi.security.session,
    responses: {
      200: {
        description: 'One page of invitations.',
        content: json(OrganizationInvitationListSchema),
      },
      404: openapi.responses[404],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_invitations_list',
    limit: INVITATIONS_READ_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', MemberOrganizationParamSchema, validationHook),
  validator('query', OrganizationInvitationQuerySchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      OrganizationInvitationListSchema.parse(
        await Invitations.listAsMember(
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

router.post(
  '/me/organizations/:organizationId/invitations',
  describeRoute({
    operationId: 'inviteToMyOrganization',
    tags: ['Organizations'],
    summary: 'Invite an address to an organization',
    description:
      'Emails the address a link that leads to `redirectUrl` (one of the environment’s allowed ' +
      'redirect URLs, matched exactly; a custom scheme is refused) with the invitation’s token ' +
      'in the URL fragment. The invitation lasts 7 days and only a signed-in user whose ' +
      '**verified** email is the invited address can accept it. The role offered must hold ' +
      'no permission the caller’s own role lacks (`organization.role_not_assignable`, 403). ' +
      'An address that is a member already answers `organization.member_exists` and one with a ' +
      'pending invitation `organization.invitation_exists` (409). Limited per IP, per ' +
      `organization per hour and per environment per day. ${manage} ${disabled}`,
    security: openapi.security.session,
    responses: {
      201: { description: 'The invitation.', content: json(OrganizationInvitationSchema) },
      404: openapi.responses[404],
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_invitations_create',
    limit: INVITATIONS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', MemberOrganizationParamSchema, validationHook),
  validator('json', CreateOrganizationInvitationRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      OrganizationInvitationSchema.parse(
        await Invitations.inviteAsMember(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('param').organizationId,
          c.req.valid('json'),
          userActor(c)
        )
      ),
      201
    )
  }
)

router.delete(
  '/me/organizations/:organizationId/invitations/:invitationId',
  describeRoute({
    operationId: 'revokeMyOrganizationInvitation',
    tags: ['Organizations'],
    summary: 'Revoke an invitation',
    description:
      'Withdraws a pending invitation: its link stops working. One that was accepted or ' +
      'declined answers `organization.invitation_used`, a withdrawn one ' +
      '`organization.invitation_revoked` and an expired one `organization.invitation_expired` ' +
      `(410). ${manage} ${disabled}`,
    security: openapi.security.session,
    responses: {
      204: { description: 'Revoked.' },
      404: openapi.responses[404],
      410: openapi.responses[410],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_invitations_revoke',
    limit: INVITATIONS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', MemberInvitationParamSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { organizationId, invitationId } = c.req.valid('param')
    await Invitations.revokeAsMember(
      c.get('deps'),
      c.get('tenant'),
      { userId: c.get('session').sub },
      organizationId,
      invitationId,
      userActor(c)
    )
    return c.body(null, 204)
  }
)

const refusals =
  '`organization.invitation_not_found` (404) for a token nothing was issued for; ' +
  '`organization.invitation_expired`, `organization.invitation_revoked` and ' +
  '`organization.invitation_used` (410) for one that can no longer be used.'

router.post(
  '/organization-invitations/preview',
  describeRoute({
    operationId: 'previewOrganizationInvitation',
    tags: ['Organizations'],
    summary: 'Preview an invitation',
    description:
      'What the holder of an invitation’s token may see before signing in: the ' +
      'organization’s name, the role’s key and the address the invitation was sent to, so ' +
      'that a sign-up can be prefilled with it. Needs no session; the token is the proof of ' +
      `having been sent the invitation. Refuses with ${refusals} ${disabled}`,
    security: openapi.security.client,
    responses: {
      200: { description: 'The invitation.', content: json(InvitationPreviewSchema) },
      404: openapi.responses[404],
      410: openapi.responses[410],
      413: openapi.responses[413],
      422: openapi.responses[422],
      403: openapi.responses[403],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
      401: openapi.responses[401],
    },
  }),
  rateLimit({
    name: 'organization_invitations_preview',
    limit: INVITATIONS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  validator('json', InvitationTokenRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      InvitationPreviewSchema.parse(
        await Invitations.preview(c.get('deps'), c.get('tenant'), c.req.valid('json').token)
      )
    )
  }
)

router.post(
  '/me/organization-invitations/accept',
  describeRoute({
    operationId: 'acceptOrganizationInvitation',
    tags: ['Organizations'],
    summary: 'Accept an invitation',
    description:
      'The signed-in user joins the organization with the invitation’s role. Only the ' +
      'account the invitation was sent to may accept it: its **verified** email must be the ' +
      'invited address (`organization.invitation_wrong_account`, ' +
      '`organization.invitation_email_unverified`; 403). The invitation is used up and the ' +
      'membership created in one transaction. A role deleted since the invitation was sent ' +
      'answers `organization.invitation_role_gone` (409): the invitation is never given ' +
      'another role. A user who is a member already answers `organization.member_exists` ' +
      `(409). Refuses with ${refusals} ${disabled}`,
    security: openapi.security.session,
    responses: {
      200: {
        description: 'The organization the user joined, with their role.',
        content: json(AcceptedInvitationSchema),
      },
      404: openapi.responses[404],
      409: openapi.responses[409],
      410: openapi.responses[410],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'organization_invitations_accept',
    limit: INVITATIONS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('json', InvitationTokenRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      AcceptedInvitationSchema.parse(
        await Invitations.accept(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('json').token,
          userActor(c)
        )
      )
    )
  }
)

router.post(
  '/me/organization-invitations/decline',
  describeRoute({
    operationId: 'declineOrganizationInvitation',
    tags: ['Organizations'],
    summary: 'Decline an invitation',
    description:
      'The invitation is used up without a membership. Only the account the invitation was ' +
      'sent to may decline it, on the same conditions as accepting. Refuses with ' +
      `${refusals} ${disabled}`,
    security: openapi.security.session,
    responses: {
      204: { description: 'Declined.' },
      404: openapi.responses[404],
      410: openapi.responses[410],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'organization_invitations_decline',
    limit: INVITATIONS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('json', InvitationTokenRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    await Invitations.decline(
      c.get('deps'),
      c.get('tenant'),
      { userId: c.get('session').sub },
      c.req.valid('json').token,
      userActor(c)
    )
    return c.body(null, 204)
  }
)

router.get(
  '/me/organization-invitations',
  describeRoute({
    operationId: 'listMyPendingOrganizationInvitations',
    tags: ['Organizations'],
    summary: 'List the invitations addressed to me',
    description:
      'The pending, unexpired invitations sent to the signed-in user’s own address, newest ' +
      'first, one page at a time: each one’s `id`, the organization’s name, the role’s key and ' +
      'its expiry, and nothing else (never the token, the address or the inviter). Only a ' +
      '**verified** address matches: a user whose address is unverified, or who has none, gets ' +
      'an empty page. Answer one with `POST /v1/client/me/organization-invitations/{invitationId}/accept` ' +
      `or \`…/decline\`. ${disabled}`,
    security: openapi.security.session,
    responses: {
      200: {
        description: 'One page of invitations.',
        content: json(MyOrganizationInvitationListSchema),
      },
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_invitations_pending',
    limit: INVITATIONS_READ_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('query', MyOrganizationInvitationQuerySchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      MyOrganizationInvitationListSchema.parse(
        await Invitations.listMine(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('query')
        )
      )
    )
  }
)

router.post(
  '/me/organization-invitations/:invitationId/accept',
  describeRoute({
    operationId: 'acceptMyOrganizationInvitation',
    tags: ['Organizations'],
    summary: 'Accept an invitation addressed to me',
    description:
      'As `acceptOrganizationInvitation`, for an invitation the user found in their own list ' +
      '(`listMyPendingOrganizationInvitations`) and so holds no token for. The session ' +
      'authorizes it: the invitation must have been sent to the user’s own **verified** ' +
      'address. An id that is not theirs, and one that does not exist, both answer ' +
      '`organization.invitation_not_found` (404). Refuses an unverified address with ' +
      '`organization.invitation_email_unverified` (403) and a used-up one with ' +
      `\`…_expired\`, \`…_revoked\` or \`…_used\` (410). ${disabled}`,
    security: openapi.security.session,
    responses: {
      200: {
        description: 'The organization the user joined, with their role.',
        content: json(AcceptedInvitationSchema),
      },
      404: openapi.responses[404],
      409: openapi.responses[409],
      410: openapi.responses[410],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_invitation_accept',
    limit: INVITATIONS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', MyInvitationParamSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      AcceptedInvitationSchema.parse(
        await Invitations.acceptById(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('param').invitationId,
          userActor(c)
        )
      )
    )
  }
)

router.post(
  '/me/organization-invitations/:invitationId/decline',
  describeRoute({
    operationId: 'declineMyOrganizationInvitation',
    tags: ['Organizations'],
    summary: 'Decline an invitation addressed to me',
    description:
      'As `declineOrganizationInvitation`, for an invitation the user found in their own list. ' +
      'The conditions are those of `acceptMyOrganizationInvitation`. ' +
      disabled,
    security: openapi.security.session,
    responses: {
      204: { description: 'Declined.' },
      404: openapi.responses[404],
      410: openapi.responses[410],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organization_invitation_decline',
    limit: INVITATIONS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', MyInvitationParamSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    await Invitations.declineById(
      c.get('deps'),
      c.get('tenant'),
      { userId: c.get('session').sub },
      c.req.valid('param').invitationId,
      userActor(c)
    )
    return c.body(null, 204)
  }
)

export default router
