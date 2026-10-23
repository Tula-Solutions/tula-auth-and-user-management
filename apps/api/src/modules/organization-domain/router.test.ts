import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type CurrentUser,
  DEFAULT_ENVIRONMENT_SETTINGS,
  EVENT_DATA_SCHEMAS,
  type FlowAttempt,
  type OrganizationDomain,
  type OrganizationSuggestionList,
  type HybridSessionTokens as SessionTokens,
  type UserOrganization,
} from '@tula-tech/contract'
import { createApp } from '~/index'
import { systemActor } from '~/lib/actor'
import * as MeOrganizations from '~/modules/organization/me-service'
import * as Organizations from '~/modules/organization/service'
import * as Reminders from '~/modules/organization-domain/reminders'
import * as Domains from '~/modules/organization-domain/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'
const PROD_SK = 'tula_sk_live_secret00000000000000000000000'
const PASSWORD = 'correct horse battery staple'
const ORIGIN = 'https://app.northline.test'
const UNKNOWN = '00000000-0000-7000-8000-00000000dead'
const PROD = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.productionEnvironmentId,
}
const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

let deps: TestDeps
let app: ReturnType<typeof createApp>
let revision = 0

function configure(organizations: Record<string, unknown> = {}) {
  revision += 1
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      urls: { allowedOrigins: [ORIGIN], allowedRedirectUrls: [] },
      organizations: {
        ...DEFAULT_ENVIRONMENT_SETTINGS.organizations,
        enabled: true,
        ...organizations,
      },
    } as never,
  })
}

beforeEach(async () => {
  deps = createTestDeps()
  revision = 0
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  await seedApiKey(deps, AK)
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  configure()
  app = createApp(deps)
})

const json = async <T>(res: Response) => (await res.json()) as T
const codeOf = async (res: Response) => (await json<{ code: string }>(res)).code
const emailedCode = () =>
  /^(\d{6}) /.exec(
    deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))?.subject ?? ''
  )?.[1] ?? ''
const types = () => deps.activityLog.entries.map((entry) => entry.type)

