import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type AccessTokenClaims,
  customClaimsBytes,
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsSchema,
  type JwtTemplate,
  jwtTemplateMaxBytes,
  MAX_CUSTOM_CLAIMS_BYTES,
  MAX_EMAIL_CLAIM_BYTES,
  RESERVED_CLAIM_NAMES,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import type { Tenant } from '~/dependencies'
import { parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import { verifyAccessToken } from '~/middleware/session-auth'
import * as Audit from '~/modules/audit/service'
import * as CustomClaims from '~/modules/session/custom-claims'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const USER = '00000000-0000-7000-8000-0000000000a1'
const EMAIL = 'Maya@Northline.app'
const APP: JwtTemplate = {
  claims: {
    email: { from: 'user.email' },
    verified: { from: 'user.email_verified' },
    since: { from: 'user.created_at' },
    client: { from: 'session.client' },
    signed_in: { from: 'session.created_at' },
    role: { value: 'member' },
    seats: { value: 3 },
    beta: { value: false },
  },
}
let deps: TestDeps
let revision = 0

beforeEach(() => {
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
})

/** Save a `sessions` section (validated like a real document). */
function configure(sessions: unknown, target: Tenant = tenant): void {
  const settings = EnvironmentSettingsSchema.parse({ ...DEFAULT_ENVIRONMENT_SETTINGS, sessions })
  revision += 1
  deps.environmentSettings.seed(target.environmentId, { revision, settings })
}

/** Store a `sessions` section as it is, the way a document written by another version is. */
function store(sessions: unknown): void {
  revision += 1
  deps.environmentSettings.seed(tenant.environmentId, {
    revision,
    settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, sessions } as never,
  })
}

async function addUser(
  overrides: { id?: string; email?: string; verified?: boolean; target?: Tenant } = {}
): Promise<void> {
  const target = overrides.target ?? tenant
  const email = overrides.email ?? EMAIL
  await deps.users.create(
    {
      id: overrides.id ?? USER,
      projectId: target.projectId,
      environmentId: target.environmentId,
      email,
      emailNormalized: email.toLowerCase(),
      emailVerifiedAt: overrides.verified === false ? null : deps.clock.now(),
      firstName: 'Maya',
      lastName: 'Okafor',
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: 'hash',
    },
    Audit.none('fixture')
  )
}

function create(
  overrides: Partial<Sessions.CreateInput> = {},
  target: Tenant = tenant
): Promise<Sessions.IssuedSession> {
  return Sessions.create(deps, target, { userId: USER, client: 'web', ...overrides })
}

function decoded(tokens: { accessToken?: string }): AccessTokenClaims {
  if (!tokens.accessToken) {
    throw new Error('expected an access token')
  }
  return decodeJwt<AccessTokenClaims>(tokens.accessToken)
}

function refreshToken(tokens: Sessions.IssuedSession): string {
  if (!tokens.refreshToken) {
    throw new Error('expected a refresh token')
  }
  return tokens.refreshToken
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000)

/** The claim names of a token issued before templates existed. */
const CLAIMS_WITHOUT_A_TEMPLATE = [
  'amr',
  'aud',
  'auth_time',
  'eid',
  'exp',
  'iat',
  'iss',
  'pid',
  'sid',
  'sp',
  'sub',
  'v',
]

