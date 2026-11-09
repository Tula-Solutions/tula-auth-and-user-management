import {
  ActiveOrganizationPermissionsSchema,
  ActiveOrganizationSchema,
  CreateOrganizationRequestSchema,
  DPOP_HEADER,
  OrganizationPageQuerySchema,
  SetActiveOrganizationRequestSchema,
  UserOrganizationListSchema,
  UserOrganizationSchema,
} from '@tula-tech/contract'
import { type Context, Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv, SessionVariables, TenantVariables } from '~/dependencies'
import { AuthError } from '~/exceptions'
import { validationHook } from '~/handlers'
import { userActor } from '~/lib/actor'
import { timingSafeEqual } from '~/lib/crypto'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import { sessionAuth } from '~/middleware/session-auth'
import * as Me from '~/modules/organization/me-service'
import * as Organizations from '~/modules/organization/service'
import * as DeviceBinding from '~/modules/session/device-binding'
import * as openapi from '~/openapi'

/** Requests per minute from one IP to the route that lists the signed-in user's organizations. */
export const MY_ORGANIZATIONS_READ_RATE_LIMIT = 60

/**
 * Requests per minute from one IP to each route that creates an organization or changes the
 * session's active one. Switching is a click, creating is rarer.
 */
export const MY_ORGANIZATIONS_WRITE_RATE_LIMIT = 20

// Mounted at `/v1/client/me/organizations`: the signed-in user's own organizations and the
// session's active one (ADR 0065, Orgs 02).
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

