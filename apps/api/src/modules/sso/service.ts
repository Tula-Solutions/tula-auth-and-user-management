import { deflateRawSync } from 'node:zlib'
import {
  effectiveAttributeNames,
  type SessionClient,
  type SsoTestReason,
} from '@tula-tech/contract'
import {
  createLocalJWKSet,
  errors,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, ConflictError } from '~/exceptions'
import { cleanOrigin, type Origin } from '~/lib/actor'
import { timingSafeEqual } from '~/lib/crypto'
import { parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import * as Outbound from '~/lib/outbound'
import { publicBase } from '~/lib/public-base'
import { SAML_NAME_ID_FORMAT } from '~/lib/saml-metadata'
import * as SamlVerifier from '~/lib/saml-verifier'
import * as Audit from '~/modules/audit/service'
import { escapeHtml } from '~/modules/email/templates'
import * as Hooks from '~/modules/hook/service'
import * as Organizations from '~/modules/organization/service'
import { lapsed } from '~/modules/organization-domain/service'
import * as Settings from '~/modules/settings/service'
import { SECRET_PURPOSE, samlUrls, secretAad } from '~/modules/sso-connection/service'
import type { SsoConnectionRecord } from '~/ports/sso-connection-store'
import type { UserRecord } from '~/ports/user-repository'

// The OpenID Connect round of an SSO connection (ADR 0067). Every request to the operator's
// issuer goes through `Outbound.request`; the ID token is verified here with `jose` against
// keys fetched the same way, never with `jose`'s own fetch.

type FetchDeps = Pick<Deps, 'outbound'>

/** A discovery document or a key set is small; a larger answer is not one. */
const MAX_DOCUMENT_BYTES = 256 * 1024

/** How long a discovery document or a key set is reused for one issuer. */
const CACHE_MS = 10 * 60 * 1000

/** Seconds of clock difference accepted on `exp` and `iat`, as for an OAuth provider. */
const CLOCK_TOLERANCE_SECONDS = 30

/**
 * Where a test sign-in collects what the provider sent (attribute or claim names to values),
 * which a real sign-in never reads. Filled only after the answer was verified.
 */
export interface Seen {
  attributes?: Record<string, string[]>
}

/** What a connection's provider vouched for, kept from the callback until the exchange. */
export interface SsoProfile {
  subject: string
  email: string | null
  emailVerified: boolean
  givenName?: string
  familyName?: string
  /**
   * The values of the connection's groups attribute or claim, capped. Directory data: read only
   * to choose a role, and never logged, audited or put in an event.
   */
  groups?: string[]
}

/** How many group values and how long each one a profile keeps. */
const MAX_PROFILE_GROUPS = 200
const MAX_GROUP_LENGTH = 256

/**
 * The connection the domain of an identifier is bound to, if single sign-on is on.
 *
 * **Decided by the domain alone.** Whether the address has an account is never read, so a known
 * and an unknown address on a bound domain get the same answer (home-realm discovery, ADR 0067).
 *
 * @param deps - Settings, config and the connection store.
 * @param tenant - The environment.
 * @param identifier - What the sign-in was started with: an address, or a phone number.
 * @returns The one active connection bound to the address's domain, or `null`.
 */
export async function offered(
  deps: Pick<
    Deps,
    'environmentSettings' | 'config' | 'ssoConnections' | 'organizationDomains' | 'clock'
  >,
  tenant: Pick<Tenant, 'environmentId'>,
  identifier: string
): Promise<SsoConnectionRecord | null> {
  const domain = identifier.includes('@') ? identifier.slice(identifier.lastIndexOf('@') + 1) : ''
  if (domain === '' || !(await Settings.current(deps, tenant)).sso.enabled) {
    return null
  }
  const connection = await deps.ssoConnections.findActiveByDomain(
    tenant.environmentId,
    domain.toLowerCase()
  )
  return connection && (await holdsDomain(deps, connection, domain)) ? connection : null
}

/**
 * Whether the connection's organization still holds `domain`: a verified, unlapsed row of its
 * own (ADR 0065). The connection's stored list is only a filter; ownership is read here, on
 * every use, because a lapse is a matter of time and no write marks it.
 */
async function holdsDomain(
  deps: Pick<Deps, 'organizationDomains' | 'clock'>,
  connection: SsoConnectionRecord,
  domain: string
): Promise<boolean> {
  const row = await deps.organizationDomains.findVerified(
    connection.environmentId,
    domain.toLowerCase()
  )
  return (
    row !== null &&
    row.organizationId === connection.organizationId &&
    !lapsed(row, deps.clock.now())
  )
}

/**
 * Whether a first factor other than `sso` is refused for an identifier: its domain is enforced
 * and the method is not one a break-glass member keeps.
 *
 * Decided by the domain. Only `password` ever reads the account (to spare a holder of the
 * connection's break-glass role), so that is the one answer that depends on who the address
 * belongs to; {@link requireNotEnforced} never asks it, and the password step folds it into
 * `auth.invalid_credentials` (account enumeration, ADR 0067).
 *
 * @param deps - Settings, connections, users and organizations.
 * @param tenant - The environment.
 * @param identifier - The address the sign-in is for (a phone number is on no domain).
 * @param method - The strategy being tried.
 * @returns `true` when the method is refused.
 */
export async function refuses(
  deps: Pick<
    Deps,
    | 'environmentSettings'
    | 'config'
    | 'ssoConnections'
    | 'users'
    | 'organizations'
    | 'organizationDomains'
    | 'clock'
  >,
  tenant: Pick<Tenant, 'environmentId'>,
  identifier: string,
  method: string
): Promise<boolean> {
  const connection = await offered(deps, tenant, identifier)
  if (!connection?.enforced) {
    return false
  }
  if (method !== 'password' || connection.breakGlassRole === null) {
    return true
  }
  const user = await deps.users.findByEmail(tenant.environmentId, identifier)
  const membership = user
    ? await deps.organizations.findMembership(
        tenant.environmentId,
        connection.organizationId,
        user.id
      )
    : null
  return membership?.roleKey !== connection.breakGlassRole
}

/**
 * Refuse a first factor other than `sso` for an identifier on an enforced connection's domain,
 * with an answer that does not depend on who the address belongs to.
 *
 * Break-glass covers the password alone, which is why this holds for every method it guards:
 * the emailed code and link, the texted code, a passkey and a provider's profile. The password
 * step does not call this; it uses {@link refuses} and answers `auth.invalid_credentials`.
 * Called by each other first factor's own route (a client that skips the offer is refused too),
 * and by the completion of a provider or passkey sign-in once the account is known.
 *
 * @param deps - Settings, connections, users and organizations.
 * @param tenant - The environment.
 * @param identifier - The address the sign-in is for (a phone number is on no domain).
 * @param method - The strategy being tried, named in the refusal.
 * @throws AuthError `auth.method_disabled` when the domain is enforced.
 */
export async function requireNotEnforced(
  deps: Pick<
    Deps,
    | 'environmentSettings'
    | 'config'
    | 'ssoConnections'
    | 'users'
    | 'organizations'
    | 'organizationDomains'
    | 'clock'
  >,
  tenant: Pick<Tenant, 'environmentId'>,
  identifier: string,
  method: string
): Promise<void> {
  if (await refuses(deps, tenant, identifier, method)) {
    throw new AuthError('auth.method_disabled', { method })
  }
}

/**
 * The connection an SSO round is for, as long as it may still sign anybody in: single sign-on
 * on and the connection `active`. Asked at the start, the callback and the exchange.
 *
 * @param deps - Settings and the connection store.
 * @param tenant - The environment.
 * @param connectionId - The connection the attempt names.
 * @returns The connection.
 * @throws AuthError `auth.method_disabled` (`params.method: 'sso'`) otherwise.
 */
export async function requireActive(
  deps: Pick<Deps, 'environmentSettings' | 'config' | 'ssoConnections'>,
  tenant: Pick<Tenant, 'environmentId'>,
  connectionId: string
): Promise<SsoConnectionRecord> {
  const connection = (await Settings.current(deps, tenant)).sso.enabled
    ? await deps.ssoConnections.find(tenant.environmentId, connectionId)
    : null
  if (connection?.status !== 'active') {
    throw new AuthError('auth.method_disabled', { method: 'sso' })
  }
  return connection
}

/**
 * The path the provider returns the browser to: the connection is in it, as the state names the
 * attempt.
 *
 * @param deps - Config.
 * @param connectionId - The connection.
 * @returns The absolute callback URL.
 */
export function callbackUrl(deps: Pick<Deps, 'config'>, connectionId: string): string {
  return `${publicBase(deps.config)}/v1/sso/callback/${connectionId}`
}

/** Documents and key sets by URL, each with when it stops being reused. */
const cache = new Map<string, { value: Record<string, unknown>; until: number }>()

/**
 * Forget every cached discovery document and key set. For tests that change an issuer's answers.
 */
export function forgetCached(): void {
  cache.clear()
}

/** The most documents and key sets kept: an operator-typed issuer must not grow memory without end. */
export const CACHE_MAX_ENTRIES = 500

/** How many documents and key sets are held now. For tests. */
export function cachedCount(): number {
  return cache.size
}

/** Keep a document, first dropping what has expired and, past the cap, the oldest. */
function remember(url: string, value: Record<string, unknown>, now: number): void {
  for (const [key, kept] of cache) {
    if (kept.until <= now) {
      cache.delete(key)
    }
  }
  cache.delete(url)
  while (cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value as string)
  }
  cache.set(url, { value, until: now + CACHE_MS })
}