function admin(method: string, path: string, body?: unknown, key = SK) {
  return app.request(`/v1/admin/organizations${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

function client(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-client': 'ios',
    origin: ORIGIN,
    'x-tula-publishable-key': PK,
  }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  return app.request(`/v1/client${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

/** Sign up through the real flow and return the session and the user's id. */
async function signedUp(email: string) {
  const started = await json<FlowAttempt>(
    await client('POST', '/sign-ups', { email, password: PASSWORD })
  )
  const res = await app.request(`/v1/client/sign-ups/${started.id}/verify-email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-client': 'ios',
      origin: ORIGIN,
      'x-tula-publishable-key': PK,
      'x-tula-attempt': started.attemptSecret ?? '',
    },
    body: JSON.stringify({ code: emailedCode() }),
  })
  const done = await json<FlowAttempt>(res)
  const session = done.session as SessionTokens
  const me = await json<CurrentUser>(await client('GET', '/me', undefined, session.accessToken))
  return { ...session, userId: me.id }
}

async function organization(slug = 'acme') {
  return Organizations.create(deps, TENANT, { name: 'Acme Corp', slug }, TEST_ACTOR)
}

async function claim(orgId: string, domain = 'northline.app', mode = 'suggest', local = 'ada') {
  return admin('POST', `/${orgId}/domains`, { domain, email: `${local}@${domain}`, mode })
}

/** Claim and verify with the emailed code. */
async function verifiedDomain(orgId: string, domain = 'northline.app', mode = 'suggest') {
  const pending = await json<OrganizationDomain>(await claim(orgId, domain, mode))
  const res = await admin('POST', `/${orgId}/domains/${pending.id}/verify`, {
    code: emailedCode(),
  })
  expect(res.status).toBe(200)
  return json<OrganizationDomain>(res)
}

describe('claiming a domain', () => {
  test('emails a code to an address on the domain and keeps a pending claim that grants nothing', async () => {
    const org = await organization()
    const res = await claim(org.id)
    expect(res.status).toBe(201)
    const body = await json<OrganizationDomain>(res)
    expect(body).toMatchObject({ domain: 'northline.app', mode: 'suggest', verifiedAt: null })
    expect(body.codeExpiresAt).not.toBeNull()
    expect(deps.mailer.outbox.at(-1)?.to).toBe('ada@northline.app')
    expect(emailedCode()).toMatch(/^\d{6}$/)
    expect(JSON.stringify(body)).not.toContain(emailedCode())
    expect(
      await deps.organizationDomains.findVerified(TENANT.environmentId, 'northline.app')
    ).toBeNull()
    expect(types()).toContain('organization_domain.claimed')
  })

  test.each([
    'gmail.com',
    'outlook.com',
    'hotmail.co.uk',
    'yahoo.fr',
    'yahoo.co.jp',
    'icloud.com',
    'proton.me',
  ])('a public domain (%s) is refused and nothing is sent', async (domain) => {
    const org = await organization()
    const res = await claim(org.id, domain)
    expect(res.status).toBe(422)
    expect(await codeOf(res)).toBe('organization.domain_public')
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('a provider name under another domain is not a public domain', async () => {
    const org = await organization()
    expect((await claim(org.id, 'yahoo.acme.example')).status).toBe(201)
  })

  test.each([
    ['an address on a subdomain', 'northline.app', 'ada@mail.northline.app'],
    ['an address on a parent domain', 'mail.northline.app', 'ada@northline.app'],
    ['an address on another domain', 'northline.app', 'ada@other.example'],
  ])('%s is refused', async (_name, domain, email) => {
    const org = await organization()
    const res = await admin('POST', `/${org.id}/domains`, { domain, email, mode: 'suggest' })
    expect(res.status).toBe(422)
    expect(await codeOf(res)).toBe('organization.domain_address_mismatch')
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('an address that is not an address is refused', async () => {
    const org = await organization()
    const res = await admin('POST', `/${org.id}/domains`, {
      domain: 'northline.app',
      email: 'nope',
      mode: 'suggest',
    })
    expect(res.status).toBe(422)
  })

  test.each([
    ['upper case', 'Northline.app'],
    ['an IPv4 address', '192.168.0.1'],
    ['an IPv6 literal', '[::1]'],
    ['unicode', 'bücher.example'],
    ['a trailing full stop', 'northline.app.'],
    ['an underscore', 'north_line.app'],
    ['a single label', 'localhost'],
    ['a wildcard', '*.northline.app'],
    ['a label of 64 characters', `${'a'.repeat(64)}.app`],
    ['a name of 254 characters', `${`${'a'.repeat(60)}.`.repeat(4)}app`],
  ])('a domain with %s is refused as invalid', async (_name, domain) => {
    const org = await organization()
    const res = await admin('POST', `/${org.id}/domains`, {
      domain,
      email: 'ada@northline.app',
      mode: 'suggest',
    })
    expect(res.status).toBe(422)
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('punycode is accepted', async () => {
    const org = await organization()
    const res = await admin('POST', `/${org.id}/domains`, {
      domain: 'xn--bcher-kva.example',
      email: 'ada@xn--bcher-kva.example',
      mode: 'suggest',
    })
    expect(res.status).toBe(201)
  })

  test('an unknown mode is refused', async () => {
    const org = await organization()
    const res = await admin('POST', `/${org.id}/domains`, {
      domain: 'northline.app',
      email: 'ada@northline.app',
      mode: 'everyone',
    })
    expect(res.status).toBe(422)
  })

  test('a domain verified for an organization cannot be claimed by another while it holds', async () => {
    const one = await organization('one')
    const two = await organization('two')
    await verifiedDomain(one.id)
    deps.clock.advance('2m')
    const res = await claim(two.id)
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('organization.domain_taken')
  })

  test('two organizations may wait on a name; the second to enter its code is refused', async () => {
    const one = await organization('one')
    const two = await organization('two')
    const first = await json<OrganizationDomain>(await claim(one.id))
    const firstCode = emailedCode()
    const second = await json<OrganizationDomain>(await claim(two.id))
    const secondCode = emailedCode()
    expect(
      (await admin('POST', `/${one.id}/domains/${first.id}/verify`, { code: firstCode })).status
    ).toBe(200)
    const res = await admin('POST', `/${two.id}/domains/${second.id}/verify`, { code: secondCode })
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('organization.domain_taken')
    expect(
      (await json<{ data: OrganizationDomain[] }>(await admin('GET', `/${two.id}/domains`))).data[0]
        ?.verifiedAt
    ).toBeNull()
  })

  test('an organization has at most ten domains', async () => {
    const org = await organization()
    for (let i = 0; i < 10; i += 1) {
      deps.clock.advance('2m')
      expect((await claim(org.id, `d${i}.example`)).status).toBe(201)
    }
    deps.clock.advance('2m')
    const res = await claim(org.id, 'eleven.example')
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('organization.domain_limit')
    // A claim it has already may still be sent again (an hour on: ten sends an hour is the cap).
    deps.clock.advance('1h')
    expect((await claim(org.id, 'd0.example')).status).toBe(201)
  })

  test('sending is limited: one a minute per organization, and five an hour to one address', async () => {
    const org = await organization()
    expect((await claim(org.id)).status).toBe(201)
    const again = await claim(org.id)
    expect(again.status).toBe(429)
    for (let i = 0; i < 4; i += 1) {
      deps.clock.advance('61s')
      expect((await claim(org.id)).status).toBe(201)
    }
    deps.clock.advance('61s')
    const sixth = await claim(org.id)
    expect(sixth.status).toBe(429)
    expect(deps.mailer.outbox).toHaveLength(5)
  })

  test('the environment-wide daily cap holds', async () => {
    for (let i = 0; i < Domains.CODES_PER_ENVIRONMENT_PER_DAY; i += 1) {
      await deps.rateLimiter.hit(
        `organization_domain_environment:${TENANT.environmentId}`,
        Domains.CODES_PER_ENVIRONMENT_PER_DAY,
        86_400_000
      )
    }
    const org = await organization()
    expect((await claim(org.id)).status).toBe(429)
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('one organization spends its own daily allowance, not the environment’s', async () => {
    const busy = await organization('busy')
    const other = await organization('other')
    for (let i = 0; i < Domains.CODES_PER_ORGANIZATION_PER_DAY; i += 1) {
      await deps.rateLimiter.hit(
        `organization_domain_day:${TENANT.environmentId}:${busy.id}`,
        Domains.CODES_PER_ORGANIZATION_PER_DAY,
        86_400_000
      )
    }
    expect((await claim(busy.id)).status).toBe(429)
    expect((await claim(other.id, 'other.example')).status).toBe(201)
  })

  test('organizations switched off: every domain route says so and writes nothing', async () => {
    const org = await organization()
    configure({ enabled: false })
    for (const [method, path, body] of [
      ['GET', `/${org.id}/domains`, undefined],
      [
        'POST',
        `/${org.id}/domains`,
        { domain: 'northline.app', email: 'a@northline.app', mode: 'suggest' },
      ],
      ['POST', `/${org.id}/domains/${UNKNOWN}/verify`, { code: '123456' }],
      ['PATCH', `/${org.id}/domains/${UNKNOWN}`, { mode: 'suggest' }],
      ['DELETE', `/${org.id}/domains/${UNKNOWN}`, undefined],
    ] as const) {
      const res = await admin(method, path, body)
      expect(res.status).toBe(403)
      expect(await codeOf(res)).toBe('organization.disabled')
    }
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('an agent key reads and is refused every write; another environment’s organization is 404', async () => {
    const org = await organization()
    expect((await admin('GET', `/${org.id}/domains`, undefined, AK)).status).toBe(200)
    const res = await admin(
      'POST',
      `/${org.id}/domains`,
      { domain: 'northline.app', email: 'a@northline.app', mode: 'suggest' },
      AK
    )
    expect(res.status).toBe(401)
    expect(deps.mailer.outbox).toHaveLength(0)
    deps.environmentSettings.seed(TEST_TENANT.productionEnvironmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
      } as never,
    })
    expect((await admin('GET', `/${org.id}/domains`, undefined, PROD_SK)).status).toBe(404)
    expect((await claimWith(PROD_SK, org.id)).status).toBe(404)
  })
})

function claimWith(key: string, orgId: string) {
  return admin(
    'POST',
    `/${orgId}/domains`,
    { domain: 'northline.app', email: 'ada@northline.app', mode: 'suggest' },
    key
  )
}

describe('verifying a domain', () => {
  test('the right code verifies, clears the code and records it with the domain and ids only', async () => {
    const org = await organization()
    const pending = await json<OrganizationDomain>(
      await claim(org.id, 'northline.app', 'auto_join')
    )
    const res = await admin('POST', `/${org.id}/domains/${pending.id}/verify`, {
      code: emailedCode(),
    })
    expect(res.status).toBe(200)
    expect(await json<OrganizationDomain>(res)).toMatchObject({
      domain: 'northline.app',
      mode: 'auto_join',
      codeExpiresAt: null,
    })
    const entry = deps.activityLog.entries.find(
      (one) => one.type === 'organization_domain.verified'
    )
    expect(entry?.data).toEqual({
      organizationId: org.id,
      domain: 'northline.app',
      mode: 'auto_join',
      weakened: true,
    })
    expect(EVENT_DATA_SCHEMAS['organization_domain.verified'].safeParse(entry?.data).success).toBe(
      true
    )
    expect(JSON.stringify(entry)).not.toContain('@')
    // A second verify of a verified claim answers as it is, with no code needed.
    expect(
      (await admin('POST', `/${org.id}/domains/${pending.id}/verify`, { code: '000000' })).status
    ).toBe(200)
  })

  test('a wrong code is invalid and counted; five wrong codes spend the code', async () => {
    const org = await organization()
    const pending = await json<OrganizationDomain>(await claim(org.id))
    const right = emailedCode()
    const wrong = right === '000000' ? '111111' : '000000'
    const first = await admin('POST', `/${org.id}/domains/${pending.id}/verify`, { code: wrong })
    expect(first.status).toBe(422)
    const firstBody = await json<{ code: string; params: { attemptsRemaining: number } }>(first)
    expect(firstBody.code).toBe('verification.invalid_code')
    expect(firstBody.params.attemptsRemaining).toBe(4)
    for (let i = 0; i < 4; i += 1) {
      await admin('POST', `/${org.id}/domains/${pending.id}/verify`, { code: wrong })
    }
    // Five guesses are spent and the sixth hits the back-off before the code is looked at.
    const sixth = await admin('POST', `/${org.id}/domains/${pending.id}/verify`, { code: right })
    expect(sixth.status).toBe(429)
    expect(
      await deps.organizationDomains.findVerified(TENANT.environmentId, 'northline.app')
    ).toBeNull()
  })

  test('after the back-off the spent code is still refused, and a new code works', async () => {
    const org = await organization()
    const pending = await json<OrganizationDomain>(await claim(org.id))
    const old = emailedCode()
    const wrong = old === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i += 1) {
      await admin('POST', `/${org.id}/domains/${pending.id}/verify`, { code: wrong })
    }
    deps.clock.advance('2m')
    const spent = await admin('POST', `/${org.id}/domains/${pending.id}/verify`, { code: old })
    expect(spent.status).toBe(429)
    expect(await codeOf(spent)).toBe('verification.too_many_attempts')
    await claim(org.id)
    const fresh = emailedCode()
    // Past the back-off, inside the new code's ten minutes.
    deps.clock.advance('5m')
    expect(
      (await admin('POST', `/${org.id}/domains/${pending.id}/verify`, { code: fresh })).status
    ).toBe(200)
  })

  test('a new code replaces the old one', async () => {
    const org = await organization()
    const pending = await json<OrganizationDomain>(await claim(org.id))
    const old = emailedCode()
    deps.clock.advance('2m')
    await claim(org.id)
    const fresh = emailedCode()
    if (fresh !== old) {
      const res = await admin('POST', `/${org.id}/domains/${pending.id}/verify`, { code: old })
      expect(res.status).toBe(422)
    }
    expect(
      (await admin('POST', `/${org.id}/domains/${pending.id}/verify`, { code: fresh })).status
    ).toBe(200)
  })

  test('an expired code is expired, not invalid, and counts nothing', async () => {
    const org = await organization()
    const pending = await json<OrganizationDomain>(await claim(org.id))
    const code = emailedCode()
    deps.clock.advance('11m')
    const res = await admin('POST', `/${org.id}/domains/${pending.id}/verify`, { code })
    expect(res.status).toBe(410)
    expect(await codeOf(res)).toBe('verification.expired')
  })

  test('a claim of another organization or an unknown id is 404', async () => {
    const one = await organization('one')
    const two = await organization('two')
    const pending = await json<OrganizationDomain>(await claim(one.id))
    const code = emailedCode()
    expect((await admin('POST', `/${two.id}/domains/${pending.id}/verify`, { code })).status).toBe(
      404
    )
    expect((await admin('POST', `/${one.id}/domains/${UNKNOWN}/verify`, { code })).status).toBe(404)
  })

  test('a code that is not six digits is invalid input', async () => {
    const org = await organization()
    const pending = await json<OrganizationDomain>(await claim(org.id))
    for (const code of ['12345', 'abcdef', '1234567', 123456]) {
      expect(
        (await admin('POST', `/${org.id}/domains/${pending.id}/verify`, { code })).status
      ).toBe(422)
    }
  })

  test('a stored claim of a domain the public list now holds is not verified', async () => {
    const org = await organization()
    const id = Bun.randomUUIDv7()
    const code = '123456'
    await deps.organizationDomains.claim(
      {
        id,
        ...TENANT,
        organizationId: org.id,
        domain: 'gmail.com',
        mode: 'auto_join',
        codeHash: await Domains.hashCode(deps, id, 'gmail.com', code),
        codeExpiresAt: new Date(deps.clock.now().getTime() + 60_000),
        at: deps.clock.now(),
        limit: 10,
      },
      (await import('~/modules/audit/service')).none('fixture')
    )
    const res = await admin('POST', `/${org.id}/domains/${id}/verify`, { code })
    expect(res.status).toBe(422)
    expect(await codeOf(res)).toBe('organization.domain_public')
  })
})

describe('changing and removing a domain', () => {
  test('moving to auto_join is recorded as a weakening, and the list shows it', async () => {
    const org = await organization()
    const done = await verifiedDomain(org.id)
    const res = await admin('PATCH', `/${org.id}/domains/${done.id}`, { mode: 'auto_join' })
    expect(res.status).toBe(200)
    const entry = deps.activityLog.entries.find((one) => one.type === 'organization_domain.updated')
    expect(entry?.data).toEqual({
      organizationId: org.id,
      domain: 'northline.app',
      mode: 'auto_join',
      previousMode: 'suggest',
      weakened: true,
    })
    const back = await admin('PATCH', `/${org.id}/domains/${done.id}`, { mode: 'suggest' })
    expect((await json<OrganizationDomain>(back)).mode).toBe('suggest')
  })

  test('removing a domain stops future joins and keeps the members it already brought', async () => {
    const org = await organization()
    const done = await verifiedDomain(org.id, 'northline.app', 'auto_join')
    const maya = await signedUp('maya@northline.app')
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, maya.userId)
    ).not.toBeNull()
    expect((await admin('DELETE', `/${org.id}/domains/${done.id}`)).status).toBe(204)
    expect((await admin('DELETE', `/${org.id}/domains/${done.id}`)).status).toBe(404)
    const kai = await signedUp('kai@northline.app')
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, kai.userId)
    ).toBeNull()
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, maya.userId)
    ).not.toBeNull()
    const entry = deps.activityLog.entries.find((one) => one.type === 'organization_domain.removed')
    expect(entry?.data).toEqual({ organizationId: org.id, domain: 'northline.app' })
    // The domain can be claimed by another organization now.
    const other = await organization('other')
    deps.clock.advance('2m')
    expect((await claim(other.id)).status).toBe(201)
  })

  test('deleting the organization removes its domains', async () => {
    const org = await organization()
    await verifiedDomain(org.id)
    await Organizations.remove(deps, TENANT, org.id, TEST_ACTOR)
    expect(
      await deps.organizationDomains.findVerified(TENANT.environmentId, 'northline.app')
    ).toBeNull()
  })
})

describe('joining at sign-up', () => {
  test('an auto_join domain makes a verified new user a member with the default role, recorded and evented', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'auto_join')
    const maya = await signedUp('maya@northline.app')
    const membership = await deps.organizations.findMembership(
      TENANT.environmentId,
      org.id,
      maya.userId
    )
    expect(membership?.roleKey).toBe('member')
    const entry = deps.activityLog.entries.find(
      (one) => one.type === 'organization_membership.added' && one.data.userId === maya.userId
    )
    expect(entry?.data).toEqual({
      organizationId: org.id,
      userId: maya.userId,
      role: 'member',
      via: 'domain_auto_join',
    })
    expect(entry?.actor.type).toBe('system')
    expect(EVENT_DATA_SCHEMAS['organization_membership.added'].safeParse(entry?.data).success).toBe(
      true
    )
  })

  test('the default role setting decides the role', async () => {
    configure({ defaultRole: 'admin' })
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'auto_join')
    const maya = await signedUp('maya@northline.app')
    expect(
      (await deps.organizations.findMembership(TENANT.environmentId, org.id, maya.userId))?.roleKey
    ).toBe('admin')
  })

  test('a suggest domain joins nobody; the organization is suggested instead', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'suggest')
    const maya = await signedUp('maya@northline.app')
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, maya.userId)
    ).toBeNull()
    const res = await client('GET', '/me/organizations/suggestions', undefined, maya.accessToken)
    expect(res.status).toBe(200)
    expect((await json<OrganizationSuggestionList>(res)).data).toEqual([
      { id: org.id, name: 'Acme Corp', slug: 'acme' },
    ])
  })

  test('a subdomain or another domain does not match', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'auto_join')
    for (const email of ['a@mail.northline.app', 'a@northline.app.example', 'a@notnorthline.app']) {
      const user = await signedUp(email)
      expect(
        await deps.organizations.findMembership(TENANT.environmentId, org.id, user.userId)
      ).toBeNull()
      const list = await json<OrganizationSuggestionList>(
        await client('GET', '/me/organizations/suggestions', undefined, user.accessToken)
      )
      expect(list.data).toEqual([])
    }
  })

  test('a sign-in does not join: only the sign-up does', async () => {
    const maya = await signedUp('maya@northline.app')
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'auto_join')
    const started = await json<FlowAttempt>(
      await client('POST', '/sign-ins', { identifier: 'maya@northline.app' })
    )
    const res = await app.request(`/v1/client/sign-ins/${started.id}/password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tula-client': 'ios',
        origin: ORIGIN,
        'x-tula-publishable-key': PK,
        'x-tula-attempt': started.attemptSecret ?? '',
      },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(res.status).toBe(200)
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, maya.userId)
    ).toBeNull()
    // They are offered it instead.
    const list = await json<OrganizationSuggestionList>(
      await client('GET', '/me/organizations/suggestions', undefined, maya.accessToken)
    )
    expect(list.data).toHaveLength(1)
  })

  test('organizations switched off join nobody', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'auto_join')
    configure({ enabled: false })
    const maya = await signedUp('maya@northline.app')
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, maya.userId)
    ).toBeNull()
  })

  test('another environment’s domain joins nobody here', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'auto_join')
    const joined = await Domains.joinOnSignUp(
      deps,
      PROD,
      (await signedUp('x@other.example')).userId,
      systemActor()
    )
    expect(joined).toBe(false)
  })

  describe('joinOnSignUp itself', () => {
    async function userWith(email: string, verified: boolean, banned = false) {
      const id = Bun.randomUUIDv7()
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
          identityId: Bun.randomUUIDv7(),
          credentialId: Bun.randomUUIDv7(),
          passwordHash: null,
        },
        (await import('~/modules/audit/service')).none('fixture')
      )
      if (banned) {
        await deps.users.setBanned(
          TENANT.environmentId,
          id,
          deps.clock.now(),
          deps.clock.now(),
          (await import('~/modules/audit/service')).none('fixture')
        )
      }
      return id
    }

    test('a verified row of a public domain joins nobody and suggests nothing', async () => {
      const org = await organization()
      const rowId = Bun.randomUUIDv7()
      const none = (await import('~/modules/audit/service')).none('fixture')
      await deps.organizationDomains.claim(
        {
          id: rowId,
          ...TENANT,
          organizationId: org.id,
          domain: 'gmail.com',
          mode: 'auto_join',
          codeHash: 'h',
          codeExpiresAt: new Date(deps.clock.now().getTime() + 60_000),
          at: deps.clock.now(),
          limit: 10,
        },
        none
      )
      await deps.organizationDomains.verify(
        TENANT.environmentId,
        org.id,
        rowId,
        'h',
        deps.clock.now(),
        new Date(deps.clock.now().getTime() + 86_400_000),
        none
      )
      const id = await userWith('lee@gmail.com', true)
      expect(await Domains.joinOnSignUp(deps, TENANT, id, systemActor())).toBe(false)
      expect((await Domains.suggestions(deps, TENANT, { userId: id })).data).toEqual([])
      await expect(
        Domains.joinSuggestion(deps, TENANT, { userId: id }, org.id, systemActor())
      ).rejects.toMatchObject({ code: 'organization.suggestion_unavailable' })
      await deps.organizationDomains.setMode(
        TENANT.environmentId,
        org.id,
        rowId,
        'suggest',
        deps.clock.now(),
        none
      )
      expect((await Domains.suggestions(deps, TENANT, { userId: id })).data).toEqual([])
    })

    test('an unverified address never counts', async () => {
      const org = await organization()
      await verifiedDomain(org.id, 'northline.app', 'auto_join')
      const id = await userWith('lee@northline.app', false)
      expect(await Domains.joinOnSignUp(deps, TENANT, id, systemActor())).toBe(false)
      expect(await deps.organizations.findMembership(TENANT.environmentId, org.id, id)).toBeNull()
      const list = await Domains.suggestions(deps, TENANT, { userId: id })
      expect(list.data).toEqual([])
      await expect(
        Domains.joinSuggestion(deps, TENANT, { userId: id }, org.id, systemActor())
      ).rejects.toMatchObject({ code: 'organization.suggestion_unavailable' })
    })

    test('a verified address joins; a second call finds them a member and joins nobody twice', async () => {
      const org = await organization()
      await verifiedDomain(org.id, 'northline.app', 'auto_join')
      const id = await userWith('lee@northline.app', true)
      expect(await Domains.joinOnSignUp(deps, TENANT, id, systemActor())).toBe(true)
      expect(await Domains.joinOnSignUp(deps, TENANT, id, systemActor())).toBe(false)
    })

    test('a banned user is not joined', async () => {
      const org = await organization()
      await verifiedDomain(org.id, 'northline.app', 'auto_join')
      const id = await userWith('lee@northline.app', true, true)
      expect(await Domains.joinOnSignUp(deps, TENANT, id, systemActor())).toBe(false)
    })

    test('an unknown default role never fails the sign-up and joins nobody', async () => {
      const org = await organization()
      await verifiedDomain(org.id, 'northline.app', 'auto_join')
      configure({ defaultRole: 'ghost' })
      const id = await userWith('lee@northline.app', true)
      expect(await Domains.joinOnSignUp(deps, TENANT, id, systemActor())).toBe(false)
    })

    test('a store that throws never fails the sign-up', async () => {
      const org = await organization()
      await verifiedDomain(org.id, 'northline.app', 'auto_join')
      const id = await userWith('lee@northline.app', true)
      const broken = {
        ...deps,
        organizations: {
          findRole: deps.organizations.findRole.bind(deps.organizations),
          ensureBuiltInRoles: deps.organizations.ensureBuiltInRoles.bind(deps.organizations),
          addMembership: async () => {
            throw new Error('database down')
          },
        },
      } as unknown as TestDeps
      expect(await Domains.joinOnSignUp(broken, TENANT, id, systemActor())).toBe(false)
    })
  })
})

