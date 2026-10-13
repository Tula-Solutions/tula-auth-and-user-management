import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsInputSchema,
  EnvironmentSettingsSchema,
  parseStoredEnvironmentSettings,
} from './environment-settings'
import { ERROR_DEFINITIONS } from './error-codes'
import { SessionTokensSchema } from './flow'
import { SESSION_PROFILE_HEADER } from './headers'
import {
  builtInSessionProfile,
  DEFAULT_MOBILE_SESSION_PROFILE,
  DEFAULT_WEB_SESSION_PROFILE,
  defaultDeviceBinding,
  isSessionProfileName,
  MAX_CUSTOM_SESSION_PROFILES,
  MIN_REUSE_GRACE_PERIOD,
  profileOfSession,
  resolveSessionProfile,
  SessionProfileNameSchema,
  SessionProfileSchema,
  SessionSettingsSchema,
  stepUpWindowSeconds,
} from './session-profile'
import { ACCESS_TOKEN_VERSION, AccessTokenClaimsSchema } from './tokens'

function withProfiles(profiles: Record<string, unknown>, rest: Record<string, unknown> = {}) {
  return EnvironmentSettingsSchema.safeParse({ sessions: { profiles, ...rest } })
}

describe('session profile defaults', () => {
  test('an empty profile is the hybrid default: what every session got before profiles', () => {
    expect(SessionProfileSchema.parse({})).toEqual({
      type: 'hybrid',
      accessTokenTtl: '60s',
      idleTimeout: '7d',
      absoluteTimeout: '30d',
      refresh: { reuseGracePeriod: '10s' },
      stepUpAfter: null,
      clientSelectable: false,
      jwtTemplate: null,
      deviceBinding: 'optional',
    })
    expect(DEFAULT_MOBILE_SESSION_PROFILE).toEqual(SessionProfileSchema.parse({}))
    // The built-ins differ in one field: a browser's session is never bound to a device key.
    expect(DEFAULT_WEB_SESSION_PROFILE).toEqual({
      ...DEFAULT_MOBILE_SESSION_PROFILE,
      deviceBinding: 'none',
    })
  })

  test('an environment that saved nothing has web and mobile, no limit', () => {
    expect(DEFAULT_ENVIRONMENT_SETTINGS.sessions).toEqual({
      profiles: { web: DEFAULT_WEB_SESSION_PROFILE, mobile: DEFAULT_MOBILE_SESSION_PROFILE },
      maxPerUser: null,
      onLimit: 'end_oldest',
      jwtTemplates: {},
    })
  })

  test('a document stored before sessions existed reads as the defaults', () => {
    expect(parseStoredEnvironmentSettings({ app: { name: 'Acme' } }).sessions).toEqual(
      DEFAULT_ENVIRONMENT_SETTINGS.sessions
    )
  })

  test('the built-ins stay present when only a custom profile is sent', () => {
    const parsed = EnvironmentSettingsSchema.parse({
      sessions: { profiles: { admin: { idleTimeout: '15m', absoluteTimeout: '8h' } } },
    })
    expect(Object.keys(parsed.sessions.profiles).sort()).toEqual(['admin', 'mobile', 'web'])
    expect(parsed.sessions.profiles.admin).toMatchObject({
      type: 'hybrid',
      idleTimeout: '15m',
      absoluteTimeout: '8h',
      clientSelectable: false,
    })
  })
})

