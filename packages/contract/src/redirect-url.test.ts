import { describe, expect, test } from 'bun:test'
import { OAUTH_PROVIDERS } from './oauth'
import {
  bindsCodeWithPkce,
  CUSTOM_SCHEME_REDIRECT_REFUSALS,
  customSchemeRedirectRefusal,
  isCustomSchemeRedirectUrl,
  isRedirectUrl,
  OAUTH_PROVIDERS_WITH_PKCE,
  OAUTH_PROVIDERS_WITHOUT_PKCE,
  REDIRECT_SCHEMES_NEVER_CUSTOM,
  redirectUrlKind,
} from './redirect-url'

describe('redirectUrlKind', () => {
  test.each([
    ['https://app.example.com/oauth/callback', 'https'],
    ['https://app.example.com', 'https'],
    ['https://app.example.com/a?b=c', 'https'],
    ['https://app.example.com/caf%C3%A9', 'https'],
    ['http://localhost:5174/callback', 'loopback'],
    ['http://127.0.0.1/callback', 'loopback'],
    ['http://[::1]:3000/callback', 'loopback'],
    ['com.example.app:/oauth', 'custom_scheme'],
    ['com.example.app://oauth/callback', 'custom_scheme'],
    ['com.example.app:/', 'custom_scheme'],
    ['com.example.my-app:/oauth2redirect/example-provider', 'custom_scheme'],
    ['com.example.app:/Oauth_Callback~1.x', 'custom_scheme'],
  ] as const)('%s is %s', (url, kind) => {
    expect(redirectUrlKind(url)).toBe(kind)
    expect(isRedirectUrl(url)).toBe(true)
    expect(isCustomSchemeRedirectUrl(url)).toBe(kind === 'custom_scheme')
  })

  test.each([
    // What a browser or the system handles itself, whatever follows.
    ['javascript:alert(1)'],
    ['javascript://example.com/%0aalert(1)'],
    ['JavaScript:/x'],
    ['data:text/html,<script>alert(1)</script>'],
    ['file:///etc/passwd'],
    ['blob:https://app.example.com/1'],
    ['about:blank'],
    ['mailto:a@example.com'],
    ['tel:+15550100'],
    ['sms:+15550100'],
    ['intent://scan/#Intent;scheme=zxing;end'],
    ['content://com.example/1'],
    ['ftp://example.com/x'],
    ['ws://example.com/x'],
    ['wss://example.com/x'],
    ['chrome://settings'],
    ['view-source:https://example.com'],
    ['vbscript:x'],
    ['x-apple.systempreferences:/com.apple.preference'],
    // A scheme with no full stop: any app may claim a short name, and so may the next
    // version of a browser.
    ['myapp://callback'],
    ['myapp:/callback'],
    ['app:/x'],
    // Not lower case: compared exactly, so one spelling.
    ['Com.Example.App:/oauth'],
    ['com.example.App:/oauth'],
    ['COM.EXAMPLE.APP:/oauth'],
    // A scheme is a scheme: it starts with a letter and ends before the colon.
    ['1com.example:/x'],
    ['.com.example:/x'],
    ['com..example:/x'],
    ['com.example.:/x'],
    ['com.example+app:/x'],
    ['com.example.app'],
    ['com.example.app:'],
    ['com.example.app:oauth'],
    // Credentials, a port, a query, a fragment.
    ['com.example.app://user@host/x'],
    ['com.example.app://user:pass@host/x'],
    ['com.example.app://host:8080/x'],
    ['com.example.app:/oauth?x=1'],
    ['com.example.app:/oauth?'],
    ['com.example.app:/oauth#x'],
    ['com.example.app:/oauth#'],
    // A wildcard, a percent-encoded octet, a dot segment.
    ['com.example.app:/*'],
    ['com.example.app:/oauth/*'],
    ['com.example.app:/%6fauth'],
    ['com.example.app:/a/../b'],
    ['com.example.app:/./b'],
    ['com.example.app:/a/..'],
    // Whitespace, control characters and what cannot be seen.
    ['com.example.app:/oauth '],
    [' com.example.app:/oauth'],
    ['com.example.app:/oa uth'],
    ['com.example.app:/oauth\n'],
    ['com.example.app:/oauth\u0000'],
    ['com.example.app:/oauth​'],
    ['com.example.app:/oauth‮'],
    ['com.exa​mple.app:/oauth'],
    ['com.example.app:/é'],
    ['com.example.app:\\oauth'],
    // The web rules, unchanged.
    ['http://app.example.com/callback'],
    ['https:/app.example.com/callback'],
    ['https:app.example.com/callback'],
    ['HTTPS://app.example.com/callback'],
    ['Http://localhost/callback'],
    ['https://user@app.example.com/callback'],
    ['https://app.example.com/callback#x'],
    ['https://app.example.com/*'],
    ['https://app.example.com/a b'],
    ['/callback'],
    [''],
  ])('%j is not a redirect URL', (url) => {
    expect(redirectUrlKind(url)).toBeNull()
    expect(isRedirectUrl(url)).toBe(false)
    expect(isCustomSchemeRedirectUrl(url)).toBe(false)
  })

  test('every scheme of the deny-list is refused, also when written like a reverse domain', () => {
    for (const scheme of REDIRECT_SCHEMES_NEVER_CUSTOM) {
      expect(redirectUrlKind(`${scheme}:/x`)).toBeNull()
      if (scheme !== 'https') {
        expect(redirectUrlKind(`${scheme}://x/y`)).toBeNull()
      }
    }
    expect(REDIRECT_SCHEMES_NEVER_CUSTOM).toContain('http')
    expect(REDIRECT_SCHEMES_NEVER_CUSTOM).toContain('https')
  })

  test('work is bounded: a long run of full stops or slashes is judged at once', () => {
    const started = performance.now()
    expect(redirectUrlKind(`${'a.'.repeat(1000)}:/x`)).toBeNull()
    expect(redirectUrlKind(`com.example.app:${'/a'.repeat(1000)}?`)).toBeNull()
    expect(redirectUrlKind(`com.example.app:${'/'.repeat(2000)}#`)).toBeNull()
    expect(performance.now() - started).toBeLessThan(200)
  })
})