async function getJson(
  deps: FetchDeps & Pick<Deps, 'clock'>,
  url: string,
  fresh = false
): Promise<Record<string, unknown>> {
  const now = deps.clock.now().getTime()
  const kept = cache.get(url)
  if (!fresh && kept && kept.until > now) {
    return kept.value
  }
  const answer = await Outbound.request(deps.outbound, url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    maxResponseBytes: MAX_DOCUMENT_BYTES,
  })
  const parsed: unknown =
    answer.status === 200 ? JSON.parse(new TextDecoder().decode(answer.body)) : null
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw refused('discovery', 'document', 'discovery_failed')
  }
  const value = parsed as Record<string, unknown>
  remember(url, value, now)
  return value
}

interface Discovery {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
}

/** The issuer as configured, without a trailing slash: how both sides are compared. */
function issuerOf(connection: SsoConnectionRecord): string {
  return connection.issuer.replace(/\/$/, '')
}

/**
 * Read the provider's discovery document, through `Outbound.request` only, cached for
 * {@link CACHE_MS} per issuer. Every endpoint it names is still called through the outbound
 * guard, which judges the address again at each request.
 *
 * @throws AuthError `sso.provider_error` when it cannot be read, or names another issuer.
 */
async function discover(
  deps: FetchDeps & Pick<Deps, 'clock'>,
  connection: SsoConnectionRecord
): Promise<Discovery> {
  const issuer = issuerOf(connection)
  const document = await getJson(deps, `${issuer}/.well-known/openid-configuration`)
  const { authorization_endpoint: a, token_endpoint: t, jwks_uri: j, issuer: named } = document
  if (
    typeof a !== 'string' ||
    typeof t !== 'string' ||
    typeof j !== 'string' ||
    typeof named !== 'string' ||
    named.replace(/\/$/, '') !== issuer
  ) {
    throw refused('discovery', 'document', 'discovery_failed')
  }
  return { issuer: named, authorizationEndpoint: a, tokenEndpoint: t, jwksUri: j }
}

