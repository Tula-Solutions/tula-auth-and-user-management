import { describe, expect, test } from 'bun:test'
import {
  AT_LEAST_ONE_SIGN_IN_METHOD,
  ClientConfigSchema,
  DEFAULT_APP_NAME,
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsInputSchema,
  EnvironmentSettingsSchema,
  hasEnabledSignInMethod,
  isRelyingPartyId,
  MAX_ALLOWED_ORIGINS,
  MAX_ALLOWED_REDIRECT_URLS,
  MAX_APP_NAME_LENGTH,
  MfaPolicySchema,
  MIN_PASSWORD_MIN_LENGTH,
  originMatchesRelyingParty,
  parseStoredEnvironmentSettings,
  RedirectUrlSchema,
  readStoredEnvironmentSettings,
  SIGN_IN_METHODS_WITHOUT_SIGN_UP,
  SignUpPasswordModeSchema,
  WebOriginSchema,
} from './environment-settings'
import { PASSWORD_POLICY_PRESETS } from './password-policy'
import { DEFAULT_SMS_DAILY_MESSAGE_LIMIT, MAX_SMS_DAILY_MESSAGE_LIMIT } from './phone'

const accepts = (input: unknown) => EnvironmentSettingsSchema.safeParse(input).success

function issuePaths(input: unknown): string[] {
  const result = EnvironmentSettingsSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
}

import type { SessionProfile, SessionSettings } from './session-profile'

const DEFAULT_PROFILE: SessionProfile = {
  type: 'hybrid',
  accessTokenTtl: '60s',
  idleTimeout: '7d',
  absoluteTimeout: '30d',
  refresh: { reuseGracePeriod: '10s' },
  stepUpAfter: null,
  clientSelectable: false,
  jwtTemplate: null,
}
const DEFAULT_SESSIONS: SessionSettings = {
  profiles: { web: DEFAULT_PROFILE, mobile: DEFAULT_PROFILE },
  maxPerUser: null,
  onLimit: 'end_oldest',
  jwtTemplates: {},
}

