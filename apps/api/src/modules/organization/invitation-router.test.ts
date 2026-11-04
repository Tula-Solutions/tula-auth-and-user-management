import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type AcceptedInvitation,
  type CurrentUser,
  DEFAULT_ENVIRONMENT_SETTINGS,
  EVENT_SCHEMAS,
  type FlowAttempt,
  INVITATION_EXPIRY_DAYS,
  type InvitationPreview,
  type MyOrganizationInvitationList,
  type Organization,
  type OrganizationInvitation,
  type OrganizationInvitationList,
  type OrganizationMembershipList,
  type HybridSessionTokens as SessionTokens,
} from '@tula-tech/contract'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import {
  INVITATIONS_READ_RATE_LIMIT,
  INVITATIONS_WRITE_RATE_LIMIT,
} from '~/modules/organization/invitation-me-router'
import * as Invitations from '~/modules/organization/invitation-service'
import * as Organizations from '~/modules/organization/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const PK_B = 'tula_pk_dev_publishableb000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'
const TENANT_A = { ...TEST_TENANT, apiKeyId: 'key_1' }
const TENANT_B = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.productionEnvironmentId,
}
const PASSWORD = 'correct horse battery staple'
const ORIGIN = 'https://app.northline.test'
const JOIN = 'https://app.northline.test/join'
const UNKNOWN = '00000000-0000-7000-8000-00000000dead'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let revision = 0

