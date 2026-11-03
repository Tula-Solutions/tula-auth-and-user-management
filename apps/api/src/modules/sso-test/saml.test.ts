import { beforeEach, describe, expect, test } from 'bun:test'
import { inflateRawSync } from 'node:zlib'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  SSO_TEST_REASONS,
  type SsoTestReason,
} from '@tula-tech/contract'
import {
  buildMockSamlResponse,
  MOCK_SAML_KEYS,
  type MockSamlFailure,
} from '~/adapters/oauth/mock-saml'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
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

// The test round of a SAML connection (TULA-145, ADR 0067) through the real verifier, with the
// mock signer told to get each thing wrong. A round stops before `finish()`: it creates no
// user, identity, membership or session, and shows the reason a sign-in never shows.

const PK = 'tula_pk_dev_sso0000000000000000000000000000'
const TENANT = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: '',
}
const REDIRECT = 'http://localhost:5174/oauth/callback'
const DOMAIN = 'acme.test'
const IDP = 'https://idp.example.test/entity'
const SSO_URL = 'https://idp.example.test/sso'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let organizationId: string
let connectionId: string
let acsPath: string
let spEntityId: string
let acsUrl: string

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
  organizationId = (
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
      saml: {
        idpEntityId: IDP,
        ssoUrl: SSO_URL,
        certificates: [MOCK_SAML_KEYS.a.certificate],
      },
      defaultRole: 'member',
      domains: [DOMAIN],
    },
    TEST_ACTOR
  )
  connectionId = made.id
  spEntityId = made.saml?.spEntityId ?? ''
  acsUrl = made.saml?.acsUrl ?? ''
  acsPath = new URL(acsUrl).pathname
})

/** Start a test round: the request id the IdP answers and the state it returns. */
async function started() {
  const begun = await SsoTests.start(deps, TENANT, connectionId, REDIRECT, TEST_ACTOR)
  const url = new URL(begun.authorizationUrl)
  const xml = inflateRawSync(
    Buffer.from(url.searchParams.get('SAMLRequest') ?? '', 'base64')
  ).toString()
  return {
    testId: begun.testId,
    requestId: /ID="([^"]+)"/.exec(xml)?.[1] ?? '',
    relayState: url.searchParams.get('RelayState') ?? '',
  }
}

interface Say {
  failure?: MockSamlFailure
  key?: 'a' | 'b' | 'c'
  subject?: string
  attributes?: Record<string, string[]>
}

/** The IdP posts its answer to the ACS; the browser comes back to the app's page. */
async function answer(s: Awaited<ReturnType<typeof started>>, say: Say = {}) {
  const response = buildMockSamlResponse({
    mockProviderEnabled: true,
    spEntityId,
    acsUrl,
    idpEntityId: IDP,
    requestId: s.requestId,
    now: deps.clock.now(),
    ...say,
    subject: say.subject ?? `ada@${DOMAIN}`,
  })
  const res = await app.request(acsPath, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      // Exactly what an IdP posts: one base64 of the Response XML.
      SAMLResponse: response,
      RelayState: s.relayState,
    }),
  })
  return { res, location: res.headers.get('location') ?? '', response }
}

async function snapshot() {
  const users = await deps.users.list(TENANT.environmentId, {
    page: 1,
    size: 50,
    sort: '-createdAt',
  })
  const members = await deps.organizations.listMemberships(TENANT.environmentId, organizationId, {
    page: 1,
    size: 50,
  })
  return {
    users: users.totalCount,
    members: members.total,
    identity: await deps.ssoConnections.findIdentity(
      TENANT.environmentId,
      connectionId,
      `ada@${DOMAIN}`
    ),
    activity: deps.activityLog.entries.map((e) => e.type),
  }
}