describe('suggestions', () => {
  test('joining a suggestion makes the user a member with the default role and records it', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'suggest')
    const maya = await signedUp('maya@northline.app')
    const res = await client(
      'POST',
      `/me/organizations/suggestions/${org.id}/join`,
      undefined,
      maya.accessToken
    )
    expect(res.status).toBe(201)
    expect(await json<UserOrganization>(res)).toMatchObject({ id: org.id, role: 'member' })
    const entry = deps.activityLog.entries.find(
      (one) => one.type === 'organization_membership.added' && one.data.userId === maya.userId
    )
    expect(entry?.data.via).toBe('domain_suggestion')
    expect(entry?.actor).toMatchObject({ type: 'user', id: maya.userId })
    const again = await client(
      'POST',
      `/me/organizations/suggestions/${org.id}/join`,
      undefined,
      maya.accessToken
    )
    expect(again.status).toBe(409)
    expect(await codeOf(again)).toBe('organization.member_exists')
    const list = await json<OrganizationSuggestionList>(
      await client('GET', '/me/organizations/suggestions', undefined, maya.accessToken)
    )
    expect(list.data).toEqual([])
  })

  test('the server decides again: a removed domain, a changed address and a stranger are all unavailable', async () => {
    const org = await organization()
    const other = await organization('other')
    const done = await verifiedDomain(org.id, 'northline.app', 'suggest')
    const maya = await signedUp('maya@northline.app')
    const kai = await signedUp('kai@elsewhere.example')
    const join = (orgId: string, token: string) =>
      client('POST', `/me/organizations/suggestions/${orgId}/join`, undefined, token)
    for (const [orgId, token] of [
      [org.id, kai.accessToken],
      [other.id, maya.accessToken],
      [UNKNOWN, maya.accessToken],
    ] as const) {
      const res = await join(orgId, token)
      expect(res.status).toBe(403)
      expect(await codeOf(res)).toBe('organization.suggestion_unavailable')
    }
    await admin('DELETE', `/${org.id}/domains/${done.id}`)
    const gone = await join(org.id, maya.accessToken)
    expect(gone.status).toBe(403)
    expect(await codeOf(gone)).toBe('organization.suggestion_unavailable')
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, maya.userId)
    ).toBeNull()
  })

  test('an organization deleted after the list answers unavailable', async () => {
    const org = await organization()
    await verifiedDomain(org.id)
    const maya = await signedUp('maya@northline.app')
    await Organizations.remove(deps, TENANT, org.id, TEST_ACTOR)
    const res = await client(
      'POST',
      `/me/organizations/suggestions/${org.id}/join`,
      undefined,
      maya.accessToken
    )
    expect(res.status).toBe(403)
  })

  test('switched off, the routes answer organization.disabled; signed out, 401', async () => {
    const org = await organization()
    const maya = await signedUp('maya@northline.app')
    configure({ enabled: false })
    for (const [method, path] of [
      ['GET', '/me/organizations/suggestions'],
      ['POST', `/me/organizations/suggestions/${org.id}/join`],
    ] as const) {
      const res = await client(method, path, undefined, maya.accessToken)
      expect(res.status).toBe(403)
      expect(await codeOf(res)).toBe('organization.disabled')
    }
    configure()
    expect((await client('GET', '/me/organizations/suggestions')).status).toBe(401)
  })
})

