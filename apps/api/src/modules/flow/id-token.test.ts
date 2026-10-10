import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { AccessTokenClaims, FlowAttempt, IdTokenStart } from '@tula/contract'
import { decodeJwt } from 'jose'
import { issueMockIdToken, type MockIdTokenClaims, mockOAuthProviders } from '~/adapters/oauth/mock'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Factors from '~/modules/factor/service'
import * as Flows from '~/modules/flow/service'
import { OAuthProviderError } from '~/ports/oauth-provider'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// A native sign-in with a provider's ID token (ADR 0045): the start that hands out a nonce,
// and the exchange that judges a token once. The provider here is the server's mock, whose
// tokens are held to the real adapter's own rule for the claims; the signature check of a
// real Google token is `adapters/oauth/google-id-token.test.ts`.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'Sunlit-harbor-42-orchid'
const WEB = '1234567890-webclient0000000000000000000000.apps.googleusercontent.com'
const ANDROID = '1234567890-androidclient00000000000000000.apps.googleusercontent.com'
const IOS = '1234567890-iosclient000000000000000000000.apps.googleusercontent.com'
const STRANGER = '9999999999-someoneelsesapp00000000000000.apps.googleusercontent.com'

let deps: TestDeps
let app: ReturnType<typeof createApp>
const spies: { mockRestore(): void }[] = []

beforeEach(async () => {
  deps = createTestDeps()
  Object.assign(deps, {
    oauth: mockOAuthProviders({
      secretBox: deps.secretBox,
      clock: deps.clock,
      publicUrl: deps.config.publicUrl,
    }),
  })
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  app = createApp(deps)
  await configure({ additionalClientIds: [ANDROID, IOS] })
})

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

const json = async <T>(res: Response) => (await res.json()) as T
const codeOf = async (res: Response) => (await json<{ code: string }>(res)).code

function admin(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  return app.request(`/v1/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json', ...extra },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

async function configure(change: Record<string, unknown> = {}) {
  const res = await admin('PUT', '/oauth-providers/google', {
    clientId: WEB,
    clientSecret: 'GOCSPX-test-client-secret-value',
    ...change,
  })
  expect(res.status).toBe(200)
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
  options: { kind?: string | null; secret?: string; headers?: Record<string, string> } = {}
) {
  return app.request(`/v1/client${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
      ...(options.kind !== null && { 'x-tula-client': options.kind ?? 'android' }),
      ...(options.secret !== undefined && { 'x-tula-attempt': options.secret }),
      ...options.headers,
    },
    body: JSON.stringify(body),
  })
}

const startWith = (body: unknown = { provider: 'google' }, kind?: string | null) =>
  client('/sign-ins/id-token', body, { kind })

async function started(kind = 'android') {
  const res = await startWith({ provider: 'google' }, kind)
  expect(res.status).toBe(200)
  const body = await json<IdTokenStart>(res)
  return { id: body.attempt.id, secret: body.attempt.attemptSecret as string, nonce: body.nonce }
}

type Started = Awaited<ReturnType<typeof started>>

/** A token as Android's Credential Manager gets it: the web client as `aud`, the app as `azp`. */
function token(
  nonce: string | undefined,
  change: Partial<MockIdTokenClaims> = {},
  expired = false
) {
  return issueMockIdToken(
    deps.secretBox,
    deps.clock,
    'google',
    {
      aud: WEB,
      azp: ANDROID,
      sub: 'google-subject-1',
      ...(nonce !== undefined && { nonce }),
      email: EMAIL,
      email_verified: true,
      ...change,
    },
    { expired }
  )
}

const exchange = (attempt: Pick<Started, 'id'> & { secret?: string }, idToken: string) =>
  client(`/sign-ins/${attempt.id}/id-token`, { idToken }, { secret: attempt.secret })

type Done = FlowAttempt & { session: NonNullable<FlowAttempt['session']> }

async function signedIn(change: Partial<MockIdTokenClaims> = {}): Promise<Done> {
  const attempt = await started()
  const res = await exchange(attempt, await token(attempt.nonce, change))
  expect(res.status).toBe(200)
  const done = await json<FlowAttempt>(res)
  expect(done.step.status).toBe('complete')
  return done as Done
}

const actions = () => deps.activityLog.entries.map((entry) => entry.type)
const sessionsCreated = () => actions().filter((type) => type === 'session.created').length

