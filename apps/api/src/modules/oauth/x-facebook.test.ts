import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type AccessTokenClaims,
  type CurrentUser,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type FlowAttempt,
  HOOK_QUESTION_SCHEMAS,
  type OAuthProviderSettings,
  type OAuthStart,
  type User,
  type UserAuthentication,
  type UserList,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import { mockOAuthProviders } from '~/adapters/oauth/mock'
import { AuthError } from '~/exceptions'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Hooks from '~/modules/hook/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as OAuth from '~/modules/oauth/service'
import * as Settings from '~/modules/settings/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// Sign in with X and with Facebook, from the admin routes to a session (ADR 0026, "Providers
// without an address"): neither gives Tula an email address, so a first sign-in makes an
// account that has none, and such an identity is never connected to an account by an
// address. Through the mock provider and the real callback, ticket and exchange. What each
// real adapter takes from its provider is in `adapters/oauth/{x,facebook}.test.ts`.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const REDIRECT = 'http://localhost:5174/oauth/callback'
const EMAIL = 'maya@northline.app'
const tenant = { ...TEST_TENANT, apiKeyId: 'key' }

type Provider = 'x' | 'facebook'
/** Each provider, its name on the consent page, and an account id in the provider's own shape. */
const PROVIDERS: [Provider, string, string][] = [
  ['x', 'X', '2244994945'],
  ['facebook', 'Facebook', '10158712345678901'],
]

let asked: Record<string, unknown>[] = []
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const question = (await req.json()) as { data: Record<string, unknown> }
    expect(HOOK_QUESTION_SCHEMAS.before_sign_up.safeParse(question).success).toBe(true)
    asked.push(question.data)
    return Response.json({ decision: 'allow' })
  },
})
afterAll(() => listener.stop(true))

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  asked = []
  deps = createTestDeps()
  deps.config = { ...deps.config, oauthMock: true }
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
})

function admin(method: string, path: string, body?: unknown) {
  return app.request(`/v1/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

function me(method: string, path: string, accessToken: string, body?: unknown) {
  return app.request(`/v1/client/me${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const configure = (provider: string, body: Record<string, unknown> = {}) =>
  admin('PUT', `/oauth-providers/${provider}`, {
    clientId: 'mock-client',
    clientSecret: 'mock-secret',
    ...body,
  })

async function start(provider: string) {
  const res = await app.request('/v1/client/sign-ins/oauth', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
      'x-tula-client': 'ios',
    },
    body: JSON.stringify({ provider, redirectUrl: REDIRECT }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as OAuthStart
}

const pathOf = (url: string) => url.slice(new URL(url).origin.length)

function consent(authorizationUrl: string, fields: Record<string, string>) {
  return app.request('/v1/dev/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...Object.fromEntries(new URL(authorizationUrl).searchParams),
      ...fields,
    }),
  })
}

interface Outcome {
  consent?: number
  callbackError?: string | null
  status?: string
  code?: string
  userId?: string
  accessToken?: string
  refreshToken?: string
}

/** One round trip: the consent form, the callback, the exchange. */
async function signIn(provider: string, fields: Record<string, string>): Promise<Outcome> {
  const started = await start(provider)
  const consented = await consent(started.authorizationUrl, fields)
  if (consented.status !== 302) {
    return { consent: consented.status }
  }
  const callback = await app.request(pathOf(consented.headers.get('location') as string))
  const fragment = new URLSearchParams((callback.headers.get('location') as string).split('#')[1])
  if (fragment.get('tula_error')) {
    return { callbackError: fragment.get('tula_error') }
  }
  const res = await app.request('/v1/client/sign-ins/oauth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tula-publishable-key': PK },
    body: JSON.stringify({
      ticket: fragment.get('tula_ticket'),
      attemptId: fragment.get('tula_attempt'),
      binding: started.binding,
    }),
  })
  const body = (await res.json()) as FlowAttempt & { code?: string }
  const step = body.step as { status?: string; userId?: string } | undefined
  return {
    status: step?.status,
    code: body.code,
    userId: step?.userId,
    accessToken: body.session?.accessToken ?? undefined,
    refreshToken: body.session?.refreshToken ?? undefined,
  }
}

async function users(): Promise<User[]> {
  return ((await (await admin('GET', '/users?sort=createdAt')).json()) as UserList).data
}

