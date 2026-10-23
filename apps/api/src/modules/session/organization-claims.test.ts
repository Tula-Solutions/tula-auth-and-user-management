import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type AccessTokenClaims,
  AccessTokenClaimsSchema,
  BUILT_IN_ROLES,
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsSchema,
  MAX_ORGANIZATION_CLAIMS_BYTES,
  type Organization,
  RESERVED_CLAIM_NAMES,
  readOrganizationClaims,
} from '@tula-tech/contract'
import { decodeJwt } from 'jose'
import type { Tenant } from '~/dependencies'
import * as logger from '~/lib/logger'
import { verifyAccessToken } from '~/middleware/session-auth'
import * as Audit from '~/modules/audit/service'
import * as Me from '~/modules/organization/me-service'
import * as Organizations from '~/modules/organization/service'
import * as OrganizationRoles from '~/modules/organization-role/service'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// The organization claims of a token (ADR 0065, "Token claims"): `org_id`, `org_role` and
// `org_perms`, present only while an organization is active, re-read from the membership at
// every refresh.

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const MAYA = '00000000-0000-7000-8000-0000000000a1'
const SAM = '00000000-0000-7000-8000-0000000000a2'
const ADMIN_PERMISSIONS = [
  ...(BUILT_IN_ROLES.find((role) => role.key === 'admin')?.permissions ?? []),
]
const MEMBER_PERMISSIONS = [
  ...(BUILT_IN_ROLES.find((role) => role.key === 'member')?.permissions ?? []),
]

let deps: TestDeps
let revision = 0

