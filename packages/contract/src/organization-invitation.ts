import { z } from 'zod'
import { RoleKeySchema, UserOrganizationSchema } from './organization'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PaginationMetaSchema } from './user'

// Invitations to an organization (ADR 0065, Orgs 04): an administrator, or a member whose role
// holds `org:sys:invitations:manage`, invites an email address with a role; the address is
// sent a link, and the signed-in user whose verified email is that address accepts or declines.
// The token in the link is the invitation's only secret: it is never in an API answer, an
// event or a log line.

/**
 * How long an invitation can be accepted after it was sent, in days. After that it is
 * `expired`, and the retention job deletes it a while later.
 *
 * @example
 * ```ts
 * new Date(sentAt.getTime() + INVITATION_EXPIRY_DAYS * 86_400_000)
 * ```
 */
export const INVITATION_EXPIRY_DAYS = 7

/** Longest redirect URL or token the request accepts, in characters. */
const MAX_LINK_FIELD_LENGTH = 2048

/**
 * The states of an invitation. `pending` is the only one that can be accepted. `expired` is
 * not stored: it is a `pending` invitation whose time has passed.
 *
 * @example
 * ```ts
 * INVITATION_STATUSES.includes('pending') // true
 * ```
 */
export const INVITATION_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'revoked',
  'expired',
] as const

/** One of {@link INVITATION_STATUSES}. */
export type InvitationStatus = (typeof INVITATION_STATUSES)[number]

/** An invitation as the admin API and the inviting members' routes return it. */
export const OrganizationInvitationSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    /** The invited address, as it was typed. */
    email: z.string(),
    /** The key of the role the invitee gets on accepting. */
    role: z.string(),
    status: z.enum(INVITATION_STATUSES),
    /** The user who invited them; `null` when an administrator did, through the admin API. */
    invitedBy: z.string().nullable(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .meta({ ref: 'OrganizationInvitation' })

/** One page of an organization's invitations, newest first. */
export const OrganizationInvitationListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(OrganizationInvitationSchema) })
  .meta({ ref: 'OrganizationInvitationList' })

/**
 * The query of a list of invitations: a page, and the state to list (`pending` unless
 * another is asked for).
 */
export const OrganizationInvitationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    status: z.enum(INVITATION_STATUSES).default('pending'),
  })
  .meta({ ref: 'OrganizationInvitationQuery' })

/**
 * Invite an address to an organization with a role.
 *
 * `redirectUrl` is where the emailed link leads: it must be one of the environment's allowed
 * redirect URLs (matched exactly), an `https` address or loopback in the `local` tier; a
 * custom scheme is refused, so a native app opens its page through an app link. The link is
 * the URL followed by `#tula_invitation=<token>`.
 */
export const CreateOrganizationInvitationRequestSchema = z
  .strictObject({
    email: z.string().max(320),
    role: RoleKeySchema,
    redirectUrl: z.string().max(MAX_LINK_FIELD_LENGTH),
  })
  .meta({ ref: 'CreateOrganizationInvitationRequest' })

/**
 * The token of an invitation, as the link carried it (`#tula_invitation=…`). What `preview`,
 * `accept` and `decline` send.
 */
export const InvitationTokenRequestSchema = z
  .strictObject({ token: z.string().min(1).max(MAX_LINK_FIELD_LENGTH) })
  .meta({ ref: 'InvitationTokenRequest' })

/**
 * What the holder of an invitation's token may see before signing in: which organization
 * invites them, as which role, and the address it was sent to (so that a sign-up can be
 * prefilled with it). Answered for a pending invitation only; the token is the proof of
 * having been sent it.
 */
export const InvitationPreviewSchema = z
  .object({
    organizationName: z.string(),
    /** The key of the role the invitee gets. */
    role: z.string(),
    /** The invited address, to prefill a sign-up with. */
    email: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ ref: 'InvitationPreview' })

/** What accepting an invitation answers: the organization the user joined, with their role. */
export const AcceptedInvitationSchema = UserOrganizationSchema.meta({ ref: 'AcceptedInvitation' })

/** An invitation. */
export type OrganizationInvitation = z.infer<typeof OrganizationInvitationSchema>
/** A page of invitations. */
export type OrganizationInvitationList = z.infer<typeof OrganizationInvitationListSchema>
/** The body that invites an address. */
export type CreateOrganizationInvitationRequest = z.infer<
  typeof CreateOrganizationInvitationRequestSchema
>
/** The body that carries an invitation's token. */
export type InvitationTokenRequest = z.infer<typeof InvitationTokenRequestSchema>
/** What the token's holder may see before signing in. */
export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>
/** The organization a user joined by accepting. */
export type AcceptedInvitation = z.infer<typeof AcceptedInvitationSchema>
