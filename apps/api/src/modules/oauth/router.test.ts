import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type AccessTokenClaims,
  FLOW_ATTEMPT_HEADER,
  type FlowAttempt,
  type Identity,
  type IdentityLinkStart,
  type OAuthProvider,
  type OAuthProviderSettings,
  type OAuthStart,
  type TotpEnrolment,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import { base32Decode, totp } from '~/lib/totp'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import { OAUTH_INVALID_PAGE } from '~/modules/oauth/router'
import { OAuthProviderError } from '~/ports/oauth-provider'
import type { OAuthProviderRecord } from '~/ports/oauth-provider-store'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const OTHER_PK = 'tula_pk_live_publishable000000000000000000'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const REDIRECT = 'https://app.northline.app/oauth/callback'
const CLIENT_SECRET = 'GOCSPX-test-client-secret-value'

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
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
  await seedApiKey(deps, OTHER_PK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
  await saveSettings({ urls: { allowedRedirectUrls: [REDIRECT] } })
  await configure('google')
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

async function saveSettings(settings: Record<string, unknown>) {
  const current = await admin('GET', '/settings')
  const res = await admin('PUT', '/settings', settings, {
    'if-match': current.headers.get('etag') ?? '"0"',
  })
  expect(res.status).toBe(200)
}

function configure(provider: OAuthProvider, body: Record<string, unknown> = {}) {
  return admin('PUT', `/oauth-providers/${provider}`, {
    clientId: `${provider}-client-id`,
    clientSecret: CLIENT_SECRET,
    ...body,
  })
}

/** A client call. `web` by default is avoided: tokens in the body are easier to assert on. */
function client(
  method: string,
  path: string,
  body?: unknown,
  options: { key?: string; token?: string; secret?: string; kind?: string; origin?: string } = {}
) {
  return app.request(`/v1/client${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tula-publishable-key': options.key ?? PK,
      'x-tula-client': options.kind ?? 'ios',
      ...(options.token && { authorization: `Bearer ${options.token}` }),
      ...(options.secret && { [FLOW_ATTEMPT_HEADER]: options.secret }),
      ...(options.origin && { origin: options.origin }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

async function start(
  provider: OAuthProvider = 'google',
  options: Parameters<typeof client>[3] = {}
) {
  const res = await client('POST', '/sign-ins/oauth', { provider, redirectUrl: REDIRECT }, options)
  expect(res.status).toBe(200)
  const started = await json<OAuthStart>(res)
  return { ...started, state: new URL(started.authorizationUrl).searchParams.get('state') ?? '' }
}

function callback(provider: OAuthProvider, query: Record<string, string>) {
  return app.request(`/v1/oauth/callback/${provider}?${new URLSearchParams(query)}`)
}

/** The fragment parameters of the URL a callback redirected to. */
function fragment(res: Response) {
  expect(res.status).toBe(303)
  const location = res.headers.get('location') ?? ''
  expect(location.startsWith(`${REDIRECT}#`)).toBe(true)
  const params = new URLSearchParams(location.slice(location.indexOf('#') + 1))
  return {
    ticket: params.get('tula_ticket'),
    error: params.get('tula_error'),
    attemptId: params.get('tula_attempt') ?? '',
  }
}

/** Start, "visit the provider" and come back: everything up to the exchange. */
async function roundTrip(provider: OAuthProvider = 'google') {
  const started = await start(provider)
  const returned = fragment(
    await callback(provider, { state: started.state, code: 'provider-code' })
  )
  expect(returned.ticket).toMatch(/^tula_ot_/)
  return { ...started, ticket: returned.ticket as string, attemptId: returned.attemptId }
}

function exchange(body: { ticket: string; attemptId: string; binding?: string }) {
  return client('POST', '/sign-ins/oauth/exchange', body)
}

/** The whole sign-in with the profile the fake provider currently answers. */
async function signInWith(provider: OAuthProvider = 'google') {
  const trip = await roundTrip(provider)
  const res = await exchange(trip)
  return { res, trip }
}

async function completed(provider: OAuthProvider = 'google') {
  const { res } = await signInWith(provider)
  expect(res.status).toBe(200)
  const attempt = await json<FlowAttempt>(res)
  expect(attempt.step.status).toBe('complete')
  return attempt as FlowAttempt & { session: NonNullable<FlowAttempt['session']> }
}

async function seedPasswordUser(email = EMAIL, verified = true) {
  const res = await admin('POST', '/users', { email, password: PASSWORD, emailVerified: verified })
  expect(res.status).toBe(201)
  return (await json<{ id: string }>(res)).id
}

function actions() {
  return deps.activityLog.entries.map((entry) => entry.type)
}

describe('starting an OAuth sign-in', () => {
  test('answers the provider URL, a binding and an attempt offering only that provider', async () => {
    const started = await start()
    expect(started.attempt.kind).toBe('sign_in')
    expect(started.attempt.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['oauth_google'],
    })
    expect(started.attempt.attemptSecret).toMatch(/^tula_at_/)
    expect(started.binding).toMatch(/^tula_ob_/)
    const url = new URL(started.authorizationUrl)
    expect(url.searchParams.get('client_id')).toBe('google-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3003/v1/oauth/callback/google'
    )
    // The state names the environment and the attempt, and ends in 256 random bits.
    expect(started.state.split('.')).toEqual([
      TEST_TENANT.environmentId,
      started.attempt.id,
      expect.stringMatching(/^[\w-]{43}$/),
    ])
  })

  test('keeps the state, the binding and the verifier server-side, hashed where it can', async () => {
    const started = await start()
    const stored = await deps.flowAttempts.findById(TEST_TENANT.environmentId, started.attempt.id)
    const serialized = JSON.stringify(stored)
    expect(serialized).not.toContain(started.state)
    expect(serialized).not.toContain(started.binding)
    expect(serialized).not.toContain(started.attempt.attemptSecret as string)
    const [request] = deps.oauth.google.requests
    // The verifier and nonce never reach the client: only the provider URL is derived from them.
    expect(JSON.stringify(started)).not.toContain(request?.codeVerifier as string)
    expect(serialized).toContain(request?.codeVerifier as string)
    expect(request?.nonce).toHaveLength(43)
  })

  test('is refused for a provider that is not configured, or configured but disabled', async () => {
    const github = await client('POST', '/sign-ins/oauth', {
      provider: 'github',
      redirectUrl: REDIRECT,
    })
    expect(github.status).toBe(403)
    expect(await json(github)).toMatchObject({
      code: 'auth.method_disabled',
      params: { method: 'oauth_github' },
    })
    await configure('github', { enabled: false })
    const disabled = await client('POST', '/sign-ins/oauth', {
      provider: 'github',
      redirectUrl: REDIRECT,
    })
    expect(await codeOf(disabled)).toBe('auth.method_disabled')
    const unknown = await client('POST', '/sign-ins/oauth', {
      provider: 'mock',
      redirectUrl: REDIRECT,
    })
    expect(unknown.status).toBe(422)
  })

  test.each([
    ['a longer path', `${REDIRECT}/extra`],
    ['an added query', `${REDIRECT}?next=/admin`],
    ['an added fragment', `${REDIRECT}#x`],
    ['another case', REDIRECT.replace('oauth', 'OAuth')],
    ['a look-alike host', 'https://app.northline.app.evil.test/oauth/callback'],
    ['credentials in front of the host', 'https://app.northline.app@evil.test/oauth/callback'],
    ['another scheme', 'javascript:alert(1)'],
  ] as [string, string][])('refuses a redirect URL with %s', async (_name, redirectUrl) => {
    // Loopback http is allowed in the local tier, so the list is tested in a deployed one.
    deps.config = { ...deps.config, tier: 'prod' }
    app = createApp(deps)
    const res = await client('POST', '/sign-ins/oauth', { provider: 'google', redirectUrl })
    expect(res.status).toBe(400)
    expect(await codeOf(res)).toBe('request.redirect_not_allowed')
    expect(deps.oauth.google.requests).toHaveLength(0)
  })

  test('a browser attempt from an origin the environment does not allow is refused', async () => {
    deps.config = { ...deps.config, tier: 'prod' }
    app = createApp(deps)
    const res = await client(
      'POST',
      '/sign-ins/oauth',
      { provider: 'google', redirectUrl: REDIRECT },
      { kind: 'web', origin: 'https://evil.test' }
    )
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('request.origin_not_allowed')
  })

  test('a sign-in start and the client config offer the enabled providers', async () => {
    await configure('apple', {
      clientSecret: undefined,
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      privateKey: await applePrivateKey(),
    })
    const signIn = await json<FlowAttempt>(await client('POST', '/sign-ins', { identifier: EMAIL }))
    expect(signIn.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['password', 'oauth_google', 'oauth_apple'],
    })
    const config = await json<{ signIn: unknown }>(await client('GET', '/config'))
    expect(config.signIn).toEqual({ methods: ['password'], oauth: ['google', 'apple'] })
  })

  test('the OAuth attempt accepts no password and no emailed code', async () => {
    await seedPasswordUser()
    const started = await start()
    const secret = started.attempt.attemptSecret as string
    const password = await client(
      'POST',
      `/sign-ins/${started.attempt.id}/password`,
      { password: PASSWORD },
      { secret }
    )
    expect(await codeOf(password)).toBe('flow.invalid_step')
    const prepare = await client(
      'POST',
      `/sign-ins/${started.attempt.id}/first-factor/prepare`,
      { strategy: 'email_code' },
      { secret }
    )
    expect(await codeOf(prepare)).toBe('flow.invalid_step')
  })
})

