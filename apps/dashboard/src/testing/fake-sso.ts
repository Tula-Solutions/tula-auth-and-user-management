import {
  CreateSetupLinkRequestSchema,
  CreateSsoConnectionRequestSchema,
  type SetupLink,
  type SsoConnection,
  SsoGroupRolesSchema,
  UpdateSsoConnectionRequestSchema,
} from '@tula-tech/contract'
import { z } from 'zod'
import { type FakeCall, type FakeHandler, failure, IDS } from './fake-api'
import type { FakeDomain, FakeOrganization } from './fake-organizations'
import { invalid } from './fake-webhooks'

// The fake API's SSO connection routes (`/v1/admin/sso-connections`): the shapes and the
// refusals of `apps/api/src/modules/sso-connection`, on plain in-memory data.
//
// What it keeps of the API: every route answers `sso.disabled` (403) while the environment
// has single sign-on off; a connection is made as a draft; its name is unique within its
// organization; a bound domain must be one the organization has verified and no other
// connection uses; the client secret is accepted and never returned (`clientSecretSet` only);
// a connection people signed in through is not deleted (`sso.connection_in_use`).
//
// Where it differs, on purpose: a SAML connection's identity provider values are made up
// (`FAKE_IDP`, with the certificate end in `state.ssoCertificateEnd`), nothing is fetched, and
// there is no rate limit or audit log.

const NOW = '2026-10-23T12:00:00.000Z'
const ENVIRONMENT = 'x-tula-environment'
const SP_BASE = 'https://auth.example.com'

/** A connection as the fake holds it: the API's view, the environment, and who used it. */
export interface FakeSsoConnection extends SsoConnection {
  environmentId: string
  /** Whether anybody has signed in through it: such a connection is not deleted. */
  used: boolean
  /** The client secret as sent, to let a test assert it is kept and never returned. */
  secret: string | null
}

/** The part of the fake's state the SSO routes work on. */
export interface FakeSsoState {
  ssoConnections: FakeSsoConnection[]
  /** The setup links, with the environment each belongs to. */
  setupLinks: (SetupLink & { environmentId: string })[]
  /** When the certificate of a SAML connection made through the fake ends. */
  ssoCertificateEnd: string
  /** The test sign-ins started, by id, with the connection each is of. */
  ssoTests: { testId: string; connectionId: string }[]
  /** What a started test reads as: a test sets it before the window "returns". */
  ssoTestOutcome: 'pending' | 'passed' | 'failed'
  /** The group to role mapping, by connection id. */
  ssoGroupRoles: Record<string, { group: string; role: string }[]>
}

/** What the routes ask of the rest of the fake. */
export interface FakeSsoContext {
  /** Whether the environment has single sign-on switched on. */
  enabled: () => boolean
  organizations: () => FakeOrganization[]
  domains: () => FakeDomain[]
}

let made = 0

/**
 * A connection for a test to put in the fake's state, in the development environment.
 *
 * @param overrides - What differs; `organizationId` should be given.
 * @returns The connection.
 */
export function fakeSsoConnection(overrides: Partial<FakeSsoConnection> = {}): FakeSsoConnection {
  made += 1
  const id = overrides.id ?? `00000000-0000-7000-8000-e${String(made).padStart(11, '0')}`
  const protocol = overrides.protocol ?? 'oidc'
  return {
    id,
    environmentId: IDS.development,
    organizationId: '00000000-0000-7000-8000-0000000aaa01',
    protocol,
    name: 'Okta',
    status: 'draft',
    issuer: protocol === 'oidc' ? 'https://login.example.com' : '',
    clientId: protocol === 'oidc' ? 'client-1' : '',
    clientSecretSet: protocol === 'oidc',
    saml: null,
    redirectUri: protocol === 'oidc' ? `${SP_BASE}/v1/sso/callback/${id}` : null,
    defaultRole: 'member',
    enforced: false,
    breakGlassRole: null,
    trustIdpMfa: false,
    attributeMapping: null,
    tested: false,
    domains: [],
    createdAt: NOW,
    updatedAt: NOW,
    used: false,
    secret: protocol === 'oidc' ? 'seed-secret' : null,
    ...overrides,
  }
}

