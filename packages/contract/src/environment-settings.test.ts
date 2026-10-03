import { describe, expect, test } from 'bun:test'
import {
  ClientConfigSchema,
  DEFAULT_APP_NAME,
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsInputSchema,
  EnvironmentSettingsSchema,
  MAX_ALLOWED_ORIGINS,
  MAX_ALLOWED_REDIRECT_URLS,
  MAX_APP_NAME_LENGTH,
  MIN_PASSWORD_MIN_LENGTH,
  parseStoredEnvironmentSettings,
  RedirectUrlSchema,
  readStoredEnvironmentSettings,
  WebOriginSchema,
} from './environment-settings'
import { PASSWORD_POLICY_PRESETS } from './password-policy'

const accepts = (input: unknown) => EnvironmentSettingsSchema.safeParse(input).success

function issuePaths(input: unknown): string[] {
  const result = EnvironmentSettingsSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
}

describe('EnvironmentSettingsSchema', () => {
  test('an empty document is the defaults', () => {
    expect(EnvironmentSettingsSchema.parse({})).toEqual({
      version: 1,
      app: { name: DEFAULT_APP_NAME, supportEmail: null },
      password: PASSWORD_POLICY_PRESETS.recommended,
      signIn: { methods: { password: { enabled: true } } },
      urls: { allowedOrigins: [], allowedRedirectUrls: [] },
      audit: { retentionDays: null },
    })
    expect(DEFAULT_ENVIRONMENT_SETTINGS).toEqual(EnvironmentSettingsSchema.parse({}))
  })

  test('a parsed document parses to itself', () => {
    const document = EnvironmentSettingsSchema.parse({
      app: { name: '  Acme  ', supportEmail: 'help@acme.test' },
      password: PASSWORD_POLICY_PRESETS.strict,
      urls: {
        allowedOrigins: ['https://app.acme.test', 'http://localhost:5173'],
        allowedRedirectUrls: ['https://app.acme.test/callback?next=1'],
      },
      audit: { retentionDays: 365 },
    })
    expect(document.app.name).toBe('Acme')
    expect(EnvironmentSettingsSchema.parse(document)).toEqual(document)
  })

  test.each<[string, unknown, string]>([
    ['a misspelt section', { pasword: {} }, ''],
    ['a misspelt field', { app: { nmae: 'Acme' } }, 'app'],
    ['an unknown sign-in method', { signIn: { methods: { carrierPigeon: {} } } }, 'signIn.methods'],
    ['an unknown url list', { urls: { origins: [] } }, 'urls'],
    ['an unknown audit field', { audit: { days: 1 } }, 'audit'],
    ['another document version', { version: 2 }, 'version'],
  ])('%s is refused, not ignored', (_, input, path) => {
    expect(issuePaths(input)).toContain(path)
  })

  test.each<[string, unknown]>([
    ['an empty name', ''],
    ['a blank name', '   '],
    ['a name that is too long', 'a'.repeat(MAX_APP_NAME_LENGTH + 1)],
    ['a name with a line break', 'Acme\r\nBcc: evil@example.com'],
    ['a name with a control character', 'Acme\u0007'],
    ['a name with a line separator', 'Acme\u2028Inc'],
  ])('%s is refused', (_, name) => {
    expect(issuePaths({ app: { name } })).toEqual(['app.name'])
  })

  test('the name may use any script and punctuation', () => {
    expect(accepts({ app: { name: 'Café “Zoë” & Søn <3 東京' } })).toBe(true)
  })

  test('the support address must be an email address or null', () => {
    expect(accepts({ app: { supportEmail: 'help@acme.test' } })).toBe(true)
    expect(accepts({ app: { supportEmail: null } })).toBe(true)
    expect(issuePaths({ app: { supportEmail: 'not an address' } })).toEqual(['app.supportEmail'])
  })

  test('the password section is a whole password policy', () => {
    expect(issuePaths({ password: { minLength: 12 } }).length).toBeGreaterThan(0)
    expect(
      issuePaths({ password: { ...PASSWORD_POLICY_PRESETS.recommended, minLength: 500 } })
    ).toContain('password.minLength')
  })

  test('at least one sign-in method must stay enabled', () => {
    expect(issuePaths({ signIn: { methods: { password: { enabled: false } } } })).toEqual([
      'signIn.methods',
    ])
    expect(accepts({ signIn: { methods: { password: { enabled: true } } } })).toBe(true)
  })

  test('the lists are bounded and hold no duplicates', () => {
    const origins = Array.from({ length: MAX_ALLOWED_ORIGINS + 1 }, (_, i) => `https://a${i}.test`)
    const urls = Array.from(
      { length: MAX_ALLOWED_REDIRECT_URLS + 1 },
      (_, i) => `https://a.test/${i}`
    )
    expect(accepts({ urls: { allowedOrigins: origins.slice(1) } })).toBe(true)
    expect(issuePaths({ urls: { allowedOrigins: origins } })).toEqual(['urls.allowedOrigins'])
    expect(issuePaths({ urls: { allowedRedirectUrls: urls } })).toEqual([
      'urls.allowedRedirectUrls',
    ])
    expect(issuePaths({ urls: { allowedOrigins: ['https://a.test', 'https://a.test'] } })).toEqual([
      'urls.allowedOrigins',
    ])
    expect(
      issuePaths({ urls: { allowedRedirectUrls: ['https://a.test/x', 'https://a.test/x'] } })
    ).toEqual(['urls.allowedRedirectUrls'])
  })

  test.each<[string, unknown, boolean]>([
    ['null keeps entries for ever', null, true],
    ['a number of days', 90, true],
    ['zero days', 0, false],
    ['a fraction', 1.5, false],
    ['more than ten years', 3651, false],
  ])('audit retention: %s', (_, retentionDays, ok) => {
    expect(accepts({ audit: { retentionDays } })).toBe(ok)
  })
})

