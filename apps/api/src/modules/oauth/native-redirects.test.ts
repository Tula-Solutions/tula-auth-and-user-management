import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  bindsCodeWithPkce,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type FlowAttempt,
  OAUTH_PROVIDERS,
  OAUTH_PROVIDERS_WITH_PKCE,
  OAUTH_PROVIDERS_WITHOUT_PKCE,
  type OAuthProvider,
  type OAuthStart,
} from '@tula/contract'
import { createAppleProvider } from '~/adapters/oauth/apple'
import { createDiscordProvider } from '~/adapters/oauth/discord'
import { createFacebookProvider } from '~/adapters/oauth/facebook'
import { createGitHubProvider } from '~/adapters/oauth/github'
import { createGoogleProvider } from '~/adapters/oauth/google'
import { createLinkedInProvider } from '~/adapters/oauth/linkedin'
import { createMicrosoftProvider } from '~/adapters/oauth/microsoft'
import { createXProvider } from '~/adapters/oauth/x'
import { createApp } from '~/index'
import * as Flows from '~/modules/flow/service'
import { OAUTH_INVALID_PAGE } from '~/modules/oauth/router'
import type { OAuthProvider as OAuthProviderPort } from '~/ports/oauth-provider'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// Where a provider sign-in may send the user back to (ADR 0044): a web page, an app link (an
// https URL the platform hands to an app) or a custom scheme. All three are entries of the one
// allow-list and are matched exactly; only the custom scheme has rules beyond that.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const CLIENT_SECRET = 'GOCSPX-test-client-secret-value'
const EMAIL = 'maya@northline.app'
/** An app link: an https URL of the operator's domain that a registered app opens. */
const APP_LINK = 'https://app.northline.app/oauth/callback'
/** A custom scheme in reverse-domain form. Any app on a device may claim it. */
const CUSTOM = 'app.northline.ios:/oauth/callback'

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  // A deployed tier: in `local` any loopback http URL is allowed as well.
  deps = createTestDeps()
  deps.config = { ...deps.config, tier: 'prod' }
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  app = createApp(deps)
  await saveSettings({ urls: { allowedRedirectUrls: [APP_LINK, CUSTOM] } })
  for (const provider of OAUTH_PROVIDERS) {
    await configure(provider)
  }
})

const json = async <T>(res: Response) => (await res.json()) as T

function admin(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  return app.request(`/v1/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json', ...extra },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

async function putSettings(settings: Record<string, unknown>) {
  const current = await admin('GET', '/settings')
  return admin('PUT', '/settings', settings, { 'if-match': current.headers.get('etag') ?? '"0"' })
}

async function saveSettings(settings: Record<string, unknown>) {
  expect((await putSettings(settings)).status).toBe(200)
}

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

async function configure(provider: OAuthProvider) {
  const body =
    provider === 'apple'
      ? {
          clientId: 'app.northline.web',
          teamId: 'TEAM123456',
          keyId: 'KEY1234567',
          privateKey: await applePrivateKey(),
        }
      : {
          clientId: `${provider}-client-id`,
          clientSecret: CLIENT_SECRET,
          ...(provider === 'microsoft' && { tenant: 'common' }),
        }
  const res = await admin('PUT', `/oauth-providers/${provider}`, body)
  // A refusal here would hide every later assertion behind `auth.method_disabled`.
  expect([provider, res.status]).toEqual([provider, 200])
}

function client(path: string, body: unknown, kind = 'ios', extra: Record<string, string> = {}) {
  return app.request(`/v1/client${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
      'x-tula-client': kind,
      ...extra,
    },
    body: JSON.stringify(body),
  })
}

const startWith = (provider: OAuthProvider, redirectUrl: string, kind = 'ios') =>
  client('/sign-ins/oauth', { provider, redirectUrl }, kind)

async function started(provider: OAuthProvider, redirectUrl: string, kind = 'ios') {
  const res = await startWith(provider, redirectUrl, kind)
  expect(res.status).toBe(200)
  const body = await json<OAuthStart>(res)
  return { ...body, state: new URL(body.authorizationUrl).searchParams.get('state') ?? '' }
}

const callback = (provider: OAuthProvider, state: string) =>
  app.request(`/v1/oauth/callback/${provider}?${new URLSearchParams({ state, code: 'c' })}`)