describe('the device-binding option of a profile', () => {
  const bindings = (sessions: { profiles: Record<string, { deviceBinding: string }> }) =>
    Object.fromEntries(
      Object.entries(sessions.profiles).map(([name, profile]) => [name, profile.deviceBinding])
    )

  test('left out, it is none for web and optional for every other profile', () => {
    const settings = SessionSettingsSchema.parse({ profiles: { kiosk: {}, 'back-office': {} } })
    expect(bindings(settings)).toEqual({
      web: 'none',
      mobile: 'optional',
      kiosk: 'optional',
      'back-office': 'optional',
    })
    for (const name of Object.keys(settings.profiles)) {
      expect(settings.profiles[name]?.deviceBinding).toBe(defaultDeviceBinding(name))
    }
  })

  test('a document stored before the option existed reads as the same defaults', () => {
    const stored = parseStoredEnvironmentSettings({
      sessions: {
        profiles: {
          web: { idleTimeout: '1d' },
          mobile: { idleTimeout: '2d' },
          kiosk: { clientSelectable: true },
        },
      },
    })
    expect(bindings(stored.sessions)).toEqual({
      web: 'none',
      mobile: 'optional',
      kiosk: 'optional',
    })
  })

  test.each(['none', 'optional', 'required'])('%s is accepted on every profile', (value) => {
    const profile = { deviceBinding: value }
    const parsed = SessionSettingsSchema.parse({
      profiles: { web: profile, mobile: profile, kiosk: profile },
    })
    expect(bindings(parsed)).toEqual({ web: value, mobile: value, kiosk: value })
    expect(
      bindings(
        parseStoredEnvironmentSettings({
          sessions: { profiles: { web: profile, mobile: profile } },
        }).sessions
      )
    ).toEqual({ web: value, mobile: value })
  })

  test.each(['Required', 'verified', 'enforced', '', true, null, 1])(
    '%p is refused, with the field named',
    (value) => {
      for (const name of ['web', 'mobile', 'kiosk']) {
        const result = withProfiles({ [name]: { deviceBinding: value } })
        expect(result.success).toBe(false)
        expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
          `sessions.profiles.${name}.deviceBinding`,
        ])
      }
    }
  )

  test('the option does not change which profile a client gets', () => {
    const settings = SessionSettingsSchema.parse({
      profiles: { mobile: { deviceBinding: 'required' }, kiosk: { clientSelectable: true } },
    })
    expect(resolveSessionProfile(settings, { client: 'ios' }).profile.deviceBinding).toBe(
      'required'
    )
    expect(
      resolveSessionProfile(settings, { client: 'ios', requested: 'kiosk' }).profile.deviceBinding
    ).toBe('optional')
    expect(resolveSessionProfile(settings, { client: 'web' }).profile.deviceBinding).toBe('none')
  })

  test('a sign-in refused for having no key has a code of the device family, a 400', () => {
    expect(ERROR_DEFINITIONS['device.binding_required'].status).toBe(400)
  })
})