describe('EnvironmentSettingsSchema', () => {
  test('an empty document is the defaults', () => {
    expect(EnvironmentSettingsSchema.parse({})).toEqual({
      version: 1,
      app: { name: DEFAULT_APP_NAME, supportEmail: null },
      password: PASSWORD_POLICY_PRESETS.recommended,
      signIn: {
        methods: {
          password: { enabled: true },
          emailCode: { enabled: false },
          emailLink: { enabled: false },
          passkey: { enabled: false },
          smsCode: { enabled: false },
        },
      },
      signUp: { password: 'required' },
      urls: { allowedOrigins: [], allowedRedirectUrls: [] },
      audit: { retentionDays: null },
      notifications: {
        passwordChanged: true,
        newSignIn: true,
        mfaChanged: true,
        identityChanged: true,
      },
      mfa: { policy: 'optional', smsCode: { enabled: false } },
      passkeys: { rpId: null },
      sessions: DEFAULT_SESSIONS,
      sms: { enabled: false, allowedCountries: [], dailyMessageLimit: 500 },
      emails: { templates: {} },
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
    ['an unknown notice', { notifications: { newSingIn: false } }, 'notifications'],
    [
      'a notice switch that is not a boolean',
      { notifications: { newSignIn: 'no' } },
      'notifications.newSignIn',
    ],
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
    // Joiners and variation selectors are how Persian and emoji are written.
    expect(accepts({ app: { name: 'می\u{200C}خواهم \u{2764}\u{FE0F} 👩\u{200D}💻' } })).toBe(true)
    // A brand may be a domain name: the link rule of email templates is not applied here.
    expect(accepts({ app: { name: 'Acme.com' } })).toBe(true)
  })

  // The name goes into every subject and body (ADR 0039): what reorders the text around
  // it, or is nobody's character, is refused when it is set.
  test.each<[string, string]>([
    ['a right-to-left override', 'Acme\u{202E}moc'],
    ['a left-to-right isolate', '\u{2066}Acme'],
    ['a pop directional isolate', 'Acme\u{2069}'],
    ['a right-to-left mark', 'Acme\u{200F}'],
    ['an Arabic letter mark', 'Acme\u{061C}'],
    ['a private-use character', 'Acme\u{E000}'],
    ['an unassigned code point', 'Acme\u{0378}'],
    ['a lone surrogate', 'Acme\u{D83D}'],
  ])('a name with %s is refused on input', (_, name) => {
    const result = EnvironmentSettingsInputSchema.safeParse({ app: { name } })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      [
        'app.name',
        'must not contain text-direction controls, private-use or unassigned characters, or half a surrogate pair',
      ],
    ])
  })

  test('a name already stored with such a character is still read, and still answered', () => {
    const name = 'Acme\u{202E}moc'
    expect(readStoredEnvironmentSettings({ app: { name } }).settings.app.name).toBe(name)
    expect(EnvironmentSettingsSchema.safeParse({ app: { name } }).success).toBe(true)
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

  test('a document with every method off is valid here: the server counts OAuth providers too', () => {
    // An environment whose only way in is an OAuth provider has every method below off. Whether
    // a provider is enabled is not part of the document, so the rule lives in the settings
    // service (`AT_LEAST_ONE_SIGN_IN_METHOD`), with `hasEnabledSignInMethod` as its test.
    const allOff = { signIn: { methods: { password: { enabled: false } } } }
    expect(issuePaths(allOff)).toEqual([])
    expect(hasEnabledSignInMethod(EnvironmentSettingsSchema.parse(allOff))).toBe(false)
    expect(hasEnabledSignInMethod(DEFAULT_ENVIRONMENT_SETTINGS)).toBe(true)
    expect(AT_LEAST_ONE_SIGN_IN_METHOD).toContain('at least one')
  })

  test('the SMS code is off by default, additive, and never counts as the one way in', () => {
    expect(DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods.smsCode).toEqual({ enabled: false })
    // A document stored before the method existed reads with it off.
    const stored = parseStoredEnvironmentSettings({
      signIn: { methods: { password: { enabled: true } } },
    })
    expect(stored.signIn.methods.smsCode).toEqual({ enabled: false })
    // Nobody signs up with a phone number: alone, it would let nobody in who is not in already.
    const onlySms = EnvironmentSettingsSchema.parse({
      signIn: { methods: { password: { enabled: false }, smsCode: { enabled: true } } },
    })
    expect(hasEnabledSignInMethod(onlySms)).toBe(false)
    expect(SIGN_IN_METHODS_WITHOUT_SIGN_UP).toEqual(['smsCode'])
    const withCode = EnvironmentSettingsSchema.parse({
      signIn: {
        methods: {
          password: { enabled: false },
          emailCode: { enabled: true },
          smsCode: { enabled: true },
        },
      },
    })
    expect(hasEnabledSignInMethod(withCode)).toBe(true)
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
      signIn: { methods: { password: { enabled: true }, carrierPigeon: { enabled: true } } },
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
      parseStoredEnvironmentSettings({ signIn: { methods: { password: { enabled: 'no' } } } })
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
      droppedEmailTemplates: [],
      unknownEmailTemplates: 0,
    })
    expect(readStoredEnvironmentSettings({ urls: null }).dropped).toBe(0)
    expect(readStoredEnvironmentSettings(DEFAULT_ENVIRONMENT_SETTINGS)).toEqual({
      settings: DEFAULT_ENVIRONMENT_SETTINGS,
      dropped: 0,
      droppedEmailTemplates: [],
      unknownEmailTemplates: 0,
    })
  })
})