const exchange = (body: { ticket: string; attemptId: string; binding?: string }) =>
  client('/sign-ins/oauth/exchange', body)

const actions = () => deps.activityLog.entries.map((entry) => entry.type)

/** A refusal: its code and its params, and nothing stored or asked of a provider. */
async function refusal(res: Response) {
  expect(res.status).toBe(400)
  const body = await json<{ code: string; params?: Record<string, unknown> }>(res)
  expect(body.code).toBe('request.redirect_not_allowed')
  return body.params
}

describe('the allow-list is matched exactly, whatever kind of URL an entry is', () => {
  test.each([
    ['an app link with a trailing slash', `${APP_LINK}/`],
    [
      'an app link whose host is in another case',
      APP_LINK.replace('app.northline', 'App.Northline'),
    ],
    ['an app link whose scheme is in another case', APP_LINK.replace('https', 'HTTPS')],
    ['an app link with an encoded letter in its path', APP_LINK.replace('oauth', 'o%61uth')],
    ['an app link with an encoded slash', APP_LINK.replace('/callback', '%2Fcallback')],
    ['an app link with an explicit default port', APP_LINK.replace('.app/', '.app:443/')],
    ['an app link with a dot segment', APP_LINK.replace('/oauth', '/x/../oauth')],
    ['an app link with a query', `${APP_LINK}?x=1`],
    ['an app link with an empty query', `${APP_LINK}?`],
    ['an app link with a fragment', `${APP_LINK}#x`],
    ['a longer path under an app link', `${APP_LINK}/more`],
    ['a shorter path than the app link', APP_LINK.replace('/callback', '')],
    ['a custom scheme with a trailing slash', `${CUSTOM}/`],
    ['a custom scheme in another case', CUSTOM.replace('app.northline', 'App.Northline')],
    ['a custom scheme with two slashes', CUSTOM.replace(':/', '://')],
    ['a custom scheme with a host in front of the path', CUSTOM.replace(':/', '://evil.test/')],
    ['a custom scheme with another path', CUSTOM.replace('callback', 'other')],
    ['a custom scheme with an encoded letter', CUSTOM.replace('oauth', 'o%61uth')],
    ['a custom scheme with a query', `${CUSTOM}?x=1`],
    ['a custom scheme with a fragment', `${CUSTOM}#x`],
    ['a longer scheme that starts with the listed one', `${CUSTOM.replace(':/', '.evil:/')}`],
    ['another app’s scheme', 'app.evil.ios:/oauth/callback'],
    ['a scheme a browser runs', 'javascript:alert(1)'],
    ['a scheme with no full stop', 'northline:/oauth/callback'],
  ])('%s is not the listed URL', async (_name, redirectUrl) => {
    const create = spyOn(deps.flowAttempts, 'create')
    // No reason is given for a URL that is not listed: nothing is said of what it would be.
    expect(await refusal(await startWith('google', redirectUrl))).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    expect(deps.oauth.google.requests).toHaveLength(0)
  })

  test('each listed URL is allowed as it is written', async () => {
    expect((await startWith('google', APP_LINK)).status).toBe(200)
    expect((await startWith('google', CUSTOM)).status).toBe(200)
  })
})