/**
 * The provider's keys as `jose` asks for them: the cached set, and on a key id it does not hold,
 * the set fetched again **once** (the provider rotated); still missing is a refused token.
 */
function keysOf(deps: FetchDeps & Pick<Deps, 'clock'>, jwksUri: string): JWTVerifyGetKey {
  return async (header, token) => {
    const set = async (fresh: boolean) =>
      createLocalJWKSet((await getJson(deps, jwksUri, fresh)) as unknown as JSONWebKeySet)
    try {
      return await (await set(false))(header, token)
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey)) {
        throw error
      }
      return (await set(true))(header, token)
    }
  }
}

/**
 * The provider's consent URL for a connection (authorization code with PKCE and a nonce).
 *
 * @param deps - Outbound, clock and config.
 * @param connection - The connection.
 * @param params - The state, nonce and PKCE verifier the attempt holds.
 * @returns The URL to send the browser to.
 * @throws AuthError `sso.provider_error` when discovery fails.
 */
export async function authorizationUrl(
  deps: FetchDeps & Pick<Deps, 'config' | 'clock'>,
  connection: SsoConnectionRecord,
  params: { state: string; nonce: string; codeVerifier: string }
): Promise<string> {
  const found = await asProviderError(discover(deps, connection), 'discovery')
  // The browser is sent here: https only, as for any address we call (`http` in the `local` tier).
  const url = URL.parse(found.authorizationEndpoint)
  if (!url) {
    throw refused('discovery', 'authorization_endpoint_invalid', 'discovery_failed')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && deps.outbound.tier === 'local')) {
    throw refused('discovery', 'authorization_endpoint_not_https', 'discovery_failed')
  }
  const challenge = new Bun.CryptoHasher('sha256').update(params.codeVerifier).digest('base64url')
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: connection.clientId,
    redirect_uri: callbackUrl(deps, connection.id),
    scope: 'openid email profile',
    state: params.state,
    nonce: params.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

