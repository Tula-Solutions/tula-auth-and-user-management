import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { VirtualAuthenticator } from '@tula-tech/conformance'
import {
  type AccessTokenClaims,
  DEFAULT_ENVIRONMENT_SETTINGS,
  SSO_CONNECTION_CLAIM,
  SSO_TEST_REASONS,
} from '@tula-tech/contract'
import { decodeJwt, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import { base32Decode, totp } from '~/lib/totp'
import * as Audit from '~/modules/audit/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Organizations from '~/modules/organization/service'
import * as Passkeys from '~/modules/passkey/service'
import * as Sms from '~/modules/sms/service'
import * as Sso from '~/modules/sso/service'
import * as SsoConnections from '~/modules/sso-connection/service'
import * as SsoTests from '~/modules/sso-test/service'
import {
  createTestDeps,
  seedApiKey,
  TEST_ACTOR,
  TEST_CONFIG,
  TEST_TENANT,
  type TestDeps,
} from '~/testing'
import { passTest } from '~/testing/sso-tested'

// The OIDC round of an SSO connection (ADR 0067), through the routes, against an identity
// provider this file runs on loopback (the outbound guard allows loopback `http` in the
// `local` tier): its discovery document, key set and token endpoint are real HTTP, and its
// ID tokens are signed here, so that each check of the token is held by a test.

const PK = 'tula_pk_dev_sso0000000000000000000000000000'
const TENANT = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: '',
}
const REDIRECT = 'http://localhost:5174/oauth/callback'
const DOMAIN = 'acme.test'
const CLIENT_ID = 'tula-client'

interface Grant {
  nonce: string
  challenge: string
}

/** The identity provider: what it answers, and what it was asked. */
const idp = {
  base: '',
  /** The issuer its discovery document names; the base address when `null`. */
  namedIssuer: null as string | null,
  /** The authorization endpoint its discovery document names; its own `/authorize` when `null`. */
  authorizationEndpoint: null as string | null,
  keys: [] as { privateKey: CryptoKey; jwk: JWK }[],
  /** Index of the key that signs. */
  signer: 0,
  /** Keys published in the key set, by index. */
  published: [0],
  jwksFetches: 0,
  grants: new Map<string, Grant>(),
  /** Claims the next token gets on top of the usual ones (`undefined` removes one). */
  claims: {} as Record<string, unknown>,
  /** The verifier the token endpoint last received. */
  lastVerifier: '' as string,
}

let server: ReturnType<typeof Bun.serve>
let deps: TestDeps
let app: ReturnType<typeof createApp>
let organizationId: string
let connectionId: string

async function key() {
  const pair = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: `k${idp.keys.length}`, alg: 'RS256' }
  idp.keys.push({ privateKey: pair.privateKey, jwk })
}

beforeAll(async () => {
  await key()
  await key()
  await key()
  await key()
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer: idp.namedIssuer ?? idp.base,
          authorization_endpoint: idp.authorizationEndpoint ?? `${idp.base}/authorize`,
          token_endpoint: `${idp.base}/token`,
          jwks_uri: `${idp.base}/jwks`,
        })
      }
      if (pathname === '/jwks') {
        idp.jwksFetches += 1
        return Response.json({ keys: idp.published.map((index) => idp.keys[index]?.jwk) })
      }
      if (pathname === '/token') {
        const form = new URLSearchParams(await request.text())
        const grant = idp.grants.get(form.get('code') ?? '')
        idp.lastVerifier = form.get('code_verifier') ?? ''
        const challenge = new Bun.CryptoHasher('sha256')
          .update(idp.lastVerifier)
          .digest('base64url')
        if (!grant || grant.challenge !== challenge || form.get('client_secret') !== 'shh') {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        const signing = idp.keys[idp.signer] as { privateKey: CryptoKey; jwk: JWK }
        const now = Math.floor(deps.clock.now().getTime() / 1000)
        const payload: Record<string, unknown> = {
          iss: idp.base,
          aud: CLIENT_ID,
          sub: 'subject-1',
          email: `ada@${DOMAIN}`,
          email_verified: true,
          nonce: grant.nonce,
          iat: now,
          exp: now + 300,
          ...idp.claims,
        }
        for (const [name, value] of Object.entries(payload)) {
          if (value === undefined) {
            delete payload[name]
          }
        }
        const token = await new SignJWT(payload)
          .setProtectedHeader({ alg: 'RS256', kid: signing.jwk.kid as string })
          .sign(signing.privateKey)
        return Response.json({ id_token: token, token_type: 'Bearer' })
      }
      return new Response(null, { status: 404 })
    },
  })
  idp.base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

/** Verify a domain for the organization straight in the store (its mail round is not the subject). */
async function verify(domain: string) {
  const id = Bun.randomUUIDv7()
  const none = Audit.none('fixture')
  const now = deps.clock.now()
  await deps.organizationDomains.claim(
    {
      id,
      ...TENANT,
      organizationId,
      domain,
      mode: 'suggest',
      codeHash: 'h',
      codeExpiresAt: new Date(now.getTime() + 60_000),
      at: now,
      limit: 10,
    },
    none
  )
  await deps.organizationDomains.verify(
    TENANT.environmentId,
    organizationId,
    id,
    'h',
    now,
    new Date(now.getTime() + 86_400_000),
    none
  )
}