describe('session profile bounds', () => {
  test.each([
    ['accessTokenTtl below 30s', { accessTokenTtl: '29s' }],
    ['accessTokenTtl above 15m', { accessTokenTtl: '16m' }],
    ['idleTimeout below 1m', { idleTimeout: '59s' }],
    ['idleTimeout above 365d', { idleTimeout: '366d' }],
    ['idle longer than absolute', { idleTimeout: '2h', absoluteTimeout: '1h' }],
    ['absoluteTimeout above 365d', { absoluteTimeout: '400d' }],
    ['a grace below the floor', { refresh: { reuseGracePeriod: '5s' } }],
    ['a grace above 60s', { refresh: { reuseGracePeriod: '61s' } }],
    ['stepUpAfter below 1m', { stepUpAfter: '30s' }],
    ['stepUpAfter above 24h', { stepUpAfter: '25h' }],
    ['an unknown type', { type: 'kiosk' }],
    ['an unknown key', { maxConcurrent: 1 }],
    ['a malformed duration', { idleTimeout: 'soon' }],
    [
      'an access token that outlives the idle timeout',
      { accessTokenTtl: '15m', idleTimeout: '2m' },
    ],
    [
      'a stateful profile that writes activity less often than it times out',
      { type: 'stateful', accessTokenTtl: '15m', idleTimeout: '2m' },
    ],
  ])('refuses %s', (_name, profile) => {
    expect(withProfiles({ web: profile }).success).toBe(false)
    expect(
      EnvironmentSettingsInputSchema.safeParse({ sessions: { profiles: { web: profile } } }).success
    ).toBe(false)
  })

  test.each([
    ['the smallest values', { accessTokenTtl: '30s', idleTimeout: '1m', absoluteTimeout: '1m' }],
    ['the largest values', { accessTokenTtl: '15m', idleTimeout: '365d', absoluteTimeout: null }],
    ['no grace at all (strict rotation)', { refresh: { reuseGracePeriod: null } }],
    ['the grace floor', { refresh: { reuseGracePeriod: MIN_REUSE_GRACE_PERIOD } }],
    ['a 60s grace', { refresh: { reuseGracePeriod: '60s' } }],
    ['a step-up window', { stepUpAfter: '5m' }],
    ['stateful', { type: 'stateful' }],
  ])('accepts %s', (_name, profile) => {
    expect(withProfiles({ web: profile }).success).toBe(true)
  })

  test('an access token longer than the idle timeout is reported on accessTokenTtl', () => {
    const parsed = withProfiles({ admin: { accessTokenTtl: '5m', idleTimeout: '2m' } })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['sessions.profiles.admin.accessTokenTtl', 'must not be longer than idleTimeout'],
    ])
    expect(withProfiles({ admin: { accessTokenTtl: '2m', idleTimeout: '2m' } }).success).toBe(true)
  })

  test('a stored document whose access token outlives its idle timeout is still read as stored', () => {
    // Accepted before the rule existed. Refusing it on read would fail every request of that
    // environment; the session service keeps such a profile's sessions alive instead.
    const read = parseStoredEnvironmentSettings({
      app: { name: 'Acme' },
      sessions: {
        profiles: { web: { type: 'stateful', accessTokenTtl: '15m', idleTimeout: '2m' } },
      },
    })
    expect(read.app.name).toBe('Acme')
    expect(read.sessions.profiles.web).toMatchObject({
      type: 'stateful',
      accessTokenTtl: '15m',
      idleTimeout: '2m',
    })
  })

  test('the grace floor is 10s: no smaller value than what an SDK refresh needs, except none', () => {
    expect(MIN_REUSE_GRACE_PERIOD).toBe('10s')
  })

  test('mobile cannot be stateful: a native app has no cookie jar to hold the session', () => {
    expect(withProfiles({ mobile: { type: 'stateful' } }).success).toBe(false)
  })

  test.each(['Admin', 'admin_panel', '-admin', 'admin-', 'a'.repeat(33), ''])(
    'refuses the profile name %p',
    (name) => {
      expect(withProfiles({ [name]: {} }).success).toBe(false)
    }
  )

  test('a `__proto__` key never becomes a profile', () => {
    const parsed = withProfiles(JSON.parse('{"__proto__":{"idleTimeout":"365d"}}'))
    const profiles = parsed.success ? parsed.data.sessions.profiles : {}
    expect(Object.keys(profiles).sort()).toEqual(parsed.success ? ['mobile', 'web'] : [])
    expect(({} as Record<string, unknown>).idleTimeout).toBeUndefined()
  })

  test('refuses more custom profiles than the cap', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_CUSTOM_SESSION_PROFILES + 1 }, (_, i) => [`p-${i}`, {}])
    )
    expect(withProfiles(many).success).toBe(false)
    const { 'p-0': _dropped, ...atCap } = many
    expect(withProfiles(atCap).success).toBe(true)
  })

  test('the session limit is a positive count or none, with a known behaviour', () => {
    expect(withProfiles({}, { maxPerUser: 0 }).success).toBe(false)
    expect(withProfiles({}, { maxPerUser: 101 }).success).toBe(false)
    expect(withProfiles({}, { maxPerUser: 1.5 }).success).toBe(false)
    expect(withProfiles({}, { maxPerUser: 3, onLimit: 'refuse_newest' }).success).toBe(true)
    expect(withProfiles({}, { onLimit: 'ignore' }).success).toBe(false)
    expect(withProfiles({}, { unknown: true }).success).toBe(false)
  })

  test('a stored document keeps unknown keys out instead of failing', () => {
    const read = parseStoredEnvironmentSettings({
      sessions: { later: true, profiles: { web: { idleTimeout: '1d', later: 1 } } },
    })
    expect(read.sessions.profiles.web.idleTimeout).toBe('1d')
    expect(read.sessions).not.toHaveProperty('later')
    expect(read.sessions.profiles.web).not.toHaveProperty('later')
  })
})

describe('choosing a profile for a new session', () => {
  const sessions = EnvironmentSettingsSchema.parse({
    sessions: {
      profiles: {
        web: { idleTimeout: '1d' },
        admin: { idleTimeout: '15m', absoluteTimeout: '8h', clientSelectable: true },
        'long-lived': { idleTimeout: '90d', absoluteTimeout: null },
        cookie: { type: 'stateful', clientSelectable: true },
      },
    },
  }).sessions

  test('the client kind decides: web for a browser, mobile for everything else', () => {
    expect(builtInSessionProfile('web')).toBe('web')
    expect(builtInSessionProfile('ios')).toBe('mobile')
    expect(builtInSessionProfile('android')).toBe('mobile')
    expect(builtInSessionProfile('server')).toBe('mobile')
    expect(resolveSessionProfile(sessions, { client: 'web' }).name).toBe('web')
    expect(resolveSessionProfile(sessions, { client: 'ios' }).name).toBe('mobile')
  })

  test('a client gets the profile it names only when the operator offers it', () => {
    const chosen = resolveSessionProfile(sessions, { client: 'web', requested: 'admin' })
    expect(chosen.name).toBe('admin')
    expect(chosen.profile.idleTimeout).toBe('15m')
  })

  test('a profile that is not client-selectable is never chosen by a client', () => {
    expect(resolveSessionProfile(sessions, { client: 'web', requested: 'long-lived' }).name).toBe(
      'web'
    )
  })

  test.each(['nope', '__proto__', 'constructor', 'toString', ''])(
    'an unknown name (%p) falls back to the client kind’s profile',
    (requested) => {
      expect(resolveSessionProfile(sessions, { client: 'web', requested }).name).toBe('web')
    }
  )

  test('a built-in is only ever the one of the client’s own kind', () => {
    expect(resolveSessionProfile(sessions, { client: 'ios', requested: 'web' }).name).toBe('mobile')
    expect(resolveSessionProfile(sessions, { client: 'web', requested: 'mobile' }).name).toBe('web')
  })

  test('a stateful profile is for browsers: a native client falls back to mobile', () => {
    expect(resolveSessionProfile(sessions, { client: 'web', requested: 'cookie' }).name).toBe(
      'cookie'
    )
    expect(resolveSessionProfile(sessions, { client: 'ios', requested: 'cookie' }).name).toBe(
      'mobile'
    )
  })
})

