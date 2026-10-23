import {
  AddOrganizationMemberRequestSchema,
  BUILT_IN_ROLES,
  CreateOrganizationInvitationRequestSchema,
  CreateOrganizationRequestSchema,
  CreateOrganizationRoleRequestSchema,
  domainRefusal,
  INVITATION_EXPIRY_DAYS,
  INVITATION_STATUSES,
  MAX_CUSTOM_ROLES,
  MAX_DOMAINS_PER_ORGANIZATION,
  MEMBERSHIPS_MANAGE_PERMISSION,
  normalizePermissions,
  type ORGANIZATION_DOMAIN_MODES,
  StartOrganizationDomainRequestSchema,
  UpdateOrganizationDomainRequestSchema,
  UpdateOrganizationMemberRequestSchema,
  UpdateOrganizationRequestSchema,
  UpdateOrganizationRoleRequestSchema,
  VerifyOrganizationDomainRequestSchema,
} from '@tula-tech/contract'
import { z } from 'zod'
import { type FakeCall, type FakeHandler, failure, IDS } from './fake-api'
import { invalid } from './fake-webhooks'

// The fake API's organization routes (`/v1/admin/organizations`, `/v1/admin/organization-roles`
// and `/v1/admin/users/:id/organizations`): the shapes, the refusals and the error codes of
// `apps/api/src/modules/organization` and `…/organization-role`, on plain in-memory data.
//
// What it keeps of the API: every route answers `organization.disabled` (403) while the
// environment has organizations off, a read as well as a write; a slug is unique in its
// environment; a user is a member of an organization once; the last member who holds
// `org:sys:memberships:manage` cannot be demoted, removed, stripped of the permission by a role
// change or deleted with their account; a role needs `If-Match` to be changed (428 without,
// 412 when stale), a built-in role is never changed or deleted, a role in use is not deleted,
// the cap of custom roles holds; an invitation needs a redirect URL the environment allows and
// is one pending per address.
//
// Where it differs, on purpose: no rate limit, no audit log, no email is sent, and nothing
// races (a test that needs a conflict that depends on timing overrides the route).

const NOW = '2026-10-23T12:00:00.000Z'
const ENVIRONMENT = 'x-tula-environment'
const UUID = z.uuid()

