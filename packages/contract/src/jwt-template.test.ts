import { describe, expect, test } from 'bun:test'
import {
  MAX_CUSTOM_CLAIM_CONSTANT_LENGTH,
  MAX_CUSTOM_CLAIMS_BYTES,
  MAX_JWT_TEMPLATE_CLAIMS,
  MAX_JWT_TEMPLATES,
} from './custom-claims'
import {
  EnvironmentSettingsInputSchema,
  EnvironmentSettingsSchema,
  parseStoredEnvironmentSettings,
} from './environment-settings'
import {
  JWT_TEMPLATE_SOURCES,
  JwtTemplateSchema,
  jwtTemplateMaxBytes,
  jwtTemplateOfProfile,
  MAX_EMAIL_CLAIM_BYTES,
} from './jwt-template'
import { SessionSettingsSchema } from './session-profile'

const role = { claims: { role: { value: 'member' } } }

function messages(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'))
}

describe('a JWT template', () => {
  test('is a map of claim keys to one source each', () => {
    const template = JwtTemplateSchema.parse({
      claims: {
        email: { from: 'user.email' },
        verified: { from: 'user.email_verified' },
        since: { from: 'user.created_at' },
        client: { from: 'session.client' },
        signed_in: { from: 'session.created_at' },
        plan: { value: 'pro' },
        seats: { value: 5 },
        beta: { value: true },
      },
    })
    expect(Object.keys(template.claims)).toHaveLength(8)
  })

  test('the sources are a closed list', () => {
    expect([...JWT_TEMPLATE_SOURCES]).toEqual([
      'user.email',
      'user.email_verified',
      'user.created_at',
      'session.client',
      'session.created_at',
    ])
  })

  test.each([
    ['a source outside the list', { from: 'user.password_hash' }],
    ['the IP address', { from: 'session.ip_address' }],
    ['the user agent', { from: 'session.user_agent' }],
    ['a name', { from: 'user.first_name' }],
    ['an expression', { from: '{{user.email}}' }],
    ['a source and a constant', { from: 'user.email', value: 'x' }],
    ['neither', {}],
    ['an unknown key', { value: 'x', when: 'always' }],
    ['a nested constant', { value: { role: 'admin' } }],
    ['a list constant', { value: ['admin'] }],
    ['a null constant', { value: null }],
    ['a constant JSON cannot hold', { value: Number.POSITIVE_INFINITY }],
    ['a constant that is not a number', { value: Number.NaN }],
    ['a constant longer than the cap', { value: 'x'.repeat(MAX_CUSTOM_CLAIM_CONSTANT_LENGTH + 1) }],
    ['a constant with a control character', { value: 'a\u{0}b' }],
    ['a bare string', 'user.email'],
  ])('refuses %s', (_label, claim) => {
    expect(JwtTemplateSchema.safeParse({ claims: { k: claim } }).success).toBe(false)
  })

  test.each([
    'iss',
    'sub',
    'aud',
    'exp',
    'nbf',
    'iat',
    'jti',
    'sid',
    'pid',
    'eid',
    'v',
    'amr',
    'auth_time',
    'sp',
    'cnf',
    'ext',
  ])('refuses the reserved key %s', (key) => {
    const result = JwtTemplateSchema.safeParse({ claims: { [key]: { value: 'x' } } })
    expect(result.success).toBe(false)
  })

  test.each(['my-claim', 'a.b', '', '1st', 'constructor', 'prototype', 'x'.repeat(33)])(
    'refuses the malformed key %p',
    (key) => {
      expect(JwtTemplateSchema.safeParse({ claims: { [key]: { value: 'x' } } }).success).toBe(false)
    }
  )

  test('a `__proto__` key never becomes a claim', () => {
    const parsed = JwtTemplateSchema.safeParse(JSON.parse('{"claims":{"__proto__":{"value":1}}}'))
    // Refused or dropped: either way nothing is issued under it.
    expect(parsed.success ? Object.keys(parsed.data.claims) : []).toEqual([])
    expect(parsed.success ? Object.getPrototypeOf(parsed.data.claims) : Object.prototype).toBe(
      Object.prototype
    )
  })

  test('an unknown key beside `claims` is refused', () => {
    expect(JwtTemplateSchema.safeParse({ claims: {}, audience: 'x' }).success).toBe(false)
  })

  test('an empty template is allowed: it adds nothing', () => {
    expect(JwtTemplateSchema.parse({}).claims).toEqual({})
  })

  test('refuses more claims than the cap', () => {
    const claims = Object.fromEntries(
      Array.from({ length: MAX_JWT_TEMPLATE_CLAIMS + 1 }, (_, i) => [`c${i}`, { value: i }])
    )
    expect(JwtTemplateSchema.safeParse({ claims }).success).toBe(false)
    delete claims.c0
    expect(JwtTemplateSchema.safeParse({ claims }).success).toBe(true)
  })
})