router.get(
  '/',
  describeRoute({
    operationId: 'listMyOrganizations',
    tags: ['Organizations'],
    summary: 'List my organizations',
    description:
      'The organizations the signed-in user belongs to, the one they joined first at the top, ' +
      'with their role in each and its permission keys, and the session’s active ' +
      `organization (\`activeOrganizationId\`, \`null\` for the personal account). ${disabled}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'One page of organizations.', content: json(UserOrganizationListSchema) },
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organizations_list',
    limit: MY_ORGANIZATIONS_READ_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('query', OrganizationPageQuerySchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { sub, sid } = c.get('session')
    return c.json(
      UserOrganizationListSchema.parse(
        await Me.list(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          c.req.valid('query')
        )
      )
    )
  }
)

router.post(
  '/',
  describeRoute({
    operationId: 'createMyOrganization',
    tags: ['Organizations'],
    summary: 'Create an organization',
    description:
      'Creates an organization with the signed-in user as its first member, holding the ' +
      'environment’s `creatorRole`. Only where `organizations.allowUserCreated` is on ' +
      '(`organization.creation_disabled` otherwise), and up to `organizations.maxCreatedPerUser` ' +
      'organizations created by one user (`organization.limit_reached`). A slug another ' +
      'organization has is `organization.slug_taken` (409). The session does not switch to it: ' +
      `call \`PUT /v1/client/me/organizations/active\`. ${disabled}`,
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      201: { description: 'The organization.', content: json(UserOrganizationSchema) },
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organizations_create',
    limit: MY_ORGANIZATIONS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('json', CreateOrganizationRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      UserOrganizationSchema.parse(
        await Me.create(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('json'),
          userActor(c)
        )
      ),
      201
    )
  }
)

router.put(
  '/active',
  describeRoute({
    operationId: 'setActiveOrganization',
    tags: ['Organizations'],
    summary: 'Set the active organization',
    description:
      'Makes an organization the one the session acts in, or clears it (`organizationId: null`, ' +
      'the personal account, where `organizations.personalAccount` allows it: ' +
      '`organization.personal_account_disabled` otherwise). The user must belong to the ' +
      'organization: one they do not belong to, and one that does not exist, both answer ' +
      '`organization.not_a_member` (403). A `hybrid` session gets a **new access token** that ' +
      'carries `org_id`, `org_role` and `org_perms` (none once cleared) and keeps its refresh ' +
      'token; a `stateful` session gets none and its next request carries them. Every later ' +
      'token re-reads the membership: a user removed from the organization, or given another ' +
      `role, has the change at the next refresh. ${disabled}`,
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      200: {
        description: 'The session and its active organization.',
        content: json(ActiveOrganizationSchema),
      },
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organizations_set_active',
    limit: MY_ORGANIZATIONS_WRITE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  validator('json', SetActiveOrganizationRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { sub, sid } = c.get('session')
    return c.json(
      ActiveOrganizationSchema.parse(
        await Me.setActive(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          c.req.valid('json').organizationId
        )
      )
    )
  }
)

type LookupContext = Context<AppEnv & { Variables: TenantVariables & SessionVariables }, string>

/**
 * The per-session limit of a lookup route, after `sessionAuth()` has set the session.
 *
 * @param name - The limiter's name.
 * @returns The rate-limit middleware.
 */
function perSession(name: string) {
  return rateLimit({
    name,
    limit: MY_ORGANIZATIONS_READ_RATE_LIMIT,
    window: '1m',
    // `rateLimit`'s context is the bare `AppEnv`; `sessionAuth()` has set `session` by now.
    key: (c) => {
      const { sid } = (c as unknown as LookupContext).get('session')
      return `sid:${sid}`
    },
  })
}

/**
 * Require the DPoP proof of a device-bound session, as at a refresh.
 *
 * @param c - The request's context, past `sessionAuth()`.
 * @throws AuthError when the proof is missing or invalid.
 */
async function proveDevice(c: LookupContext): Promise<void> {
  const claims = c.get('session')
  if (claims.cnf) {
    await DeviceBinding.atResource(c.get('deps'), c.get('tenant'), claims.cnf.jkt, {
      proof: c.req.header(DPOP_HEADER),
      method: c.req.method,
      path: c.req.path,
    })
  }
}

/**
 * Whether an `If-None-Match` header names the ETag `"hash"`: a comma list, `*` and the weak
 * form `W/"…"` all count (RFC 9110 §13.1.2; a weak comparison is what a GET revalidation uses).
 *
 * @param header - The request's `If-None-Match` value.
 * @param hash - The permissions hash the ETag holds.
 * @returns True when the client's copy is current.
 */
function etagMatches(header: string | undefined, hash: string): boolean {
  return (
    header?.split(',').some((tag) => {
      const value = tag.trim()
      return value === '*' || value.replace(/^W\//, '') === `"${hash}"`
    }) ?? false
  )
}

router.get(
  '/active/permissions',
  describeRoute({
    operationId: 'getActiveOrganizationPermissions',
    tags: ['Organizations'],
    summary: "Read the permissions of the token's role version",
    description:
      'The permissions behind the `org_role`, `org_rv` and `org_ph` claims of the access token, ' +
      'for a token that carries a hash and not the list. Answers only while the stored ' +
      "snapshot's hash is the token's; every other case (no active organization, no snapshot, " +
      'a hash that does not match) is the same `organization.permissions_unavailable` (404). ' +
      'The answer never changes for that hash, so it is cached for good and revalidated with ' +
      '`If-None-Match` (304). A device-bound session sends a DPoP proof, as at a refresh. ' +
      disabled,
    security: openapi.security.session,
    responses: {
      200: {
        description: "The role version's permissions.",
        content: json(ActiveOrganizationPermissionsSchema),
      },
      304: { description: "The client's copy (its `ETag`) is current." },
      404: openapi.responses[404],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organizations_permissions',
    limit: MY_ORGANIZATIONS_READ_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  perSession('my_organizations_permissions_session'),
  async (c) => {
    const claims = c.get('session')
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    await Organizations.requireEnabled(deps, tenant)
    await proveDevice(c)
    const unavailable = new AuthError('organization.permissions_unavailable')
    const role = claims.org_role
    const version = claims.org_rv
    const hash = claims.org_ph
    if (!role || version === undefined || !hash) {
      throw unavailable
    }
    const found = await deps.organizations.findRole(tenant.environmentId, role)
    const snapshot =
      found && (await deps.organizations.findRoleVersion(tenant.environmentId, found.id, version))
    if (!snapshot || !timingSafeEqual(snapshot.permissionsHash, hash)) {
      throw unavailable
    }
    c.header('Cache-Control', 'private, max-age=31536000, immutable')
    c.header('Vary', 'Authorization')
    c.header('ETag', `"${hash}"`)
    if (etagMatches(c.req.header('if-none-match'), hash)) {
      return c.body(null, 304)
    }
    return c.json(
      ActiveOrganizationPermissionsSchema.parse({
        role,
        version,
        permissions: snapshot.permissions,
        hash,
      })
    )
  }
)

router.get(
  '/active/permissions/latest',
  describeRoute({
    operationId: 'getLatestActiveOrganizationPermissions',
    tags: ['Organizations'],
    summary: "Read the latest permissions of the token's role",
    description:
      "The role's current snapshot for the token's organization and role, for a verifier that " +
      'learned of a newer version from a webhook. Answers only while the caller is still a ' +
      'member holding that role; every other case is the same ' +
      '`organization.permissions_unavailable` (404). It changes, so it is never cached. ' +
      'A device-bound session sends a DPoP proof, as at a refresh. ' +
      disabled,
    security: openapi.security.session,
    responses: {
      200: {
        description: "The role version's permissions.",
        content: json(ActiveOrganizationPermissionsSchema),
      },
      304: { description: "The client's copy (its `ETag`) is current." },
      404: openapi.responses[404],
      ...errors,
    },
  }),
  rateLimit({
    name: 'my_organizations_permissions_latest',
    limit: MY_ORGANIZATIONS_READ_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  perSession('my_organizations_permissions_latest_session'),
  async (c) => {
    const claims = c.get('session')
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    await Organizations.requireEnabled(deps, tenant)
    await proveDevice(c)
    const unavailable = new AuthError('organization.permissions_unavailable')
    const role = claims.org_role
    const organizationId = claims.org_id
    if (!role || !organizationId) {
      throw unavailable
    }
    const member = await deps.organizations.findMembership(
      tenant.environmentId,
      organizationId,
      claims.sub
    )
    const found =
      member?.roleKey === role && (await deps.organizations.findRole(tenant.environmentId, role))
    const snapshot =
      found &&
      (await deps.organizations.findRoleVersion(tenant.environmentId, found.id, found.version))
    if (!found || !snapshot) {
      throw unavailable
    }
    c.header('Cache-Control', 'no-store')
    return c.json(
      ActiveOrganizationPermissionsSchema.parse({
        role,
        version: found.version,
        permissions: snapshot.permissions,
        hash: snapshot.permissionsHash,
      })
    )
  }
)

export default router