beforeEach(async () => {
  Sso.forgetCached()
  Object.assign(idp, {
    namedIssuer: null,
    authorizationEndpoint: null,
    signer: 0,
    published: [0],
    jwksFetches: 0,
    claims: {},
    lastVerifier: '',
  })
  idp.grants.clear()
  deps = createTestDeps({ config: { ...TEST_CONFIG, oauthMock: true } })
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
      sso: { enabled: true },
    } as never,
  })
  await seedApiKey(deps, PK)
  app = createApp(deps)
  organizationId = (
    await Organizations.create(deps, TENANT, { name: 'Acme', slug: 'acme' }, TEST_ACTOR)
  ).id
  await verify(DOMAIN)
  const made = await SsoConnections.create(
    deps,
    TENANT,
    {
      organizationId,
      protocol: 'oidc',
      name: 'Okta',
      issuer: idp.base,
      clientId: CLIENT_ID,
      clientSecret: 'shh',
      defaultRole: 'member',
      domains: [DOMAIN],
    },
    TEST_ACTOR
  )
  connectionId = made.id
  await setStatus('active')
})

async function setStatus(status: 'draft' | 'active' | 'disabled') {
  if (status === 'active') {
    await passTest(deps, TENANT, connectionId, TEST_ACTOR)
  }
  await SsoConnections.update(deps, TENANT, connectionId, { status }, TEST_ACTOR)
}

const HEADERS = { 'content-type': 'application/json', 'x-tula-publishable-key': PK }

/** The `x-tula-client` of the requests; a test changes it to be a second device. */
let clientKind = 'ios'

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { ...HEADERS, 'x-tula-client': clientKind, ...headers },
    body: JSON.stringify(body),
  })
}

/** Start a sign-in for an address and continue it with single sign-on. */
async function started(email = `ada@${DOMAIN}`) {
  const signIn = await post('/v1/client/sign-ins', { identifier: email })
  const attempt = (await signIn.json()) as { id: string; attemptSecret: string; step: unknown }
  const sso = await post(
    `/v1/client/sign-ins/${attempt.id}/sso`,
    { redirectUrl: REDIRECT },
    { 'x-tula-attempt': attempt.attemptSecret }
  )
  return { attempt, sso }
}

/** The identity provider signs the user in: the code it hands the browser for this URL. */
function consent(authorizationUrl: string) {
  const url = new URL(authorizationUrl)
  const code = `code-${idp.grants.size}`
  idp.grants.set(code, {
    nonce: url.searchParams.get('nonce') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? '',
  })
  return { code, state: url.searchParams.get('state') ?? '' }
}

/** What the callback sends the app's page: the ticket and attempt, or the error code. */
async function callback(query: Record<string, string>) {
  const response = await app.request(
    `/v1/sso/callback/${connectionId}?${new URLSearchParams(query)}`
  )
  const location = response.headers.get('location') ?? ''
  return {
    status: response.status,
    location,
    fragment: new URLSearchParams(location.split('#')[1] ?? ''),
  }
}

/** The whole round: start, the provider, the callback and the exchange. */
async function signIn(email = `ada@${DOMAIN}`) {
  const { sso } = await started(email)
  const begun = (await sso.json()) as { authorizationUrl: string; binding: string }
  const back = await callback(consent(begun.authorizationUrl))
  const error = back.fragment.get('tula_error')
  if (error) {
    return { error, response: null }
  }
  const response = await post('/v1/client/sign-ins/oauth/exchange', {
    ticket: back.fragment.get('tula_ticket'),
    attemptId: back.fragment.get('tula_attempt'),
    binding: begun.binding,
  })
  return { error: null, response }
}

async function signedIn(email?: string) {
  const { error, response } = await signIn(email)
  expect(error).toBeNull()
  expect(response?.status).toBe(200)
  return (await response?.json()) as {
    step: { status: string; userId: string; sessionId: string }
    session: { accessToken: string }
  }
}

async function codeOf(email?: string) {
  const { error, response } = await signIn(email)
  return error ?? ((await response?.json()) as { code: string } | undefined)?.code
}

async function seedUser(email: string, verified: boolean, password: string | null = null) {
  const id = deps.ids.next()
  await deps.users.create(
    {
      id,
      ...TENANT,
      email,
      emailNormalized: email,
      emailVerifiedAt: verified ? deps.clock.now() : null,
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: password ? await Bun.password.hash(password, { algorithm: 'argon2id' }) : null,
    },
    Audit.none('fixture')
  )
  return id
}

const recorded = () => deps.activityLog.entries.map((entry) => entry.type)