describe('a custom-scheme redirect and the provider', () => {
  test('every provider is in exactly one of the two lists, and the list is what decides', () => {
    for (const provider of OAUTH_PROVIDERS) {
      const withPkce = (OAUTH_PROVIDERS_WITH_PKCE as readonly string[]).includes(provider)
      const without = (OAUTH_PROVIDERS_WITHOUT_PKCE as readonly string[]).includes(provider)
      // A provider in neither list, or in both, fails here: adding one is a decision.
      expect([provider, withPkce !== without]).toEqual([provider, true])
      expect(bindsCodeWithPkce(provider)).toBe(withPkce)
    }
    expect(OAUTH_PROVIDERS_WITH_PKCE.length + OAUTH_PROVIDERS_WITHOUT_PKCE.length).toBe(
      OAUTH_PROVIDERS.length
    )
  })

  test('the lists say what the adapters do: a challenge is sent by exactly the providers with PKCE', async () => {
    const privateKey = await applePrivateKey()
    const adapters: Record<OAuthProvider, OAuthProviderPort> = {
      google: createGoogleProvider(),
      github: createGitHubProvider(),
      apple: createAppleProvider(),
      microsoft: createMicrosoftProvider(),
      discord: createDiscordProvider(),
      linkedin: createLinkedInProvider(),
      x: createXProvider(),
      facebook: createFacebookProvider(),
    }
    for (const provider of OAUTH_PROVIDERS) {
      const url = new URL(
        adapters[provider].authorizationUrl(
          {
            clientId: 'client',
            clientSecret: 'secret',
            tenant: 'common',
            teamId: 'TEAM123456',
            keyId: 'KEY1234567',
            privateKey,
          },
          {
            state: 'state',
            codeVerifier: 'v'.repeat(43),
            nonce: 'nonce',
            redirectUri: `https://auth.northline.app/v1/oauth/callback/${provider}`,
          }
        )
      )
      // The list is a statement about the adapter. One that stops sending a challenge while
      // its provider stays on the PKCE list would leave a custom scheme with nothing behind it.
      expect([provider, url.searchParams.get('code_challenge_method') === 'S256']).toEqual([
        provider,
        bindsCodeWithPkce(provider),
      ])
      expect([provider, url.searchParams.has('code_challenge')]).toEqual([
        provider,
        bindsCodeWithPkce(provider),
      ])
    }
  })

  test.each([...OAUTH_PROVIDERS_WITH_PKCE])(
    '%s, whose code is bound with PKCE, may return to a listed custom scheme',
    async (provider) => {
      const start = await started(provider, CUSTOM)
      expect(start.binding).toMatch(/^tula_ob_/)
      expect(deps.oauth[provider].requests).toHaveLength(1)
    }
  )

  test.each([...OAUTH_PROVIDERS_WITHOUT_PKCE])(
    '%s, whose code is not, is refused a listed custom scheme before anything is made or counted',
    async (provider) => {
      const create = spyOn(deps.flowAttempts, 'create')
      const charge = spyOn(deps.rateLimiter, 'hit')
      const res = await startWith(provider, CUSTOM)
      expect(await refusal(res)).toEqual({ reason: 'provider_without_pkce' })
      expect(create).not.toHaveBeenCalled()
      expect(deps.oauth[provider].requests).toHaveLength(0)
      const refused = charge.mock.calls.map(([key]) => key)
      charge.mockClear()
      // The same provider with the app link is a sign-in like any other, and counts one thing
      // more than the refused start did: the environment's ceiling for provider sign-ins,
      // which only an attempt that is made is charged against.
      expect((await startWith(provider, APP_LINK)).status).toBe(200)
      const made = charge.mock.calls.map(([key]) => key)
      expect(made.slice(0, refused.length)).toEqual(refused)
      expect(made).toHaveLength(refused.length + 1)
      expect(made.at(-1)).toContain(TEST_TENANT.environmentId)
    }
  )

  test('the refusal is about the provider and the URL: no user is looked for', async () => {
    const byEmail = spyOn(deps.users, 'findByEmail')
    const byId = spyOn(deps.users, 'findById')
    await refusal(await startWith('apple', CUSTOM))
    await refusal(await startWith('facebook', CUSTOM))
    expect(byEmail).not.toHaveBeenCalled()
    expect(byId).not.toHaveBeenCalled()
  })

  test('a provider that is switched off answers that, not what its redirect would have been', async () => {
    await admin('PUT', '/oauth-providers/linkedin', {
      clientId: 'linkedin-client-id',
      clientSecret: CLIENT_SECRET,
      enabled: false,
    })
    const res = await startWith('linkedin', CUSTOM)
    expect((await json<{ code: string }>(res)).code).toBe('auth.method_disabled')
  })
})

