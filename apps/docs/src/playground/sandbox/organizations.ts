import {
  BUILT_IN_ROLES,
  DOMAINS_MANAGE_PERMISSION,
  INVITATIONS_MANAGE_PERMISSION,
  MEMBERSHIPS_MANAGE_PERMISSION,
  MEMBERSHIPS_READ_PERMISSION,
  ORGANIZATION_DELETE_PERMISSION,
  ORGANIZATION_MANAGE_PERMISSION,
} from '@tula-tech/contract/organization-permissions'
import type { Operations, Schemas } from './api-types'
import { SandboxError } from './errors'
import {
  type Answer,
  accessTokenFor,
  authenticate,
  type Context,
  email,
  redirect,
  text,
} from './helpers'
import type {
  SandboxDomain,
  SandboxInvitation,
  SandboxMember,
  SandboxOrganization,
  SandboxRole,
  SandboxUser,
} from './types'
import { ACCESS_TOKEN_TTL_MS, normalizeEmail, type World } from './world'

// Organizations (ADR 0065) as the sandbox answers them: members with the two built-in roles,
// invitations, claimed domains and the active organization of a session. The rules a visitor
// can run into are the real server's: a role's permissions decide what a route allows, the last
// member who can manage members cannot leave or be demoted, a domain is claimed with an emailed
// code (six digits, five guesses, ten minutes), an invitation is answered by the account it was
// sent to. What it does not simulate: custom roles, the number of organizations a user may
// create, and anything a person on another device would do (the sandbox has one browser).

/** The operations this file answers. */
type OrganizationOperation =
  | 'listMyOrganizations'
  | 'createMyOrganization'
  | 'setActiveOrganization'
  | 'updateMyOrganization'
  | 'deleteMyOrganization'
  | 'listMyOrganizationMembers'
  | 'listMyOrganizationRoles'
  | 'updateMyOrganizationMember'
  | 'removeMyOrganizationMember'
  | 'listMyOrganizationSuggestions'
  | 'joinOrganizationSuggestion'
  | 'listMyOrganizationDomains'
  | 'startMyOrganizationDomain'
  | 'verifyMyOrganizationDomain'
  | 'updateMyOrganizationDomain'
  | 'removeMyOrganizationDomain'
  | 'listMyOrganizationInvitations'
  | 'inviteToMyOrganization'
  | 'revokeMyOrganizationInvitation'
  | 'previewOrganizationInvitation'
  | 'acceptOrganizationInvitation'
  | 'declineOrganizationInvitation'

/** How long a domain code and an invitation live. */
const CODE_TTL_MS = 10 * 60_000
const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000
/** Wrong guesses a domain code allows. */
const DOMAIN_CODE_GUESSES = 5
/** Domains one organization may claim. */
const MAX_DOMAINS = 5
/** Domains no organization can claim: shared by everyone. */
const PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'icloud.com',
  'proton.me',
])

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/

function iso(at: number): string {
  return new Date(at).toISOString()
}

function invalid(field: string, message: string): SandboxError {
  return new SandboxError('validation.failed', {
    fields: [{ field, code: 'validation.failed', message }],
  })
}

function permissionsOf(role: SandboxRole): readonly string[] {
  return BUILT_IN_ROLES.find((one) => one.key === role)?.permissions ?? []
}

function role(value: unknown): SandboxRole {
  if (value === 'admin' || value === 'member') {
    return value
  }
  throw new SandboxError('organization.role_unknown')
}

/** Refuse unless the environment has organizations on. */
function requireOn(world: World): void {
  if (!world.settings.organizations) {
    throw new SandboxError('organization.disabled')
  }
}

/** The organization and the caller's membership of it. */
function membership(
  ctx: Pick<Context<keyof Operations>, 'world' | 'accessToken'>,
  organizationId: string
): { user: SandboxUser; organization: SandboxOrganization; member: SandboxMember } {
  requireOn(ctx.world)
  const { user } = authenticate(ctx)
  const organization = ctx.world.organizations.get(organizationId)
  const member = organization?.members.find((one) => one.userId === user.id)
  if (!(organization && member)) {
    // Also what an organization that does not exist answers: it says nothing about what does.
    throw new SandboxError('organization.not_a_member')
  }
  return { user, organization, member }
}