describe('a token without a template is unchanged', () => {
  test('its claims are exactly the set a token had before templates existed', async () => {
    await addUser()
    const tokens = await create()
    expect(Object.keys(decoded(tokens)).sort()).toEqual(CLAIMS_WITHOUT_A_TEMPLATE)
    const refreshed = await Sessions.refresh(deps, tenant, refreshToken(tokens))
    expect(Object.keys(decoded(refreshed)).sort()).toEqual(CLAIMS_WITHOUT_A_TEMPLATE)
  })

  test('a template the profile does not use adds nothing', async () => {
    await addUser()
    configure({ jwtTemplates: { app: APP } })
    expect(Object.keys(decoded(await create())).sort()).toEqual(CLAIMS_WITHOUT_A_TEMPLATE)
  })

  test('a template with no claim adds no namespace claim, not even an empty one', async () => {
    await addUser()
    configure({ jwtTemplates: { app: { claims: {} } }, profiles: { web: { jwtTemplate: 'app' } } })
    expect(Object.keys(decoded(await create())).sort()).toEqual(CLAIMS_WITHOUT_A_TEMPLATE)
  })

  test('a template whose every claim has no value for this user adds no namespace claim', async () => {
    // No stored user: every `user.*` source is without a value.
    configure({
      jwtTemplates: {
        app: {
          claims: { email: { from: 'user.email' }, verified: { from: 'user.email_verified' } },
        },
      },
      profiles: { web: { jwtTemplate: 'app' } },
    })
    expect(Object.keys(decoded(await create())).sort()).toEqual(CLAIMS_WITHOUT_A_TEMPLATE)
  })

  test('the claims a server sets are all reserved', async () => {
    await addUser()
    for (const claim of Object.keys(decoded(await create()))) {
      expect(RESERVED_CLAIM_NAMES as readonly string[]).toContain(claim)
    }
  })

  test('a session bound to a device key adds cnf, which is reserved, and nothing else', async () => {
    await addUser()
    // Device binding (ADR 0043): the one claim a bound session's token has beyond the others.
    const claims = decoded(await create({ client: 'ios', deviceThumbprint: 'A'.repeat(43) }))
    expect(claims.cnf).toEqual({ jkt: 'A'.repeat(43) })
    expect(Object.keys(claims).sort()).toEqual([...CLAIMS_WITHOUT_A_TEMPLATE, 'cnf'].sort())
    for (const claim of Object.keys(claims)) {
      expect(RESERVED_CLAIM_NAMES as readonly string[]).toContain(claim)
    }
  })
})