describe('a custom-scheme redirect and the client', () => {
  test.each(['ios', 'android'])(
    'a %s attempt may return to a listed custom scheme',
    async (kind) => {
      expect((await startWith('google', CUSTOM, kind)).status).toBe(200)
    }
  )

  test.each(['web', 'server'])(
    'a %s attempt is refused one: nothing a browser or a server holds is an app’s',
    async (kind) => {
      const create = spyOn(deps.flowAttempts, 'create')
      expect(await refusal(await startWith('google', CUSTOM, kind))).toEqual({
        reason: 'client_not_native',
      })
      expect(create).not.toHaveBeenCalled()
      expect(deps.oauth.google.requests).toHaveLength(0)
      // An app link is a web address: every client kind may have it.
      expect((await startWith('google', APP_LINK, kind)).status).toBe(200)
    }
  )

  test('a request that names no client kind is a browser’s, and is refused one', async () => {
    const res = await app.request('/v1/client/sign-ins/oauth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tula-publishable-key': PK },
      body: JSON.stringify({ provider: 'google', redirectUrl: CUSTOM }),
    })
    expect(await refusal(res)).toEqual({ reason: 'client_not_native' })
  })

  test('a publishable key is enough to tell a listed custom scheme from an unlisted one, and that is all it tells', async () => {
    // Kept on purpose (ADR 0044): the reason is what lets an integrator see which rule
    // stopped them. The list is no secret (every entry appears in a redirect), and the
    // start looks up no user, so the answer says nothing about anyone.
    const unlisted = 'app.northline.other:/oauth/callback'
    const listed = await refusal(await startWith('google', CUSTOM, 'web'))
    const other = await startWith('google', unlisted, 'web')
    expect(listed).toEqual({ reason: 'client_not_native' })
    expect(await refusal(other)).toBeUndefined()
    // The reason has two fixed words and never the URL or anything of the list.
    const body = await (await startWith('google', CUSTOM, 'web')).text()
    expect(Object.keys(JSON.parse(body).params)).toEqual(['reason'])
    // The same for an account that exists and one that does not: the start takes no
    // identifier, and no user is read.
    const find = spyOn(deps.users, 'findById')
    await startWith('google', CUSTOM, 'web')
    expect(find).not.toHaveBeenCalled()
  })

  test('the provider’s rule is said first: a browser asking Apple for a scheme hears of PKCE', async () => {
    expect(await refusal(await startWith('apple', CUSTOM, 'web'))).toEqual({
      reason: 'provider_without_pkce',
    })
  })
})