describe('home-realm discovery', () => {
  test('is by domain: a known and an unknown address on the domain get the same step', async () => {
    await seedUser(`ada@${DOMAIN}`, true)
    const known = await started(`ada@${DOMAIN}`)
    const unknown = await started(`nobody@${DOMAIN}`)
    expect(known.attempt.step).toEqual(unknown.attempt.step)
    expect(JSON.stringify(known.attempt.step)).toContain('"sso"')
    expect(known.sso.status).toBe(200)
    expect(unknown.sso.status).toBe(200)
  })

  test('a draft, a disabled connection, another domain and SSO off are not offered', async () => {
    const refused = async () => ((await (await started()).sso.json()) as { code: string }).code
    await setStatus('disabled')
    expect(await refused()).toBe('flow.invalid_step')
    expect(((await (await started('ada@other.test')).sso.json()) as { code: string }).code).toBe(
      'flow.invalid_step'
    )
    await setStatus('active')
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 2,
      settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, sso: { enabled: false } } as never,
    })
    expect(await refused()).toBe('flow.invalid_step')
  })

  test('the start sends the browser to the provider with PKCE, state and a nonce', async () => {
    const { sso } = await started()
    const url = new URL(((await sso.json()) as { authorizationUrl: string }).authorizationUrl)
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.base}/authorize`)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('nonce')).toBeTruthy()
    expect(url.searchParams.get('state')).toContain(TEST_TENANT.environmentId)
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${TEST_CONFIG.publicUrl}/v1/sso/callback/${connectionId}`
    )
  })
})