describe('the largest claim a template can produce', () => {
  test('constants are measured as they are', () => {
    expect(jwtTemplateMaxBytes({ claims: { role: { value: 'admin' } } })).toBe(
      '{"role":"admin"}'.length
    )
    expect(jwtTemplateMaxBytes({ claims: { a: { value: true }, b: { value: 10 } } })).toBe(
      '{"a":true,"b":10}'.length
    )
  })

  test('an empty template is the empty object', () => {
    expect(jwtTemplateMaxBytes({ claims: {} })).toBe(2)
  })

  test('an email is bounded by the longest address, every character escaped', () => {
    // `{"e":` + the value + `}`.
    expect(jwtTemplateMaxBytes({ claims: { e: { from: 'user.email' } } })).toBe(
      6 + MAX_EMAIL_CLAIM_BYTES
    )
    expect(MAX_EMAIL_CLAIM_BYTES).toBe(2 * 320 + 2)
  })

  test('a boolean is bounded by `false`, a time by the largest safe integer', () => {
    expect(jwtTemplateMaxBytes({ claims: { v: { from: 'user.email_verified' } } })).toBe(6 + 5)
    expect(jwtTemplateMaxBytes({ claims: { t: { from: 'user.created_at' } } })).toBe(6 + 16)
    expect(jwtTemplateMaxBytes({ claims: { t: { from: 'session.created_at' } } })).toBe(6 + 16)
  })

  test('the client kind is bounded by the longest kind', () => {
    expect(jwtTemplateMaxBytes({ claims: { c: { from: 'session.client' } } })).toBe(
      6 + '"android"'.length
    )
  })

  test('a template that could exceed the cap is refused, one that cannot is accepted', () => {
    // An email leaves 1024 - 6 - 642 = 376 bytes; a 256-character constant under a one-letter
    // key takes `,"k":"` + 256 + `"` = 263.
    const fits = { e: { from: 'user.email' }, k: { value: 'x'.repeat(256) } }
    expect(jwtTemplateMaxBytes({ claims: fits as never })).toBeLessThanOrEqual(
      MAX_CUSTOM_CLAIMS_BYTES
    )
    expect(JwtTemplateSchema.safeParse({ claims: fits }).success).toBe(true)

    const over = { ...fits, l: { value: 'x'.repeat(256) } }
    expect(jwtTemplateMaxBytes({ claims: over as never })).toBeGreaterThan(MAX_CUSTOM_CLAIMS_BYTES)
    expect(JwtTemplateSchema.safeParse({ claims: over }).success).toBe(false)
  })

  test('the cap is on bytes: a constant of multi-byte characters counts in full', () => {
    // 256 three-byte characters are 768 bytes; two of them cannot fit.
    const euro = '\u{20ac}'.repeat(256)
    expect(JwtTemplateSchema.safeParse({ claims: { a: { value: euro } } }).success).toBe(true)
    expect(
      JwtTemplateSchema.safeParse({ claims: { a: { value: euro }, b: { value: euro } } }).success
    ).toBe(false)
  })
})