function configure(
  organizations: Record<string, unknown> = {},
  target: Tenant = tenant,
  sessions: Record<string, unknown> = {}
): void {
  revision += 1
  deps.environmentSettings.seed(target.environmentId, {
    revision,
    settings: EnvironmentSettingsSchema.parse({
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      sessions,
      organizations: {
        ...DEFAULT_ENVIRONMENT_SETTINGS.organizations,
        enabled: true,
        ...organizations,
      },
    }),
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
  configure()
  await addUser(MAYA, 'maya@northline.app')
  await addUser(SAM, 'sam@northline.app')
})

async function addUser(id: string, email: string, target: Tenant = tenant): Promise<void> {
  await deps.users.create(
    {
      id,
      projectId: target.projectId,
      environmentId: target.environmentId,
      email,
      emailNormalized: email,
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: 'hash',
    },
    Audit.none('fixture')
  )
}

let slugs = 0
async function organization(target: Tenant = tenant): Promise<Organization> {
  slugs += 1
  return Organizations.create(deps, target, { name: 'Acme', slug: `acme-${slugs}` }, TEST_ACTOR)
}

const join = (org: Organization, userId: string, role: string, target: Tenant = tenant) =>
  Organizations.addMember(deps, target, org.id, { userId, role }, TEST_ACTOR)

function create(
  userId = MAYA,
  overrides: Partial<Sessions.CreateInput> = {},
  target: Tenant = tenant
): Promise<Sessions.IssuedSession> {
  return Sessions.create(deps, target, { userId, client: 'ios', ...overrides })
}

function claimsOf(tokens: { accessToken?: string }): AccessTokenClaims {
  if (!tokens.accessToken) {
    throw new Error('expected an access token')
  }
  return decodeJwt<AccessTokenClaims>(tokens.accessToken)
}

function refreshTokenOf(tokens: Sessions.IssuedSession): string {
  if (!tokens.refreshToken) {
    throw new Error('expected a refresh token')
  }
  return tokens.refreshToken
}

const self = (tokens: { sessionId: string }, userId = MAYA) => ({
  userId,
  sessionId: tokens.sessionId,
})
const setActive = (tokens: { sessionId: string }, id: string | null, userId = MAYA) =>
  Me.setActive(deps, tenant, self(tokens, userId), id)

const ORG_CLAIMS = ['org_id', 'org_perms', 'org_role']
const orgClaimsOf = (claims: AccessTokenClaims) =>
  Object.keys(claims)
    .filter((name) => name.startsWith('org_'))
    .sort()

describe('a session acting in no organization', () => {
  test('has the claims it always had, before and after a refresh', async () => {
    const acme = await organization()
    await join(acme, MAYA, 'admin')
    const tokens = await create()
    expect(orgClaimsOf(claimsOf(tokens))).toEqual([])
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(orgClaimsOf(claimsOf(refreshed))).toEqual([])
  })

  test('reads no membership at a refresh', async () => {
    const acme = await organization()
    await join(acme, MAYA, 'admin')
    const tokens = await create()
    const one = spyOn(deps.organizations, 'findUserMembership')
    const many = spyOn(deps.organizations, 'listUserMemberships')
    await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(one).not.toHaveBeenCalled()
    expect(many).not.toHaveBeenCalled()
  })
})

describe('setting the active organization', () => {
  test('gives a new access token that carries the organization, the role and its permissions', async () => {
    const acme = await organization()
    await join(acme, MAYA, 'admin')
    const tokens = await create()
    const active = await setActive(tokens, acme.id)
    expect(active).toMatchObject({ sessionId: tokens.sessionId, organizationId: acme.id })
    const claims = claimsOf(active)
    expect(claims).toMatchObject({
      org_id: acme.id,
      org_role: 'admin',
      org_perms: ADMIN_PERMISSIONS,
      sid: tokens.sessionId,
      sub: MAYA,
    })
    // The token is a valid one: it verifies, and its claims parse.
    const verified = await verifyAccessToken(deps, active.accessToken ?? '', tenant)
    expect(AccessTokenClaimsSchema.parse(verified).org_id).toBe(acme.id)
    expect(readOrganizationClaims(verified)).toEqual({
      orgId: acme.id,
      orgRole: 'admin',
      orgPermissions: ADMIN_PERMISSIONS,
    })
  })

  test('is not a rotation: the refresh token still works, once', async () => {
    const acme = await organization()
    await join(acme, MAYA, 'member')
    const tokens = await create()
    const active = await setActive(tokens, acme.id)
    expect(active).not.toHaveProperty('refreshToken')
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(refreshed.refreshToken).not.toBe(tokens.refreshToken)
  })

  test('clearing it gives a token with none of the three claims', async () => {
    const acme = await organization()
    await join(acme, MAYA, 'admin')
    const tokens = await create()
    await setActive(tokens, acme.id)
    const cleared = await setActive(tokens, null)
    expect(cleared.organizationId).toBeNull()
    expect(orgClaimsOf(claimsOf(cleared))).toEqual([])
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(orgClaimsOf(claimsOf(refreshed))).toEqual([])
  })

  test('switching moves the claims to the other organization', async () => {
    const [acme, globex] = [await organization(), await organization()]
    await join(acme, MAYA, 'admin')
    await join(globex, MAYA, 'member')
    const tokens = await create()
    expect(claimsOf(await setActive(tokens, acme.id))).toMatchObject({
      org_id: acme.id,
      org_role: 'admin',
    })
    expect(claimsOf(await setActive(tokens, globex.id))).toMatchObject({
      org_id: globex.id,
      org_role: 'member',
      org_perms: MEMBER_PERMISSIONS,
    })
  })

  test.each([
    ['one that does not exist', async () => '00000000-0000-7000-8000-00000000dead'],
    ['one the user does not belong to', async () => (await organization()).id],
    [
      'another environment’s',
      async () => {
        configure({}, otherTenant)
        const foreign = await organization(otherTenant)
        await addUser(MAYA, 'maya@northline.app', otherTenant)
        await join(foreign, MAYA, 'admin', otherTenant)
        return foreign.id
      },
    ],
  ])('%s is refused as not_a_member, with nothing stored and no token', async (_name, id) => {
    const tokens = await create()
    const target = await id()
    await expect(setActive(tokens, target)).rejects.toMatchObject({
      code: 'organization.not_a_member',
    })
    expect(
      (await deps.sessions.findById(tenant.environmentId, tokens.sessionId))?.activeOrganizationId
    ).toBeNull()
  })

  test('another user’s organization is refused even to a user of the same environment', async () => {
    const acme = await organization()
    await join(acme, SAM, 'admin')
    const tokens = await create(MAYA)
    await expect(setActive(tokens, acme.id)).rejects.toMatchObject({
      code: 'organization.not_a_member',
    })
  })

  test('the three answers are indistinguishable', async () => {
    const stranger = await organization()
    const tokens = await create()
    const answers = await Promise.all(
      [stranger.id, '00000000-0000-7000-8000-00000000dead'].map(async (id) =>
        setActive(tokens, id).catch((error: unknown) => error)
      )
    )
    expect(
      answers.map((error) => JSON.stringify(error, Object.getOwnPropertyNames(error as object)))
    ).toSatisfy(([first, second]: string[]) => first === second)
  })

  test('a user who has left is refused, and so is a session that has ended', async () => {
    const acme = await organization()
    await join(acme, MAYA, 'admin')
    const tokens = await create()
    await Organizations.removeMember(deps, tenant, acme.id, MAYA, TEST_ACTOR).catch(() => {
      // Maya was the only manager: make a second one first.
    })
    const second = await organization()
    await join(second, MAYA, 'admin')
    await join(second, SAM, 'admin')
    await Organizations.removeMember(deps, tenant, second.id, MAYA, TEST_ACTOR)
    await expect(setActive(tokens, second.id)).rejects.toMatchObject({
      code: 'organization.not_a_member',
    })
    await Sessions.signOut(deps, tenant, refreshTokenOf(tokens))
    await expect(setActive(tokens, acme.id)).rejects.toMatchObject({ code: 'session.revoked' })
    expect(
      (await deps.sessions.findById(tenant.environmentId, tokens.sessionId))?.activeOrganizationId
    ).toBeNull()
  })

  test('another user’s session id cannot be switched', async () => {
    const acme = await organization()
    await join(acme, SAM, 'admin')
    const mayas = await create(MAYA)
    await expect(
      Me.setActive(deps, tenant, { userId: SAM, sessionId: mayas.sessionId }, acme.id)
    ).rejects.toMatchObject({ code: 'session.revoked' })
    expect(
      (await deps.sessions.findById(tenant.environmentId, mayas.sessionId))?.activeOrganizationId
    ).toBeNull()
  })

  test('is refused while organizations are off, and nothing is stored', async () => {
    const acme = await organization()
    await join(acme, MAYA, 'admin')
    const tokens = await create()
    configure({ enabled: false })
    await expect(setActive(tokens, acme.id)).rejects.toMatchObject({
      code: 'organization.disabled',
    })
    await expect(setActive(tokens, null)).rejects.toMatchObject({ code: 'organization.disabled' })
    expect(
      (await deps.sessions.findById(tenant.environmentId, tokens.sessionId))?.activeOrganizationId
    ).toBeNull()
  })

  test('cannot be cleared where the environment has no personal account', async () => {
    const acme = await organization()
    await join(acme, MAYA, 'admin')
    const tokens = await create()
    await setActive(tokens, acme.id)
    configure({ personalAccount: false })
    await expect(setActive(tokens, null)).rejects.toMatchObject({
      code: 'organization.personal_account_disabled',
    })
    // Still acting in the organization, and still allowed to switch to one.
    expect(
      (await deps.sessions.findById(tenant.environmentId, tokens.sessionId))?.activeOrganizationId
    ).toBe(acme.id)
    expect(claimsOf(await setActive(tokens, acme.id)).org_id).toBe(acme.id)
  })
})

describe('a refresh', () => {
  async function actingAs(role = 'admin') {
    const acme = await organization()
    await join(acme, MAYA, role)
    // A second manager, so that the first can be demoted or removed.
    await join(acme, SAM, 'admin')
    const tokens = await create()
    await setActive(tokens, acme.id)
    return { acme, tokens }
  }

  test('keeps the claims, reading the membership once', async () => {
    const { acme, tokens } = await actingAs()
    const read = spyOn(deps.organizations, 'findUserMembership')
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(read).toHaveBeenCalledTimes(1)
    expect(claimsOf(refreshed)).toMatchObject({
      org_id: acme.id,
      org_role: 'admin',
      org_perms: ADMIN_PERMISSIONS,
    })
    expect(orgClaimsOf(claimsOf(refreshed))).toEqual(ORG_CLAIMS)
  })

  test('keeps them again, and inside the grace window too', async () => {
    const { acme, tokens } = await actingAs()
    const first = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    // The first token presented again inside the grace period: the same claims.
    const replay = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(claimsOf(replay).org_id).toBe(acme.id)
    const second = await Sessions.refresh(deps, tenant, refreshTokenOf(first))
    expect(claimsOf(second).org_id).toBe(acme.id)
  })

  test('loses the claims once the user is removed, and the session stays', async () => {
    const { acme, tokens } = await actingAs()
    await Organizations.removeMember(deps, tenant, acme.id, MAYA, TEST_ACTOR)
    // The token already issued is a token: it says what it said until it expires.
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(orgClaimsOf(claimsOf(refreshed))).toEqual([])
    expect(claimsOf(refreshed).sid).toBe(tokens.sessionId)
    expect(
      (await deps.sessions.findById(tenant.environmentId, tokens.sessionId))?.revokedAt
    ).toBeNull()
    // And the session goes on refreshing.
    const again = await Sessions.refresh(deps, tenant, refreshTokenOf(refreshed))
    expect(orgClaimsOf(claimsOf(again))).toEqual([])
  })

  test('has the new role once the user is demoted, and the old one before', async () => {
    const { acme, tokens } = await actingAs()
    await Organizations.changeMemberRole(
      deps,
      tenant,
      acme.id,
      MAYA,
      { role: 'member' },
      TEST_ACTOR
    )
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(claimsOf(refreshed)).toMatchObject({
      org_id: acme.id,
      org_role: 'member',
      org_perms: MEMBER_PERMISSIONS,
    })
  })

  test('has the claims again if the user is added back to the same organization', async () => {
    const { acme, tokens } = await actingAs()
    await Organizations.removeMember(deps, tenant, acme.id, MAYA, TEST_ACTOR)
    const gone = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(orgClaimsOf(claimsOf(gone))).toEqual([])
    await join(acme, MAYA, 'member')
    const back = await Sessions.refresh(deps, tenant, refreshTokenOf(gone))
    expect(claimsOf(back)).toMatchObject({ org_id: acme.id, org_role: 'member' })
  })

  test('loses the claims once the organization is deleted', async () => {
    const { acme, tokens } = await actingAs()
    await Organizations.remove(deps, tenant, acme.id, TEST_ACTOR)
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(orgClaimsOf(claimsOf(refreshed))).toEqual([])
  })

  test('has no claims while organizations are off, and has them again when switched on', async () => {
    const { acme, tokens } = await actingAs()
    configure({ enabled: false })
    const off = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(orgClaimsOf(claimsOf(off))).toEqual([])
    configure({ enabled: true })
    const on = await Sessions.refresh(deps, tenant, refreshTokenOf(off))
    expect(claimsOf(on).org_id).toBe(acme.id)
  })

  test('of another user in the same organization is untouched by the first one’s removal', async () => {
    const { acme } = await actingAs()
    const sams = await create(SAM)
    await setActive(sams, acme.id, SAM)
    await Organizations.removeMember(deps, tenant, acme.id, MAYA, TEST_ACTOR)
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(sams))
    expect(claimsOf(refreshed).org_id).toBe(acme.id)
  })

  test('a banned user’s refresh is refused before any claim is built', async () => {
    const { tokens } = await actingAs()
    await deps.users.setBanned(
      tenant.environmentId,
      MAYA,
      deps.clock.now(),
      deps.clock.now(),
      Audit.none('fixture')
    )
    const read = spyOn(deps.organizations, 'findUserMembership')
    await expect(Sessions.refresh(deps, tenant, refreshTokenOf(tokens))).rejects.toMatchObject({
      code: 'auth.user_banned',
    })
    expect(read).not.toHaveBeenCalled()
  })
})