describe('WebOriginSchema', () => {
  test.each<[string, string, boolean]>([
    ['an https origin', 'https://app.example.com', true],
    ['an https origin with a port', 'https://app.example.com:8443', true],
    ['a single-label host', 'https://intranet', true],
    ['an IPv6 host', 'https://[2001:db8::1]', true],
    ['localhost over http', 'http://localhost:5173', true],
    ['localhost over http without a port', 'http://localhost', true],
    ['127.0.0.1 over http', 'http://127.0.0.1:3000', true],
    ['IPv6 loopback over http', 'http://[::1]:3000', true],
    ['http for any other host', 'http://app.example.com', false],
    ['a localhost lookalike over http', 'http://localhost.evil.test', false],
    ['a trailing slash', 'https://app.example.com/', false],
    ['a path', 'https://app.example.com/app', false],
    ['a wildcard', 'https://*.example.com', false],
    ['the wildcard alone', '*', false],
    ['an uppercase host', 'https://App.example.com', false],
    ['credentials', 'https://user:pw@app.example.com', false],
    ['the default https port', 'https://app.example.com:443', false],
    ['the default http port', 'http://localhost:80', false],
    ['a port out of range', 'https://app.example.com:70000', false],
    ['another scheme', 'ftp://app.example.com', false],
    ['the literal null origin', 'null', false],
    ['an empty string', '', false],
  ])('%s', (_, origin, ok) => {
    expect(WebOriginSchema.safeParse(origin).success).toBe(ok)
  })
})

describe('RedirectUrlSchema', () => {
  test.each<[string, string, boolean]>([
    ['an https URL', 'https://app.example.com/auth/callback', true],
    ['an https URL with a query', 'https://app.example.com/cb?next=%2Fhome', true],
    ['localhost over http', 'http://localhost:5173/callback', true],
    ['127.0.0.1 over http', 'http://127.0.0.1:3000/cb', true],
    ['IPv6 loopback over http', 'http://[::1]:3000/cb', true],
    ['http for any other host', 'http://app.example.com/cb', false],
    ['a relative URL', '/callback', false],
    ['a wildcard', 'https://*.example.com/cb', false],
    ['credentials', 'https://user:pw@app.example.com/cb', false],
    ['a fragment', 'https://app.example.com/cb#token', false],
    ['a javascript URL', 'javascript:alert(1)', false],
    ['a custom scheme', 'myapp://callback', false],
    ['whitespace', 'https://app.example.com/a b', false],
    ['an empty string', '', false],
  ])('%s', (_, url, ok) => {
    expect(RedirectUrlSchema.safeParse(url).success).toBe(ok)
  })
})

describe('parseStoredEnvironmentSettings', () => {
  test('fills fields added since the document was stored', () => {
    expect(parseStoredEnvironmentSettings({ app: { name: 'Acme' } })).toEqual({
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      app: { name: 'Acme', supportEmail: null },
    })
  })

  test('drops keys a newer server wrote instead of failing', () => {
    const stored = {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      app: { name: 'Acme', supportEmail: null, logoUrl: 'https://acme.test/logo.png' },
      signIn: { methods: { password: { enabled: true }, passkey: { enabled: true } } },
      branding: { colour: 'teal' },
    }
    expect(parseStoredEnvironmentSettings(stored)).toEqual({
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      app: { name: 'Acme', supportEmail: null },
    })
  })

  test('still refuses a known field holding an invalid value', () => {
    expect(() => parseStoredEnvironmentSettings({ app: { name: '' } })).toThrow()
    expect(() =>
      parseStoredEnvironmentSettings({ signIn: { methods: { password: { enabled: false } } } })
    ).toThrow()
  })
})

describe('ClientConfigSchema', () => {
  test('holds the app, the enabled methods and the password policy, and nothing else', () => {
    const config = {
      app: { name: 'Acme', supportEmail: null },
      signIn: { methods: ['password'] },
      password: PASSWORD_POLICY_PRESETS.recommended,
    }
    expect(
      ClientConfigSchema.parse({ ...config, urls: { allowedOrigins: ['https://a.test'] } })
    ).toEqual(config)
  })
})

