import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { AccessTokenClaims, FlowAttempt, IdTokenStart, NativeApp } from '@tula/contract'
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createAppleProvider } from '~/adapters/oauth/apple'
import { issueMockIdToken, type MockIdTokenClaims, mockOAuthProviders } from '~/adapters/oauth/mock'
import { createApp } from '~/index'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import * as Factors from '~/modules/factor/service'
import * as Flows from '~/modules/flow/service'
import * as OAuth from '~/modules/oauth/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// Native Sign in with Apple (ADR 0047), on the ID-token exchange of ADR 0045: what differs
// for Apple. The audiences are the bundle ids of the environment's registered iOS apps, the
// token carries the SHA-256 of the attempt's nonce, the start is an iOS client's, and the
// name comes beside the token. What the two providers share (the attempt's secret, the
// ceiling, the nonce taken once) is `id-token.test.ts`; the signature check of a real Apple
// token is `adapters/oauth/apple-id-token.test.ts`.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const OTHER_SK = 'tula_sk_live_othersecret000000000000000000'
const EMAIL = 'maya@northline.app'
const RELAY = 'x7k2m9q4@privaterelay.appleid.com'
const PASSWORD = 'Sunlit-harbor-42-orchid'
const SERVICES_ID = 'app.northline.web'
const TEAM = 'A1B2C3D4E5'
const BUNDLE = 'app.northline.ios'
const SECOND_BUNDLE = 'app.northline.ios.beta'
const STRANGER = 'com.someone.else'
const SUBJECT = '001234.5c3f0a1b2d3e4f5a6b7c8d9e0f1a2b3c.0412'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let privateKey: string
const spies: { mockRestore(): void }[] = []

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
    'base64'
  )
  privateKey = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----`
})

beforeEach(async () => {
  deps = createTestDeps()
  Object.assign(deps, {
    oauth: mockOAuthProviders({
      secretBox: deps.secretBox,
      clock: deps.clock,
      publicUrl: deps.config.publicUrl,
    }),
  })
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
  await seedApiKey(deps, OTHER_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
  await configure()
})

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

const json = async <T>(res: Response) => (await res.json()) as T
const codeOf = async (res: Response) => (await json<{ code: string }>(res)).code

function admin(
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
  key = SK
) {
  return app.request(`/v1/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

async function configure(change: Record<string, unknown> = {}) {
  const res = await admin('PUT', '/oauth-providers/apple', {
    clientId: SERVICES_ID,
    teamId: TEAM,
    keyId: 'KEY1234567',
    privateKey,
    ...change,
  })
  expect(res.status).toBe(200)
}

async function registerApp(bundleId = BUNDLE, key = SK): Promise<NativeApp> {
  const res = await admin(
    'POST',
    '/native-apps',
    { platform: 'ios', teamId: TEAM, bundleId },
    {},
    key
  )
  expect(res.status).toBe(201)
  return json<NativeApp>(res)
}

async function removeApp(app: NativeApp) {
  expect((await admin('DELETE', `/native-apps/${app.id}`)).status).toBe(204)
}

async function saveSettings(settings: Record<string, unknown>) {
  const current = await admin('GET', '/settings')
  const res = await admin('PUT', '/settings', settings, {
    'if-match': current.headers.get('etag') ?? '"0"',
  })
  expect(res.status).toBe(200)
}

