import { describe, expect, test } from 'bun:test'
import { readStoredEnvironmentSettings } from './environment-settings'
import { OAUTH_PROVIDERS } from './oauth'
import {
  bindsCodeWithPkce,
  CUSTOM_SCHEME_REDIRECT_REFUSALS,
  customSchemeRedirectRefusal,
  hasForbiddenRedirectCharacter,
  isCustomSchemeRedirectUrl,
  isRedirectUrl,
  OAUTH_PROVIDERS_WITH_PKCE,
  OAUTH_PROVIDERS_WITHOUT_PKCE,
  REDIRECT_SCHEME_FAMILIES_NEVER_CUSTOM,
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

  test.each([
    // A `Location` header cannot carry these, and a reader cannot see them: an entry with
    // one would be a 500 at the provider's callback, after the state is spent.
    ['a NUL', 'https://a.com/\u{0}x'],
    ['a tab', 'https://a.com/\u{9}x'],
    ['a unit separator', 'https://a.com/\u{1f}x'],
    ['DEL', 'https://a.com/\u{7f}x'],
    ['a C1 control (NEL)', 'https://a.com/\u{85}x'],
    ['the last C1 control', 'https://a.com/\u{9f}x'],
    ['a right-to-left override', 'https://a.com/\u{202e}x'],
    ['a left-to-right mark', 'https://a.com/\u{200e}x'],
    ['a private-use character', 'https://a.com/\u{e000}x'],
    ['a lone surrogate', 'https://a.com/\ud800x'],
    // The URL parser reads a backslash as a slash: what is listed would not be where it goes.
    ['a backslash after the host', 'https://a.com\\evil.com'],
    ['a backslash in the path', 'https://a.com/a\\b'],
    ['a loopback URL with a control', 'http://localhost:3000/\u{0}x'],
  ])('a web URL with %s is not a redirect URL', (_name, url) => {
    expect(redirectUrlKind(url)).toBeNull()
    expect(isRedirectUrl(url)).toBe(false)
  })

  test.each([
    // What draws nothing: two entries that differ by one of these read the same on every
    // screen, and only one of them is where the sign-in goes.
    ['a zero-width space (U+200B)', '\u{200b}'],
    ['a word joiner (U+2060)', '\u{2060}'],
    ['a soft hyphen (U+00AD)', '\u{ad}'],
    ['a Mongolian vowel separator (U+180E)', '\u{180e}'],
    ['a variation selector (U+FE0F)', '\u{fe0f}'],
    ['a variation selector of the supplement (U+E0100)', '\u{e0100}'],
    ['a tag character (U+E0041)', '\u{e0041}'],
    ['a zero-width joiner (U+200D)', '\u{200d}'],
    ['a zero-width no-break space (U+FEFF)', '\u{feff}'],
    ['a combining grapheme joiner (U+034F)', '\u{34f}'],
    ['a Hangul filler (U+3164)', '\u{3164}'],
  ])('a web URL with %s is not a redirect URL, wherever it stands', (_name, character) => {
    for (const url of [
      `https://a.com/x${character}y`,
      `https://a${character}.com/cb`,
      `https://a.com/cb?x=${character}`,
      `http://localhost:3000/x${character}y`,
    ]) {
      expect(redirectUrlKind(url)).toBeNull()
      expect(isRedirectUrl(url)).toBe(false)
      expect(hasForbiddenRedirectCharacter(url)).toBe(true)
    }
    // A custom scheme's grammar is ASCII letters, digits and five marks: it never held one.
    expect(redirectUrlKind(`com.example.app:/oauth${character}`)).toBeNull()
    expect(redirectUrlKind(`com.exam${character}ple.app:/oauth`)).toBeNull()
    expect(hasForbiddenRedirectCharacter(`com.example.app:/oauth${character}`)).toBe(true)
  })

  test.each([
    [
      'a query, a port and a percent-encoded space',
      'https://a.com:8443/cb?tenant=a&x=%20',
      'https',
    ],
    ['text outside ASCII in the path', 'https://a.com/caf\u{e9}', 'https'],
    ['a host in punycode', 'https://xn--mnchen-3ya.de/cb', 'https'],
    ['a host written in Unicode', 'https://m\u{fc}nchen.de/cb', 'https'],
    ['a percent-encoded space in the path', 'https://a.com/a%20b', 'https'],
    ['the IPv6 loopback with a port', 'http://[::1]:8443/cb', 'loopback'],
    ['a percent-encoded zero-width space, which is visible', 'https://a.com/x%E2%80%8By', 'https'],
  ] as const)('a web URL keeps what it could always hold: %s', (_name, url, kind) => {
    expect(redirectUrlKind(url)).toBe(kind)
    expect(hasForbiddenRedirectCharacter(url)).toBe(false)
  })

  test('the tolerant read drops a stored entry with a character that draws nothing', () => {
    // An entry saved before the rule: read without it, never a failed read.
    const read = readStoredEnvironmentSettings({
      urls: {
        allowedOrigins: [],
        allowedRedirectUrls: [
          'https://a.com/cb',
          'https://a.com/x\u{200b}y',
          'https://a.com/x\u{fe0f}y',
          'https://a.com/x\u{e0041}y',
          'https://m\u{fc}nchen.de/cb',
        ],
      },
    })
    expect(read.settings.urls.allowedRedirectUrls).toEqual([
      'https://a.com/cb',
      'https://m\u{fc}nchen.de/cb',
    ])
    expect(read.dropped).toBe(3)
  })

  test('work is bounded for a web URL too: a long run of what is refused is judged at once', () => {
    const started = performance.now()
    expect(redirectUrlKind(`https://a.com/${'\u{202e}'.repeat(50_000)}`)).toBeNull()
    expect(redirectUrlKind(`https://a.com/${'\\'.repeat(50_000)}`)).toBeNull()
    expect(redirectUrlKind(`https://a.com/${'\u{200b}'.repeat(50_000)}`)).toBeNull()
    expect(redirectUrlKind(`https://a.com/${'a'.repeat(50_000)}\u{e0041}`)).toBeNull()
    expect(redirectUrlKind(`https://a.com/${'a'.repeat(50_000)}\u{0}`)).toBeNull()
    expect(performance.now() - started).toBeLessThan(200)
  })

  test('the tolerant read drops a stored entry that is refused, and counts it', () => {
    const read = readStoredEnvironmentSettings({
      urls: {
        allowedOrigins: [],
        allowedRedirectUrls: [
          'https://a.com/cb',
          'https://a.com/\u{0}x',
          'https://a.com/\u{202e}x',
          'https://a.com\\evil.com',
          'HTTPS://a.com/cb',
          'com.example.app:/oauth',
        ],
      },
    })
    expect(read.settings.urls.allowedRedirectUrls).toEqual([
      'https://a.com/cb',
      'com.example.app:/oauth',
    ])
    expect(read.dropped).toBe(4)
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

  test.each([
    // Schemes an operating system handles itself that are written with full stops, so the
    // rule "a custom scheme has a full stop" does not refuse them: only the list does.
    ['Windows’ camera', 'microsoft.windows.camera:/x'],
    ['Windows’ camera picker', 'microsoft.windows.camera.picker:/x'],
    ['Windows’ photo crop', 'microsoft.windows.photos.crop://x/y'],
    ['macOS’ system settings', 'x-apple.systempreferences:/x'],
    ['another of Apple’s x-apple schemes', 'x-apple.anything:/x'],
    ['a scheme in Apple’s own bundle-id space', 'com.apple.tv:/x'],
    ['anything under com.apple.', 'com.apple.x:/cb'],
  ])('%s is in a family no app of an operator’s owns, and is refused', (_name, url) => {
    expect(redirectUrlKind(url)).toBeNull()
  })

  test.each([
    // The list is best effort and says so: these are let through, by the grammar alone.
    ['a dotted scheme nobody listed', 'microsoft.someapp.thing:/x'],
    ['a name that only starts like a family', 'com.applesauce.app:/x'],
    ['the same name, another path', 'com.applesauce.app:/cb'],
    // The anchor is the full stop: `com.apple.` is the family, `com.apple` is not in it.
    ['Apple’s reverse domain with nothing under it', 'com.apple:/cb'],
    ['a family’s name with nothing after it', 'microsoft.windows:/x'],
    ['an ordinary reverse domain', 'com.microsoft.teams:/x'],
  ])('%s is outside every listed family, and passes the grammar', (_name, url) => {
    expect(redirectUrlKind(url)).toBe('custom_scheme')
  })

  test('a family is a prefix that ends with a full stop, in lower case', () => {
    for (const family of REDIRECT_SCHEME_FAMILIES_NEVER_CUSTOM) {
      expect(family).toMatch(/^[a-z][a-z0-9.-]*\.$/)
      expect(redirectUrlKind(`${family}x:/y`)).toBeNull()
    }
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