describe('a template’s claims', () => {
  beforeEach(async () => {
    await addUser()
    configure({ jwtTemplates: { app: APP }, profiles: { web: { jwtTemplate: 'app' } } })
  })

  test('are issued under the one namespace claim, each from its own source', async () => {
    const now = deps.clock.now()
    const claims = decoded(await create())
    expect(claims.ext).toEqual({
      email: 'maya@northline.app',
      verified: true,
      since: seconds(now),
      client: 'web',
      signed_in: seconds(now),
      role: 'member',
      seats: 3,
      beta: false,
    })
    expect(Object.keys(claims).sort()).toEqual([...CLAIMS_WITHOUT_A_TEMPLATE, 'ext'].sort())
  })

  test('the token still verifies, and the server’s own claims are untouched', async () => {
    const tokens = await create()
    const claims = await verifyAccessToken(deps, tokens.accessToken ?? '', tenant)
    expect(claims.sub).toBe(USER)
    expect(claims.sid).toBe(tokens.sessionId)
    expect(claims.sp).toBe('web')
    expect(claims.ext?.role).toBe('member')
  })

  test('only the profile that names the template carries them', async () => {
    expect(decoded(await create({ client: 'ios' })).ext).toBeUndefined()
    expect(decoded(await create({ client: 'web' })).ext).toBeDefined()
  })

  test('are read again at every refresh: a newly verified address shows up', async () => {
    await addUser({ id: 'u2', email: 'new@northline.app', verified: false })
    const tokens = await create({ userId: 'u2' })
    expect(decoded(tokens).ext).toMatchObject({ email: 'new@northline.app', verified: false })
    await deps.users.markEmailVerified(
      tenant.environmentId,
      'u2',
      deps.clock.now(),
      Audit.none('fixture')
    )
    deps.clock.advance('1m')
    const refreshed = await Sessions.refresh(deps, tenant, refreshToken(tokens))
    expect(decoded(refreshed).ext).toMatchObject({ verified: true })
  })

  // The two times are different facts. Everywhere else in this file the user and the session
  // begin at the same instant of the fixed clock, where reading one for the other goes unseen.
  test('`user.created_at` and `session.created_at` are each their own time', async () => {
    expect(deps.clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z')
    deps.clock.advance('3d')
    const tokens = await create()
    expect(decoded(tokens).ext).toMatchObject({ since: 1_767_225_600, signed_in: 1_767_484_800 })
    deps.clock.advance('30s')
    const refreshed = await Sessions.refresh(deps, tenant, refreshToken(tokens))
    expect(decoded(refreshed).ext).toMatchObject({
      since: 1_767_225_600,
      signed_in: 1_767_484_800,
    })
  })

  test('`session.created_at` does not move with a refresh or a step-up', async () => {
    const signedIn = seconds(deps.clock.now())
    const tokens = await create()
    deps.clock.advance('5m')
    const refreshed = await Sessions.refresh(deps, tenant, refreshToken(tokens))
    expect(decoded(refreshed).ext?.signed_in).toBe(signedIn)
    deps.clock.advance('5m')
    const stepped = await Sessions.recordAuthentication(
      deps,
      tenant,
      { userId: USER, sessionId: tokens.sessionId },
      ['pwd'],
      TEST_ACTOR
    )
    expect(decoded(stepped).ext).toMatchObject({ signed_in: signedIn, role: 'member' })
    expect(decoded(stepped).auth_time).toBe(signedIn + 600)
  })

  test('a refresh replayed inside the grace window carries them too', async () => {
    const tokens = await create()
    await Sessions.refresh(deps, tenant, refreshToken(tokens))
    const replayed = await Sessions.refresh(deps, tenant, refreshToken(tokens))
    expect(decoded(replayed).ext?.role).toBe('member')
  })

  test('a template changed between sign-in and refresh applies at the refresh', async () => {
    const tokens = await create()
    configure({
      jwtTemplates: { app: { claims: { role: { value: 'owner' } } } },
      profiles: { web: { jwtTemplate: 'app' } },
    })
    const refreshed = await Sessions.refresh(deps, tenant, refreshToken(tokens))
    expect(decoded(refreshed).ext).toEqual({ role: 'owner' })
  })

  test('a profile that stops using its template stops carrying claims at the next refresh', async () => {
    const tokens = await create()
    configure({ jwtTemplates: { app: APP } })
    const refreshed = await Sessions.refresh(deps, tenant, refreshToken(tokens))
    expect(Object.keys(decoded(refreshed)).sort()).toEqual(CLAIMS_WITHOUT_A_TEMPLATE)
  })

  test('another environment’s template is never applied', async () => {
    await addUser({ target: otherTenant })
    const theirs = decoded(await create({}, otherTenant))
    expect(theirs.ext).toBeUndefined()

    configure(
      {
        jwtTemplates: { app: { claims: { role: { value: 'theirs' } } } },
        profiles: { web: { jwtTemplate: 'app' } },
      },
      otherTenant
    )
    expect(decoded(await create({}, otherTenant)).ext).toEqual({ role: 'theirs' })
    expect(decoded(await create()).ext?.role).toBe('member')
  })

  test('a user of another environment with the same id contributes nothing', async () => {
    // The session's user is looked up in the session's own environment only.
    configure(
      {
        jwtTemplates: { app: { claims: { email: { from: 'user.email' } } } },
        profiles: { web: { jwtTemplate: 'app' } },
      },
      otherTenant
    )
    expect(decoded(await create({}, otherTenant)).ext).toBeUndefined()
  })
})

describe('a source with no value', () => {
  test('leaves its key out instead of writing null', async () => {
    // A user who is gone (or was never stored) has no address; the session's facts remain.
    configure({
      jwtTemplates: {
        app: { claims: { email: { from: 'user.email' }, client: { from: 'session.client' } } },
      },
      profiles: { web: { jwtTemplate: 'app' } },
    })
    expect(decoded(await create()).ext).toEqual({ client: 'web' })
  })
})

describe('what reaches a claim', () => {
  test('nothing the request said: not the IP address, not the user agent, not a name', async () => {
    await addUser()
    configure({ jwtTemplates: { app: APP }, profiles: { web: { jwtTemplate: 'app' } } })
    const tokens = await create({ userAgent: 'CANARY-agent/1.0', ipAddress: '203.0.113.77' })
    const payload = JSON.stringify(decoded(tokens))
    expect(payload).not.toContain('CANARY')
    expect(payload).not.toContain('203.0.113.77')
    expect(payload).not.toContain('Okafor')
  })

  // A store hands back what a newer server wrote; the contract's reader drops what this
  // version does not know, and the service does not depend on that having happened.
  test('a source this version does not have yields nothing, and the rest is issued', async () => {
    await addUser()
    store({
      ...DEFAULT_ENVIRONMENT_SETTINGS.sessions,
      jwtTemplates: {
        app: { claims: { ip: { from: 'session.ip_address' }, role: { value: 'member' } } },
      },
      profiles: {
        ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles,
        web: { ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles.web, jwtTemplate: 'app' },
      },
    })
    expect(decoded(await create({ ipAddress: '203.0.113.77' })).ext).toEqual({ role: 'member' })
  })

  test('a stored profile naming a template that is gone signs in, without custom claims', async () => {
    await addUser()
    store({
      ...DEFAULT_ENVIRONMENT_SETTINGS.sessions,
      profiles: {
        ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles,
        web: { ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles.web, jwtTemplate: 'constructor' },
      },
    })
    expect(Object.keys(decoded(await create())).sort()).toEqual(CLAIMS_WITHOUT_A_TEMPLATE)
  })
})

describe('the size cap when a token is built', () => {
  const session = { client: 'web' as const, createdAt: new Date(0) }

  test('the save-time bound holds for the longest address Tula accepts', () => {
    const local = 'a'.repeat(64)
    const longest = `${local}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(59)}.com`
    expect(longest).toHaveLength(320)
    expect(parseEmail(longest)).not.toBeNull()
    expect(parseEmail(`a${longest}`)).toBeNull()
    expect(customClaimsBytes({ e: longest }) - '{"e":}'.length).toBeLessThanOrEqual(
      MAX_EMAIL_CLAIM_BYTES
    )
  })

  test('claims within the cap are returned', () => {
    const template: JwtTemplate = { claims: { role: { value: 'x'.repeat(256) } } }
    expect(jwtTemplateMaxBytes(template)).toBeLessThanOrEqual(MAX_CUSTOM_CLAIMS_BYTES)
    expect(CustomClaims.build({ name: 'app', template }, { user: null, session })).toEqual({
      role: 'x'.repeat(256),
    })
  })

  // Unreachable through the settings API (a template that could exceed the cap is refused
  // when it is saved); this is the defence behind it.
  test('claims over the cap are dropped whole, named in a warning, and never truncated', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const user = {
        emailNormalized: `${'x'.repeat(2000)}@northline.app`,
        emailVerifiedAt: null,
        createdAt: new Date(0),
      }
      const template: JwtTemplate = {
        claims: { email: { from: 'user.email' }, role: { value: 'member' } },
      }
      expect(CustomClaims.build({ name: 'app', template }, { user, session })).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      const logged = JSON.stringify(warn.mock.calls[0])
      expect(logged).toContain('app')
      expect(logged).not.toContain('northline')
      expect(logged).not.toContain('member')
    } finally {
      warn.mockRestore()
    }
  })

  test('a later source of claims is merged under the same namespace and the same cap', () => {
    const template: JwtTemplate = { claims: { role: { value: 'member' } } }
    const merged = CustomClaims.build({ name: 'app', template }, { user: null, session }, [
      { plan: 'pro' },
    ])
    expect(merged).toEqual({ role: 'member', plan: 'pro' })
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      expect(
        CustomClaims.build({ name: 'app', template }, { user: null, session }, [
          { big: 'x'.repeat(MAX_CUSTOM_CLAIMS_BYTES) },
        ])
      ).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  test('a later source cannot set a reserved or malformed key, or a value that is not a scalar', () => {
    const extra = [{ sub: 'someone', 'bad-key': 1, nested: { a: 1 } as never, ok: true }]
    expect(CustomClaims.build(null, { user: null, session }, extra)).toEqual({ ok: true })
  })
})

describe('a stateful session', () => {
  beforeEach(async () => {
    await addUser()
    configure({
      jwtTemplates: { app: APP },
      profiles: { web: { type: 'stateful', jwtTemplate: 'app' } },
    })
  })

  test('answers its check with the same custom claims a token would carry', async () => {
    const now = deps.clock.now()
    const tokens = await create()
    expect(tokens.accessToken).toBeUndefined()
    const claims = await Sessions.authenticate(deps, tenant, tokens.sessionToken ?? '')
    expect(claims.ext).toEqual({
      email: 'maya@northline.app',
      verified: true,
      since: seconds(now),
      client: 'web',
      signed_in: seconds(now),
      role: 'member',
      seats: 3,
      beta: false,
    })
  })

  test('reads them on every check, also one that writes nothing', async () => {
    const tokens = await create()
    await Sessions.authenticate(deps, tenant, tokens.sessionToken ?? '')
    configure({
      jwtTemplates: { app: { claims: { role: { value: 'owner' } } } },
      profiles: { web: { type: 'stateful', jwtTemplate: 'app' } },
    })
    const touch = spyOn(deps.sessions, 'touch')
    const claims = await Sessions.authenticate(deps, tenant, tokens.sessionToken ?? '')
    expect(touch).not.toHaveBeenCalled()
    expect(claims.ext).toEqual({ role: 'owner' })
  })

  test('without a template its answer has no namespace claim', async () => {
    configure({ profiles: { web: { type: 'stateful' } } })
    const tokens = await create()
    const claims = await Sessions.authenticate(deps, tenant, tokens.sessionToken ?? '')
    expect(Object.keys(claims).sort()).toEqual(CLAIMS_WITHOUT_A_TEMPLATE)
  })
})

describe('what a template costs', () => {
  test('a refresh reads the user once, with or without a template', async () => {
    await addUser()
    const plain = await create()
    const find = spyOn(deps.users, 'findById')
    await Sessions.refresh(deps, tenant, refreshToken(plain))
    const without = find.mock.calls.length
    expect(without).toBe(1)

    configure({ jwtTemplates: { app: APP }, profiles: { web: { jwtTemplate: 'app' } } })
    const templated = await create()
    find.mockClear()
    await Sessions.refresh(deps, tenant, refreshToken(templated))
    expect(find.mock.calls.length).toBe(without)
  })

  test('a sign-in reads the user only for a template that has a user source', async () => {
    await addUser()
    const find = spyOn(deps.users, 'findById')
    await create()
    expect(find).not.toHaveBeenCalled()

    configure({
      jwtTemplates: {
        app: { claims: { role: { value: 'member' }, c: { from: 'session.client' } } },
      },
      profiles: { web: { jwtTemplate: 'app' } },
    })
    await create()
    expect(find).not.toHaveBeenCalled()

    configure({ jwtTemplates: { app: APP }, profiles: { web: { jwtTemplate: 'app' } } })
    await create()
    expect(find).toHaveBeenCalledTimes(1)
  })

  test('a stateful check reads the user only for a template that has a user source', async () => {
    await addUser()
    configure({
      jwtTemplates: { app: { claims: { role: { value: 'member' } } } },
      profiles: { web: { type: 'stateful', jwtTemplate: 'app' } },
    })
    const tokens = await create()
    const find = spyOn(deps.users, 'findById')
    await Sessions.authenticate(deps, tenant, tokens.sessionToken ?? '')
    expect(find).not.toHaveBeenCalled()
  })
})

describe('a user with no email address (an account made through X or Facebook)', () => {
  const session = { client: 'web' as const, createdAt: new Date('2026-01-01T00:00:00Z') }
  const createdAt = new Date('2025-06-01T00:00:00Z')
  const addressless = { emailNormalized: null, emailVerifiedAt: null, createdAt }
  const both: JwtTemplate = {
    claims: { email: { from: 'user.email' }, verified: { from: 'user.email_verified' } },
  }

  test('has neither the address nor whether it is verified: no value, no key', () => {
    const template: JwtTemplate = {
      claims: { ...both.claims, since: { from: 'user.created_at' }, role: { value: 'member' } },
    }
    expect(CustomClaims.build({ name: 'app', template }, { user: addressless, session })).toEqual({
      since: seconds(createdAt),
      role: 'member',
    })
  })

  test('and no namespace claim at all when those two were the template’s only claims', async () => {
    expect(
      CustomClaims.build({ name: 'app', template: both }, { user: addressless, session })
    ).toBeUndefined()
    // Through a real token: exactly the claim set of a profile without a template.
    await deps.users.create(
      {
        id: USER,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        email: null,
        emailNormalized: null,
        emailVerifiedAt: null,
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: deps.ids.next(),
        credentialId: deps.ids.next(),
        passwordHash: null,
        oauthIdentity: { id: deps.ids.next(), provider: 'x', subject: '2244994945' },
      },
      Audit.none('fixture')
    )
    configure({ jwtTemplates: { app: both }, profiles: { web: { jwtTemplate: 'app' } } })
    const tokens = await create()
    expect(Object.keys(decoded(tokens)).sort()).toEqual(CLAIMS_WITHOUT_A_TEMPLATE)
    const refreshed = await Sessions.refresh(deps, tenant, refreshToken(tokens))
    expect(Object.keys(decoded(refreshed)).sort()).toEqual(CLAIMS_WITHOUT_A_TEMPLATE)
  })

  test('an address that is there and not proven is still `false`: unproven is a value, absent is not', () => {
    const unverified = { emailNormalized: 'maya@northline.app', emailVerifiedAt: null, createdAt }
    expect(
      CustomClaims.build({ name: 'app', template: both }, { user: unverified, session })
    ).toEqual({ email: 'maya@northline.app', verified: false })
  })
})