describe('a sign-in through the connection', () => {
  test('creates the user just in time, managed by the connection and a member, with sso in amr and the connection claim', async () => {
    const result = await signedIn()
    expect(result.step.status).toBe('complete')
    const claims = decodeJwt<AccessTokenClaims>(result.session.accessToken)
    expect(claims.amr).toEqual(['sso'])
    expect(claims[SSO_CONNECTION_CLAIM]).toBe(connectionId)
    const user = await deps.users.findById(TENANT.environmentId, result.step.userId)
    expect(user?.managedByConnectionId).toBe(connectionId)
    expect(user?.emailVerifiedAt).not.toBeNull()
    const membership = await deps.organizations.findMembership(
      TENANT.environmentId,
      organizationId,
      result.step.userId
    )
    expect(membership?.roleKey).toBe('member')
    expect(recorded()).toEqual(
      expect.arrayContaining(['user.created', 'user.sso_linked', 'organization_membership.added'])
    )
    // The verifier went to the token endpoint and matched the challenge (it was checked there).
    expect(idp.lastVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('announces the new device and is in the session list', async () => {
    // The account's first sign-in is never announced: the second, from another kind of device, is.
    await signedIn()
    clientKind = 'android'
    const result = await signedIn().finally(() => {
      clientKind = 'ios'
    })
    await Notices.settled()
    expect(deps.mailer.outbox.some((mail) => mail.to === `ada@${DOMAIN}`)).toBe(true)
    const list = await app.request('/v1/client/sessions', {
      headers: { ...HEADERS, authorization: `Bearer ${result.session.accessToken}` },
    })
    expect(JSON.stringify(await list.json())).toContain(result.step.sessionId)
  })

  test('a ticket without the starting browser’s binding completes nothing', async () => {
    const { sso } = await started()
    const begun = (await sso.json()) as { authorizationUrl: string }
    const back = await callback(consent(begun.authorizationUrl))
    const response = await post('/v1/client/sign-ins/oauth/exchange', {
      ticket: back.fragment.get('tula_ticket'),
      attemptId: back.fragment.get('tula_attempt'),
      binding: 'tula_ob_not-the-binding',
    })
    expect(((await response.json()) as { code: string }).code).toBe('oauth.different_browser')
    expect(await deps.users.findByEmail(TENANT.environmentId, `ada@${DOMAIN}`)).toBeNull()
  })

  test('the state works once', async () => {
    const { sso } = await started()
    const query = consent(((await sso.json()) as { authorizationUrl: string }).authorizationUrl)
    expect((await callback(query)).fragment.get('tula_ticket')).toBeTruthy()
    expect((await callback(query)).fragment.get('tula_error')).toBe('oauth.state_invalid')
  })

  test('a state for another connection, or of no attempt, gets the static page', async () => {
    const { sso } = await started()
    const query = consent(((await sso.json()) as { authorizationUrl: string }).authorizationUrl)
    const other = await app.request(
      `/v1/sso/callback/${Bun.randomUUIDv7()}?${new URLSearchParams(query)}`
    )
    expect(other.status).toBe(400)
    expect((await callback({ state: 'nope', code: 'x' })).status).toBe(400)
  })

  test('a connection disabled while the user is at the provider signs nobody in', async () => {
    const { sso } = await started()
    const query = consent(((await sso.json()) as { authorizationUrl: string }).authorizationUrl)
    await setStatus('disabled')
    expect((await callback(query)).fragment.get('tula_error')).toBe('auth.method_disabled')
  })
})

describe('the matching table', () => {
  test('1. a known identity is its user, whatever address the provider reports now', async () => {
    const first = await signedIn()
    idp.claims = { email: `ada.lovelace@${DOMAIN}` }
    const again = await signedIn(`ada@${DOMAIN}`)
    expect(again.step.userId).toBe(first.step.userId)
  })

  test('2. an address outside the connection’s domains is refused, verified or not', async () => {
    idp.claims = { email: 'ada@elsewhere.test' }
    expect(await codeOf()).toBe('sso.email_domain_mismatch')
    idp.claims = { email: 'ada@elsewhere.test', email_verified: false }
    expect(await codeOf()).toBe('sso.email_domain_mismatch')
    idp.claims = { email: undefined }
    expect(await codeOf()).toBe('sso.email_domain_mismatch')
    expect(recorded()).not.toContain('user.created')
  })

  test('2. on the domain, the domain vouches: email_verified false still signs in', async () => {
    idp.claims = { email_verified: false }
    expect((await signedIn()).step.status).toBe('complete')
  })

  test('3. a verified account with the address is linked, not duplicated', async () => {
    const existing = await seedUser(`ada@${DOMAIN}`, true)
    const result = await signedIn()
    expect(result.step.userId).toBe(existing)
    expect(recorded()).toContain('user.sso_linked')
    expect(recorded()).not.toContain('user.created')
    expect(
      await deps.ssoConnections.findIdentity(TENANT.environmentId, connectionId, 'subject-1')
    ).toMatchObject({ userId: existing })
  })

  test('4. an unverified account with the address is not linked into', async () => {
    await seedUser(`ada@${DOMAIN}`, false)
    expect(await codeOf()).toBe('sso.user_not_provisioned')
    expect(
      await deps.ssoConnections.findIdentity(TENANT.environmentId, connectionId, 'subject-1')
    ).toBeNull()
  })

  test('5. no account: one is created just in time', async () => {
    const result = await signedIn()
    expect(recorded()).toContain('user.created')
    expect(result.step.userId).toBeTruthy()
  })
})

describe('the ID token', () => {
  test.each([
    ['a wrong issuer', { iss: 'https://evil.test' }],
    ['a wrong audience', { aud: 'someone-else' }],
    ['an azp that is not the client', { azp: 'someone-else' }],
    ['a nonce that is not the attempt’s', { nonce: 'not-the-nonce' }],
    ['no nonce', { nonce: undefined }],
    ['an expired token', { exp: 1 }],
  ])('%s is refused, and nobody is created', async (_name, claims) => {
    idp.claims = claims
    expect(await codeOf()).toBe('sso.provider_error')
    expect(await deps.users.findByEmail(TENANT.environmentId, `ada@${DOMAIN}`)).toBeNull()
  })

  test('a discovery document naming another issuer is refused at the start', async () => {
    idp.namedIssuer = 'https://evil.test'
    expect(((await (await started()).sso.json()) as { code: string }).code).toBe(
      'sso.provider_error'
    )
  })

  test('a token the provider will not give for a wrong PKCE verifier signs nobody in', async () => {
    const { sso } = await started()
    const url = new URL(((await sso.json()) as { authorizationUrl: string }).authorizationUrl)
    idp.grants.set('bad', { nonce: url.searchParams.get('nonce') ?? '', challenge: 'other' })
    const back = await callback({ code: 'bad', state: url.searchParams.get('state') ?? '' })
    expect(back.fragment.get('tula_error')).toBe('sso.provider_error')
  })

  test('an unknown kid makes the key set be fetched again once, and a rotated key is taken', async () => {
    await signedIn()
    expect(idp.jwksFetches).toBe(1)
    idp.published = [0, 1]
    idp.signer = 1
    await signedIn()
    expect(idp.jwksFetches).toBe(2)
    // A key the fresh set does not have either: refused, with one more fetch and no more.
    idp.signer = 2
    expect(await codeOf()).toBe('sso.provider_error')
    expect(idp.jwksFetches).toBe(3)
  })

  test('the documents come from cache: one discovery and one key set for two sign-ins', async () => {
    await signedIn()
    await signedIn()
    expect(idp.jwksFetches).toBe(1)
  })
})

describe('the outbound guard', () => {
  test('an issuer whose name now resolves to a private address is not called', async () => {
    const stored = await deps.ssoConnections.find(TENANT.environmentId, connectionId)
    const issuer = `http://idp.internal.test:${server.port}`
    deps.outbound.point('idp.internal.test', '10.0.0.8')
    await deps.ssoConnections.update(
      TENANT.environmentId,
      connectionId,
      { issuer },
      deps.clock.now(),
      Audit.entry(deps, TENANT, {
        type: 'sso_connection.updated',
        actor: TEST_ACTOR,
        target: { type: 'sso_connection', id: connectionId },
        data: { protocol: 'oidc', changed: ['issuer'], status: stored?.status ?? 'active' },
      })
    )
    const before = idp.jwksFetches
    expect(((await (await started()).sso.json()) as { code: string }).code).toBe(
      'sso.provider_error'
    )
    expect(idp.jwksFetches).toBe(before)
    expect(deps.outbound.asked).toContain('idp.internal.test')
  })
})

describe('IdP groups mapped to organization roles', () => {
  const roleOf = async (userId: string) =>
    (await deps.organizations.findMembership(TENANT.environmentId, organizationId, userId))?.roleKey

  const mapGroups = (mappings: { group: string; role: string }[]) =>
    SsoConnections.putGroupRoles(deps, TENANT, connectionId, { mappings }, TEST_ACTOR)

  test('a user in two mapped groups gets the role of the first in the saved order', async () => {
    await mapGroups([
      { group: 'eng', role: 'member' },
      { group: 'ops', role: 'admin' },
    ])
    idp.claims = { groups: ['ops', 'eng'] }
    expect(await roleOf((await signedIn()).step.userId)).toBe('member')
    await mapGroups([
      { group: 'ops', role: 'admin' },
      { group: 'eng', role: 'member' },
    ])
    expect(await roleOf((await signedIn()).step.userId)).toBe('admin')
  })

  test('a user in no mapped group gets the connection default role', async () => {
    await mapGroups([{ group: 'ops', role: 'admin' }])
    idp.claims = { groups: ['sales'] }
    expect(await roleOf((await signedIn()).step.userId)).toBe('member')
  })

  test('a mapping to a role that does not exist, or a group named twice, is refused on save', async () => {
    await expect(mapGroups([{ group: 'ops', role: 'ghost' }])).rejects.toMatchObject({
      code: 'organization.role_unknown',
    })
    await expect(
      mapGroups([
        { group: 'ops', role: 'admin' },
        { group: 'ops', role: 'member' },
      ])
    ).rejects.toMatchObject({ code: 'request.malformed' })
  })

  test('the role follows the group across two sign-ins', async () => {
    await mapGroups([{ group: 'ops', role: 'admin' }])
    idp.claims = { sub: 'subject-bob', email: `bob@${DOMAIN}`, groups: ['ops'] }
    await signedIn(`bob@${DOMAIN}`)
    idp.claims = { groups: ['ops'] }
    const first = await signedIn()
    expect(await roleOf(first.step.userId)).toBe('admin')
    idp.claims = { groups: [] }
    expect(await roleOf((await signedIn()).step.userId)).toBe('member')
  })

  test('demoting the last manager is refused, the sign-in succeeds with the old role and the reason is logged', async () => {
    await mapGroups([{ group: 'ops', role: 'admin' }])
    idp.claims = { groups: ['ops'] }
    const first = await signedIn()
    expect(await roleOf(first.step.userId)).toBe('admin')
    const warn = spyOn(logger, 'warn')
    idp.claims = { groups: [] }
    const second = await signedIn()
    expect(second.step.status).toBe('complete')
    expect(await roleOf(first.step.userId)).toBe('admin')
    expect(warn).toHaveBeenCalledWith(
      'an SSO sign-in kept the member role',
      expect.objectContaining({ reason: 'organization.last_manager' })
    )
    warn.mockRestore()
  })

  test('no group name reaches an audit entry', async () => {
    await mapGroups([{ group: 'secret-group-name', role: 'admin' }])
    idp.claims = { groups: ['secret-group-name'] }
    await signedIn()
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain('secret-group-name')
  })
})

describe('the OIDC test round (TULA-145)', () => {
  /** Run a test round through the provider and the callback; the result the admin reads. */
  async function round(): Promise<Awaited<ReturnType<typeof SsoTests.result>>> {
    const begun = await SsoTests.start(deps, TENANT, connectionId, REDIRECT, TEST_ACTOR)
    const back = await callback(consent(begun.authorizationUrl))
    expect(back.location).toStartWith(`${REDIRECT}#tula_test=${begun.testId}`)
    return SsoTests.result(deps, TENANT, connectionId, begun.testId)
  }

  test('a pass shows the claims, marks the connection tested and creates no user, session or identity', async () => {
    idp.claims = { email: `ada@${DOMAIN}`, groups: ['admins'] }
    const before = recorded()
    const result = await round()
    expect(result).toMatchObject({
      status: 'passed',
      groups: ['admins'],
      mapped: { email: `ada@${DOMAIN}`, emailOnVerifiedDomain: true },
    })
    expect(JSON.stringify(result)).not.toContain('eyJ')
    expect((await SsoConnections.get(deps, TENANT, connectionId)).tested).toBe(true)
    expect(await deps.users.findByEmail(TENANT.environmentId, `ada@${DOMAIN}`)).toBeNull()
    expect(recorded().slice(before.length)).toEqual(['sso_connection.updated'])
  })

  test.each([
    [
      'a key the provider does not publish',
      () => {
        idp.signer = 2
      },
      'certificate_not_trusted',
    ],
    [
      'an address outside the domains',
      () => (idp.claims = { email: 'x@elsewhere.test' }),
      'email_outside_domains',
    ],
  ] as const)('%s fails with its reason', async (_name, setup, reason) => {
    setup()
    const result = await round()
    expect(result).toMatchObject({ status: 'failed', reason })
    expect(result.message).toBe(SSO_TEST_REASONS[reason])
    expect(await deps.users.findByEmail(TENANT.environmentId, `ada@${DOMAIN}`)).toBeNull()
  })

  test('a real sign-in with the same fault still says only sso.provider_error', async () => {
    idp.signer = 2
    expect(await codeOf()).toBe('sso.provider_error')
  })

  test('an authorization endpoint that is not https (http only in local) fails the test', async () => {
    idp.authorizationEndpoint = 'ftp://idp.example/authorize'
    const begun = await SsoTests.start(deps, TENANT, connectionId, REDIRECT, TEST_ACTOR)
    expect(await SsoTests.result(deps, TENANT, connectionId, begun.testId)).toMatchObject({
      status: 'failed',
      reason: 'discovery_failed',
    })
  })

  test('a discovery document naming another issuer fails the test at its start', async () => {
    idp.namedIssuer = 'https://evil.test'
    const begun = await SsoTests.start(deps, TENANT, connectionId, REDIRECT, TEST_ACTOR)
    expect(await SsoTests.result(deps, TENANT, connectionId, begun.testId)).toMatchObject({
      status: 'failed',
      reason: 'discovery_failed',
    })
  })
})

describe('enforcement (TULA-140)', () => {
  const PASSWORD = 'correct horse battery staple'
  const BREAK_GLASS = 'admin'

  beforeEach(() => {
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 2,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
        sso: { enabled: true },
        signIn: {
          methods: {
            password: { enabled: true },
            emailCode: { enabled: true },
            emailLink: { enabled: true },
            passkey: { enabled: false },
            smsCode: { enabled: false },
          },
        },
      },
    } as never)
  })

  async function stepOf(response: Response | null) {
    return ((await (response as Response).json()) as { step: { status: string } }).step.status
  }

  async function enforce(changes: {
    enforced?: boolean
    breakGlassRole?: string | null
    trustIdpMfa?: boolean
  }) {
    await SsoConnections.update(deps, TENANT, connectionId, changes, TEST_ACTOR)
  }

  async function attemptFor(email: string) {
    const res = await post('/v1/client/sign-ins', { identifier: email })
    return (await res.json()) as {
      id: string
      attemptSecret: string
      step: { strategies?: string[] }
    }
  }

  async function codeAt(email: string, path: string, body: unknown) {
    const attempt = await attemptFor(email)
    const res = await post(`/v1/client/sign-ins/${attempt.id}/${path}`, body, {
      'x-tula-attempt': attempt.attemptSecret,
    })
    return { status: res.status, body: (await res.json()) as { code?: string } }
  }

  test('offers sso only, and the same for a known and an unknown address', async () => {
    await seedUser(`ada@${DOMAIN}`, true)
    await enforce({ enforced: true })
    const known = await attemptFor(`ada@${DOMAIN}`)
    const unknown = await attemptFor(`nobody@${DOMAIN}`)
    expect(known.step).toEqual(unknown.step)
    expect(known.step.strategies).toEqual(['sso'])
  })

  test('an unenforced domain still offers the other methods', async () => {
    expect((await attemptFor(`ada@${DOMAIN}`)).step.strategies).toContain('password')
  })

  for (const [strategy, path, body] of [
    ['email_code', 'first-factor/prepare', { strategy: 'email_code' }],
    ['email_code', 'first-factor/attempt', { strategy: 'email_code', code: '123456' }],
    ['email_link', 'first-factor/prepare', { strategy: 'email_link', redirectUrl: REDIRECT }],
  ] as const) {
    test(`refuses ${strategy} at ${path} for an enforced domain, known or not`, async () => {
      await seedUser(`ada@${DOMAIN}`, true)
      await enforce({ enforced: true })
      const known = await codeAt(`ada@${DOMAIN}`, path, body)
      const unknown = await codeAt(`nobody@${DOMAIN}`, path, body)
      expect(known.body.code).toBe('auth.method_disabled')
      expect(unknown).toEqual(known)
    })
  }

  test('the password step answers alike for an unknown address, a non-member and a break-glass member with a wrong password', async () => {
    const member = await seedUser(`ada@${DOMAIN}`, true, PASSWORD)
    await seedUser(`bob@${DOMAIN}`, true, PASSWORD)
    await Organizations.addMember(
      deps,
      TENANT,
      organizationId,
      { userId: member, role: BREAK_GLASS },
      TEST_ACTOR
    )
    await enforce({ enforced: true, breakGlassRole: BREAK_GLASS })
    const answers = [
      await codeAt(`nobody@${DOMAIN}`, 'password', { password: PASSWORD }),
      // Right password, but not a member: the guard must not be visible.
      await codeAt(`bob@${DOMAIN}`, 'password', { password: PASSWORD }),
      await codeAt(`ada@${DOMAIN}`, 'password', { password: 'wrong wrong wrong wrong' }),
    ]
    for (const answer of answers) {
      expect(answer.status).toBe(401)
      expect(answer.body.code).toBe('auth.invalid_credentials')
    }
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
  })

  test('a break-glass member signs in with the right password; no one else does', async () => {
    const member = await seedUser(`ada@${DOMAIN}`, true, PASSWORD)
    await Organizations.addMember(
      deps,
      TENANT,
      organizationId,
      { userId: member, role: BREAK_GLASS },
      TEST_ACTOR
    )
    await enforce({ enforced: true, breakGlassRole: BREAK_GLASS })
    expect((await codeAt(`ada@${DOMAIN}`, 'password', { password: PASSWORD })).status).toBe(200)
  })

  test('break-glass covers the password only: the answer of every other step ignores who asks', async () => {
    const member = await seedUser(`ada@${DOMAIN}`, true, PASSWORD)
    await Organizations.addMember(
      deps,
      TENANT,
      organizationId,
      { userId: member, role: BREAK_GLASS },
      TEST_ACTOR
    )
    await enforce({ enforced: true, breakGlassRole: BREAK_GLASS })
    const body = { strategy: 'email_code' }
    const asMember = await codeAt(`ada@${DOMAIN}`, 'first-factor/prepare', body)
    const asStranger = await codeAt(`nobody@${DOMAIN}`, 'first-factor/prepare', body)
    expect(asMember.body.code).toBe('auth.method_disabled')
    expect(asStranger).toEqual(asMember)
  })

  test('trust off stops at the second step for a user with TOTP; trust on completes with mfa', async () => {
    const userId = await seedUser(`ada@${DOMAIN}`, true)
    const { secret } = await Mfa.startTotp(deps, TENANT, userId)
    await Mfa.confirmTotp(deps, TENANT, { userId }, totp(base32Decode(secret), deps.clock.now()), {
      type: 'user',
      id: userId,
      ipAddress: null,
      userAgent: null,
    })
    await Notices.settled()
    deps.clock.advance('30s')
    const off = await signIn()
    expect(await stepOf(off.response)).toBe('needs_second_factor')
    await enforce({ trustIdpMfa: true })
    const on = await signedIn()
    expect(on.step.status).toBe('complete')
    expect([...(decodeJwt<AccessTokenClaims>(on.session.accessToken).amr ?? [])].sort()).toEqual([
      'mfa',
      'sso',
    ])
  })

  test('under mfa.policy required, trust off asks for enrolment and trust on completes', async () => {
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 2,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
        sso: { enabled: true },
        mfa: { ...DEFAULT_ENVIRONMENT_SETTINGS.mfa, policy: 'required' },
      } as never,
    })
    const off = await signIn()
    expect(await stepOf(off.response)).toBe('needs_factor_enrolment')
    await enforce({ trustIdpMfa: true })
    expect((await signedIn(`grace@${DOMAIN}`)).step.status).toBe('complete')
  })
})