/**
 * The service provider side of a SAML connection, as the API builds it from the connection's id.
 *
 * @param id - The connection id.
 * @param environmentId - The environment.
 * @returns The three values to give the identity provider.
 */
export function fakeServiceProvider(id: string, environmentId: string) {
  const base = `${SP_BASE}/v1/environments/${environmentId}/sso/saml/${id}`
  return {
    spEntityId: `${base}/metadata`,
    acsUrl: `${base}/acs`,
    spMetadataUrl: `${base}/metadata`,
  }
}

function view({ environmentId: _e, used: _u, secret: _s, ...connection }: FakeSsoConnection) {
  return connection
}

const IdParam = z.object({ id: z.uuid() })
const ListQuery = z.object({ organizationId: z.uuid() })

/**
 * The SSO routes of the fake API.
 *
 * @param state - The fake's state; the routes read and change its SSO part.
 * @param context - What the routes ask of the rest of the fake.
 * @returns The routes, in the fake's own table format.
 */
export function ssoRoutes(
  state: FakeSsoState,
  context: FakeSsoContext
): [string, RegExp, FakeHandler][] {
  const environmentOf = (call: FakeCall) => call.headers.get(ENVIRONMENT) ?? ''
  const off = () =>
    failure(403, 'sso.disabled', 'Single sign-on is not enabled for this environment.')
  const notFound = () => failure(404, 'sso.connection_not_found', 'The connection does not exist.')

  function domainRefusal(
    environmentId: string,
    organizationId: string,
    domains: string[],
    except?: string
  ): Response | null {
    for (const domain of domains) {
      const verified = context
        .domains()
        .some(
          (entry) =>
            entry.environmentId === environmentId &&
            entry.organizationId === organizationId &&
            entry.domain === domain &&
            entry.verifiedAt !== null
        )
      if (!verified) {
        return failure(422, 'sso.domain_not_verified', 'The domain is not verified.')
      }
      const taken = state.ssoConnections.some(
        (entry) =>
          entry.environmentId === environmentId &&
          entry.id !== except &&
          entry.domains.includes(domain)
      )
      if (taken) {
        return failure(409, 'sso.domain_taken', 'The domain is bound to another connection.')
      }
    }
    return null
  }

  function samlView(id: string, environmentId: string, previous: SsoConnection['saml']) {
    return {
      idpEntityId: 'https://idp.example.com/entity',
      ssoUrl: 'https://idp.example.com/sso',
      metadataUrl: previous?.metadataUrl ?? null,
      certificates: [
        {
          fingerprint: 'AB:CD:EF:01',
          notAfter: state.ssoCertificateEnd,
          expired: Date.parse(state.ssoCertificateEnd) <= Date.parse(NOW),
        },
      ],
      ...fakeServiceProvider(id, environmentId),
    }
  }

  const find = (call: FakeCall, id: string) =>
    state.ssoConnections.find(
      (entry) => entry.id === id && entry.environmentId === environmentOf(call)
    )

  return [
    [
      'GET',
      /^\/v1\/admin\/sso-connections$/,
      (call) => {
        if (!context.enabled()) {
          return off()
        }
        const query = ListQuery.safeParse(Object.fromEntries(call.search))
        if (!query.success) {
          return invalid(query.error)
        }
        return {
          connections: state.ssoConnections
            .filter(
              (entry) =>
                entry.environmentId === environmentOf(call) &&
                entry.organizationId === query.data.organizationId
            )
            .map(view),
        }
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/sso-connections$/,
      (call) => {
        if (!context.enabled()) {
          return off()
        }
        const body = CreateSsoConnectionRequestSchema.safeParse(call.body ?? {})
        if (!body.success) {
          return invalid(body.error)
        }
        const environmentId = environmentOf(call)
        const input = body.data
        if (
          !context
            .organizations()
            .some(
              (entry) => entry.id === input.organizationId && entry.environmentId === environmentId
            )
        ) {
          return failure(404, 'resource.not_found', 'The organization does not exist.')
        }
        if (
          state.ssoConnections.some(
            (entry) =>
              entry.environmentId === environmentId &&
              entry.organizationId === input.organizationId &&
              entry.name === input.name
          )
        ) {
          return failure(409, 'sso.name_taken', 'The name is taken.')
        }
        if (input.protocol === 'oidc' && !(input.issuer && input.clientId && input.clientSecret)) {
          return failure(422, 'validation.failed', 'The request is not valid.', [
            {
              field: 'issuer',
              code: 'validation.failed',
              message: 'An OIDC connection needs an issuer, a client id and a secret.',
            },
          ])
        }
        if (input.protocol === 'saml' && !input.saml) {
          return failure(422, 'sso.saml_invalid', 'The SAML values are not valid.')
        }
        const refused = domainRefusal(environmentId, input.organizationId, input.domains)
        if (refused) {
          return refused
        }
        made += 1
        const id = `00000000-0000-7000-8000-d${String(made).padStart(11, '0')}`
        const connection = fakeSsoConnection({
          id,
          environmentId,
          organizationId: input.organizationId,
          protocol: input.protocol,
          name: input.name,
          issuer: input.issuer ?? '',
          clientId: input.clientId ?? '',
          clientSecretSet: input.protocol === 'oidc',
          secret: input.clientSecret ?? null,
          defaultRole: input.defaultRole,
          enforced: false,
          breakGlassRole: null,
          trustIdpMfa: false,
          domains: input.domains,
          saml: input.protocol === 'saml' ? samlView(id, environmentId, null) : null,
        })
        state.ssoConnections.push(connection)
        return new Response(JSON.stringify(view(connection)), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      },
    ],
    [
      'PATCH',
      /^\/v1\/admin\/sso-connections\/([^/]+)$/,
      (call, match) => {
        if (!context.enabled()) {
          return off()
        }
        const params = IdParam.safeParse({ id: match[1] })
        const body = UpdateSsoConnectionRequestSchema.safeParse(call.body ?? {})
        if (!params.success || !body.success) {
          return invalid((params.success ? body : params).error as z.ZodError)
        }
        const connection = find(call, params.data.id)
        if (!connection) {
          return notFound()
        }
        const changes = body.data
        if (changes.domains) {
          const refused = domainRefusal(
            connection.environmentId,
            connection.organizationId,
            changes.domains,
            connection.id
          )
          if (refused) {
            return refused
          }
        }
        if (changes.status === 'active' && !connection.tested) {
          return failure(409, 'sso.test_required', 'Run a passing test sign-in first.')
        }
        const { saml, clientSecret, ...plain } = changes
        // A change to what a test exercises resets its pass, as the server's fingerprint does.
        const exercised = ['issuer', 'clientId', 'defaultRole', 'domains', 'attributeMapping']
        if (clientSecret !== undefined || saml || exercised.some((key) => key in plain)) {
          connection.tested = false
        }
        Object.assign(connection, plain, { updatedAt: NOW })
        if (clientSecret !== undefined) {
          connection.secret = clientSecret
          connection.clientSecretSet = true
        }
        if (saml) {
          connection.saml = samlView(connection.id, connection.environmentId, connection.saml)
        }
        return view(connection)
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/sso-connections\/([^/]+)\/tests$/,
      (call, match) => {
        if (!context.enabled()) {
          return off()
        }
        const connection = find(call, match[1] ?? '')
        if (!connection) {
          return notFound()
        }
        made += 1
        const testId = `00000000-0000-7000-8000-c${String(made).padStart(11, '0')}`
        state.ssoTests.push({ testId, connectionId: connection.id })
        return new Response(
          JSON.stringify({ testId, authorizationUrl: 'https://login.example.com/authorize?s=1' }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/sso-connections\/([^/]+)\/tests\/([^/]+)$/,
      (call, match) => {
        if (!context.enabled()) {
          return off()
        }
        const connection = find(call, match[1] ?? '')
        const test = state.ssoTests.find(
          (entry) => entry.testId === match[2] && entry.connectionId === connection?.id
        )
        if (!connection || !test) {
          return failure(404, 'sso.test_not_found', 'No such test sign-in.')
        }
        const outcome = state.ssoTestOutcome
        if (outcome === 'passed') {
          connection.tested = true
        }
        return {
          testId: test.testId,
          status: outcome,
          reason: outcome === 'failed' ? 'wrong_audience' : null,
          message: outcome === 'failed' ? 'The response was meant for another application.' : null,
          attributes: outcome === 'passed' ? [{ name: 'email', values: ['ada@acme.com'] }] : [],
          groups: outcome === 'passed' ? ['engineering'] : [],
          mapped:
            outcome === 'passed'
              ? {
                  email: 'ada@acme.com',
                  givenName: 'Ada',
                  familyName: 'Lovelace',
                  emailOnVerifiedDomain: true,
                }
              : null,
        }
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/sso-connections\/([^/]+)\/group-roles$/,
      (call, match) => {
        if (!context.enabled()) {
          return off()
        }
        const connection = find(call, match[1] ?? '')
        return connection ? { mappings: state.ssoGroupRoles[connection.id] ?? [] } : notFound()
      },
    ],
    [
      'PUT',
      /^\/v1\/admin\/sso-connections\/([^/]+)\/group-roles$/,
      (call, match) => {
        if (!context.enabled()) {
          return off()
        }
        const connection = find(call, match[1] ?? '')
        const body = SsoGroupRolesSchema.safeParse(call.body ?? {})
        if (!body.success) {
          return invalid(body.error)
        }
        if (!connection) {
          return notFound()
        }
        state.ssoGroupRoles[connection.id] = body.data.mappings
        return { mappings: body.data.mappings }
      },
    ],
    [
      'DELETE',
      /^\/v1\/admin\/sso-connections\/([^/]+)$/,
      (call, match) => {
        if (!context.enabled()) {
          return off()
        }
        const connection = find(call, match[1] ?? '')
        if (!connection) {
          return notFound()
        }
        if (connection.status === 'active') {
          return failure(409, 'sso.connection_in_use', 'The connection is active.')
        }
        state.ssoConnections = state.ssoConnections.filter((entry) => entry !== connection)
        return new Response(null, { status: 204 })
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/setup-links$/,
      (call) => {
        if (!context.enabled()) {
          return off()
        }
        const organizationId = call.search.get('organizationId')
        return {
          links: state.setupLinks
            .filter(
              (entry) =>
                entry.environmentId === environmentOf(call) &&
                entry.organizationId === organizationId
            )
            .map(({ environmentId: _environmentId, ...link }) => link),
        }
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/setup-links$/,
      (call) => {
        if (!context.enabled()) {
          return off()
        }
        const body = CreateSetupLinkRequestSchema.safeParse(call.body ?? {})
        if (!body.success) {
          return invalid(body.error)
        }
        const id = `0190a000-0000-7000-8000-${String(state.setupLinks.length + 1).padStart(12, '0')}`
        const token = `tula_setup_${environmentOf(call).replaceAll('-', '')}_fake${id.slice(-4)}`
        const link = {
          id,
          organizationId: body.data.organizationId,
          name: body.data.name,
          prefix: token.slice(0, 16),
          expiresAt: new Date(Date.now() + body.data.expiresInDays * 86_400_000).toISOString(),
          revokedAt: null,
          lastUsedAt: null,
          createdAt: NOW,
        }
        state.setupLinks.unshift({ ...link, environmentId: environmentOf(call) })
        return new Response(
          JSON.stringify({ ...link, token, url: `${SP_BASE}/dashboard/setup#token=${token}` }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      },
    ],
    [
      'DELETE',
      /^\/v1\/admin\/setup-links\/([^/]+)$/,
      (call, match) => {
        if (!context.enabled()) {
          return off()
        }
        const link = state.setupLinks.find(
          (entry) => entry.id === match[1] && entry.environmentId === environmentOf(call)
        )
        if (!link) {
          return failure(404, 'resource.not_found', 'The setup link does not exist.')
        }
        link.revokedAt = NOW
        return new Response(null, { status: 204 })
      },
    ],
  ]
}