describe('EnvironmentSettingsInputSchema', () => {
  test('keeps apart what was left out and what was sent', () => {
    expect(EnvironmentSettingsInputSchema.parse({})).toEqual({
      version: 1,
      app: { name: DEFAULT_APP_NAME, supportEmail: null },
      signIn: {
        methods: {
          password: { enabled: true },
          emailCode: { enabled: false },
          emailLink: { enabled: false },
          passkey: { enabled: false },
          smsCode: { enabled: false },
        },
      },
      signUp: { password: 'required' },
      urls: { allowedRedirectUrls: [] },
      audit: { retentionDays: null },
      notifications: {
        passwordChanged: true,
        newSignIn: true,
        mfaChanged: true,
        identityChanged: true,
      },
      mfa: { policy: 'optional', smsCode: { enabled: false } },
      passkeys: { rpId: null },
      sessions: DEFAULT_SESSIONS,
      sms: { enabled: false, allowedCountries: [], dailyMessageLimit: 500 },
      emails: { templates: {} },
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
    expect(paths({ signIn: { methods: { password: { enabled: 'no' } } } })).toEqual([
      'signIn.methods.password.enabled',
    ])
  })

  test('every whole document is a valid input', () => {
    expect(EnvironmentSettingsInputSchema.parse(DEFAULT_ENVIRONMENT_SETTINGS)).toEqual(
      DEFAULT_ENVIRONMENT_SETTINGS
    )
  })
})

describe('email sign-in methods and the sign-up password', () => {
  const paths =
    (schema: typeof EnvironmentSettingsSchema | typeof EnvironmentSettingsInputSchema) =>
    (input: unknown) => {
      const result = schema.safeParse(input)
      return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
    }
  const methods = (password: boolean, emailCode: boolean, emailLink: boolean) => ({
    signIn: {
      methods: {
        password: { enabled: password },
        emailCode: { enabled: emailCode },
        emailLink: { enabled: emailLink },
      },
    },
  })

  test('the email methods are off until an environment switches them on', () => {
    const { signIn, signUp } = DEFAULT_ENVIRONMENT_SETTINGS
    expect(signIn.methods.emailCode).toEqual({ enabled: false })
    expect(signIn.methods.emailLink).toEqual({ enabled: false })
    expect(signUp).toEqual({ password: 'required' })
  })

  test.each([EnvironmentSettingsSchema, EnvironmentSettingsInputSchema])(
    'every method may be off in the document: the server requires a provider then (schema %#)',
    (schema) => {
      expect(paths(schema)(methods(false, false, false))).toEqual([])
      // The email code alone is enough: the password may then be switched off.
      expect(paths(schema)(methods(false, true, false))).toEqual([])
      expect(paths(schema)(methods(false, true, true))).toEqual([])
    }
  )

  test.each([EnvironmentSettingsSchema, EnvironmentSettingsInputSchema])(
    'a link needs the code beside it (schema %#)',
    (schema) => {
      expect(paths(schema)(methods(true, false, true))).toEqual([
        'signIn.methods.emailLink.enabled',
      ])
      expect(paths(schema)(methods(true, true, true))).toEqual([])
    }
  )

  test.each([EnvironmentSettingsSchema, EnvironmentSettingsInputSchema])(
    'an optional sign-up password needs the email code (schema %#)',
    (schema) => {
      expect(paths(schema)({ signUp: { password: 'optional' } })).toEqual(['signUp.password'])
      expect(
        paths(schema)({ ...methods(true, true, false), signUp: { password: 'optional' } })
      ).toEqual([])
      expect(paths(schema)({ signUp: { password: 'sometimes' } })).toEqual(['signUp.password'])
      expect(paths(schema)({ signUp: { pasword: 'optional' } })).toEqual(['signUp'])
    }
  )

  test('a method’s section takes only `enabled`', () => {
    expect(
      paths(EnvironmentSettingsSchema)({
        signIn: { methods: { emailCode: { enabled: true, length: 8 } } },
      })
    ).toEqual(['signIn.methods.emailCode'])
  })

  test('a document stored before the methods existed reads with them off', () => {
    const stored = {
      version: 1,
      app: { name: 'Acme', supportEmail: null },
      signIn: { methods: { password: { enabled: true } } },
    }
    const { settings, dropped } = readStoredEnvironmentSettings(stored)
    expect(dropped).toBe(0)
    expect(settings.signIn.methods).toEqual({
      password: { enabled: true },
      emailCode: { enabled: false },
      emailLink: { enabled: false },
      passkey: { enabled: false },
      smsCode: { enabled: false },
    })
    expect(settings.signUp).toEqual({ password: 'required' })
    // And what it reads is a document the strict schema accepts.
    expect(EnvironmentSettingsSchema.parse(settings)).toEqual(settings)
  })

  test('the client config carries the sign-up mode, and tolerates a server that sends none', () => {
    const config = {
      app: { name: 'Acme', supportEmail: null },
      signIn: { methods: ['password', 'emailCode'] },
      password: PASSWORD_POLICY_PRESETS.recommended,
    }
    expect(ClientConfigSchema.parse(config).signUp).toBeUndefined()
    expect(
      ClientConfigSchema.parse({ ...config, signUp: { password: 'optional' } }).signUp
    ).toEqual({ password: 'optional' })
    expect(SignUpPasswordModeSchema.options).toEqual(['required', 'optional'])
  })
})

describe('two-step verification: the policy and its notice', () => {
  const paths =
    (schema: typeof EnvironmentSettingsSchema | typeof EnvironmentSettingsInputSchema) =>
    (input: unknown) => {
      const result = schema.safeParse(input)
      return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
    }

  test('the policy is optional and its notice on until an environment says otherwise', () => {
    expect(DEFAULT_ENVIRONMENT_SETTINGS.mfa).toEqual({
      policy: 'optional',
      smsCode: { enabled: false },
    })
    expect(DEFAULT_ENVIRONMENT_SETTINGS.notifications.mfaChanged).toBe(true)
    expect(MfaPolicySchema.options).toEqual(['off', 'optional', 'required'])
  })

  test.each([EnvironmentSettingsSchema, EnvironmentSettingsInputSchema])(
    'every policy is accepted, and the notice can be switched off (schema %#)',
    (schema) => {
      for (const policy of MfaPolicySchema.options) {
        expect(schema.parse({ mfa: { policy } }).mfa).toEqual({
          policy,
          smsCode: { enabled: false },
        })
      }
      expect(schema.parse({ mfa: {} }).mfa).toEqual({
        policy: 'optional',
        smsCode: { enabled: false },
      })
      expect(schema.parse({ notifications: { mfaChanged: false } }).notifications).toEqual({
        passwordChanged: true,
        newSignIn: true,
        mfaChanged: false,
        identityChanged: true,
      })
    }
  )

  test.each([EnvironmentSettingsSchema, EnvironmentSettingsInputSchema])(
    'an unknown policy, an unknown key under `mfa` and a notice that is not a boolean are refused (schema %#)',
    (schema) => {
      expect(paths(schema)({ mfa: { policy: 'mandatory' } })).toEqual(['mfa.policy'])
      expect(paths(schema)({ mfa: { policy: null } })).toEqual(['mfa.policy'])
      expect(paths(schema)({ mfa: { policy: 'required', methods: ['sms'] } })).toEqual(['mfa'])
      expect(paths(schema)({ mfa: { enforced: true } })).toEqual(['mfa'])
      expect(paths(schema)({ mfa: 'required' })).toEqual(['mfa'])
      expect(paths(schema)({ notifications: { mfaChanged: 'no' } })).toEqual([
        'notifications.mfaChanged',
      ])
      expect(paths(schema)({ notifications: { mfa: false } })).toEqual(['notifications'])
    }
  )

  test.each([EnvironmentSettingsSchema, EnvironmentSettingsInputSchema])(
    'a texted code as the second step is off until an environment switches it on (schema %#)',
    (schema) => {
      expect(schema.parse({}).mfa.smsCode).toEqual({ enabled: false })
      expect(schema.parse({ mfa: { smsCode: {} } }).mfa.smsCode).toEqual({ enabled: false })
      expect(schema.parse({ mfa: { smsCode: { enabled: true } } }).mfa).toEqual({
        policy: 'optional',
        smsCode: { enabled: true },
      })
      expect(paths(schema)({ mfa: { smsCode: { enabled: 'yes' } } })).toEqual([
        'mfa.smsCode.enabled',
      ])
      expect(paths(schema)({ mfa: { smsCode: true } })).toEqual(['mfa.smsCode'])
      expect(paths(schema)({ mfa: { smsCode: { enabled: true, fallback: true } } })).toEqual([
        'mfa.smsCode',
      ])
    }
  )

  test('a stored switch that is not a boolean reads as off, never as on', () => {
    for (const smsCode of [{ enabled: 'yes' }, { enabled: 1 }, true, null, 'on']) {
      let settings: ReturnType<typeof readStoredEnvironmentSettings>['settings'] | undefined
      try {
        settings = readStoredEnvironmentSettings({ mfa: { policy: 'required', smsCode } }).settings
      } catch {
        // A document that cannot be read at all switches nothing on either.
        continue
      }
      expect(settings.mfa.smsCode.enabled).toBe(false)
    }
    expect(
      readStoredEnvironmentSettings({ mfa: { smsCode: { enabled: true } } }).settings.mfa
    ).toEqual({ policy: 'optional', smsCode: { enabled: true } })
  })

  test('a document stored before the policy existed reads as optional, with the notice on', () => {
    const stored = {
      version: 1,
      app: { name: 'Acme', supportEmail: null },
      notifications: { passwordChanged: false, newSignIn: true },
    }
    const { settings, dropped } = readStoredEnvironmentSettings(stored)
    expect(dropped).toBe(0)
    expect(settings.mfa).toEqual({ policy: 'optional', smsCode: { enabled: false } })
    expect(settings.notifications).toEqual({
      passwordChanged: false,
      newSignIn: true,
      mfaChanged: true,
      identityChanged: true,
    })
    expect(EnvironmentSettingsSchema.parse(settings)).toEqual(settings)
  })

  test('a stored document keeps its policy, and a key another version put under `mfa` is dropped', () => {
    const settings = parseStoredEnvironmentSettings({
      mfa: { policy: 'required', methods: ['sms'], gracePeriodDays: 7 },
    })
    expect(settings.mfa).toEqual({ policy: 'required', smsCode: { enabled: false } })
    // What was read is a document the strict schema accepts.
    expect(EnvironmentSettingsSchema.parse(settings)).toEqual(settings)
  })

  test('a stored policy this version does not know is still an error, not a silent default', () => {
    expect(() => parseStoredEnvironmentSettings({ mfa: { policy: 'mandatory' } })).toThrow()
  })

  test('the client config carries the policy, and tolerates a server that sends none', () => {
    const config = {
      app: { name: 'Acme', supportEmail: null },
      signIn: { methods: ['password'] },
      password: PASSWORD_POLICY_PRESETS.recommended,
    }
    expect(ClientConfigSchema.parse(config).mfa).toBeUndefined()
    for (const policy of MfaPolicySchema.options) {
      expect(ClientConfigSchema.parse({ ...config, mfa: { policy } }).mfa).toEqual({ policy })
    }
    expect(ClientConfigSchema.safeParse({ ...config, mfa: { policy: 'mandatory' } }).success).toBe(
      false
    )
    // The notice switches stay server-side.
    expect(
      ClientConfigSchema.parse({ ...config, notifications: { mfaChanged: false } })
    ).not.toHaveProperty('notifications')
  })
})

describe('passkeys', () => {
  const withPasskeys = (rpId: unknown, enabled = true) => ({
    signIn: { methods: { passkey: { enabled } } },
    passkeys: { rpId },
  })

  test('the method is off and there is no relying-party id until an environment sets them', () => {
    const settings = EnvironmentSettingsSchema.parse({})
    expect(settings.signIn.methods.passkey).toEqual({ enabled: false })
    expect(settings.passkeys).toEqual({ rpId: null })
  })

  test('switching passkeys on needs a relying-party id, in both schemas', () => {
    for (const schema of [EnvironmentSettingsSchema, EnvironmentSettingsInputSchema]) {
      const refused = schema.safeParse({ signIn: { methods: { passkey: { enabled: true } } } })
      expect(refused.success).toBe(false)
      expect(refused.error?.issues[0]?.path).toEqual(['signIn', 'methods', 'passkey', 'enabled'])
      expect(schema.safeParse(withPasskeys('northline.app')).success).toBe(true)
      // An id alone switches nothing on.
      expect(schema.safeParse(withPasskeys('northline.app', false)).success).toBe(true)
    }
  })

  test.each([
    'https://northline.app',
    'northline.app:443',
    'northline.app/path',
    'Northline.app',
    '127.0.0.1',
    '10.0.0.1',
    'app',
    '*.northline.app',
    'northline..app',
    '',
    `${'a'.repeat(250)}.app`,
  ])('refuses %p as a relying-party id', (rpId) => {
    expect(isRelyingPartyId(rpId)).toBe(false)
    expect(EnvironmentSettingsSchema.safeParse(withPasskeys(rpId)).success).toBe(false)
  })

  test.each(['localhost', 'northline.app', 'auth.northline.co.uk'])('accepts %p', (rpId) => {
    expect(isRelyingPartyId(rpId)).toBe(true)
  })

  test.each([
    ['https://northline.app', 'northline.app', true],
    ['https://app.northline.app', 'northline.app', true],
    ['https://app.northline.app:8443', 'northline.app', true],
    ['http://localhost:5174', 'localhost', true],
    ['https://northline.app.evil.test', 'northline.app', false],
    ['https://evilnorthline.app', 'northline.app', false],
    ['https://northline.app', 'app.northline.app', false],
    ['not an origin', 'northline.app', false],
  ])('an origin %p and the relying party %p: %p', (origin, rpId, expected) => {
    expect(originMatchesRelyingParty(origin, rpId)).toBe(expected)
  })

  test('a stored document from before passkeys reads with them off', () => {
    const { settings } = readStoredEnvironmentSettings({ app: { name: 'Acme' } })
    expect(settings.signIn.methods.passkey).toEqual({ enabled: false })
    expect(settings.passkeys).toEqual({ rpId: null })
  })
})

describe('sms', () => {
  test('is off and allows no country until an environment says otherwise', () => {
    expect(DEFAULT_ENVIRONMENT_SETTINGS.sms).toEqual({
      enabled: false,
      allowedCountries: [],
      dailyMessageLimit: DEFAULT_SMS_DAILY_MESSAGE_LIMIT,
    })
    expect(parseStoredEnvironmentSettings({ app: { name: 'Acme' } }).sms).toEqual({
      enabled: false,
      allowedCountries: [],
      dailyMessageLimit: 500,
    })
  })

  test.each([
    ['strict', EnvironmentSettingsSchema],
    ['input', EnvironmentSettingsInputSchema],
  ] as const)('the %s schema takes upper-case country codes the table knows', (_name, schema) => {
    expect(schema.parse({ sms: { enabled: true, allowedCountries: ['DE', 'US'] } }).sms).toEqual({
      enabled: true,
      allowedCountries: ['DE', 'US'],
      dailyMessageLimit: 500,
    })
    for (const allowedCountries of [
      ['de'],
      ['DEU'],
      ['ZZ'],
      ['D'],
      [''],
      ['+49'],
      ['constructor'],
      ['DE', 'DE'],
      [49],
      'DE',
    ]) {
      const result = schema.safeParse({ sms: { allowedCountries } })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.path.slice(0, 2)).toEqual(['sms', 'allowedCountries'])
    }
    expect(schema.safeParse({ sms: { enabled: 'yes' } }).success).toBe(false)
    expect(schema.safeParse({ sms: { provider: 'twilio' } }).success).toBe(false)
  })

  test('a stored document keeps the countries this version knows and counts the rest', () => {
    const { settings, dropped } = readStoredEnvironmentSettings({
      sms: { enabled: true, allowedCountries: ['DE', 'de', 'ZZ', 'DE', 'US', 7], sender: 'x' },
    })
    expect(settings.sms).toEqual({
      enabled: true,
      allowedCountries: ['DE', 'US'],
      dailyMessageLimit: 500,
    })
    expect(dropped).toBe(4)
    expect(readStoredEnvironmentSettings({ sms: null })).toEqual({
      settings: DEFAULT_ENVIRONMENT_SETTINGS,
      dropped: 0,
      droppedEmailTemplates: [],
      unknownEmailTemplates: 0,
    })
    expect(readStoredEnvironmentSettings({ sms: { allowedCountries: 'DE' } })).toEqual({
      settings: DEFAULT_ENVIRONMENT_SETTINGS,
      dropped: 1,
      droppedEmailTemplates: [],
      unknownEmailTemplates: 0,
    })
  })

  test.each([
    ['strict', EnvironmentSettingsSchema],
    ['input', EnvironmentSettingsInputSchema],
  ] as const)(
    'the %s schema holds the daily limit to a whole number in its range',
    (_name, schema) => {
      for (const dailyMessageLimit of [1, 500, MAX_SMS_DAILY_MESSAGE_LIMIT]) {
        expect(schema.parse({ sms: { dailyMessageLimit } }).sms.dailyMessageLimit).toBe(
          dailyMessageLimit
        )
      }
      // No value switches the limit off: not zero, not null, not a number past the maximum.
      for (const dailyMessageLimit of [0, -1, 1.5, MAX_SMS_DAILY_MESSAGE_LIMIT + 1, null, '500']) {
        const result = schema.safeParse({ sms: { dailyMessageLimit } })
        expect(result.success).toBe(false)
        expect(result.error?.issues[0]?.path).toEqual(['sms', 'dailyMessageLimit'])
      }
    }
  )

  test('a document stored before the daily limit existed has the default one', () => {
    expect(
      parseStoredEnvironmentSettings({ sms: { enabled: true, allowedCountries: ['DE'] } }).sms
    ).toEqual({ enabled: true, allowedCountries: ['DE'], dailyMessageLimit: 500 })
  })

  test('the client config has a place for whether a phone number can be added', () => {
    const config = {
      app: { name: 'Acme', supportEmail: null },
      signIn: { methods: ['password'] },
      password: PASSWORD_POLICY_PRESETS.recommended,
    }
    expect(ClientConfigSchema.parse({ ...config, phone: { enabled: true } }).phone).toEqual({
      enabled: true,
    })
    // An older server's answer has none.
    expect(ClientConfigSchema.parse(config).phone).toBeUndefined()
  })
})