describe('enforcement of sign-up and recovery (decision 12)', () => {
  const PASSWORD = 'correct horse battery staple'
  const BREAK_GLASS = 'admin'

  beforeEach(() => {
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 2,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
        sso: { enabled: true },
      },
    } as never)
  })

  async function enforce() {
    await SsoConnections.update(
      deps,
      TENANT,
      connectionId,
      { enforced: true, breakGlassRole: BREAK_GLASS },
      TEST_ACTOR
    )
  }

  async function enforced() {
    const member = await seedUser(`ada@${DOMAIN}`, true, PASSWORD)
    await Organizations.addMember(
      deps,
      TENANT,
      organizationId,
      { userId: member, role: BREAK_GLASS },
      TEST_ACTOR
    )
    await seedUser(`bob@${DOMAIN}`, true, PASSWORD)
    await enforce()
  }

  const resetMails = (to: string) =>
    deps.mailer.outbox.filter((mail) => mail.to === to && /\b\d{6}\b/.test(mail.text))

  async function answer(res: Response) {
    return { status: res.status, body: await res.json() }
  }

  test('sign-up is refused for an unknown address, a member and a break-glass member alike', async () => {
    await enforced()
    const answers = []
    for (const email of [`new@${DOMAIN}`, `bob@${DOMAIN}`, `ada@${DOMAIN}`]) {
      answers.push(await answer(await post('/v1/client/sign-ups', { email, password: PASSWORD })))
    }
    expect(answers[0]?.status).toBe(403)
    expect((answers[0]?.body as { code: string }).code).toBe('auth.method_disabled')
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
    expect(deps.mailer.outbox).toHaveLength(0)
    expect(await deps.users.findByEmail(TENANT.environmentId, `new@${DOMAIN}`)).toBeNull()
  })

  test('a sign-up begun before enforcement cannot be verified after it', async () => {
    const res = await post('/v1/client/sign-ups', { email: `new@${DOMAIN}`, password: PASSWORD })
    const attempt = (await res.json()) as { id: string; attemptSecret: string }
    const code = /\b(\d{6})\b/.exec(deps.mailer.last().text)?.[1] ?? ''
    await enforce()
    const verified = await post(
      `/v1/client/sign-ups/${attempt.id}/verify-email`,
      { code },
      { 'x-tula-attempt': attempt.attemptSecret }
    )
    expect(((await verified.json()) as { code: string }).code).toBe('auth.method_disabled')
    expect(await deps.users.findByEmail(TENANT.environmentId, `new@${DOMAIN}`)).toBeNull()
  })

  test('a passwordless sign-up is refused too, and another domain still signs up', async () => {
    await enforced()
    const refused = await post('/v1/client/sign-ups', { email: `new@${DOMAIN}` })
    expect(((await refused.json()) as { code: string }).code).toBe('auth.method_disabled')
    const open = await post('/v1/client/sign-ups', {
      email: 'new@elsewhere.test',
      password: PASSWORD,
    })
    expect(open.status).toBe(200)
  })

  test('a password reset answers alike for any address and mails a code only to a break-glass member', async () => {
    await enforced()
    const answers = []
    for (const email of [`new@${DOMAIN}`, `bob@${DOMAIN}`, `ada@${DOMAIN}`]) {
      const res = await post('/v1/client/password-resets', { email })
      const body = (await res.json()) as { step: { status: string } }
      answers.push({ status: res.status, step: body.step.status })
    }
    expect(answers[0]?.status).toBe(200)
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
    expect(resetMails(`new@${DOMAIN}`)).toHaveLength(0)
    expect(resetMails(`bob@${DOMAIN}`)).toHaveLength(0)
    expect(resetMails(`ada@${DOMAIN}`)).toHaveLength(1)
  })

  test('a reset started before enforcement cannot be finished by a non-member, but can by a break-glass member', async () => {
    const attempts: Record<string, { id: string; attemptSecret: string; code: string }> = {}
    const member = await seedUser(`ada@${DOMAIN}`, true, PASSWORD)
    await seedUser(`bob@${DOMAIN}`, true, PASSWORD)
    for (const who of ['ada', 'bob']) {
      const res = await post('/v1/client/password-resets', { email: `${who}@${DOMAIN}` })
      const body = (await res.json()) as { id: string; attemptSecret: string }
      const code = /\b(\d{6})\b/.exec(deps.mailer.last().text)?.[1] ?? ''
      attempts[who] = { ...body, code }
    }
    await Organizations.addMember(
      deps,
      TENANT,
      organizationId,
      { userId: member, role: BREAK_GLASS },
      TEST_ACTOR
    )
    await enforce()
    const finish = (who: string, code: string) =>
      post(
        `/v1/client/password-resets/${attempts[who]?.id}/password`,
        { code, password: 'another long passphrase 42' },
        { 'x-tula-attempt': attempts[who]?.attemptSecret ?? '' }
      )
    const wrongCode = await answer(await finish('bob', '000000'))
    const rightCode = await answer(await finish('bob', attempts.bob?.code ?? ''))
    expect(rightCode.status).not.toBe(200)
    expect((rightCode.body as { code: string }).code).toBe(
      (wrongCode.body as { code: string }).code
    )
    const stored = await deps.users.findByEmailWithPassword(TENANT.environmentId, `bob@${DOMAIN}`)
    expect(await Bun.password.verify(PASSWORD, stored?.passwordHash ?? '')).toBe(true)
    expect((await finish('ada', attempts.ada?.code ?? '')).status).toBe(200)
  })
})