describe('templates in the sessions settings', () => {
  test('an environment that saved nothing has no template and no profile uses one', () => {
    const settings = SessionSettingsSchema.parse({})
    expect(settings.jwtTemplates).toEqual({})
    expect(settings.profiles.web.jwtTemplate).toBeNull()
    expect(settings.profiles.mobile.jwtTemplate).toBeNull()
  })

  test('a profile names the template it uses', () => {
    const settings = SessionSettingsSchema.parse({
      jwtTemplates: { app: role },
      profiles: { web: { jwtTemplate: 'app' } },
    })
    expect(jwtTemplateOfProfile(settings, settings.profiles.web)).toEqual({
      name: 'app',
      template: { claims: { role: { value: 'member' } } },
    })
    expect(jwtTemplateOfProfile(settings, settings.profiles.mobile)).toBeNull()
  })

  test('a profile naming a template that does not exist is refused, on that profile', () => {
    const result = SessionSettingsSchema.safeParse({ profiles: { web: { jwtTemplate: 'gone' } } })
    expect(result.success).toBe(false)
    expect(messages(result)).toEqual(['profiles.web.jwtTemplate'])
  })

  test('removing a template a profile still uses is refused; unsetting it first is not', () => {
    const using = { profiles: { admin: { jwtTemplate: 'app' } } }
    expect(SessionSettingsSchema.safeParse({ ...using, jwtTemplates: {} }).success).toBe(false)
    expect(
      SessionSettingsSchema.safeParse({ profiles: { admin: { jwtTemplate: null } } }).success
    ).toBe(true)
  })

  test('an inherited key is not a template', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const result = SessionSettingsSchema.safeParse({ profiles: { web: { jwtTemplate: name } } })
      expect(result.success).toBe(false)
    }
  })

  test.each(['Admin', 'a_b', '-a', 'a--b', 'x'.repeat(33), ''])(
    'refuses the template name %p',
    (name) => {
      expect(SessionSettingsSchema.safeParse({ jwtTemplates: { [name]: role } }).success).toBe(
        false
      )
    }
  )

  test('a `__proto__` key never becomes a template', () => {
    const parsed = SessionSettingsSchema.safeParse(
      JSON.parse(
        '{"jwtTemplates":{"__proto__":{"claims":{}}},"profiles":{"web":{"jwtTemplate":null}}}'
      )
    )
    expect(parsed.success ? Object.keys(parsed.data.jwtTemplates) : []).toEqual([])
  })

  test('refuses more templates than the cap', () => {
    const jwtTemplates = Object.fromEntries(
      Array.from({ length: MAX_JWT_TEMPLATES + 1 }, (_, i) => [`t${i}`, role])
    )
    expect(SessionSettingsSchema.safeParse({ jwtTemplates }).success).toBe(false)
    delete jwtTemplates.t0
    expect(SessionSettingsSchema.safeParse({ jwtTemplates }).success).toBe(true)
  })

  test('both settings schemas accept templates and apply the same rules', () => {
    const sessions = { jwtTemplates: { app: role }, profiles: { web: { jwtTemplate: 'app' } } }
    for (const schema of [EnvironmentSettingsSchema, EnvironmentSettingsInputSchema]) {
      expect(schema.parse({ sessions }).sessions.profiles.web.jwtTemplate).toBe('app')
      expect(
        schema.safeParse({ sessions: { profiles: { web: { jwtTemplate: 'gone' } } } }).success
      ).toBe(false)
      expect(
        schema.safeParse({
          sessions: { jwtTemplates: { app: { claims: { sub: { value: 'x' } } } } },
        }).success
      ).toBe(false)
    }
  })
})

describe('templates in a stored document', () => {
  test('a document stored before templates existed reads with none', () => {
    const settings = parseStoredEnvironmentSettings({
      sessions: { profiles: { web: { idleTimeout: '1d' } } },
    })
    expect(settings.sessions.jwtTemplates).toEqual({})
    expect(settings.sessions.profiles.web.jwtTemplate).toBeNull()
  })

  test('a stored template is read back', () => {
    const settings = parseStoredEnvironmentSettings({
      sessions: { jwtTemplates: { app: role }, profiles: { web: { jwtTemplate: 'app' } } },
    })
    expect(settings.sessions.jwtTemplates).toEqual({ app: role })
    expect(EnvironmentSettingsSchema.safeParse(settings).success).toBe(true)
  })

  // A newer server may have stored a source this one does not know, before a rollback. A
  // missing claim reads as "no" to an app; a failed read would take the environment down.
  test('a claim this version does not understand is left out, not a failed read', () => {
    const settings = parseStoredEnvironmentSettings({
      sessions: {
        jwtTemplates: {
          app: { claims: { role: { value: 'member' }, org: { from: 'organization.id' } } },
        },
        profiles: { web: { jwtTemplate: 'app' } },
      },
    })
    expect(settings.sessions.jwtTemplates).toEqual({ app: role })
  })

  test.each([
    ['not a map', 'templates'],
    ['a list', [role]],
    ['null', null],
  ])('templates that are %s read as none', (_label, jwtTemplates) => {
    const settings = parseStoredEnvironmentSettings({ sessions: { jwtTemplates } })
    expect(settings.sessions.jwtTemplates).toEqual({})
  })

  test('a template that is not one, or is badly named, is left out', () => {
    const settings = parseStoredEnvironmentSettings({
      sessions: { jwtTemplates: { app: role, Bad_Name: role, broken: 'x', empty: {} } },
    })
    expect(settings.sessions.jwtTemplates).toEqual({ app: role, empty: { claims: {} } })
  })

  test('a stored profile that names a missing template still reads, and resolves to none', () => {
    const settings = parseStoredEnvironmentSettings({
      sessions: { profiles: { web: { jwtTemplate: 'gone' } } },
    })
    expect(jwtTemplateOfProfile(settings.sessions, settings.sessions.profiles.web)).toBeNull()
  })

  test('a stored template over the size cap is left out whole', () => {
    const big = {
      claims: {
        a: { value: 'x'.repeat(256) },
        b: { from: 'user.email' },
        c: { value: 'y'.repeat(256) },
      },
    }
    const settings = parseStoredEnvironmentSettings({ sessions: { jwtTemplates: { big } } })
    expect(settings.sessions.jwtTemplates).toEqual({})
  })
})