function client(
  path: string,
  body: unknown,
  options: { kind?: string | null; secret?: string } = {}
) {
  return app.request(`/v1/client${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
      ...(options.kind !== null && { 'x-tula-client': options.kind ?? 'ios' }),
      ...(options.secret !== undefined && { 'x-tula-attempt': options.secret }),
    },
    body: JSON.stringify(body),
  })
}

const startWith = (kind?: string | null, provider = 'apple') =>
  client('/sign-ins/id-token', { provider }, { kind })

async function started() {
  const res = await startWith()
  expect(res.status).toBe(200)
  const body = await json<IdTokenStart>(res)
  return { id: body.attempt.id, secret: body.attempt.attemptSecret as string, nonce: body.nonce }
}

type Started = Awaited<ReturnType<typeof started>>

/**
 * A token as the system's sheet hands it to an app that followed the documentation: the
 * app's bundle id as `aud`, the SHA-256 of the server's nonce, Apple's string booleans.
 * `nonce` is the claim as it is in the token; left out, it is the hash of the attempt's.
 */
function token(
  attempt: Pick<Started, 'nonce'>,
  change: Partial<MockIdTokenClaims> = {},
  expired = false
) {
  return issueMockIdToken(
    deps.secretBox,
    deps.clock,
    'apple',
    {
      aud: BUNDLE,
      sub: SUBJECT,
      nonce: sha256Hex(attempt.nonce),
      nonce_supported: true,
      email: EMAIL,
      email_verified: 'true',
      is_private_email: 'false',
      ...change,
    },
    { expired }
  )
}

const exchange = (
  attempt: Pick<Started, 'id'> & { secret?: string },
  idToken: string,
  name: Record<string, unknown> = {}
) => client(`/sign-ins/${attempt.id}/id-token`, { idToken, ...name }, { secret: attempt.secret })

type Done = FlowAttempt & { session: NonNullable<FlowAttempt['session']> }

async function signedIn(
  change: Partial<MockIdTokenClaims> = {},
  name: Record<string, unknown> = {}
): Promise<Done> {
  const attempt = await started()
  const res = await exchange(attempt, await token(attempt, change), name)
  expect(res.status).toBe(200)
  const done = await json<FlowAttempt>(res)
  expect(done.step.status).toBe('complete')
  return done as Done
}

const userIdOf = (done: FlowAttempt) => (done.step as { userId: string }).userId
const actions = () => deps.activityLog.entries.map((entry) => entry.type)
const sessionsCreated = () => actions().filter((type) => type === 'session.created').length

async function seedPasswordUser(verified = true, email = EMAIL) {
  const res = await admin('POST', '/users', { email, password: PASSWORD, emailVerified: verified })
  expect(res.status).toBe(201)
  return (await json<{ id: string }>(res)).id
}

/** A refused exchange: the generic failed sign-in, and nothing came of it. */
async function refused(res: Response) {
  expect(res.status).toBe(401)
  expect(res.headers.get('set-cookie')).toBeNull()
  expect(await json<Record<string, unknown>>(res)).toEqual({
    status: 401,
    code: 'auth.invalid_credentials',
    detail: expect.any(String),
  })
  expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toBeNull()
  expect(sessionsCreated()).toBe(0)
  expect(actions()).not.toContain('user.created')
}

async function stillUsable(attempt: Started) {
  const res = await exchange(attempt, await token(attempt))
  expect(res.status).toBe(200)
  expect((await json<FlowAttempt>(res)).step.status).toBe('complete')
}

describe('starting a native Apple sign-in', () => {
  test('with an iOS app registered: an attempt offering only Apple, its secret and a nonce', async () => {
    await registerApp()
    const res = await startWith()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('set-cookie')).toBeNull()
    const body = await json<IdTokenStart>(res)
    expect(body.attempt.step).toEqual({ status: 'needs_first_factor', strategies: ['oauth_apple'] })
    expect(body.attempt.attemptSecret).toEqual(expect.any(String))
    // The nonce as the server made it. The hash is the app's to take: it is not in the answer.
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(body)).not.toContain(sha256Hex(body.nonce))
    expect(Object.keys(body).sort()).toEqual(['attempt', 'nonce'])
  })

  test.each([['android'], ['web'], ['server'], [null]])(
    'a client that says %s is refused with a 422 and starts nothing',
    async (kind) => {
      await registerApp()
      const create = spyOn(deps.flowAttempts, 'create')
      spies.push(create)
      const res = await startWith(kind)
      expect(res.status).toBe(422)
      expect(await json<{ code: string; errors: { field: string }[] }>(res)).toMatchObject({
        code: 'validation.failed',
        errors: [{ field: 'x-tula-client' }],
      })
      expect(create).not.toHaveBeenCalled()
    }
  )

  test('an Android client is refused Apple and still starts Google', async () => {
    await registerApp()
    const google = await admin('PUT', '/oauth-providers/google', {
      clientId: '1234567890-web.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-test-client-secret-value',
    })
    expect(google.status).toBe(200)
    expect((await startWith('android', 'apple')).status).toBe(422)
    expect((await startWith('android', 'google')).status).toBe(200)
    expect((await startWith('ios', 'google')).status).toBe(200)
  })

  test('the client kind is judged before anything of the environment: Apple off answers an Android client the same', async () => {
    await registerApp()
    const on = await startWith('android')
    await saveSettings({ signIn: { methods: { password: { enabled: true } } } })
    await configure({ enabled: false })
    const off = await startWith('android')
    expect(off.status).toBe(on.status)
    expect(await off.text()).toBe(await on.text())
  })

  test('with no iOS app registered it is auth.method_disabled, starts nothing and costs nothing', async () => {
    const create = spyOn(deps.flowAttempts, 'create')
    const hit = spyOn(deps.rateLimiter, 'hit')
    spies.push(create, hit)
    const res = await startWith()
    expect(res.status).toBe(403)
    expect(await json<Record<string, unknown>>(res)).toMatchObject({
      code: 'auth.method_disabled',
      params: { method: 'oauth_apple' },
    })
    expect(create).not.toHaveBeenCalled()
    const ceiling = Flows.environmentKey('oauth', TEST_TENANT)
    expect(hit.mock.calls.filter(([key]) => key === ceiling)).toEqual([])
  })

  test('“no iOS app” answers exactly as “Apple is off”', async () => {
    const none = await startWith()
    await registerApp()
    await saveSettings({ signIn: { methods: { password: { enabled: true } } } })
    await configure({ enabled: false })
    const off = await startWith()
    expect(off.status).toBe(none.status)
    expect(await off.text()).toBe(await none.text())
    expect([...off.headers.keys()].sort()).toEqual([...none.headers.keys()].sort())
  })

  test.each<[string, () => Promise<unknown>]>([
    [
      'an Android app',
      async () =>
        admin('POST', '/native-apps', {
          platform: 'android',
          packageName: BUNDLE,
          sha256CertFingerprints: [Array.from({ length: 32 }, () => 'AA').join(':')],
        }),
    ],
    ['an iOS app of another environment', () => registerApp(BUNDLE, OTHER_SK)],
    [
      'a provider record with the bundle id as its client id',
      () => configure({ clientId: BUNDLE }),
    ],
  ])('%s is no audience: the start is still auth.method_disabled', async (_name, arrange) => {
    await arrange()
    expect(await codeOf(await startWith())).toBe('auth.method_disabled')
  })

  test('Apple not configured is auth.method_disabled whatever apps there are', async () => {
    await registerApp()
    await saveSettings({ signIn: { methods: { password: { enabled: true } } } })
    expect((await admin('DELETE', '/oauth-providers/apple')).status).toBe(204)
    expect(await codeOf(await startWith())).toBe('auth.method_disabled')
  })

  test('the answer is the same whoever has an account', async () => {
    await registerApp()
    const before = await json<IdTokenStart>(await startWith())
    await seedPasswordUser()
    const after = await json<IdTokenStart>(await startWith())
    expect(after.attempt.step).toEqual(before.attempt.step)
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  })
})

describe('exchanging an Apple ID token', () => {
  beforeEach(async () => {
    await registerApp()
  })

  test('a first authorization creates the account, verified, without a password, named by what the app passed on', async () => {
    const attempt = await started()
    const idToken = await token(attempt)
    const res = await exchange(attempt, idToken, { givenName: 'Maya', familyName: 'Okafor' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('set-cookie')).toBeNull()
    const done = (await json<FlowAttempt>(res)) as Done
    expect(done.step.status).toBe('complete')
    expect(done.session.refreshToken).toEqual(expect.any(String))
    expect(decodeJwt<AccessTokenClaims>(done.session.accessToken as string).amr).toEqual(['fed'])

    const user = await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)
    expect(user).toMatchObject({ email: EMAIL, firstName: 'Maya', lastName: 'Okafor' })
    expect(user?.emailVerifiedAt).not.toBeNull()
    expect(
      (await deps.users.findByEmailWithPassword(TEST_TENANT.environmentId, EMAIL))?.passwordHash ??
        null
    ).toBeNull()
    const identities = await deps.users.listIdentities(TEST_TENANT.environmentId, user?.id ?? '')
    expect(identities.find((identity) => identity.provider === 'apple')).toMatchObject({
      subject: SUBJECT,
    })

    // Nothing of the token, the nonce in either form, or the name the app passed is kept
    // on the attempt or recorded.
    const kept = JSON.stringify([
      await deps.flowAttempts.findById(TEST_TENANT.environmentId, attempt.id),
      deps.activityLog.entries,
    ])
    expect(kept).not.toContain(idToken)
    expect(kept).not.toContain(attempt.nonce)
    expect(kept).not.toContain(sha256Hex(attempt.nonce))
    expect(kept).not.toContain('Okafor')
    expect(kept).not.toContain(BUNDLE)
  })

  test('a known identity signs in with no address and no name in sight', async () => {
    const first = await signedIn({}, { givenName: 'Maya', familyName: 'Okafor' })
    const again = await signedIn({
      email: undefined,
      email_verified: undefined,
      is_private_email: undefined,
    })
    expect(userIdOf(again)).toBe(userIdOf(first))
    expect(actions().filter((type) => type === 'user.created')).toHaveLength(1)
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toMatchObject({
      firstName: 'Maya',
      lastName: 'Okafor',
    })
  })

  test('a name passed again later changes nothing: it is read for a new account only', async () => {
    const first = await signedIn({}, { givenName: 'Maya' })
    const again = await signedIn({}, { givenName: 'Mallory', familyName: 'Changed' })
    expect(userIdOf(again)).toBe(userIdOf(first))
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toMatchObject({
      firstName: 'Maya',
      lastName: null,
    })
  })

  test('a known identity is its user whatever address Apple reports later', async () => {
    const first = await signedIn()
    const again = await signedIn({ email: RELAY, is_private_email: 'true' })
    expect(userIdOf(again)).toBe(userIdOf(first))
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, RELAY)).toBeNull()
  })

  test('a private relay address is the account’s address, verified', async () => {
    await signedIn({ email: RELAY, is_private_email: 'true' })
    const user = await deps.users.findByEmail(TEST_TENANT.environmentId, RELAY)
    expect(user?.emailVerifiedAt).not.toBeNull()
  })

  test('a first sign-in with no address is oauth.email_missing: Apple is not a provider without addresses', async () => {
    const attempt = await started()
    const res = await exchange(
      attempt,
      await token(attempt, { email: undefined, email_verified: undefined }),
      { givenName: 'Maya' }
    )
    expect(await codeOf(res)).toBe('oauth.email_missing')
    expect(actions()).not.toContain('user.created')
    expect(sessionsCreated()).toBe(0)
  })

  test.each<[string, Partial<MockIdTokenClaims>]>([
    ['"false"', { email_verified: 'false' }],
    ['false', { email_verified: false }],
    ['nothing', { email_verified: undefined }],
  ])('an address Apple does not vouch for (%s) is oauth.email_unverified', async (_n, change) => {
    const attempt = await started()
    const res = await exchange(attempt, await token(attempt, change))
    expect(await codeOf(res)).toBe('oauth.email_unverified')
    expect(actions()).not.toContain('user.created')
  })

  test('email_verified as the boolean true is taken as the string is', async () => {
    await signedIn({ email_verified: true })
  })

  test('a verified Apple address is linked to the verified account that has it', async () => {
    const userId = await seedPasswordUser(true)
    const done = await signedIn()
    expect(userIdOf(done)).toBe(userId)
    expect(actions()).toContain('user.identity_linked')
    expect(
      (await deps.users.findByEmailWithPassword(TEST_TENANT.environmentId, EMAIL))?.passwordHash
    ).toEqual(expect.any(String))
  })

  test('an unverified account with that address is never taken over: oauth.account_exists', async () => {
    const userId = await seedPasswordUser(false)
    const attempt = await started()
    const res = await exchange(attempt, await token(attempt))
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('oauth.account_exists')
    expect(await deps.users.listIdentities(TEST_TENANT.environmentId, userId)).toEqual([])
    expect(sessionsCreated()).toBe(0)
  })

  test('the account is the one the browser flow made: the same subject, the same user', async () => {
    // What the web flow stores for an Apple account is the ID token's `sub`; so does this.
    const user = await deps.users.findByEmail(
      TEST_TENANT.environmentId,
      (await seedVerifiedUserWithAppleIdentity()).email
    )
    const done = await signedIn({ email: undefined, email_verified: undefined })
    expect(userIdOf(done)).toBe(user?.id ?? '')
  })

  async function seedVerifiedUserWithAppleIdentity() {
    const { user } = await OAuth.resolveAccount(
      deps,
      TEST_TENANT,
      'apple',
      { subject: SUBJECT, email: EMAIL, emailVerified: true },
      { ip: '203.0.113.9', userAgent: 'test', client: 'web' } as never,
      'web'
    )
    return { email: user.email as string }
  }

  test('a banned user learns of the ban only after the token was accepted, and gets no session', async () => {
    const first = await signedIn()
    expect((await admin('POST', `/users/${userIdOf(first)}/ban`)).status).toBe(200)
    const attempt = await started()
    const res = await exchange(attempt, await token(attempt))
    expect(await codeOf(res)).toBe('auth.user_banned')
    expect(sessionsCreated()).toBe(1)
  })

  test('a user with a second factor gets needs_second_factor and no tokens', async () => {
    await signedIn()
    const asked = spyOn(Factors, 'requiredFor').mockResolvedValue(['totp'])
    spies.push(asked)
    const attempt = await started()
    const res = await exchange(attempt, await token(attempt))
    expect(res.status).toBe(200)
    const parked = await json<FlowAttempt>(res)
    expect(parked.step).toMatchObject({ status: 'needs_second_factor', options: ['totp'] })
    expect(parked.session).toBeUndefined()
    expect(asked).toHaveBeenCalled()
    expect(sessionsCreated()).toBe(1)
  })

  test('where a second factor is required a new account stops at the enrolment, with no session', async () => {
    await saveSettings({ mfa: { policy: 'required' } })
    const attempt = await started()
    const parked = await json<FlowAttempt>(await exchange(attempt, await token(attempt)))
    expect(parked.step.status).toBe('needs_factor_enrolment')
    expect(parked.session).toBeUndefined()
    expect(sessionsCreated()).toBe(0)
  })

  test('the account is resolved in the one place, as for a browser’s sign-in', async () => {
    const resolve = spyOn(OAuth, 'resolveAccount')
    spies.push(resolve)
    await signedIn({}, { givenName: 'Maya' })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]?.slice(2, 4)).toEqual([
      'apple',
      { subject: SUBJECT, email: EMAIL, emailVerified: true, givenName: 'Maya' },
    ])
  })
})

describe('an Apple token that is not accepted is the generic failed sign-in', () => {
  beforeEach(async () => {
    await registerApp()
  })

  test.each<[string, (attempt: Started) => Partial<MockIdTokenClaims>]>([
    ['another app’s bundle id', () => ({ aud: STRANGER })],
    ['the Services ID of the web flow', () => ({ aud: SERVICES_ID })],
    ['a bundle id nobody registered that starts like ours', () => ({ aud: SECOND_BUNDLE })],
    ['the nonce itself instead of its hash', (attempt) => ({ nonce: attempt.nonce })],
    ['the hash in upper case', (attempt) => ({ nonce: sha256Hex(attempt.nonce).toUpperCase() })],
    ['a hash of something else', () => ({ nonce: sha256Hex('not-the-nonce') })],
    ['no nonce', () => ({ nonce: undefined })],
    ['nonce_supported false', () => ({ nonce_supported: false })],
    ['an azp that is no registered app', () => ({ azp: STRANGER })],
    ['no subject', () => ({ sub: '' })],
  ])('%s', async (_name, change) => {
    const attempt = await started()
    await refused(await exchange(attempt, await token(attempt, change(attempt))))
  })

  test('expired', async () => {
    const attempt = await started()
    await refused(await exchange(attempt, await token(attempt, {}, true)))
  })

  test('not a token, and a token the mock minted for Google', async () => {
    const [first, second] = [await started(), await started()]
    await refused(await exchange(first, 'not-a-token'))
    const google = await issueMockIdToken(deps.secretBox, deps.clock, 'google', {
      aud: BUNDLE,
      sub: SUBJECT,
      nonce: sha256Hex(second.nonce),
      email: EMAIL,
      email_verified: true,
    })
    await refused(await exchange(second, google))
  })

  test('another attempt’s token', async () => {
    const [mine, theirs] = [await started(), await started()]
    await refused(await exchange(mine, await token(theirs)))
  })

  test('a good token after a refused one: the nonce went with the first', async () => {
    const attempt = await started()
    await refused(await exchange(attempt, await token(attempt, { aud: STRANGER })))
    await refused(await exchange(attempt, await token(attempt)))
  })

  test('a token that signed in once signs in nowhere else: not on its attempt, not on a new one', async () => {
    const attempt = await started()
    const idToken = await token(attempt)
    expect((await exchange(attempt, idToken)).status).toBe(200)
    const again = await exchange(attempt, idToken)
    expect(again.status).toBe(404)
    expect(await codeOf(again)).toBe('flow.not_found')
    const next = await started()
    const replayed = await exchange(next, idToken)
    expect(replayed.status).toBe(401)
    expect(await codeOf(replayed)).toBe('auth.invalid_credentials')
    expect(sessionsCreated()).toBe(1)
  })

  test('two requests at once with one good token end in one session', async () => {
    const attempt = await started()
    const idToken = await token(attempt)
    const answers = await Promise.all([exchange(attempt, idToken), exchange(attempt, idToken)])
    expect(answers.map((res) => res.status).sort()).toEqual([200, 401])
    expect(sessionsCreated()).toBe(1)
    expect(actions().filter((type) => type === 'user.created')).toHaveLength(1)
  })

  test('every refusal answers alike, byte for byte', async () => {
    const bodies = new Set<string>()
    const changes: ((attempt: Started) => Partial<MockIdTokenClaims>)[] = [
      () => ({ aud: STRANGER }),
      (attempt) => ({ nonce: attempt.nonce }),
      () => ({ nonce: undefined }),
      () => ({ nonce_supported: false }),
    ]
    for (const change of changes) {
      const attempt = await started()
      const res = await exchange(attempt, await token(attempt, change(attempt)))
      bodies.add(`${res.status} ${await res.text()}`)
    }
    const expired = await started()
    const res = await exchange(expired, await token(expired, {}, true))
    bodies.add(`${res.status} ${await res.text()}`)
    expect(bodies.size).toBe(1)
  })

  test('which check failed is a fixed word in the log; the token, the bundle ids and the name are in none', async () => {
    const warned = spyOn(logger, 'warn').mockImplementation(() => undefined)
    spies.push(warned)
    const attempt = await started()
    const idToken = await token(attempt, { aud: STRANGER })
    await exchange(attempt, idToken, { givenName: 'Maya', familyName: 'Okafor' })
    await exchange(attempt, idToken)
    const lines = warned.mock.calls.filter(
      ([message]) => message === 'a native ID token was refused'
    )
    expect(lines.map(([, fields]) => fields)).toEqual([
      { environmentId: TEST_TENANT.environmentId, provider: 'apple', failure: 'invalid_token' },
      { environmentId: TEST_TENANT.environmentId, provider: 'apple', failure: 'nonce_used' },
    ])
    const logged = JSON.stringify(warned.mock.calls)
    for (const secret of [idToken, EMAIL, STRANGER, BUNDLE, 'Okafor', attempt.nonce]) {
      expect(logged).not.toContain(secret)
    }
  })
})

describe('the audience is the environment’s iOS apps as they are when the token is presented', () => {
  test('an app registered after the start is an audience at the exchange', async () => {
    await registerApp()
    const attempt = await started()
    await registerApp(SECOND_BUNDLE)
    const res = await exchange(attempt, await token(attempt, { aud: SECOND_BUNDLE }))
    expect(res.status).toBe(200)
  })

  test('an app removed mid-attempt takes its audience with it: the token for it is refused', async () => {
    const first = await registerApp()
    await registerApp(SECOND_BUNDLE)
    const attempt = await started()
    const idToken = await token(attempt)
    await removeApp(first)
    await refused(await exchange(attempt, idToken))
    // The other app's users are not touched by it.
    const next = await started()
    expect((await exchange(next, await token(next, { aud: SECOND_BUNDLE }))).status).toBe(200)
  })

  test('the last app removed mid-attempt: auth.method_disabled, nothing used up, and it completes once an app is back', async () => {
    const only = await registerApp()
    const attempt = await started()
    await removeApp(only)
    const hit = spyOn(deps.rateLimiter, 'hit')
    spies.push(hit)
    const res = await exchange(attempt, await token(attempt))
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('auth.method_disabled')
    const ceiling = Flows.environmentKey('verify', TEST_TENANT)
    expect(hit.mock.calls.filter(([key]) => key === ceiling)).toEqual([])
    expect(sessionsCreated()).toBe(0)
    await registerApp()
    await stillUsable(attempt)
  })

  test('Apple switched off mid-attempt: auth.method_disabled, and it completes once it is back', async () => {
    await registerApp()
    await saveSettings({ signIn: { methods: { password: { enabled: true } } } })
    const attempt = await started()
    await configure({ enabled: false })
    expect(await codeOf(await exchange(attempt, await token(attempt)))).toBe('auth.method_disabled')
    await configure({ enabled: true })
    await stillUsable(attempt)
  })

  test('another environment’s app is never an audience', async () => {
    await registerApp()
    await registerApp(SECOND_BUNDLE, OTHER_SK)
    const attempt = await started()
    await refused(await exchange(attempt, await token(attempt, { aud: SECOND_BUNDLE })))
  })

  test('a stored row whose identifier is no bundle id is no audience', async () => {
    await registerApp()
    const rows = await deps.nativeApps.list(TEST_TENANT.environmentId)
    expect(
      OAuth.appleIdTokenAudiences([
        ...rows,
        { platform: 'ios', identifier: '*' },
        { platform: 'ios', identifier: 'nodots' },
        { platform: 'ios', identifier: `a.${'b'.repeat(200)}` },
        { platform: 'android', identifier: 'com.example.android' },
        { platform: 'ios', identifier: BUNDLE },
      ])
    ).toEqual([BUNDLE])
  })
})

// Over the fake adapter, which verifies nothing and records what it was asked: what reaches
// the port is the server's own, whatever the request said.
describe('what the Apple adapter is handed', () => {
  beforeEach(async () => {
    deps = createTestDeps()
    deps.environments.add({
      id: TEST_TENANT.environmentId,
      projectId: TEST_TENANT.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
    await seedApiKey(deps, PK)
    await seedApiKey(deps, SK)
    app = createApp(deps)
    await configure()
    await registerApp(SECOND_BUNDLE)
    await registerApp()
  })

  const fake = () => (deps as TestDeps).oauth.apple

  test('the token as sent, the nonce as the server made it, the bundle ids and nothing of the provider record', async () => {
    const attempt = await started()
    const res = await exchange(attempt, 'the-token-as-the-app-sent-it')
    expect(res.status).toBe(200)
    expect(fake().idTokens).toEqual([
      {
        idToken: 'the-token-as-the-app-sent-it',
        nonce: attempt.nonce,
        audiences: [SECOND_BUNDLE, BUNDLE],
      },
    ])
    expect(JSON.stringify(fake().idTokens)).not.toContain(SERVICES_ID)
    expect(fake().exchanges).toEqual([])
    expect(fake().requests).toEqual([])
  })

  test('the name the app passed on, and only a name', async () => {
    const attempt = await started()
    await exchange(attempt, 'a-token', { givenName: 'Maya', familyName: 'Okafor' })
    expect(fake().idTokens[0]?.user).toEqual({ givenName: 'Maya', familyName: 'Okafor' })
  })

  test.each([
    ['an address', { email: 'victim@northline.app' }],
    ['a subject', { sub: 'someone-else' }],
    ['an audience', { audience: STRANGER }],
    ['a nonce', { nonce: 'mine' }],
    ['Apple’s own user object', { user: { name: { firstName: 'Maya' } } }],
    ['a name that is not a string', { givenName: { toString: 'x' } }],
    ['a name over the cap', { givenName: 'a'.repeat(101) }],
  ])('a body that brings %s is a 422, and the adapter is not asked', async (_name, extra) => {
    const attempt = await started()
    const res = await exchange(attempt, 'a-token', extra)
    expect(res.status).toBe(422)
    expect(fake().idTokens).toEqual([])
  })
})

describe('a name beside a Google token is not read', () => {
  test('Google’s token carries its own names, and the request’s change nothing', async () => {
    const WEB = '1234567890-web.apps.googleusercontent.com'
    expect(
      (
        await admin('PUT', '/oauth-providers/google', {
          clientId: WEB,
          clientSecret: 'GOCSPX-test-client-secret-value',
        })
      ).status
    ).toBe(200)
    const start = await json<IdTokenStart>(await startWith('android', 'google'))
    const idToken = await issueMockIdToken(deps.secretBox, deps.clock, 'google', {
      aud: WEB,
      sub: 'google-subject-1',
      nonce: start.nonce,
      email: EMAIL,
      email_verified: true,
      given_name: 'Maya',
    })
    const res = await client(
      `/sign-ins/${start.attempt.id}/id-token`,
      { idToken, givenName: 'Mallory', familyName: 'Injected' },
      { secret: start.attempt.attemptSecret as string, kind: 'android' }
    )
    expect(res.status).toBe(200)
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toMatchObject({
      firstName: 'Maya',
      lastName: null,
    })
  })
})

describe('with the real Apple adapter', () => {
  // The route, the service and the adapter together; `fetch` is a stub and nothing reaches
  // Apple. The token is signed by a key this test makes.
  const KEYS = 'https://appleid.apple.com/auth/keys'
  let key: { privateKey: CryptoKey; jwk: Record<string, unknown> }
  let calls: string[]

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true })
    key = {
      privateKey: pair.privateKey,
      jwk: { ...(await exportJWK(pair.publicKey)), kid: 'apple-key', alg: 'RS256', use: 'sig' },
    }
  })

  beforeEach(async () => {
    await registerApp()
  })

  function keysAnswer(answer: () => Response | Promise<Response>) {
    calls = []
    Object.assign(deps.oauth, { apple: createAppleProvider() })
    spies.push(
      spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input)
        calls.push(url)
        if (url !== KEYS) {
          throw new Error(`unexpected request to ${url}`)
        }
        return answer()
      }) as typeof fetch)
    )
  }

  const appleToken = (nonce: string, audience = BUNDLE, kid: string | null = 'apple-key') =>
    new SignJWT({ nonce, nonce_supported: true, email: EMAIL, email_verified: 'true' })
      .setProtectedHeader({ alg: 'RS256', ...(kid !== null && { kid }) })
      .setIssuer('https://appleid.apple.com')
      .setAudience(audience)
      .setSubject(SUBJECT)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key.privateKey)

  test('a token Apple signed for the registered app and the hashed nonce signs in', async () => {
    keysAnswer(() => Response.json({ keys: [key.jwk] }))
    const attempt = await started()
    const res = await exchange(attempt, await appleToken(sha256Hex(attempt.nonce)))
    expect(res.status).toBe(200)
    expect(calls).toEqual([KEYS])
  })

  test('the same token with the raw nonce, and one for the Services ID, are refused', async () => {
    keysAnswer(() => Response.json({ keys: [key.jwk] }))
    const [first, second] = [await started(), await started()]
    await refused(await exchange(first, await appleToken(first.nonce)))
    await refused(await exchange(second, await appleToken(sha256Hex(second.nonce), SERVICES_ID)))
  })

  test.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => new Response('down', { status: 500 })],
    ['a page where the keys should be', () => new Response('<html>', { status: 200 })],
    [
      'a request that fails',
      () => {
        throw new TypeError('connection refused')
      },
    ],
  ])('Apple’s keys could not be had (%s): 503, and the nonce is spent', async (_name, answer) => {
    spies.push(spyOn(logger, 'warn').mockImplementation(() => undefined))
    keysAnswer(answer)
    const attempt = await started()
    const idToken = await appleToken(sha256Hex(attempt.nonce))
    const res = await exchange(attempt, idToken)
    expect(res.status).toBe(503)
    expect(await codeOf(res)).toBe('service.unavailable')
    expect(sessionsCreated()).toBe(0)
    // With the keys back the attempt's one token has still been presented.
    keysAnswer(() => Response.json({ keys: [key.jwk] }))
    await refused(await exchange(attempt, idToken))
  })

  test('a token that names no key is the generic failed sign-in, and Apple is not asked', async () => {
    keysAnswer(() => new Response('down', { status: 500 }))
    const attempt = await started()
    await refused(await exchange(attempt, await appleToken(sha256Hex(attempt.nonce), BUNDLE, null)))
    expect(calls).toEqual([])
  })
})