describe('enforcement and a texted sign-in code', () => {
  const NUMBER = '+14155550142'

  /** The holder's code is right, so only the enforced domain can refuse the submission. */
  async function submitRightCode() {
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 3,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
        sso: { enabled: true },
        signIn: {
          methods: {
            password: { enabled: true },
            emailCode: { enabled: false },
            emailLink: { enabled: false },
            passkey: { enabled: false },
            smsCode: { enabled: true },
          },
        },
        sms: { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 500, templates: {} },
      } as never,
    })
    const holder = await seedUser(`ada@${DOMAIN}`, true)
    await deps.users.setPhoneNumber(
      TENANT.environmentId,
      holder,
      NUMBER,
      deps.clock.now(),
      Audit.none('fixture'),
      Audit.none('fixture')
    )
    const start = await post('/v1/client/sign-ins', { identifier: NUMBER })
    const attempt = (await start.json()) as { id: string; attemptSecret: string }
    const headers = { 'x-tula-attempt': attempt.attemptSecret }
    await post(
      `/v1/client/sign-ins/${attempt.id}/first-factor/prepare`,
      { strategy: 'sms_code' },
      headers
    )
    await Sms.settled()
    const code = /code is (\d{6})\./.exec(deps.sms.messages(NUMBER).at(-1)?.text ?? '')?.[1] ?? ''
    const res = await post(
      `/v1/client/sign-ins/${attempt.id}/first-factor/attempt`,
      { strategy: 'sms_code', code },
      headers
    )
    return { status: res.status, body: (await res.json()) as { code?: string } }
  }

  test('control: the right code signs the holder in while the domain is not enforced', async () => {
    expect((await submitRightCode()).status).toBe(200)
  })

  test('an enforced domain refuses the holder’s right code at the route', async () => {
    await SsoConnections.update(deps, TENANT, connectionId, { enforced: true }, TEST_ACTOR)
    const refused = await submitRightCode()
    expect(refused.body.code).toBe('auth.method_disabled')
  })
})