describe('a member managing domains through the client routes', () => {
  async function members() {
    const org = await organization()
    const boss = await signedUp('boss@elsewhere.example')
    const staff = await signedUp('staff@elsewhere.example')
    const stranger = await signedUp('stranger@elsewhere.example')
    await Organizations.addMember(
      deps,
      TENANT,
      org.id,
      { userId: boss.userId, role: 'admin' },
      TEST_ACTOR
    )
    await Organizations.addMember(
      deps,
      TENANT,
      org.id,
      { userId: staff.userId, role: 'member' },
      TEST_ACTOR
    )
    return { org, boss, staff, stranger }
  }

  test('a holder of org:sys:domains:manage claims, verifies, changes and removes', async () => {
    const { org, boss } = await members()
    const started = await client(
      'POST',
      `/me/organizations/${org.id}/domains`,
      { domain: 'northline.app', email: 'ada@northline.app', mode: 'auto_join' },
      boss.accessToken
    )
    expect(started.status).toBe(201)
    const pending = await json<OrganizationDomain>(started)
    const verified = await client(
      'POST',
      `/me/organizations/${org.id}/domains/${pending.id}/verify`,
      { code: emailedCode() },
      boss.accessToken
    )
    expect(verified.status).toBe(200)
    const listed = await client(
      'GET',
      `/me/organizations/${org.id}/domains`,
      undefined,
      boss.accessToken
    )
    expect((await json<{ data: OrganizationDomain[] }>(listed)).data).toHaveLength(1)
    const patched = await client(
      'PATCH',
      `/me/organizations/${org.id}/domains/${pending.id}`,
      { mode: 'suggest' },
      boss.accessToken
    )
    expect((await json<OrganizationDomain>(patched)).mode).toBe('suggest')
    const removed = await client(
      'DELETE',
      `/me/organizations/${org.id}/domains/${pending.id}`,
      undefined,
      boss.accessToken
    )
    expect(removed.status).toBe(204)
    const entry = deps.activityLog.entries.find((one) => one.type === 'organization_domain.claimed')
    expect(entry?.actor).toMatchObject({ type: 'user', id: boss.userId })
  })

  test('a member without the permission is forbidden, a non-member and an unknown organization are not members', async () => {
    const { org, staff, stranger } = await members()
    const body = { domain: 'northline.app', email: 'ada@northline.app', mode: 'suggest' }
    const forbidden = await client(
      'POST',
      `/me/organizations/${org.id}/domains`,
      body,
      staff.accessToken
    )
    expect(forbidden.status).toBe(403)
    expect(await codeOf(forbidden)).toBe('auth.forbidden')
    for (const [orgId, token] of [
      [org.id, stranger.accessToken],
      [UNKNOWN, stranger.accessToken],
    ] as const) {
      const res = await client('POST', `/me/organizations/${orgId}/domains`, body, token)
      expect(res.status).toBe(403)
      expect(await codeOf(res)).toBe('organization.not_a_member')
    }
    expect(
      (await client('GET', `/me/organizations/${org.id}/domains`, undefined, staff.accessToken))
        .status
    ).toBe(403)
    expect(deps.mailer.outbox.filter((mail) => mail.to === 'ada@northline.app')).toHaveLength(0)
  })

  test('the permission is read from the role now: a demoted admin is refused at once', async () => {
    const { org, boss } = await members()
    const second = await signedUp('second@elsewhere.example')
    await Organizations.addMember(
      deps,
      TENANT,
      org.id,
      { userId: second.userId, role: 'admin' },
      TEST_ACTOR
    )
    await Organizations.changeMemberRole(
      deps,
      TENANT,
      org.id,
      boss.userId,
      { role: 'member' },
      TEST_ACTOR
    )
    const res = await client(
      'GET',
      `/me/organizations/${org.id}/domains`,
      undefined,
      boss.accessToken
    )
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('auth.forbidden')
  })

  test('a custom role with the permission may manage domains', async () => {
    const { org, staff } = await members()
    await deps.organizations.insertRole(
      {
        id: Bun.randomUUIDv7(),
        ...TENANT,
        key: 'domain_keeper',
        name: 'Domain keeper',
        permissions: ['org:sys:domains:manage'],
        builtIn: false,
        version: 1,
        createdAt: deps.clock.now(),
        updatedAt: deps.clock.now(),
      },
      (await import('~/modules/audit/service')).none('fixture')
    )
    await Organizations.changeMemberRole(
      deps,
      TENANT,
      org.id,
      staff.userId,
      { role: 'domain_keeper' },
      TEST_ACTOR
    )
    expect(
      (await client('GET', `/me/organizations/${org.id}/domains`, undefined, staff.accessToken))
        .status
    ).toBe(200)
  })

  test('brute-forcing the code through the client route hits the back-off', async () => {
    const { org, boss } = await members()
    const pending = await json<OrganizationDomain>(
      await client(
        'POST',
        `/me/organizations/${org.id}/domains`,
        { domain: 'northline.app', email: 'ada@northline.app', mode: 'suggest' },
        boss.accessToken
      )
    )
    const right = emailedCode()
    const wrong = right === '000000' ? '111111' : '000000'
    const statuses: number[] = []
    for (let i = 0; i < 7; i += 1) {
      const res = await client(
        'POST',
        `/me/organizations/${org.id}/domains/${pending.id}/verify`,
        { code: i === 6 ? right : wrong },
        boss.accessToken
      )
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 5)).toEqual([422, 422, 422, 422, 422])
    expect(statuses.slice(5)).toEqual([429, 429])
    expect(
      await deps.organizationDomains.findVerified(TENANT.environmentId, 'northline.app')
    ).toBeNull()
  })
})