async function seedPasswordUser(verified = true) {
  const res = await admin('POST', '/users', {
    email: EMAIL,
    password: PASSWORD,
    emailVerified: verified,
  })
  expect(res.status).toBe(201)
  return (await json<{ id: string }>(res)).id
}

/** A refused exchange: the generic failed sign-in, and nothing came of it. */
async function refused(res: Response) {
  expect(res.status).toBe(401)
  expect(res.headers.get('set-cookie')).toBeNull()
  expect(await codeOf(res)).toBe('auth.invalid_credentials')
  expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toBeNull()
  expect(sessionsCreated()).toBe(0)
  expect(actions()).not.toContain('user.created')
}

describe('starting a native ID-token sign-in', () => {
  test('answers an attempt offering only the provider, its secret and a nonce', async () => {
    const res = await startWith()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('set-cookie')).toBeNull()
    const body = await json<IdTokenStart>(res)
    expect(body.attempt.kind).toBe('sign_in')
    expect(body.attempt.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['oauth_google'],
    })
    expect(body.attempt.attemptSecret).toMatch(/^tula_at_/)
    // 32 random bytes, base64url without padding: what both platforms' SDKs take as it is.
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Object.keys(body).sort()).toEqual(['attempt', 'nonce'])
  })

  test('every start has a nonce of its own', async () => {
    const nonces = new Set([
      (await started()).nonce,
      (await started()).nonce,
      (await started('ios')).nonce,
    ])
    expect(nonces.size).toBe(3)
  })

  test.each([['web'], ['server'], [null]])(
    'a client that is not a native app is refused: %s',
    async (kind) => {
      const create = spyOn(deps.flowAttempts, 'create')
      spies.push(create)
      const res = await startWith({ provider: 'google' }, kind)
      expect(res.status).toBe(422)
      const body = await json<{ code: string; errors: { field: string }[] }>(res)
      expect(body.code).toBe('validation.failed')
      expect(body.errors.map((error) => error.field)).toEqual(['x-tula-client'])
      expect(create).not.toHaveBeenCalled()
    }
  )

  test.each([
    ['a provider with no ID-token exchange', { provider: 'github' }],
    ['a provider that does not exist', { provider: 'nobody' }],
    ['no provider', {}],
    [
      'a redirect URL beside the provider',
      { provider: 'google', redirectUrl: 'https://a.test/cb' },
    ],
    ['a nonce of the client’s own', { provider: 'google', nonce: 'mine' }],
  ])('refused with a 422 and no attempt: %s', async (_name, body) => {
    const create = spyOn(deps.flowAttempts, 'create')
    spies.push(create)
    expect((await startWith(body)).status).toBe(422)
    expect(create).not.toHaveBeenCalled()
  })

  test('a provider that is off, or not configured, is auth.method_disabled and starts nothing', async () => {
    const create = spyOn(deps.flowAttempts, 'create')
    spies.push(create)
    // The password stays on, so that Google is not the environment’s last way in.
    await saveSettings({ signIn: { methods: { password: { enabled: true } } } })
    await configure({ additionalClientIds: [ANDROID], enabled: false })
    const off = await startWith()
    expect(off.status).toBe(403)
    expect(await json<{ code: string; params: unknown }>(off)).toMatchObject({
      code: 'auth.method_disabled',
      params: { method: 'oauth_google' },
    })
    expect((await admin('DELETE', '/oauth-providers/google')).status).toBe(204)
    expect(await codeOf(await startWith())).toBe('auth.method_disabled')
    expect(create).not.toHaveBeenCalled()
  })

  test('a provider whose adapter cannot verify an ID token is auth.method_disabled', async () => {
    const google = deps.oauth.google as { verifyIdToken?: unknown }
    delete google.verifyIdToken
    expect(await codeOf(await startWith())).toBe('auth.method_disabled')
  })

  test('is counted under the environment’s ceiling, after the provider was found on', async () => {
    const key = Flows.environmentKey('oauth', TEST_TENANT)
    for (let i = 0; i < Flows.ENVIRONMENT_RATE_LIMITS.oauth; i += 1) {
      await deps.rateLimiter.hit(key, Flows.ENVIRONMENT_RATE_LIMITS.oauth, 60_000)
    }
    const res = await startWith()
    expect(res.status).toBe(429)
    expect(await codeOf(res)).toBe('rate_limited')
  })

  test('the answer is the same whoever has an account', async () => {
    const before = await json<IdTokenStart>(await startWith())
    await seedPasswordUser()
    const after = await json<IdTokenStart>(await startWith())
    expect(after.attempt.step).toEqual(before.attempt.step)
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  })
})