describe('enforcement and a passkey sign-in', () => {
  const RP_ID = 'acme.test'
  const ORIGIN = 'https://app.acme.test'

  /** A holder with a registered passkey signs in with it, so only the domain can refuse. */
  async function passkeySignIn() {
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 4,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
        sso: { enabled: true },
        signIn: {
          methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, passkey: { enabled: true } },
        },
        urls: { allowedOrigins: [ORIGIN], allowedRedirectUrls: [] },
        passkeys: { rpId: RP_ID },
      } as never,
    })
    const userId = await seedUser(`ada@${DOMAIN}`, true)
    const who = { userId, sessionId: deps.ids.next() }
    const request = { origin: ORIGIN, client: 'web' } as const
    const authenticator = new VirtualAuthenticator()
    const options = await Passkeys.startRegistration(deps, TENANT, who, request)
    const credential = await authenticator.create(options, { origin: ORIGIN })
    await Passkeys.finishRegistration(deps, TENANT, who, { credential }, request, {
      type: 'user',
      id: userId,
      ipAddress: null,
      userAgent: null,
    })
    const headers = { origin: ORIGIN, 'x-tula-client': 'web' }
    const begun = await post('/v1/client/sign-ins/passkey', {}, headers)
    const start = (await begun.json()) as {
      attempt: { id: string; attemptSecret: string }
      options: Parameters<VirtualAuthenticator['get']>[0]
    }
    const assertion = await authenticator.get(start.options, { origin: ORIGIN })
    const res = await post(
      `/v1/client/sign-ins/${start.attempt.id}/passkey`,
      { credential: assertion },
      { ...headers, 'x-tula-attempt': start.attempt.attemptSecret }
    )
    return { status: res.status, body: (await res.json()) as { code?: string } }
  }

  test('control: the passkey signs the holder in while the domain is not enforced', async () => {
    expect((await passkeySignIn()).status).toBe(200)
  })

  test('an enforced domain refuses the holder’s right passkey', async () => {
    await SsoConnections.update(deps, TENANT, connectionId, { enforced: true }, TEST_ACTOR)
    const refused = await passkeySignIn()
    expect(refused.body.code).toBe('auth.method_disabled')
  })
})