// A verification has a lifetime (TULA-128, ADR 0065 "Lapse"): a domain can be lost and
// registered again by someone else, so a claim is believed for a year and then matches nobody
// until a manager proves it again.
describe('a verification lapses', () => {
  const inDays = (days: number) => deps.clock.advance(`${days}d`)

  async function userNamed(email: string) {
    const id = Bun.randomUUIDv7()
    const none = (await import('~/modules/audit/service')).none('fixture')
    await deps.users.create(
      {
        id,
        ...TENANT,
        email,
        emailNormalized: email,
        emailVerifiedAt: deps.clock.now(),
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: Bun.randomUUIDv7(),
        credentialId: Bun.randomUUIDv7(),
        passwordHash: null,
      },
      none
    )
    return id
  }

  const listed = async (orgId: string) =>
    (await json<{ data: OrganizationDomain[] }>(await admin('GET', `/${orgId}/domains`))).data

  test('a verified domain says when it lapses, a year after the code was entered', async () => {
    const org = await organization()
    const verifiedAt = deps.clock.now()
    const domain = await verifiedDomain(org.id)
    expect(domain.status).toBe('verified')
    expect(domain.expiresAt).toBe(new Date(verifiedAt.getTime() + 365 * 86_400_000).toISOString())
    deps.clock.advance('2m')
    const pending = await json<OrganizationDomain>(await claim(org.id, 'waiting.example'))
    expect(pending).toMatchObject({ status: 'pending', expiresAt: null })
  })

  test('a lapsed domain no longer auto-joins at sign-up (and one a minute short of it still does)', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'auto_join')
    deps.clock.advance('364d')
    deps.clock.advance('1438m')
    const early = await signedUp('early@northline.app')
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, early.userId)
    ).not.toBeNull()
    deps.clock.advance('3m')
    const late = await signedUp('late@northline.app')
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, late.userId)
    ).toBeNull()
    expect(
      deps.activityLog.entries.filter(
        (one) => one.type === 'organization_membership.added' && one.data.userId === late.userId
      )
    ).toEqual([])
  })

  test('a lapsed domain suggests nothing and its suggestion cannot be joined', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'suggest')
    const maya = await signedUp('maya@northline.app')
    const self = { userId: maya.userId }
    expect((await Domains.suggestions(deps, TENANT, self)).data).toHaveLength(1)
    inDays(366)
    expect((await Domains.suggestions(deps, TENANT, self)).data).toEqual([])
    await expect(
      Domains.joinSuggestion(deps, TENANT, self, org.id, systemActor())
    ).rejects.toMatchObject({ code: 'organization.suggestion_unavailable' })
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, maya.userId)
    ).toBeNull()
  })

  test('joinOnSignUp of a user on a lapsed domain joins nobody', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'auto_join')
    const id = await userNamed('ada@northline.app')
    inDays(366)
    expect(await Domains.joinOnSignUp(deps, TENANT, id, systemActor())).toBe(false)
  })

  test('the list says needs_reverification once it has lapsed, and the row is kept', async () => {
    const org = await organization()
    await verifiedDomain(org.id)
    inDays(366)
    const [row] = await listed(org.id)
    expect(row).toMatchObject({ domain: 'northline.app', status: 'needs_reverification' })
    expect(row?.verifiedAt).not.toBeNull()
  })

  test('a lapsed domain has no code to enter: it is expired until a new code is asked for', async () => {
    const org = await organization()
    const domain = await verifiedDomain(org.id)
    inDays(366)
    const res = await admin('POST', `/${org.id}/domains/${domain.id}/verify`, { code: '123456' })
    expect(await codeOf(res)).toBe('verification.expired')
  })

  test('proving the domain again restores it and restarts the year', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'auto_join')
    inDays(366)
    const asked = await claim(org.id, 'northline.app', 'suggest')
    expect(asked.status).toBe(201)
    const again = await json<OrganizationDomain>(asked)
    // Still lapsed until the code is entered, and asking does not change the mode.
    expect(again).toMatchObject({ status: 'needs_reverification', mode: 'auto_join' })
    expect(again.codeExpiresAt).not.toBeNull()
    const code = emailedCode()
    const before = await signedUp('before@northline.app')
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, before.userId)
    ).toBeNull()

    const res = await admin('POST', `/${org.id}/domains/${again.id}/verify`, { code })
    expect(res.status).toBe(200)
    const restored = await json<OrganizationDomain>(res)
    expect(restored).toMatchObject({ id: again.id, status: 'verified', codeExpiresAt: null })
    expect(restored.expiresAt).toBe(
      new Date(deps.clock.now().getTime() + 365 * 86_400_000).toISOString()
    )
    const joined = await signedUp('after@northline.app')
    expect(
      (await deps.organizations.findMembership(TENANT.environmentId, org.id, joined.userId))
        ?.roleKey
    ).toBe('member')
    const entry = deps.activityLog.entries.findLast(
      (one) => one.type === 'organization_domain.verified'
    )
    expect(entry?.data).toMatchObject({ reverified: true, weakened: true })
    expect(EVENT_DATA_SCHEMAS['organization_domain.verified'].safeParse(entry?.data).success).toBe(
      true
    )
  })

  test('while a manager proves a domain that has not lapsed it keeps matching, and it still lapses on its date', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'auto_join')
    inDays(340)
    expect((await claim(org.id, 'northline.app')).status).toBe(201)
    const maya = await signedUp('maya@northline.app')
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, org.id, maya.userId)
    ).not.toBeNull()
    inDays(30)
    expect((await listed(org.id))[0]?.status).toBe('needs_reverification')
  })

  test('a wrong code for a re-verification counts and does not change the domain', async () => {
    const org = await organization()
    const domain = await verifiedDomain(org.id)
    inDays(340)
    await claim(org.id)
    const wrong = emailedCode() === '000000' ? '111111' : '000000'
    const res = await admin('POST', `/${org.id}/domains/${domain.id}/verify`, { code: wrong })
    expect(res.status).toBe(422)
    expect(await codeOf(res)).toBe('verification.invalid_code')
    expect((await listed(org.id))[0]?.expiresAt).toBe(domain.expiresAt)
  })

  test('asking for a code for a verified domain does not change its mode (that is a weakening of its own)', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'suggest')
    deps.clock.advance('2m')
    const res = await claim(org.id, 'northline.app', 'auto_join')
    expect(res.status).toBe(201)
    expect((await json<OrganizationDomain>(res)).mode).toBe('suggest')
    const entry = deps.activityLog.entries.findLast(
      (one) => one.type === 'organization_domain.claimed'
    )
    expect(entry?.data).toMatchObject({ mode: 'suggest' })
  })

  test('another organization cannot claim a domain until its verification has lapsed; then it takes it', async () => {
    const one = await organization('one')
    const two = await organization('two')
    await verifiedDomain(one.id, 'northline.app', 'auto_join')
    const member = await signedUp('old@northline.app')
    inDays(300)
    expect(await codeOf(await claim(two.id))).toBe('organization.domain_taken')
    inDays(66)
    const started = await claim(two.id)
    expect(started.status).toBe(201)
    const pending = await json<OrganizationDomain>(started)
    const res = await admin('POST', `/${two.id}/domains/${pending.id}/verify`, {
      code: emailedCode(),
    })
    expect(res.status).toBe(200)
    // The lapsed row is gone (recorded); its members stay members.
    expect(await listed(one.id)).toEqual([])
    expect(
      deps.activityLog.entries.some(
        (entry) =>
          entry.type === 'organization_domain.removed' && entry.data.organizationId === one.id
      )
    ).toBe(true)
    expect(
      await deps.organizations.findMembership(TENANT.environmentId, one.id, member.userId)
    ).not.toBeNull()
    expect(
      (await deps.organizationDomains.findVerified(TENANT.environmentId, 'northline.app'))
        ?.organizationId
    ).toBe(two.id)
  })

  test('lapsed is a decision about the date alone: the instant it passes, and a missing date', async () => {
    const org = await organization()
    await verifiedDomain(org.id, 'northline.app', 'auto_join')
    const row = await deps.organizationDomains.findVerified(TENANT.environmentId, 'northline.app')
    if (!row?.expiresAt) {
      throw new Error('a verified row has an expiry')
    }
    expect(Domains.lapsed(row, new Date(row.expiresAt.getTime() - 1))).toBe(false)
    expect(Domains.lapsed(row, row.expiresAt)).toBe(true)
    // Not a state the database allows; unknown is never trusted.
    expect(Domains.statusOf({ ...row, expiresAt: null }, deps.clock.now())).toBe(
      'needs_reverification'
    )
  })
})

