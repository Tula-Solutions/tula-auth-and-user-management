import type {
  CreateSsoConnectionRequest,
  SamlSettingsInput,
  SsoConnection,
  SsoConnectionField,
  SsoGroupRoles,
  UpdateSsoConnectionRequest,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import { sha256Hex } from '~/lib/crypto'
import * as Outbound from '~/lib/outbound'
import { publicBase } from '~/lib/public-base'
import {
  type IdpMetadata,
  parseIdpMetadata,
  readCertificate,
  SamlMetadataError,
} from '~/lib/saml-metadata'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import { lapsed } from '~/modules/organization-domain/service'
import * as Settings from '~/modules/settings/service'
import type {
  SamlSettings,
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

/**
 * The service provider values of a SAML connection, stable for its life: what the operator
 * gives the identity provider. The entity id is the metadata's own address.
 *
 * @param config - The public URL.
 * @param record - The connection.
 * @returns The entity id, the assertion consumer service URL and the metadata URL.
 */
export function samlUrls(
  config: { publicUrl: string },
  record: Pick<SsoConnectionRecord, 'id' | 'environmentId'>
): { spEntityId: string; acsUrl: string; spMetadataUrl: string } {
  const base = `${publicBase(config)}/v1/environments/${record.environmentId}/sso/saml/${record.id}`
  return {
    spEntityId: `${base}/metadata`,
    acsUrl: `${base}/acs`,
    spMetadataUrl: `${base}/metadata`,
  }
}

/**
 * A fingerprint of everything a test sign-in exercises: the protocol, the provider's values,
 * the client, the role, the domains and the attribute mapping. A passing test is good for exactly the settings that
 * hash to the value it stored, so any change to them is a reset with nothing to clear.
 *
 * @param record - A connection, or what it would be after a change.
 * @returns A SHA-256 hex digest.
 */
export function fingerprint(
  record: Pick<
    SsoConnectionRecord,
    | 'protocol'
    | 'issuer'
    | 'clientId'
    | 'clientSecretSealed'
    | 'saml'
    | 'defaultRole'
    | 'domains'
    | 'attributeMapping'
  >
): string {
  return sha256Hex(
    JSON.stringify([
      record.protocol,
      record.issuer,
      record.clientId,
      record.clientSecretSealed,
      record.saml && [
        record.saml.idpEntityId,
        record.saml.ssoUrl,
        record.saml.certificates.map((c) => c.pem),
      ],
      record.defaultRole,
      [...record.domains].sort(),
      record.attributeMapping,
    ])
  )
}

function view(
  config: { publicUrl: string },
  record: SsoConnectionRecord,
  now: Date
): SsoConnection {
  return {
    id: record.id,
    organizationId: record.organizationId,
    protocol: record.protocol,
    name: record.name,
    status: record.status,
    issuer: record.issuer,
    clientId: record.clientId,
    clientSecretSet: record.protocol === 'oidc',
    saml: record.saml && {
      idpEntityId: record.saml.idpEntityId,
      ssoUrl: record.saml.ssoUrl,
      metadataUrl: record.saml.metadataUrl,
      certificates: record.saml.certificates.map((c) => ({
        fingerprint: readCertificate(c.pem).fingerprint,
        notAfter: c.notAfter,
        expired: new Date(c.notAfter).getTime() <= now.getTime(),
      })),
      ...samlUrls(config, record),
    },
    attributeMapping: record.attributeMapping,
    defaultRole: record.defaultRole,
    enforced: record.enforced,
    breakGlassRole: record.breakGlassRole,
    trustIdpMfa: record.trustIdpMfa,
    domains: record.domains,
    tested: record.testedFingerprint === fingerprint(record),
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

const MAX_METADATA_BYTES = 512 * 1024

/**
 * Turn the three ways of giving a SAML identity provider's values into stored settings:
 * pasted metadata, a metadata address fetched through `Outbound.request` (so a private
 * address is refused), or the values by hand. Exactly one way per call. Each certificate is
 * read for its expiry, which is kept.
 *
 * @param deps - The outbound guard.
 * @param input - What the operator gave.
 * @returns The settings to store.
 * @throws AuthError `sso.saml_invalid` (`params.reason`, a fixed word) or
 *   `sso.issuer_not_allowed` for a metadata address the server may not call.
 */
export async function resolveSaml(
  deps: Pick<Deps, 'outbound'>,
  input: SamlSettingsInput
): Promise<SamlSettings> {
  const manual = [input.idpEntityId, input.ssoUrl, input.certificates].some((v) => v !== undefined)
  if (
    [input.metadataXml !== undefined, input.metadataUrl !== undefined, manual].filter(Boolean)
      .length !== 1
  ) {
    throw new AuthError('sso.saml_invalid', { reason: 'one_source' })
  }
  try {
    let metadataUrl: string | null = null
    let values: IdpMetadata
    if (input.metadataUrl !== undefined) {
      const address = input.metadataUrl
      metadataUrl = address
      let answer: Outbound.OutboundResponse
      try {
        answer = await Outbound.request(deps.outbound, address, {
          headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
          maxResponseBytes: MAX_METADATA_BYTES,
        })
      } catch (error) {
        if (error instanceof Outbound.OutboundError) {
          throw new AuthError('sso.issuer_not_allowed', { reason: error.reason })
        }
        throw error
      }
      if (answer.status !== 200) {
        throw new AuthError('sso.saml_invalid', { reason: 'fetch_failed' })
      }
      values = parseIdpMetadata(new TextDecoder().decode(answer.body))
    } else if (input.metadataXml !== undefined) {
      values = parseIdpMetadata(input.metadataXml)
    } else {
      if (!input.idpEntityId || !input.ssoUrl || !input.certificates?.length) {
        throw new AuthError('sso.saml_invalid', { reason: 'incomplete' })
      }
      values = {
        idpEntityId: input.idpEntityId,
        ssoUrl: input.ssoUrl,
        certificates: input.certificates,
      }
    }
    // The browser is sent here: plain http is for the local tier only, as for any address we call.
    const scheme = URL.canParse(values.ssoUrl) ? new URL(values.ssoUrl).protocol : null
    if (scheme === null) {
      throw new AuthError('sso.saml_invalid', { reason: 'sso_url' })
    }
    if (scheme !== 'https:' && !(scheme === 'http:' && deps.outbound.tier === 'local')) {
      throw new AuthError('sso.url_not_https')
    }
    return {
      idpEntityId: values.idpEntityId,
      ssoUrl: values.ssoUrl,
      metadataUrl,
      certificates: values.certificates.map((cert) => {
        const read = readCertificate(cert)
        return { pem: read.pem, notAfter: read.notAfter.toISOString() }
      }),
    }
  } catch (error) {
    if (error instanceof SamlMetadataError) {
      throw new AuthError('sso.saml_invalid', { reason: error.reason })
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
 * @param organizationId - The organization; left out, every connection of the environment.
 * @returns The connections, oldest first.
 */
export async function list(
  deps: Pick<Deps, 'ssoConnections' | 'environmentSettings' | 'config' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  organizationId?: string
): Promise<SsoConnection[]> {
  await requireEnabled(deps, tenant)
  return (await deps.ssoConnections.list(tenant.environmentId, organizationId)).map((r) =>
    view(deps.config, r, deps.clock.now())
  )
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
  deps: Pick<Deps, 'ssoConnections' | 'environmentSettings' | 'config' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<SsoConnection> {
  await requireEnabled(deps, tenant)
  return view(deps.config, await requireConnection(deps, tenant, id), deps.clock.now())
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
 * @throws AuthError `sso.issuer_not_allowed`, `sso.domain_not_verified`, `sso.name_taken`,
 *   `sso.saml_invalid`, `request.malformed` (the fields of the other protocol).
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
  let saml: SamlSettings | null = null
  if (input.protocol === 'saml') {
    if (
      input.issuer !== undefined ||
      input.clientId !== undefined ||
      input.clientSecret !== undefined
    ) {
      throw new AuthError('request.malformed')
    }
    saml = await resolveSaml(deps, input.saml ?? {})
  } else {
    if (!input.issuer || !input.clientId || !input.clientSecret || input.saml !== undefined) {
      throw new AuthError('request.malformed')
    }
    await requireCallableIssuer(deps, input.issuer)
  }
  const domains = await requireOwnDomains(deps, tenant, input.organizationId, input.domains)
  const id = deps.ids.next()
  const sealed = input.clientSecret
    ? await deps.secretBox.seal(
        SECRET_PURPOSE,
        new TextEncoder().encode(input.clientSecret),
        secretAad(tenant.environmentId, id)
      )
    : ''
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
      // A SAML row keeps the identity provider's entity id here and no client at all.
      issuer: saml ? saml.idpEntityId : (input.issuer ?? ''),
      clientId: input.clientId ?? '',
      clientSecretSealed: sealed,
      saml,
      attributeMapping: input.attributeMapping ?? null,
      defaultRole: input.defaultRole,
      enforced: false,
      breakGlassRole: null,
      trustIdpMfa: false,
      domains,
      testedFingerprint: null,
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
  return view(deps.config, stored, deps.clock.now())
}

/**
 * Read the group to role mapping of a connection's organization.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param id - The connection.
 * @returns The mappings in precedence order.
 * @throws AuthError `sso.connection_not_found`.
 */
export async function getGroupRoles(
  deps: Pick<Deps, 'ssoConnections' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<SsoGroupRoles> {
  await requireEnabled(deps, tenant)
  const connection = await requireConnection(deps, tenant, id)
  return {
    mappings: await deps.ssoConnections.listGroupRoles(
      tenant.environmentId,
      connection.organizationId
    ),
  }
}

/**
 * Replace the group to role mapping of a connection's organization. It is held per
 * organization, so SCIM Groups read the same one. The order is the precedence.
 *
 * Group names are directory data: the audit entry records that the mapping changed, never a
 * group, a count of groups or a role.
 *
 * @param deps - Stores, ids and clock.
 * @param tenant - The environment.
 * @param id - The connection whose organization is meant.
 * @param input - The whole new mapping.
 * @param actor - Who changes it, for the audit log.
 * @returns The mapping as saved.
 * @throws AuthError `sso.connection_not_found`, `organization.role_unknown` for a role that
 *   does not exist, `request.malformed` for a group named twice.
 */
export async function putGroupRoles(
  deps: Pick<
    Deps,
    'ssoConnections' | 'organizations' | 'environmentSettings' | 'config' | 'ids' | 'clock'
  >,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  input: SsoGroupRoles,
  actor: Actor
): Promise<SsoGroupRoles> {
  await requireEnabled(deps, tenant)
  const connection = await requireConnection(deps, tenant, id)
  if (new Set(input.mappings.map((one) => one.group)).size !== input.mappings.length) {
    throw new AuthError('request.malformed')
  }
  for (const role of new Set(input.mappings.map((one) => one.role))) {
    await Organizations.requireRole(deps, tenant, role)
  }
  const activity = Audit.entry(deps, tenant, {
    type: 'sso_connection.updated',
    actor,
    target: { type: 'sso_connection', id },
    data: { protocol: connection.protocol, changed: ['groupRoles'], status: connection.status },
  })
  await deps.ssoConnections.replaceGroupRoles(
    {
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId: connection.organizationId,
      mappings: input.mappings,
    },
    activity.occurredAt,
    activity
  )
  return { mappings: input.mappings }
}

/**
 * Record that a test sign-in passed against the connection's settings as they were when it
 * started. A connection changed since then has another fingerprint and is not marked.
 *
 * @param deps - The connection store and clock.
 * @param tenant - The environment.
 * @param id - The connection.
 * @param tested - The fingerprint the test ran against.
 * @param actor - Who started the test, for the audit log.
 * @returns Whether the mark was written: `false` when the settings changed meanwhile.
 */
export async function markTested(
  deps: Pick<Deps, 'ssoConnections' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  tested: string,
  actor: Actor
): Promise<boolean> {
  const current = await deps.ssoConnections.find(tenant.environmentId, id)
  if (!current || fingerprint(current) !== tested) {
    return false
  }
  const activity = Audit.entry(deps, tenant, {
    type: 'sso_connection.updated',
    actor,
    target: { type: 'sso_connection', id },
    data: { protocol: current.protocol, changed: ['test'], status: current.status },
  })
  const result = await deps.ssoConnections.update(
    tenant.environmentId,
    id,
    { testedFingerprint: tested },
    activity.occurredAt,
    activity
  )
  return typeof result !== 'string'
}

/** The life of a connection never goes back to a draft. */
function transitionAllowed(from: SsoConnectionStatus, to: SsoConnectionStatus): boolean {
  return from === to || to !== 'draft'
}

/**
 * Whether a change makes the connection ask less of a sign-in (ADR 0067): activating it, or
 * changing what an active one accepts, and in any case switching enforcement off, trusting
 * the provider for MFA, or naming a break-glass role. Shared by the audit entry's `weakened`.
 *
 * @param current - The connection as it is.
 * @param changes - The fields being changed.
 * @returns `true` when the change is a weakening.
 */
export function weakens(current: SsoConnectionRecord, changes: SsoConnectionChanges): boolean {
  const changedFields = Object.keys(changes).filter((key) => key !== 'name' && key !== 'status')
  return (
    changes.status === 'active' ||
    (current.status === 'active' &&
      changedFields.some((key) => !['enforced', 'breakGlassRole', 'trustIdpMfa'].includes(key))) ||
    (changes.enforced === false && current.enforced) ||
    (changes.trustIdpMfa === true && !current.trustIdpMfa) ||
    (typeof changes.breakGlassRole === 'string' &&
      changes.breakGlassRole !== current.breakGlassRole)
  )
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
  if (
    current.protocol === 'saml' &&
    (input.issuer !== undefined || input.clientId !== undefined || input.clientSecret !== undefined)
  ) {
    throw new AuthError('request.malformed')
  }
  if (current.protocol === 'oidc' && input.saml !== undefined) {
    throw new AuthError('request.malformed')
  }
  if (input.saml !== undefined) {
    const next = await resolveSaml(deps, input.saml)
    if (JSON.stringify(next) !== JSON.stringify(current.saml)) {
      changes.saml = next
      changes.issuer = next.idpEntityId
      changed.push('saml')
    }
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
  if (
    input.attributeMapping !== undefined &&
    JSON.stringify(input.attributeMapping) !== JSON.stringify(current.attributeMapping ?? {})
  ) {
    changes.attributeMapping = input.attributeMapping
    changed.push('attributeMapping')
  }
  if (input.defaultRole !== undefined && input.defaultRole !== current.defaultRole) {
    await Organizations.requireRole(deps, tenant, input.defaultRole)
    changes.defaultRole = input.defaultRole
    changed.push('defaultRole')
  }
  if (input.enforced !== undefined && input.enforced !== current.enforced) {
    changes.enforced = input.enforced
    changed.push('enforced')
  }
  if (input.breakGlassRole !== undefined && input.breakGlassRole !== current.breakGlassRole) {
    if (input.breakGlassRole !== null) {
      await Organizations.requireRole(deps, tenant, input.breakGlassRole)
    }
    changes.breakGlassRole = input.breakGlassRole
    changed.push('breakGlassRole')
  }
  if (input.trustIdpMfa !== undefined && input.trustIdpMfa !== current.trustIdpMfa) {
    changes.trustIdpMfa = input.trustIdpMfa
    changed.push('trustIdpMfa')
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
  // Going live needs a passing test of exactly these settings (a change in this same request counts).
  if (
    status === 'active' &&
    current.status !== 'active' &&
    fingerprint({ ...current, ...changes }) !== current.testedFingerprint
  ) {
    throw new AuthError('sso.test_required')
  }
  if (changed.length === 0) {
    return view(deps.config, current, deps.clock.now())
  }
  const widens = weakens(current, changes)
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
  return view(deps.config, result, deps.clock.now())
}

/**
 * Read a SAML connection's identity provider values again from its metadata address, so a
 * rotated certificate or a moved SSO URL is taken on demand.
 *
 * @param deps - As {@link update}.
 * @param tenant - The environment.
 * @param id - The connection.
 * @param actor - Who asks, for the audit log.
 * @returns The connection as it is now.
 * @throws AuthError `sso.connection_not_found`, `sso.saml_invalid` (`reason: 'no_metadata_url'`
 *   when the values were not given by an address), and those of {@link resolveSaml}.
 */
export async function refreshMetadata(
  deps: Parameters<typeof update>[0],
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  actor: Actor
): Promise<SsoConnection> {
  await requireEnabled(deps, tenant)
  const url = (await requireConnection(deps, tenant, id)).saml?.metadataUrl
  if (!url) {
    throw new AuthError('sso.saml_invalid', { reason: 'no_metadata_url' })
  }
  return update(deps, tenant, id, { saml: { metadataUrl: url } }, actor)
}

/**
 * Delete a connection that is not active, whoever has signed in through it (decision 13).
 *
 * Its identities and domains go with it and the users it managed keep their accounts, no
 * longer managed; disabling an enforced connection was the weakening, so deleting adds none.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param id - The connection.
 * @param actor - Who deletes it, for the audit log.
 * @throws AuthError `sso.connection_not_found`, or `sso.connection_in_use` when the connection
 *   is active: disable it first.
 */
export async function remove(
  deps: Pick<Deps, 'ssoConnections' | 'ids' | 'clock' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  actor: Actor
): Promise<void> {
  await requireEnabled(deps, tenant)
  const current = await requireConnection(deps, tenant, id)
  if (current.status === 'active') {
    throw new AuthError('sso.connection_in_use')
  }
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
}
