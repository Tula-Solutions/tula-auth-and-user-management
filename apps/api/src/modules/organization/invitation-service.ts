import {
  type AcceptedInvitation,
  type CreateOrganizationInvitationRequest,
  durationToMs,
  INVITATION_EXPIRY_DAYS,
  INVITATIONS_MANAGE_PERMISSION,
  type InvitationPreview,
  type InvitationStatus,
  ORGANIZATION_INVITATION_TOKEN_PARAM,
  type OrganizationInvitation,
  type OrganizationInvitationList,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, InvalidEmailError, NotFoundError, RateLimitError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import { randomToken, sha256Hex } from '~/lib/crypto'
import { parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Mailer from '~/modules/organization/mailer'
import { requireEnabled, requireRole } from '~/modules/organization/service'
import * as Settings from '~/modules/settings/service'
import type {
  InvitationRecord,
  PageCriteria,
  UserMembershipRecord,
} from '~/ports/organization-store'

// Invitations to an organization (ADR 0065, Orgs 04). Every entry point starts with
// `requireEnabled`. The token travels in the emailed link's fragment and is stored only as its
// SHA-256; it is never in a response, an event, an audit entry or a log line. A route of a
// signed-in member re-reads the membership and its role's permissions on every call: the
// token's `org_perms` claims are never what decides.

/**
 * Invitations one organization may send in an hour, through either route. An invitation is an
 * email to an address the inviter chose, so the count is what stops a compromised member or
 * key from using the server to mail strangers.
 */
export const INVITATIONS_PER_ORGANIZATION_PER_HOUR = 50

/** Invitations one environment may send in a day, all its organizations together. */
export const INVITATIONS_PER_ENVIRONMENT_PER_DAY = 1000

const HOUR_MS = durationToMs('1h')
const DAY_MS = durationToMs('1d')

type ReadDeps = Pick<Deps, 'organizations' | 'environmentSettings' | 'config' | 'clock'>
type WriteDeps = ReadDeps & Pick<Deps, 'ids'>

/** The signed-in user who calls a member's route, from the verified access token. */
export interface Member {
  userId: string
}

/** The public view of a stored invitation. `expired` is a pending one past its expiry. */
function view(record: InvitationRecord, now: Date): OrganizationInvitation {
  const expired = record.status === 'pending' && record.expiresAt.getTime() <= now.getTime()
  return {
    id: record.id,
    organizationId: record.organizationId,
    email: record.email,
    role: record.roleKey,
    status: expired ? 'expired' : record.status,
    invitedBy: record.invitedBy,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  }
}

/** The 404 every route answers for an organization that is not this environment's. */
async function requireOrganization(
  deps: Pick<Deps, 'organizations'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
) {
  const organization = await deps.organizations.find(tenant.environmentId, id)
  if (!organization) {
    throw new NotFoundError()
  }
  return organization
}

/**
 * The calling member's membership, which must hold `org:sys:invitations:manage` **now**.
 *
 * Read from the store on every call, never from the access token's claims: a demotion or a
 * removal takes effect here at once, not at the token's next refresh.
 *
 * @throws AuthError `organization.not_a_member` for an organization the user is not in, and
 *   for one that does not exist or is another environment's, alike.
 * @throws AuthError `organization.permission_required` when their role lacks the permission.
 */
async function requireManager(
  deps: Pick<Deps, 'organizations'>,
  tenant: Pick<Tenant, 'environmentId'>,
  member: Member,
  organizationId: string
): Promise<UserMembershipRecord> {
  const held = await deps.organizations.findUserMembership(
    tenant.environmentId,
    organizationId,
    member.userId
  )
  if (!held) {
    throw new AuthError('organization.not_a_member')
  }
  if (!held.permissions.includes(INVITATIONS_MANAGE_PERMISSION)) {
    throw new AuthError('organization.permission_required', {
      permission: INVITATIONS_MANAGE_PERMISSION,
    })
  }
  return held
}

/** Count an invitation against the organization's hour and the environment's day. */
async function charge(
  deps: Pick<Deps, 'rateLimiter'>,
  tenant: Pick<Tenant, 'environmentId'>,
  organizationId: string
): Promise<void> {
  const hour = await deps.rateLimiter.hit(
    `organization_invitations:${tenant.environmentId}:${organizationId}`,
    INVITATIONS_PER_ORGANIZATION_PER_HOUR,
    HOUR_MS
  )
  if (!hour.allowed) {
    throw new RateLimitError(hour.retryAfterMs)
  }
  const day = await deps.rateLimiter.hit(
    `organization_invitations_environment:${tenant.environmentId}`,
    INVITATIONS_PER_ENVIRONMENT_PER_DAY,
    DAY_MS
  )
  if (!day.allowed) {
    throw new RateLimitError(day.retryAfterMs)
  }
}

/**
 * List an organization's invitations, newest first. Admin API.
 *
 * @param deps - The organization store, the settings and the clock.
 * @param tenant - The environment.
 * @param organizationId - The organization.
 * @param query - Which state to list and which page.
 * @returns The page and its paging details.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the environment has no organization with that id.
 */
export async function list(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  organizationId: string,
  query: PageCriteria & { status: InvitationStatus }
): Promise<OrganizationInvitationList> {
  await requireEnabled(deps, tenant)
  await requireOrganization(deps, tenant, organizationId)
  const now = deps.clock.now()
  const { records, total } = await deps.organizations.listInvitations(
    tenant.environmentId,
    organizationId,
    query.status,
    now,
    query
  )
  return {
    meta: {
      totalCount: total,
      totalPages: Math.ceil(total / query.size),
      page: query.page,
      perPage: query.size,
    },
    data: records.map((record) => view(record, now)),
  }
}

/**
 * List the invitations of an organization the signed-in user manages invitations for.
 *
 * @param deps - As {@link list}.
 * @param tenant - The environment.
 * @param member - The signed-in user.
 * @param organizationId - The organization.
 * @param query - Which state to list and which page.
 * @returns The page and its paging details.
 * @throws AuthError `organization.disabled`, `organization.not_a_member`,
 *   `organization.permission_required`.
 */
export async function listAsMember(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  member: Member,
  organizationId: string,
  query: PageCriteria & { status: InvitationStatus }
): Promise<OrganizationInvitationList> {
  await requireEnabled(deps, tenant)
  await requireManager(deps, tenant, member, organizationId)
  return list(deps, tenant, organizationId, query)
}

/** The link the email carries: the redirect URL and the token in its fragment. */
function linkFor(redirectUrl: string, token: string): string {
  return `${redirectUrl}#${ORGANIZATION_INVITATION_TOKEN_PARAM}=${encodeURIComponent(token)}`
}

/**
 * Invite an address to an organization with a role, and email it the link.
 *
 * The role must exist (`organization.role_unknown`) and `redirectUrl` must be one of the
 * environment's allowed redirect URLs (`request.redirect_not_allowed`; never a custom scheme).
 * An address that is a member already is `organization.member_exists` and one with a pending,
 * unexpired invitation `organization.invitation_exists`. The invitation lasts
 * {@link INVITATION_EXPIRY_DAYS} days. If the email cannot be sent the invitation is withdrawn
 * again, so that a retry is not met with `invitation_exists`.
 *
 * @param deps - The stores, the settings, the rate limiter, the mailer, ids and clock.
 * @param tenant - The environment.
 * @param organizationId - The organization.
 * @param input - The address, the role's key and the redirect URL.
 * @param actor - Who invites, for the audit log.
 * @param by - The inviting member, with the permissions of their role as read now: the role
 *   offered must not hold a permission they lack. `null` for the admin API, which may offer any.
 * @returns The invitation. The token is not in it.
 * @throws AuthError `organization.disabled`, `organization.role_unknown`,
 *   `organization.role_not_assignable`, `organization.member_exists`,
 *   `organization.invitation_exists`, `request.redirect_not_allowed`.
 * @throws InvalidEmailError when the address is not an address.
 * @throws RateLimitError past the organization's hour or the environment's day.
 * @throws NotFoundError when the environment has no organization with that id.
 */
export async function invite(
  deps: WriteDeps & Pick<Deps, 'users' | 'rateLimiter' | 'mailer'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  organizationId: string,
  input: CreateOrganizationInvitationRequest,
  actor: Actor,
  by: { userId: string; permissions: readonly string[] } | null
): Promise<OrganizationInvitation> {
  await requireEnabled(deps, tenant)
  const organization = await requireOrganization(deps, tenant, organizationId)
  const parsed = parseEmail(input.email)
  if (!parsed) {
    throw new InvalidEmailError()
  }
  // A custom scheme is refused as for an emailed sign-in link: the page is a web page or an
  // app link, and the email is read on any device.
  const redirectUrl = await Settings.requireRedirectUrl(deps, tenant, input.redirectUrl, {
    client: 'web',
  })
  const role = await requireRole(deps, tenant, input.role)
  if (by && !role.permissions.every((permission) => by.permissions.includes(permission))) {
    // Otherwise a member who may only invite could invite their own second address as an
    // administrator.
    throw new AuthError('organization.role_not_assignable')
  }
  const existing = await deps.users.findByEmail(tenant.environmentId, parsed.normalized)
  if (
    existing &&
    (await deps.organizations.findMembership(tenant.environmentId, organizationId, existing.id))
  ) {
    throw new AuthError('organization.member_exists')
  }
  await charge(deps, tenant, organizationId)

  const now = deps.clock.now()
  const id = deps.ids.next()
  const token = randomToken()
  const activity = Audit.entry(deps, tenant, {
    type: 'organization_invitation.created',
    actor,
    target: { type: 'organization_invitation', id },
    data: { organizationId, role: role.key },
  })
  const result = await deps.organizations.insertInvitation(
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId,
      email: parsed.email,
      emailNormalized: parsed.normalized,
      roleKey: role.key,
      tokenHash: sha256Hex(token),
      status: 'pending',
      invitedBy: by?.userId ?? null,
      expiresAt: new Date(now.getTime() + INVITATION_EXPIRY_DAYS * DAY_MS),
      resolvedAt: null,
      resolvedBy: null,
      createdAt: activity.occurredAt,
      updatedAt: activity.occurredAt,
    },
    now,
    activity
  )
  if (result.outcome === 'exists') {
    throw new AuthError('organization.invitation_exists')
  }
  if (result.outcome === 'gone') {
    throw new NotFoundError()
  }
  try {
    await Mailer.sendInvitation(deps, tenant, {
      to: parsed.email,
      organizationName: organization.name,
      linkUrl: linkFor(redirectUrl, token),
      ttlDays: INVITATION_EXPIRY_DAYS,
    })
  } catch (error) {
    // The address never got the link: withdraw the invitation so that asking again works. The
    // message holds the link, so only the fact is logged.
    logger.warn('an organization invitation could not be emailed and was withdrawn', {
      environmentId: tenant.environmentId,
      organizationId,
    })
    await withdraw(deps, tenant, organizationId, id, actor, role.key)
    throw error
  }
  return view(result.record, now)
}

/** Withdraw an invitation the service just stored, after its email failed. Best effort. */
async function withdraw(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  organizationId: string,
  id: string,
  actor: Actor,
  role: string
): Promise<void> {
  try {
    await deps.organizations.revokeInvitation(
      tenant.environmentId,
      organizationId,
      id,
      deps.clock.now(),
      Audit.entry(deps, tenant, {
        type: 'organization_invitation.revoked',
        actor,
        target: { type: 'organization_invitation', id },
        data: { organizationId, role },
      })
    )
  } catch {
    // Left pending: it expires, and the send error below is the one the caller needs.
  }
}

/**
 * Invite an address as a signed-in member whose role holds `org:sys:invitations:manage`
 * (read now), to a role whose permissions they hold themselves.
 *
 * @param deps - As {@link invite}.
 * @param tenant - The environment.
 * @param member - The signed-in user.
 * @param organizationId - The organization.
 * @param input - The address, the role's key and the redirect URL.
 * @param actor - The user, for the audit log.
 * @returns The invitation.
 * @throws AuthError `organization.not_a_member`, `organization.permission_required`, and
 *   what {@link invite} throws.
 */
export async function inviteAsMember(
  deps: Parameters<typeof invite>[0],
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  member: Member,
  organizationId: string,
  input: CreateOrganizationInvitationRequest,
  actor: Actor
): Promise<OrganizationInvitation> {
  await requireEnabled(deps, tenant)
  const held = await requireManager(deps, tenant, member, organizationId)
  return invite(deps, tenant, organizationId, input, actor, {
    userId: member.userId,
    permissions: held.permissions,
  })
}

/**
 * Withdraw a pending invitation: its link stops working.
 *
 * @param deps - The organization store, the settings, ids and clock.
 * @param tenant - The environment.
 * @param organizationId - The organization.
 * @param invitationId - The invitation.
 * @param actor - Who withdraws it, for the audit log.
 * @throws AuthError `organization.disabled`, and `organization.invitation_used`,
 *   `organization.invitation_revoked` or `organization.invitation_expired` for an invitation
 *   that is no longer pending.
 * @throws NotFoundError when the organization has no invitation with that id.
 */
export async function revoke(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  organizationId: string,
  invitationId: string,
  actor: Actor
): Promise<void> {
  await requireEnabled(deps, tenant)
  await requireOrganization(deps, tenant, organizationId)
  const current = await deps.organizations.findInvitation(
    tenant.environmentId,
    organizationId,
    invitationId
  )
  if (!current) {
    throw new NotFoundError()
  }
  const result = await deps.organizations.revokeInvitation(
    tenant.environmentId,
    organizationId,
    invitationId,
    deps.clock.now(),
    Audit.entry(deps, tenant, {
      type: 'organization_invitation.revoked',
      actor,
      target: { type: 'organization_invitation', id: invitationId },
      data: { organizationId, role: current.roleKey },
    })
  )
  if (result.outcome === 'not_found') {
    throw new NotFoundError()
  }
  if (result.outcome === 'unavailable') {
    throw unavailable(result.record, deps.clock.now())
  }
}

/**
 * Withdraw an invitation as a signed-in member whose role holds `org:sys:invitations:manage`.
 *
 * @param deps - As {@link revoke}.
 * @param tenant - The environment.
 * @param member - The signed-in user.
 * @param organizationId - The organization.
 * @param invitationId - The invitation.
 * @param actor - The user, for the audit log.
 * @throws AuthError `organization.not_a_member`, `organization.permission_required`, and
 *   what {@link revoke} throws.
 */
export async function revokeAsMember(
  deps: WriteDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  member: Member,
  organizationId: string,
  invitationId: string,
  actor: Actor
): Promise<void> {
  await requireEnabled(deps, tenant)
  await requireManager(deps, tenant, member, organizationId)
  await revoke(deps, tenant, organizationId, invitationId, actor)
}

/** The error for an invitation that can no longer be accepted, declined or withdrawn. */
function unavailable(record: InvitationRecord, now: Date): AuthError {
  switch (record.status) {
    case 'revoked':
      return new AuthError('organization.invitation_revoked')
    case 'accepted':
    case 'declined':
      return new AuthError('organization.invitation_used')
    case 'pending':
      // Still pending in the store: only its time can have run out.
      return record.expiresAt.getTime() <= now.getTime()
        ? new AuthError('organization.invitation_expired')
        : new AuthError('organization.invitation_not_found')
  }
}

/**
 * The invitation a presented token belongs to, which must still be open.
 *
 * @throws AuthError `organization.invitation_not_found` for a token nothing was issued for,
 *   and `organization.invitation_expired`, `organization.invitation_revoked` or
 *   `organization.invitation_used` for one that can no longer be used.
 */
async function openInvitation(
  deps: Pick<Deps, 'organizations' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  token: string
): Promise<InvitationRecord> {
  const record = await deps.organizations.findInvitationByTokenHash(
    tenant.environmentId,
    sha256Hex(token)
  )
  if (!record) {
    throw new AuthError('organization.invitation_not_found')
  }
  const now = deps.clock.now()
  if (record.status !== 'pending' || record.expiresAt.getTime() <= now.getTime()) {
    throw unavailable(record, now)
  }
  return record
}

/**
 * What the holder of an invitation's token may see before signing in: the organization's
 * name, the role's key and the address it was sent to (to prefill a sign-up).
 *
 * @param deps - The organization store, the settings and the clock.
 * @param tenant - The environment.
 * @param token - The token from the link's fragment.
 * @returns The preview.
 * @throws AuthError `organization.disabled` and the errors of an invitation that cannot be
 *   used: `organization.invitation_not_found`, `…_expired`, `…_revoked`, `…_used`.
 */
export async function preview(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  token: string
): Promise<InvitationPreview> {
  await requireEnabled(deps, tenant)
  const record = await openInvitation(deps, tenant, token)
  const organization = await deps.organizations.find(tenant.environmentId, record.organizationId)
  if (!organization) {
    throw new AuthError('organization.invitation_not_found')
  }
  return {
    organizationName: organization.name,
    role: record.roleKey,
    email: record.email,
    expiresAt: record.expiresAt.toISOString(),
  }
}

/**
 * Refuse an invitation to anyone but the account it was sent to: the signed-in user's address
 * must be the invited one **and verified**. A link forwarded to someone else joins nothing,
 * and an unproven address (an account made by an administrator, say) is not the invitee.
 */
async function requireInvitee(
  deps: Pick<Deps, 'users'>,
  tenant: Pick<Tenant, 'environmentId'>,
  member: Member,
  record: InvitationRecord
): Promise<void> {
  const user = await deps.users.findById(tenant.environmentId, member.userId)
  if (!user || user.emailNormalized !== record.emailNormalized) {
    throw new AuthError('organization.invitation_wrong_account')
  }
  if (!user.emailVerifiedAt) {
    throw new AuthError('organization.invitation_email_unverified')
  }
}

/**
 * Accept an invitation: the signed-in user becomes a member with the invitation's role. The
 * invitation is used up and the membership stored in one transaction, with an audit entry for
 * each.
 *
 * If the role was deleted since the invitation was sent, it is refused
 * (`organization.invitation_role_gone`) and stays pending: it is **never** given another role,
 * which could grant more than the inviter meant. The inviter withdraws it and invites again.
 *
 * @param deps - The stores, the settings, ids and clock.
 * @param tenant - The environment.
 * @param member - The signed-in user.
 * @param token - The token from the link's fragment.
 * @param actor - The user, for the audit log.
 * @returns The organization the user joined, with their role and its permissions.
 * @throws AuthError `organization.disabled`, `organization.invitation_not_found`,
 *   `…_expired`, `…_revoked`, `…_used`, `…_wrong_account`, `…_email_unverified`,
 *   `…_role_gone` and `organization.member_exists`.
 */
export async function accept(
  deps: WriteDeps & Pick<Deps, 'users'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  member: Member,
  token: string,
  actor: Actor
): Promise<AcceptedInvitation> {
  await requireEnabled(deps, tenant)
  const record = await openInvitation(deps, tenant, token)
  await requireInvitee(deps, tenant, member, record)
  const role = await deps.organizations.findRole(tenant.environmentId, record.roleKey)
  if (!role) {
    throw new AuthError('organization.invitation_role_gone')
  }
  const now = deps.clock.now()
  const membershipId = deps.ids.next()
  const result = await deps.organizations.acceptInvitation(
    tenant.environmentId,
    record.id,
    {
      id: membershipId,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId: record.organizationId,
      userId: member.userId,
      roleId: role.id,
      roleKey: role.key,
      createdAt: now,
      updatedAt: now,
    },
    now,
    {
      invitation: Audit.entry(deps, tenant, {
        type: 'organization_invitation.accepted',
        actor,
        target: { type: 'organization_invitation', id: record.id },
        data: { organizationId: record.organizationId, role: role.key, userId: member.userId },
      }),
      membership: Audit.entry(deps, tenant, {
        type: 'organization_membership.added',
        actor,
        target: { type: 'organization_membership', id: membershipId },
        data: { organizationId: record.organizationId, userId: member.userId, role: role.key },
      }),
    }
  )
  switch (result.outcome) {
    case 'accepted':
      break
    case 'unavailable':
      throw unavailable(result.record, now)
    case 'not_found':
    case 'gone':
      // Deleted between the read and the write: the organization, the user or the invitation.
      throw new AuthError('organization.invitation_not_found')
    case 'duplicate':
      throw new AuthError('organization.member_exists')
  }
  const joined = await deps.organizations.findUserMembership(
    tenant.environmentId,
    record.organizationId,
    member.userId
  )
  if (!joined) {
    throw new AuthError('organization.invitation_not_found')
  }
  const { organization, membership, permissions } = joined
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role: membership.roleKey,
    permissions: [...permissions],
    createdAt: organization.createdAt.toISOString(),
  }
}