describe('the callback', () => {
  test.each([
    ['a custom scheme', CUSTOM],
    ['an app link', APP_LINK],
  ])('sends the ticket to %s in the fragment, as a bare redirect', async (_name, redirectUrl) => {
    const start = await started('google', redirectUrl)
    const res = await callback('google', start.state)
    expect(res.status).toBe(303)
    const location = res.headers.get('location') ?? ''
    // The listed URL, untouched, then the fragment: nothing is added to its path or a query.
    expect(location.startsWith(`${redirectUrl}#tula_ticket=tula_ot_`)).toBe(true)
    expect(location.slice(redirectUrl.length)).toMatch(
      /^#tula_ticket=tula_ot_[\w-]{43}&tula_attempt=[0-9a-f-]{36}$/
    )
    expect(location).not.toContain('?')
    // A redirect and nothing else: no page, so no script and no markup that could carry one.
    expect(await res.text()).toBe('')
    expect(res.headers.get('content-type')).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(actions()).not.toContain('session.created')
  })

  test.each([
    ['a custom scheme', CUSTOM],
    ['an app link', APP_LINK],
  ])(
    'a ticket sent to %s completes nothing without the binding the starting app holds',
    async (_name, redirectUrl) => {
      deps.oauth.google.profile = { ...deps.oauth.google.profile, email: EMAIL }
      const start = await started('google', redirectUrl)
      const location = (await callback('google', start.state)).headers.get('location') ?? ''
      const params = new URLSearchParams(location.slice(location.indexOf('#') + 1))
      const ticket = params.get('tula_ticket') ?? ''
      const attemptId = params.get('tula_attempt') ?? ''
      // What another app that claimed the scheme, or was handed the link, has: the ticket and
      // the attempt's id, both from the URL. Neither alone nor together are they enough.
      for (const binding of [undefined, 'tula_ob_wrong', ticket]) {
        const res = await exchange({ ticket, attemptId, binding })
        expect(res.status).toBe(409)
        expect((await json<{ code: string }>(res)).code).toBe('oauth.different_browser')
      }
      expect(actions()).not.toContain('session.created')
      expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toBeNull()
      // Nothing was used up: the app that started the sign-in still completes it.
      const res = await exchange({ ticket, attemptId, binding: start.binding })
      expect(res.status).toBe(200)
      expect((await json<FlowAttempt>(res)).step.status).toBe('complete')
    }
  )

  describe('a stored redirect URL that no header can carry', () => {
    // No save accepts such an entry and the stores' tolerant read drops one. The memory
    // store holds what it is given, which is how the server's own defences are reached.
    const BAD = [
      ['a NUL', 'https://app.northline.example/\u{0}x'],
      ['a right-to-left override', 'https://app.northline.example/\u{202e}x'],
      ['a line break', 'https://app.northline.example/x\r\nset-cookie: a=b'],
      ['a backslash', 'https://app.northline.example\\evil.example'],
    ] as const

    const seed = (redirectUrl: string) =>
      deps.environmentSettings.seed(TEST_TENANT.environmentId, {
        revision: 7,
        settings: {
          ...DEFAULT_ENVIRONMENT_SETTINGS,
          urls: { allowedOrigins: [], allowedRedirectUrls: [APP_LINK, redirectUrl] },
        },
      })

    test.each(BAD)(
      'with %s is refused when a sign-in starts, listed as it is',
      async (_name, url) => {
        seed(url)
        const made = spyOn(deps.flowAttempts, 'create')
        expect(await refusal(await startWith('google', url))).toBeUndefined()
        expect(made).not.toHaveBeenCalled()
      }
    )

    test.each(BAD)(
      'with %s on an attempt already made ends on the static page, never a 500',
      async (_name, url) => {
        seed(url)
        const start = await started('google', APP_LINK)
        const row = await deps.flowAttempts.findById(TEST_TENANT.environmentId, start.attempt.id)
        const state = row?.state as { oauth: { redirectUrl: string } }
        await deps.flowAttempts.transition(
          TEST_TENANT.environmentId,
          start.attempt.id,
          'needs_first_factor',
          {
            status: 'needs_first_factor',
            state: { ...state, oauth: { ...state.oauth, redirectUrl: url } },
          },
          deps.clock.now()
        )
        const res = await callback('google', start.state)
        expect(res.status).toBe(400)
        expect(res.headers.get('location')).toBeNull()
        expect(res.headers.get('set-cookie')).toBeNull()
        expect(await res.text()).toBe(OAUTH_INVALID_PAGE)
        expect(deps.oauth.google.exchanges).toHaveLength(0)
      }
    )

    test.each([
      ['a NUL', 'https://app.northline.example/\u{0}x#tula_ticket=t'],
      ['a line break', 'https://app.northline.example/x\r\nset-cookie: a=b#tula_ticket=t'],
    ])(
      'a redirect that cannot be built (%s) is the static page, whatever let it through',
      async (_name, redirectTo) => {
        // The last defence, with everything before it taken away: the flow service is made
        // to answer a destination the runtime refuses to put in a header.
        const answered = spyOn(Flows, 'oauthCallback').mockResolvedValue({ redirectTo })
        try {
          const res = await callback('google', 'any-state')
          expect(res.status).toBe(400)
          expect(res.headers.get('location')).toBeNull()
          expect(res.headers.get('set-cookie')).toBeNull()
          expect(res.headers.get('cache-control')).toBe('no-store')
          expect(await res.text()).toBe(OAUTH_INVALID_PAGE)
        } finally {
          answered.mockRestore()
        }
      }
    )
  })

  test('a custom scheme taken off the list while the user was away gets the static page', async () => {
    const start = await started('google', CUSTOM)
    await saveSettings({ urls: { allowedRedirectUrls: [APP_LINK] } })
    const res = await callback('google', start.state)
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).not.toContain(CUSTOM)
  })

  test.each([
    ['a provider without PKCE', 'apple', 'ios'],
    ['a browser', 'google', 'web'],
  ] as const)(
    'asks the rule again: an attempt of %s that holds a custom scheme is sent nowhere',
    async (_name, provider, kind) => {
      // No request can make such an attempt (the start refuses it). One is made here as a
      // stored row would have to be: started with the app link, then pointed at the scheme.
      const start = await started(provider, APP_LINK, kind)
      const row = await deps.flowAttempts.findById(TEST_TENANT.environmentId, start.attempt.id)
      const state = row?.state as { oauth: { redirectUrl: string } }
      const moved = await deps.flowAttempts.transition(
        TEST_TENANT.environmentId,
        start.attempt.id,
        'needs_first_factor',
        {
          status: 'needs_first_factor',
          state: { ...state, oauth: { ...state.oauth, redirectUrl: CUSTOM } },
        },
        deps.clock.now()
      )
      expect(moved).not.toBeNull()
      const res = await callback(provider, start.state)
      expect(res.status).toBe(400)
      expect(res.headers.get('location')).toBeNull()
      // The provider is not asked for anything with the code.
      expect(deps.oauth[provider].exchanges).toHaveLength(0)
    }
  )
})