function configure(
  organizations: Record<string, unknown> = {},
  environmentId: string = TEST_TENANT.environmentId
) {
  revision += 1
  deps.environmentSettings.seed(environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      signIn: {
        methods: {
          password: { enabled: true },
          emailCode: { enabled: true },
          emailLink: { enabled: false },
          passkey: { enabled: false },
          smsCode: { enabled: false },
        },
      },
      urls: { allowedOrigins: [ORIGIN], allowedRedirectUrls: [JOIN, 'myapp://join'] },
      organizations: {
        ...DEFAULT_ENVIRONMENT_SETTINGS.organizations,
        enabled: true,
        allowUserCreated: true,
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
    [TENANT_B.environmentId, 'production'],
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
  await seedApiKey(deps, PK_B, TENANT_B)
  configure()
  configure({}, TENANT_B.environmentId)
  app = createApp(deps)
})

const json = async <T>(res: Response) => (await res.json()) as T
const codeOf = async (res: Response) => (await json<{ code: string }>(res)).code

/** An admin call, with a secret key unless told otherwise. */
function admin(method: string, path: string, body?: unknown, key: string | null = SK) {
  return app.request(`/v1/admin/organizations${path}`, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

interface CallOptions {
  token?: string
  key?: string | null
  ip?: string
  secret?: string
}

/** A client call, as a native app would make it. */
function client(method: string, path: string, body?: unknown, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-client': 'ios',
    origin: ORIGIN,
  }
  if (options.key !== null) {
    headers['x-tula-publishable-key'] = options.key ?? PK
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  if (options.secret) {
    headers['x-tula-attempt'] = options.secret
  }
  if (options.ip) {
    headers['x-forwarded-for'] = options.ip
  }
  return app.request(`/v1/client${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const emailedCode = () =>
  /^(\d{6}) /.exec(
    deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))?.subject ?? ''
  )?.[1] ?? ''

async function signUp(email = 'maya@northline.app'): Promise<SessionTokens & { userId: string }> {
  const started = await json<FlowAttempt>(
    await client('POST', '/sign-ups', { email, password: PASSWORD })
  )
  const done = await json<FlowAttempt>(
    await client(
      'POST',
      `/sign-ups/${started.id}/verify-email`,
      { code: emailedCode() },
      { secret: started.attemptSecret }
    )
  )
  const session = done.session as SessionTokens
  const user = await json<CurrentUser>(
    await client('GET', '/me', undefined, { token: session.accessToken })
  )
  return { ...session, userId: user.id }
}

async function makeOrganization(slug = 'acme', name = 'Acme Corp'): Promise<Organization> {
  const res = await admin('POST', '', { name, slug })
  expect(res.status).toBe(201)
  return json<Organization>(res)
}

/** Put a user in an organization with a role, as the operator. */
async function join(org: Organization, userId: string, role: string) {
  await Organizations.addMember(deps, TENANT_A, org.id, { userId, role }, TEST_ACTOR)
}

async function defineRole(key: string, permissions: string[]) {
  const res = await app.request('/v1/admin/organization-roles', {
    method: 'POST',
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key, name: key, permissions }),
  })
  expect(res.status).toBe(201)
}

const invitationMails = () =>
  deps.mailer.outbox.filter(
    (mail) => mail.subject.startsWith('You’re invited') || /invited to join/.test(mail.subject)
  )

/** The token in the newest invitation email's link fragment. */
function tokenOfLastInvitation(): string {
  const mail = invitationMails().at(-1)
  const token = /#tula_invitation=([^\s"&<]+)/.exec(mail?.text ?? '')?.[1]
  if (!token) {
    throw new Error('no invitation email with a link was sent')
  }
  return decodeURIComponent(token)
}

const inviteBody = (overrides: Record<string, unknown> = {}) => ({
  email: 'ada@northline.app',
  role: 'member',
  redirectUrl: JOIN,
  ...overrides,
})

const invite = (org: Organization, overrides: Record<string, unknown> = {}, key = SK) =>
  admin('POST', `/${org.id}/invitations`, inviteBody(overrides), key)

async function invited(org: Organization, overrides: Record<string, unknown> = {}) {
  const res = await invite(org, overrides)
  expect(res.status).toBe(201)
  return json<OrganizationInvitation>(res)
}

const accept = (token: string, tokenString: string) =>
  client('POST', '/me/organization-invitations/accept', { token: tokenString }, { token })
const decline = (token: string, tokenString: string) =>
  client('POST', '/me/organization-invitations/decline', { token: tokenString }, { token })
const preview = (tokenString: string, options: CallOptions = {}) =>
  client('POST', '/organization-invitations/preview', { token: tokenString }, options)

const invitationTypes = () =>
  deps.activityLog.entries
    .filter((entry) => entry.type.startsWith('organization_invitation'))
    .map((entry) => entry.type)

describe('organizations switched off', () => {
  test('every invitation route answers organization.disabled and touches nothing', async () => {
    const maya = await signUp()
    const org = await makeOrganization()
    await join(org, maya.userId, 'admin')
    const sent = await invited(org)
    const token = tokenOfLastInvitation()
    configure({ enabled: false })
    const before = deps.activityLog.entries.length
    const mails = deps.mailer.outbox.length
    const calls = [
      await admin('GET', `/${org.id}/invitations`),
      await invite(org, { email: 'bo@northline.app' }),
      await admin('DELETE', `/${org.id}/invitations/${sent.id}`),
      await client('GET', `/me/organizations/${org.id}/invitations`, undefined, {
        token: maya.accessToken,
      }),
      await client(
        'POST',
        `/me/organizations/${org.id}/invitations`,
        inviteBody({ email: 'bo@northline.app' }),
        { token: maya.accessToken }
      ),
      await client('DELETE', `/me/organizations/${org.id}/invitations/${sent.id}`, undefined, {
        token: maya.accessToken,
      }),
      await preview(token),
      await accept(maya.accessToken, token),
      await decline(maya.accessToken, token),
    ]
    for (const res of calls) {
      expect(res.status).toBe(403)
      expect(await codeOf(res)).toBe('organization.disabled')
    }
    expect(deps.activityLog.entries).toHaveLength(before)
    expect(deps.mailer.outbox).toHaveLength(mails)
    expect(
      (await deps.organizations.findInvitation(TEST_TENANT.environmentId, org.id, sent.id))?.status
    ).toBe('pending')
  })
})

describe('the admin routes', () => {
  test.each([
    ['GET', '', undefined],
    ['POST', '', inviteBody()],
    ['DELETE', `/${UNKNOWN}`, undefined],
  ])('%s needs a secret key', async (method, suffix, body) => {
    const org = await makeOrganization()
    const path = `/${org.id}/invitations${suffix}`
    expect((await admin(method, path, body, null)).status).toBe(401)
    expect((await admin(method, path, body, PK)).status).toBe(401)
  })

  test('an agent key reads and is refused every write', async () => {
    const org = await makeOrganization()
    const sent = await invited(org)
    const read = await admin('GET', `/${org.id}/invitations`, undefined, AK)
    expect(read.status).toBe(200)
    const before = deps.mailer.outbox.length
    for (const res of [
      await invite(org, { email: 'bo@northline.app' }, AK),
      await admin('DELETE', `/${org.id}/invitations/${sent.id}`, undefined, AK),
    ]) {
      expect(res.status).toBe(401)
    }
    expect(deps.mailer.outbox).toHaveLength(before)
    expect(
      (await deps.organizations.findInvitation(TEST_TENANT.environmentId, org.id, sent.id))?.status
    ).toBe('pending')
  })

  test('invites an address: the invitation, the email with the link, and the record', async () => {
    const org = await makeOrganization('acme', 'Acme <Corp> & Sons')
    const res = await invite(org, { email: ' Ada@Northline.app ' })
    expect(res.status).toBe(201)
    const body = await json<OrganizationInvitation>(res)
    expect(body).toEqual({
      id: expect.any(String),
      organizationId: org.id,
      email: 'Ada@Northline.app',
      role: 'member',
      status: 'pending',
      invitedBy: null,
      expiresAt: new Date(
        deps.clock.now().getTime() + INVITATION_EXPIRY_DAYS * 24 * 3600 * 1000
      ).toISOString(),
      createdAt: deps.clock.now().toISOString(),
    })
    // The response never carries the token.
    const token = tokenOfLastInvitation()
    expect(JSON.stringify(body)).not.toContain(token)
    const mail = invitationMails().at(-1)
    expect(mail?.to).toBe('Ada@Northline.app')
    expect(mail?.text).toContain(`${JOIN}#tula_invitation=`)
    // The organization's name is escaped in the HTML and never breaks out of it.
    expect(mail?.html).toContain('Acme &lt;Corp&gt; &amp; Sons')
    expect(mail?.html).not.toContain('<Corp>')
    // Only the hash is stored.
    const stored = await deps.organizations.findInvitationByTokenHash(
      TEST_TENANT.environmentId,
      new Bun.CryptoHasher('sha256').update(token).digest('hex')
    )
    expect(stored?.id).toBe(body.id)
    expect(JSON.stringify(stored)).not.toContain(token)
  })

  test('records the creation with ids and the role key, never the address or the token', async () => {
    const org = await makeOrganization()
    const sent = await invited(org)
    const token = tokenOfLastInvitation()
    const entry = deps.activityLog.entries.find(
      (one) => one.type === 'organization_invitation.created'
    )
    expect(entry?.actor.type).toBe('admin')
    expect(entry?.target).toEqual({ type: 'organization_invitation', id: sent.id })
    expect(entry?.data).toEqual({ organizationId: org.id, role: 'member' })
    const parsed = EVENT_SCHEMAS['organization_invitation.created'].safeParse({
      id: entry?.id,
      type: entry?.type,
      schemaVersion: 1,
      occurredAt: entry?.occurredAt.toISOString(),
      actor: entry?.actor,
      target: entry?.target,
      data: entry?.data,
    })
    expect(parsed.success).toBe(true)
    const everything = JSON.stringify(deps.activityLog.entries)
    expect(everything).not.toContain('ada@northline.app')
    expect(everything).not.toContain(token)
  })

  test.each([
    ['an address that is not one', { email: 'nobody' }, 422, 'email.invalid'],
    ['no role', { role: undefined }, 422, 'validation.failed'],
    ['a role that does not exist', { role: 'ghost' }, 422, 'organization.role_unknown'],
    [
      'a redirect URL the environment does not allow',
      { redirectUrl: 'https://evil.example/join' },
      400,
      'request.redirect_not_allowed',
    ],
    [
      'a custom scheme, even an allowed one',
      { redirectUrl: 'myapp://join' },
      400,
      'request.redirect_not_allowed',
    ],
  ])('refuses %s and sends nothing', async (_, overrides, status, code) => {
    const org = await makeOrganization()
    const res = await invite(org, overrides)
    expect(res.status).toBe(status)
    expect(await codeOf(res)).toBe(code)
    expect(invitationMails()).toHaveLength(0)
    expect(invitationTypes()).toHaveLength(0)
  })

  test('refuses an address that is a member already, and one invited twice', async () => {
    const maya = await signUp('ada@northline.app')
    const org = await makeOrganization()
    await join(org, maya.userId, 'member')
    const member = await invite(org)
    expect(member.status).toBe(409)
    expect(await codeOf(member)).toBe('organization.member_exists')
    const bo = await invite(org, { email: 'bo@northline.app' })
    expect(bo.status).toBe(201)
    const again = await invite(org, { email: ' BO@northline.app' })
    expect(again.status).toBe(409)
    expect(await codeOf(again)).toBe('organization.invitation_exists')
    expect(invitationMails()).toHaveLength(1)
  })

  test('an organization of another environment is not found', async () => {
    const org = await makeOrganization()
    const res = await app.request(`/v1/admin/organizations/${org.id}/invitations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await productionSecret()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(inviteBody()),
    })
    expect(res.status).toBe(404)
    expect((await admin('GET', `/${UNKNOWN}/invitations`)).status).toBe(404)
    expect((await invite({ ...org, id: UNKNOWN })).status).toBe(404)
    expect(invitationMails()).toHaveLength(0)
  })

  test('a lapsed invitation is replaced by a new one for the same address', async () => {
    const org = await makeOrganization()
    const first = await invited(org)
    deps.clock.advance(`${INVITATION_EXPIRY_DAYS}d`)
    const second = await invited(org)
    expect(second.id).not.toBe(first.id)
    expect(
      await deps.organizations.findInvitation(TEST_TENANT.environmentId, org.id, first.id)
    ).toBeNull()
  })

  test('a failed send withdraws the invitation, logs no link and lets a retry through', async () => {
    const org = await makeOrganization()
    const warn = spyOn(logger, 'warn')
    deps.mailer.failing = true
    const failed = await invite(org)
    expect(failed.status).toBeGreaterThanOrEqual(500)
    deps.mailer.failing = false
    expect(invitationTypes()).toEqual([
      'organization_invitation.created',
      'organization_invitation.revoked',
    ])
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('tula_invitation')
    expect(logged).not.toContain('ada@northline.app')
    warn.mockRestore()
    expect((await invite(org)).status).toBe(201)
  })

  test('lists by state, newest first, a page at a time, without tokens', async () => {
    const org = await makeOrganization()
    const first = await invited(org, { email: 'a@northline.app' })
    deps.clock.advance('1s')
    const second = await invited(org, { email: 'b@northline.app' })
    deps.clock.advance('1s')
    const third = await invited(org, { email: 'c@northline.app' })
    await admin('DELETE', `/${org.id}/invitations/${third.id}`)
    const pending = await json<OrganizationInvitationList>(
      await admin('GET', `/${org.id}/invitations`)
    )
    expect(pending.data.map((one) => one.id)).toEqual([second.id, first.id])
    expect(pending.meta.totalCount).toBe(2)
    const paged = await json<OrganizationInvitationList>(
      await admin('GET', `/${org.id}/invitations?size=1&page=2`)
    )
    expect(paged.data.map((one) => one.id)).toEqual([first.id])
    const revoked = await json<OrganizationInvitationList>(
      await admin('GET', `/${org.id}/invitations?status=revoked`)
    )
    expect(revoked.data.map((one) => [one.id, one.status])).toEqual([[third.id, 'revoked']])
    deps.clock.advance(`${INVITATION_EXPIRY_DAYS}d`)
    const expired = await json<OrganizationInvitationList>(
      await admin('GET', `/${org.id}/invitations?status=expired`)
    )
    expect(expired.data.map((one) => one.status)).toEqual(['expired', 'expired'])
    expect(expired.data.map((one) => one.id)).toEqual([second.id, first.id])
    expect((await admin('GET', `/${org.id}/invitations?status=bogus`)).status).toBe(422)
    expect((await admin('GET', `/${org.id}/invitations?size=0`)).status).toBe(422)
    expect(JSON.stringify([pending, paged, revoked, expired])).not.toContain('tokenHash')
  })

  test('revokes an invitation, once: its link stops working and the second revoke says so', async () => {
    const maya = await signUp('ada@northline.app')
    const org = await makeOrganization()
    const sent = await invited(org)
    const token = tokenOfLastInvitation()
    expect((await admin('DELETE', `/${org.id}/invitations/${sent.id}`)).status).toBe(204)
    expect(invitationTypes()).toEqual([
      'organization_invitation.created',
      'organization_invitation.revoked',
    ])
    const again = await admin('DELETE', `/${org.id}/invitations/${sent.id}`)
    expect(again.status).toBe(410)
    expect(await codeOf(again)).toBe('organization.invitation_revoked')
    const used = await accept(maya.accessToken, token)
    expect(used.status).toBe(410)
    expect(await codeOf(used)).toBe('organization.invitation_revoked')
    expect((await preview(token)).status).toBe(410)
    expect(invitationTypes()).toHaveLength(2)
  })

  test('refuses to revoke one that was used or has lapsed, and one that is not found', async () => {
    const maya = await signUp('ada@northline.app')
    const org = await makeOrganization()
    const used = await invited(org)
    expect((await accept(maya.accessToken, tokenOfLastInvitation())).status).toBe(200)
    const usedRes = await admin('DELETE', `/${org.id}/invitations/${used.id}`)
    expect(usedRes.status).toBe(410)
    expect(await codeOf(usedRes)).toBe('organization.invitation_used')
    const other = await makeOrganization('other')
    const lapsed = await invited(other, { email: 'bo@northline.app' })
    deps.clock.advance(`${INVITATION_EXPIRY_DAYS}d`)
    const lapsedRes = await admin('DELETE', `/${other.id}/invitations/${lapsed.id}`)
    expect(lapsedRes.status).toBe(410)
    expect(await codeOf(lapsedRes)).toBe('organization.invitation_expired')
    expect((await admin('DELETE', `/${other.id}/invitations/${UNKNOWN}`)).status).toBe(404)
    // An invitation is found through its own organization only.
    expect((await admin('DELETE', `/${org.id}/invitations/${lapsed.id}`)).status).toBe(404)
    expect((await admin('DELETE', `/${other.id}/invitations/not-an-id`)).status).toBe(422)
  })
})

async function productionSecret(): Promise<string> {
  const key = 'tula_sk_live_secret00000000000000000000000'
  await seedApiKey(deps, key, { environmentId: TENANT_B.environmentId })
  return key
}

describe('the limits on sending', () => {
  test('one organization may send 50 invitations an hour, and no more', async () => {
    const org = await makeOrganization()
    for (let index = 0; index < Invitations.INVITATIONS_PER_ORGANIZATION_PER_HOUR; index += 1) {
      await Invitations.invite(
        deps,
        TENANT_A,
        org.id,
        inviteBody({ email: `user${index}@northline.app` }) as never,
        TEST_ACTOR,
        null
      )
    }
    const res = await invite(org, { email: 'one-more@northline.app' })
    expect(res.status).toBe(429)
    expect(await codeOf(res)).toBe('rate_limited')
    expect(invitationMails()).toHaveLength(Invitations.INVITATIONS_PER_ORGANIZATION_PER_HOUR)
    // Another organization is not held up by it, and the hour passing frees this one.
    const other = await makeOrganization('other')
    expect((await invite(other)).status).toBe(201)
    deps.clock.advance('1h')
    expect((await invite(org, { email: 'one-more@northline.app' })).status).toBe(201)
  })

  test('one environment may send 1000 invitations a day, across its organizations', async () => {
    const perOrganization = Invitations.INVITATIONS_PER_ORGANIZATION_PER_HOUR
    const total = Invitations.INVITATIONS_PER_ENVIRONMENT_PER_DAY
    const organizations = Math.ceil(total / perOrganization) + 1
    let sent = 0
    for (let index = 0; index < organizations; index += 1) {
      const org = await Organizations.create(
        deps,
        TENANT_A,
        { name: `Org ${index}`, slug: `org-${index}` },
        TEST_ACTOR
      )
      for (let count = 0; count < perOrganization && sent < total; count += 1) {
        await Invitations.invite(
          deps,
          TENANT_A,
          org.id,
          inviteBody({ email: `user${sent}@northline.app` }) as never,
          TEST_ACTOR,
          null
        )
        sent += 1
      }
    }
    expect(sent).toBe(total)
    const last = await makeOrganization('last')
    const res = await invite(last)
    expect(res.status).toBe(429)
    expect(await codeOf(res)).toBe('rate_limited')
    // Another environment has a day of its own.
    expect(
      (
        await Invitations.invite(
          deps,
          TENANT_B,
          (
            await Organizations.create(deps, TENANT_B, { name: 'Other', slug: 'other' }, TEST_ACTOR)
          ).id,
          inviteBody() as never,
          TEST_ACTOR,
          null
        )
      ).status
    ).toBe('pending')
  }, 60_000)

  test('the counts hold ids, never an address', async () => {
    const org = await makeOrganization()
    const hit = spyOn(deps.rateLimiter, 'hit')
    await invited(org)
    const keys = hit.mock.calls.map((call) => String(call[0]))
    expect(keys.some((key) => key.includes(org.id))).toBe(true)
    expect(keys.join()).not.toContain('northline')
    hit.mockRestore()
  })

  test.each([
    ['POST', '/me/organization-invitations/accept', INVITATIONS_WRITE_RATE_LIMIT],
    ['POST', '/me/organization-invitations/decline', INVITATIONS_WRITE_RATE_LIMIT],
    ['POST', '/organization-invitations/preview', INVITATIONS_WRITE_RATE_LIMIT],
  ])('%s %s is limited per IP', async (method, path, limit) => {
    for (let index = 0; index < limit; index += 1) {
      const res = await client(method, path, { token: 'nothing' }, { ip: '203.0.113.9' })
      expect(res.status).not.toBe(429)
    }
    const res = await client(method, path, { token: 'nothing' }, { ip: '203.0.113.9' })
    expect(res.status).toBe(429)
  })

  test('the member routes are limited per IP', async () => {
    const maya = await signUp()
    const org = await makeOrganization()
    await join(org, maya.userId, 'admin')
    const path = `/me/organizations/${org.id}/invitations`
    for (let index = 0; index < INVITATIONS_READ_RATE_LIMIT; index += 1) {
      const res = await client('GET', path, undefined, {
        token: maya.accessToken,
        ip: '203.0.113.10',
      })
      expect(res.status).toBe(200)
    }
    expect(
      (await client('GET', path, undefined, { token: maya.accessToken, ip: '203.0.113.10' })).status
    ).toBe(429)
  })
})

describe('a signed-in member inviting', () => {
  test.each([
    ['GET', '', undefined],
    ['POST', '', inviteBody()],
    ['DELETE', `/${UNKNOWN}`, undefined],
  ])('%s needs a session and a publishable key', async (method, suffix, body) => {
    const org = await makeOrganization()
    const path = `/me/organizations/${org.id}/invitations${suffix}`
    expect((await client(method, path, body)).status).toBe(401)
    const maya = await signUp()
    expect((await client(method, path, body, { token: SK })).status).toBe(401)
    expect([401, 403]).toContain(
      (await client(method, path, body, { token: maya.accessToken, key: null })).status
    )
    // A token of one environment is no session in another.
    expect((await client(method, path, body, { token: maya.accessToken, key: PK_B })).status).toBe(
      401
    )
  })

  test('an administrator invites; the invitation names them and the record is theirs', async () => {
    const maya = await signUp()
    const org = await makeOrganization()
    await join(org, maya.userId, 'admin')
    const res = await client('POST', `/me/organizations/${org.id}/invitations`, inviteBody(), {
      token: maya.accessToken,
    })
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await json<OrganizationInvitation>(res)
    expect(body.invitedBy).toBe(maya.userId)
    const entry = deps.activityLog.entries.find(
      (one) => one.type === 'organization_invitation.created'
    )
    expect(entry?.actor).toMatchObject({ type: 'user', id: maya.userId })
    const listed = await json<OrganizationInvitationList>(
      await client('GET', `/me/organizations/${org.id}/invitations`, undefined, {
        token: maya.accessToken,
      })
    )
    expect(listed.data.map((one) => one.id)).toEqual([body.id])
    expect(
      (
        await client('DELETE', `/me/organizations/${org.id}/invitations/${body.id}`, undefined, {
          token: maya.accessToken,
        })
      ).status
    ).toBe(204)
  })

  test('a user who is not a member, or whose role lacks the permission, is refused', async () => {
    const maya = await signUp()
    const org = await makeOrganization()
    const path = `/me/organizations/${org.id}/invitations`
    const outsider = await client('POST', path, inviteBody(), { token: maya.accessToken })
    expect(outsider.status).toBe(403)
    expect(await codeOf(outsider)).toBe('organization.not_a_member')
    // An organization that does not exist looks the same.
    const missing = await client('GET', `/me/organizations/${UNKNOWN}/invitations`, undefined, {
      token: maya.accessToken,
    })
    expect(await codeOf(missing)).toBe('organization.not_a_member')
    await join(org, maya.userId, 'member')
    for (const res of [
      await client('POST', path, inviteBody(), { token: maya.accessToken }),
      await client('GET', path, undefined, { token: maya.accessToken }),
      await client('DELETE', `${path}/${UNKNOWN}`, undefined, { token: maya.accessToken }),
    ]) {
      expect(res.status).toBe(403)
      const body = await json<{ code: string; params?: { permission?: string } }>(res)
      expect(body.code).toBe('organization.permission_required')
      expect(body.params?.permission).toBe('org:sys:invitations:manage')
    }
    expect(invitationMails()).toHaveLength(0)
    expect(invitationTypes()).toHaveLength(0)
  })

  test('a demotion takes effect at once, whatever the token says', async () => {
    const maya = await signUp()
    const org = await makeOrganization()
    await join(org, maya.userId, 'admin')
    const path = `/me/organizations/${org.id}/invitations`
    expect((await client('GET', path, undefined, { token: maya.accessToken })).status).toBe(200)
    // A second administrator exists, so the demotion is allowed.
    const sam = await signUp('sam@northline.app')
    await join(org, sam.userId, 'admin')
    await Organizations.changeMemberRole(
      deps,
      TENANT_A,
      org.id,
      maya.userId,
      { role: 'member' },
      TEST_ACTOR
    )
    const res = await client('POST', path, inviteBody(), { token: maya.accessToken })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('organization.permission_required')
  })

  test('an inviter offers only roles within their own permissions', async () => {
    const maya = await signUp()
    const org = await makeOrganization()
    await defineRole('inviter', ['org:sys:invitations:manage'])
    await defineRole('reader', ['org:sys:memberships:read'])
    await join(org, maya.userId, 'inviter')
    const path = `/me/organizations/${org.id}/invitations`
    for (const role of ['admin', 'member', 'reader']) {
      const res = await client('POST', path, inviteBody({ role }), { token: maya.accessToken })
      expect(res.status).toBe(403)
      expect(await codeOf(res)).toBe('organization.role_not_assignable')
    }
    expect(invitationMails()).toHaveLength(0)
    const own = await client('POST', path, inviteBody({ role: 'inviter' }), {
      token: maya.accessToken,
    })
    expect(own.status).toBe(201)
    // The operator is not held to it.
    expect((await invite(org, { email: 'bo@northline.app', role: 'admin' })).status).toBe(201)
  })

  test('an invitation of another organization cannot be withdrawn through this one', async () => {
    const maya = await signUp()
    const first = await makeOrganization('first')
    const second = await makeOrganization('second')
    await join(first, maya.userId, 'admin')
    const theirs = await invited(second)
    const res = await client(
      'DELETE',
      `/me/organizations/${first.id}/invitations/${theirs.id}`,
      undefined,
      { token: maya.accessToken }
    )
    expect(res.status).toBe(404)
    expect(
      (await deps.organizations.findInvitation(TEST_TENANT.environmentId, second.id, theirs.id))
        ?.status
    ).toBe('pending')
  })
})

describe('answering an invitation', () => {
  test('previews it with no session: the organization, the role, the address, the expiry', async () => {
    const org = await makeOrganization('acme', 'Acme Corp')
    const sent = await invited(org)
    const res = await preview(tokenOfLastInvitation())
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await json<InvitationPreview>(res)).toEqual({
      organizationName: 'Acme Corp',
      role: 'member',
      email: 'ada@northline.app',
      expiresAt: sent.expiresAt,
    })
    // It needs the publishable key, and a token of this environment.
    expect([401, 403]).toContain((await preview(tokenOfLastInvitation(), { key: null })).status)
    const other = await preview(tokenOfLastInvitation(), { key: PK_B })
    expect(await codeOf(other)).toBe('organization.invitation_not_found')
  })

  test('accepts it: the user joins with the invitation’s role, and it cannot be used twice', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    const sent = await invited(org, { role: 'admin' })
    const token = tokenOfLastInvitation()
    const res = await accept(ada.accessToken, token)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const joined = await json<AcceptedInvitation>(res)
    expect(joined).toMatchObject({ id: org.id, name: 'Acme Corp', slug: 'acme', role: 'admin' })
    expect(joined.permissions).toContain('org:sys:invitations:manage')
    const members = await json<OrganizationMembershipList>(
      await admin('GET', `/${org.id}/memberships`)
    )
    expect(members.data.map((one) => [one.userId, one.role])).toEqual([[ada.userId, 'admin']])
    expect(invitationTypes()).toEqual([
      'organization_invitation.created',
      'organization_invitation.accepted',
    ])
    const entries = deps.activityLog.entries
    const accepted = entries.find((one) => one.type === 'organization_invitation.accepted')
    expect(accepted?.target).toEqual({ type: 'organization_invitation', id: sent.id })
    expect(accepted?.data).toEqual({ organizationId: org.id, role: 'admin', userId: ada.userId })
    expect(accepted?.actor).toMatchObject({ type: 'user', id: ada.userId })
    expect(entries.map((one) => one.type)).toContain('organization_membership.added')
    for (const entry of entries.filter((one) => one.type.startsWith('organization'))) {
      const type = entry.type as keyof typeof EVENT_SCHEMAS
      expect(
        EVENT_SCHEMAS[type].safeParse({
          id: entry.id,
          type: entry.type,
          schemaVersion: 1,
          occurredAt: entry.occurredAt.toISOString(),
          actor: entry.actor,
          target: entry.target,
          data: entry.data,
        }).success
      ).toBe(true)
    }
    expect(JSON.stringify(entries)).not.toContain(token)
    expect(JSON.stringify(entries)).not.toContain('ada@northline.app')
    for (const second of [
      await accept(ada.accessToken, token),
      await decline(ada.accessToken, token),
    ]) {
      expect(second.status).toBe(410)
      expect(await codeOf(second)).toBe('organization.invitation_used')
    }
    expect((await preview(token)).status).toBe(410)
  })

  test('declines it: no membership, and it cannot be accepted afterwards', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    await invited(org)
    const token = tokenOfLastInvitation()
    const res = await decline(ada.accessToken, token)
    expect(res.status).toBe(204)
    expect(invitationTypes()).toEqual([
      'organization_invitation.created',
      'organization_invitation.declined',
    ])
    const members = await json<OrganizationMembershipList>(
      await admin('GET', `/${org.id}/memberships`)
    )
    expect(members.data).toEqual([])
    const late = await accept(ada.accessToken, token)
    expect(late.status).toBe(410)
    expect(await codeOf(late)).toBe('organization.invitation_used')
    const listed = await json<OrganizationInvitationList>(
      await admin('GET', `/${org.id}/invitations?status=declined`)
    )
    expect(listed.data).toHaveLength(1)
  })

  test.each([
    ['accept', accept],
    ['decline', decline],
  ])('a token nothing was issued for cannot be %sed', async (_, answer) => {
    const ada = await signUp('ada@northline.app')
    for (const bogus of ['nothing', 'x'.repeat(40)]) {
      const res = await answer(ada.accessToken, bogus)
      expect(res.status).toBe(404)
      expect(await codeOf(res)).toBe('organization.invitation_not_found')
    }
    expect(
      (await client('POST', '/me/organization-invitations/accept', {}, { token: ada.accessToken }))
        .status
    ).toBe(422)
  })

  test.each([
    ['accept', accept],
    ['decline', decline],
  ])('only the account it was sent to may %s it', async (_, answer) => {
    const sam = await signUp('sam@northline.app')
    const org = await makeOrganization()
    await invited(org)
    const token = tokenOfLastInvitation()
    const res = await answer(sam.accessToken, token)
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('organization.invitation_wrong_account')
    // Nothing was used up or joined: the real invitee can still answer.
    expect(invitationTypes()).toEqual(['organization_invitation.created'])
    const members = await json<OrganizationMembershipList>(
      await admin('GET', `/${org.id}/memberships`)
    )
    expect(members.data).toEqual([])
    const ada = await signUp('ada@northline.app')
    expect((await accept(ada.accessToken, token)).status).toBe(200)
  })

  test.each([
    ['accept', accept],
    ['decline', decline],
  ])('an address that was never proven cannot %s', async (_, answer) => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    await invited(org)
    const token = tokenOfLastInvitation()
    const real = deps.users.findById.bind(deps.users)
    const find = spyOn(deps.users, 'findById').mockImplementation(async (environmentId, id) => {
      const user = await real(environmentId, id)
      return user && { ...user, emailVerifiedAt: null }
    })
    const res = await answer(ada.accessToken, token)
    find.mockRestore()
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('organization.invitation_email_unverified')
    expect(invitationTypes()).toEqual(['organization_invitation.created'])
    expect((await answer(ada.accessToken, token)).status).not.toBe(403)
  })

  test('the address is compared as an address: case and spaces do not matter', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    await invited(org, { email: '  ADA@Northline.App ' })
    expect((await accept(ada.accessToken, tokenOfLastInvitation())).status).toBe(200)
  })

  test('an invitation that has lapsed cannot be previewed, accepted or declined', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    // Expiring within the life of the access token, so the session is still good afterwards.
    const token = 'a-token-that-is-about-to-lapse'
    const now = deps.clock.now()
    await deps.organizations.insertInvitation(
      {
        id: Bun.randomUUIDv7(),
        projectId: TEST_TENANT.projectId,
        environmentId: TEST_TENANT.environmentId,
        organizationId: org.id,
        email: 'ada@northline.app',
        emailNormalized: 'ada@northline.app',
        roleKey: 'member',
        tokenHash: new Bun.CryptoHasher('sha256').update(token).digest('hex'),
        status: 'pending',
        invitedBy: null,
        expiresAt: new Date(now.getTime() + 30_000),
        resolvedAt: null,
        resolvedBy: null,
        createdAt: now,
        updatedAt: now,
      },
      now,
      Audit.entry(deps, TEST_TENANT, {
        type: 'organization_invitation.created',
        actor: TEST_ACTOR,
        target: { type: 'organization_invitation', id: org.id },
        data: { organizationId: org.id, role: 'member' },
      })
    )
    expect((await preview(token)).status).toBe(200)
    deps.clock.advance('31s')
    for (const res of [
      await preview(token),
      await accept(ada.accessToken, token),
      await decline(ada.accessToken, token),
    ]) {
      expect(res.status).toBe(410)
      expect(await codeOf(res)).toBe('organization.invitation_expired')
    }
    expect(invitationTypes()).toEqual(['organization_invitation.created'])
    const members = await json<OrganizationMembershipList>(
      await admin('GET', `/${org.id}/memberships`)
    )
    expect(members.data).toEqual([])
  })

  test('a role deleted after the invitation is refused, never replaced, and the invitation stays', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    await defineRole('billing', ['org:billing:read'])
    const { id } = await invited(org, { role: 'billing' })
    const token = tokenOfLastInvitation()
    const gone = await app.request('/v1/admin/organization-roles/billing', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(gone.status).toBe(204)
    const res = await accept(ada.accessToken, token)
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('organization.invitation_role_gone')
    const members = await json<OrganizationMembershipList>(
      await admin('GET', `/${org.id}/memberships`)
    )
    expect(members.data).toEqual([])
    expect(
      (await deps.organizations.findInvitation(TEST_TENANT.environmentId, org.id, id))?.status
    ).toBe('pending')
    // Declining does not need the role, and the operator can withdraw it.
    expect((await decline(ada.accessToken, token)).status).toBe(204)
  })

  test('a user who is a member already is told so, and the invitation stays pending', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    const { id } = await invited(org)
    const token = tokenOfLastInvitation()
    await join(org, ada.userId, 'member')
    const res = await accept(ada.accessToken, token)
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('organization.member_exists')
    expect(
      (await deps.organizations.findInvitation(TEST_TENANT.environmentId, org.id, id))?.status
    ).toBe('pending')
    expect(invitationTypes()).toEqual(['organization_invitation.created'])
  })

  test('two acceptances at once make one membership', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    await invited(org)
    const token = tokenOfLastInvitation()
    const results = await Promise.all([
      accept(ada.accessToken, token),
      accept(ada.accessToken, token),
    ])
    expect(results.map((res) => res.status).sort()).toEqual([200, 410])
    const members = await json<OrganizationMembershipList>(
      await admin('GET', `/${org.id}/memberships`)
    )
    expect(members.data).toHaveLength(1)
  })

  test('the membership it makes counts for the next token', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    await invited(org, { role: 'admin' })
    await accept(ada.accessToken, tokenOfLastInvitation())
    const activated = await client(
      'PUT',
      '/me/organizations/active',
      { organizationId: org.id },
      { token: ada.accessToken }
    )
    expect(activated.status).toBe(200)
  })

  test('a signed-in user needs a session and a publishable key to answer', async () => {
    const org = await makeOrganization()
    await invited(org)
    const token = tokenOfLastInvitation()
    for (const path of ['accept', 'decline']) {
      const full = `/me/organization-invitations/${path}`
      expect((await client('POST', full, { token })).status).toBe(401)
      expect((await client('POST', full, { token }, { token: SK })).status).toBe(401)
      expect((await client('POST', full, { token }, { token: AK })).status).toBe(401)
    }
  })
})

describe('the invitations addressed to me', () => {
  const mine = (token: string, query = '') =>
    client('GET', `/me/organization-invitations${query}`, undefined, { token })
  const acceptMine = (token: string, id: string) =>
    client('POST', `/me/organization-invitations/${id}/accept`, undefined, { token })
  const declineMine = (token: string, id: string) =>
    client('POST', `/me/organization-invitations/${id}/decline`, undefined, { token })

  async function listed(token: string, query = '') {
    const res = await mine(token, query)
    expect(res.status).toBe(200)
    return json<MyOrganizationInvitationList>(res)
  }

  /** The user's access token after the invitations' lifetime has passed, refreshing on the way. */
  async function laterToken(session: SessionTokens): Promise<string> {
    let refreshToken = session.refreshToken
    let accessToken = session.accessToken
    // A refresh token does not last a week unused, so the days pass in two halves.
    for (const days of ['4d', '4d']) {
      deps.clock.advance(days)
      const refreshed = await client('POST', '/sessions/refresh', { refreshToken })
      expect(refreshed.status).toBe(200)
      ;({ accessToken, refreshToken } = await json<SessionTokens>(refreshed))
    }
    return accessToken
  }

  test('lists the pending invitations to my verified address: id, organization name, role, expiry', async () => {
    const ada = await signUp('ada@northline.app')
    const one = await makeOrganization('acme', 'Acme Corp')
    const two = await makeOrganization('globex', 'Globex')
    const first = await invited(one, { role: 'admin' })
    deps.clock.advance('1s')
    const second = await invited(two)
    const res = await mine(ada.accessToken)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await json<MyOrganizationInvitationList>(res)
    expect(body.meta.totalCount).toBe(2)
    expect(body.data).toEqual([
      { id: second.id, organizationName: 'Globex', role: 'member', expiresAt: second.expiresAt },
      { id: first.id, organizationName: 'Acme Corp', role: 'admin', expiresAt: first.expiresAt },
    ])
  })

  test('shows nothing but those four fields: no token, address, inviter or organization id', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    await invited(org)
    const token = tokenOfLastInvitation()
    const raw = JSON.stringify(await (await mine(ada.accessToken)).json())
    expect(raw).not.toContain(token)
    expect(raw).not.toContain('ada@northline.app')
    expect(raw).not.toContain(org.id)
    const [entry] = (await listed(ada.accessToken)).data
    expect(Object.keys(entry ?? {}).sort()).toEqual(['expiresAt', 'id', 'organizationName', 'role'])
  })

  test('never lists another user’s invitations', async () => {
    const ada = await signUp('ada@northline.app')
    const sam = await signUp('sam@northline.app')
    const org = await makeOrganization()
    await invited(org, { email: 'sam@northline.app' })
    expect((await listed(ada.accessToken)).data).toEqual([])
    expect((await listed(sam.accessToken)).data).toHaveLength(1)
  })

  test('an address that was never proven sees none', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    await invited(org)
    const real = deps.users.findById.bind(deps.users)
    const find = spyOn(deps.users, 'findById').mockImplementation(async (environmentId, id) => {
      const user = await real(environmentId, id)
      return user && { ...user, emailVerifiedAt: null }
    })
    const body = await listed(ada.accessToken)
    find.mockRestore()
    expect(body.data).toEqual([])
    expect(body.meta.totalCount).toBe(0)
  })

  test('leaves out the expired, the revoked and the used', async () => {
    const ada = await signUp('ada@northline.app')
    const used = await makeOrganization('used', 'Used')
    const revoked = await makeOrganization('revoked', 'Revoked')
    const lapsing = await makeOrganization('late', 'Late')
    await invited(used)
    await accept(ada.accessToken, tokenOfLastInvitation())
    const sent = await invited(revoked)
    expect((await admin('DELETE', `/${revoked.id}/invitations/${sent.id}`)).status).toBe(204)
    await invited(lapsing)
    expect((await listed(ada.accessToken)).data.map((one) => one.organizationName)).toEqual([
      'Late',
    ])
    const token = await laterToken(ada)
    expect((await listed(token)).data).toEqual([])
  })

  test('is paged like the other lists, and a bad page is refused', async () => {
    const ada = await signUp('ada@northline.app')
    for (const slug of ['one', 'two', 'three']) {
      await invited(await makeOrganization(slug, slug))
      deps.clock.advance('1s')
    }
    const page = await listed(ada.accessToken, '?size=2&page=2')
    expect(page.meta).toMatchObject({ totalCount: 3, totalPages: 2, page: 2, perPage: 2 })
    expect(page.data.map((one) => one.organizationName)).toEqual(['one'])
    expect((await mine(ada.accessToken, '?page=0')).status).toBe(422)
    expect((await mine(ada.accessToken, '?size=100000')).status).toBe(422)
  })

  test('needs a publishable key and a session, and organizations switched on', async () => {
    const ada = await signUp('ada@northline.app')
    expect((await client('GET', '/me/organization-invitations')).status).toBe(401)
    expect((await mine(SK)).status).toBe(401)
    expect((await mine(AK)).status).toBe(401)
    const keyless = await client('GET', '/me/organization-invitations', undefined, {
      token: ada.accessToken,
      key: null,
    })
    expect(keyless.status).toBe(401)
    configure({ enabled: false })
    const res = await mine(ada.accessToken)
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('organization.disabled')
  })

  test('is rate limited per IP', async () => {
    const ada = await signUp('ada@northline.app')
    let last = 200
    for (let i = 0; i <= INVITATIONS_READ_RATE_LIMIT; i += 1) {
      last = (await mine(ada.accessToken)).status
    }
    expect(last).toBe(429)
  })

  test('accepts one from the list by its id: the user joins with its role, once', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    const sent = await invited(org, { role: 'admin' })
    const res = await acceptMine(ada.accessToken, sent.id)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await json<AcceptedInvitation>(res)).toMatchObject({ id: org.id, role: 'admin' })
    expect((await listed(ada.accessToken)).data).toEqual([])
    const again = await acceptMine(ada.accessToken, sent.id)
    expect(again.status).toBe(410)
    expect(await codeOf(again)).toBe('organization.invitation_used')
    expect(invitationTypes()).toEqual([
      'organization_invitation.created',
      'organization_invitation.accepted',
    ])
  })

  test('declines one from the list by its id: no membership, and it is gone from the list', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    const sent = await invited(org)
    expect((await declineMine(ada.accessToken, sent.id)).status).toBe(204)
    expect((await listed(ada.accessToken)).data).toEqual([])
    const members = await json<OrganizationMembershipList>(
      await admin('GET', `/${org.id}/memberships`)
    )
    expect(members.data).toEqual([])
    expect(invitationTypes()).toEqual([
      'organization_invitation.created',
      'organization_invitation.declined',
    ])
  })

  test.each([
    ['accept', true],
    ['decline', false],
  ])(
    'someone else’s id, an unknown id and a malformed one cannot be %sed, and look alike',
    async (_, accepting) => {
      const answer = accepting ? acceptMine : declineMine
      const sam = await signUp('sam@northline.app')
      const org = await makeOrganization()
      const sent = await invited(org)
      for (const id of [sent.id, UNKNOWN]) {
        const res = await answer(sam.accessToken, id)
        expect(res.status).toBe(404)
        expect(await codeOf(res)).toBe('organization.invitation_not_found')
      }
      expect((await answer(sam.accessToken, 'not-a-uuid')).status).toBe(422)
      // Nothing was used up: the real invitee can still answer.
      const ada = await signUp('ada@northline.app')
      expect([200, 204]).toContain((await answer(ada.accessToken, sent.id)).status)
    }
  )

  test('a used-up invitation of someone else does not reveal its state', async () => {
    const ada = await signUp('ada@northline.app')
    const sam = await signUp('sam@northline.app')
    const org = await makeOrganization()
    const sent = await invited(org)
    await declineMine(ada.accessToken, sent.id)
    const res = await acceptMine(sam.accessToken, sent.id)
    expect(res.status).toBe(404)
    expect(await codeOf(res)).toBe('organization.invitation_not_found')
  })

  test.each([
    ['accept', true],
    ['decline', false],
  ])('an address that was never proven cannot %s by id', async (_, accepting) => {
    const answer = accepting ? acceptMine : declineMine
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    const sent = await invited(org)
    const real = deps.users.findById.bind(deps.users)
    const find = spyOn(deps.users, 'findById').mockImplementation(async (environmentId, id) => {
      const user = await real(environmentId, id)
      return user && { ...user, emailVerifiedAt: null }
    })
    const res = await answer(ada.accessToken, sent.id)
    find.mockRestore()
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('organization.invitation_email_unverified')
    const members = await json<OrganizationMembershipList>(
      await admin('GET', `/${org.id}/memberships`)
    )
    expect(members.data).toEqual([])
  })

  test('a revoked and an expired invitation cannot be answered by id', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    const other = await makeOrganization('globex', 'Globex')
    const sent = await invited(org)
    await admin('DELETE', `/${org.id}/invitations/${sent.id}`)
    const revoked = await acceptMine(ada.accessToken, sent.id)
    expect(revoked.status).toBe(410)
    expect(await codeOf(revoked)).toBe('organization.invitation_revoked')
    const lapsing = await invited(other)
    const token = await laterToken(ada)
    const expired = await acceptMine(token, lapsing.id)
    expect(expired.status).toBe(410)
    expect(await codeOf(expired)).toBe('organization.invitation_expired')
  })

  test('the id routes need a session and a publishable key, and organizations switched on', async () => {
    const ada = await signUp('ada@northline.app')
    const org = await makeOrganization()
    const sent = await invited(org)
    for (const path of ['accept', 'decline']) {
      const full = `/me/organization-invitations/${sent.id}/${path}`
      expect((await client('POST', full)).status).toBe(401)
      expect((await client('POST', full, undefined, { token: SK })).status).toBe(401)
      expect((await client('POST', full, undefined, { token: AK })).status).toBe(401)
      expect(
        (await client('POST', full, undefined, { token: ada.accessToken, key: null })).status
      ).toBe(401)
    }
    configure({ enabled: false })
    for (const answer of [acceptMine, declineMine]) {
      const res = await answer(ada.accessToken, sent.id)
      expect(res.status).toBe(403)
      expect(await codeOf(res)).toBe('organization.disabled')
    }
  })
})
