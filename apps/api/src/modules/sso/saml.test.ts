import { beforeEach, describe, expect, test } from 'bun:test'
import { inflateRawSync } from 'node:zlib'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import {
  buildMockSamlResponse,
  MOCK_SAML_KEYS,
  type MockSamlFailure,
} from '~/adapters/oauth/mock-saml'
import { FakeRedis } from '~/adapters/redis/fake'
import { RedisProofReplayGuard } from '~/adapters/redis/proof-replay'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import * as SsoConnections from '~/modules/sso-connection/service'
import {
  createTestDeps,
  seedApiKey,
  TEST_ACTOR,
  TEST_CONFIG,
  TEST_TENANT,
  type TestDeps,
} from '~/testing'
import { passTest } from '~/testing/sso-tested'

// The SAML round of an SSO connection (ADR 0067), through the real routes and the real
// verifier; the identity provider is the mock signer, told to get each thing wrong.

const PK = 'tula_pk_dev_sso0000000000000000000000000000'
const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const REDIRECT = 'http://localhost:5174/oauth/callback'
const DOMAIN = 'acme.test'
const IDP = 'https://idp.example.test/entity'
const SSO_URL = 'https://idp.example.test/sso'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let connectionId: string
let acsPath: string
let spEntityId: string
let acsUrl: string

async function connect(certificates: string[]) {
  const organizationId = (
    await Organizations.create(deps, TENANT, { name: 'Acme', slug: 'acme' }, TEST_ACTOR)
  ).id
  const id = Bun.randomUUIDv7()
  const none = Audit.none('fixture')
  const now = deps.clock.now()
  await deps.organizationDomains.claim(
    {
      id,
      ...TENANT,
      organizationId,
      domain: DOMAIN,
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
  const made = await SsoConnections.create(
    deps,
    TENANT,
    {
      organizationId,
      protocol: 'saml',
      name: 'Okta SAML',
      saml: { idpEntityId: IDP, ssoUrl: SSO_URL, certificates },
      defaultRole: 'member',
      domains: [DOMAIN],
    },
    TEST_ACTOR
  )
  connectionId = made.id
  spEntityId = made.saml?.spEntityId ?? ''
  acsUrl = made.saml?.acsUrl ?? ''
  acsPath = new URL(acsUrl).pathname
  await passTest(deps, TENANT, made.id, TEST_ACTOR)
  await SsoConnections.update(deps, TENANT, made.id, { status: 'active' }, TEST_ACTOR)
}

beforeEach(async () => {
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
  await connect([MOCK_SAML_KEYS.a.certificate, MOCK_SAML_KEYS.b.certificate])
})

const HEADERS = { 'content-type': 'application/json', 'x-tula-publishable-key': PK }

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { ...HEADERS, 'x-tula-client': 'ios', ...headers },
    body: JSON.stringify(body),
  })
}

/** Start a sign-in and its SAML redirect: what the IdP is asked, and the state to return. */
async function started(email = `ada@${DOMAIN}`) {
  const signIn = await post('/v1/client/sign-ins', { identifier: email })
  const attempt = (await signIn.json()) as { id: string; attemptSecret: string }
  const sso = await post(
    `/v1/client/sign-ins/${attempt.id}/sso`,
    { redirectUrl: REDIRECT },
    { 'x-tula-attempt': attempt.attemptSecret }
  )
  const begun = (await sso.json()) as { authorizationUrl: string; binding: string }
  const url = new URL(begun.authorizationUrl)
  const xml = inflateRawSync(
    Buffer.from(url.searchParams.get('SAMLRequest') ?? '', 'base64')
  ).toString()
  return {
    begun,
    url,
    xml,
    requestId: /ID="([^"]+)"/.exec(xml)?.[1] ?? '',
    relayState: url.searchParams.get('RelayState') ?? '',
  }
}

interface Say {
  failure?: MockSamlFailure
  key?: 'a' | 'b' | 'c'
  subject?: string
  assertionId?: string
}

function respond(s: Awaited<ReturnType<typeof started>>, say: Say = {}) {
  return buildMockSamlResponse({
    mockProviderEnabled: true,
    spEntityId,
    acsUrl,
    idpEntityId: IDP,
    requestId: s.requestId,
    now: deps.clock.now(),
    ...say,
    subject: say.subject ?? `ada@${DOMAIN}`,
  })
}