/** A Tula account with a password, its address verified or not. */
async function account(verified: boolean, email = EMAIL): Promise<string> {
  const id = deps.ids.next()
  await deps.users.create(
    {
      id,
      projectId: TEST_TENANT.projectId,
      environmentId: TEST_TENANT.environmentId,
      email,
      emailNormalized: email,
      emailVerifiedAt: verified ? deps.clock.now() : null,
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: '$argon2id$hash',
    },
    Audit.none('fixture')
  )
  return id
}

const created = () => deps.activityLog.entries.filter((entry) => entry.type === 'user.created')

describe.each(PROVIDERS)('%s', (provider, name, accountId) => {
  describe('the credentials', () => {
    test('are a client id and a secret, which no read returns', async () => {
      const res = await configure(provider)
      expect(res.status).toBe(200)
      expect((await res.json()) as OAuthProviderSettings).toEqual({
        provider,
        configured: true,
        enabled: true,
        clientId: 'mock-client',
        teamId: null,
        keyId: null,
        tenant: null,
        additionalClientIds: [],
        callbackUrl: `${deps.config.publicUrl}/v1/oauth/callback/${provider}`,
        updatedAt: expect.any(String),
      })
      expect(await (await admin('GET', '/oauth-providers')).text()).not.toContain('mock-secret')
    })

    test.each([
      ['no secret', { clientSecret: undefined }, 'clientSecret is required'],
      ['Microsoft’s tenant', { tenant: 'common' }, 'tenant is not used by this provider'],
      ['Apple’s team id', { teamId: 'TEAM123456' }, 'teamId is not used by this provider'],
      ['a private key', { privateKey: 'x' }, 'privateKey is not used by this provider'],
    ])('are refused with %s, and nothing is stored', async (_name, body, message) => {
      const res = await configure(provider, body)
      expect(res.status).toBe(422)
      expect(await res.text()).toContain(message)
      expect(await deps.oauthProviders.find(TEST_TENANT.environmentId, provider)).toBeNull()
    })

    test('the secret is stored sealed, bound to this provider and this environment', async () => {
      await configure(provider)
      const record = await deps.oauthProviders.find(TEST_TENANT.environmentId, provider)
      expect(record?.secret).not.toContain('mock-secret')
      const other = provider === 'x' ? 'facebook' : 'x'
      await configure(other)
      const copied = await deps.oauthProviders.find(TEST_TENANT.environmentId, other)
      await deps.oauthProviders.upsert(
        { ...(copied as NonNullable<typeof copied>), secret: record?.secret as string },
        Audit.none('fixture')
      )
      await expect(OAuth.credentials(deps, TEST_TENANT, other)).rejects.toMatchObject({
        code: 'auth.method_disabled',
      })
    })

    test('the consent page says the address is never read', async () => {
      await configure(provider)
      const started = await start(provider)
      const page = await app.request(pathOf(started.authorizationUrl))
      expect(page.status).toBe(200)
      expect(await page.text()).toContain(`never read from ${name}`)
    })
  })

  describe('a first sign-in', () => {
    beforeEach(async () => {
      await configure(provider)
    })

    test('makes an account with no email address, which signs in again by its id', async () => {
      const first = await signIn(provider, { subject: accountId, given_name: 'Nelly' })
      expect(first.status).toBe('complete')
      await Notices.settled()
      expect(await users()).toMatchObject([
        { id: first.userId, email: null, emailVerifiedAt: null, firstName: 'Nelly' },
      ])
      expect(created().map((entry) => entry.data)).toEqual([
        { method: `oauth_${provider}`, emailVerified: false, passwordless: true },
      ])
      const profile = (await (
        await me('GET', '', first.accessToken as string)
      ).json()) as CurrentUser
      expect(profile).toMatchObject({ id: first.userId, email: null, hasPassword: false })
      expect(decodeJwt<AccessTokenClaims>(first.accessToken as string).amr).toEqual(['fed'])

      // Again, with another name: the same account, by the provider's id alone.
      const again = await signIn(provider, { subject: accountId, given_name: 'Renamed' })
      expect(again).toMatchObject({ status: 'complete', userId: first.userId })
      await Notices.settled()
      expect(await users()).toHaveLength(1)
      // Nobody is emailed: there is nowhere to send a "new sign-in" notice.
      expect(deps.mailer.outbox).toEqual([])
    })

    test.each([
      ['verified', true],
      ['unverified', false],
    ])(
      'never touches the %s account that has the address the provider "reports"',
      async (_n, verified) => {
        const holder = await account(verified)
        // The mock lets the "provider" say an address, verified. The real adapters read none;
        // account resolution must not depend on that.
        const outcome = await signIn(provider, { subject: accountId, email: EMAIL })
        expect(outcome.status).toBe('complete')
        expect(outcome.userId).not.toBe(holder)
        await Notices.settled()
        const all = await users()
        expect(all.map((user) => user.email).sort()).toEqual([EMAIL, null].sort())
        expect(await deps.users.listIdentities(TEST_TENANT.environmentId, holder)).toEqual([])
        expect(
          (await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL))?.emailVerifiedAt === null
        ).toBe(!verified)
        expect(deps.activityLog.entries.map((entry) => entry.type)).not.toContain(
          'user.identity_linked'
        )
        // The address's owner hears nothing, because nothing of theirs changed.
        expect(deps.mailer.outbox).toEqual([])
      }
    )

    test('two provider accounts are two Tula accounts, though both "report" one address', async () => {
      const one = await signIn(provider, { subject: accountId, email: EMAIL })
      const two = await signIn(provider, { subject: `${accountId}7`, email: EMAIL })
      expect(one.status).toBe('complete')
      expect(two.status).toBe('complete')
      expect(two.userId).not.toBe(one.userId)
      expect((await users()).map((user) => user.email)).toEqual([null, null])
    })

    test('an account id that is not an id is refused at the callback, and nothing is created', async () => {
      for (const subject of ['nelly', '0123', '-5', `${accountId}:admin`]) {
        expect(await signIn(provider, { subject })).toEqual({
          callbackError: 'oauth.provider_error',
        })
      }
      expect(await users()).toEqual([])
    })

    test('no address and no account id is not a consent', async () => {
      expect(await signIn(provider, {})).toEqual({ consent: 400 })
    })

    test('the same new identity resolved twice at once is one account', async () => {
      const profile = { subject: accountId, email: null, emailVerified: false }
      const origin = { ipAddress: '203.0.113.7', userAgent: 'tests' }
      const results = await Promise.all([
        OAuth.resolveAccount(deps, tenant, provider, profile, origin, 'web'),
        OAuth.resolveAccount(deps, tenant, provider, profile, origin, 'web'),
      ])
      expect(new Set(results.map((result) => result.user.id)).size).toBe(1)
      expect(results.map((result) => result.created).sort()).toEqual([false, true])
      expect(await users()).toHaveLength(1)
      expect(created()).toHaveLength(1)
    })

    test('a store that keeps refusing the insert ends in a contract error, never a loop or a 500', async () => {
      const create = spyOn(deps.users, 'create').mockResolvedValue(false)
      const profile = { subject: accountId, email: null, emailVerified: false }
      await expect(
        OAuth.resolveAccount(deps, tenant, provider, profile, {}, 'web')
      ).rejects.toMatchObject({ code: 'flow.invalid_step' })
      expect(create).toHaveBeenCalledTimes(2)
      create.mockRestore()
    })

    test('a banned account does not sign in', async () => {
      const first = await signIn(provider, { subject: accountId })
      await admin('POST', `/users/${first.userId}/ban`)
      expect((await signIn(provider, { subject: accountId })).code).toBe('auth.user_banned')
    })
  })

  describe('the before_sign_up hook', () => {
    beforeEach(async () => {
      await configure(provider)
      await Hooks.create(
        deps,
        tenant,
        {
          point: 'before_sign_up',
          url: `http://127.0.0.1:${listener.port}/tula/before-sign-up`,
          enabled: true,
          deadlineMs: 1000,
          failureMode: 'deny',
        },
        TEST_ACTOR
      )
    })

    test('is asked once, with a null address: none is leaked and none is invented', async () => {
      await account(true)
      const outcome = await signIn(provider, { subject: accountId, email: EMAIL })
      expect(outcome.status).toBe('complete')
      expect(asked).toEqual([
        { email: null, method: `oauth_${provider}`, client: 'ios', ipAddress: null },
      ])
      expect(JSON.stringify(asked)).not.toContain(accountId)
      // A second sign-in is no sign-up.
      await signIn(provider, { subject: accountId })
      expect(asked).toHaveLength(1)
    })

    // What the side-by-side test of an existing and a new address is for the other sign-up
    // paths: there is no address to compare here, so the claim is about *when*. Whether the
    // hook was asked must say nothing before the browser that started has been proven.
    test('is asked only at the exchange, after the binding: not at the start, the callback or for a known identity', async () => {
      const exchange = (fragment: URLSearchParams, binding: string) =>
        app.request('/v1/client/sign-ins/oauth/exchange', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tula-publishable-key': PK },
          body: JSON.stringify({
            ticket: fragment.get('tula_ticket'),
            attemptId: fragment.get('tula_attempt'),
            binding,
          }),
        })

      const started = await start(provider)
      expect(asked).toEqual([])
      const consented = await consent(started.authorizationUrl, { subject: accountId })
      const callback = await app.request(pathOf(consented.headers.get('location') as string))
      const fragment = new URLSearchParams(
        (callback.headers.get('location') as string).split('#')[1]
      )
      expect(fragment.get('tula_ticket')).toBeTruthy()
      expect(asked).toEqual([])

      // Another browser's binding (login CSRF): refused before the account is resolved.
      const other = await start(provider)
      const foreign = await exchange(fragment, other.binding)
      expect(((await foreign.json()) as { code: string }).code).toBe('oauth.different_browser')
      expect(asked).toEqual([])
      expect(await users()).toEqual([])

      const own = await exchange(fragment, started.binding)
      expect(((await own.json()) as FlowAttempt).step.status).toBe('complete')
      expect(asked).toHaveLength(1)

      // The identity is known now: every later sign-in resolves to its user, and asks nobody
      // at any of the three steps.
      expect((await signIn(provider, { subject: accountId })).status).toBe('complete')
      expect(asked).toHaveLength(1)
    })

    test('a denial makes no account, and the next try asks again', async () => {
      const spy = spyOn(Hooks, 'beforeSignUp')
      try {
        spy.mockImplementationOnce(() => {
          throw new AuthError('hook.denied', { code: 'not_invited' })
        })
        const refused = await signIn(provider, { subject: accountId })
        expect(refused.code).toBe('hook.denied')
        expect(await users()).toEqual([])
        expect(created()).toEqual([])
        expect((await signIn(provider, { subject: accountId })).status).toBe('complete')
        expect(asked).toHaveLength(1)
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('what an account with no address can and cannot do', () => {
    let session: Outcome

    beforeEach(async () => {
      await configure(provider)
      session = await signIn(provider, { subject: accountId, given_name: 'Nelly' })
      expect(session.status).toBe('complete')
    })

    test('its only identity cannot be removed, with every other method on', async () => {
      const token = session.accessToken as string
      const { data } = (await (await me('GET', '/identities', token)).json()) as {
        data: { id: string; provider: string }[]
      }
      expect(data.map((identity) => identity.provider)).toEqual([provider])
      const res = await me('DELETE', `/identities/${data[0]?.id}`, token)
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe('identity.last_sign_in_method')
      expect(
        await deps.users.listIdentities(TEST_TENANT.environmentId, session.userId as string)
      ).toHaveLength(1)
    })

    test('an administrator cannot give it a password, so a password never counts as its way in', async () => {
      const res = await admin('PUT', `/users/${session.userId}/password`, {
        password: 'correct horse battery staple 42',
      })
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe('resource.conflict')
      const means = (await (
        await admin('GET', `/users/${session.userId}/authentication`)
      ).json()) as UserAuthentication
      expect(means).toMatchObject({ hasPassword: false, emailVerified: false })
      expect(means.identities.map((identity) => identity.provider)).toEqual([provider])
      // Still refused afterwards.
      const token = session.accessToken as string
      const { data } = (await (await me('GET', '/identities', token)).json()) as {
        data: { id: string }[]
      }
      expect((await me('DELETE', `/identities/${data[0]?.id}`, token)).status).toBe(409)
    })

    test('changing a password answers that there is none', async () => {
      const res = await me('POST', '/password', session.accessToken as string, {
        currentPassword: 'anything at all',
        newPassword: 'correct horse battery staple 42',
      })
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe('password.not_set')
    })

    test('it has nothing to step up with: no password, no address for a code', async () => {
      expect(await Mfa.stepUpMethods(deps, tenant, session.userId as string)).toEqual([])
      const res = await app.request('/v1/client/sessions/step-up/email-code', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          'x-tula-publishable-key': PK,
        },
        body: JSON.stringify({ method: 'email_code' }),
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({
        code: 'auth.step_up_required',
        params: { methods: '' },
      })
      expect(deps.mailer.outbox).toEqual([])
    })

    test('an authenticator app is enrolled under its name, right after the sign-in', async () => {
      const res = await me('POST', '/factors/totp', session.accessToken as string, {})
      expect(res.status).toBe(200)
      const { uri } = (await res.json()) as { uri: string }
      expect(uri).toContain(':Nelly?secret=')
      expect(uri).not.toContain('null')
      expect(uri).not.toContain(accountId)
    })

    test('it adds and confirms a phone number, and the send limits are keyed by its id', async () => {
      deps.environmentSettings.seed(TEST_TENANT.environmentId, {
        revision: 1,
        settings: {
          ...DEFAULT_ENVIRONMENT_SETTINGS,
          urls: { allowedOrigins: ['https://app.northline.test'], allowedRedirectUrls: [REDIRECT] },
          sms: { ...DEFAULT_ENVIRONMENT_SETTINGS.sms, enabled: true, allowedCountries: ['US'] },
        },
      })
      const limited = spyOn(deps.rateLimiter, 'hit')
      const hashed = spyOn(deps.keyedHash, 'hmac')
      const token = session.accessToken as string
      const userId = session.userId as string

      const asked = await me('POST', '/phone', token, { phoneNumber: '+1 (415) 555-0142' })
      expect(asked.status).toBe(200)
      const text = deps.sms.messages('+14155550142').at(-1)?.text ?? ''
      const code = /(\d{6})\D*$/.exec(text)?.[1] as string
      expect(code).toMatch(/^\d{6}$/)

      // Per asker means per user id: there is no address to key anything by, and nothing
      // was keyed by a missing one.
      const keys = limited.mock.calls.map(([key]) => String(key))
      expect(keys.some((key) => key.endsWith(`:user:${userId}`))).toBe(true)
      const inputs = JSON.stringify([keys, hashed.mock.calls])
      expect(inputs).not.toContain('null')
      expect(inputs).not.toContain('undefined')

      const confirmed = await me('POST', '/phone/verify', token, { code })
      expect(confirmed.status).toBe(200)
      const profile = (await (await me('GET', '', token)).json()) as CurrentUser
      expect(profile).toMatchObject({ id: userId, email: null, phoneNumber: '+14155550142' })
      expect(typeof profile.phoneNumberVerifiedAt).toBe('string')
      // Still nothing to email, and the number is no way to sign in.
      await Notices.settled()
      expect(deps.mailer.outbox).toEqual([])
      const means = (await (
        await admin('GET', `/users/${userId}/authentication`)
      ).json()) as UserAuthentication
      expect(means).toMatchObject({ hasPassword: false, emailVerified: false })
    })

    test('a connected-account notice has nowhere to go and fails nothing', async () => {
      const user = await deps.users.findById(TEST_TENANT.environmentId, session.userId as string)
      Notices.identityChanged(deps, tenant, user as NonNullable<typeof user>, {
        change: 'linked',
        provider,
        at: deps.clock.now(),
      })
      await Notices.settled()
      expect(deps.mailer.outbox).toEqual([])
    })

    test('a JWT template that names the address, or whether it is verified, adds no key for either', async () => {
      deps.environmentSettings.seed(TEST_TENANT.environmentId, {
        revision: 1,
        settings: {
          ...DEFAULT_ENVIRONMENT_SETTINGS,
          urls: { allowedOrigins: [], allowedRedirectUrls: [REDIRECT] },
          sessions: {
            ...DEFAULT_ENVIRONMENT_SETTINGS.sessions,
            jwtTemplates: {
              app: {
                claims: {
                  mail: { from: 'user.email' },
                  proven: { from: 'user.email_verified' },
                  kind: { from: 'session.client' },
                },
              },
            },
            profiles: {
              ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles,
              web: { ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles.web, jwtTemplate: 'app' },
              mobile: {
                ...DEFAULT_ENVIRONMENT_SETTINGS.sessions.profiles.mobile,
                jwtTemplate: 'app',
              },
            },
          },
        },
      })
      const again = await signIn(provider, { subject: accountId })
      expect(again.status).toBe('complete')
      // The template is applied (the client kind is there); an address that is not there has
      // no value and neither has "is it verified", so neither has a key.
      expect(decodeJwt(again.accessToken as string).ext).toEqual({ kind: 'ios' })
    })

    // Pinned, not prevented (ADR 0026, "A user may now have no email address"): the server
    // refuses a change that leaves the *environment* no sign-in method, and never asks whether
    // some *user* depends on the provider. For an account with an address that is recoverable
    // (a reset sets a first password, an administrator can set one); for this one it is not.
    test.each([
      ['switches the provider off', () => configure(provider, { enabled: false }), 200],
      ['removes its credentials', () => admin('DELETE', `/oauth-providers/${provider}`), 204],
    ])(
      'an account whose only way in is this provider is locked out when the operator %s',
      async (_n, takeAway, answered) => {
        const userId = session.userId as string
        // Nothing refuses it and nothing warns: the password is still a method of the
        // environment, which is all the server asks.
        expect((await takeAway()).status).toBe(answered)

        // The one way in: closed at the start, before any redirect.
        const started = await app.request('/v1/client/sign-ins/oauth', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tula-publishable-key': PK,
            'x-tula-client': 'ios',
          },
          body: JSON.stringify({ provider, redirectUrl: REDIRECT }),
        })
        expect(((await started.json()) as { code: string }).code).toBe('auth.method_disabled')

        // Every other way in needs something this account does not have and cannot be given:
        // no password (and none can be set), no address for a code, a link or a reset, no
        // passkey, no other identity.
        const means = (await (
          await admin('GET', `/users/${userId}/authentication`)
        ).json()) as UserAuthentication
        expect(means).toMatchObject({ hasPassword: false, emailVerified: false, passkeys: [] })
        expect(means.identities.map((identity) => identity.provider)).toEqual([provider])
        expect(
          (
            await admin('PUT', `/users/${userId}/password`, {
              password: 'correct horse battery staple 42',
            })
          ).status
        ).toBe(409)
        const user = await deps.users.findById(TEST_TENANT.environmentId, userId)
        expect(user).toMatchObject({ email: null, emailNormalized: null })
        // The rule the server itself judges "can still sign in" by agrees.
        expect(
          OAuth.canStillSignIn(
            await Settings.current(deps, tenant),
            await OAuth.enabledProviders(deps, tenant),
            {
              hasPassword: means.hasPassword,
              emailVerified: means.emailVerified,
              providers: [provider],
              passkeys: means.passkeys.length,
            }
          )
        ).toBe(false)

        // The account is still there, and an administrator still sees it.
        const shown = await admin('GET', `/users/${userId}`)
        expect(shown.status).toBe(200)
        expect(await shown.json()).toMatchObject({ id: userId, email: null, firstName: 'Nelly' })
        expect((await users()).map((entry) => entry.id)).toEqual([userId])

        // The session it already has is not ended by the change: it lasts as its profile says.
        const refreshed = await app.request('/v1/client/sessions/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tula-publishable-key': PK },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        })
        expect(refreshed.status).toBe(200)

        // Nothing was deleted: the provider configured again is the same account again.
        await configure(provider)
        expect(await signIn(provider, { subject: accountId })).toMatchObject({
          status: 'complete',
          userId,
        })
      }
    )

    test('an administrator sees it in the list, searches past it and sorts it last by address', async () => {
      await account(true, 'zoe@northline.app')
      const page = async (query: string) =>
        ((await (await admin('GET', `/users?${query}`)).json()) as UserList).data.map(
          (user) => user.email
        )
      expect(await page('sort=email')).toEqual(['zoe@northline.app', null])
      expect(await page('sort=-email')).toEqual(['zoe@northline.app', null])
      expect(await page('q=northline')).toEqual(['zoe@northline.app'])
      expect(await page('q=nelly')).toEqual([null])
    })
  })
})

describe('every other provider', () => {
  test.each(['google', 'github', 'discord'])(
    '%s with no address is still refused, and creates nothing',
    async (provider) => {
      await configure(provider)
      const subject = provider === 'discord' ? '80351110224678912' : 'the-subject'
      expect((await signIn(provider, { subject })).code).toBe('oauth.email_missing')
      expect(await users()).toEqual([])
    }
  )
})