describe('the fairness of the environment’s allowance of codes', () => {
  async function userOrganization(userId: string, slug: string) {
    configure({ allowUserCreated: true, maxCreatedPerUser: 5 })
    return MeOrganizations.create(
      deps,
      TENANT,
      { userId },
      { name: `Org ${slug}`, slug },
      TEST_ACTOR
    )
  }

  test('an organization a user created sends fewer codes a day than one an administrator made', async () => {
    const user = await signedUp('maker@elsewhere.example')
    const mine = await userOrganization(user.userId, 'mine')
    const theirs = await organization('theirs')
    expect(Domains.CODES_PER_USER_ORGANIZATION_PER_DAY).toBeLessThan(
      Domains.CODES_PER_ORGANIZATION_PER_DAY
    )
    for (let i = 0; i < Domains.CODES_PER_USER_ORGANIZATION_PER_DAY; i += 1) {
      for (const [org, limit] of [
        [mine.id, Domains.CODES_PER_USER_ORGANIZATION_PER_DAY],
        [theirs.id, Domains.CODES_PER_ORGANIZATION_PER_DAY],
      ] as const) {
        await deps.rateLimiter.hit(
          `organization_domain_day:${TENANT.environmentId}:${org}`,
          limit,
          86_400_000
        )
      }
    }
    expect((await claim(mine.id)).status).toBe(429)
    expect((await claim(theirs.id, 'theirs.example')).status).toBe(201)
  })

  test('one user’s organizations share one daily allowance, so they cannot spend the environment’s', async () => {
    const user = await signedUp('maker@elsewhere.example')
    const orgs = [
      await userOrganization(user.userId, 'one'),
      await userOrganization(user.userId, 'two'),
      await userOrganization(user.userId, 'three'),
    ]
    const before = deps.mailer.outbox.length
    let sent = 0
    for (let round = 0; round < Domains.CODES_PER_USER_ORGANIZATION_PER_DAY; round += 1) {
      for (const [index, org] of orgs.entries()) {
        deps.clock.advance('61s')
        const res = await claim(org.id, 'northline.app', 'suggest', `p${round}x${index}`)
        if (res.status === 201) {
          sent += 1
        } else {
          expect(res.status).toBe(429)
        }
      }
    }
    expect(sent).toBe(Domains.CODES_PER_CREATOR_PER_DAY)
    expect(deps.mailer.outbox).toHaveLength(before + Domains.CODES_PER_CREATOR_PER_DAY)
    // Another creator's organization is not held up.
    const other = await signedUp('other@elsewhere.example')
    const theirs = await userOrganization(other.userId, 'theirs')
    deps.clock.advance('61s')
    expect((await claim(theirs.id, 'theirs.example')).status).toBe(201)
  })

  test('the creator’s allowance is per day: it comes back', async () => {
    const user = await signedUp('maker@elsewhere.example')
    const mine = await userOrganization(user.userId, 'mine')
    for (let i = 0; i < Domains.CODES_PER_CREATOR_PER_DAY; i += 1) {
      await deps.rateLimiter.hit(
        `organization_domain_creator_day:${TENANT.environmentId}:${user.userId}`,
        Domains.CODES_PER_CREATOR_PER_DAY,
        86_400_000
      )
    }
    expect((await claim(mine.id)).status).toBe(429)
    deps.clock.advance('25h')
    expect((await claim(mine.id)).status).toBe(201)
  })

  test('an organization an administrator made is not held to a creator’s allowance', async () => {
    const org = await organization('admin-made')
    for (let i = 0; i < Domains.CODES_PER_CREATOR_PER_DAY + 1; i += 1) {
      // Seven minutes apart: past the minute's cooldown, under the hour's ten.
      deps.clock.advance('7m')
      expect((await claim(org.id, 'northline.app', 'suggest', `p${i}`)).status).toBe(201)
    }
  })
})