/**
 * Exchange the provider's code for its word on who signed in: the token request (with the PKCE
 * verifier and the sealed client secret), then the ID token, verified for its signature
 * (`RS256`, a key of the provider's published set), issuer, audience (`aud` the client id,
 * `azp` too when present), expiry and the attempt's nonce.
 *
 * @param deps - Outbound, secret box, clock and config.
 * @param connection - The connection.
 * @param params - The code, and the verifier and nonce the attempt kept.
 * @param seen - A test sign-in's collector of the claims that arrived.
 * @returns The profile.
 * @throws AuthError `sso.provider_error` for every failure; the log says which step failed
 *   and how, by a fixed word, never with anything of the answer.
 */
export async function exchange(
  deps: FetchDeps & Pick<Deps, 'config' | 'clock' | 'secretBox'>,
  connection: SsoConnectionRecord,
  params: { code: string; codeVerifier: string; nonce: string },
  seen?: Seen
): Promise<SsoProfile> {
  const found = await asProviderError(discover(deps, connection), 'discovery')
  const secret = new TextDecoder().decode(
    await asProviderError(
      deps.secretBox.open(
        SECRET_PURPOSE,
        connection.clientSecretSealed,
        secretAad(connection.environmentId, connection.id)
      ),
      'secret'
    )
  )
  const answer = await asProviderError(
    Outbound.request(deps.outbound, found.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: callbackUrl(deps, connection.id),
        client_id: connection.clientId,
        client_secret: secret,
        code_verifier: params.codeVerifier,
      }).toString(),
      maxResponseBytes: MAX_DOCUMENT_BYTES,
    }),
    'token'
  )
  const tokens: unknown = await asProviderError(
    Promise.resolve().then(() =>
      answer.status === 200 ? JSON.parse(new TextDecoder().decode(answer.body)) : null
    ),
    'token'
  )
  const idToken = (tokens as { id_token?: unknown } | null)?.id_token
  if (typeof idToken !== 'string') {
    throw refused('token', 'no_id_token', 'no_id_token')
  }
  const { payload } = await asProviderError(
    jwtVerify(idToken, keysOf(deps, found.jwksUri), {
      issuer: found.issuer,
      audience: connection.clientId,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['sub', 'exp', 'iat'],
      currentDate: deps.clock.now(),
    }),
    'id_token'
  )
  if (typeof payload.nonce !== 'string' || !timingSafeEqual(payload.nonce, params.nonce)) {
    throw refused('id_token', 'nonce', 'response_not_to_this_request')
  }
  if (payload.azp !== undefined && payload.azp !== connection.clientId) {
    throw refused('id_token', 'azp', 'wrong_audience')
  }
  if (seen) {
    seen.attributes = claimsOf(payload)
  }
  return profileOf(payload, connection)
}