/**
 * Decline an invitation. Only the account it was sent to may: the same checks as accepting
 * (but a role that was deleted does not matter).
 *
 * @param deps - The stores, the settings, ids and clock.
 * @param tenant - The environment.
 * @param member - The signed-in user.
 * @param token - The token from the link's fragment.
 * @param actor - The user, for the audit log.
 * @throws AuthError `organization.disabled`, `organization.invitation_not_found`,
 *   `…_expired`, `…_revoked`, `…_used`, `…_wrong_account` and `…_email_unverified`.
 */
export async function decline(
  deps: WriteDeps & Pick<Deps, 'users'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  member: Member,
  token: string,
  actor: Actor
): Promise<void> {
  await requireEnabled(deps, tenant)
  const record = await openInvitation(deps, tenant, token)
  await requireInvitee(deps, tenant, member, record)
  const now = deps.clock.now()
  const result = await deps.organizations.declineInvitation(
    tenant.environmentId,
    record.id,
    member.userId,
    now,
    Audit.entry(deps, tenant, {
      type: 'organization_invitation.declined',
      actor,
      target: { type: 'organization_invitation', id: record.id },
      data: { organizationId: record.organizationId, role: record.roleKey, userId: member.userId },
    })
  )
  if (result.outcome === 'not_found') {
    throw new AuthError('organization.invitation_not_found')
  }
  if (result.outcome === 'unavailable') {
    throw unavailable(result.record, now)
  }
}
