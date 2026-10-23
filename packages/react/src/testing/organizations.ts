import { accessToken } from '../../../core/src/testing/fakes'
import { json, ROUTE, sessionTokens, type World, world } from './harness'

// What the organization components' tests share: the API's routes as the fake API names them,
// organizations with the roles they hold, and a world whose session acts in one of them.

/** The organizations' ids: UUID-shaped, as the claims grammar needs. */
export const A = '01980000-0000-7000-8000-00000000000a'
export const B = '01980000-0000-7000-8000-00000000000b'
export const C = '01980000-0000-7000-8000-00000000000c'

/** The routes the organization components call. */
export const ORG_ROUTE = {
  list: 'GET /v1/client/me/organizations',
  active: 'PUT /v1/client/me/organizations/active',
  create: 'POST /v1/client/me/organizations',
  suggestions: 'GET /v1/client/me/organizations/suggestions',
  join: (id: string) => `POST /v1/client/me/organizations/suggestions/${id}/join`,
  update: (id: string) => `PATCH /v1/client/me/organizations/${id}`,
  remove: (id: string) => `DELETE /v1/client/me/organizations/${id}`,
  roles: (id: string) => `GET /v1/client/me/organizations/${id}/roles`,
  members: (id: string) => `GET /v1/client/me/organizations/${id}/members`,
  member: (id: string, userId: string) => `/v1/client/me/organizations/${id}/members/${userId}`,
  invitations: (id: string) => `GET /v1/client/me/organizations/${id}/invitations`,
  invite: (id: string) => `POST /v1/client/me/organizations/${id}/invitations`,
  revoke: (id: string, invitationId: string) =>
    `DELETE /v1/client/me/organizations/${id}/invitations/${invitationId}`,
  domains: (id: string) => `GET /v1/client/me/organizations/${id}/domains`,
  claim: (id: string) => `POST /v1/client/me/organizations/${id}/domains`,
  verify: (id: string, domainId: string) =>
    `POST /v1/client/me/organizations/${id}/domains/${domainId}/verify`,
  domain: (id: string, domainId: string) => `/v1/client/me/organizations/${id}/domains/${domainId}`,
  previewInvitation: 'POST /v1/client/organization-invitations/preview',
  acceptInvitation: 'POST /v1/client/me/organization-invitations/accept',
  declineInvitation: 'POST /v1/client/me/organization-invitations/decline',
} as const

/** Every permission Tula's own routes check: the built-in `admin` role. */
export const ADMIN_PERMISSIONS = [
  'org:sys:organization:manage',
  'org:sys:organization:delete',
  'org:sys:memberships:read',
  'org:sys:memberships:manage',
  'org:sys:invitations:manage',
  'org:sys:domains:manage',
]

/** What the built-in `member` role holds. */
export const MEMBER_PERMISSIONS = ['org:sys:memberships:read']

/**
 * @param id - The organization's id.
 * @param name - Its name.
 * @param role - The user's role key in it.
 * @param permissions - That role's permission keys.
 * @returns One entry of the user's organization list.
 */
export function organization(id: string, name: string, role: string, permissions: string[]) {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    role,
    permissions,
    createdAt: '2030-01-01T00:00:00.000Z',
  }
}

export const ACME = organization(A, 'Acme', 'admin', ADMIN_PERMISSIONS)
export const GLOBEX = organization(B, 'Globex', 'member', MEMBER_PERMISSIONS)

/**
 * @param data - The organizations.
 * @param activeOrganizationId - The one the session acts in, or `null`.
 * @returns The list's answer.
 */
export function page(data: unknown[], activeOrganizationId: string | null) {
  return json(200, { data, activeOrganizationId, meta: { hasMore: false, nextCursor: null } })
}

/** The answer to making an organization (or none) the active one. */
export function activated(organizationId: string | null) {
  return json(200, {
    sessionId: 'session_1',
    organizationId,
    accessToken: accessToken('t', 60, organizationId ? { org_id: organizationId } : {}),
    accessTokenExpiresAt: '2030-01-01T00:01:00.000Z',
  })
}

/** What `organizations` of the public configuration says in the worlds below. */
export const ORGS_ON = { enabled: true, allowUserCreated: true, personalAccount: true }

/**
 * A signed-in world whose session acts in an organization (or none), where the environment has
 * organizations on. The organizations are answered from `organizations`, which a test may
 * change: the list is always read from it.
 *
 * @param options.active - The organization the session acts in, or `null`.
 * @param options.organizations - What the list answers.
 * @param options.config - The `organizations` of the public configuration.
 * @returns The world and the list a test can change.
 */
export function orgWorld(
  options: {
    active?: string | null
    organizations?: ReturnType<typeof organization>[]
    config?: { enabled: boolean; allowUserCreated: boolean; personalAccount: boolean }
  } = {}
): World & { organizations: ReturnType<typeof organization>[] } {
  const active = options.active === undefined ? A : options.active
  const w = world({ signedIn: true, organizations: options.config ?? ORGS_ON })
  const result = Object.assign(w, { organizations: options.organizations ?? [ACME, GLOBEX] })
  w.api.on(ROUTE.refresh, () =>
    json(
      200,
      sessionTokens('access_1', {
        accessToken: accessToken('t', 60, active ? { org_id: active } : {}),
      })
    )
  )
  w.api.on(ORG_ROUTE.list, () =>
    page(
      result.organizations,
      w.client.state.status === 'signed-in' ? w.client.state.organizationId : null
    )
  )
  w.api.on(ORG_ROUTE.active, (request) => {
    const body = request.body as { organizationId: string | null }
    return activated(body.organizationId)
  })
  w.api.on(ORG_ROUTE.suggestions, () => json(200, { data: [] }))
  return result
}