describe('what else asks for a redirect URL', () => {
  test('connecting a provider from a profile is a browser’s act: a custom scheme is refused', async () => {
    // A session, by signing in with the app link.
    const start = await started('google', APP_LINK)
    const location = (await callback('google', start.state)).headers.get('location') ?? ''
    const params = new URLSearchParams(location.slice(location.indexOf('#') + 1))
    const done = await json<FlowAttempt>(
      await exchange({
        ticket: params.get('tula_ticket') ?? '',
        attemptId: params.get('tula_attempt') ?? '',
        binding: start.binding,
      })
    )
    const token = done.session?.accessToken ?? ''
    expect(token).not.toBe('')
    const res = await client(
      '/me/identities/oauth',
      { provider: 'github', redirectUrl: CUSTOM },
      'ios',
      {
        authorization: `Bearer ${token}`,
      }
    )
    expect(await refusal(res)).toEqual({ reason: 'client_not_native' })
  })
})

describe('listing a custom scheme in the settings', () => {
  test.each([
    ['no full stop in the scheme', 'northline:/oauth'],
    ['an upper-case scheme', 'App.Northline.ios:/oauth'],
    ['a scheme a browser runs', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,x'],
    ['an intent', 'intent://x#Intent;scheme=https;end'],
    ['a user name', 'app.northline.ios://user@host/oauth'],
    ['a query', 'app.northline.ios:/oauth?x=1'],
    ['a fragment', 'app.northline.ios:/oauth#x'],
    ['a wildcard', 'app.northline.ios:/*'],
    ['an encoded octet', 'app.northline.ios:/o%61uth'],
    ['a dot segment', 'app.northline.ios:/a/../b'],
    ['no path', 'app.northline.ios:'],
    ['a space', 'app.northline.ios:/oa uth'],
    ['a line break', 'app.northline.ios:/oauth\n'],
    ['an invisible character', 'app.northline.ios:/oauth\u{200B}'],
    ['a web scheme with a full stop', 'https.example:/oauth'.replace('https.example', 'https')],
    // What a `Location` header cannot carry, or a reader cannot see, in a web address.
    ['a NUL in a web address', 'https://a.com/\u{0}x'],
    ['DEL in a web address', 'https://a.com/\u{7f}x'],
    ['a C1 control in a web address', 'https://a.com/\u{85}x'],
    ['a right-to-left override in a web address', 'https://a.com/\u{202e}x'],
    ['a backslash in a web address', 'https://a.com\\evil.com'],
  ])('refuses one with %s', async (_name, url) => {
    const res = await putSettings({ urls: { allowedRedirectUrls: [url] } })
    expect(res.status).toBe(422)
  })

  test('is recorded as a weakening by the list’s name, and never by the URL', async () => {
    await saveSettings({ urls: { allowedRedirectUrls: [APP_LINK] } })
    await saveSettings({
      urls: { allowedRedirectUrls: [APP_LINK, 'app.northline.android:/oauth'] },
    })
    const entry = deps.activityLog.entries.at(-1)
    expect(entry?.type).toBe('environment.settings_updated')
    expect(entry?.data).toMatchObject({ changed: ['urls.allowedRedirectUrls'], weakened: true })
    const text = JSON.stringify(deps.activityLog.entries)
    expect(text).not.toContain('app.northline.android')
    expect(text).not.toContain(APP_LINK)
  })

  test('a web address more, and a custom scheme taken away, are not weakenings', async () => {
    await saveSettings({ urls: { allowedRedirectUrls: [APP_LINK, CUSTOM, 'https://x.test/cb'] } })
    expect(deps.activityLog.entries.at(-1)?.data).not.toHaveProperty('weakened')
    await saveSettings({ urls: { allowedRedirectUrls: [APP_LINK] } })
    expect(deps.activityLog.entries.at(-1)?.data).not.toHaveProperty('weakened')
  })
})
