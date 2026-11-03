import type {
  CreateSsoConnectionRequest,
  SsoConnection,
  SsoConnectionField,
  UpdateSsoConnectionRequest,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as Outbound from '~/lib/outbound'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import { lapsed } from '~/modules/organization-domain/service'
import * as Settings from '~/modules/settings/service'
import type {
  SsoConnectionChanges,
  SsoConnectionRecord,
  SsoConnectionStatus,
} from '~/ports/sso-connection-store'

// Enterprise connections (ADR 0067): the admin side. The sign-in itself is `modules/sso`.

/** The secret-box purpose a connection's client secret is sealed with. */
export const SECRET_PURPOSE = 'sso-connection-secret'

/**
 * The associated data binding a sealed secret to its connection, so it opens nowhere else.
 *
 * @param environmentId - The environment.
 * @param connectionId - The connection.
 * @returns The associated data.
 */
export function secretAad(environmentId: string, connectionId: string): string {
  return `${environmentId}:${connectionId}`
}

/**
 * Refuse every connection route while organizations or single sign-on are switched off.
 *
 * @param deps - Settings and config.
 * @param tenant - The environment.
 * @throws AuthError `organization.disabled` or `sso.disabled`.
 */
export async function requireEnabled(
  deps: Pick<Deps, 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<void> {
  await Organizations.requireEnabled(deps, tenant)
  if (!(await Settings.current(deps, tenant)).sso.enabled) {
    throw new AuthError('sso.disabled')
  }
}

function view(record: SsoConnectionRecord): SsoConnection {
  return {
    id: record.id,
    organizationId: record.organizationId,
    protocol: record.protocol,
    name: record.name,
    status: record.status,
    issuer: record.issuer,
    clientId: record.clientId,
    clientSecretSet: true,
    defaultRole: record.defaultRole,
    domains: record.domains,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

async function requireConnection(
  deps: Pick<Deps, 'ssoConnections'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<SsoConnectionRecord> {
  const record = await deps.ssoConnections.find(tenant.environmentId, id)
  if (!record) {
    throw new AuthError('sso.connection_not_found')
  }
  return record
}

/** The guard's fixed word is all the answer says about why an issuer was refused. */
async function requireCallableIssuer(deps: Pick<Deps, 'outbound'>, issuer: string): Promise<void> {
  try {
    await Outbound.check(deps.outbound, issuer)
  } catch (error) {
    if (error instanceof Outbound.OutboundError) {
      throw new AuthError('sso.issuer_not_allowed', { reason: error.reason })
    }
    throw error
  }
}

/**
 * Every domain must be a verified, unlapsed domain of this organization. Read through `lapsed`
 * like every reader of verified rows (ADR 0065): a lapsed claim binds nothing.
 */
async function requireOwnDomains(
  deps: Pick<Deps, 'organizationDomains' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  organizationId: string,
  domains: readonly string[]
): Promise<string[]> {
  const unique = [...new Set(domains)].sort()
  for (const domain of unique) {
    const row = await deps.organizationDomains.findVerified(tenant.environmentId, domain)
    if (!row || row.organizationId !== organizationId || lapsed(row, deps.clock.now())) {
      throw new AuthError('sso.domain_not_verified')
    }
  }
  return unique
}

/**
 * List an organization's connections.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param organizationId - The organization.
 * @returns Its connections, oldest first.
 */
export async function list(
  deps: Pick<Deps, 'ssoConnections' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  organizationId: string
): Promise<SsoConnection[]> {
  await requireEnabled(deps, tenant)
  return (await deps.ssoConnections.list(tenant.environmentId, organizationId)).map(view)
}

/**
 * Read one connection.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param id - The connection.
 * @returns The connection, without its secret.
 * @throws AuthError `sso.connection_not_found`.
 */
export async function get(
  deps: Pick<Deps, 'ssoConnections' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<SsoConnection> {
  await requireEnabled(deps, tenant)
  return view(await requireConnection(deps, tenant, id))
}

/**
 * Create a connection as a draft.
 *
 * The client secret is sealed with the secret box and never returned. A draft claims no
 * domain; only activation does (`sso.domain_taken` when another active connection has one).
 *
 * @param deps - Stores, secret box, outbound guard, ids and clock.
 * @param tenant - The environment.
 * @param input - The connection.
 * @param actor - Who creates it, for the audit log.
 * @returns The connection.
 * @throws AuthError `sso.issuer_not_allowed`, `sso.domain_not_verified`, `sso.name_taken`.
 * @throws NotFoundError when the organization is not this environment's.
 */
export async function create(
  deps: Pick<
    Deps,
    | 'ssoConnections'
    | 'organizations'
    | 'organizationDomains'
    | 'secretBox'
    | 'outbound'
    | 'ids'
    | 'clock'
    | 'environmentSettings'
    | 'config'
  >,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: CreateSsoConnectionRequest,
  actor: Actor
): Promise<SsoConnection> {
  await requireEnabled(deps, tenant)
  if (!(await deps.organizations.find(tenant.environmentId, input.organizationId))) {
    throw new NotFoundError()
  }
  await Organizations.requireRole(deps, tenant, input.defaultRole)
  await requireCallableIssuer(deps, input.issuer)
  const domains = await requireOwnDomains(deps, tenant, input.organizationId, input.domains)
  const id = deps.ids.next()
  const sealed = await deps.secretBox.seal(
    SECRET_PURPOSE,
    new TextEncoder().encode(input.clientSecret),
    secretAad(tenant.environmentId, id)
  )
  const activity = Audit.entry(deps, tenant, {
    type: 'sso_connection.created',
    actor,
    target: { type: 'sso_connection', id },
    data: { protocol: input.protocol, status: 'draft', domains: domains.length },
  })
  const stored = await deps.ssoConnections.insert(
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId: input.organizationId,
      protocol: input.protocol,
      name: input.name,
      status: 'draft',
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecretSealed: sealed,
      defaultRole: input.defaultRole,
      domains,
      createdAt: activity.occurredAt,
      updatedAt: activity.occurredAt,
    },
    activity
  )
  if (stored === 'name_taken') {
    throw new AuthError('sso.name_taken')
  }
  if (stored === 'domain_taken') {
    throw new AuthError('sso.domain_taken')
  }
  return view(stored)
}

/** The life of a connection never goes back to a draft. */
function transitionAllowed(from: SsoConnectionStatus, to: SsoConnectionStatus): boolean {
  return from === to || to !== 'draft'
}

/**
 * Change a connection.
 *
 * Fields left out are kept. Activating, or changing the issuer, client, secret, role or
 * domains of an active connection, widens who can sign in, so the audit entry carries
 * `weakened: true`; it names the fields that changed, never their values.
 *
 * @param deps - Stores, secret box, outbound guard, ids and clock.
 * @param tenant - The environment.
 * @param id - The connection.
 * @param input - The fields to change.
 * @param actor - Who changes it, for the audit log.
 * @returns The connection as it is now.
 * @throws AuthError `sso.connection_not_found`, `sso.invalid_transition`, `sso.domain_taken`,
 *   `sso.name_taken`, `sso.domain_not_verified`, `sso.issuer_not_allowed`.
 */
export async function update(
  deps: Pick<
    Deps,
    | 'ssoConnections'
    | 'organizations'
    | 'organizationDomains'
    | 'secretBox'
    | 'outbound'
    | 'clock'
    | 'ids'
    | 'environmentSettings'
    | 'config'
  >,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  input: UpdateSsoConnectionRequest,
  actor: Actor
): Promise<SsoConnection> {
  await requireEnabled(deps, tenant)
  const current = await requireConnection(deps, tenant, id)
  const changes: SsoConnectionChanges = {}
  const changed: SsoConnectionField[] = []
  if (input.name !== undefined && input.name !== current.name) {
    changes.name = input.name
    changed.push('name')
  }
  if (input.issuer !== undefined && input.issuer !== current.issuer) {
    await requireCallableIssuer(deps, input.issuer)
    changes.issuer = input.issuer
    changed.push('issuer')
  }
  if (input.clientId !== undefined && input.clientId !== current.clientId) {
    changes.clientId = input.clientId
    changed.push('clientId')
  }
  if (input.clientSecret !== undefined) {
    changes.clientSecretSealed = await deps.secretBox.seal(
      SECRET_PURPOSE,
      new TextEncoder().encode(input.clientSecret),
      secretAad(tenant.environmentId, id)
    )
    changed.push('clientSecret')
  }
  if (input.defaultRole !== undefined && input.defaultRole !== current.defaultRole) {
    await Organizations.requireRole(deps, tenant, input.defaultRole)
    changes.defaultRole = input.defaultRole
    changed.push('defaultRole')
  }
  if (input.domains !== undefined) {
    const domains = await requireOwnDomains(deps, tenant, current.organizationId, input.domains)
    if (domains.join() !== current.domains.join()) {
      changes.domains = domains
      changed.push('domains')
    }
  }
  const status = input.status ?? current.status
  if (!transitionAllowed(current.status, status)) {
    throw new AuthError('sso.invalid_transition')
  }
  if (status !== current.status) {
    changes.status = status
    changed.push('status')
  }
  if (status === 'active' && (changes.domains ?? current.domains).length === 0) {
    throw new AuthError('sso.domain_not_verified')
  }
  if (changed.length === 0) {
    return view(current)
  }
  const widens =
    changes.status === 'active' ||
    (current.status === 'active' && changed.some((field) => field !== 'name' && field !== 'status'))
  const activity = Audit.entry(deps, tenant, {
    type: 'sso_connection.updated',
    actor,
    target: { type: 'sso_connection', id },
    data: {
      protocol: current.protocol,
      changed,
      status,
      ...(widens ? { weakened: true } : {}),
    },
  })
  const result = await deps.ssoConnections.update(
    tenant.environmentId,
    id,
    changes,
    activity.occurredAt,
    activity
  )
  if (result === 'missing') {
    throw new AuthError('sso.connection_not_found')
  }
  if (result === 'name_taken') {
    throw new AuthError('sso.name_taken')
  }
  if (result === 'domain_taken') {
    throw new AuthError('sso.domain_taken')
  }
  return view(result)
}

/**
 * Delete a connection nobody has signed in through.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param id - The connection.
 * @param actor - Who deletes it, for the audit log.
 * @throws AuthError `sso.connection_not_found`, or `sso.connection_in_use` when an identity
 *   exists: disable the connection instead.
 */
export async function remove(
  deps: Pick<Deps, 'ssoConnections' | 'ids' | 'clock' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  actor: Actor
): Promise<void> {
  await requireEnabled(deps, tenant)
  const current = await requireConnection(deps, tenant, id)
  const activity = Audit.entry(deps, tenant, {
    type: 'sso_connection.deleted',
    actor,
    target: { type: 'sso_connection', id },
    data: { protocol: current.protocol },
  })
  const result = await deps.ssoConnections.delete(tenant.environmentId, id, activity)
  if (result === 'missing') {
    throw new AuthError('sso.connection_not_found')
  }
  if (result === 'in_use') {
    throw new AuthError('sso.connection_in_use')
  }
}