describe('exchanging an ID token', () => {
  test('a first sign-in creates the account, verified and without a password, and signs in', async () => {
    const attempt = await started()
    const idToken = await token(attempt.nonce, { given_name: 'Maya', family_name: 'Okafor' })
    const res = await exchange(attempt, idToken)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // A native client: the refresh token is in the body and no cookie is set.
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
    expect(
      (await deps.users.listIdentities(TEST_TENANT.environmentId, user?.id ?? '')).map(
        (identity) => identity.provider
      )
    ).toContain('google')
    expect(actions()).toContain('user.created')
    expect(sessionsCreated()).toBe(1)

    // No provider token is stored: not on the attempt, not in an audit entry or an event.
    const kept = JSON.stringify([
      await deps.flowAttempts.findById(TEST_TENANT.environmentId, attempt.id),
      deps.activityLog.entries,
    ])
    expect(kept).not.toContain(idToken)
    expect(kept).not.toContain(attempt.nonce)
  })

  test('the same Google account signs in to the same user, whatever address it reports later', async () => {
    const first = await signedIn()
    const again = await signedIn({ email: 'renamed@elsewhere.test' })
    expect((again.step as { userId: string }).userId).toBe(
      (first.step as { userId: string }).userId
    )
    expect(
      await deps.users.findByEmail(TEST_TENANT.environmentId, 'renamed@elsewhere.test')
    ).toBeNull()
    expect(actions().filter((type) => type === 'user.created')).toHaveLength(1)
  })

  test('a verified Google address is linked to the verified account that has it', async () => {
    const userId = await seedPasswordUser(true)
    const done = await signedIn()
    expect((done.step as { userId: string }).userId).toBe(userId)
    expect(actions()).toContain('user.identity_linked')
    // The password stays: the account's owner proved the address before.
    expect(
      (await deps.users.findByEmailWithPassword(TEST_TENANT.environmentId, EMAIL))?.passwordHash
    ).toEqual(expect.any(String))
  })

  test('an unverified account with that address is never taken over: oauth.account_exists', async () => {
    const userId = await seedPasswordUser(false)
    const attempt = await started()
    const res = await exchange(attempt, await token(attempt.nonce))
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('oauth.account_exists')
    expect(await deps.users.listIdentities(TEST_TENANT.environmentId, userId)).toEqual([])
    expect(sessionsCreated()).toBe(0)
  })

  test.each<[string, Partial<MockIdTokenClaims>, string]>([
    ['an address Google does not vouch for', { email_verified: false }, 'oauth.email_unverified'],
    ['no address', { email: undefined, email_verified: undefined }, 'oauth.email_missing'],
  ])('%s creates nothing', async (_name, change, code) => {
    const attempt = await started()
    const res = await exchange(attempt, await token(attempt.nonce, change))
    expect(await codeOf(res)).toBe(code)
    expect(actions()).not.toContain('user.created')
    expect(sessionsCreated()).toBe(0)
  })

  test('as iOS sends it: the iOS client as aud', async () => {
    await signedIn({ aud: IOS, azp: IOS })
  })

  test('a banned user learns of the ban only after the token was accepted, and gets no session', async () => {
    const first = await signedIn()
    const userId = (first.step as { userId: string }).userId
    expect((await admin('POST', `/users/${userId}/ban`)).status).toBe(200)
    const attempt = await started()
    const res = await exchange(attempt, await token(attempt.nonce))
    expect(await codeOf(res)).toBe('auth.user_banned')
    expect(sessionsCreated()).toBe(1)
  })

  test('a user with a second factor gets needs_second_factor and no tokens', async () => {
    await signedIn()
    const asked = spyOn(Factors, 'requiredFor').mockResolvedValue(['totp'])
    spies.push(asked)
    const attempt = await started()
    const res = await exchange(attempt, await token(attempt.nonce))
    expect(res.status).toBe(200)
    const parked = await json<FlowAttempt>(res)
    expect(parked.step).toMatchObject({ status: 'needs_second_factor', options: ['totp'] })
    expect(parked.session).toBeUndefined()
    expect(asked).toHaveBeenCalled()
    expect(sessionsCreated()).toBe(1)
    // The step is past: the route takes no second token for the attempt.
    const again = await exchange(attempt, await token(attempt.nonce))
    expect(await codeOf(again)).toBe('flow.invalid_step')
  })

  test('where a second factor is required a new account stops at the enrolment, with no session', async () => {
    await saveSettings({ mfa: { policy: 'required' } })
    const attempt = await started()
    const res = await exchange(attempt, await token(attempt.nonce))
    const parked = await json<FlowAttempt>(res)
    expect(parked.step.status).toBe('needs_factor_enrolment')
    expect(parked.session).toBeUndefined()
    expect(sessionsCreated()).toBe(0)
  })
})

