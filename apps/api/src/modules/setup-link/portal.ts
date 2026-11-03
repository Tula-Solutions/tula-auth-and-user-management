import type {
  SetupConnectionCreate,
  SetupConnectionUpdate,
  SetupPortal,
  SsoConnection,
  SsoGroupRoles,
  SsoTestResult,
  SsoTestStart,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as SsoConnections from '~/modules/sso-connection/service'
import * as SsoTests from '~/modules/sso-test/service'
import { PORTAL_PATH } from './service'

// What a setup link opens (ADR 0067, "Setup links"). Every function here takes the link's
// organization from the middleware, never from the request, and calls the same connection and
// test services the admin routes call, with the `setup_link` actor. The body schemas hold the
// fields a link may send; `enforced`, `trustIdpMfa`, `breakGlassRole` and `defaultRole` are not
// among them, so they stay with the operator and the organization's administrators.

/** The link a portal request was authorized by, as `setupLink()` resolved it. */
export interface Scope {
  organizationId: string
  expiresAt: Date
}

type ConnectionDeps = Parameters<typeof SsoConnections.update>[0]
type PortalDeps = ConnectionDeps & Pick<Deps, 'organizationDomains'>
type TestDeps = Deps

/**
 * The connection, if it is the link's organization's. Another organization's connection and
 * one that does not exist are the same answer.
 */
async function requireOwn(
  deps: Pick<Deps, 'ssoConnections'>,
  tenant: Pick<Tenant, 'environmentId'>,
  scope: Scope,
  id: string
): Promise<void> {
  const found = await deps.ssoConnections.find(tenant.environmentId, id)
  if (!found || found.organizationId !== scope.organizationId) {
    throw new AuthError('sso.connection_not_found')
  }
}

/**
 * What the portal shows first: the organization, its verified domains, the link's life and the
 * organization's connections.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param scope - The link's organization and expiry.
 * @returns The portal's view.
 * @throws AuthError `sso.disabled`; NotFoundError when the organization is gone.
 */
export async function show(
  deps: Pick<
    Deps,
    | 'ssoConnections'
    | 'organizations'
    | 'organizationDomains'
    | 'environmentSettings'
    | 'config'
    | 'clock'
  >,
  tenant: Pick<Tenant, 'environmentId'>,
  scope: Scope
): Promise<SetupPortal> {
  await SsoConnections.requireEnabled(deps, tenant)
  const organization = await deps.organizations.find(tenant.environmentId, scope.organizationId)
  if (!organization) {
    throw new NotFoundError()
  }
  const domains = await deps.organizationDomains.list(tenant.environmentId, scope.organizationId)
  return {
    organization: { id: organization.id, name: organization.name },
    domains: domains.filter((one) => one.verifiedAt !== null).map((one) => one.domain),
    expiresAt: scope.expiresAt.toISOString(),
    connections: await SsoConnections.list(deps, tenant, scope.organizationId),
  }
}

/**
 * Create a draft connection for the link's organization.
 *
 * @param deps - What `SsoConnections.create` needs.
 * @param tenant - The environment.
 * @param scope - The link's organization.
 * @param input - The connection; its default role is the admin API's default, never sent.
 * @param actor - The `setup_link` actor.
 * @returns The connection.
 */
export async function createConnection(
  deps: Parameters<typeof SsoConnections.create>[0],
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  scope: Scope,
  input: SetupConnectionCreate,
  actor: Actor
): Promise<SsoConnection> {
  return SsoConnections.create(
    deps,
    tenant,
    { ...input, organizationId: scope.organizationId, defaultRole: 'member' },
    actor
  )
}

/**
 * Read one of the link's organization's connections.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param scope - The link's organization.
 * @param id - The connection.
 * @returns The connection.
 * @throws AuthError `sso.connection_not_found` for another organization's.
 */
export async function getConnection(
  deps: Pick<Deps, 'ssoConnections' | 'environmentSettings' | 'config' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  scope: Scope,
  id: string
): Promise<SsoConnection> {
  await requireOwn(deps, tenant, scope, id)
  return SsoConnections.get(deps, tenant, id)
}

/**
 * Change one of the link's organization's connections: the fields of
 * `SetupConnectionUpdate` only, and a status that can only be `active` (the service still
 * requires a passing test of the current settings).
 *
 * @param deps - What `SsoConnections.update` needs.
 * @param tenant - The environment.
 * @param scope - The link's organization.
 * @param id - The connection.
 * @param input - The fields to change.
 * @param actor - The `setup_link` actor.
 * @returns The connection as it is now.
 * @throws AuthError `sso.connection_not_found` for another organization's.
 */
export async function updateConnection(
  deps: PortalDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  scope: Scope,
  id: string,
  input: SetupConnectionUpdate,
  actor: Actor
): Promise<SsoConnection> {
  await requireOwn(deps, tenant, scope, id)
  return SsoConnections.update(deps, tenant, id, input, actor)
}

/**
 * Read a SAML connection's metadata address again.
 *
 * @param deps - What `SsoConnections.refreshMetadata` needs.
 * @param tenant - The environment.
 * @param scope - The link's organization.
 * @param id - The connection.
 * @param actor - The `setup_link` actor.
 * @returns The connection.
 * @throws AuthError `sso.connection_not_found` for another organization's.
 */
export async function refreshMetadata(
  deps: PortalDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  scope: Scope,
  id: string,
  actor: Actor
): Promise<SsoConnection> {
  await requireOwn(deps, tenant, scope, id)
  return SsoConnections.refreshMetadata(deps, tenant, id, actor)
}

/**
 * Read the group to role mapping of one of the link's organization's connections.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param scope - The link's organization.
 * @param id - The connection.
 * @returns The mappings.
 * @throws AuthError `sso.connection_not_found` for another organization's.
 */
export async function getGroupRoles(
  deps: Pick<Deps, 'ssoConnections' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  scope: Scope,
  id: string
): Promise<SsoGroupRoles> {
  await requireOwn(deps, tenant, scope, id)
  return SsoConnections.getGroupRoles(deps, tenant, id)
}

/**
 * Replace the group to role mapping. Residual risk (ADR 0067): the link's holder controls
 * the identity provider, so they decide which of its groups become which role; the operator
 * who made the link trusted them with that.
 *
 * @param deps - What `SsoConnections.putGroupRoles` needs.
 * @param tenant - The environment.
 * @param scope - The link's organization.
 * @param id - The connection.
 * @param input - The mappings.
 * @param actor - The `setup_link` actor.
 * @returns The mappings as saved.
 * @throws AuthError `sso.connection_not_found` for another organization's.
 */
export async function putGroupRoles(
  deps: Parameters<typeof SsoConnections.putGroupRoles>[0],
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  scope: Scope,
  id: string,
  input: SsoGroupRoles,
  actor: Actor
): Promise<SsoGroupRoles> {
  await requireOwn(deps, tenant, scope, id)
  return SsoConnections.putGroupRoles(deps, tenant, id, input, actor)
}

/**
 * Start a test sign-in. The browser returns to the portal page itself, an address the server
 * builds from `PUBLIC_URL`: the link needs no entry in the environment's redirect list.
 *
 * @param deps - All the ports the SSO round uses.
 * @param tenant - The environment.
 * @param scope - The link's organization.
 * @param id - The connection.
 * @param actor - The `setup_link` actor.
 * @returns The test's id and where to send the browser.
 * @throws AuthError `sso.connection_not_found` for another organization's.
 */
export async function startTest(
  deps: TestDeps,
  tenant: Tenant,
  scope: Scope,
  id: string,
  actor: Actor
): Promise<SsoTestStart> {
  await requireOwn(deps, tenant, scope, id)
  const page = `${deps.config.publicUrl.replace(/\/+$/, '')}${PORTAL_PATH}`
  return SsoTests.start(deps, tenant, id, page, actor, true)
}

/**
 * Read the result of a test of one of the link's organization's connections.
 *
 * @param deps - Flow attempts and connections.
 * @param tenant - The environment.
 * @param scope - The link's organization.
 * @param id - The connection.
 * @param testId - The test.
 * @returns The result.
 * @throws AuthError `sso.connection_not_found`, `sso.test_not_found`.
 */
export async function testResult(
  deps: Parameters<typeof SsoTests.result>[0] & Pick<Deps, 'ssoConnections'>,
  tenant: Tenant,
  scope: Scope,
  id: string,
  testId: string
): Promise<SsoTestResult> {
  await requireOwn(deps, tenant, scope, id)
  return SsoTests.result(deps, tenant, id, testId)
}