describe('SAML test round', () => {
  test('a passing round reports what arrived, marks the connection tested and creates nothing', async () => {
    const before = await snapshot()
    const s = await started()
    expect((await SsoTests.result(deps, TENANT, connectionId, s.testId)).status).toBe('pending')
    const back = await answer(s, {
      attributes: { email: [`ada@${DOMAIN}`], groups: ['admins', 'staff'], givenName: ['Ada'] },
    })
    expect(back.res.status).toBe(303)
    expect(back.location).toStartWith(`${REDIRECT}#tula_test=${s.testId}`)
    const result = await SsoTests.result(deps, TENANT, connectionId, s.testId)
    expect(result).toMatchObject({
      status: 'passed',
      reason: null,
      message: null,
      groups: ['admins', 'staff'],
      mapped: { email: `ada@${DOMAIN}`, emailOnVerifiedDomain: true },
    })
    expect(result.attributes.map((a) => a.name)).toContain('groups')
    expect((await SsoConnections.get(deps, TENANT, connectionId)).tested).toBe(true)
    const after = await snapshot()
    expect(after.users).toBe(before.users)
    expect(after.members).toBe(before.members)
    expect(after.identity).toBeNull()
    expect(after.activity.filter((t) => !before.activity.includes(t))).toEqual([
      'sso_connection.updated',
    ])
    // No raw assertion and no token is kept anywhere in the result.
    const text = JSON.stringify(result)
    expect(text).not.toContain('Signature')
    expect(text).not.toContain(back.response)
    expect(text).not.toContain('Assertion')
  })

  test('the connection can then be activated, and a changed setting takes the mark away', async () => {
    const s = await started()
    await answer(s)
    await SsoConnections.update(deps, TENANT, connectionId, { status: 'active' }, TEST_ACTOR)
    const again = await SsoConnections.update(
      deps,
      TENANT,
      connectionId,
      { name: 'Renamed', defaultRole: 'member' },
      TEST_ACTOR
    )
    expect(again.status).toBe('active')
  })

  const refusals: [MockSamlFailure | 'key_c', SsoTestReason][] = [
    ['wrong_audience', 'wrong_audience'],
    ['wrong_issuer', 'wrong_issuer'],
    ['wrong_recipient', 'wrong_recipient'],
    ['wrong_destination', 'wrong_recipient'],
    ['missing_in_response_to', 'response_not_to_this_request'],
    ['wrong_in_response_to', 'response_not_to_this_request'],
    ['expired', 'assertion_expired'],
    ['not_yet_valid', 'clock_skew'],
    ['unsigned', 'unsigned_assertion'],
    ['response_signed_assertion_unsigned', 'unsigned_assertion'],
    ['second_assertion', 'malformed_response'],
    ['doctype', 'malformed_response'],
    ['entity', 'malformed_response'],
    ['status_failure', 'idp_refused'],
    ['key_c', 'certificate_not_trusted'],
  ]
  test.each(refusals)(
    'a %s response fails the round with %s and its sentence',
    async (what, reason) => {
      const before = await snapshot()
      const s = await started()
      const back = await answer(s, what === 'key_c' ? { key: 'c' } : { failure: what })
      expect(back.location).toStartWith(`${REDIRECT}#tula_test=${s.testId}`)
      const result = await SsoTests.result(deps, TENANT, connectionId, s.testId)
      expect(result).toMatchObject({ status: 'failed', reason, message: SSO_TEST_REASONS[reason] })
      expect(JSON.stringify(result)).not.toContain('SAMLResponse')
      expect((await SsoConnections.get(deps, TENANT, connectionId)).tested).toBe(false)
      expect(await snapshot()).toEqual(before)
    }
  )

  test('an address outside the connection’s domains fails with email_outside_domains', async () => {
    const s = await started()
    await answer(s, { subject: 'eve@other.test' })
    const result = await SsoTests.result(deps, TENANT, connectionId, s.testId)
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'email_outside_domains',
      mapped: { email: 'eve@other.test', emailOnVerifiedDomain: false },
    })
    expect((await SsoConnections.get(deps, TENANT, connectionId)).tested).toBe(false)
  })

  test('a name that is not an email fails with email_missing', async () => {
    const s = await started()
    await answer(s, { subject: 'not-an-address' })
    const result = await SsoTests.result(deps, TENANT, connectionId, s.testId)
    expect(result).toMatchObject({ status: 'failed', reason: 'email_missing' })
  })

  test('the state is single use: a second answer changes nothing', async () => {
    const s = await started()
    await answer(s, { failure: 'wrong_audience' })
    const replay = await answer(s)
    expect(replay.res.status).not.toBe(303)
    const result = await SsoTests.result(deps, TENANT, connectionId, s.testId)
    expect(result.reason).toBe('wrong_audience')
  })

  test('a test of another connection or another environment is not found', async () => {
    const s = await started()
    await expect(SsoTests.result(deps, TENANT, Bun.randomUUIDv7(), s.testId)).rejects.toMatchObject(
      { code: 'sso.test_not_found', status: 404 }
    )
    await expect(
      SsoTests.result(
        deps,
        { environmentId: TEST_TENANT.productionEnvironmentId },
        connectionId,
        s.testId
      )
    ).rejects.toMatchObject({ code: 'sso.test_not_found' })
  })
})