describe('a token that is not accepted is the generic failed sign-in', () => {
  test.each<[string, Partial<MockIdTokenClaims>]>([
    ['issued for another app (aud)', { aud: STRANGER, azp: STRANGER }],
    ['issued for our audience to another app (azp)', { azp: STRANGER }],
    [
      'issued for a client id the environment did not list',
      { aud: `1234567890-notlisted.apps.googleusercontent.com`, azp: undefined },
    ],
    ['with another nonce', { nonce: 'the-nonce-of-something-else' }],
    ['with no nonce', { nonce: undefined }],
  ])('%s', async (_name, change) => {
    const attempt = await started()
    await refused(await exchange(attempt, await token(attempt.nonce, change)))
  })

  test('expired', async () => {
    const attempt = await started()
    await refused(await exchange(attempt, await token(attempt.nonce, {}, true)))
  })

  test('not a token', async () => {
    const attempt = await started()
    await refused(await exchange(attempt, 'eyJhbGciOiJub25lIn0.e30.'))
  })

  test('a token minted for another attempt’s nonce', async () => {
    const [mine, theirs] = [await started(), await started()]
    await refused(await exchange(mine, await token(theirs.nonce)))
  })

  test('a good token after a refused one: the nonce went with the first', async () => {
    const attempt = await started()
    await refused(await exchange(attempt, await token('wrong')))
    await refused(await exchange(attempt, await token(attempt.nonce)))
  })

  test('a token that signed in once signs in nowhere else: not on its attempt, not on a new one', async () => {
    const attempt = await started()
    const idToken = await token(attempt.nonce)
    expect((await exchange(attempt, idToken)).status).toBe(200)
    // Its own attempt is complete, and answers as any completed attempt does.
    const replayed = await exchange(attempt, idToken)
    expect(replayed.status).toBe(404)
    expect(await codeOf(replayed)).toBe('flow.not_found')
    // A new attempt has another nonce.
    const fresh = await started()
    const elsewhere = await exchange(fresh, idToken)
    expect(elsewhere.status).toBe(401)
    expect(await codeOf(elsewhere)).toBe('auth.invalid_credentials')
    expect(sessionsCreated()).toBe(1)
  })

  test('two requests at once with one good token end in one session', async () => {
    const attempt = await started()
    const idToken = await token(attempt.nonce)
    const answers = await Promise.all([exchange(attempt, idToken), exchange(attempt, idToken)])
    expect(answers.map((res) => res.status).sort()).toEqual([200, 401])
    expect(sessionsCreated()).toBe(1)
    expect(actions().filter((type) => type === 'user.created')).toHaveLength(1)
  })

  test('the adapter is asked once per attempt, with the environment’s client ids and the attempt’s nonce', async () => {
    const verify = spyOn(deps.oauth.google, 'verifyIdToken' as never) as ReturnType<typeof spyOn>
    spies.push(verify)
    const attempt = await started()
    await exchange(attempt, await token('wrong'))
    await exchange(attempt, await token(attempt.nonce))
    expect(verify).toHaveBeenCalledTimes(1)
    const [, asked] = verify.mock.calls[0] as [unknown, { audiences: string[]; nonce: string }]
    expect(asked.nonce).toBe(attempt.nonce)
    expect(asked.audiences).toEqual(
      [WEB, ANDROID, IOS].sort((a, b) => (a === WEB ? -1 : b === WEB ? 1 : a.localeCompare(b)))
    )
  })

  test('which check failed is a fixed word in the log, and the token is in none', async () => {
    const warned = spyOn(logger, 'warn').mockImplementation(() => undefined)
    spies.push(warned)
    const attempt = await started()
    const idToken = await token(attempt.nonce, { aud: STRANGER })
    await exchange(attempt, idToken)
    await exchange(attempt, idToken)
    const lines = warned.mock.calls.filter(
      ([message]) => message === 'a native ID token was refused'
    )
    expect(lines.map(([, fields]) => fields)).toEqual([
      { environmentId: TEST_TENANT.environmentId, provider: 'google', failure: 'invalid_token' },
      { environmentId: TEST_TENANT.environmentId, provider: 'google', failure: 'nonce_used' },
    ])
    const logged = JSON.stringify(warned.mock.calls)
    expect(logged).not.toContain(idToken)
    expect(logged).not.toContain(EMAIL)
    expect(logged).not.toContain(STRANGER)
  })

  test('keys that could not be fetched are service.unavailable, and the nonce is spent', async () => {
    const verify = spyOn(deps.oauth.google, 'verifyIdToken' as never) as ReturnType<typeof spyOn>
    spies.push(verify)
    verify.mockRejectedValueOnce(new OAuthProviderError('unavailable'))
    const attempt = await started()
    const res = await exchange(attempt, await token(attempt.nonce))
    expect(res.status).toBe(503)
    expect(await codeOf(res)).toBe('service.unavailable')
    await refused(await exchange(attempt, await token(attempt.nonce)))
  })

  test('an error of the adapter that is not the port’s stays a 500, never a failed sign-in', async () => {
    const verify = spyOn(deps.oauth.google, 'verifyIdToken' as never) as ReturnType<typeof spyOn>
    spies.push(verify)
    spies.push(spyOn(logger, 'error').mockImplementation(() => undefined))
    verify.mockRejectedValueOnce(new TypeError('a bug'))
    const attempt = await started()
    expect((await exchange(attempt, await token(attempt.nonce))).status).toBe(500)
  })
})