describe('a stateful session', () => {
  const stateful = { profiles: { web: { type: 'stateful' } } }

  test('carries the claims at its next check, and loses them with the membership', async () => {
    configure({}, tenant, stateful)
    const acme = await organization()
    await join(acme, MAYA, 'admin')
    await join(acme, SAM, 'admin')
    const tokens = await create(MAYA, { client: 'web' })
    const active = await setActive(tokens, acme.id)
    // No token to give: the cookie is the credential.
    expect(active).toEqual({ sessionId: tokens.sessionId, organizationId: acme.id })
    const claims = await Sessions.authenticate(deps, tenant, tokens.sessionToken ?? '')
    expect(claims).toMatchObject({
      org_id: acme.id,
      org_role: 'admin',
      org_perms: ADMIN_PERMISSIONS,
    })
    await Organizations.removeMember(deps, tenant, acme.id, MAYA, TEST_ACTOR)
    const after = await Sessions.authenticate(deps, tenant, tokens.sessionToken ?? '')
    expect(orgClaimsOf(after)).toEqual([])
    expect(after.sid).toBe(tokens.sessionId)
  })
})

describe('the most a role can put in a token', () => {
  const FEATURE = 'f'.repeat(31)
  const ACTION = 'a'.repeat(31)
  const maximal = Array.from(
    { length: 32 },
    (_, index) => `org:${FEATURE}${index % 10}:${ACTION}${index % 10}`
  )

  /** Stores a custom role directly, past what the roles API would accept. */
  async function withRole(key: string, permissions: string[]) {
    const now = deps.clock.now()
    await deps.organizations.ensureBuiltInRoles([
      {
        id: deps.ids.next(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        key,
        name: key,
        permissions,
        builtIn: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    ])
  }

  test('a token signed for the maximal role carries all of it and stays inside the cap', async () => {
    const longest = `r${'x'.repeat(31)}`
    await withRole(longest, maximal)
    const acme = await organization()
    await join(acme, SAM, 'admin')
    await join(acme, MAYA, longest)
    const tokens = await create()
    const active = await setActive(tokens, acme.id)
    for (const issued of [active, await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))]) {
      const read = readOrganizationClaims(claimsOf(issued))
      expect(read?.orgRole).toBe(longest)
      expect(read?.orgPermissions).toEqual(maximal)
      const payload = claimsOf(issued)
      const bytes = JSON.stringify({
        org_id: payload.org_id,
        org_role: payload.org_role,
        org_perms: payload.org_perms,
      }).length
      expect(bytes).toBeLessThanOrEqual(MAX_ORGANIZATION_CLAIMS_BYTES)
    }
  })

  test('a role written by hand past the bounds yields a token with none of the claims, and logs no permission', async () => {
    await withRole('toolong', [...maximal, 'org:billing:read'])
    const acme = await organization()
    await join(acme, SAM, 'admin')
    await join(acme, MAYA, 'toolong')
    const tokens = await create()
    const error = spyOn(logger, 'error').mockImplementation(() => undefined)
    const active = await setActive(tokens, acme.id)
    expect(orgClaimsOf(claimsOf(active))).toEqual([])
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(orgClaimsOf(claimsOf(refreshed))).toEqual([])
    expect(error).toHaveBeenCalled()
    expect(JSON.stringify(error.mock.calls)).not.toContain('org:billing')
    expect(JSON.stringify(error.mock.calls)).not.toContain(FEATURE)
    error.mockRestore()
  })
})