/** Refuse unless the caller's role holds one of the permissions. */
function requireAny(member: SandboxMember, ...permissions: string[]): void {
  const held = permissionsOf(member.role)
  if (!permissions.some((permission) => held.includes(permission))) {
    throw new SandboxError('organization.permission_required', {
      params: { permission: permissions[0] ?? '' },
    })
  }
}

function view(
  organization: SandboxOrganization,
  member: SandboxMember
): Schemas['UserOrganization'] {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role: member.role,
    permissions: [...permissionsOf(member.role)],
    createdAt: organization.createdAt,
  }
}

function meta(count: number): Schemas['PaginationMeta'] {
  return { totalCount: count, totalPages: 1, page: 1, perPage: Math.max(count, 25) }
}

/** Members who can manage members, other than `except`. */
function otherManagers(organization: SandboxOrganization, except: string): number {
  return organization.members.filter(
    (one) =>
      one.userId !== except && permissionsOf(one.role).includes(MEMBERSHIPS_MANAGE_PERMISSION)
  ).length
}

function name(value: unknown): string {
  const trimmed = text(value, 'name').trim()
  if (trimmed.length > 64) {
    throw invalid('name', 'Use at most 64 characters.')
  }
  return trimmed
}

function slug(world: World, value: unknown, except: string | null): string {
  const given = text(value, 'slug').trim()
  if (!SLUG.test(given) || given.length > 48) {
    throw invalid('slug', 'Use lower-case letters, digits and hyphens, up to 48 characters.')
  }
  for (const other of world.organizations.values()) {
    if (other.slug === given && other.id !== except) {
      throw new SandboxError('organization.slug_taken')
    }
  }
  return given
}

function memberView(world: World, member: SandboxMember): Schemas['OrganizationMember'] {
  const user = world.users.get(member.userId)
  const full = [user?.firstName, user?.lastName].filter(Boolean).join(' ')
  return {
    userId: member.userId,
    name: full === '' ? null : full,
    email: user?.email ?? null,
    role: member.role,
    createdAt: member.createdAt,
  }
}

function invitationView(invitation: SandboxInvitation, organizationId: string) {
  return {
    id: invitation.id,
    organizationId,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invitedBy: invitation.invitedBy,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  } satisfies Schemas['OrganizationInvitation']
}

function domainView(domain: SandboxDomain): Schemas['OrganizationDomain'] {
  return {
    id: domain.id,
    domain: domain.domain,
    mode: domain.mode,
    status: domain.verifiedAt === null ? 'pending' : 'verified',
    verifiedAt: domain.verifiedAt,
    // A verification lasts a year (the sandbox's clock never gets that far in a visit).
    expiresAt:
      domain.verifiedAt === null ? null : iso(Date.parse(domain.verifiedAt) + 365 * 86_400_000),
    codeExpiresAt: domain.codeExpiresAt === null ? null : iso(domain.codeExpiresAt),
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
  }
}

/** The pending invitation a token names, with its organization, or the reason it is no use. */
function invitationOf(
  world: World,
  token: unknown
): { organization: SandboxOrganization; invitation: SandboxInvitation } {
  requireOn(world)
  const given = text(token, 'token')
  for (const organization of world.organizations.values()) {
    const invitation = organization.invitations.find((one) => one.token === given)
    if (!invitation) {
      continue
    }
    if (invitation.status === 'revoked') {
      throw new SandboxError('organization.invitation_revoked')
    }
    if (invitation.status === 'accepted' || invitation.status === 'declined') {
      throw new SandboxError('organization.invitation_used')
    }
    if (invitation.status === 'expired' || Date.parse(invitation.expiresAt) <= world.now()) {
      throw new SandboxError('organization.invitation_expired')
    }
    return { organization, invitation }
  }
  throw new SandboxError('organization.invitation_not_found')
}