describe('the providers that bind their code with PKCE', () => {
  test('are stated: Apple, LinkedIn and Facebook do not', () => {
    expect([...OAUTH_PROVIDERS_WITHOUT_PKCE]).toEqual(['apple', 'linkedin', 'facebook'])
    expect([...OAUTH_PROVIDERS_WITH_PKCE]).toEqual([
      'google',
      'github',
      'microsoft',
      'discord',
      'x',
    ])
  })

  test('every provider is in exactly one of the two lists', () => {
    for (const provider of OAUTH_PROVIDERS) {
      const withPkce = (OAUTH_PROVIDERS_WITH_PKCE as readonly string[]).includes(provider)
      const without = (OAUTH_PROVIDERS_WITHOUT_PKCE as readonly string[]).includes(provider)
      expect({ provider, listed: Number(withPkce) + Number(without) }).toEqual({
        provider,
        listed: 1,
      })
      expect(bindsCodeWithPkce(provider)).toBe(withPkce)
    }
    expect(OAUTH_PROVIDERS_WITH_PKCE.length + OAUTH_PROVIDERS_WITHOUT_PKCE.length).toBe(
      OAUTH_PROVIDERS.length
    )
  })

  test('a name that is no provider binds nothing', () => {
    for (const name of ['', 'Google', 'constructor', 'toString', '__proto__', 'tiktok']) {
      expect(bindsCodeWithPkce(name)).toBe(false)
    }
  })
})

describe('customSchemeRedirectRefusal', () => {
  const custom = 'com.example.app:/oauth'

  test('an https or loopback URL is refused for nothing here', () => {
    for (const url of ['https://app.example.com/cb', 'http://localhost:3000/cb']) {
      expect(customSchemeRedirectRefusal(url, { client: 'web', provider: 'apple' })).toBeNull()
      expect(customSchemeRedirectRefusal(url, { client: 'web' })).toBeNull()
    }
  })

  test.each([
    ['ios', 'google', null],
    ['android', 'github', null],
    ['ios', 'x', null],
    ['ios', 'apple', 'provider_without_pkce'],
    ['android', 'linkedin', 'provider_without_pkce'],
    ['android', 'facebook', 'provider_without_pkce'],
    ['web', 'google', 'client_not_native'],
    ['server', 'google', 'client_not_native'],
    // The provider is judged first: its refusal holds whatever the client says it is.
    ['web', 'apple', 'provider_without_pkce'],
  ] as const)('%s with %s: %s', (client, provider, reason) => {
    expect(customSchemeRedirectRefusal(custom, { client, provider })).toBe(reason)
  })

  test('with no provider (an emailed link) a custom scheme is refused for every client', () => {
    for (const client of ['web', 'ios', 'android', 'server'] as const) {
      expect(customSchemeRedirectRefusal(custom, { client })).toBe('not_a_provider_sign_in')
    }
  })

  test('the reasons are a closed list', () => {
    expect([...CUSTOM_SCHEME_REDIRECT_REFUSALS]).toEqual([
      'provider_without_pkce',
      'client_not_native',
      'not_a_provider_sign_in',
    ])
  })
})