describe('a custom role (ADR 0065, "Custom roles")', () => {
  const BILLING = ['org:billing:read', 'org:billing:write']

  async function billingManager() {
    return OrganizationRoles.create(
      deps,
      tenant,
      { key: 'billing_manager', name: 'Billing manager', permissions: BILLING },
      TEST_ACTOR
    )
  }

  test('the token carries the custom role’s key and permissions, and the next refresh the new set', async () => {
    const role = await billingManager()
    const acme = await organization()
    await join(acme, SAM, 'admin')
    await join(acme, MAYA, 'billing_manager')
    const tokens = await create()
    const active = await setActive(tokens, acme.id)
    expect(claimsOf(active)).toMatchObject({
      org_id: acme.id,
      org_role: 'billing_manager',
      org_perms: BILLING,
    })

    // An administrator changes what the role holds. The role is read at every issue, never
    // kept in the session or in a cache, so the very next refresh says so.
    const changed = ['org:billing:read', 'org:invoices:read', 'org:sys:memberships:read']
    await OrganizationRoles.update(
      deps,
      tenant,
      'billing_manager',
      role.version,
      { permissions: changed },
      TEST_ACTOR
    )
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(claimsOf(refreshed)).toMatchObject({
      org_id: acme.id,
      org_role: 'billing_manager',
      org_perms: changed,
    })
    const again = await Sessions.refresh(deps, tenant, refreshTokenOf(refreshed))
    expect(claimsOf(again).org_perms).toEqual(changed)
  })

  test('a role taking a permission away takes it from the next token, not the same one', async () => {
    const role = await billingManager()
    const acme = await organization()
    await join(acme, SAM, 'admin')
    await join(acme, MAYA, 'billing_manager')
    const tokens = await create()
    const active = await setActive(tokens, acme.id)
    await OrganizationRoles.update(
      deps,
      tenant,
      'billing_manager',
      role.version,
      { permissions: [] },
      TEST_ACTOR
    )
    // The token already issued is a signed statement and lives out its minute; the refresh
    // after the change is the first that cannot say the permission.
    expect(claimsOf(active).org_perms).toEqual(BILLING)
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(claimsOf(refreshed)).toMatchObject({ org_role: 'billing_manager', org_perms: [] })
  })

  test('a member moved to another role carries the other role at the next refresh', async () => {
    await billingManager()
    const acme = await organization()
    await join(acme, SAM, 'admin')
    await join(acme, MAYA, 'billing_manager')
    const tokens = await create()
    await setActive(tokens, acme.id)
    await Organizations.changeMemberRole(
      deps,
      tenant,
      acme.id,
      MAYA,
      { role: 'member' },
      TEST_ACTOR
    )
    const refreshed = await Sessions.refresh(deps, tenant, refreshTokenOf(tokens))
    expect(claimsOf(refreshed)).toMatchObject({
      org_role: 'member',
      org_perms: MEMBER_PERMISSIONS,
    })
  })

  test('a stateful session reads the changed role at its next request', async () => {
    configure({}, tenant, { profiles: { web: { type: 'stateful' } } })
    const role = await billingManager()
    const acme = await organization()
    await join(acme, SAM, 'admin')
    await join(acme, MAYA, 'billing_manager')
    const tokens = await create(MAYA, { client: 'web' })
    await setActive(tokens, acme.id)
    await OrganizationRoles.update(
      deps,
      tenant,
      'billing_manager',
      role.version,
      { permissions: ['org:reports:read'] },
      TEST_ACTOR
    )
    const claims = await Sessions.authenticate(deps, tenant, tokens.sessionToken ?? '')
    expect(claims).toMatchObject({ org_role: 'billing_manager', org_perms: ['org:reports:read'] })
  })
})