/** An organization as the fake holds it: the API's view, plus the environment it is in. */
export interface FakeOrganization {
  id: string
  environmentId: string
  name: string
  slug: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** A membership as the fake holds it. */
export interface FakeMembership {
  id: string
  environmentId: string
  organizationId: string
  userId: string
  role: string
  createdAt: string
  updatedAt: string
}

/** A custom role as the fake holds it (the built-in roles are the contract's). */
export interface FakeRole {
  id: string
  environmentId: string
  key: string
  name: string
  permissions: string[]
  version: number
  createdAt: string
  updatedAt: string
}

/** An invitation as the fake holds it. */
export interface FakeInvitation {
  id: string
  environmentId: string
  organizationId: string
  email: string
  role: string
  status: (typeof INVITATION_STATUSES)[number]
  invitedBy: string | null
  expiresAt: string
  createdAt: string
}

/**
 * A claimed domain as the fake holds it. The emailed code is `code`: a test types it, and the
 * fake compares it as the service does (expiry, then a count of wrong guesses).
 */
export interface FakeDomain {
  id: string
  environmentId: string
  organizationId: string
  domain: string
  mode: (typeof ORGANIZATION_DOMAIN_MODES)[number]
  verifiedAt: string | null
  /** When the verification lapses; `null` while pending. */
  expiresAt: string | null
  codeExpiresAt: string | null
  createdAt: string
  updatedAt: string
  code: string | null
  attempts: number
}

/** The part of the fake's state the organization routes work on. */
export interface FakeOrganizationState {
  organizations: FakeOrganization[]
  memberships: FakeMembership[]
  roles: FakeRole[]
  invitations: FakeInvitation[]
  domains: FakeDomain[]
}

/** What the routes ask of the rest of the fake. */
export interface FakeOrganizationContext {
  /** Whether the environment has organizations switched on (its settings document). */
  enabled: () => boolean
  /** The environment's allowed redirect URLs. */
  redirectUrls: () => string[]
  /** Whether a user of the environment exists. */
  userExists: (userId: string) => boolean
}

let made = 0

function nextId(): string {
  made += 1
  return `00000000-0000-7000-8000-f${String(made).padStart(11, '0')}`
}

/**
 * An organization for a test to put in the fake's state, in the development environment.
 *
 * @param overrides - What differs.
 * @returns The organization.
 */
export function fakeOrganization(overrides: Partial<FakeOrganization> = {}): FakeOrganization {
  const id = overrides.id ?? nextId()
  return {
    id,
    environmentId: IDS.development,
    name: 'Acme Corp',
    slug: `acme-${id.slice(-4)}`,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/**
 * A membership for a test to put in the fake's state, in the development environment.
 *
 * @param overrides - What differs; `organizationId` and `userId` should be given.
 * @returns The membership.
 */
export function fakeMembership(overrides: Partial<FakeMembership> = {}): FakeMembership {
  return {
    id: nextId(),
    environmentId: IDS.development,
    organizationId: nextId(),
    userId: IDS.user,
    role: 'member',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/**
 * A custom role for a test to put in the fake's state, in the development environment.
 *
 * @param overrides - What differs.
 * @returns The role.
 */
export function fakeRole(overrides: Partial<FakeRole> = {}): FakeRole {
  return {
    id: nextId(),
    environmentId: IDS.development,
    key: 'billing',
    name: 'Billing manager',
    permissions: ['org:billing:read'],
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/**
 * An invitation for a test to put in the fake's state, in the development environment.
 *
 * @param overrides - What differs; `organizationId` should be given.
 * @returns The invitation.
 */
export function fakeInvitation(overrides: Partial<FakeInvitation> = {}): FakeInvitation {
  return {
    id: nextId(),
    environmentId: IDS.development,
    organizationId: nextId(),
    email: 'new.hire@example.com',
    role: 'member',
    status: 'pending',
    invitedBy: null,
    expiresAt: '2026-10-30T12:00:00.000Z',
    createdAt: NOW,
    ...overrides,
  }
}

/** A year after the fake's clock: when a verification made now lapses. */
export const IN_A_YEAR = '2027-10-23T12:00:00.000Z'

/** The code the fake emails for a claim: a test types it in. */
export const FAKE_DOMAIN_CODE = '123456'

/**
 * A claimed domain for a test to put in the fake's state, in the development environment:
 * verified unless `verifiedAt` is given as `null`.
 *
 * @param overrides - What differs; `organizationId` should be given.
 * @returns The claim.
 */
export function fakeDomain(overrides: Partial<FakeDomain> = {}): FakeDomain {
  const pending = overrides.verifiedAt === null
  return {
    id: nextId(),
    environmentId: IDS.development,
    organizationId: nextId(),
    domain: 'acme.com',
    mode: 'suggest',
    verifiedAt: pending ? null : NOW,
    expiresAt: pending ? null : IN_A_YEAR,
    codeExpiresAt: pending ? '2026-10-24T12:00:00.000Z' : null,
    createdAt: NOW,
    updatedAt: NOW,
    code: pending ? FAKE_DOMAIN_CODE : null,
    attempts: 0,
    ...overrides,
  }
}

/** The permissions of a role key in an environment: the built-in ones, else the custom row. */
function permissionsOf(state: FakeOrganizationState, environmentId: string, key: string) {
  const builtIn = BUILT_IN_ROLES.find((role) => role.key === key)
  if (builtIn) {
    return [...builtIn.permissions] as string[]
  }
  return (
    state.roles.find((role) => role.environmentId === environmentId && role.key === key)
      ?.permissions ?? null
  )
}

function roleKnown(state: FakeOrganizationState, environmentId: string, key: string): boolean {
  return permissionsOf(state, environmentId, key) !== null
}

function managers(
  state: FakeOrganizationState,
  organization: FakeOrganization,
  rolePermissions: (key: string) => string[] | null = (key) =>
    permissionsOf(state, organization.environmentId, key)
) {
  return state.memberships.filter(
    (membership) =>
      membership.organizationId === organization.id &&
      membership.environmentId === organization.environmentId &&
      rolePermissions(membership.role)?.includes(MEMBERSHIPS_MANAGE_PERMISSION)
  )
}

/**
 * The organizations a user is the only manager of, in id order: what stops the user's
 * deletion (`user.last_organization_manager`, 409).
 *
 * @param state - The fake's organization state.
 * @param environmentId - The environment.
 * @param userId - The user to be deleted.
 * @returns The ids of the organizations that would be left with no manager.
 */
export function lastManagerOrganizationIds(
  state: FakeOrganizationState,
  environmentId: string,
  userId: string
): string[] {
  return state.organizations
    .filter((organization) => organization.environmentId === environmentId)
    .filter((organization) => {
      const holders = managers(state, organization)
      return holders.length === 1 && holders[0]?.userId === userId
    })
    .map((organization) => organization.id)
    .sort()
}

/**
 * The deletion of a user's memberships, as the database does it with the account.
 *
 * @param state - The fake's organization state.
 * @param userId - The deleted user.
 */
export function dropMembershipsOf(state: FakeOrganizationState, userId: string): void {
  state.memberships = state.memberships.filter((membership) => membership.userId !== userId)
}

function paged<T>(rows: T[], call: FakeCall) {
  const page = Math.max(1, Number(call.search.get('page') ?? 1) || 1)
  const size = Math.min(100, Math.max(1, Number(call.search.get('size') ?? 20) || 20))
  return {
    meta: {
      totalCount: rows.length,
      totalPages: Math.ceil(rows.length / size),
      page,
      perPage: size,
    },
    data: rows.slice((page - 1) * size, page * size),
  }
}

function created(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  })
}

function notFound(): Response {
  return failure(404, 'resource.not_found', 'The requested resource does not exist.')
}

const lastManager = () =>
  failure(
    409,
    'organization.last_manager',
    'An organization must keep at least one member who can manage its members.'
  )

function organizationView({ environmentId: _environmentId, ...organization }: FakeOrganization) {
  return organization
}

function membershipView({ environmentId: _environmentId, ...membership }: FakeMembership) {
  return membership
}

function domainView(domain: FakeDomain) {
  const {
    environmentId: _environmentId,
    organizationId: _organizationId,
    code: _code,
    attempts: _attempts,
    ...view
  } = domain
  // Derived from the date and the clock, as the API does: never stored.
  const status =
    view.verifiedAt === null
      ? ('pending' as const)
      : view.expiresAt !== null && view.expiresAt > NOW
        ? ('verified' as const)
        : ('needs_reverification' as const)
  return { ...view, status }
}

/** Whether a claim holds its name now: verified and not lapsed. */
function holds(entry: FakeDomain): boolean {
  return entry.verifiedAt !== null && entry.expiresAt !== null && entry.expiresAt > NOW
}

function invitationView(invitation: FakeInvitation) {
  const { environmentId: _environmentId, ...view } = invitation
  // A pending invitation past its time is `expired`, which the API does not store.
  return view.status === 'pending' && Date.parse(view.expiresAt) < Date.parse(NOW)
    ? { ...view, status: 'expired' as const }
    : view
}

function roleView(role: FakeRole) {
  const { environmentId: _environmentId, ...view } = role
  return { ...view, builtIn: false }
}

const IdParam = z.object({ id: UUID })
const MembershipParams = z.object({ id: UUID, userId: UUID })
const InvitationParams = z.object({ id: UUID, invitationId: UUID })
const PageQuery = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
})
const InvitationQuery = PageQuery.extend({ status: z.enum(INVITATION_STATUSES).default('pending') })

const KEY = /^[a-z][a-z0-9_]{0,31}$/

/**
 * The organization routes of the fake API.
 *
 * @param state - The fake's state; the routes read and change its organization part.
 * @param context - What the routes ask of the rest of the fake.
 * @returns The routes, in the fake's own table format.
 */
export function organizationRoutes(
  state: FakeOrganizationState,
  context: FakeOrganizationContext
): [string, RegExp, FakeHandler][] {
  const environmentOf = (call: FakeCall) => call.headers.get(ENVIRONMENT) ?? ''
  const off = () =>
    failure(403, 'organization.disabled', 'Organizations are not enabled for this environment.')

  /** Every route starts here: organizations on, the ids and the body read, the row found. */
  function onOrganization<Body>(
    body: z.ZodType<Body> | null,
    handler: (organization: FakeOrganization, body: Body, call: FakeCall) => Response | unknown
  ): FakeHandler {
    return (call, match) => {
      if (!context.enabled()) {
        return off()
      }
      const params = IdParam.safeParse({ id: match[1] })
      if (!params.success) {
        return invalid(params.error)
      }
      const given = body === null ? null : body.safeParse(call.body ?? {})
      if (given && !given.success) {
        return invalid(given.error)
      }
      const organization = state.organizations.find(
        (entry) => entry.id === params.data.id && entry.environmentId === environmentOf(call)
      )
      return organization ? handler(organization, given?.data as Body, call) : notFound()
    }
  }

  /** Every route of one claim: organizations on, the organization and the claim found. */
  function onDomain<Body>(
    body: z.ZodType<Body> | null,
    handler: (claim: FakeDomain, body: Body, call: FakeCall) => Response | unknown
  ): FakeHandler {
    return (call, match) =>
      onOrganization(body, (organization, given, inner) => {
        const claim = state.domains.find(
          (entry) =>
            entry.id === match[2] &&
            entry.organizationId === organization.id &&
            entry.environmentId === organization.environmentId
        )
        return claim ? handler(claim, given, inner) : notFound()
      })(call, match)
  }

  function slugTaken(environmentId: string, slug: string, except?: string): boolean {
    return state.organizations.some(
      (entry) => entry.environmentId === environmentId && entry.slug === slug && entry.id !== except
    )
  }

  const roleList = (environmentId: string) => [
    ...BUILT_IN_ROLES.map((role) => ({
      id: `built-in-${role.key}`,
      key: role.key,
      name: role.name,
      permissions: normalizePermissions(role.permissions),
      builtIn: true,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    ...state.roles
      .filter((role) => role.environmentId === environmentId)
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map(roleView),
  ]

  /** Whether giving `key` these permissions would leave an organization with no manager. */
  function strandsAnOrganization(environmentId: string, key: string, next: string[]): boolean {
    return state.organizations
      .filter((organization) => organization.environmentId === environmentId)
      .some((organization) => {
        const holders = managers(state, organization)
        const stays = managers(state, organization, (roleKey) =>
          roleKey === key ? next : permissionsOf(state, environmentId, roleKey)
        )
        return holders.length > 0 && stays.length === 0
      })
  }

  /** Every role route starts here: organizations on, the key read, the row found. */
  function onRole<Body>(
    body: z.ZodType<Body> | null,
    handler: (role: FakeRole, body: Body, call: FakeCall) => Response | unknown
  ): FakeHandler {
    return (call, match) => {
      if (!context.enabled()) {
        return off()
      }
      const key = match[1] as string
      const given = body === null ? null : body.safeParse(call.body ?? {})
      if (given && !given.success) {
        return invalid(given.error)
      }
      if (BUILT_IN_ROLES.some((role) => role.key === key)) {
        return failure(409, 'organization.role_built_in', 'A built-in role cannot be changed.')
      }
      const role = state.roles.find(
        (entry) => entry.environmentId === environmentOf(call) && entry.key === key
      )
      return role ? handler(role, given?.data as Body, call) : notFound()
    }
  }

  /** `If-Match` as the API reads it: absent, or a quoted version. */
  function versionOf(call: FakeCall): number | null | 'malformed' {
    const header = call.headers.get('if-match')
    if (header === null) {
      return null
    }
    const parsed = /^"(\d+)"$/.exec(header.trim())
    return parsed ? Number(parsed[1]) : 'malformed'
  }

  return [
    [
      'GET',
      /^\/v1\/admin\/organizations$/,
      (call) => {
        if (!context.enabled()) {
          return off()
        }
        const query = PageQuery.safeParse(Object.fromEntries(call.search))
        if (!query.success) {
          return invalid(query.error)
        }
        const mine = state.organizations
          .filter((entry) => entry.environmentId === environmentOf(call))
          .reverse()
        return paged(mine.map(organizationView), call)
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/organizations$/,
      (call) => {
        if (!context.enabled()) {
          return off()
        }
        const body = CreateOrganizationRequestSchema.safeParse(call.body ?? {})
        if (!body.success) {
          return invalid(body.error)
        }
        const environmentId = environmentOf(call)
        if (slugTaken(environmentId, body.data.slug)) {
          return failure(
            409,
            'organization.slug_taken',
            'An organization with that slug already exists.'
          )
        }
        const organization = fakeOrganization({
          environmentId,
          name: body.data.name,
          slug: body.data.slug,
        })
        state.organizations.push(organization)
        return created(organizationView(organization))
      },
    ],
    ['GET', /^\/v1\/admin\/organizations\/([^/]+)$/, onOrganization(null, organizationView)],
    [
      'PATCH',
      /^\/v1\/admin\/organizations\/([^/]+)$/,
      onOrganization(UpdateOrganizationRequestSchema, (organization, body) => {
        if (
          body.slug !== undefined &&
          body.slug !== organization.slug &&
          slugTaken(organization.environmentId, body.slug, organization.id)
        ) {
          return failure(
            409,
            'organization.slug_taken',
            'An organization with that slug already exists.'
          )
        }
        const changes =
          (body.name !== undefined && body.name !== organization.name) ||
          (body.slug !== undefined && body.slug !== organization.slug)
        if (changes) {
          organization.name = body.name ?? organization.name
          organization.slug = body.slug ?? organization.slug
          organization.updatedAt = NOW
        }
        return organizationView(organization)
      }),
    ],
    [
      'DELETE',
      /^\/v1\/admin\/organizations\/([^/]+)$/,
      onOrganization(null, (organization) => {
        state.organizations.splice(state.organizations.indexOf(organization), 1)
        state.memberships = state.memberships.filter(
          (membership) => membership.organizationId !== organization.id
        )
        state.invitations = state.invitations.filter(
          (invitation) => invitation.organizationId !== organization.id
        )
        state.domains = state.domains.filter((entry) => entry.organizationId !== organization.id)
        return new Response(null, { status: 204 })
      }),
    ],
    [
      'GET',
      /^\/v1\/admin\/organizations\/([^/]+)\/memberships$/,
      (call, match) => {
        const query = PageQuery.safeParse(Object.fromEntries(call.search))
        if (!query.success && context.enabled()) {
          return invalid(query.error)
        }
        return onOrganization(null, (organization) =>
          paged(
            state.memberships
              .filter(
                (membership) =>
                  membership.organizationId === organization.id &&
                  membership.environmentId === organization.environmentId
              )
              .map(membershipView),
            call
          )
        )(call, match)
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/organizations\/([^/]+)\/memberships$/,
      onOrganization(AddOrganizationMemberRequestSchema, (organization, body) => {
        if (!context.userExists(body.userId)) {
          return notFound()
        }
        if (!roleKnown(state, organization.environmentId, body.role)) {
          return failure(422, 'organization.role_unknown', 'That role does not exist.')
        }
        if (
          state.memberships.some(
            (entry) =>
              entry.organizationId === organization.id &&
              entry.environmentId === organization.environmentId &&
              entry.userId === body.userId
          )
        ) {
          return failure(
            409,
            'organization.member_exists',
            'That user is already a member of this organization.'
          )
        }
        const membership = fakeMembership({
          environmentId: organization.environmentId,
          organizationId: organization.id,
          userId: body.userId,
          role: body.role,
        })
        state.memberships.push(membership)
        return created(membershipView(membership))
      }),
    ],
    [
      'PATCH',
      /^\/v1\/admin\/organizations\/([^/]+)\/memberships\/([^/]+)$/,
      (call, match) => {
        const params = MembershipParams.safeParse({ id: match[1], userId: match[2] })
        if (context.enabled() && !params.success) {
          return invalid(params.error)
        }
        return onOrganization(UpdateOrganizationMemberRequestSchema, (organization, body) => {
          const membership = state.memberships.find(
            (entry) =>
              entry.organizationId === organization.id &&
              entry.environmentId === organization.environmentId &&
              entry.userId === match[2]
          )
          if (!membership) {
            return notFound()
          }
          if (!roleKnown(state, organization.environmentId, body.role)) {
            return failure(422, 'organization.role_unknown', 'That role does not exist.')
          }
          const holders = managers(state, organization)
          const demoted = holders.some((holder) => holder.id === membership.id)
          if (
            demoted &&
            !permissionsOf(state, organization.environmentId, body.role)?.includes(
              MEMBERSHIPS_MANAGE_PERMISSION
            ) &&
            holders.length === 1
          ) {
            return lastManager()
          }
          if (membership.role !== body.role) {
            membership.role = body.role
            membership.updatedAt = NOW
          }
          return membershipView(membership)
        })(call, match)
      },
    ],
    [
      'DELETE',
      /^\/v1\/admin\/organizations\/([^/]+)\/memberships\/([^/]+)$/,
      (call, match) => {
        const params = MembershipParams.safeParse({ id: match[1], userId: match[2] })
        if (context.enabled() && !params.success) {
          return invalid(params.error)
        }
        return onOrganization(null, (organization) => {
          const membership = state.memberships.find(
            (entry) =>
              entry.organizationId === organization.id &&
              entry.environmentId === organization.environmentId &&
              entry.userId === match[2]
          )
          if (!membership) {
            return notFound()
          }
          const holders = managers(state, organization)
          if (holders.length === 1 && holders[0]?.id === membership.id) {
            return lastManager()
          }
          state.memberships.splice(state.memberships.indexOf(membership), 1)
          return new Response(null, { status: 204 })
        })(call, match)
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/organizations\/([^/]+)\/invitations$/,
      (call, match) => {
        const query = InvitationQuery.safeParse(Object.fromEntries(call.search))
        if (context.enabled() && !query.success) {
          return invalid(query.error)
        }
        return onOrganization(null, (organization) =>
          paged(
            state.invitations
              .filter(
                (invitation) =>
                  invitation.organizationId === organization.id &&
                  invitation.environmentId === organization.environmentId
              )
              .map(invitationView)
              .filter((invitation) => invitation.status === (query.data?.status ?? 'pending'))
              .reverse(),
            call
          )
        )(call, match)
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/organizations\/([^/]+)\/invitations$/,
      onOrganization(CreateOrganizationInvitationRequestSchema, (organization, body) => {
        if (!/^[^@\s]+@[^@\s]+$/.test(body.email.trim())) {
          return failure(422, 'validation.failed', 'The request is not valid.', [
            { field: 'email', code: 'validation.failed', message: 'Not an email address.' },
          ])
        }
        if (!context.redirectUrls().includes(body.redirectUrl)) {
          return failure(422, 'validation.failed', 'The request is not valid.', [
            {
              field: 'redirectUrl',
              code: 'validation.failed',
              message: 'Not one of the environment’s allowed redirect URLs.',
            },
          ])
        }
        if (!roleKnown(state, organization.environmentId, body.role)) {
          return failure(422, 'organization.role_unknown', 'That role does not exist.')
        }
        const address = body.email.trim().toLowerCase()
        if (
          state.invitations.some(
            (entry) =>
              entry.organizationId === organization.id &&
              entry.environmentId === organization.environmentId &&
              entry.email.toLowerCase() === address &&
              invitationView(entry).status === 'pending'
          )
        ) {
          return failure(
            409,
            'organization.invitation_exists',
            'That address already has a pending invitation.'
          )
        }
        const invitation = fakeInvitation({
          environmentId: organization.environmentId,
          organizationId: organization.id,
          email: body.email.trim(),
          role: body.role,
          expiresAt: new Date(Date.parse(NOW) + INVITATION_EXPIRY_DAYS * 86_400_000).toISOString(),
        })
        state.invitations.push(invitation)
        return created(invitationView(invitation))
      }),
    ],
    [
      'DELETE',
      /^\/v1\/admin\/organizations\/([^/]+)\/invitations\/([^/]+)$/,
      (call, match) => {
        const params = InvitationParams.safeParse({ id: match[1], invitationId: match[2] })
        if (context.enabled() && !params.success) {
          return invalid(params.error)
        }
        return onOrganization(null, (organization) => {
          const invitation = state.invitations.find(
            (entry) =>
              entry.organizationId === organization.id &&
              entry.environmentId === organization.environmentId &&
              entry.id === match[2]
          )
          if (!invitation) {
            return failure(
              404,
              'organization.invitation_not_found',
              'This invitation does not exist.'
            )
          }
          if (invitationView(invitation).status !== 'pending') {
            return failure(410, 'organization.invitation_used', 'This invitation was already used.')
          }
          invitation.status = 'revoked'
          return new Response(null, { status: 204 })
        })(call, match)
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/organizations\/([^/]+)\/domains$/,
      onOrganization(null, (organization) => ({
        data: state.domains
          .filter(
            (entry) =>
              entry.organizationId === organization.id &&
              entry.environmentId === organization.environmentId
          )
          .map(domainView),
      })),
    ],
    [
      'POST',
      /^\/v1\/admin\/organizations\/([^/]+)\/domains$/,
      onOrganization(StartOrganizationDomainRequestSchema, (organization, body) => {
        const domain = body.domain
        if (domainRefusal(domain) === 'public') {
          return failure(
            422,
            'organization.domain_public',
            'A public email domain cannot be claimed.'
          )
        }
        const address = body.email.trim().toLowerCase()
        if (!/^[^@\s]+@[^@\s]+$/.test(address)) {
          return failure(422, 'validation.failed', 'The request is not valid.', [
            { field: 'email', code: 'validation.failed', message: 'Not an email address.' },
          ])
        }
        if (address.split('@')[1] !== domain) {
          return failure(
            422,
            'organization.domain_address_mismatch',
            'That address is not on the domain.'
          )
        }
        const mine = state.domains.filter(
          (entry) =>
            entry.organizationId === organization.id &&
            entry.environmentId === organization.environmentId
        )
        if (
          state.domains.some(
            (entry) =>
              entry.environmentId === organization.environmentId &&
              entry.organizationId !== organization.id &&
              entry.domain === domain &&
              holds(entry)
          )
        ) {
          return failure(409, 'organization.domain_taken', 'That domain is verified already.')
        }
        const existing = mine.find((entry) => entry.domain === domain)
        if (!existing && mine.length >= MAX_DOMAINS_PER_ORGANIZATION) {
          return failure(
            409,
            'organization.domain_limit',
            'This organization has the most domains it can have.',
            undefined,
            { max: MAX_DOMAINS_PER_ORGANIZATION }
          )
        }
        const claim =
          existing ??
          fakeDomain({
            organizationId: organization.id,
            environmentId: organization.environmentId,
            domain,
            verifiedAt: null,
          })
        // A domain this organization has verified keeps its mode and its standing while a new
        // code is proved (the request's mode is ignored, as the API does).
        if (claim.verifiedAt === null) {
          claim.mode = body.mode
        }
        claim.code = FAKE_DOMAIN_CODE
        claim.codeExpiresAt = '2026-10-24T12:00:00.000Z'
        claim.attempts = 0
        if (!existing) {
          state.domains.push(claim)
        }
        return created(domainView(claim))
      }),
    ],
    [
      'POST',
      /^\/v1\/admin\/organizations\/([^/]+)\/domains\/([^/]+)\/verify$/,
      (call, match) =>
        onDomain(VerifyOrganizationDomainRequestSchema, (claim, body) => {
          if (claim.verifiedAt !== null && claim.code === null) {
            return holds(claim)
              ? domainView(claim)
              : failure(410, 'verification.expired', 'The code has expired.')
          }
          if (claim.code === null || (claim.codeExpiresAt ?? '') <= NOW) {
            return failure(410, 'verification.expired', 'The code has expired.')
          }
          claim.attempts += 1
          if (claim.attempts > 5) {
            return failure(429, 'verification.too_many_attempts', 'Too many wrong codes.')
          }
          if (body.code !== claim.code) {
            return failure(422, 'verification.invalid_code', 'That code is not right.')
          }
          const taken = state.domains.some(
            (entry) =>
              entry !== claim &&
              entry.environmentId === claim.environmentId &&
              entry.domain === claim.domain &&
              holds(entry)
          )
          if (taken) {
            return failure(409, 'organization.domain_taken', 'That domain is verified already.')
          }
          // Another organization's lapsed verification of the name is removed, as the API does.
          state.domains = state.domains.filter(
            (entry) =>
              entry === claim ||
              entry.domain !== claim.domain ||
              entry.environmentId !== claim.environmentId ||
              entry.verifiedAt === null
          )
          claim.verifiedAt = NOW
          claim.expiresAt = IN_A_YEAR
          claim.codeExpiresAt = null
          claim.code = null
          return domainView(claim)
        })(call, match),
    ],
    [
      'PATCH',
      /^\/v1\/admin\/organizations\/([^/]+)\/domains\/([^/]+)$/,
      (call, match) =>
        onDomain(UpdateOrganizationDomainRequestSchema, (claim, body) => {
          claim.mode = body.mode
          claim.updatedAt = NOW
          return domainView(claim)
        })(call, match),
    ],
    [
      'DELETE',
      /^\/v1\/admin\/organizations\/([^/]+)\/domains\/([^/]+)$/,
      (call, match) =>
        onDomain(null, (claim) => {
          state.domains.splice(state.domains.indexOf(claim), 1)
          return new Response(null, { status: 204 })
        })(call, match),
    ],
    [
      'GET',
      /^\/v1\/admin\/users\/([^/]+)\/organizations$/,
      (call, match) => {
        if (!context.enabled()) {
          return off()
        }
        const query = PageQuery.safeParse(Object.fromEntries(call.search))
        if (!query.success) {
          return invalid(query.error)
        }
        const userId = match[1] as string
        if (!UUID.safeParse(userId).success) {
          return invalid(IdParam.safeParse({ id: userId }).error as z.ZodError)
        }
        if (!context.userExists(userId)) {
          return notFound()
        }
        const rows = state.memberships
          .filter(
            (membership) =>
              membership.userId === userId && membership.environmentId === environmentOf(call)
          )
          .flatMap((membership) => {
            const organization = state.organizations.find(
              (entry) => entry.id === membership.organizationId
            )
            return organization
              ? [
                  {
                    organizationId: organization.id,
                    name: organization.name,
                    slug: organization.slug,
                    role: membership.role,
                    joinedAt: membership.createdAt,
                  },
                ]
              : []
          })
        return paged(rows, call)
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/organization-roles$/,
      (call) => (context.enabled() ? { data: roleList(environmentOf(call)) } : off()),
    ],
    [
      'POST',
      /^\/v1\/admin\/organization-roles$/,
      (call) => {
        if (!context.enabled()) {
          return off()
        }
        const body = CreateOrganizationRoleRequestSchema.safeParse(call.body ?? {})
        if (!body.success) {
          return invalid(body.error)
        }
        const environmentId = environmentOf(call)
        const { key } = body.data
        if (!KEY.test(key) || roleKnown(state, environmentId, key)) {
          return failure(
            409,
            'organization.role_exists',
            'A role with that key already exists in this environment.'
          )
        }
        if (
          state.roles.filter((role) => role.environmentId === environmentId).length >=
          MAX_CUSTOM_ROLES
        ) {
          return failure(
            409,
            'organization.role_limit',
            'This environment has the most custom roles it can have.',
            undefined,
            { max: MAX_CUSTOM_ROLES }
          )
        }
        const role = fakeRole({
          environmentId,
          key,
          name: body.data.name,
          permissions: normalizePermissions(body.data.permissions),
        })
        state.roles.push(role)
        return created(roleView(role))
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/organization-roles\/([^/]+)$/,
      (call, match) => {
        if (!context.enabled()) {
          return off()
        }
        const key = match[1] as string
        return roleList(environmentOf(call)).find((role) => role.key === key) ?? notFound()
      },
    ],
    [
      'PATCH',
      /^\/v1\/admin\/organization-roles\/([^/]+)$/,
      (call, match) =>
        onRole(UpdateOrganizationRoleRequestSchema, (role, body) => {
          const version = versionOf(call)
          if (version === null) {
            return failure(428, 'precondition.required', 'Send the version you read in If-Match.')
          }
          if (version === 'malformed' || version !== role.version) {
            return failure(412, 'precondition.failed', 'The role changed.')
          }
          const next = body.permissions ? normalizePermissions(body.permissions) : role.permissions
          if (strandsAnOrganization(role.environmentId, role.key, next)) {
            return lastManager()
          }
          const renamed = body.name !== undefined && body.name !== role.name
          const reset = next.join() !== role.permissions.join()
          if (renamed || reset) {
            role.name = body.name ?? role.name
            role.permissions = next
            role.version += 1
            role.updatedAt = NOW
          }
          return roleView(role)
        })(call, match),
    ],
    [
      'DELETE',
      /^\/v1\/admin\/organization-roles\/([^/]+)$/,
      (call, match) =>
        onRole(null, (role) => {
          const version = versionOf(call)
          if (version === 'malformed' || (version !== null && version !== role.version)) {
            return failure(412, 'precondition.failed', 'The role changed.')
          }
          if (
            state.memberships.some(
              (membership) =>
                membership.environmentId === role.environmentId && membership.role === role.key
            )
          ) {
            return failure(
              409,
              'organization.role_in_use',
              'Members still hold this role. Give them another role first.'
            )
          }
          state.roles.splice(state.roles.indexOf(role), 1)
          return new Response(null, { status: 204 })
        })(call, match),
    ],
  ]
}