describe('what is checked before the nonce is taken leaves it to be used', () => {
  async function stillUsable(attempt: Started) {
    const res = await exchange(attempt, await token(attempt.nonce))
    expect(res.status).toBe(200)
    expect((await json<FlowAttempt>(res)).step.status).toBe('complete')
  }

  test.each([
    ['no secret', undefined],
    ['a wrong secret', 'tula_at_not-the-secret'],
  ])('%s: flow.not_found', async (_name, secret) => {
    const attempt = await started()
    const res = await exchange({ id: attempt.id, secret }, await token(attempt.nonce))
    expect(res.status).toBe(404)
    expect(await codeOf(res)).toBe('flow.not_found')
    await stillUsable(attempt)
  })

  test('another attempt’s secret: flow.not_found', async () => {
    const [mine, theirs] = [await started(), await started()]
    const res = await exchange({ id: mine.id, secret: theirs.secret }, await token(mine.nonce))
    expect(await codeOf(res)).toBe('flow.not_found')
    await stillUsable(mine)
  })

  test('the provider switched off mid-attempt: auth.method_disabled, and it completes once it is back', async () => {
    await saveSettings({ signIn: { methods: { password: { enabled: true } } } })
    const attempt = await started()
    await configure({ additionalClientIds: [ANDROID, IOS], enabled: false })
    const res = await exchange(attempt, await token(attempt.nonce))
    expect(await codeOf(res)).toBe('auth.method_disabled')
    await configure({ additionalClientIds: [ANDROID, IOS], enabled: true })
    await stillUsable(attempt)
  })

  test('the environment’s ceiling: rate_limited', async () => {
    const attempt = await started()
    const key = Flows.environmentKey('verify', TEST_TENANT)
    for (let i = 0; i < Flows.ENVIRONMENT_RATE_LIMITS.verify; i += 1) {
      await deps.rateLimiter.hit(key, Flows.ENVIRONMENT_RATE_LIMITS.verify, 60_000)
    }
    const res = await exchange(attempt, await token(attempt.nonce))
    expect(res.status).toBe(429)
    deps.clock.advance('61s')
    await stillUsable(attempt)
  })

  test.each([
    ['an empty token', { idToken: '' }],
    ['no token', {}],
    ['a key beside the token', { idToken: 'x', provider: 'google' }],
    ['a nonce beside the token', { idToken: 'x', nonce: 'mine' }],
    ['a token over the cap', { idToken: 'x'.repeat(8193) }],
  ])('a malformed body is a 422: %s', async (_name, body) => {
    const attempt = await started()
    const res = await client(`/sign-ins/${attempt.id}/id-token`, body, { secret: attempt.secret })
    expect(res.status).toBe(422)
    await stillUsable(attempt)
  })
})

