import {
  CreateSsoConnectionRequestSchema,
  type SsoConnection,
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
  /** When the certificate of a SAML connection made through the fake ends. */
  ssoCertificateEnd: string
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
    defaultRole: 'member',
    enforced: false,
    breakGlassRole: null,
    trustIdpMfa: false,
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
        const { saml, clientSecret, ...plain } = changes
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
        if (connection.used) {
          return failure(409, 'sso.connection_in_use', 'People have signed in through it.')
        }
        state.ssoConnections = state.ssoConnections.filter((entry) => entry !== connection)
        return new Response(null, { status: 204 })
      },
    ],
  ]
}