describe('probing for claimed domains', () => {
  test('each answer that a name is claimed elsewhere spends the organization’s hourly allowance', async () => {
    const holder = await organization('holder')
    const prober = await organization('prober')
    await verifiedDomain(holder.id)
    const sentBefore = deps.mailer.outbox.length
    for (let i = 0; i < Domains.CODES_PER_ORGANIZATION_PER_HOUR; i += 1) {
      const res = await claim(prober.id)
      expect(res.status).toBe(409)
      expect(await codeOf(res)).toBe('organization.domain_taken')
    }
    expect((await claim(prober.id)).status).toBe(429)
    // The allowance is the organization's own and an hour long: it comes back.
    deps.clock.advance('61m')
    expect(await codeOf(await claim(prober.id))).toBe('organization.domain_taken')
    expect(deps.mailer.outbox).toHaveLength(sentBefore)
  })

  test('probing leaves another organization’s allowance alone', async () => {
    const holder = await organization('holder')
    const prober = await organization('prober')
    const honest = await organization('honest')
    await verifiedDomain(holder.id)
    for (let i = 0; i < Domains.CODES_PER_ORGANIZATION_PER_HOUR; i += 1) {
      await claim(prober.id)
    }
    expect((await claim(honest.id, 'honest.example')).status).toBe(201)
  })

  test('a name that is free, or the organization’s own, is not a probe', async () => {
    const org = await organization('own')
    await verifiedDomain(org.id)
    for (let i = 0; i < Domains.CODES_PER_ORGANIZATION_PER_HOUR - 2; i += 1) {
      deps.clock.advance('61s')
      expect((await claim(org.id, 'northline.app', 'suggest', `p${i}`)).status).toBe(201)
    }
  })
})