describe('the attempt is an ID-token attempt and nothing else', () => {
  test('a password sign-in’s attempt takes no ID token', async () => {
    await saveSettings({ signIn: { methods: { password: { enabled: true } } } })
    const res = await client('/sign-ins', { identifier: EMAIL })
    const attempt = await json<FlowAttempt>(res)
    const submitted = await exchange(
      { id: attempt.id, secret: attempt.attemptSecret },
      await token('anything')
    )
    expect(await codeOf(submitted)).toBe('flow.invalid_step')
  })

  test('an ID-token attempt takes no password, no emailed code and no browser ticket', async () => {
    const attempt = await started()
    const password = await client(
      `/sign-ins/${attempt.id}/password`,
      { password: PASSWORD },
      { secret: attempt.secret }
    )
    expect([400, 401, 403, 409]).toContain(password.status)
    const ticket = await client('/sign-ins/oauth/exchange', {
      ticket: 'tula_ot_made-up',
      attemptId: attempt.id,
      binding: 'tula_ob_made-up',
    })
    expect(await codeOf(ticket)).toBe('oauth.ticket_invalid')
    expect(sessionsCreated()).toBe(0)
  })

  test('the attempt expires with its nonce', async () => {
    const attempt = await started()
    deps.clock.advance('10m')
    const res = await exchange(attempt, await token(attempt.nonce))
    expect(await codeOf(res)).toBe('flow.not_found')
  })

  test('the client kind of a later request changes nothing: the attempt’s own decides', async () => {
    const attempt = await started('ios')
    const res = await client(
      `/sign-ins/${attempt.id}/id-token`,
      { idToken: await token(attempt.nonce) },
      { secret: attempt.secret, kind: 'web', headers: { origin: 'https://evil.example' } }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(((await json<FlowAttempt>(res)) as Done).session.refreshToken).toEqual(
      expect.any(String)
    )
  })
})

// The same two steps over the fake adapter, which verifies nothing and records what it was
// asked: what reaches the port is the server's own, whatever the request said.
describe('what the adapter is handed', () => {
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
    await configure({ additionalClientIds: [IOS, ANDROID] })
  })

  test('the token as sent, the attempt’s nonce, and the record’s client ids: its own first, then the others', async () => {
    const attempt = await started()
    const res = await client(
      `/sign-ins/${attempt.id}/id-token`,
      { idToken: 'the-token-as-the-app-sent-it' },
      { secret: attempt.secret }
    )
    expect(res.status).toBe(200)
    expect(deps.oauth.google.idTokens).toEqual([
      {
        idToken: 'the-token-as-the-app-sent-it',
        nonce: attempt.nonce,
        audiences: [WEB, ANDROID, IOS],
      },
    ])
    // No code was exchanged and no authorization URL built: there is no browser.
    expect(deps.oauth.google.exchanges).toEqual([])
    expect(deps.oauth.google.requests).toEqual([])
  })

  test('a body that brings an audience or a nonce of its own is refused, and the adapter is not asked', async () => {
    const attempt = await started()
    for (const extra of [{ audience: STRANGER }, { nonce: 'mine' }, { audiences: [STRANGER] }]) {
      const res = await client(
        `/sign-ins/${attempt.id}/id-token`,
        { idToken: 'a-token', ...extra },
        { secret: attempt.secret }
      )
      expect(res.status).toBe(422)
    }
    expect(deps.oauth.google.idTokens).toEqual([])
  })

  test.each([
    ['invalid_token', 401, 'auth.invalid_credentials'],
    ['invalid_profile', 401, 'auth.invalid_credentials'],
    ['invalid_grant', 401, 'auth.invalid_credentials'],
    ['unavailable', 503, 'service.unavailable'],
  ] as const)(
    'the adapter’s %s is %i %s, and the nonce is spent',
    async (failure, status, code) => {
      deps.oauth.google.failure = new OAuthProviderError(failure)
      const attempt = await started()
      const refused = await exchange(attempt, 'a-token')
      expect(refused.status).toBe(status)
      expect(await codeOf(refused)).toBe(code)
      // The adapter would accept now, but the attempt's one token was presented.
      deps.oauth.google.failure = null
      expect(await codeOf(await exchange(attempt, 'a-token'))).toBe('auth.invalid_credentials')
      expect(deps.oauth.google.idTokens).toHaveLength(1)
      expect(sessionsCreated()).toBe(0)
    }
  )
})