/** The IdP posts its response to the ACS. */
async function acs(response: string, relayState: string) {
  const res = await app.request(acsPath, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      SAMLResponse: Buffer.from(response).toString('base64'),
      RelayState: relayState,
    }),
  })
  const location = res.headers.get('location') ?? ''
  return { res, location, fragment: new URLSearchParams(location.split('#')[1] ?? '') }
}

async function exchange(back: { fragment: URLSearchParams }, binding: string) {
  return post('/v1/client/sign-ins/oauth/exchange', {
    ticket: back.fragment.get('tula_ticket'),
    attemptId: back.fragment.get('tula_attempt'),
    binding,
  })
}

describe('SAML sign-in', () => {
  test('asks the IdP with a Redirect-binding AuthnRequest naming the SP and the ACS', async () => {
    const s = await started()
    expect(s.url.origin + s.url.pathname).toBe(SSO_URL)
    expect(s.xml).toContain('Issuer')
    expect(s.xml).toContain(spEntityId)
    expect(s.xml).toContain(acsUrl)
    expect(s.requestId).toStartWith('_')
  })

  test('a signed response to the request signs the user in', async () => {
    const s = await started()
    const back = await acs(respond(s), s.relayState)
    expect(back.res.status).toBe(303)
    expect(back.fragment.get('tula_error')).toBeNull()
    const done = await exchange(back, s.begun.binding)
    expect(done.status).toBe(200)
    const body = (await done.json()) as { step: { status: string } }
    expect(body.step.status).toBe('complete')
  })

  test.each(['a', 'b'] as const)('certificate %s is accepted (rotation)', async (key) => {
    const s = await started()
    const back = await acs(respond(s, { key }), s.relayState)
    expect(back.fragment.get('tula_error')).toBeNull()
    expect((await exchange(back, s.begun.binding)).status).toBe(200)
  })

  test('a certificate that is not configured is refused', async () => {
    const s = await started()
    const back = await acs(respond(s, { key: 'c' }), s.relayState)
    expect(back.fragment.get('tula_error')).toBe('sso.provider_error')
  })

  const FAILURES: MockSamlFailure[] = [
    'wrong_audience',
    'wrong_recipient',
    'wrong_destination',
    'missing_in_response_to',
    'wrong_in_response_to',
    'expired',
    'not_yet_valid',
    'unsigned',
    'response_signed_assertion_unsigned',
    'second_assertion',
    'comment_in_name_id',
    'doctype',
    'entity',
    'wrong_issuer',
    'status_failure',
  ]

  test.each(FAILURES)(
    '%s is refused with one generic error and no assertion content',
    async (failure) => {
      const s = await started()
      const back = await acs(
        respond(s, { failure, subject: 'secret.person@acme.test' }),
        s.relayState
      )
      expect(back.res.status).toBe(303)
      expect(back.fragment.get('tula_error')).toBe('sso.provider_error')
      expect(back.fragment.get('tula_ticket')).toBeNull()
      expect(back.location).not.toContain('secret.person')
      expect(back.location).not.toContain(failure)
      expect(await back.res.text()).not.toContain('secret.person')
    }
  )

  test('a response replayed is refused', async () => {
    const s = await started()
    expect(
      (await acs(respond(s, { assertionId: '_same-assertion' }), s.relayState)).fragment.get(
        'tula_error'
      )
    ).toBeNull()
    const s2 = await started()
    const again = await acs(respond(s2, { assertionId: '_same-assertion' }), s2.relayState)
    expect(again.fragment.get('tula_error')).toBe('sso.provider_error')
  })

  test('a response with no request of ours (IdP-initiated) gets the static page', async () => {
    const s = await started()
    expect((await acs(respond(s), 'not-a-state')).res.status).toBe(400)
    const unsolicited = await acs(
      buildMockSamlResponse({
        mockProviderEnabled: true,
        spEntityId,
        acsUrl,
        idpEntityId: IDP,
        subject: `ada@${DOMAIN}`,
        now: deps.clock.now(),
      }),
      ''
    )
    expect(unsolicited.res.status).toBe(400)
  })

  test('a response for another request id is refused', async () => {
    const s = await started()
    const other = await started()
    const back = await acs(respond(other), s.relayState)
    expect(back.fragment.get('tula_error')).toBe('sso.provider_error')
  })

  test('a malformed SAMLResponse is refused with the same generic error', async () => {
    const s = await started()
    const back = await acs('not xml at all', s.relayState)
    expect(back.fragment.get('tula_error')).toBe('sso.provider_error')
  })

  test('the ACS has a limit per connection', async () => {
    let last = 0
    for (let i = 0; i < 40 && last !== 429; i++) {
      last = (await acs('x', 'nope')).res.status
    }
    expect(last).toBe(429)
  })
})