describe('the minimum password length has a floor', () => {
  const withMin = (minLength: number) => ({
    password: { ...PASSWORD_POLICY_PRESETS.recommended, minLength },
  })

  test('a document sent to the API cannot set it under the floor', () => {
    expect(issuePaths(withMin(MIN_PASSWORD_MIN_LENGTH - 1))).toEqual(['password.minLength'])
    expect(accepts(withMin(MIN_PASSWORD_MIN_LENGTH))).toBe(true)
    expect(MIN_PASSWORD_MIN_LENGTH).toBe(8)
  })

  test('a document already stored below the floor still reads', () => {
    expect(parseStoredEnvironmentSettings(withMin(6)).password.minLength).toBe(6)
  })
})

describe('reading a stored document never fails over a list entry', () => {
  test('an invalid origin or redirect URL is dropped, and counted', () => {
    const read = readStoredEnvironmentSettings({
      app: { name: 'Acme' },
      urls: {
        allowedOrigins: ['https://app.acme.test', 'http://app.lan', 7, 'https://app.acme.test'],
        allowedRedirectUrls: ['https://app.acme.test/cb', 'javascript:alert(1)', null],
      },
    })
    expect(read.settings.urls).toEqual({
      allowedOrigins: ['https://app.acme.test'],
      allowedRedirectUrls: ['https://app.acme.test/cb'],
    })
    expect(read.settings.app.name).toBe('Acme')
    // Two bad origins, one duplicate, two bad URLs.
    expect(read.dropped).toBe(5)
    expect(
      parseStoredEnvironmentSettings({ urls: { allowedOrigins: ['http://app.lan'] } }).urls
        .allowedOrigins
    ).toEqual([])
  })

  test('something that is not a document at all is still an error', () => {
    expect(() => readStoredEnvironmentSettings(null)).toThrow()
    expect(() => readStoredEnvironmentSettings('settings')).toThrow()
  })

  test('a list longer than the limit is cut to it', () => {
    const origins = Array.from({ length: MAX_ALLOWED_ORIGINS + 3 }, (_, i) => `https://a${i}.test`)
    const read = readStoredEnvironmentSettings({ urls: { allowedOrigins: origins } })
    expect(read.settings.urls.allowedOrigins).toEqual(origins.slice(0, MAX_ALLOWED_ORIGINS))
    expect(read.dropped).toBe(3)
  })

  test('a list that is not a list reads as empty; a clean document drops nothing', () => {
    expect(readStoredEnvironmentSettings({ urls: { allowedOrigins: 'https://a.test' } })).toEqual({
      settings: DEFAULT_ENVIRONMENT_SETTINGS,
      dropped: 1,
    })
    expect(readStoredEnvironmentSettings({ urls: null }).dropped).toBe(0)
    expect(readStoredEnvironmentSettings(DEFAULT_ENVIRONMENT_SETTINGS)).toEqual({
      settings: DEFAULT_ENVIRONMENT_SETTINGS,
      dropped: 0,
    })
  })
})

describe('EnvironmentSettingsInputSchema', () => {
  test('keeps apart what was left out and what was sent', () => {
    expect(EnvironmentSettingsInputSchema.parse({})).toEqual({
      version: 1,
      app: { name: DEFAULT_APP_NAME, supportEmail: null },
      signIn: { methods: { password: { enabled: true } } },
      urls: { allowedRedirectUrls: [] },
      audit: { retentionDays: null },
    })
    const sent = EnvironmentSettingsInputSchema.parse({
      password: PASSWORD_POLICY_PRESETS.strict,
      urls: { allowedOrigins: [] },
    })
    expect(sent.password).toEqual(PASSWORD_POLICY_PRESETS.strict)
    expect(sent.urls.allowedOrigins).toEqual([])
  })

  test('refuses what the document refuses', () => {
    const paths = (input: unknown) => {
      const result = EnvironmentSettingsInputSchema.safeParse(input)
      return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
    }
    expect(paths({ pasword: {} })).toEqual([''])
    expect(paths({ urls: { origins: [] } })).toEqual(['urls'])
    expect(paths({ urls: { allowedOrigins: ['http://app.lan'] } })).toEqual([
      'urls.allowedOrigins.0',
    ])
    expect(paths({ password: { ...PASSWORD_POLICY_PRESETS.recommended, minLength: 7 } })).toEqual([
      'password.minLength',
    ])
    expect(paths({ signIn: { methods: { password: { enabled: false } } } })).toEqual([
      'signIn.methods',
    ])
  })

  test('every whole document is a valid input', () => {
    expect(EnvironmentSettingsInputSchema.parse(DEFAULT_ENVIRONMENT_SETTINGS)).toEqual(
      DEFAULT_ENVIRONMENT_SETTINGS
    )
  })
})