describe('a name an operator can never set', () => {
  test.each(['org_id', 'org_role', 'org_perms'])('%s is reserved', (name) => {
    expect(RESERVED_CLAIM_NAMES as readonly string[]).toContain(name)
  })

  test.each(['org_id', 'org_role', 'org_perms'])(
    'a JWT template with a claim named %s is not a document that can be saved',
    (name) => {
      const parsed = EnvironmentSettingsSchema.safeParse({
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        sessions: {
          jwtTemplates: { app: { claims: { [name]: { value: 'admin' } } } },
          profiles: { web: { jwtTemplate: 'app' } },
        },
      })
      expect(parsed.success).toBe(false)
    }
  )

  test('a stored template that holds one anyway cannot put it into a token', async () => {
    const acme = await organization()
    await join(acme, MAYA, 'member')
    // Written by another version of the server, around the schema.
    revision += 1
    deps.environmentSettings.seed(tenant.environmentId, {
      revision,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
        sessions: {
          ...DEFAULT_ENVIRONMENT_SETTINGS.sessions,
          jwtTemplates: { app: { claims: { org_role: { value: 'owner' } } } },
          profiles: {
            ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles,
            mobile: {
              ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles.mobile,
              jwtTemplate: 'app',
            },
          },
        },
      } as never,
    })
    const tokens = await create()
    const claims = claimsOf(await setActive(tokens, acme.id))
    expect(claims.org_role).toBe('member')
    expect(JSON.stringify(claims)).not.toContain('owner')
  })
})