describe('SAML metadata route', () => {
  test('serves the SP metadata Okta and Entra need, public', async () => {
    const res = await app.request(new URL(spEntityId).pathname)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('xml')
    const xml = await res.text()
    expect(xml).toContain(`entityID="${spEntityId}"`)
    expect(xml).toContain('HTTP-POST')
    expect(xml).toContain(acsUrl)
    expect(xml).toContain('nameid-format:emailAddress')
  })

  test('an unknown connection is a 404', async () => {
    const res = await app.request(
      new URL(spEntityId).pathname.replace(connectionId, Bun.randomUUIDv7())
    )
    expect(res.status).toBe(404)
  })
})

describe('two instances sharing one replay guard', () => {
  test('an assertion accepted by one instance is refused by the other', async () => {
    const redis = new FakeRedis(deps.clock)
    const instance = () =>
      createApp({ ...deps, proofReplay: new RedisProofReplayGuard(redis, deps.clock) })
    const a = instance()
    const b = instance()
    const same = '_one-assertion-for-both'
    const run = async (target: ReturnType<typeof createApp>) => {
      app = target
      const s = await started()
      return (await acs(respond(s, { assertionId: same }), s.relayState)).fragment.get('tula_error')
    }
    expect(await run(a)).toBeNull()
    expect(await run(b)).toBe('sso.provider_error')
  })
})

describe('the mock identity provider (SAML)', () => {
  /** Ask the mock as the browser would: its page, and the form it posts. */
  async function viaMock(
    s: Awaited<ReturnType<typeof started>>,
    extra: Record<string, string> = {}
  ) {
    const query = new URLSearchParams({
      SAMLRequest: s.url.searchParams.get('SAMLRequest') ?? '',
      RelayState: s.relayState,
      login_hint: `ada@${DOMAIN}`,
      idp: IDP,
      ...extra,
    })
    const page = await app.request(`/v1/dev/sso/saml/sso?${query}`, {
      headers: { host: 'localhost:3003' },
    })
    const html = await page.text()
    return {
      page,
      html,
      response: Buffer.from(
        /name="SAMLResponse" value="([^"]+)"/.exec(html)?.[1] ?? '',
        'base64'
      ).toString(),
    }
  }

  test('serves a self-posting form that signs the user in, under a strict CSP', async () => {
    const s = await started()
    const mock = await viaMock(s)
    expect(mock.page.status).toBe(200)
    expect(mock.page.headers.get('content-security-policy')).toContain("script-src 'sha256-")
    expect(mock.html).toContain(`action="${acsUrl}"`)
    const back = await acs(mock.response, s.relayState)
    expect(back.fragment.get('tula_error')).toBeNull()
    expect((await exchange(back, s.begun.binding)).status).toBe(200)
  })

  test('can be told to produce a failure, which the ACS refuses', async () => {
    const s = await started()
    const mock = await viaMock(s, { failure: 'expired' })
    expect((await acs(mock.response, s.relayState)).fragment.get('tula_error')).toBe(
      'sso.provider_error'
    )
  })

  test('refuses a request whose ACS is not this API\u2019s own', async () => {
    const s = await started()
    const xml = s.xml.replace(acsUrl, 'https://evil.example/acs')
    const { deflateRawSync } = await import('node:zlib')
    const mock = await viaMock(s, {
      SAMLRequest: deflateRawSync(Buffer.from(xml)).toString('base64'),
    })
    expect(mock.page.status).toBe(400)
  })

  test('is not served to a non-loopback host', async () => {
    const res = await app.request('/v1/dev/sso/saml/metadata', {
      headers: { host: 'idp.example.test' },
    })
    expect(res.status).toBe(403)
  })

  test('publishes its metadata with both signing certificates', async () => {
    const res = await app.request('/v1/dev/sso/saml/metadata', {
      headers: { host: 'localhost:3003' },
    })
    expect(res.status).toBe(200)
    expect((await res.text()).match(/<ds:X509Certificate>/g)).toHaveLength(2)
  })
})