async function applePrivateKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
    'base64'
  )
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----`
}

describe('the provider callback', () => {
  test('exchanges the code with the stored verifier and redirects with a ticket in the fragment', async () => {
    const started = await start()
    const res = await callback('google', { state: started.state, code: 'provider-code' })
    const { ticket, attemptId, error } = fragment(res)
    expect(ticket).toMatch(/^tula_ot_[\w-]{43}$/)
    expect(error).toBeNull()
    expect(attemptId).toBe(started.attempt.id)
    // Nothing of the sign-in is in the query: a fragment is never sent to the app's server.
    expect(new URL(res.headers.get('location') as string).search).toBe('')
    const [asked] = deps.oauth.google.exchanges
    const [request] = deps.oauth.google.requests
    expect(asked).toMatchObject({
      code: 'provider-code',
      codeVerifier: request?.codeVerifier,
      nonce: request?.nonce,
      redirectUri: 'http://localhost:3003/v1/oauth/callback/google',
      credentials: { clientId: 'google-client-id', clientSecret: CLIENT_SECRET },
    })
  })

  test('sets no cookie, returns no token and creates no session or user', async () => {
    const started = await start('google', { kind: 'web' })
    const res = await callback('google', { state: started.state, code: 'provider-code' })
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await res.text()).not.toContain('eyJ')
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toBeNull()
    expect(actions()).not.toContain('session.created')
  })

  // PKCE is what binds a provider's code to the attempt (for GitHub, the only thing beside
  // `state`): an attempt that holds no verifier must never reach the provider with a code.
  test.each(['google', 'github'] as const)(
    '%s: a callback whose attempt has no verifier is refused, and the code is never exchanged',
    async (provider) => {
      await configure(provider)
      const started = await start(provider)
      const stored = await deps.flowAttempts.findById(TEST_TENANT.environmentId, started.attempt.id)
      const state = stored?.state as { oauth: Record<string, unknown> }
      const { codeVerifier, ...oauth } = state.oauth
      expect(codeVerifier).toMatch(/^[\w-]{43}$/)
      expect(
        await deps.flowAttempts.transition(
          TEST_TENANT.environmentId,
          started.attempt.id,
          'needs_first_factor',
          { status: 'needs_first_factor', state: { ...state, oauth } },
          deps.clock.now()
        )
      ).toBe(true)
      const res = await callback(provider, { state: started.state, code: 'provider-code' })
      expect(fragment(res)).toMatchObject({ ticket: null, error: 'oauth.provider_error' })
      expect(deps.oauth[provider].exchanges).toHaveLength(0)
    }
  )

  test('the verifier and the nonce leave the attempt once the code is exchanged', async () => {
    const trip = await roundTrip()
    const [request] = deps.oauth.google.requests
    const stored = JSON.stringify(
      await deps.flowAttempts.findById(TEST_TENANT.environmentId, trip.attemptId)
    )
    expect(stored).not.toContain(request?.codeVerifier as string)
    expect(stored).not.toContain(request?.nonce as string)
    expect(stored).not.toContain(trip.ticket)
  })

  test.each([
    ['no state', {}],
    ['a state that is not ours', { state: 'abc', code: 'c' }],
    [
      'an unknown attempt',
      { state: `${TEST_TENANT.environmentId}.00000000-0000-7000-8000-0000000000ff.x`, code: 'c' },
    ],
  ] as [string, Record<string, string>][])('answers a static page for %s', async (_name, query) => {
    const res = await callback('google', query)
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).toBe(OAUTH_INVALID_PAGE)
    expect(deps.oauth.google.exchanges).toHaveLength(0)
  })

  test('nothing from the request is reflected into the static page', async () => {
    const res = await app.request(
      '/v1/oauth/callback/google?state=%3Cscript%3Ealert(1)%3C/script%3E&error=%3Cb%3Ex&code=%3Ci%3E'
    )
    expect(await res.text()).toBe(OAUTH_INVALID_PAGE)
    const unknown = await app.request('/v1/oauth/callback/%3Cscript%3E?state=x')
    expect(await unknown.text()).toBe(OAUTH_INVALID_PAGE)
    expect(unknown.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  test('a state with a tampered random part, or of another provider, matches nothing', async () => {
    await configure('github')
    const started = await start()
    const tampered = `${started.state.slice(0, -1)}${started.state.endsWith('A') ? 'B' : 'A'}`
    expect((await callback('google', { state: tampered, code: 'c' })).status).toBe(400)
    expect((await callback('github', { state: started.state, code: 'c' })).status).toBe(400)
    // Neither used the state up: the real callback still works.
    expect(
      fragment(await callback('google', { state: started.state, code: 'c' })).ticket
    ).toBeTruthy()
  })

  test('a state of one environment is unknown in another', async () => {
    const started = await start()
    const [, attemptId, random] = started.state.split('.')
    const res = await callback('google', {
      state: `${TEST_TENANT.productionEnvironmentId}.${attemptId}.${random}`,
      code: 'c',
    })
    expect(res.status).toBe(400)
  })

  test('a state works once: a replayed callback gets an error and no second exchange', async () => {
    const started = await start()
    const first = fragment(
      await callback('google', { state: started.state, code: 'provider-code' })
    )
    const replay = fragment(
      await callback('google', { state: started.state, code: 'provider-code' })
    )
    expect(replay).toEqual({
      ticket: null,
      error: 'oauth.state_invalid',
      attemptId: first.attemptId,
    })
    expect(deps.oauth.google.exchanges).toHaveLength(1)
    // The replay did not disturb the first ticket.
    expect(
      (await exchange({ ...started, ticket: first.ticket as string, attemptId: first.attemptId }))
        .status
    ).toBe(200)
  })

  test('two callbacks at once: exactly one exchanges the code', async () => {
    const started = await start()
    const results = await Promise.all(
      [1, 2].map(async () =>
        fragment(await callback('google', { state: started.state, code: 'c' }))
      )
    )
    expect(results.filter((result) => result.ticket).length).toBe(1)
    expect(results.filter((result) => result.error === 'oauth.state_invalid').length).toBe(1)
    expect(deps.oauth.google.exchanges).toHaveLength(1)
  })

  test('a state is used up by a failed exchange too', async () => {
    const started = await start()
    deps.oauth.google.failure = new OAuthProviderError('invalid_grant')
    expect(fragment(await callback('google', { state: started.state, code: 'bad' })).error).toBe(
      'oauth.provider_error'
    )
    deps.oauth.google.failure = null
    expect(fragment(await callback('google', { state: started.state, code: 'good' })).error).toBe(
      'oauth.state_invalid'
    )
  })

  test('an expired attempt answers an error and exchanges nothing', async () => {
    const started = await start()
    deps.clock.advance('11m')
    expect(fragment(await callback('google', { state: started.state, code: 'c' })).error).toBe(
      'oauth.state_invalid'
    )
    expect(deps.oauth.google.exchanges).toHaveLength(0)
  })

  test.each([
    ['access_denied', 'oauth.access_denied'],
    ['server_error', 'oauth.provider_error'],
    ['<script>alert(1)</script>', 'oauth.provider_error'],
  ] as [string, string][])(
    'a provider error %p becomes %p, never its own text',
    async (error, code) => {
      const started = await start()
      const res = await callback('google', {
        state: started.state,
        error,
        error_description: '<b>x',
      })
      expect(fragment(res).error).toBe(code)
      expect(res.headers.get('location')).not.toContain('script')
      expect(deps.oauth.google.exchanges).toHaveLength(0)
    }
  )

  test.each([
    ['the provider refuses the code', new OAuthProviderError('invalid_grant')],
    ['the provider cannot be reached', new OAuthProviderError('unavailable')],
    ['the ID token does not verify', new OAuthProviderError('invalid_token')],
    ['something unexpected is thrown', new Error('access_token=ya29.secret maya@northline.app')],
  ] as [string, Error][])(
    'when %s the app is told oauth.provider_error and nothing leaks',
    async (_name, failure) => {
      const warn = spyOn(logger, 'warn').mockImplementation(() => {})
      const started = await start()
      deps.oauth.google.failure = failure
      const res = await callback('google', { state: started.state, code: 'c' })
      expect(fragment(res).error).toBe('oauth.provider_error')
      expect(res.headers.get('location')).not.toContain('ya29')
      expect(JSON.stringify(warn.mock.calls)).not.toContain('ya29')
      expect(JSON.stringify(warn.mock.calls)).not.toContain('northline')
      warn.mockRestore()
    }
  )

  // Review finding F6: a provider call that times out surfaces as `unavailable`. The attempt
  // must be left exactly as after any failed exchange: state spent, no ticket, no account.
  test('a provider that timed out leaves the attempt spent and nothing half-done', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const started = await start()
    deps.oauth.google.failure = new OAuthProviderError('unavailable')
    const timedOut = fragment(await callback('google', { state: started.state, code: 'c' }))
    expect(timedOut).toMatchObject({ ticket: null, error: 'oauth.provider_error' })
    expect(JSON.stringify(warn.mock.calls)).toContain('unavailable')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(started.state)
    // The provider recovers; the same state is not given a second exchange.
    deps.oauth.google.failure = null
    const replay = fragment(await callback('google', { state: started.state, code: 'c' }))
    expect(replay).toMatchObject({ ticket: null, error: 'oauth.state_invalid' })
    expect(deps.oauth.google.exchanges).toHaveLength(1)
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toBeNull()
    expect(actions()).not.toContain('session.created')
    warn.mockRestore()
    // A fresh attempt works.
    expect((await exchange(await roundTrip())).status).toBe(200)
  })

  test('a callback without a code is a provider error', async () => {
    const started = await start()
    expect(fragment(await callback('google', { state: started.state })).error).toBe(
      'oauth.provider_error'
    )
  })

  test('a provider switched off while the user was away is refused', async () => {
    const started = await start()
    await configure('google', { enabled: false })
    expect(fragment(await callback('google', { state: started.state, code: 'c' })).error).toBe(
      'auth.method_disabled'
    )
  })

  test('a redirect URL taken off the allow-list meanwhile gets the static page', async () => {
    deps.config = { ...deps.config, tier: 'prod' }
    app = createApp(deps)
    const started = await start()
    await saveSettings({ urls: { allowedRedirectUrls: [] } })
    const res = await callback('google', { state: started.state, code: 'c' })
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  test('Apple’s form post is handled, and its unsigned user field goes only to the adapter', async () => {
    await configure('apple', {
      clientSecret: undefined,
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      privateKey: await applePrivateKey(),
    })
    const started = await start('apple')
    const user = JSON.stringify({ name: { firstName: 'Maya' }, email: 'attacker@evil.test' })
    const res = await app.request('/v1/oauth/callback/apple', {
      method: 'POST',
      // A cross-site post, as Apple's is.
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://appleid.apple.com',
      },
      body: new URLSearchParams({ state: started.state, code: 'apple-code', user }),
    })
    expect(fragment(res).ticket).toBeTruthy()
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(deps.oauth.apple.exchanges[0]).toMatchObject({ code: 'apple-code', user })
    expect(deps.oauth.apple.exchanges[0]?.credentials).toMatchObject({
      clientId: 'apple-client-id',
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      privateKey: expect.stringContaining('BEGIN PRIVATE KEY'),
    })
  })

  test('a form post that cannot be read is a callback with no state', async () => {
    const res = await app.request('/v1/oauth/callback/apple', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: 'not a form',
    })
    expect(res.status).toBe(400)
  })
})

describe('exchanging the ticket', () => {
  test('signs a new user up: verified address, no password, identity recorded', async () => {
    deps.oauth.google.profile = {
      subject: 'google-sub-1',
      email: 'Maya@Northline.app',
      emailVerified: true,
      givenName: 'Maya',
      familyName: 'Okafor',
    }
    const attempt = await completed()
    const user = await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)
    expect(user).toMatchObject({
      id: attempt.step.status === 'complete' ? attempt.step.userId : '',
      email: 'Maya@Northline.app',
      firstName: 'Maya',
      lastName: 'Okafor',
    })
    expect(user?.emailVerifiedAt).not.toBeNull()
    const found = await deps.users.findByEmailWithPassword(TEST_TENANT.environmentId, EMAIL)
    expect(found?.passwordHash).toBeNull()
    expect(decodeJwt<AccessTokenClaims>(attempt.session.accessToken as string).amr).toEqual(['fed'])
    expect(attempt.session.refreshToken).toBeTruthy()
    expect(attempt.attemptSecret).toBeUndefined()
    const created = deps.activityLog.entries.find((entry) => entry.type === 'user.created')
    expect(created?.data).toEqual({
      method: 'oauth_google',
      emailVerified: true,
      passwordless: true,
    })
  })

  test('a browser gets its refresh token as a cookie, and only at the exchange', async () => {
    const started = await start('google', { kind: 'web' })
    const { ticket, attemptId } = fragment(
      await callback('google', { state: started.state, code: 'c' })
    )
    const res = await client(
      'POST',
      '/sign-ins/oauth/exchange',
      { ticket, attemptId, binding: started.binding },
      { kind: 'web' }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
    expect((await json<FlowAttempt>(res)).session?.refreshToken).toBeUndefined()
  })

  test('signing in again finds the identity, whatever address the provider now reports', async () => {
    const first = await completed()
    deps.oauth.google.profile = { ...deps.oauth.google.profile, email: 'renamed@elsewhere.test' }
    const second = await completed()
    expect(second.step).toMatchObject({ userId: (first.step as { userId: string }).userId })
    const user = await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)
    expect(user?.email).toBe(EMAIL)
    expect(
      await deps.users.findByEmail(TEST_TENANT.environmentId, 'renamed@elsewhere.test')
    ).toBeNull()
  })

  test('a ticket works once', async () => {
    const trip = await roundTrip()
    expect((await exchange(trip)).status).toBe(200)
    const replay = await exchange(trip)
    expect(replay.status).toBe(410)
    expect(await codeOf(replay)).toBe('oauth.ticket_invalid')
  })

  test('two exchanges at once: exactly one session', async () => {
    const trip = await roundTrip()
    const results = await Promise.all([exchange(trip), exchange(trip)])
    expect(results.map((res) => res.status).sort()).toEqual([200, 410])
    expect(actions().filter((type) => type === 'session.created')).toHaveLength(1)
    expect(actions().filter((type) => type === 'user.created')).toHaveLength(1)
  })

  test('a ticket lasts sixty seconds', async () => {
    const trip = await roundTrip()
    deps.clock.advance('61s')
    expect(await codeOf(await exchange(trip))).toBe('oauth.ticket_invalid')
    expect(actions()).not.toContain('session.created')
  })

  test.each([
    ['a wrong ticket', (trip: Trip) => ({ ...trip, ticket: 'tula_ot_nope' })],
    [
      'another attempt’s id',
      (trip: Trip, other: Trip) => ({ ...trip, attemptId: other.attemptId }),
    ],
    ['another attempt’s ticket', (trip: Trip, other: Trip) => ({ ...trip, ticket: other.ticket })],
  ] as [string, (trip: Trip, other: Trip) => Trip][])(
    '%s is refused and completes nothing',
    async (_name, forge) => {
      const [trip, other] = [await roundTrip(), await roundTrip()]
      const res = await exchange(forge(trip, other))
      expect(await codeOf(res)).toBe('oauth.ticket_invalid')
      expect(actions()).not.toContain('session.created')
      // The honest exchange still works.
      expect((await exchange(trip)).status).toBe(200)
    }
  )

  test.each([
    ['no binding', undefined],
    ['a wrong binding', 'tula_ob_wrong'],
  ] as [string, string | undefined][])(
    '%s is the login-CSRF case: nothing completes and nothing is used up',
    async (_name, binding) => {
      const trip = await roundTrip()
      const res = await exchange({ ticket: trip.ticket, attemptId: trip.attemptId, binding })
      expect(res.status).toBe(409)
      expect(await codeOf(res)).toBe('oauth.different_browser')
      expect(res.headers.get('set-cookie')).toBeNull()
      expect(actions()).not.toContain('session.created')
      expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toBeNull()
      // The browser that started it is not disturbed.
      expect((await exchange(trip)).status).toBe(200)
    }
  )

  test('a victim’s binding does not redeem the attacker’s ticket', async () => {
    const [attacker, victim] = [await roundTrip(), await start()]
    const res = await exchange({
      ticket: attacker.ticket,
      attemptId: attacker.attemptId,
      binding: victim.binding,
    })
    expect(await codeOf(res)).toBe('oauth.different_browser')
  })

  test('a ticket is unknown under another environment’s key', async () => {
    const trip = await roundTrip()
    const res = await client('POST', '/sign-ins/oauth/exchange', trip, { key: OTHER_PK })
    expect(await codeOf(res)).toBe('oauth.ticket_invalid')
  })

  test('a browser attempt cannot be exchanged from an origin that is not allowed', async () => {
    deps.config = { ...deps.config, tier: 'prod' }
    app = createApp(deps)
    await saveSettings({
      urls: { allowedRedirectUrls: [REDIRECT], allowedOrigins: ['https://app.northline.app'] },
    })
    const web = { kind: 'web', origin: 'https://app.northline.app' }
    const started = await start('google', web)
    const { ticket, attemptId } = fragment(
      await callback('google', { state: started.state, code: 'c' })
    )
    const body = { ticket, attemptId, binding: started.binding }
    const foreign = await client('POST', '/sign-ins/oauth/exchange', body, {
      kind: 'web',
      origin: 'https://evil.test',
    })
    expect(await codeOf(foreign)).toBe('request.origin_not_allowed')
    expect(foreign.headers.get('set-cookie')).toBeNull()
    expect((await client('POST', '/sign-ins/oauth/exchange', body, web)).status).toBe(200)
  })

  test('a provider switched off before the exchange completes nothing', async () => {
    const trip = await roundTrip()
    await configure('google', { enabled: false })
    expect(await codeOf(await exchange(trip))).toBe('auth.method_disabled')
  })

  test('the secret the attempt started with stops working at the exchange', async () => {
    await enrolTotp()
    const trip = await roundTrip()
    const res = await exchange(trip)
    const attempt = await json<FlowAttempt>(res)
    expect(attempt.step.status).toBe('needs_second_factor')
    expect(attempt.attemptSecret).toMatch(/^tula_at_/)
    expect(attempt.attemptSecret).not.toBe(trip.attempt.attemptSecret)
    const old = await client(
      'POST',
      `/sign-ins/${trip.attemptId}/second-factor`,
      { method: 'totp', code: '000000' },
      { secret: trip.attempt.attemptSecret }
    )
    expect(await codeOf(old)).toBe('flow.not_found')
  })

  test('a banned user learns of the ban only after the provider vouched, and gets no session', async () => {
    const first = await completed()
    const userId = (first.step as { userId: string }).userId
    expect((await admin('POST', `/users/${userId}/ban`)).status).toBe(200)
    const { res } = await signInWith()
    expect(await codeOf(res)).toBe('auth.user_banned')
  })
})

type Trip = Awaited<ReturnType<typeof roundTrip>>

/** Sign Maya up through Google and give her an authenticator. Returns its secret. */
async function enrolTotp() {
  const { session } = await completed()
  const enrolment = await json<TotpEnrolment>(
    await client('POST', '/me/factors/totp', {}, { token: session.accessToken })
  )
  const key = base32Decode(enrolment.secret)
  const confirm = await client(
    'POST',
    '/me/factors/totp/confirm',
    { code: totp(key, deps.clock.now()) },
    { token: session.accessToken }
  )
  expect(confirm.status).toBe(200)
  deps.clock.advance('31s')
  return key
}

describe('OAuth is a first factor', () => {
  test('a user with an authenticator stops at the second factor: no tokens, no session', async () => {
    const key = await enrolTotp()
    const before = actions().filter((type) => type === 'session.created').length
    const { res, trip } = await signInWith()
    const attempt = await json<FlowAttempt>(res)
    expect(attempt.step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code'],
    })
    expect(attempt.session).toBeUndefined()
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(actions().filter((type) => type === 'session.created')).toHaveLength(before)

    const done = await client(
      'POST',
      `/sign-ins/${trip.attemptId}/second-factor`,
      { method: 'totp', code: totp(key, deps.clock.now()) },
      { secret: attempt.attemptSecret }
    )
    const finished = await json<FlowAttempt>(done)
    expect(finished.step.status).toBe('complete')
    const { amr } = decodeJwt<AccessTokenClaims>(finished.session?.accessToken as string)
    expect(new Set(amr)).toEqual(new Set(['fed', 'otp', 'mfa']))
  })

  test('a provider switched off while the attempt waits on the second factor: refused, nothing counted, and it completes once it is back', async () => {
    const key = await enrolTotp()
    const { res, trip } = await signInWith()
    const attempt = await json<FlowAttempt>(res)
    expect(attempt.step.status).toBe('needs_second_factor')
    const submit = () =>
      client(
        'POST',
        `/sign-ins/${trip.attemptId}/second-factor`,
        { method: 'totp', code: totp(key, deps.clock.now()) },
        { secret: attempt.attemptSecret }
      )

    // Another method must stay on, or switching the provider off is refused.
    await saveSettings({
      urls: { allowedRedirectUrls: [REDIRECT] },
      signIn: { methods: { password: { enabled: true } } },
    })
    expect((await configure('google', { enabled: false })).status).toBe(200)
    const counted = spyOn(deps.lockout, 'attempt')
    const refused = await submit()
    expect(refused.status).toBe(403)
    expect(await codeOf(refused)).toBe('auth.method_disabled')
    expect(counted).not.toHaveBeenCalled()
    counted.mockRestore()
    expect(refused.headers.get('set-cookie')).toBeNull()

    expect((await configure('google', { enabled: true })).status).toBe(200)
    expect((await json<FlowAttempt>(await submit())).step.status).toBe('complete')
  })

  test('where the environment requires a second factor, a new user must enrol inside the attempt', async () => {
    await saveSettings({ urls: { allowedRedirectUrls: [REDIRECT] }, mfa: { policy: 'required' } })
    const { res, trip } = await signInWith()
    const attempt = await json<FlowAttempt>(res)
    expect(attempt.step).toEqual({ status: 'needs_factor_enrolment', methods: ['totp'] })
    expect(attempt.session).toBeUndefined()
    const options = { secret: attempt.attemptSecret }
    const enrolment = await json<TotpEnrolment>(
      await client('POST', `/sign-ins/${trip.attemptId}/factor-enrolment/totp`, {}, options)
    )
    const confirmed = await json<FlowAttempt>(
      await client(
        'POST',
        `/sign-ins/${trip.attemptId}/factor-enrolment/totp/confirm`,
        { code: totp(base32Decode(enrolment.secret), deps.clock.now()) },
        options
      )
    )
    expect(confirmed.step.status).toBe('complete')
    expect(confirmed.backupCodes).toHaveLength(10)
  })
})

describe('account resolution over HTTP', () => {
  test('connects to an existing account whose address is verified on both sides, and tells its owner', async () => {
    const userId = await seedPasswordUser(EMAIL, true)
    const attempt = await completed()
    expect(attempt.step).toMatchObject({ userId })
    const linked = deps.activityLog.entries.find((entry) => entry.type === 'user.identity_linked')
    expect(linked?.data).toEqual({ provider: 'google', method: 'auto' })
    // The only account is the one the administrator created.
    expect(actions().filter((type) => type === 'user.created')).toHaveLength(1)
    await Notices.settled()
    expect(deps.mailer.outbox.at(-1)?.subject).toContain('A Google account was connected')
  })

  test('does not connect to an account whose Tula address is unverified', async () => {
    const userId = await seedPasswordUser(EMAIL, false)
    const { res } = await signInWith()
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('oauth.account_exists')
    expect(await deps.users.listIdentities(TEST_TENANT.environmentId, userId)).toEqual([])
    expect(actions()).not.toContain('session.created')
  })

  test.each([
    ['unverified', { email: EMAIL, emailVerified: false }, 'oauth.email_unverified'],
    ['missing', { email: null, emailVerified: false }, 'oauth.email_missing'],
  ] as [string, { email: string | null; emailVerified: boolean }, string][])(
    'a provider address that is %s is refused the same with and without an account',
    async (_name, claims, code) => {
      deps.oauth.google.profile = { subject: 'google-sub-9', ...claims }
      const without = await signInWith()
      expect(without.res.status).toBe(403)
      expect(await codeOf(without.res)).toBe(code)
      expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toBeNull()

      const userId = await seedPasswordUser(EMAIL, true)
      const withAccount = await signInWith()
      expect(await codeOf(withAccount.res)).toBe(code)
      expect(await deps.users.listIdentities(TEST_TENANT.environmentId, userId)).toEqual([])
    }
  )
})

describe('connected accounts', () => {
  async function passwordSession() {
    await seedPasswordUser()
    const started = await json<FlowAttempt>(
      await client('POST', '/sign-ins', { identifier: EMAIL })
    )
    const done = await json<FlowAttempt>(
      await client(
        'POST',
        `/sign-ins/${started.id}/password`,
        { password: PASSWORD },
        { secret: started.attemptSecret }
      )
    )
    session = done.session as NonNullable<FlowAttempt['session']>
    return session.accessToken as string
  }
  let session: NonNullable<FlowAttempt['session']>

  async function link(token: string, provider: OAuthProvider = 'google') {
    const res = await client(
      'POST',
      '/me/identities/oauth',
      { provider, redirectUrl: REDIRECT },
      { token }
    )
    expect(res.status).toBe(200)
    const started = await json<IdentityLinkStart>(res)
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? ''
    const { ticket, attemptId } = fragment(await callback(provider, { state, code: 'c' }))
    return { ticket: ticket as string, attemptId, binding: started.binding }
  }

  const finish = (token: string, body: unknown) =>
    client('POST', '/me/identities/oauth/exchange', body, { token })
  const list = async (token: string) =>
    (await json<{ data: Identity[] }>(await client('GET', '/me/identities', undefined, { token })))
      .data

  test('links whatever address the provider reports, lists it, and tells the owner', async () => {
    const token = await passwordSession()
    deps.oauth.google.profile = {
      subject: 'google-sub-7',
      email: 'other@elsewhere.test',
      emailVerified: false,
    }
    const res = await finish(token, await link(token))
    expect(res.status).toBe(200)
    const identity = await json<Identity>(res)
    expect(identity).toEqual({
      id: expect.any(String),
      provider: 'google',
      createdAt: expect.any(String),
    })
    expect(await list(token)).toEqual([identity])
    // The provider's own id for the account is never sent to a client.
    expect(JSON.stringify(await list(token))).not.toContain('google-sub-7')
    const entry = deps.activityLog.entries.find((item) => item.type === 'user.identity_linked')
    expect(entry?.data).toEqual({ provider: 'google', method: 'profile' })
    expect(actions().filter((type) => type === 'session.created')).toHaveLength(1)
    await Notices.settled()
    expect(deps.mailer.outbox.at(-1)?.subject).toContain('A Google account was connected')
    // And it now signs that user in.
    const signedIn = await completed()
    expect(signedIn.step).toMatchObject({ status: 'complete' })
  })

  test('refuses an identity that belongs to another user, and a second account of one provider', async () => {
    deps.oauth.google.profile = {
      subject: 'taken',
      email: 'someone@elsewhere.test',
      emailVerified: true,
    }
    await completed()
    const token = await passwordSession()
    const inUse = await finish(token, await link(token))
    expect(inUse.status).toBe(409)
    expect(await codeOf(inUse)).toBe('oauth.identity_in_use')

    deps.oauth.google.profile = { subject: 'mine-1', email: null, emailVerified: false }
    expect((await finish(token, await link(token))).status).toBe(200)
    deps.oauth.google.profile = { subject: 'mine-2', email: null, emailVerified: false }
    expect(await codeOf(await finish(token, await link(token)))).toBe('oauth.already_linked')
    expect(await list(token)).toHaveLength(1)
  })

  test('a link ticket needs its binding, its owner, and the link route', async () => {
    const token = await passwordSession()
    const trip = await link(token)
    expect(await codeOf(await finish(token, { ...trip, binding: undefined }))).toBe(
      'oauth.different_browser'
    )
    // The sign-in exchange does not take a link ticket (it would sign someone in).
    expect(await codeOf(await exchange(trip))).toBe('oauth.ticket_invalid')
    // Another signed-in user cannot take it either, and does not use it up.
    deps.oauth.google.profile = {
      subject: 'other',
      email: 'other@elsewhere.test',
      emailVerified: true,
    }
    const other = await completed()
    deps.oauth.google.profile = { subject: 'mine', email: null, emailVerified: false }
    expect(await codeOf(await finish(other.session.accessToken as string, trip))).toBe(
      'oauth.ticket_invalid'
    )
    expect((await finish(token, trip)).status).toBe(200)
    // And a sign-in ticket is not a link ticket.
    const signIn = await roundTrip()
    expect(await codeOf(await finish(token, signIn))).toBe('oauth.ticket_invalid')
  })

  test('linking and unlinking need a session and a recent authentication', async () => {
    const token = await passwordSession()
    const body = { provider: 'google', redirectUrl: REDIRECT }
    expect((await client('POST', '/me/identities/oauth', body)).status).toBe(401)
    expect((await client('GET', '/me/identities')).status).toBe(401)
    const identity = await json<Identity>(await finish(token, await link(token)))
    deps.clock.advance('11m')
    const refreshed = await client('POST', '/sessions/refresh', {
      refreshToken: session.refreshToken,
    })
    expect(refreshed.status).toBe(200)
    const fresh = (await json<{ accessToken: string }>(refreshed)).accessToken
    const stale = await client('POST', '/me/identities/oauth', body, { token: fresh })
    expect(await codeOf(stale)).toBe('auth.step_up_required')
    const unlink = await client('DELETE', `/me/identities/${identity.id}`, undefined, {
      token: fresh,
    })
    expect(await codeOf(unlink)).toBe('auth.step_up_required')
  })

  test('unlinks, records it and tells the owner; the identity no longer signs in to that account', async () => {
    const token = await passwordSession()
    deps.oauth.google.profile = { subject: 'mine', email: null, emailVerified: false }
    const identity = await json<Identity>(await finish(token, await link(token)))
    const res = await client('DELETE', `/me/identities/${identity.id}`, undefined, { token })
    expect(res.status).toBe(204)
    expect(await list(token)).toEqual([])
    const entry = deps.activityLog.entries.find((item) => item.type === 'user.identity_unlinked')
    expect(entry?.data).toEqual({ provider: 'google' })
    await Notices.settled()
    expect(deps.mailer.outbox.at(-1)?.subject).toContain('A Google account was disconnected')
    expect(await codeOf((await signInWith()).res)).toBe('oauth.email_missing')
    const again = await client('DELETE', `/me/identities/${identity.id}`, undefined, { token })
    expect(again.status).toBe(404)
  })

  test('refuses to remove the last way to sign in', async () => {
    const { session } = await completed()
    const [identity] = await list(session.accessToken as string)
    const res = await client('DELETE', `/me/identities/${identity?.id}`, undefined, {
      token: session.accessToken,
    })
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('identity.last_sign_in_method')
    expect(await list(session.accessToken as string)).toHaveLength(1)
    expect(actions()).not.toContain('user.identity_unlinked')
  })

  test('a user cannot remove another user’s identity', async () => {
    const maya = await completed()
    const [identity] = await list(maya.session.accessToken as string)
    deps.oauth.google.profile = { subject: 'zed', email: 'zed@elsewhere.test', emailVerified: true }
    const other = await completed()
    const res = await client('DELETE', `/me/identities/${identity?.id}`, undefined, {
      token: other.session.accessToken,
    })
    expect(res.status).toBe(404)
  })
})

describe('admin: provider credentials', () => {
  const providers = async () =>
    (await json<{ data: OAuthProviderSettings[] }>(await admin('GET', '/oauth-providers'))).data

  test('lists every provider with its callback URL, and never a secret', async () => {
    const res = await admin('GET', '/oauth-providers')
    const text = await res.clone().text()
    expect(text).not.toContain(CLIENT_SECRET)
    expect((await json<{ data: OAuthProviderSettings[] }>(res)).data).toEqual([
      {
        provider: 'google',
        configured: true,
        enabled: true,
        clientId: 'google-client-id',
        teamId: null,
        keyId: null,
        tenant: null,
        callbackUrl: 'http://localhost:3003/v1/oauth/callback/google',
        updatedAt: expect.any(String),
      },
      expect.objectContaining({
        provider: 'github',
        configured: false,
        enabled: false,
        clientId: null,
      }),
      expect.objectContaining({
        provider: 'apple',
        configured: false,
        callbackUrl: 'http://localhost:3003/v1/oauth/callback/apple',
      }),
      expect.objectContaining({
        provider: 'microsoft',
        configured: false,
        tenant: null,
        callbackUrl: 'http://localhost:3003/v1/oauth/callback/microsoft',
      }),
    ])
  })

  test('stores the secret sealed, and neither returns nor records it', async () => {
    const res = await configure('github')
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain(CLIENT_SECRET)
    const stored = await deps.oauthProviders.find(TEST_TENANT.environmentId, 'github')
    expect(stored?.secret).toMatch(/^v1\./)
    expect(JSON.stringify(stored)).not.toContain(CLIENT_SECRET)
    const entry = deps.activityLog.entries.findLast(
      (item) => item.type === 'oauth_provider.updated'
    )
    expect(entry).toMatchObject({
      actor: { type: 'admin' },
      data: { provider: 'github', changed: ['clientId', 'secret', 'enabled'], created: true },
    })
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain(CLIENT_SECRET)
  })

  test('a sealed secret does not open for another environment or another provider', async () => {
    await configure('github')
    const google = await deps.oauthProviders.find(TEST_TENANT.environmentId, 'google')
    const github = await deps.oauthProviders.find(TEST_TENANT.environmentId, 'github')
    const error = spyOn(logger, 'error').mockImplementation(() => {})
    // Copied to another provider's row.
    await deps.oauthProviders.upsert(
      {
        ...(github as OAuthProviderRecord),
        secret: google?.secret ?? '',
      },
      Audit.none('fixture')
    )
    expect(
      await codeOf(
        await client('POST', '/sign-ins/oauth', { provider: 'github', redirectUrl: REDIRECT })
      )
    ).toBe('auth.method_disabled')
    // Copied to another environment's row.
    await deps.oauthProviders.upsert(
      {
        ...(google as OAuthProviderRecord),
        id: deps.ids.next(),
        environmentId: TEST_TENANT.productionEnvironmentId,
      },
      Audit.none('fixture')
    )
    const other = await client(
      'POST',
      '/sign-ins/oauth',
      { provider: 'google', redirectUrl: 'http://localhost:5174/cb' },
      { key: OTHER_PK }
    )
    expect(await codeOf(other)).toBe('auth.method_disabled')
    expect(error).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(error.mock.calls)).not.toContain(CLIENT_SECRET)
    error.mockRestore()
  })

  test('keeps the stored secret when an update leaves it out, and records only what changed', async () => {
    const res = await admin('PUT', '/oauth-providers/google', { clientId: 'new-id', enabled: true })
    expect(res.status).toBe(200)
    const entry = deps.activityLog.entries.findLast(
      (item) => item.type === 'oauth_provider.updated'
    )
    expect(entry?.data).toEqual({ provider: 'google', changed: ['clientId'] })
    await signInWith()
    expect(deps.oauth.google.exchanges[0]?.credentials).toEqual({
      clientId: 'new-id',
      clientSecret: CLIENT_SECRET,
    })
  })

  test.each([
    ['a first save without a secret', 'github', { clientId: 'x' }, 'clientSecret'],
    [
      'Apple fields on Google',
      'google',
      { clientId: 'x', clientSecret: 'y', teamId: 'T' },
      'teamId',
    ],
    ['Apple without a team id', 'apple', { clientId: 'x', keyId: 'K', privateKey: 'p' }, 'teamId'],
    ['Apple with a client secret', 'apple', { clientId: 'x', clientSecret: 'y' }, 'clientSecret'],
    [
      'Apple with a key that is not a P-256 PEM',
      'apple',
      { clientId: 'x', teamId: 'T', keyId: 'K', privateKey: 'not a key' },
      'privateKey',
    ],
    ['an unknown field', 'google', { clientId: 'x', clientSecret: 'y', scopes: ['a'] }, '(root)'],
  ] as [string, string, Record<string, unknown>, string][])(
    'refuses %s',
    async (_name, provider, body, field) => {
      const res = await admin('PUT', `/oauth-providers/${provider}`, body)
      expect(res.status).toBe(422)
      const errors = (await json<{ errors: { field: string; message: string }[] }>(res)).errors
      expect(errors[0]?.field).toBe(field)
      expect(JSON.stringify(errors)).not.toContain('not a key')
    }
  )

  test('needs a secret key: a publishable key or none is refused', async () => {
    for (const authorization of [undefined, `Bearer ${PK}`]) {
      for (const [method, path] of [
        ['GET', '/oauth-providers'],
        ['PUT', '/oauth-providers/google'],
        ['DELETE', '/oauth-providers/google'],
      ] as const) {
        const res = await app.request(`/v1/admin${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...(authorization && { authorization }) },
          ...(method === 'PUT' && { body: JSON.stringify({ clientId: 'x', clientSecret: 'y' }) }),
        })
        expect(res.status).toBe(401)
      }
    }
  })

  test('removes a provider, records it, and keeps the users’ identities', async () => {
    const { session } = await completed()
    const res = await admin('DELETE', '/oauth-providers/google')
    expect(res.status).toBe(204)
    expect((await providers())[0]).toMatchObject({ configured: false, enabled: false })
    expect(deps.activityLog.entries.at(-1)).toMatchObject({
      type: 'oauth_provider.deleted',
      data: { provider: 'google' },
    })
    expect((await admin('DELETE', '/oauth-providers/google')).status).toBe(404)
    const identities = await json<{ data: Identity[] }>(
      await client('GET', '/me/identities', undefined, { token: session.accessToken })
    )
    expect(identities.data).toHaveLength(1)
  })

  test('the last way to sign in cannot be switched off from either side', async () => {
    const off = { signIn: { methods: { password: { enabled: false } } } }
    const settings = { ...off, urls: { allowedRedirectUrls: [REDIRECT] } }
    // With Google enabled, the settings may switch every method of their own off.
    await saveSettings(settings)
    const start = await json<FlowAttempt>(await client('POST', '/sign-ins', { identifier: EMAIL }))
    expect(start.step).toEqual({ status: 'needs_first_factor', strategies: ['oauth_google'] })
    // Then Google is the last way in: it can be neither disabled nor removed.
    const disable = await configure('google', { enabled: false })
    expect(disable.status).toBe(422)
    expect(await json(disable)).toMatchObject({
      errors: [{ field: 'enabled', message: 'at least one sign-in method must stay enabled' }],
    })
    expect((await admin('DELETE', '/oauth-providers/google')).status).toBe(422)
    // A second provider makes the first removable.
    await configure('github')
    expect((await admin('DELETE', '/oauth-providers/google')).status).toBe(204)
    expect((await admin('DELETE', '/oauth-providers/github')).status).toBe(422)
  })

  test('settings with every method off are refused where no provider is enabled', async () => {
    await configure('google', { enabled: false })
    const current = await admin('GET', '/settings')
    const res = await admin(
      'PUT',
      '/settings',
      { signIn: { methods: { password: { enabled: false } } } },
      { 'if-match': current.headers.get('etag') ?? '' }
    )
    expect(res.status).toBe(422)
    expect(await json(res)).toMatchObject({
      errors: [
        { field: 'signIn.methods', message: 'at least one sign-in method must stay enabled' },
      ],
    })
  })
})