describe('the reminder that a verification is about to lapse', () => {
  async function managed() {
    const org = await organization()
    const boss = await signedUp('boss@elsewhere.example')
    const staff = await signedUp('staff@elsewhere.example')
    await Organizations.addMember(
      deps,
      TENANT,
      org.id,
      { userId: boss.userId, role: 'admin' },
      TEST_ACTOR
    )
    await Organizations.addMember(
      deps,
      TENANT,
      org.id,
      { userId: staff.userId, role: 'member' },
      TEST_ACTOR
    )
    return { org, boss, staff }
  }
  const reminders = () =>
    deps.mailer.outbox.filter((mail) => mail.subject.startsWith('Domain verification'))

  test('the managers are emailed once at 30 days and once at 7, and nobody else', async () => {
    const { org } = await managed()
    await verifiedDomain(org.id)
    deps.clock.advance('334d')
    expect((await Reminders.remind(deps)).emails).toBe(0)
    deps.clock.advance('1d')
    expect(await Reminders.remind(deps)).toMatchObject({ emails: 1, domains: 1, failed: 0 })
    expect(reminders().map((mail) => mail.to)).toEqual(['boss@elsewhere.example'])
    // Once: the same threshold is not sent again, however often the job runs.
    await Reminders.remind(deps)
    await Reminders.remind(deps)
    expect(reminders()).toHaveLength(1)
    deps.clock.advance('10d')
    await Reminders.remind(deps)
    expect(reminders()).toHaveLength(1)
    deps.clock.advance('13d')
    expect((await Reminders.remind(deps)).emails).toBe(1)
    expect(reminders()).toHaveLength(2)
    await Reminders.remind(deps)
    deps.clock.advance('3d')
    await Reminders.remind(deps)
    expect(reminders()).toHaveLength(2)
    // Past the lapse there is nothing to warn about.
    deps.clock.advance('10d')
    await Reminders.remind(deps)
    expect(reminders()).toHaveLength(2)
  })

  test('it carries no code and no link, names no domain, and its subject does not lead with a digit', async () => {
    const { org } = await managed()
    await verifiedDomain(org.id)
    deps.clock.advance('336d')
    await Reminders.remind(deps)
    const [mail] = reminders()
    expect(mail).toBeDefined()
    for (const part of [mail?.subject ?? '', mail?.text ?? '', mail?.html ?? '']) {
      expect(part).not.toMatch(/\d{6}/)
      expect(part).not.toMatch(/https?:|href=|www\./)
      expect(part).not.toContain('northline.app')
    }
    expect(mail?.subject).toMatch(/^\D/)
    expect(mail?.text).toContain('within 30 days')
  })

  test('one email covers several domains, and a domain first seen late gets the 7-day one alone', async () => {
    const { org } = await managed()
    await verifiedDomain(org.id, 'northline.app')
    deps.clock.advance('2m')
    await verifiedDomain(org.id, 'northline.example')
    deps.clock.advance('359d')
    await Reminders.remind(deps)
    expect(reminders()).toHaveLength(1)
    expect(reminders()[0]?.text).toContain('2 verified domains')
    expect(reminders()[0]?.text).toContain('within 7 days')
  })

  test('verifying again starts the series over', async () => {
    const { org } = await managed()
    await verifiedDomain(org.id)
    deps.clock.advance('336d')
    await Reminders.remind(deps)
    expect(reminders()).toHaveLength(1)
    deps.clock.advance('2m')
    expect((await claim(org.id)).status).toBe(201)
    const [row] = (
      await json<{ data: OrganizationDomain[] }>(await admin('GET', `/${org.id}/domains`))
    ).data
    expect(
      (await admin('POST', `/${org.id}/domains/${row?.id}/verify`, { code: emailedCode() })).status
    ).toBe(200)
    deps.clock.advance('336d')
    await Reminders.remind(deps)
    expect(reminders()).toHaveLength(2)
  })

  test('a banned manager and a member without the permission are not emailed', async () => {
    const { org, boss } = await managed()
    await verifiedDomain(org.id)
    await deps.users.setBanned(
      TENANT.environmentId,
      boss.userId,
      deps.clock.now(),
      deps.clock.now(),
      (await import('~/modules/audit/service')).none('fixture')
    )
    deps.clock.advance('336d')
    expect((await Reminders.remind(deps)).emails).toBe(0)
    expect(reminders()).toHaveLength(0)
  })

  test('a mailer that fails gives the reminder back, and the next run sends it', async () => {
    const { org } = await managed()
    await verifiedDomain(org.id)
    deps.clock.advance('336d')
    const send = spyOn(deps.mailer, 'send').mockRejectedValueOnce(new Error('relay down'))
    expect(await Reminders.remind(deps)).toMatchObject({ emails: 0, retried: 1 })
    send.mockRestore()
    expect((await Reminders.remind(deps)).emails).toBe(1)
    expect(reminders()).toHaveLength(1)
  })

  test('organizations switched off: no reminder is taken or sent', async () => {
    const { org } = await managed()
    await verifiedDomain(org.id)
    configure({ enabled: false })
    deps.clock.advance('336d')
    expect(await Reminders.remind(deps)).toMatchObject({ emails: 0, domains: 0 })
    configure()
    expect((await Reminders.remind(deps)).emails).toBe(1)
  })

  test('the environment’s daily allowance of reminders holds, and what it refused is sent the next day', async () => {
    const { org } = await managed()
    await verifiedDomain(org.id)
    deps.clock.advance('336d')
    for (let i = 0; i < Reminders.REMINDERS_PER_ENVIRONMENT_PER_DAY; i += 1) {
      await deps.rateLimiter.hit(
        `organization_domain_reminders:${TENANT.environmentId}`,
        Reminders.REMINDERS_PER_ENVIRONMENT_PER_DAY,
        86_400_000
      )
    }
    expect(await Reminders.remind(deps)).toMatchObject({ emails: 0, retried: 1 })
    deps.clock.advance('25h')
    expect((await Reminders.remind(deps)).emails).toBe(1)
  })

  test('run takes the job lock, and does nothing where another instance holds it', async () => {
    const { org } = await managed()
    await verifiedDomain(org.id)
    deps.clock.advance('336d')
    const outcome = await deps.jobLock.runExclusive('domain_reminders', () => Reminders.run(deps))
    expect(outcome).toEqual({ ran: true, value: null })
    expect(await Reminders.run(deps)).toMatchObject({ emails: 1 })
  })
})