describe('the profile of an existing session', () => {
  const sessions = EnvironmentSettingsSchema.parse({
    sessions: { profiles: { web: { idleTimeout: '1d' }, admin: { stepUpAfter: '2m' } } },
  }).sessions

  test('is the one it names, as configured now', () => {
    expect(profileOfSession(sessions, { profile: 'admin', client: 'web' }).name).toBe('admin')
    expect(profileOfSession(sessions, { profile: 'web', client: 'web' }).profile.idleTimeout).toBe(
      '1d'
    )
  })

  test('a deleted profile falls back to the built-in for the client kind', () => {
    expect(profileOfSession(sessions, { profile: 'gone', client: 'web' }).name).toBe('web')
    expect(profileOfSession(sessions, { profile: 'gone', client: 'android' }).name).toBe('mobile')
    expect(profileOfSession(sessions, { profile: '__proto__', client: 'web' }).name).toBe('web')
  })

  test('a native session stored as `web` before profiles existed is a mobile one', () => {
    expect(profileOfSession(sessions, { profile: 'web', client: 'ios' }).name).toBe('mobile')
  })

  test('the step-up window is the profile’s, or ten minutes', () => {
    expect(stepUpWindowSeconds(sessions, 'admin')).toBe(120)
    expect(stepUpWindowSeconds(sessions, 'web')).toBe(600)
    expect(stepUpWindowSeconds(sessions, 'gone')).toBe(600)
    expect(stepUpWindowSeconds(sessions, undefined)).toBe(600)
  })
})

describe('what the wire carries for profiles', () => {
  test('the profile header has a name of its own', () => {
    expect(SESSION_PROFILE_HEADER).toBe('x-tula-session-profile')
  })

  test('a refused sign-in at the session limit has its own code', () => {
    expect(ERROR_DEFINITIONS['session.limit_reached'].status).toBe(403)
  })

  test('a stateful session’s tokens are just the session id', () => {
    expect(SessionTokensSchema.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' })
  })

  test('access-token claims may name the session’s profile', () => {
    const claims = { iss: 'i', sub: 'u', aud: 'e', sid: 's', pid: 'p', eid: 'e', iat: 1, exp: 2 }
    const parsed = AccessTokenClaimsSchema.parse({
      ...claims,
      v: ACCESS_TOKEN_VERSION,
      sp: 'admin',
    })
    expect(parsed.sp).toBe('admin')
    expect(AccessTokenClaimsSchema.parse({ ...claims, v: ACCESS_TOKEN_VERSION }).sp).toBeUndefined()
  })
})

describe('isSessionProfileName', () => {
  // The one rule for a profile's name and a JWT template's, shared with the forms that ask for
  // one: a form with a pattern of its own accepted names the schema refuses.
  test.each(['web', 'admin', 'back-office', 'a1', 'a-1-b', 'a'.repeat(32)])(
    'accepts %p, as the schema does',
    (name) => {
      expect(isSessionProfileName(name)).toBe(true)
      expect(SessionProfileNameSchema.safeParse(name).success).toBe(true)
    }
  )

  test.each([
    '',
    'a_b',
    'a--b',
    'a-',
    '-a',
    '1a',
    'Admin',
    'admin panel',
    'a'.repeat(33),
    7,
    null,
    undefined,
  ])('refuses %p, as the schema does', (name) => {
    expect(isSessionProfileName(name)).toBe(false)
    expect(SessionProfileNameSchema.safeParse(name).success).toBe(false)
  })

  test('the settings schema refuses a template named by a name it refuses', () => {
    for (const name of ['a_b', 'a--b', 'a-']) {
      expect(
        SessionSettingsSchema.safeParse({ jwtTemplates: { [name]: { claims: {} } } }).success
      ).toBe(false)
    }
  })
})