// Review finding F3: each side checked "at least one sign-in method" against a snapshot, so a
// settings write and a provider write made at the same moment could both pass and leave the
// environment with no way in. Both now take the environment's lock and check inside it.
describe('admin: the last sign-in method under concurrent writes', () => {
  const ALL_OFF = {
    signIn: { methods: { password: { enabled: false } } },
    urls: { allowedRedirectUrls: [REDIRECT] },
  }

  /** Hold a store write until `open` is called, so the other request runs in between. */
  function gated<T extends object, K extends keyof T>(store: T, method: K) {
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    let reached: () => void = () => undefined
    const waiting = new Promise<void>((resolve) => {
      reached = resolve
    })
    const original = (store[method] as (...args: unknown[]) => Promise<unknown>).bind(store)
    const spy = spyOn(store as Record<K, (...args: unknown[]) => Promise<unknown>>, method)
    spy.mockImplementationOnce(async (...args: unknown[]) => {
      reached()
      await gate
      return original(...args)
    })
    return { open, waiting, restore: () => spy.mockRestore() }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

  async function wayIn() {
    const { settings } = await deps.environmentSettings
      .get(TEST_TENANT.environmentId)
      .then((stored) => stored ?? { settings: null })
    const methods = settings?.signIn.methods
    const ownMethod =
      settings === null || Object.values(methods ?? {}).some((method) => method.enabled)
    const providers = await deps.oauthProviders.list(TEST_TENANT.environmentId)
    return ownMethod || providers.some((provider) => provider.enabled)
  }

  test('settings switching every method off, racing the last provider being disabled: one is refused', async () => {
    const etag = (await admin('GET', '/settings')).headers.get('etag') ?? '"0"'
    const write = gated(deps.environmentSettings, 'replace')
    const settings = admin('PUT', '/settings', ALL_OFF, { 'if-match': etag })
    await write.waiting
    // The settings request has passed its check (Google is enabled) and not yet written.
    const disable = configure('google', { enabled: false })
    await settle()
    write.open()
    const [first, second] = await Promise.all([settings, disable])
    write.restore()

    expect(first.status).toBe(200)
    expect(second.status).toBe(422)
    expect(await json(second)).toMatchObject({ errors: [{ field: 'enabled' }] })
    expect(await wayIn()).toBe(true)
    expect((await deps.oauthProviders.find(TEST_TENANT.environmentId, 'google'))?.enabled).toBe(
      true
    )
  })

  test('the last provider being removed, racing settings that switch every method off: one is refused', async () => {
    const etag = (await admin('GET', '/settings')).headers.get('etag') ?? '"0"'
    const write = gated(deps.oauthProviders, 'delete')
    const removal = admin('DELETE', '/oauth-providers/google')
    await write.waiting
    // The removal has passed its check (the password is on) and not yet written.
    const settings = admin('PUT', '/settings', ALL_OFF, { 'if-match': etag })
    await settle()
    write.open()
    const [first, second] = await Promise.all([removal, settings])
    write.restore()

    expect(first.status).toBe(204)
    expect(second.status).toBe(422)
    expect(await json(second)).toMatchObject({ errors: [{ field: 'signIn.methods' }] })
    expect(await wayIn()).toBe(true)
  })

  test('the last provider being disabled, racing settings that switch every method off: one is refused', async () => {
    const etag = (await admin('GET', '/settings')).headers.get('etag') ?? '"0"'
    const write = gated(deps.oauthProviders, 'upsert')
    const disable = configure('google', { enabled: false })
    await write.waiting
    const settings = admin('PUT', '/settings', ALL_OFF, { 'if-match': etag })
    await settle()
    write.open()
    const [first, second] = await Promise.all([disable, settings])
    write.restore()

    expect(first.status).toBe(200)
    expect(second.status).toBe(422)
    expect(await wayIn()).toBe(true)
  })

  test('two providers disabled at once where the settings have no method: one stays', async () => {
    await configure('github')
    await saveSettings(ALL_OFF)
    const write = gated(deps.oauthProviders, 'upsert')
    const google = configure('google', { enabled: false })
    await write.waiting
    const github = configure('github', { enabled: false })
    await settle()
    write.open()
    const [first, second] = await Promise.all([google, github])
    write.restore()

    expect([first.status, second.status]).toEqual([200, 422])
    expect(await wayIn()).toBe(true)
  })

  test('a write that fails releases the lock: the next one is decided normally', async () => {
    const spy = spyOn(deps.oauthProviders, 'upsert').mockRejectedValueOnce(new Error('db down'))
    const silenced = spyOn(logger, 'error').mockImplementation(() => {})
    expect((await configure('google', { enabled: false })).status).toBe(500)
    spy.mockRestore()
    silenced.mockRestore()
    expect((await configure('google', { enabled: false })).status).toBe(200)
  })
})

describe('nothing sensitive leaves', () => {
  test('a whole journey puts no secret, ticket, binding, state or verifier in a log or the audit log', async () => {
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      spyOn(logger, level).mockImplementation(() => {})
    )
    const key = await enrolTotp()
    const { res, trip } = await signInWith()
    const attempt = await json<FlowAttempt>(res)
    await client(
      'POST',
      `/sign-ins/${trip.attemptId}/second-factor`,
      { method: 'totp', code: totp(key, deps.clock.now()) },
      { secret: attempt.attemptSecret }
    )
    const failing = await start()
    deps.oauth.google.failure = new OAuthProviderError('invalid_token')
    await callback('google', { state: failing.state, code: 'c' })
    await Notices.settled()

    const [request] = deps.oauth.google.requests
    const haystack = JSON.stringify([
      spies.flatMap((spy) => spy.mock.calls),
      deps.activityLog.entries,
      deps.mailer.outbox,
    ])
    for (const secret of [
      CLIENT_SECRET,
      trip.ticket,
      trip.binding,
      trip.state.split('.')[2] as string,
      trip.attempt.attemptSecret as string,
      attempt.attemptSecret as string,
      request?.codeVerifier as string,
      request?.nonce as string,
      'google-subject-1',
    ]) {
      expect(haystack).not.toContain(secret)
    }
    for (const spy of spies) {
      spy.mockRestore()
    }
  })
})