/** The claims a test shows: strings, numbers, booleans and lists of them, not the token's own bookkeeping. */
function claimsOf(payload: JWTPayload): Record<string, string[]> {
  const own = new Set([
    'iss',
    'aud',
    'exp',
    'iat',
    'nbf',
    'jti',
    'nonce',
    'azp',
    'at_hash',
    'c_hash',
  ])
  const out: Record<string, string[]> = {}
  for (const [name, value] of Object.entries(payload)) {
    const values = (Array.isArray(value) ? value : [value]).filter(
      (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    )
    if (!own.has(name) && values.length > 0) {
      out[name] = values.map(String)
    }
  }
  return out
}

/**
 * The browser's redirect to a SAML identity provider (HTTP-Redirect binding): an unsigned
 * `AuthnRequest` whose `ID` the attempt holds, so only a response to *this* request is accepted.
 *
 * @param deps - Config and clock.
 * @param connection - A SAML connection.
 * @param params - The request's `ID` (an XML name) and the attempt's `state`, sent as `RelayState`.
 * @returns The identity provider's URL with `SAMLRequest` and `RelayState`.
 */
export function samlRedirectUrl(
  deps: Pick<Deps, 'config' | 'clock'>,
  connection: SsoConnectionRecord,
  params: { requestId: string; relayState: string }
): string {
  const saml = connection.saml
  if (!saml) {
    throw new AuthError('auth.method_disabled', { method: 'sso' })
  }
  const { spEntityId, acsUrl } = samlUrls(deps.config, connection)
  const e = escapeHtml
  const xml =
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${e(params.requestId)}" Version="2.0" IssueInstant="${deps.clock.now().toISOString()}" Destination="${e(saml.ssoUrl)}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="${e(acsUrl)}">` +
    `<saml:Issuer>${e(spEntityId)}</saml:Issuer><samlp:NameIDPolicy Format="${SAML_NAME_ID_FORMAT}" AllowCreate="true"/></samlp:AuthnRequest>`
  const url = new URL(saml.ssoUrl)
  url.searchParams.set('SAMLRequest', deflateRawSync(xml).toString('base64'))
  url.searchParams.set('RelayState', params.relayState)
  return url.toString()
}

/**
 * Check a SAML response with the one verifier (`lib/saml-verifier.ts`): every refusal becomes
 * the one generic `sso.provider_error`, and the fixed reason code is logged, never shown.
 *
 * Any of the connection's certificates may have signed it (rotation). The email comes from
 * the assertion's attributes, or from the `NameID` when that is an address; the connection's
 * domains vouch for it later, in {@link resolveAccount}.
 *
 * @param deps - Clock, replay guard and config.
 * @param connection - A SAML connection.
 * @param samlResponse - The `SAMLResponse` form field.
 * @param requestId - The `ID` of the attempt's `AuthnRequest`.
 * @param seen - A test sign-in's collector of the attributes that arrived.
 * @returns The profile.
 * @throws AuthError `sso.provider_error` when the response is refused for any reason.
 * @throws ServiceUnavailableError when the replay guard cannot answer.
 */
export async function verifySaml(
  deps: Pick<Deps, 'clock' | 'proofReplay' | 'config'>,
  connection: SsoConnectionRecord,
  samlResponse: string,
  requestId: string,
  seen?: Seen
): Promise<SsoProfile> {
  const saml = connection.saml
  if (!saml) {
    throw refused('saml', 'not_saml', 'malformed_response')
  }
  const { spEntityId, acsUrl } = samlUrls(deps.config, connection)
  // The verifier decodes the POST binding's base64 itself; decoding here too refused every real IdP.
  const verdict = await SamlVerifier.verify(deps, samlResponse, {
    spEntityId,
    acsUrl,
    requestId,
    idpEntityId: saml.idpEntityId,
    certificates: saml.certificates.map((c) => c.pem),
  })
  if (!verdict.ok) {
    throw refused('saml', verdict.reason, SAML_REASONS[verdict.reason])
  }
  const { subject, attributes } = verdict.assertion
  const names = effectiveAttributeNames(connection.protocol, connection.attributeMapping)
  if (seen) {
    seen.attributes = attributes
  }
  const first = (candidates: string[]) => {
    for (const name of candidates) {
      const value = attributes[name]?.[0]?.trim()
      if (value) {
        return value
      }
    }
    return undefined
  }
  const email = first(names.email) ?? (subject.includes('@') ? subject : undefined)
  const given = first(names.firstName)?.slice(0, 100)
  const family = first(names.lastName)?.slice(0, 100)
  const groups = groupValues(names.groups.flatMap((name) => attributes[name] ?? []))
  return {
    subject,
    email: email ?? null,
    emailVerified: true,
    ...(given !== undefined && { givenName: given }),
    ...(family !== undefined && { familyName: family }),
    ...(groups.length > 0 && { groups }),
  }
}

function profileOf(payload: JWTPayload, connection: SsoConnectionRecord): SsoProfile {
  const names = effectiveAttributeNames(connection.protocol, connection.attributeMapping)
  const claim = (candidates: string[]) => {
    for (const key of candidates) {
      if (payload[key] !== undefined) {
        return payload[key]
      }
    }
    return undefined
  }
  const name = (value: unknown) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 100) : undefined
  const givenName = name(claim(names.firstName))
  const familyName = name(claim(names.lastName))
  const email = claim(names.email)
  const raw = claim(names.groups)
  const groups = groupValues(typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [])
  return {
    subject: payload.sub as string,
    email: typeof email === 'string' ? email : null,
    // The boolean only: a string "true" is not the provider's word.
    emailVerified: payload.email_verified === true,
    ...(givenName !== undefined && { givenName }),
    ...(familyName !== undefined && { familyName }),
    ...(groups.length > 0 && { groups }),
  }
}

/** The usable group values: non-empty strings, trimmed, bounded in number and length. */
function groupValues(values: unknown[]): string[] {
  return values
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().slice(0, MAX_GROUP_LENGTH))
    .filter((v) => v !== '')
    .slice(0, MAX_PROFILE_GROUPS)
}

/**
 * A refusal of the provider's answer. It reaches a sign-in as `sso.provider_error` and nothing
 * more; only the test sign-in (TULA-145) reads `reason`, to tell the person setting the
 * connection up what is wrong.
 */
export class SsoRefusal extends AuthError {
  /** @param reason - The contract's code for what went wrong. */
  constructor(readonly reason: SsoTestReason) {
    super('sso.provider_error')
    this.name = 'SsoRefusal'
  }
}

/** What each of the SAML verifier's refusals is called to the person setting a connection up. */
const SAML_REASONS: Record<SamlVerifier.SamlRefusal, SsoTestReason> = {
  malformed: 'malformed_response',
  forbidden_xml: 'malformed_response',
  unsolicited: 'response_not_to_this_request',
  status_not_success: 'idp_refused',
  encrypted_assertion_unsupported: 'encrypted_assertion',
  no_assertion: 'malformed_response',
  multiple_assertions: 'malformed_response',
  assertion_misplaced: 'malformed_response',
  unsigned: 'unsigned_assertion',
  assertion_unsigned: 'unsigned_assertion',
  signature_invalid: 'signature_invalid',
  signature_algorithm_refused: 'signature_algorithm',
  certificate_not_configured: 'certificate_not_trusted',
  issuer_mismatch: 'wrong_issuer',
  destination_mismatch: 'wrong_recipient',
  in_response_to_missing: 'response_not_to_this_request',
  in_response_to_mismatch: 'response_not_to_this_request',
  subject_confirmation_invalid: 'wrong_recipient',
  recipient_mismatch: 'wrong_recipient',
  audience_mismatch: 'wrong_audience',
  conditions_missing: 'malformed_response',
  not_yet_valid: 'clock_skew',
  expired: 'assertion_expired',
  name_id_invalid: 'malformed_response',
  attribute_invalid: 'malformed_response',
  replayed: 'replayed',
}

function refused(step: string, failure: string, reason: SsoTestReason): SsoRefusal {
  // The step and a fixed word only: an answer can hold a token or an address.
  logger.warn('an SSO provider call failed', { step, failure })
  return new SsoRefusal(reason)
}

function reasonOf(step: string, error: unknown): SsoTestReason {
  if (error instanceof errors.JWTExpired) {
    return 'assertion_expired'
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    const claim = error.claim
    return claim === 'aud'
      ? 'wrong_audience'
      : claim === 'iss'
        ? 'wrong_issuer'
        : claim === 'nbf' || claim === 'iat'
          ? 'clock_skew'
          : 'id_token_invalid'
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return 'signature_invalid'
  }
  if (error instanceof errors.JWKSNoMatchingKey) {
    return 'certificate_not_trusted'
  }
  return step === 'discovery'
    ? 'discovery_failed'
    : step === 'id_token'
      ? 'id_token_invalid'
      : 'token_exchange_failed'
}

async function asProviderError<T>(work: Promise<T>, step: string): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (error instanceof AuthError) {
      throw error
    }
    throw refused(
      step,
      error instanceof Outbound.OutboundError
        ? error.reason
        : error instanceof errors.JOSEError
          ? error.code
          : 'unexpected',
      reasonOf(step, error)
    )
  }
}

type AccountDeps = Pick<
  Deps,
  | 'users'
  | 'ssoConnections'
  | 'organizationDomains'
  | 'organizations'
  | 'ids'
  | 'clock'
  | 'environmentSettings'
  | 'config'
  | 'rateLimiter'
  | 'hooks'
  | 'outbound'
  | 'secretBox'
>

/**
 * Decide which account an SSO identity signs in to (ADR 0067), row by row:
 *
 * 1. **The identity (connection + subject) is a user's** → that user, whatever address the
 *    provider reports now.
 * 2. **The address is not on one of the connection's domains** (or there is none) →
 *    `sso.email_domain_mismatch`, whatever `email_verified` says: the provider is trusted for
 *    its organization's verified domains and nothing else. On them, the domain vouches for the
 *    address, so `email_verified` is not required.
 * 3. **A user has that address and it is verified** → the identity is linked to them
 *    (`user.sso_linked`, `method: 'email'`).
 * 4. **A user has that address, unverified** → `sso.user_not_provisioned`: the account may
 *    have been made by someone who does not own the inbox, and it is not linked into.
 * 5. **No user has it** → created just in time: the address verified, no password, marked as
 *    managed by the connection, after the `before_sign_up` hook (`method: 'sso'`).
 *
 * After rows 1, 3 and 5 the user is a member of the connection's organization, with the
 * connection's default role when the membership is new, through the organization service.
 * A link or a creation that loses a race is looked at again, once.
 *
 * @param deps - Users, connections, organizations and what the hook needs.
 * @param tenant - The environment.
 * @param connection - The connection that vouched.
 * @param profile - What it vouched for.
 * @param origin - The request, for the audit entries and the hook.
 * @param client - The client kind the attempt was started as, for the hook.
 * @returns The user and whether it was just created.
 * @throws AuthError `sso.email_domain_mismatch`, `sso.user_not_provisioned`,
 *   `auth.user_banned`, `flow.invalid_step` after two lost races, the hook's codes, and the
 *   organization service's when the membership cannot be made.
 */
export async function resolveAccount(
  deps: AccountDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  connection: SsoConnectionRecord,
  profile: SsoProfile,
  origin: Partial<Origin>,
  client: SessionClient
): Promise<{ user: UserRecord; created: boolean }> {
  const { environmentId } = tenant
  let clearance: Hooks.SignUpClearance | undefined
  for (let round = 0; round < 2; round += 1) {
    const known = await deps.ssoConnections.findIdentity(
      environmentId,
      connection.id,
      profile.subject
    )
    const knownUser = known && (await deps.users.findById(environmentId, known.userId))
    if (knownUser) {
      await ensureMember(deps, tenant, connection, knownUser.id, profile, origin)
      return { user: knownUser, created: false }
    }
    const parsed = profile.email === null ? null : parseEmail(profile.email)
    const domain = parsed?.normalized.slice(parsed.normalized.lastIndexOf('@') + 1)
    if (
      !parsed ||
      domain === undefined ||
      !connection.domains.includes(domain) ||
      !(await holdsDomain(deps, connection, domain))
    ) {
      throw new AuthError('sso.email_domain_mismatch')
    }
    const now = deps.clock.now()
    const owner = await deps.users.findByEmail(environmentId, parsed.normalized)
    let user: UserRecord | null = owner
    let created = false
    if (owner) {
      if (owner.emailVerifiedAt === null) {
        throw new AuthError('sso.user_not_provisioned')
      }
      if (owner.bannedAt !== null) {
        throw new AuthError('auth.user_banned')
      }
    } else {
      clearance ??= await Hooks.beforeSignUp(deps, tenant, {
        email: parsed.normalized,
        method: 'sso',
        client,
        ipAddress: cleanOrigin(origin).ipAddress,
      })
      user = await provision(deps, tenant, connection, profile, parsed, origin, clearance)
      created = true
    }
    if (
      user &&
      (await deps.ssoConnections.linkIdentity(
        environmentId,
        { connectionId: connection.id, userId: user.id, subject: profile.subject },
        now,
        Audit.entry(deps, tenant, {
          type: 'user.sso_linked',
          actor: { type: 'user', id: user.id, ...cleanOrigin(origin) },
          target: { type: 'user', id: user.id },
          data: { connectionId: connection.id, method: created ? 'provisioned' : 'email' },
        })
      ))
    ) {
      await ensureMember(deps, tenant, connection, user.id, profile, origin)
      return { user, created }
    }
    // Another callback for the same identity, or the same address, got there first: row 1
    // or 3 finds what it made.
  }
  throw new AuthError('flow.invalid_step')
}

async function provision(
  deps: AccountDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  connection: SsoConnectionRecord,
  profile: SsoProfile,
  address: { email: string; normalized: string },
  origin: Partial<Origin>,
  clearance: Hooks.SignUpClearance
): Promise<UserRecord | null> {
  const now = deps.clock.now()
  const userId = deps.ids.next()
  const created = await deps.users.create(
    {
      id: userId,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: address.email,
      emailNormalized: address.normalized,
      // The connection's verified domain vouches for the address.
      emailVerifiedAt: now,
      firstName: profile.givenName ?? null,
      lastName: profile.familyName ?? null,
      createdAt: now,
      managedByConnectionId: connection.id,
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: null,
    },
    Audit.entry(deps, tenant, {
      type: 'user.created',
      actor: { type: 'user', id: userId, ...cleanOrigin(origin) },
      target: { type: 'user', id: userId },
      data: {
        method: 'sso',
        emailVerified: true,
        passwordless: true,
        ...(clearance === 'bypassed' && { hookBypassed: true }),
      },
    })
  )
  return created ? deps.users.findById(tenant.environmentId, userId) : null
}

/**
 * The role the organization's group mapping gives a user: the first mapping, in the order the
 * operator saved them, whose group is among the user's groups (the precedence rule of
 * ADR 0067). `null` when the organization maps no group at all; the connection's default role
 * for a user in none of the mapped groups.
 */
export function roleForGroups(
  mappings: { group: string; role: string }[],
  groups: string[] | undefined,
  defaultRole: string
): string | null {
  if (mappings.length === 0) {
    return null
  }
  const held = new Set(groups ?? [])
  return mappings.find((one) => held.has(one.group))?.role ?? defaultRole
}

/**
 * Make the user a member of the connection's organization, and, where the organization maps
 * groups to roles, set the role from the groups they signed in with (ADR 0067). Without a
 * mapping a member keeps the role they have.
 *
 * A role change goes through the organization service, so the last manager of an organization
 * is never demoted: that change is refused, the sign-in goes on with the old role, and the
 * reason (a fixed code, no group) is logged.
 */
async function ensureMember(
  deps: AccountDeps,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  connection: SsoConnectionRecord,
  userId: string,
  profile: SsoProfile,
  origin: Partial<Origin>
): Promise<void> {
  const mapped = roleForGroups(
    await deps.ssoConnections.listGroupRoles(tenant.environmentId, connection.organizationId),
    profile.groups,
    connection.defaultRole
  )
  const actor = { type: 'user' as const, id: userId, ...cleanOrigin(origin) }
  try {
    await Organizations.addMember(
      deps,
      tenant,
      connection.organizationId,
      { userId, role: mapped ?? connection.defaultRole },
      actor
    )
    return
  } catch (error) {
    if (!(error instanceof AuthError && error.code === 'organization.member_exists')) {
      throw error
    }
  }
  if (mapped === null) {
    return
  }
  try {
    await Organizations.changeMemberRole(
      deps,
      tenant,
      connection.organizationId,
      userId,
      { role: mapped },
      actor
    )
  } catch (error) {
    if (!(error instanceof AuthError || error instanceof ConflictError)) {
      throw error
    }
    logger.warn('an SSO sign-in kept the member role', {
      environmentId: tenant.environmentId,
      connectionId: connection.id,
      reason: error instanceof AuthError ? error.code : 'conflict',
    })
  }
}