/** The account an invitation was sent to: the signed-in user, with a verified address. */
function inviteeOf(
  ctx: Pick<Context<keyof Operations>, 'world' | 'accessToken'>,
  invitation: SandboxInvitation
): SandboxUser {
  const { user } = authenticate(ctx)
  if (normalizeEmail(user.email) !== normalizeEmail(invitation.email)) {
    throw new SandboxError('organization.invitation_wrong_account')
  }
  if (user.emailVerifiedAt === null) {
    throw new SandboxError('organization.invitation_email_unverified')
  }
  return user
}

/** The organizations a verified domain of the user's own address offers them to join. */
function suggestionsFor(world: World, user: SandboxUser): SandboxOrganization[] {
  const at = user.email.lastIndexOf('@')
  if (at < 0 || user.emailVerifiedAt === null) {
    return []
  }
  const domain = user.email.slice(at + 1).toLowerCase()
  return [...world.organizations.values()].filter(
    (organization) =>
      !organization.members.some((one) => one.userId === user.id) &&
      organization.domains.some(
        (claim) => claim.domain === domain && claim.verifiedAt !== null && claim.mode === 'suggest'
      )
  )
}

function domainOf(organization: SandboxOrganization, domainId: string): SandboxDomain {
  const domain = organization.domains.find((one) => one.id === domainId)
  if (!domain) {
    // The route has no better word for a claim that does not exist.
    throw new SandboxError('organization.not_a_member')
  }
  return domain
}

function mode(value: unknown): Schemas['OrganizationDomainMode'] {
  if (value === 'suggest' || value === 'auto_join') {
    return value
  }
  throw invalid('mode', 'Choose what a verified address does.')
}

/**
 * The sandbox's answers for organizations, merged into the handler table.
 */
export const ORGANIZATION_HANDLERS: {
  [Id in OrganizationOperation]: (ctx: Context<Id>) => Answer<Id>
} = {
  listMyOrganizations: (ctx) => {
    requireOn(ctx.world)
    const { user, session } = authenticate(ctx)
    const mine = [...ctx.world.organizations.values()]
      .flatMap((organization) => {
        const member = organization.members.find((one) => one.userId === user.id)
        return member ? [{ organization, member }] : []
      })
      .sort((a, b) => a.organization.name.localeCompare(b.organization.name))
    const active = mine.some(({ organization }) => organization.id === session.organizationId)
    return {
      activeOrganizationId: active ? session.organizationId : null,
      meta: meta(mine.length),
      data: mine.map(({ organization, member }) => view(organization, member)),
    }
  },
  createMyOrganization: (ctx) => {
    requireOn(ctx.world)
    const { user } = authenticate(ctx)
    const given = name(ctx.body.name)
    const short = slug(ctx.world, ctx.body.slug, null)
    const at = iso(ctx.world.now())
    const member: SandboxMember = { userId: user.id, role: 'admin', createdAt: at }
    const organization: SandboxOrganization = {
      id: crypto.randomUUID(),
      name: given,
      slug: short,
      createdAt: at,
      members: [member],
      invitations: [],
      domains: [],
    }
    ctx.world.organizations.set(organization.id, organization)
    ctx.world.changed()
    return view(organization, member)
  },
  setActiveOrganization: (ctx) => {
    requireOn(ctx.world)
    const { session } = authenticate(ctx)
    const target = ctx.body.organizationId
    if (target !== null) {
      membership(ctx, target)
    }
    session.organizationId = target
    ctx.world.changed()
    return {
      sessionId: session.id,
      organizationId: target,
      accessToken: accessTokenFor(ctx.world, session),
      accessTokenExpiresAt: iso(ctx.world.now() + ACCESS_TOKEN_TTL_MS),
    }
  },
  updateMyOrganization: (ctx) => {
    const { organization, member } = membership(ctx, ctx.params.organizationId)
    requireAny(member, ORGANIZATION_MANAGE_PERMISSION)
    const next = {
      name: ctx.body.name === undefined ? organization.name : name(ctx.body.name),
      slug:
        ctx.body.slug === undefined
          ? organization.slug
          : slug(ctx.world, ctx.body.slug, organization.id),
    }
    organization.name = next.name
    organization.slug = next.slug
    ctx.world.changed()
    return view(organization, member)
  },
  deleteMyOrganization: (ctx) => {
    const { organization, member } = membership(ctx, ctx.params.organizationId)
    requireAny(member, ORGANIZATION_DELETE_PERMISSION)
    ctx.world.organizations.delete(organization.id)
    ctx.world.changed()
    return undefined
  },
  listMyOrganizationMembers: (ctx) => {
    const { organization, member } = membership(ctx, ctx.params.organizationId)
    requireAny(member, MEMBERSHIPS_READ_PERMISSION, MEMBERSHIPS_MANAGE_PERMISSION)
    return {
      meta: meta(organization.members.length),
      data: organization.members.map((one) => memberView(ctx.world, one)),
    }
  },
  listMyOrganizationRoles: (ctx) => {
    const { member } = membership(ctx, ctx.params.organizationId)
    requireAny(member, INVITATIONS_MANAGE_PERMISSION, MEMBERSHIPS_MANAGE_PERMISSION)
    return { data: BUILT_IN_ROLES.map(({ key, name: label }) => ({ key, name: label })) }
  },
  updateMyOrganizationMember: (ctx) => {
    const { organization, member } = membership(ctx, ctx.params.organizationId)
    requireAny(member, MEMBERSHIPS_MANAGE_PERMISSION)
    const target = organization.members.find((one) => one.userId === ctx.params.userId)
    if (!target) {
      throw new SandboxError('organization.not_a_member')
    }
    const next = role(ctx.body.role)
    if (
      !permissionsOf(next).includes(MEMBERSHIPS_MANAGE_PERMISSION) &&
      otherManagers(organization, target.userId) === 0
    ) {
      throw new SandboxError('organization.last_manager')
    }
    target.role = next
    ctx.world.changed()
    return memberView(ctx.world, target)
  },
  removeMyOrganizationMember: (ctx) => {
    const { user, organization, member } = membership(ctx, ctx.params.organizationId)
    const leaving = ctx.params.userId === user.id
    if (!leaving) {
      requireAny(member, MEMBERSHIPS_MANAGE_PERMISSION)
    }
    const target = organization.members.find((one) => one.userId === ctx.params.userId)
    if (!target) {
      throw new SandboxError('organization.not_a_member')
    }
    if (
      permissionsOf(target.role).includes(MEMBERSHIPS_MANAGE_PERMISSION) &&
      otherManagers(organization, target.userId) === 0
    ) {
      throw new SandboxError('organization.last_manager')
    }
    organization.members = organization.members.filter((one) => one !== target)
    ctx.world.changed()
    return undefined
  },
  listMyOrganizationSuggestions: (ctx) => {
    requireOn(ctx.world)
    const { user } = authenticate(ctx)
    return {
      data: suggestionsFor(ctx.world, user).map(({ id, name: label, slug: short }) => ({
        id,
        name: label,
        slug: short,
      })),
    }
  },
  joinOrganizationSuggestion: (ctx) => {
    requireOn(ctx.world)
    const { user } = authenticate(ctx)
    const organization = suggestionsFor(ctx.world, user).find(
      (one) => one.id === ctx.params.organizationId
    )
    if (!organization) {
      throw new SandboxError('organization.suggestion_unavailable')
    }
    const joined: SandboxMember = {
      userId: user.id,
      role: 'member',
      createdAt: iso(ctx.world.now()),
    }
    organization.members.push(joined)
    ctx.world.changed()
    return view(organization, joined)
  },
  listMyOrganizationDomains: (ctx) => {
    const { organization, member } = membership(ctx, ctx.params.id)
    requireAny(member, DOMAINS_MANAGE_PERMISSION)
    return { data: organization.domains.map(domainView) }
  },
  startMyOrganizationDomain: (ctx) => {
    const { world } = ctx
    const { user, organization, member } = membership(ctx, ctx.params.id)
    requireAny(member, DOMAINS_MANAGE_PERMISSION)
    const domain = text(ctx.body.domain, 'domain').trim().toLowerCase()
    if (!DOMAIN.test(domain)) {
      throw invalid('domain', 'Enter a domain, for example acme.com.')
    }
    const address = email(ctx.body.email)
    const chosen = mode(ctx.body.mode)
    if (PUBLIC_DOMAINS.has(domain)) {
      throw new SandboxError('organization.domain_public')
    }
    if (!address.toLowerCase().endsWith(`@${domain}`)) {
      throw new SandboxError('organization.domain_address_mismatch')
    }
    for (const other of world.organizations.values()) {
      if (other.domains.some((claim) => claim.domain === domain && claim.verifiedAt !== null)) {
        throw new SandboxError('organization.domain_taken')
      }
    }
    const existing = organization.domains.find((claim) => claim.domain === domain)
    if (!existing && organization.domains.length >= MAX_DOMAINS) {
      throw new SandboxError('organization.domain_limit', { params: { max: MAX_DOMAINS } })
    }
    const at = world.now()
    const claim: SandboxDomain = existing ?? {
      id: crypto.randomUUID(),
      domain,
      mode: chosen,
      code: null,
      codeExpiresAt: null,
      tries: 0,
      verifiedAt: null,
      createdAt: iso(at),
      updatedAt: iso(at),
    }
    claim.mode = chosen
    claim.code = world.digits()
    claim.codeExpiresAt = at + CODE_TTL_MS
    claim.tries = 0
    claim.updatedAt = iso(at)
    if (!existing) {
      organization.domains.push(claim)
    }
    world.sendEmail({
      to: address,
      subject: `${claim.code} is your code to verify ${domain}`,
      text: `${user.firstName ?? 'Someone'} asked to verify ${domain} for ${organization.name}. Enter this code in the app: ${claim.code}. It works for ten minutes.`,
      code: claim.code,
      notice: false,
    })
    return domainView(claim)
  },
  verifyMyOrganizationDomain: (ctx) => {
    const { world } = ctx
    const { organization, member } = membership(ctx, ctx.params.id)
    requireAny(member, DOMAINS_MANAGE_PERMISSION)
    const claim = domainOf(organization, ctx.params.domainId)
    if (claim.verifiedAt !== null) {
      return domainView(claim)
    }
    if (claim.code === null || claim.codeExpiresAt === null || claim.codeExpiresAt <= world.now()) {
      throw new SandboxError('verification.expired')
    }
    if (claim.tries >= DOMAIN_CODE_GUESSES) {
      throw new SandboxError('verification.too_many_attempts', { retryAfterSeconds: 60 })
    }
    if (claim.code !== text(ctx.body.code, 'code').replace(/\s/g, '')) {
      claim.tries += 1
      throw new SandboxError('verification.invalid_code', {
        params: { attemptsRemaining: Math.max(0, DOMAIN_CODE_GUESSES - claim.tries) },
      })
    }
    for (const other of world.organizations.values()) {
      if (
        other.id !== organization.id &&
        other.domains.some((one) => one.domain === claim.domain && one.verifiedAt !== null)
      ) {
        throw new SandboxError('organization.domain_taken')
      }
    }
    claim.verifiedAt = iso(world.now())
    claim.code = null
    claim.codeExpiresAt = null
    claim.updatedAt = iso(world.now())
    world.changed()
    return domainView(claim)
  },
  updateMyOrganizationDomain: (ctx) => {
    const { organization, member } = membership(ctx, ctx.params.id)
    requireAny(member, DOMAINS_MANAGE_PERMISSION)
    const claim = domainOf(organization, ctx.params.domainId)
    claim.mode = mode(ctx.body.mode)
    claim.updatedAt = iso(ctx.world.now())
    ctx.world.changed()
    return domainView(claim)
  },
  removeMyOrganizationDomain: (ctx) => {
    const { organization, member } = membership(ctx, ctx.params.id)
    requireAny(member, DOMAINS_MANAGE_PERMISSION)
    const claim = domainOf(organization, ctx.params.domainId)
    organization.domains = organization.domains.filter((one) => one !== claim)
    ctx.world.changed()
    return undefined
  },
  listMyOrganizationInvitations: (ctx) => {
    const { organization, member } = membership(ctx, ctx.params.organizationId)
    requireAny(member, INVITATIONS_MANAGE_PERMISSION)
    const pending = organization.invitations.filter(
      (one) => one.status === 'pending' && Date.parse(one.expiresAt) > ctx.world.now()
    )
    return {
      meta: meta(pending.length),
      data: pending.map((one) => invitationView(one, organization.id)),
    }
  },
  inviteToMyOrganization: (ctx) => {
    const { world } = ctx
    const { user, organization, member } = membership(ctx, ctx.params.organizationId)
    requireAny(member, INVITATIONS_MANAGE_PERMISSION)
    const address = email(ctx.body.email)
    const given = role(ctx.body.role)
    redirect(world, ctx.body.redirectUrl, 'redirectUrl')
    const invitee = world.findUserByEmail(address)
    if (invitee && organization.members.some((one) => one.userId === invitee.id)) {
      throw new SandboxError('organization.member_exists')
    }
    const duplicate = organization.invitations.some(
      (one) =>
        one.status === 'pending' &&
        Date.parse(one.expiresAt) > world.now() &&
        normalizeEmail(one.email) === normalizeEmail(address)
    )
    if (duplicate) {
      throw new SandboxError('organization.invitation_exists')
    }
    const at = world.now()
    const invitation: SandboxInvitation = {
      id: crypto.randomUUID(),
      email: address,
      role: given,
      status: 'pending',
      invitedBy: user.id,
      expiresAt: iso(at + INVITATION_TTL_MS),
      createdAt: iso(at),
      token: `sbx-invitation-${world.secret(12)}`,
    }
    organization.invitations.push(invitation)
    // The message has no link: the sandbox has one browser, and the visitor is the inviter.
    world.sendEmail({
      to: address,
      subject: `You are invited to join ${organization.name}`,
      text: `${user.firstName ?? 'Someone'} invited you to join ${organization.name} as ${given}. The invitation expires in seven days.`,
      notice: true,
    })
    return invitationView(invitation, organization.id)
  },
  revokeMyOrganizationInvitation: (ctx) => {
    const { organization, member } = membership(ctx, ctx.params.organizationId)
    requireAny(member, INVITATIONS_MANAGE_PERMISSION)
    const invitation = organization.invitations.find((one) => one.id === ctx.params.invitationId)
    if (!invitation) {
      throw new SandboxError('organization.invitation_not_found')
    }
    if (invitation.status === 'accepted' || invitation.status === 'declined') {
      throw new SandboxError('organization.invitation_used')
    }
    invitation.status = 'revoked'
    ctx.world.changed()
    return undefined
  },
  previewOrganizationInvitation: (ctx) => {
    const { organization, invitation } = invitationOf(ctx.world, ctx.body.token)
    return {
      organizationName: organization.name,
      role: invitation.role,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
    }
  },
  acceptOrganizationInvitation: (ctx) => {
    const { organization, invitation } = invitationOf(ctx.world, ctx.body.token)
    const user = inviteeOf(ctx, invitation)
    let member = organization.members.find((one) => one.userId === user.id)
    if (!member) {
      member = { userId: user.id, role: invitation.role, createdAt: iso(ctx.world.now()) }
      organization.members.push(member)
    }
    invitation.status = 'accepted'
    ctx.world.changed()
    const { id, name: label, slug: short, createdAt } = organization
    return {
      id,
      name: label,
      slug: short,
      role: member.role,
      permissions: [...permissionsOf(member.role)],
      createdAt,
    }
  },
  declineOrganizationInvitation: (ctx) => {
    const { invitation } = invitationOf(ctx.world, ctx.body.token)
    inviteeOf(ctx, invitation)
    invitation.status = 'declined'
    ctx.world.changed()
    return undefined
  },
}
